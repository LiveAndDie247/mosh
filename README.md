# MOSH

Real I-frame-removal datamosh, entirely in the phone browser. No server: everything runs in
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and plain JavaScript on the device.

**Live:** https://liveanddie247.github.io/mosh/

Pick **Clip A** (the picture that gets smeared) and **Clip B** (the motion source). The result is
A's last picture dragged around by B's movement, with blocky macroblock smearing and colour drift.

## How it works

1. **Load ffmpeg.wasm** (`@ffmpeg/ffmpeg` 0.12, single-thread core, so no COOP/COEP headers are
   needed on GitHub Pages). The core is loaded from jsDelivr with `toBlobURL`; the app checks the
   build has the native `mpeg4` encoder and `libx264` before using it.
2. **Encode** both clips scaled to 480 px wide, same size and 30 fps, no audio, concatenated, as
   MPEG-4 Part 2 in AVI with no keyframes except the first and one forced at the cut
   (`-c:v mpeg4 -q:v 2 -g 9999 -bf 0 -sc_threshold 1000000000 -force_key_frames <cut>`).
3. **Mosh** in JavaScript (`mosh.js`): walk the AVI `movi` chunks, read each frame's VOP type
   (`00 00 01 B6`, top 2 bits of the next byte; 0 = I-frame), keep the first I-frame and delete every
   later one. The old `idx1` is discarded and a new one is written, with fixed frame counts.
4. **Bloom** (optional): after the cut, one chosen P-frame is repeated N times so its motion keeps
   being re-applied and the smear grows.
5. **Render** the moshed AVI to H.264 MP4 (`libx264`, `yuv420p`) for playback and Save / Share.

Keep clips short (under 20 s): everything happens in the phone's memory.

## Files

- `index.html`, `style.css`, `app.js`: the app
- `mosh.js`: the AVI parser and I-frame removal (pure, testable)
- `pipeline.js`: the ffmpeg command lines
- `vendor/`: `@ffmpeg/ffmpeg` and `@ffmpeg/util` (ESM builds, served same-origin so the worker loads)
- `sw.js`, `manifest.webmanifest`, `icons/`: installable web app; caches the engine after first use
- `tools/`: `fetch-ffmpeg.sh` (vendor the packages), `test-pipeline.mjs` (end-to-end test of the
  real pipeline on the real core under Node), `make-icons.py`
