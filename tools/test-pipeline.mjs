// End-to-end test of the real pipeline on the real ffmpeg.wasm core, under Node.
//   node tools/test-pipeline.mjs [/tmp/mosh-dl/core/package/dist/esm]
// 1. lists encoders and checks for the native "mpeg4" encoder and libx264
// 2. makes two synthetic clips (A: a still picture, B: a moving square)
// 3. runs encodeArgs (pipeline.js) → moshAvi (mosh.js) → decodeArgs, exactly as the app does
// 4. checks the result: one I-frame removed at the cut, bloom copies inserted, and that the
//    moshed frames after the cut look like Clip A (smeared), not like Clip B.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeArgs, decodeArgs, targetSize, FPS } from "../pipeline.js";
import { moshAvi, parseAvi, vopType } from "../mosh.js";
import { encodeWav } from "../wav.js";

const coreDir = process.argv[2] || "/tmp/mosh-dl/core/package/dist/esm";
const coreJs = path.join(coreDir, "ffmpeg-core.js");
const coreWasm = path.join(coreDir, "ffmpeg-core.wasm");

// The core is built for browsers/workers: pretend to be a worker, hand it the wasm bytes.
globalThis.self = globalThis;
globalThis.importScripts ??= () => {};
globalThis.location ??= { href: pathToFileURL(coreJs).href };

const { default: createFFmpegCore } = await import(pathToFileURL(coreJs).href);
const logs = [];
const core = await createFFmpegCore({
  wasmBinary: fs.readFileSync(coreWasm),
  locateFile: f => path.join(coreDir, f),
  mainScriptUrlOrBlob: `${pathToFileURL(coreJs).href}#${Buffer.from(JSON.stringify({ wasmURL: pathToFileURL(coreWasm).href })).toString("base64")}`,
});
core.setLogger(({ message }) => logs.push(message));
const run = (...args) => {
  logs.length = 0;
  if (core.setTimeout) core.setTimeout(-1);
  core.exec(...args);
  const ret = core.ret;
  core.reset();
  return ret;
};
const fail = msg => { console.error("FAIL:", msg); console.error(logs.slice(-25).join("\n")); process.exit(1); };

// --- 1. encoders --------------------------------------------------------------
run("-hide_banner", "-encoders");
const enc = logs.join("\n");
const hasMpeg4 = /^\s*V\S*\s+mpeg4\s/m.test(enc);
const hasX264 = /^\s*V\S*\s+libx264\s/m.test(enc);
console.log("mpeg4 encoder:", hasMpeg4 ? "YES" : "NO");
console.log("libx264 encoder:", hasX264 ? "YES" : "NO");
const hasAac = /^\s*A\S*\s+aac\s/m.test(enc);
console.log("aac encoder:", hasAac ? "YES" : "NO");
if (!hasMpeg4 || !hasX264 || !hasAac) fail("the core is missing a required encoder");

// --- 2. synthetic phone clips (gray raw frames → H.264 MP4, like a camera file) ---
const W = 480, Hh = 270, nA = 45, nB = 60;            // A: 1.5 s, B: 2 s
const still = new Uint8Array(W * Hh);
for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++)
  still[y * W + x] = ((x >> 5) + (y >> 5)) & 1 ? 220 : 40;   // a checkerboard: easy to see smeared
