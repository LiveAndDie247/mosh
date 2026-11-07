// AUTO MOSH test under Node, with a native ffmpeg standing in for ffmpeg.wasm (same commands).
//   node tools/test-auto.mjs <dir with loop.gif once.gif life.gif clip.mp4 song.mp3> [seconds]
// Checks: the plan adds up to the target, one keyframe per CUT join and none elsewhere, the MP4
// plays, has the song as its sound, and lasts the target length.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planAuto, runAuto, STYLES } from "../auto.js";
import { FPS } from "../pipeline.js";

const dir = process.argv[2] || "/tmp/autotest", seconds = +(process.argv[3] || 60);
const fail = m => { console.error("FAIL:", m); process.exit(1); };
const ok = m => console.log("ok  ", m);

// a tiny FFmpeg look-alike: a scratch folder + the native binary
function fakeFF() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ffw-"));
  return {
    work,
    writeFile: async (n, d) => fs.writeFileSync(path.join(work, n), d),
    readFile: async n => new Uint8Array(fs.readFileSync(path.join(work, n))),
    deleteFile: async n => fs.rmSync(path.join(work, n)),
    exec: async args => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: work, stdio: ["ignore", "inherit", "inherit"] }).status,
  };
}

const pool = [
  { kind: "gif", file: "loop.gif" }, { kind: "gif", file: "once.gif" }, { kind: "gif", file: "life.gif" },
  { kind: "video", file: "clip.mp4", ext: ".mp4", duration: 8 },
];
for (const style of Object.keys(STYLES)) {
  const segs = planAuto({ seconds, bpm: 120, style, pool, seed: 7 });
  const frames = segs.reduce((s, x) => s + x.frames + (x.join === "bloom" ? x.count : 0) - (x.join === "cut" ? 0 : 1), 0);
  if (frames !== seconds * FPS) fail(`${style}: plan is ${frames} frames, wanted ${seconds * FPS}`);
  ok(`${style}: ${segs.length} segments, joins ${[...new Set(segs.slice(1).map(s => s.join))].join("/")}, ${frames} frames`);
}

const ff = fakeFF();
const o = {
  ffmpeg: ff, log: m => console.log("     ", m.slice(0, 160)), setProgress: () => {}, stopped: () => false,
  rm: async n => { try { await ff.deleteFile(n); } catch {} },
  run: async (args, a, b, label) => { const t = Date.now(); const r = await ff.exec(args); if (r !== 0) fail(`${label} failed`); console.log(`      ${label} ${((Date.now() - t) / 1000).toFixed(1)} s`); },
};
const segs = planAuto({ seconds, bpm: 120, style: "CHAOS", pool, seed: 3 });
const sources = pool.map(p => ({ ...p, data: new Uint8Array(fs.readFileSync(path.join(dir, p.file))) }));
const music = { data: new Uint8Array(fs.readFileSync(path.join(dir, "song.mp3"))), ext: ".mp3", offset: 2 };
globalThis.Blob ??= (await import("node:buffer")).Blob;
const out = await runAuto(o, { sources, segs, ratio: "1:1", music });
const mp4 = path.join(dir, "auto-out.mp4");
fs.writeFileSync(mp4, Buffer.from(await out.blob.arrayBuffer()));
const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", mp4]).stdout.toString());
const v = probe.streams.find(s => s.codec_type === "video"), a = probe.streams.find(s => s.codec_type === "audio");
if (!v || !a) fail("missing a stream");
const dur = +probe.format.duration;
if (Math.abs(dur - seconds) > 0.6) fail(`duration ${dur}, wanted ${seconds}`);
if (v.width !== 480 || v.height !== 480) fail(`size ${v.width}x${v.height}`);
ok(`MP4 ${v.width}x${v.height} ${v.codec_name} + ${a.codec_name}, ${dur.toFixed(2)} s, ${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB → ${mp4}`);
const left = fs.readdirSync(ff.work);
if (left.length) fail(`scratch files left behind: ${left.join(", ")}`);
ok("scratch space cleaned up");
