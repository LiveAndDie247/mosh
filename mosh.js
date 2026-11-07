// Real datamosh on an MPEG-4 Part 2 (mpeg4 / "DivX-style") AVI.
//
// Keep the first I-frame, delete every later I-frame, so the P-frames that follow
// the cut are applied to the last picture of Clip A instead of their own keyframe.
// Optional BLOOM: repeat one P-frame after the cut N times, so its motion keeps
// being re-applied and the smear grows.
//
// Pure functions on a Uint8Array. No DOM, so it also runs under Node for testing.

const AVIIF_KEYFRAME = 0x10;

const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

// MPEG-4 VOP start code 00 00 01 B6; the top 2 bits of the next byte are the
// coding type: 0 = I, 1 = P, 2 = B, 3 = S. Returns -1 if there's no VOP.
export function vopType(u8, start, end) {
  for (let i = start; i + 4 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && u8[i + 3] === 0xb6) return u8[i + 4] >> 6;
  }
  return -1;
}

// Find the hdrl and movi lists, and every chunk inside movi (descending into any
// LIST 'rec ' groups). Chunks: { id, o (offset of the 8-byte header), size }.
export function parseAvi(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 12 || fourcc(u8, 0) !== "RIFF" || fourcc(u8, 8) !== "AVI ") {
    throw new Error("Not an AVI file");
  }
  const riffEnd = Math.min(u8.length, 8 + dv.getUint32(4, true));
  let hdrl = null, movi = null;
  for (let o = 12; o + 8 <= riffEnd; ) {
    const id = fourcc(u8, o), size = dv.getUint32(o + 4, true);
    if (id === "LIST" && o + 12 <= riffEnd) {
      const type = fourcc(u8, o + 8);
      if (type === "hdrl" && !hdrl) hdrl = { o, size };
      if (type === "movi" && !movi) movi = { o, size };
    }
    o += 8 + size + (size & 1);
  }
  if (!hdrl) throw new Error("AVI has no hdrl list");
  if (!movi) throw new Error("AVI has no movi list");

  const chunks = [];
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end; ) {
      const id = fourcc(u8, p), size = dv.getUint32(p + 4, true);
      if (p + 8 + size > end) break;                       // truncated chunk: stop here
      if (id === "LIST") walk(p + 12, p + 8 + size);
      else chunks.push({ id, o: p, size });
      p += 8 + size + (size & 1);
    }
  };
  walk(movi.o + 12, Math.min(u8.length, movi.o + 8 + movi.size));
  return { dv, hdrl, movi, chunks };
}

// Visit every chunk in a range, descending into LISTs: fn(id, offset, size)
function eachChunk(u8, dv, start, end, fn) {
  for (let p = start; p + 8 <= end; ) {
    const id = fourcc(u8, p), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) break;
    if (id === "LIST") eachChunk(u8, dv, p + 12, p + 8 + size, fn);
    else fn(id, p, size);
    p += 8 + size + (size & 1);
  }
}

const isVideo = id => id.endsWith("dc") || id.endsWith("db");