const a = new Uint8Array(W * Hh * nA);
for (let f = 0; f < nA; f++) a.set(still, f * W * Hh);
const b = new Uint8Array(W * Hh * nB);
for (let f = 0; f < nB; f++) {
  const fr = b.subarray(f * W * Hh, (f + 1) * W * Hh);
  fr.fill(128);
  const sx = 20 + f * 6, sy = 60 + Math.round(40 * Math.sin(f / 8));
  for (let y = sy; y < sy + 120; y++) for (let x = sx; x < sx + 120; x++) if (x < W && y < Hh) fr[y * W + x] = 250;
}
core.FS.writeFile("a.gray", a);
core.FS.writeFile("b.gray", b);
const mkClip = (src, dst) => run("-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${Hh}`, "-r", `${FPS}`, "-i", src,
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", dst);
if (mkClip("a.gray", "a.mp4") !== 0) fail("could not make clip A");
if (mkClip("b.gray", "b.mp4") !== 0) fail("could not make clip B");

// --- 3. the app's pipeline ------------------------------------------------------
const size = targetSize(W, Hh);
const keepA = nA / FPS;
const t0 = Date.now();
if (run(...encodeArgs({ inA: "a.mp4", inB: "b.mp4", keepA, w: size.w, h: size.h })) !== 0) fail("encode to AVI failed");
const joined = core.FS.readFile("joined.avi");
console.log(`joined.avi: ${joined.length} bytes (${Date.now() - t0} ms)`);

// frame types before moshing
const { chunks } = parseAvi(joined);
const types = chunks.filter(c => c.id.endsWith("dc")).map(c => vopType(joined, c.o + 8, c.o + 8 + c.size));
const iAt = types.flatMap((t, i) => (t === 0 ? [i] : []));
console.log(`frames: ${types.length}, I-frames at: ${iAt.join(", ")}`);
if (iAt.length !== 2 || iAt[0] !== 0 || iAt[1] !== nA) fail(`expected I-frames at 0 and ${nA} (the cut), got ${iAt}`);

const BLOOM = 10;
const { data: moshed, stats } = moshAvi(joined, { bloom: BLOOM, bloomAt: 0.25 });
console.log("mosh stats:", JSON.stringify(stats));
if (stats.removedI !== 1) fail("expected exactly one I-frame removed");
if (stats.kept !== types.length - 1 + BLOOM) fail("frame count after mosh is wrong");
if (stats.order.length !== stats.kept) fail("frame order map has the wrong length");
if (stats.order[nA] !== nA + 1) fail(`after the cut, output frame ${nA} should come from original frame ${nA + 1} (B's I-frame is gone)`);
core.FS.writeFile("moshed.avi", moshed);

// The sound: a tone per source clip, laid out in the moshed frame order (as wav.js does)
const sr = 48000, per = sr / FPS, L = new Float32Array(Math.round(stats.order.length * per));
stats.order.forEach((k, i) => {
  const f = k < nA ? 330 : 550;
  for (let j = Math.round(i * per); j < Math.round((i + 1) * per); j++) L[j] = 0.3 * Math.sin((2 * Math.PI * f * j) / sr);
});
core.FS.writeFile("mosh.wav", encodeWav(L, L, sr));

if (run(...decodeArgs("moshed.avi", "mosh.mp4", "mosh.wav")) !== 0) fail("decode to MP4 (with sound) failed");
const mp4 = core.FS.readFile("mosh.mp4");
console.log(`mosh.mp4: ${mp4.length} bytes`);
run("-hide_banner", "-i", "mosh.mp4");
const streams = logs.join("\n");
if (!/Video: h264/.test(streams) || !/Audio: aac/.test(streams)) fail("mosh.mp4 should have an H.264 video and an AAC audio stream");
console.log("mosh.mp4 streams: H.264 video + AAC audio");

// --- 4. does it actually mosh? Compare a frame just after the cut ---------------
const grab = (file, n) => {
  if (run("-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "f.gray") !== 0) fail(`grab ${file} #${n}`);
  return core.FS.readFile("f.gray");
};
const mad = (p, q) => { let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]); return s / p.length; };
const k = nA + 3;                                      // a few frames into Clip B
const clean = grab("joined.avi", k), moshedF = grab("mosh.mp4", k);
const lastA = grab("joined.avi", nA - 1);
const dA = mad(moshedF, lastA), dB = mad(moshedF, clean);
console.log(`frame ${k}: moshed vs Clip A's last frame = ${dA.toFixed(1)}, moshed vs clean Clip B = ${dB.toFixed(1)}`);
if (!(dA < dB)) fail("moshed frames don't look like Clip A: the I-frame removal had no effect");
console.log("PASS");
