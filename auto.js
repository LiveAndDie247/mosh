// AUTO MOSH: a pile of GIFs (GifCities and/or your own GIFs and videos) → one moshed clip of a set
// length, cut on the beat, with your song as the sound. One ffmpeg encode for the whole thing:
//   plan → write the sources → autoEncodeArgs (every segment to one MPEG-4 AVI, a keyframe at
//   each cut) → moshChain (delete / bloom / soup / keep each keyframe) → decodeArgs (+ the song).
// Pure planning (planAuto) is separate from running (runAuto), so it can be tested under Node.
import { autoEncodeArgs, chainStarts, decodeArgs, keepColorVf, RATIOS, FPS, DRIFTS } from "./pipeline.js";
import { moshChain } from "./mosh.js";

// Styles: how cuts are joined, how long segments are (in beats), how hard blooms are.
// A BLOOM repeats the frame after a cut N times, so the motion keeps smearing: big bloom + long
// holds = the continuous "Drake & Josh" vortex melt. Small bloom + short holds = choppy glitch.
// The mosh only happens AT a join (keyframe deleted → the next motion drags the held picture),
// so SHORT segments = constant smear, LONG segments = the clip plays clean between blips. For a
// continuous melt: short holds, never a "cut" (which resets to a clean picture), steady bloom.
// `drift`: the GIF only supplies the picture; the engine supplies the motion (pipeline.js DRIFTS),
// so every join drags the previous picture into a zoom / spin / pan. That is the reference vortex.
// The smooth ones. No pan (it tears) and no zoomout: zooming OUT reveals new pixels at the edges,
// which get painted in clean and rebuild the picture. Zoom in / spin / spiral only ever re-use pixels.
const SWIRL = ["spiral", "spiralr", "zoomin", "spin"];
export const STYLES = {
  // VORTEX: the continuous melt — each GIF frozen to one picture and dragged into a spiral; no clean resets
  VORTEX: { joins: [["bloom", 6], ["mosh", 4]], beats: [4, 6, 8], bloom: [24, 60], firstBeats: 1, drift: SWIRL, still: true },
  // MELT: the GIFs keep playing under the drift (more life, a little rougher)
  MELT:   { joins: [["bloom", 5], ["mosh", 3], ["soup", 1]], beats: [3, 4, 6], bloom: [16, 40], firstBeats: 2, drift: DRIFTS },
  SMEAR:  { joins: [["mosh", 5], ["bloom", 3], ["cut", 1]], beats: [2, 3, 4, 6], bloom: [10, 24] },
  CHAOS:  { joins: [["mosh", 4], ["bloom", 3], ["soup", 2], ["cut", 1]], beats: [1, 2, 2, 4], bloom: [8, 20] },
  CLEAN:  { joins: [["cut", 5], ["mosh", 4], ["bloom", 1]], beats: [4, 4, 8], bloom: [6, 14] },
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
  let last = -1;                                       // so a source never lands twice in a row
  const next = () => {
    if (!order.length) {
      const idx = pool.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      if (idx.length > 1 && idx[0] === last) [idx[0], idx[1]] = [idx[1], idx[0]];  // not the same as the last one used
      order.push(...idx);
    }
    const v = order.shift();
    last = v;
    return v;
  };
  const segs = [];
  let used = 0;
  while (used < total) {
    // the first segment is the only clean one (its keyframe is kept), so keep it short when the style says so
    const beatsN = segs.length === 0 && st.firstBeats ? st.firstBeats : pick(rnd, st.beats);
    let frames = Math.max(8, Math.round(beatsN * beat * FPS));
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
    const drift = st.drift ? pick(rnd, st.drift) : null;
    segs.push({ src, frames: frames - Math.max(0, count) + (j === "cut" ? 0 : 1), ss, join: j, count, drift, still: !!st.still });
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
    const enc = autoEncodeArgs({ segs: segs.map(s => ({ name: names[s.src], gif: sources[s.src].kind === "gif", ss: s.ss, drift: s.drift, still: s.still })), frames, w, h });
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
