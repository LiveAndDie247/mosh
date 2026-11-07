// The ffmpeg command lines. Shared by the app and the Node test, so the test runs
// exactly what the phone runs.

export const WIDTH = 480;          // phone memory: everything is scaled to 480 px wide
export const FPS = 30;
export const MAX_SECONDS = 20;     // longer clips get a warning (they may run out of memory)

// Output size: 480 wide, height from Clip A's aspect, even, within sane limits
export function targetSize(w, h) {
  if (!w || !h) return { w: WIDTH, h: 854 };
  const H = Math.round((WIDTH * h) / w / 2) * 2;
  return { w: WIDTH, h: Math.min(1280, Math.max(64, H)) };
}

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

// Step 5: decode the moshed AVI back to a normal H.264 MP4 the phone can play and share
export function decodeArgs(inp = "moshed.avi", out = "mosh.mp4") {
  return [
    "-i", inp,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", out,
  ];
}
