// The ffmpeg command lines. Shared by the app and the Node test, so the test runs
// exactly what the phone runs.

export const WIDTH = 480;          // phone memory: everything is scaled to 480 px wide
export const FPS = 30;
export const MAX_SECONDS = 20;     // longer clips get a warning (they may run out of memory)

// Output size: 480 wide (DAISY links: 360), height from Clip A's aspect, even, within sane limits
export function targetSize(w, h, width = WIDTH) {
  if (!w || !h) return { w: width, h: Math.round((width * 16) / 9 / 2) * 2 };
  const H = Math.round((width * h) / w / 2) * 2;
  return { w: width, h: Math.min(Math.round(width * 2.67), Math.max(64, H)) };
}

// DAISY CHAIN: every link scaled to one size, cut to exactly `frames[i]` frames (padded by
// repeating its last frame if it's a little short), concatenated, and encoded as one MPEG-4
// AVI with a forced keyframe exactly where each link starts (and nowhere else).
export function chainEncodeArgs({ inputs, frames, w, h, out = "chain.avi" }) {
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS},format=yuv420p`;
  const parts = inputs.map((_, i) =>
    `[${i}:v]${fit},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${frames[i]},setpts=PTS-STARTPTS[v${i}]`);
  const cat = `${inputs.map((_, i) => `[v${i}]`).join("")}concat=n=${inputs.length}:v=1:a=0[v]`;
  const starts = chainStarts(frames).slice(1);
  return [
    ...inputs.flatMap(f => ["-i", f]),
    "-filter_complex", `${parts.join(";")};${cat}`,
    "-map", "[v]", "-an",
    "-c:v", "mpeg4", "-q:v", "2", "-g", "9999", "-bf", "0", "-sc_threshold", "1000000000",
    ...(starts.length ? ["-force_key_frames", starts.map(f => (f / FPS).toFixed(6)).join(",")] : []),
    "-f", "avi", out,
  ];
}

// The frame where each link starts
export const chainStarts = frames => frames.reduce((a, n, i) => (a.push(i ? a[i - 1] + frames[i - 1] : 0), a), []);

// AUTO MOSH: the chain straight from the raw sources, in one encode. Each segment is a GIF (looped
// if it loops, its last frame held if it doesn't, upscaled with nearest-neighbour so the pixels stay
// crisp) or a window of a video (`ss` seconds in), cut to exactly `frames[i]` frames. Same output
// as chainEncodeArgs: one MPEG-4 AVI with a forced keyframe exactly where each segment starts.
//   segs: [{ name, gif: bool, ss: seconds, drift: null | a DRIFTS kind }]
// A segment with `drift` plays its GIF once, holds the picture, and zooms / rotates / pans it the
// whole way (driftVf), so the motion that drags the previous picture is strong and coherent.
export function autoEncodeArgs({ segs, frames, w, h, out = "chain.avi" }) {
  const inputs = segs.flatMap((s, i) => {
    const t = (frames[i] / FPS + 0.6).toFixed(3);              // read a little past the cut
    const loop = s.gif && !s.drift ? ["-ignore_loop", "0"] : [];   // drifting: play once, then hold
    return [...loop, ...(s.ss ? ["-ss", s.ss.toFixed(3)] : []), "-t", t, "-i", s.name];
  });
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS},format=yuv420p`;
  // `still`: freeze the source to its first picture before drifting (no GIF frames rebuilding it)
  const parts = segs.map((s, i) =>
    `[${i}:v]${s.still ? "trim=end_frame=1,setpts=PTS-STARTPTS," : ""}tpad=stop_mode=clone:stop_duration=${(frames[i] / FPS + 1).toFixed(3)},` +
    `${s.gif && !s.drift ? "scale='min(iw*4,960)':-2:flags=neighbor," : ""}${s.drift ? driftVf(s.drift, frames[i], w, h) : fit},trim=end_frame=${frames[i]},setpts=PTS-STARTPTS[v${i}]`);
  const cat = `${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`;
  const starts = chainStarts(frames).slice(1);
  return [
    ...inputs,
    "-filter_complex", `${parts.join(";")};${cat}`,
    "-map", "[v]", "-an",
    "-c:v", "mpeg4", "-q:v", "2", "-g", "9999", "-bf", "0", "-sc_threshold", "1000000000",
    ...(starts.length ? ["-force_key_frames", starts.map(f => (f / FPS).toFixed(6)).join(",")] : []),
    "-f", "avi", out,
  ];
}

