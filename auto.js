// AUTO MOSH: a pile of GIFs (GifCities and/or your own GIFs and videos) → one moshed clip of a set
// length, cut on the beat, with your song as the sound. One ffmpeg encode for the whole thing:
//   plan → write the sources → autoEncodeArgs (every segment to one MPEG-4 AVI, a keyframe at
//   each cut) → moshChain (delete / bloom / soup / keep each keyframe) → decodeArgs (+ the song).
// Pure planning (planAuto) is separate from running (runAuto), so it can be tested under Node.
import { autoEncodeArgs, chainStarts, decodeArgs, keepColorVf, RATIOS, FPS } from "./pipeline.js";
import { moshChain } from "./mosh.js";

// Styles: how cuts are joined, how long segments are (in beats), how hard blooms are
export const STYLES = {
  SMEAR: { joins: [["mosh", 6], ["bloom", 3], ["cut", 1]], beats: [4, 8], bloom: [8, 16] },
  MELT:  { joins: [["bloom", 6], ["mosh", 3], ["soup", 1]], beats: [8, 8, 16], bloom: [16, 30] },
  CHAOS: { joins: [["mosh", 4], ["bloom", 3], ["soup", 2], ["cut", 1]], beats: [2, 2, 4], bloom: [16, 30] },
  CLEAN: { joins: [["cut", 5], ["mosh", 4], ["bloom", 1]], beats: [4, 4, 8], bloom: [4, 8] },
};

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
function weighted(rnd, list) {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of list) if ((r -= w) < 0) return v;
  return list[0][0];
}
export function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

// pool: [{ id, kind: "gif" | "video", duration }] — the sources to cut from.
// Returns segs: [{ src: pool index, frames, ss, join, count }] adding up to exactly `seconds`.
export function planAuto({ seconds = 60, bpm = 120, style = "SMEAR", pool, seed = Date.now() }) {
  if (!pool.length) throw new Error("nothing to mosh: add clips or pick a vibe");
  const st = STYLES[style] || STYLES.SMEAR, rnd = seeded(seed);
  const beat = 60 / Math.max(40, Math.min(240, bpm));
  const total = Math.round(seconds * FPS);
  const order = [];                                   // shuffled sources, reshuffled when used up
  const next = () => {
    if (!order.length) {
      const idx = pool.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      order.push(...idx);
    }
    return order.shift();
  };
  const segs = [];
  let used = 0;
  while (used < total) {
    let frames = Math.max(8, Math.round(pick(rnd, st.beats) * beat * FPS));
    if (total - used - frames < 12) frames = total - used;  // no tiny last segment
    frames = Math.min(frames, total - used);
    const src = next(), s = pool[src];
    const len = frames / FPS;
    const ss = s.kind === "video" && s.duration > len + 0.2 ? +(rnd() * (s.duration - len)).toFixed(2) : 0;
    const join = segs.length ? weighted(rnd, st.joins) : "cut";
    // a BLOOM adds `count` repeated frames: take them out of the segment so the total stays exact
    const count = join === "bloom" ? Math.min(pick(rnd, st.bloom), frames - 8) : 0;
    const j = join === "bloom" && count < 2 ? "mosh" : join;
    // every join except CUT deletes that segment's keyframe (one frame): encode one extra
    segs.push({ src, frames: frames - Math.max(0, count) + (j === "cut" ? 0 : 1), ss, join: j, count });
    used += frames;
  }
  return segs;
}

// Run it. o: { ffmpeg (loaded FFmpeg), run(args, from, to, label), rm, setProgress, log, stopped() }
// sources: [{ kind, data: Uint8Array, ext, duration }] (same order as the pool)
// music: { data: Uint8Array, ext, offset } or null. Returns { blob, w, h, duration, segs }.
export async function runAuto(o, { sources, segs, ratio = "1:1", music = null, keepColor = 30 }) {
  const ff = o.ffmpeg, { w, h } = RATIOS[ratio] || RATIOS["1:1"];
  const names = sources.map((s, i) => `src${i}${s.kind === "gif" ? ".gif" : s.ext || ".mp4"}`);
  const files = [...names, "chain.avi", "chain-m.avi", "auto.mp4", "song" + (music?.ext || ".mp3")];
  try {
    o.setProgress(0.12, "AUTO: loading clips");
    for (const [i, s] of sources.entries()) await ff.writeFile(names[i], s.data);
    const frames = segs.map(s => s.frames);
    const enc = autoEncodeArgs({ segs: segs.map(s => ({ name: names[s.src], gif: sources[s.src].kind === "gif", ss: s.ss })), frames, w, h });
    await o.run(enc, 0.14, 0.62, "AUTO: ENCODING");
    for (const n of names) await o.rm(n);
    if (o.stopped?.()) throw new Error("stopped");
    o.setProgress(0.63, "AUTO: MOSHING");
    const avi = await ff.readFile("chain.avi");
    await o.rm("chain.avi");
    const starts = chainStarts(frames);
    const joins = segs.slice(1).map((s, k) => ({ at: starts[k + 1], type: s.join, count: s.count }));
    const { data, stats } = moshChain(avi, joins);
    o.log(`auto: ${JSON.stringify({ ...stats, order: undefined })}`);
    await ff.writeFile("chain-m.avi", data);
    const duration = stats.kept / FPS;
    let opts = { vf: keepColorVf(keepColor) };
    if (music) {
      const mname = "song" + (music.ext || ".mp3");
      await ff.writeFile(mname, music.data);
      opts.music = { name: mname, offset: music.offset || 0, duration };
    }
    await o.run(decodeArgs("chain-m.avi", "auto.mp4", null, opts), 0.65, 0.99, "AUTO: RENDERING");
    const mp4 = await ff.readFile("auto.mp4");
    for (const n of files) await o.rm(n);
    return { blob: new Blob([mp4.buffer], { type: "video/mp4" }), w, h, duration, segs };
  } catch (e) {
    for (const n of files) await o.rm(n);
    throw e;
  }
}
