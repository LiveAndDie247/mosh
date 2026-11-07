// The moshed video's sound, built to match it frame by frame: each output frame gets the
// 1/30 s of sound from the original frame it came from (Clip A's up to the cut, then Clip B's).
// The BLOOM copies repeat their sliver of sound, so the bloom stutters audibly too.

export async function buildMoshAudio(ac, fileA, fileB, nA, order, fps = 30) {
  if (!ac) throw new Error("Web Audio isn't available");
  const [a, b] = await Promise.all([decode(ac, fileA), decode(ac, fileB)]);
  if (!a && !b) throw new Error("neither clip has sound");
  const sr = ac.sampleRate, per = sr / fps;
  const len = Math.round(order.length * per);
  const L = new Float32Array(len), R = new Float32Array(len);
  order.forEach((k, i) => {
    const buf = k < nA ? a : b, f = k < nA ? k : k - nA;
    if (!buf) return;
    const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    const from = Math.round(f * per), to = Math.round(i * per), n = Math.round((i + 1) * per) - to;
    for (let j = 0; j < n && from + j < l.length && to + j < len; j++) { L[to + j] = l[from + j]; R[to + j] = r[from + j]; }
  });
  return encodeWav(L, R, sr);
}

// A DAISY CHAIN's sound: the links' sounds laid end to end (each cut or padded to exactly its
// frame count), then rebuilt in the moshed frame order (so BLOOM and SOUP are heard too).
// files: the links; frames: frame count of each; order: original frame of each output frame.
export async function buildChainAudio(ac, files, frames, order, fps = 30) {
  if (!ac) throw new Error("Web Audio isn't available");
  const bufs = await Promise.all(files.map(f => decode(ac, f)));
  if (!bufs.some(Boolean)) throw new Error("no link has sound");
  const sr = ac.sampleRate, per = sr / fps;
  const starts = frames.reduce((a, n, i) => (a.push(i ? a[i - 1] + frames[i - 1] : 0), a), []);
  const linkOf = fi => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= fi) i++; return i; };
  const len = Math.round(order.length * per);
  const L = new Float32Array(len), R = new Float32Array(len);
  order.forEach((fi, i) => {
    const li = linkOf(fi), buf = bufs[li];
    if (!buf) return;
    const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    const from = Math.round((fi - starts[li]) * per), to = Math.round(i * per), n = Math.round((i + 1) * per) - to;
    for (let j = 0; j < n && from + j < l.length && to + j < len; j++) { L[to + j] = l[from + j]; R[to + j] = r[from + j]; }
  });
  return encodeWav(L, R, sr);
}

async function decode(ac, file) {
  try { return await ac.decodeAudioData(await file.arrayBuffer()); } catch { return null; }
}

// 16-bit stereo PCM WAV
export function encodeWav(L, R, sr) {
  const n = L.length, bytes = n * 4, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); v.setUint32(4, 36 + bytes, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, bytes, true);
  const s16 = x => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0, o = 44; i < n; i++, o += 4) { v.setInt16(o, s16(L[i]), true); v.setInt16(o + 2, s16(R[i]), true); }
  return new Uint8Array(buf);
}
