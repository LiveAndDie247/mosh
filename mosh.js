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
  return {
    data: writeAvi(u8, hdrl, movi, out),
    stats: {
      frames, kept: videoOut, removedI: removed, cutFrame: cut, bloomFrame, bloomCopies: bloomFrame >= 0 ? bloom : 0,
      // For each output frame, the original frame it came from (so the sound can follow the picture)
      order: out.filter(c => isVideo(c.id)).map(c => c.fi),
    },
  };
}

// DAISY CHAIN: one AVI of several links, with a forced keyframe exactly where each link starts.
// joins: [{ at: frame number where the next link starts, type, count }] where type is
//   "mosh"  : delete the keyframe; the next link's motion drags this link's last picture
//   "bloom" : the same, plus `count` extra copies of one of the next link's motion frames. Which
//             one: the link's P-frames are ranked by compressed size, which tracks what they carry:
//             the tiniest are static (nothing to drag with), the biggest are the picture repainting
//             itself (repeat one and it sits there as blocks), and the ones in between are motion.
//             The first `skip` motion frames are left alone so the picture can bleed in first.
//   A join (and the first link, as { at: 0 }) can instead carry a PHRASE: `blooms`, a list of
//   { skip, pct, count, window }, applied in order along the link: skip `skip` motion frames (they
//   play as they are: a burst of real motion), then among the next `window` frames repeat the one
//   at the `pct` point of the size ranking `count` times. Low pct = a near-still frame = a hold,
//   mid = a slow smear, high = a heavy swirl. That is how the reference melt is built.
//   "soup"  : delete the keyframe and interleave the motion frames of both links for
//             `soupFrames` frames around the join (alternating P-frames), then hand off
//   "cut"   : keep the keyframe: a clean, hard reset
// Any keyframe that isn't at a join is deleted too (the encoder shouldn't make any).
// Returns { data, stats: { frames, kept, removedI, joins (what was applied), order } }.
export function moshChain(input, joins = [], { soupFrames = 30 } = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { hdrl, movi, chunks } = parseAvi(u8);
  const vids = [];
  for (const c of chunks) {
    if (!isVideo(c.id)) continue;                           // the chain AVI is video only
    vids.push({ ...c, fi: vids.length, type: c.size ? vopType(u8, c.o + 8, c.o + 8 + c.size) : -1 });
  }
  if (!vids.length || vids[0].type !== 0) throw new Error("The chain doesn't start with an MPEG-4 I-frame");
  // A join's keyframe can land a frame off; match within ±2
  const joinAt = fi => joins.find(j => Math.abs(j.at - fi) <= 2) || null;

  const out = [], applied = [];
  let removed = 0, segStart = 0;
  const blooms = new Map();                                 // vids index -> copies to insert after it

  // The motion frames of a link: vids[from..] up to the next keyframe
  const motionFrames = from => {
    const cands = [];
    for (let k = from; k < vids.length && vids[k].type !== 0; k++) if (vids[k].type === 1 && vids[k].size) cands.push(k);
    return cands;
  };
  // Lay a phrase along a link: for each spec, skip `skip` motion frames, then among the next
  // `window` pick the frame at the `pct` point of the size ranking and repeat it `count` times.
  // Returns what was placed (for the stats).
  const layBlooms = (from, specs) => {
    const cands = motionFrames(from), placed = [];
    let pos = 0;
    for (const sp of specs) {
      pos = Math.min(cands.length - 1, pos + Math.max(0, sp.skip | 0));
      if (pos < 0 || pos >= cands.length) break;
      const win = cands.slice(pos, pos + Math.max(1, sp.window ?? 12));
      const ranked = win.slice().sort((a, b) => vids[a].size - vids[b].size);
      const idx = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * Math.min(1, Math.max(0, sp.pct ?? 0.7))))];
      const count = Math.max(0, sp.count | 0);
      if (count) blooms.set(idx, (blooms.get(idx) || 0) + count);
      placed.push({ frame: vids[idx].fi, count, pct: sp.pct ?? 0.7 });
      pos = cands.indexOf(idx) + 1;
    }
    return placed;
  };
  const specsOf = j => j.blooms?.length ? j.blooms : [{ skip: j.skip | 0, pct: j.pct ?? 0.7, count: j.count | 0, window: 1e9 }];

  // A phrase on the first link (its keyframe stays): { at: 0, blooms: [...] }
  const first = joins.find(j => j.at === 0 && j.blooms?.length);
  if (first) applied.push({ at: 0, type: "phrase", blooms: layBlooms(1, first.blooms) });
  for (let i = 0; i < vids.length; i++) {
    const f = vids[i];
    if (f.type === 0 && i > 0) {
      const j = joinAt(f.fi) || { at: f.fi, type: "mosh", stray: true };
      if (j.type === "cut") {
        out.push({ ...f, key: true });
        applied.push({ at: f.fi, type: "cut", ...(j.blooms?.length && { blooms: layBlooms(i + 1, j.blooms) }) });
        segStart = out.length - 1;
        continue;
      }
      removed++;
      if (j.type === "soup") {
        // the last K motion frames of this link, alternating with the next link's first K
        const half = Math.max(1, Math.round(soupFrames / 2));
        const tail = [];
        while (tail.length < half && out.length > segStart + 1 && out[out.length - 1].p) tail.unshift(out.pop());
        const head = [];
        let k = i + 1;
        while (head.length < tail.length && k < vids.length && vids[k].type === 1) head.push(vids[k++]);
        const n = Math.min(tail.length, head.length);
        // frames of the tail that won't be paired go back first
        out.push(...tail.slice(0, tail.length - n).map(c => ({ ...c })));
        const t = tail.slice(tail.length - n);
        for (let m = 0; m < n; m++) {
          out.push({ ...t[m], key: false, p: true });
          out.push({ ...head[m], key: false, p: true });
        }
        i = k - 1;
        applied.push({ at: f.fi, type: "soup", frames: 2 * n });
      } else {
        const placed = j.type === "bloom" ? layBlooms(i + 1, specsOf(j)) : null;
        if (!j.stray) applied.push({ at: f.fi, type: j.type, ...(placed && { blooms: placed }) });
      }
      segStart = out.length;
      continue;
    }
    const isP = f.type === 1;
    out.push({ ...f, key: i === 0, p: isP });
    const copies = blooms.get(i);
    if (copies) for (let b = 0; b < copies; b++) out.push({ ...f, key: false, p: true });   // the chosen frame: repeat it
  }
  return {
    data: writeAvi(u8, hdrl, movi, out),
    stats: { frames: vids.length, kept: out.length, removedI: removed, joins: applied, order: out.map(c => c.fi) },
  };
}

// Write a new AVI: everything before movi (headers, patched), a new movi from `out` (chunks
// of the input: { id, o, size, key }), a new idx1. Anything after movi in the original (the
// old idx1, extra RIFFs) is not copied.
function writeAvi(u8, hdrl, movi, out) {
  const videoOut = out.filter(c => isVideo(c.id)).length;
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
  return res;
}
