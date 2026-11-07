// DAISY CHAIN test on the real ffmpeg.wasm core, under Node:
//   node tools/test-chain.mjs [/tmp/mosh-dl/core/package/dist/esm]
// Four synthetic links (a still checkerboard, a moving square, sliding bars, a moving circle)
// joined MOSH, BLOOM x8, SOUP, exactly as the app renders a chain:
// chainEncodeArgs → moshChain → decodeArgs. Then a LOOPed chain with a CUT (link 1 appended
// and the first copy trimmed off). Checks keyframes, frame counts, the order map, the pictures.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chainEncodeArgs, chainStarts, decodeArgs, FPS } from "../pipeline.js";
import { moshChain, parseAvi, vopType } from "../mosh.js";
import { encodeWav } from "../wav.js";

const coreDir = process.argv[2] || "/tmp/mosh-dl/core/package/dist/esm";
const coreJs = path.join(coreDir, "ffmpeg-core.js"), coreWasm = path.join(coreDir, "ffmpeg-core.wasm");
globalThis.self = globalThis;
globalThis.importScripts ??= () => {};
globalThis.location ??= { href: pathToFileURL(coreJs).href };
const { default: createFFmpegCore } = await import(pathToFileURL(coreJs).href);
const logs = [];
const core = await createFFmpegCore({
  wasmBinary: fs.readFileSync(coreWasm),
  mainScriptUrlOrBlob: `${pathToFileURL(coreJs).href}#${Buffer.from(JSON.stringify({ wasmURL: pathToFileURL(coreWasm).href })).toString("base64")}`,
});
core.setLogger(({ message }) => logs.push(message));
const run = (...args) => { logs.length = 0; core.setTimeout?.(-1); core.exec(...args); const r = core.ret; core.reset(); return r; };
const fail = msg => { console.error("FAIL:", msg); console.error(logs.slice(-20).join("\n")); process.exit(1); };
const ok = msg => console.log("ok  ", msg);