// DRIFT: synthetic motion for the VORTEX melt. A datamosh only drags a picture as hard as the
// motion in the frames after the cut, and most GIFs barely move, so they just swap pictures with
// speckles. Instead, the GIF supplies the picture and we supply the motion: the picture is scaled
// up and slowly zoomed / rotated / panned, so its P-frames are pure coherent motion vectors with
// almost no residual. Deleting the keyframe then drags the previous picture into that motion: the
// spiral vortex. Returns a filter chain that ends at w×h, FPS, yuv420p.
// The drift is SLOW on purpose: the swirl is built by BLOOM re-applying one small motion step
// dozens of times, so a gentle per-frame step accumulates into a smooth vortex while the picture
// stays recognizable for seconds (like the reference). A fast drift wipes the picture to mush in
// a second and leaves nothing to smear.
// No rotation in the PUSH set: a turning picture reads as a picture turning. A slow push-in reads
// as camera motion (what the reference's motion is), and off-centre pushes melt asymmetrically,
// which looks organic rather than a bullseye.
export const DRIFTS = ["spiral", "spiralr", "zoomin", "zoomout", "spin", "pan"];
export const PUSHES = ["push", "pushL", "pushR", "pushU", "pushD"];
export function driftVf(kind, frames, w, h) {
  const N = Math.max(1, frames);
  // resample to FPS first: zoompan (d=1) emits one frame per input frame, so a 12 fps GIF would come up short.
  // Smooth (bicubic) scale, not the crisp nearest-neighbour: the vortex should flow, not ring.
  // At the OUTPUT size, not 2x: ffmpeg buffers frames from every segment at once, and 2x frames
  // are 4x the memory, which is more than a phone has. The zoom goes a little soft; a mosh doesn't care.
  const big = `fps=${FPS},scale=${4 * w}:${4 * h}:force_original_aspect_ratio=increase:flags=bicubic,crop=${4 * w}:${4 * h},setsar=1`;
  const rot = r => `rotate='t*${r}':c=black:ow=iw:oh=ih`;
  const zp = (z, x = "iw/2-(iw/zoom/2)", y = "ih/2-(ih/zoom/2)") => `zoompan=z='${z}':d=1:x='${x}':y='${y}':s=${w}x${h}:fps=${FPS}`;
  // off-centre push: the crop window drifts toward a corner as it zooms (stays inside the 2x frame)
  const z = `1.05+0.26*on/${N}`;
  const push = (cx, cy) => zp(z, `iw/2-(iw/zoom/2)+(${cx})*(iw-iw/zoom)/2*on/${N}`, `ih/2-(ih/zoom/2)+(${cy})*(ih-ih/zoom)/2*on/${N}`);
  const chain = {
    push:    `${big},${push(0, 0)}`,
    pushL:   `${big},${push(-0.6, 0.15)}`,
    pushR:   `${big},${push(0.6, -0.15)}`,
    pushU:   `${big},${push(0.15, -0.6)}`,
    pushD:   `${big},${push(-0.15, 0.6)}`,
    spiral:  `${big},${rot(0.09)},${zp(`1.05+0.22*on/${N}`)}`,
    spiralr: `${big},${rot(-0.09)},${zp(`1.05+0.22*on/${N}`)}`,
    zoomin:  `${big},${zp(`1.05+0.3*on/${N}`)}`,
    zoomout: `${big},${zp(`1.35-0.3*on/${N}`)}`,
    spin:    `${big},${rot(0.14)},${zp("1.2")}`,
    pan:     `${big},${zp("1.3", `(iw-iw/zoom)*on/${N}`)}`,
  }[kind] || `${big},${rot(0.09)},${zp(`1.05+0.22*on/${N}`)}`;
  return `${chain},format=yuv420p`;
}

// Output sizes for AUTO MOSH (all 480 wide, like everything else)
export const RATIOS = { "1:1": { w: 480, h: 480 }, "9:16": { w: 480, h: 854 }, "16:9": { w: 480, h: 270 } };

// Whole frames of Clip A to keep, so the forced keyframe lands exactly on B's first frame
export const framesOf = sec => Math.max(1, Math.round(sec * FPS));

// Step 2: scale both clips to the same size and frame rate, drop audio, concat, and
// encode MPEG-4 Part 2 into AVI with exactly one extra keyframe, right at the cut.
export function encodeArgs({ inA, inB, keepA, w, h, out = "joined.avi" }) {
  const nA = framesOf(keepA), cutT = (nA / FPS).toFixed(6);
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS},format=yuv420p`;
  return [
    "-i", inA, "-i", inB,
    "-filter_complex", `[0:v]${fit},trim=end_frame=${nA},setpts=PTS-STARTPTS[a];[1:v]${fit},setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]`,
    "-map", "[v]", "-an",
    "-c:v", "mpeg4", "-q:v", "2", "-g", "9999", "-bf", "0", "-sc_threshold", "1000000000",
    "-force_key_frames", cutT,
    "-f", "avi", out,
  ];
}

// Step 5: decode the moshed AVI back to a normal H.264 MP4 the phone can play and share,
// with the sound (a WAV built to match the moshed frames) if there is one
// Options: vf (a filter for the picture, e.g. KEEP COLOR's eq=…), ss (start this many seconds
// in: a LOOPed chain drops its first copy of link 1), music ({ name, offset, duration }: a song
// file as the sound instead of a WAV, from `offset` seconds in, padded with silence if it runs
// out, and faded out over the last 1.5 s of the picture).
export function decodeArgs(inp = "moshed.avi", out = "mosh.mp4", wav = null, { vf = null, ss = 0, music = null } = {}) {
  const video = [...(vf ? ["-vf", vf] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  const start = ss > 0 ? ["-ss", ss.toFixed(6)] : [];
  if (music) {
    const fadeAt = Math.max(0, (music.duration || 0) - 1.5).toFixed(3);
    return [
      "-i", inp, ...(music.offset > 0 ? ["-ss", music.offset.toFixed(3)] : []), "-i", music.name,
      "-map", "0:v", "-map", "1:a", ...start, ...video,
      "-af", `apad,afade=t=out:st=${fadeAt}:d=1.5`, "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out,
    ];
  }
  if (!wav) return ["-i", inp, ...start, ...video, "-movflags", "+faststart", "-an", out];
  return [
    "-i", inp, "-i", wav, "-map", "0:v", "-map", "1:a", ...start,
    ...video, "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out,
  ];
}

// KEEP COLOR (0..100): more saturation and contrast, so generations of moshing don't fade to brown
export const keepColorVf = k => (k > 0 ? `eq=saturation=${(1 + 0.6 * k / 100).toFixed(3)}:contrast=${(1 + 0.2 * k / 100).toFixed(3)}` : null);
