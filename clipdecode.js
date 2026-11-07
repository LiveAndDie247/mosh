// Decode a clip once, up front, so the pads can play it instantly: every frame as raw RGBA
// (small, so it fits in a phone's GPU memory) and the sound as an AudioBuffer (+ a reversed copy).
import { fetchFile } from "./vendor/util/index.js";

export const PAD_W = 256;          // frame width in pad mode
export const PAD_FPS = 24;
export const PAD_MAX = 8;          // seconds per clip (8 s x 24 fps = 192 frames, ~90 MB on the GPU)

// Frame size from the clip's aspect: 256 wide, height a multiple of 8 (whole 8x8 blocks)
export function padSize(w, h) {
  if (!w || !h) return { w: PAD_W, h: 456 };
  const H = Math.round((PAD_W * h) / w / 8) * 8;
  return { w: PAD_W, h: Math.min(512, Math.max(64, H)) };
}

export async function decodeClip(ffmpeg, file, { w, h }, ac, onProgress) {
  const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? ".mp4").toLowerCase();
  const name = `pad${ext}`;
  await ffmpeg.writeFile(name, await fetchFile(file));
  const onProg = ({ progress }) => { if (progress >= 0 && progress <= 1) onProgress?.(progress); };
  ffmpeg.on("progress", onProg);
  let ret;
  try {
    ret = await ffmpeg.exec([
      "-i", name, "-t", String(PAD_MAX), "-an",
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${PAD_FPS},format=rgba`,
      "-f", "rawvideo", "pad.rgba",
    ]);
  } finally {
    ffmpeg.off("progress", onProg);
  }
  try { await ffmpeg.deleteFile(name); } catch {}
  if (ret !== 0) throw new Error("couldn't decode the video (see LOG)");
  const raw = await ffmpeg.readFile("pad.rgba");
  try { await ffmpeg.deleteFile("pad.rgba"); } catch {}
  const frameBytes = w * h * 4, n = Math.floor(raw.length / frameBytes);
  if (!n) throw new Error("no frames decoded");
  const duration = n / PAD_FPS;

  let buf = null;
  try { buf = await ac.decodeAudioData(await file.arrayBuffer()); } catch {}
  const audio = trim(ac, buf, duration);
  return {
    w, h, n, duration,
    frames: raw.length === n * frameBytes ? raw : raw.subarray(0, n * frameBytes),
    audio, rev: reverse(ac, audio), silent: !buf,
  };
}

// The sound, cut to the same length as the frames (silence if the clip has none)
function trim(ac, buf, dur) {
  const len = Math.max(1, Math.round(dur * ac.sampleRate));
  const out = ac.createBuffer(buf ? buf.numberOfChannels : 1, len, ac.sampleRate);
  if (buf) for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.copyToChannel(buf.getChannelData(ch).subarray(0, Math.min(len, buf.length)), ch);
  }
  return out;
}

function reverse(ac, buf) {
  const out = ac.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).slice().reverse(), ch);
  return out;
}