// --- four links -------------------------------------------------------------------------
const W = 360, H = 200;
const gen = (n, paint) => {
  const buf = new Uint8Array(W * H * n);
  for (let f = 0; f < n; f++) paint(buf.subarray(f * W * H, (f + 1) * W * H), f);
  return buf;
};
const links = [
  gen(45, fr => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fr[y * W + x] = ((x >> 4) + (y >> 4)) & 1 ? 230 : 30; }),
  gen(60, (fr, f) => { fr.fill(120); const sx = 10 + f * 5; for (let y = 50; y < 130; y++) for (let x = sx; x < sx + 80 && x < W; x++) fr[y * W + x] = 250; }),
  gen(50, (fr, f) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fr[y * W + x] = ((y + f * 4) >> 3) & 1 ? 200 : 60; }),
  gen(40, (fr, f) => { fr.fill(10); const cx = 60 + f * 6, cy = 100; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < 1600) fr[y * W + x] = 255; }),
];
const frames = links.map(l => l.length / (W * H));
links.forEach((l, i) => {
  core.FS.writeFile(`l${i}.gray`, l);
  if (run("-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", `${FPS}`, "-i", `l${i}.gray`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", `l${i}.mp4`) !== 0) fail(`make link ${i}`);
});
const inputs = links.map((_, i) => `l${i}.mp4`);
const starts = chainStarts(frames);
const total = frames.reduce((a, b) => a + b, 0);
console.log(`links: ${frames.join(" + ")} = ${total} frames, starting at ${starts.join(", ")}`);

// --- 1. encode: keyframes exactly at the joins --------------------------------------------
let t0 = Date.now();
if (run(...chainEncodeArgs({ inputs, frames, w: W, h: H })) !== 0) fail("chain encode");
const avi = core.FS.readFile("chain.avi");
const types = parseAvi(avi).chunks.filter(c => c.id.endsWith("dc")).map(c => vopType(avi, c.o + 8, c.o + 8 + c.size));
const iAt = types.flatMap((t, i) => (t === 0 ? [i] : []));
console.log(`chain.avi: ${types.length} frames, I-frames at ${iAt.join(", ")} (${Date.now() - t0} ms)`);
if (types.length !== total) fail(`expected ${total} frames`);
if (iAt.join() !== starts.join()) fail(`expected I-frames exactly at ${starts.join(", ")}`);
ok("one keyframe at the start of every link, none anywhere else");

// --- 2. mosh the joins ----------------------------------------------------------------------
const BLOOM = 8, SOUP = 30;
const joins = [
  { at: starts[1], type: "mosh" },
  { at: starts[2], type: "bloom", count: BLOOM },
  { at: starts[3], type: "soup" },
];
const { data, stats } = moshChain(avi, joins, { soupFrames: SOUP });
console.log("moshChain:", JSON.stringify({ ...stats, order: undefined }));
if (stats.removedI !== 3) fail("expected 3 keyframes removed (mosh, bloom, soup)");
if (stats.kept !== total - 3 + BLOOM) fail(`expected ${total - 3 + BLOOM} frames out, got ${stats.kept}`);
if (stats.order.length !== stats.kept) fail("order map length");
if (stats.order[starts[1]] !== starts[1] + 1) fail("after the MOSH join, the next frame should be link 2's first motion frame");
ok("MOSH: link 2's keyframe deleted");
const bloomFi = starts[2] + 1;
const copies = stats.order.filter(fi => fi === bloomFi).length;
if (copies !== BLOOM + 1) fail(`BLOOM: link 3's first motion frame should appear ${BLOOM + 1} times, got ${copies}`);
ok(`BLOOM: link 3's first motion frame repeated x${BLOOM}`);
const soupJ = stats.joins.find(j => j.type === "soup");
const iSoup = stats.order.findIndex(fi => fi > starts[3]);
const win = soupJ ? stats.order.slice(iSoup - 1, iSoup - 1 + soupJ.frames) : [];
const alternates = win.every((fi, k) => (k % 2 === 0 ? fi < starts[3] : fi > starts[3]));
if (!soupJ || soupJ.frames < 20 || !alternates) fail(`SOUP: expected ~${SOUP} alternating frames, got ${JSON.stringify(win)}`);
ok(`SOUP: ${soupJ.frames} frames alternate between link 3 and link 4`);
core.FS.writeFile("moshed.avi", data);

// sound: a tone per link, in the moshed order (as buildChainAudio does)
const sr = 48000, per = sr / FPS, L = new Float32Array(Math.round(stats.order.length * per));
const linkOf = fi => starts.filter(s => s <= fi).length - 1;
stats.order.forEach((fi, i) => { const fq = 220 * (1 + linkOf(fi)); for (let j = Math.round(i * per); j < Math.round((i + 1) * per); j++) L[j] = 0.2 * Math.sin((2 * Math.PI * fq * j) / sr); });
core.FS.writeFile("chain.wav", encodeWav(L, L, sr));
if (run(...decodeArgs("moshed.avi", "chain.mp4", "chain.wav", { vf: "eq=saturation=1.3:contrast=1.1" })) !== 0) fail("decode chain");
run("-hide_banner", "-i", "chain.mp4");
if (!/Video: h264/.test(logs.join("\n")) || !/Audio: aac/.test(logs.join("\n"))) fail("chain.mp4 needs H.264 + AAC");
ok("chain.mp4: H.264 + AAC (with a KEEP COLOR eq filter)");

// --- 3. the pictures ------------------------------------------------------------------------
const grab = (file, n) => {
  if (run("-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "f.gray") !== 0) fail(`grab ${file} #${n}`);
  return core.FS.readFile("f.gray");
};
const mad = (p, q) => { let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]); return s / p.length; };
const k = starts[1] + 4;
const m1 = grab("chain.mp4", k), clean2 = grab("chain.avi", k + 1), last1 = grab("chain.avi", starts[1] - 1);
console.log(`MOSH join +4: vs link 1's last frame ${mad(m1, last1).toFixed(1)}, vs clean link 2 ${mad(m1, clean2).toFixed(1)}`);
if (!(mad(m1, last1) < mad(m1, clean2))) fail("after the MOSH join the picture should still be link 1's, smeared");
ok("MOSH join: link 1's picture carries on under link 2's motion");

// --- 4. CUT + LOOP: links 1..4 + link 1 again, last join CUT, trimmed by link 1 -------------
const inputs2 = [...inputs, "l0.mp4"], frames2 = [...frames, frames[0]], starts2 = chainStarts(frames2);
if (run(...chainEncodeArgs({ inputs: inputs2, frames: frames2, w: W, h: H, out: "loop.avi" })) !== 0) fail("loop encode");
const joins2 = [...joins.map((j, i) => ({ ...j, at: starts2[i + 1] })), { at: starts2[4], type: "cut" }];
const r2 = moshChain(core.FS.readFile("loop.avi"), joins2, { soupFrames: SOUP });
if (r2.stats.removedI !== 3 || !r2.stats.joins.some(j => j.type === "cut")) fail("CUT: the keyframe should be kept");
core.FS.writeFile("loop-moshed.avi", r2.data);
const cutOut = r2.stats.order.indexOf(starts2[4]);
const cutPic = grab("loop-moshed.avi", cutOut), cleanFirst = grab("l0.mp4", 0);
console.log(`CUT join: vs clean link 1 frame 0 ${mad(cutPic, cleanFirst).toFixed(1)}`);
if (mad(cutPic, cleanFirst) > 6) fail("after a CUT the picture should be clean");
ok("CUT: a clean keyframe, the picture resets");
const ss = frames2[0] / FPS;
if (run(...decodeArgs("loop-moshed.avi", "loop.mp4", null, { ss })) !== 0) fail("loop decode");
run("-i", "loop.mp4", "-f", "null", "-");
const nOut = +((logs.join("\n").match(/frame=\s*(\d+)/g) || []).pop() || "").replace(/\D/g, "");
const expect = r2.stats.kept - frames2[0];
console.log(`LOOP: ${nOut} frames out, expected ${expect}`);
if (Math.abs(nOut - expect) > 1) fail("LOOP trim is off");
ok("LOOP: the first copy of link 1 is trimmed off");
console.log("PASS");
