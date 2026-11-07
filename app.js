// MOSH: the UI and the ffmpeg.wasm plumbing. The datamosh itself is in mosh.js,
// the ffmpeg command lines in pipeline.js.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile } from "./vendor/util/index.js";
import { moshAvi } from "./mosh.js";
import { encodeArgs, decodeArgs, targetSize, MAX_SECONDS } from "./pipeline.js";

// Single-thread core: no SharedArrayBuffer, so it works on GitHub Pages without COOP/COEP
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

const $ = id => document.getElementById(id);
const ui = {
  fileA: $("fileA"), fileB: $("fileB"), cardA: $("cardA"), cardB: $("cardB"), nameA: $("nameA"), nameB: $("nameB"),
  warn: $("warn"), keepA: $("keepA"), keepAOut: $("keepAOut"), bloom: $("bloom"), bloomOut: $("bloomOut"),
  bloomAt: $("bloomAt"), bloomAtOut: $("bloomAtOut"), mosh: $("mosh"), bar: $("bar"), status: $("status"),
  out: $("out"), save: $("save"), log: $("log"),
};

const clips = { A: null, B: null };       // { file, duration, width, height }
let ffmpeg = null, ready = null, result = null, busy = false;

// ---------- small helpers ----------
const fmtSec = s => `${s.toFixed(1)} s`;
function log(line) {
  ui.log.textContent += line + "\n";
  if (ui.log.textContent.length > 60000) ui.log.textContent = ui.log.textContent.slice(-40000);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setProgress(frac, text) {
  if (frac != null) ui.bar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
  if (text) ui.status.textContent = text;
}
const extOf = name => (name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? ".mp4").toLowerCase();

// Read duration and size with a throwaway <video> (no decoding of the whole file)
function probe(file) {
  return new Promise(resolve => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = info => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(info);
    };
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    v.onloadedmetadata = () => done({ duration: isFinite(v.duration) ? v.duration : null, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => done({ duration: null, width: 0, height: 0 });
    setTimeout(() => done({ duration: null, width: 0, height: 0 }), 8000);
    v.src = url;
  });
}

// ---------- picking clips ----------
async function pick(which, input) {
  const file = input.files?.[0];
  if (!file) return;
  const info = await probe(file);
  clips[which] = { file, ...info };
  const card = which === "A" ? ui.cardA : ui.cardB, name = which === "A" ? ui.nameA : ui.nameB;
  card.classList.add("ok");
  name.textContent = `${file.name}${info.duration ? ` · ${fmtSec(info.duration)}` : ""}`;
  if (which === "A" && info.duration) {
    ui.keepA.max = Math.max(0.3, info.duration).toFixed(1);
    if (+ui.keepA.value > info.duration) ui.keepA.value = info.duration.toFixed(1);
    updateLabels();
  }
  refresh();
}

function refresh() {
  const long = Object.entries(clips).filter(([, c]) => c?.duration > MAX_SECONDS);
  const unknown = Object.entries(clips).filter(([, c]) => c && c.duration == null);
  const msgs = [];
  if (long.length) msgs.push(`Clip ${long.map(([k]) => k).join(" and ")} is longer than ${MAX_SECONDS} s. Phones can run out of memory on long clips: trim it first for best results.`);
  if (unknown.length) msgs.push(`Couldn't read the length of clip ${unknown.map(([k]) => k).join(" and ")} in the browser; it may still work.`);
  ui.warn.hidden = !msgs.length;
  ui.warn.textContent = msgs.join(" ");
  ui.mosh.disabled = busy || !clips.A || !clips.B;
  if (!busy) setProgress(0, clips.A && clips.B ? "READY" : "PICK TWO CLIPS");
}

function updateLabels() {
  ui.keepAOut.textContent = fmtSec(+ui.keepA.value);
  const n = +ui.bloom.value;
  ui.bloomOut.textContent = n ? `×${n}` : "off";
  ui.bloomAtOut.textContent = `${ui.bloomAt.value}%`;
  ui.bloomAt.disabled = !n;
}

// ---------- ffmpeg ----------
// Download to a blob: URL with progress (what @ffmpeg/util's toBlobURL does, minus its bug:
// when the server compresses the file, Content-Length counts compressed bytes, the count
// "doesn't match", and toBlobURL then re-reads the already-consumed response and fails with
// "body stream already read"). Here the length is only ever a progress hint.
const WASM_BYTES = 32232419;               // @ffmpeg/core 0.12.10 ffmpeg-core.wasm, for progress
async function blobURL(url, type, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Engine download failed (HTTP ${res.status})`);
  const enc = res.headers.get("Content-Encoding");
  const len = +res.headers.get("Content-Length") || 0;
  const total = enc && enc !== "identity" ? 0 : len;   // compressed: the length isn't the real size
  if (!res.body?.getReader) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
  const reader = res.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total && got <= total ? total : 0);
  }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

async function loadFFmpeg() {
  if (ready) return ready;
  ready = (async () => {
    ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => log(message));
    setProgress(0, "LOADING ENGINE");
    const coreURL = await blobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await blobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm", (got, total) => {
      const f = total ? got / total : got / WASM_BYTES;
      setProgress(Math.min(0.99, f), `LOADING ENGINE ${(got / 1048576).toFixed(1)} MB`);
    });
    await ffmpeg.load({ coreURL, wasmURL });

    // Check this build really has the encoders the pipeline needs
    const lines = [];
    const grab = ({ message }) => lines.push(message);
    ffmpeg.on("log", grab);
    await ffmpeg.exec(["-hide_banner", "-encoders"]);
    ffmpeg.off("log", grab);
    const enc = lines.join("\n");
    if (!/^\s*V\S*\s+mpeg4\s/m.test(enc)) throw new Error("This ffmpeg build has no mpeg4 encoder");
    if (!/^\s*V\S*\s+libx264\s/m.test(enc)) throw new Error("This ffmpeg build has no libx264 encoder");
    log("engine ready: mpeg4 + libx264 encoders present");
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

async function run(args, from, to, label) {
  const onProg = ({ progress }) => {
    if (progress >= 0 && progress <= 1) setProgress(from + (to - from) * progress, `${label} ${Math.round(progress * 100)}%`);
  };
  ffmpeg.on("progress", onProg);
  setProgress(from, label);
  log(`$ ffmpeg ${args.join(" ")}`);
  try {
    const ret = await ffmpeg.exec(args);
    if (ret !== 0) throw new Error(`ffmpeg failed (${label.toLowerCase()}), see LOG`);
  } finally {
    ffmpeg.off("progress", onProg);
  }
}

const rm = async name => { try { await ffmpeg.deleteFile(name); } catch {} };

// ---------- the mosh ----------
async function doMosh() {
  if (busy || !clips.A || !clips.B) return;
  busy = true; document.body.classList.add("busy");
  ui.mosh.disabled = true; ui.save.hidden = true;
  const inA = `a${extOf(clips.A.file.name)}`, inB = `b${extOf(clips.B.file.name)}`;
  try {
    await loadFFmpeg();
    setProgress(0.02, "READING CLIPS");
    await ffmpeg.writeFile(inA, await fetchFile(clips.A.file));
    await ffmpeg.writeFile(inB, await fetchFile(clips.B.file));

    // 1-2. scale, concat, MPEG-4 AVI with one keyframe at the cut
    const size = targetSize(clips.A.width, clips.A.height);
    const keepA = Math.min(+ui.keepA.value, clips.A.duration || +ui.keepA.value);
    await run(encodeArgs({ inA, inB, keepA, w: size.w, h: size.h }), 0.04, 0.5, "ENCODING");
    await rm(inA); await rm(inB);

    // 3-4. remove the I-frames (and bloom) in JavaScript
    setProgress(0.5, "MOSHING");
    const joined = await ffmpeg.readFile("joined.avi");
    await rm("joined.avi");
    const { data, stats } = moshAvi(joined, { bloom: +ui.bloom.value, bloomAt: +ui.bloomAt.value / 100 });
    log(`mosh: ${JSON.stringify(stats)}`);
    if (!stats.removedI) log("note: no keyframe found at the cut; the result may barely mosh");
    await ffmpeg.writeFile("moshed.avi", data);

    // 5. back to a normal H.264 MP4
    await run(decodeArgs("moshed.avi", "mosh.mp4"), 0.52, 0.99, "RENDERING");
    await rm("moshed.avi");
    const mp4 = await ffmpeg.readFile("mosh.mp4");
    await rm("mosh.mp4");

    if (result) URL.revokeObjectURL(result.url);
    const blob = new Blob([mp4.buffer], { type: "video/mp4" });
    result = { blob, url: URL.createObjectURL(blob), name: `mosh-${Date.now()}.mp4` };
    ui.out.src = result.url; ui.out.hidden = false; ui.save.hidden = false;
    ui.out.play().catch(() => {});
    setProgress(1, "DONE");
  } catch (e) {
    console.error(e);
    log(`ERROR: ${e.message || e}`);
    setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 60)}`);
    if (ffmpeg) for (const f of [inA, inB, "joined.avi", "moshed.avi", "mosh.mp4"]) await rm(f);
  } finally {
    busy = false; document.body.classList.remove("busy");
    ui.mosh.disabled = !clips.A || !clips.B;
  }
}

async function save() {
  if (!result) return;
  const file = new File([result.blob], result.name, { type: "video/mp4" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "MOSH" }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = Object.assign(document.createElement("a"), { href: result.url, download: result.name });
  document.body.append(a); a.click(); a.remove();
}

// ---------- wire up ----------
ui.fileA.addEventListener("change", () => pick("A", ui.fileA));
ui.fileB.addEventListener("change", () => pick("B", ui.fileB));
for (const s of [ui.keepA, ui.bloom, ui.bloomAt]) s.addEventListener("input", updateLabels);
ui.mosh.addEventListener("click", doMosh);
ui.save.addEventListener("click", save);
updateLabels();
refresh();

// Installable, and the engine is cached after the first run
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
