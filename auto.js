// AUTO MOSH: a pile of GIFs (GifCities and/or your own GIFs and videos) → one moshed clip of a set
// length, cut on the beat, with your song as the sound. One ffmpeg encode for the whole thing:
//   plan → write the sources → autoEncodeArgs (every segment to one MPEG-4 AVI, a keyframe at
//   each cut) → moshChain (delete / bloom / soup / keep each keyframe) → decodeArgs (+ the song).
// Pure planning (planAuto) is separate from running (runAuto), so it can be tested under Node.
import { autoEncodeArgs, chainStarts, decodeArgs, keepColorVf, RATIOS, FPS, DRIFTS, PUSHES } from "./pipeline.js";
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
// `moving`: prefer GIFs with at least this many frames (the index's `f`), so a picture that bleeds
// in brings some movement of its own with it.
export const STYLES = {
  // VORTEX: the reference melt at the reference's pace: a few long arcs. Each GIF plays once under
  // a slow push-in (no rotation: that reads as a picture turning), so its own frames bleed through
  // the previous picture (the pictures sink into each other); then the bloom repeats one pure-push
  // frame for seconds and the picture melts outward. Now and then a picture lands clean (cut) and
  // the arc starts over, like the reference's opening.
  VORTEX:  { joins: [["bloom", 8], ["mosh", 1], ["cut", 1]], beats: [12, 16, 20], bloom: [90, 210], firstBeats: 2, drift: PUSHES, bleed: true, moving: 12, phrase: true, vbeats: [20, 26, 32], vmotion: 0.35 },
  // MELT: the same, shorter arcs, a little soup: rougher, more alive
  MELT:    { joins: [["bloom", 5], ["mosh", 3], ["soup", 1]], beats: [4, 6, 8], bloom: [40, 110], firstBeats: 2, drift: PUSHES, bleed: true, moving: 12, phrase: true, vbeats: [12, 16, 20], vmotion: 0.2 },
  // NATURAL: no push at all, only the clips' own motion (mosh.js pickBloom picks a real motion
  // frame to repeat). GIFs are grainy, so this is the speckle mosh, not the smooth melt.
  NATURAL: { joins: [["bloom", 8], ["mosh", 1], ["cut", 1]], beats: [8, 12, 16], bloom: [90, 210], firstBeats: 2, skip: 10, moving: 20 },
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
    const src = next(), s = pool[src];
    const isVideo = s.kind === "video";
    // the first segment is the only clean one (its keyframe is kept), so keep it short when the style says so
    const beatsN = isVideo && st.vbeats ? pick(rnd, st.vbeats) : segs.length === 0 && st.firstBeats ? st.firstBeats : pick(rnd, st.beats);
    let frames = Math.max(8, Math.round(beatsN * beat * FPS));
    if (total - used - frames < 12) frames = total - used;  // no tiny last segment
    frames = Math.min(frames, total - used);

    // PHRASE (real video, melt styles): the reference's shape, measured off it. The clip's own
    // frames play in short bursts; between them one frame is repeated for seconds: a slow smear
    // (a mid-size motion frame), a hold (a near-still frame), then a heavy swirl (a big one).
    if (st.phrase && isVideo && frames >= 150) {
      const clipF = Math.round((s.duration || 5) * FPS);
      // Many SHORT holds, each from a different moment of the clip, so the motion keeps changing:
      // camera moves make the world stream past the people, people's moves make them trail. One
      // long hold of one moment just loops the same push.
      const nHold = Math.max(4, Math.min(8, Math.round(frames / 90)));
      const lead = 2, gaps = [];
      const room = Math.max(nHold * 3, clipF - 8 - lead - nHold);  // real frames we can spend between holds
      for (let k = 0; k < nHold - 1; k++) gaps.push(Math.max(3, Math.round((room / (nHold - 1)) * (0.6 + 0.8 * rnd()))));
      let R = lead + nHold + gaps.reduce((a, b) => a + b, 0) + 6;
      while (R > clipF - 4 && gaps.some(g => g > 3)) { const i = gaps.indexOf(Math.max(...gaps)); gaps[i]--; R--; }
      const B = Math.max(nHold, frames - R);
      // hold lengths: uneven (some brief, some long), adding up to B
      const wts = Array.from({ length: nHold }, () => 0.5 + rnd());
      const tot = wts.reduce((a, b) => a + b, 0);
      const counts = wts.map(w => Math.max(1, Math.round(B * w / tot)));
      counts[counts.length - 1] += B - counts.reduce((a, b) => a + b, 0);
      // which kind of frame each hold repeats: mostly mid motion, some gentle, some heavy
      const pcts = [0.35, 0.6, 0.15, 0.75, 0.5, 0.8, 0.3, 0.65];
      const blooms = counts.map((c, k) => ({ skip: k === 0 ? lead : gaps[k - 1], pct: pcts[k % pcts.length], count: c, window: 6 }));
      const ss = s.duration > R / FPS + 0.3 ? +(rnd() * (s.duration - R / FPS - 0.2)).toFixed(2) : 0;
      const join = segs.length ? "bloom" : "cut";        // never a clean reset mid-melt: the reference has none
      segs.push({ src, frames: R + (join === "cut" ? 0 : 1), ss, join, count: B, blooms, skip: 0, drift: null, still: false });
      used += frames;
      continue;
    }
    const len = frames / FPS;
    const ss = s.kind === "video" && s.duration > len + 0.2 ? +(rnd() * (s.duration - len)).toFixed(2) : 0;
    const join = segs.length ? weighted(rnd, st.joins) : "cut";
    // `bleed` (DRIFT): the source plays through first, the bloom then repeats a pure-drift frame
    // after that. Otherwise `skip` just leaves the first few motion frames alone so the picture
    // can start bleeding in before one of its motion frames gets repeated.
    // FOOTAGE (real video) moshes on its own motion: no drift, no bleed. Its real frames must fit
    // inside the clip (past its end it would freeze = a pause), so the bloom fills the rest.
    const video = s.kind === "video";
    if (video && join !== "bloom") frames = Math.max(8, Math.min(frames, Math.round((s.duration || 2) * FPS) - 2, total - used));
    const bleed = st.bleed && !video;
    const playFrames = Math.min(Math.round((s.duration || 2) * FPS), frames - 20);
    const minKeep = bleed ? Math.max(8, playFrames + 20) : Math.max(8, (st.skip || 10) + 12);
    // a BLOOM adds `count` repeated frames: take them out of the segment so the total stays exact
    let count = join === "bloom" ? Math.min(pick(rnd, st.bloom), frames - minKeep) : 0;
    if (join === "bloom" && video) count = Math.max(count, Math.min(frames - minKeep, frames - (playFrames - 4)));
    const j = join === "bloom" && count < 2 ? "mosh" : join;
    const skip = j !== "bloom" ? 0 : bleed ? Math.max(0, playFrames + 6) : (st.skip || 10);
    // every join except CUT deletes that segment's keyframe (one frame): encode one extra
    const drift = st.drift && !video ? pick(rnd, st.drift) : null;
    segs.push({ src, frames: frames - Math.max(0, count) + (j === "cut" ? 0 : 1), ss, join: j, count, skip, drift, still: !!st.still });
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
    const encSegs = segs.map(s => ({ name: names[s.src], gif: sources[s.src].kind === "gif", ss: s.ss, drift: s.drift, still: s.still }));
    try {
      await o.run(autoEncodeArgs({ segs: encSegs, frames, w, h }), 0.14, 0.62, "AUTO: ENCODING");
    } catch (e) {
      // the drift (zoompan) is the only exotic thing in the encode: if it fails on this engine or
      // runs out of memory, encode the plain way instead of dying
      if (!encSegs.some(s => s.drift)) throw e;
      o.log(`auto: drift encode failed (${e.message || e}); retrying without drift`);
      await o.rm("chain.avi");
      await o.run(autoEncodeArgs({ segs: encSegs.map(s => ({ ...s, drift: null, still: false })), frames, w, h }), 0.14, 0.62, "AUTO: ENCODING (plain)");
    }
    for (const n of names) await o.rm(n);
    if (o.stopped?.()) throw new Error("stopped");
    o.setProgress(0.63, "AUTO: MOSHING");
    const avi = await ff.readFile("chain.avi");
    await o.rm("chain.avi");
    const starts = chainStarts(frames);
    const joins = segs.slice(1).map((s, k) => ({ at: starts[k + 1], type: s.join, count: s.count, skip: s.skip, blooms: s.blooms }));
    if (segs[0].blooms) joins.unshift({ at: 0, blooms: segs[0].blooms });   // the first clip melts too (the reference's opening)
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
