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
//   segs: [{ name, gif: bool, ss: seconds }]
export function autoEncodeArgs({ segs, frames, w, h, out = "chain.avi" }) {
  const inputs = segs.flatMap((s, i) => {
    const t = (frames[i] / FPS + 0.6).toFixed(3);              // read a little past the cut
    return [...(s.gif ? ["-ignore_loop", "0"] : []), ...(s.ss ? ["-ss", s.ss.toFixed(3)] : []), "-t", t, "-i", s.name];
  });
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS},format=yuv420p`;
  const parts = segs.map((s, i) =>
    `[${i}:v]tpad=stop_mode=clone:stop_duration=${(frames[i] / FPS + 1).toFixed(3)},` +
    `${s.gif ? "scale='min(iw*4,960)':-2:flags=neighbor," : ""}${fit},trim=end_frame=${frames[i]},setpts=PTS-STARTPTS[v${i}]`);
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
