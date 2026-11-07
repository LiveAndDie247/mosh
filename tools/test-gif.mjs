// Test GIF preparation on the real ffmpeg.wasm core, with real GifCities GIFs from the index:
// 4x nearest-neighbour upscale (capped at 960 wide), ~2 s loop, 30 fps H.264 MP4.
//   node tools/test-gif.mjs [/tmp/mosh-dl/core/package/dist/esm]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gifArgs } from "../gif.js";

const here = path.dirname(fileURLToPath(import.meta.url));
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

const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "clips", "gifcities", "manifest.json"), "utf8"));
console.log(`index: ${manifest.count} GIFs`);
// One GIF from each vibe, plus the widest and the tallest
const pick = [
  ...(manifest.vibes || []).map(v => manifest.gifs.find(g => g.v === v)),
  [...manifest.gifs].sort((a, b) => b.w / b.h - a.w / a.h)[0],
  [...manifest.gifs].sort((a, b) => b.h / b.w - a.h / a.w)[0],
].filter(Boolean);

let failed = 0;
for (const g of pick) {
  const res = await fetch(`${manifest.gifBase}${g.id}.gif`, { headers: { Origin: "https://liveanddie247.github.io" } });
  const cors = res.headers.get("access-control-allow-origin");
  if (!res.ok) { console.log(`${g.id}: HTTP ${res.status}`); failed++; continue; }
  core.FS.writeFile("gc.gif", new Uint8Array(await res.arrayBuffer()));
  const t0 = Date.now();
  const ret = run(...gifArgs("gc.gif", "gc.mp4"));
  if (ret !== 0) { console.log(`${g.id} ${g.w}x${g.h}: ffmpeg failed\n${logs.slice(-8).join("\n")}`); failed++; continue; }
  run("-hide_banner", "-i", "gc.mp4");
  const info = logs.join("\n");
  const dur = info.match(/Duration: (\d+):(\d+):([\d.]+)/), size = info.match(/Video: h264[^\n]*?, (\d+)x(\d+)/);
  const secs = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : NaN;
  const ow = size ? +size[1] : 0, expectW = Math.min(g.w * 4, 960);
  const ok = Math.abs(secs - 2) < 0.15 && Math.abs(ow - expectW) <= 1;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${g.id} [${g.t[0]}] ${g.w}x${g.h} -> ${size ? `${size[1]}x${size[2]}` : "?"}, ${secs.toFixed(2)} s, ${core.FS.readFile("gc.mp4").length} bytes, ${Date.now() - t0} ms, CORS: ${cors}`);
}
console.log(failed ? `FAIL (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