// The datamosh. Options:
//   bloom   : how many extra copies of one P-frame to insert after the cut (0 = none)
//   bloomAt : 0..1, which P-frame after the cut gets repeated (0 = the first one)
// Returns { data: Uint8Array (a new AVI), stats }.
export function moshAvi(input, { bloom = 0, bloomAt = 0 } = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { dv, hdrl, movi, chunks } = parseAvi(u8);

  // 1. Walk the video frames: keep the first I-frame, delete every later one.
  //    Other streams' chunks (audio) are kept; old ix## index chunks are dropped.
  const out = [];                 // { o, size, id, key }
  let frames = 0, firstI = false, removed = 0, cut = -1;
  for (const c of chunks) {
    if (/^ix[0-9]{2}$/.test(c.id)) continue;
    if (!isVideo(c.id)) { out.push({ ...c, key: false }); continue; }
    const fi = frames++;                                        // original frame number
    const type = c.size ? vopType(u8, c.o + 8, c.o + 8 + c.size) : -1;
    if (type === 0) {
      if (!firstI) { firstI = true; out.push({ ...c, key: true, fi }); }
      else { removed++; if (cut < 0) cut = out.length; }       // gone: the next P-frames land on Clip A
      continue;
    }
    out.push({ ...c, key: false, p: type === 1, fi });
  }
  if (!firstI) throw new Error("No MPEG-4 I-frame found (was it encoded with -c:v mpeg4?)");

  // 2. BLOOM: repeat one P-frame after the cut, so the same motion keeps smearing.
  let bloomFrame = -1;
  if (bloom > 0) {
    const from = cut >= 0 ? cut : 1;
    const cands = [];
    for (let i = from; i < out.length; i++) if (out[i].p && out[i].size) cands.push(i);
    if (cands.length) {
      const pick = cands[Math.round(Math.min(1, Math.max(0, bloomAt)) * (cands.length - 1))];
      bloomFrame = pick;
      const copies = Array.from({ length: bloom }, () => ({ ...out[pick], key: false }));
      out.splice(pick + 1, 0, ...copies);
    }
  }
  const videoOut = out.filter(c => isVideo(c.id)).length;

  // 3. Write a new AVI: everything before movi (headers, patched), a new movi, a new idx1.
  //    Anything after movi in the original (the old idx1, extra RIFFs) is not copied.
  const moviBody = out.reduce((n, c) => n + 8 + c.size + (c.size & 1), 0);
  const idxSize = out.length * 16;
  const total = movi.o + 12 + moviBody + 8 + idxSize;
  const res = new Uint8Array(total);
  const rv = new DataView(res.buffer);
  res.set(u8.subarray(0, movi.o), 0);

  // Patch the headers: new frame counts; any OpenDML super index ('indx') would now
  // point at the wrong places, so turn it into padding.
  eachChunk(res, rv, hdrl.o + 12, hdrl.o + 8 + hdrl.size, (id, p, size) => {
    if (id === "avih" && size >= 20) rv.setUint32(p + 8 + 16, videoOut, true);          // dwTotalFrames
    if (id === "strh" && size >= 36 && fourcc(res, p + 8) === "vids") rv.setUint32(p + 8 + 32, videoOut, true); // dwLength
    if (id === "dmlh" && size >= 4) rv.setUint32(p + 8, videoOut, true);                // OpenDML total frames
    if (id === "indx") res.set([0x4a, 0x55, 0x4e, 0x4b], p);                           // 'JUNK'
  });

  let w = movi.o;
  res.set([0x4c, 0x49, 0x53, 0x54], w);                     // 'LIST'
  rv.setUint32(w + 4, 4 + moviBody, true);
  res.set([0x6d, 0x6f, 0x76, 0x69], w + 8);                 // 'movi'
  const moviFourcc = w + 8;                                 // idx1 offsets are relative to this
  w += 12;
  const index = [];
  for (const c of out) {
    res.set(u8.subarray(c.o, c.o + 8 + c.size), w);         // header + data (same id and size)
    index.push([c.id, c.key ? AVIIF_KEYFRAME : 0, w - moviFourcc, c.size]);
    w += 8 + c.size;
    if (c.size & 1) res[w++] = 0;
  }
  res.set([0x69, 0x64, 0x78, 0x31], w);                     // 'idx1'
  rv.setUint32(w + 4, idxSize, true);
  w += 8;
  for (const [id, flags, off, size] of index) {
    for (let k = 0; k < 4; k++) res[w + k] = id.charCodeAt(k);
    rv.setUint32(w + 4, flags, true);
    rv.setUint32(w + 8, off, true);
    rv.setUint32(w + 12, size, true);
    w += 16;
  }
  res.set([0x52, 0x49, 0x46, 0x46], 0);                     // 'RIFF'
  rv.setUint32(4, total - 8, true);

  return {
    data: res,
    stats: {
      frames, kept: videoOut, removedI: removed, cutFrame: cut, bloomFrame, bloomCopies: bloomFrame >= 0 ? bloom : 0,
      // For each output frame, the original frame it came from (so the sound can follow the picture)
      order: out.filter(c => isVideo(c.id)).map(c => c.fi),
    },
  };
}
