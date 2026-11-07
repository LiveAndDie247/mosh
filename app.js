// MOSH: the UI and the ffmpeg.wasm plumbing. The datamosh itself is in mosh.js, the ffmpeg
// command lines in pipeline.js, the sound in wav.js. The living background is field.js, the
// logo logo.js, the live pads pads.js + live.js.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile } from "./vendor/util/index.js";
import { moshAvi } from "./mosh.js";
import { encodeArgs, decodeArgs, targetSize, framesOf, MAX_SECONDS } from "./pipeline.js";
import { buildMoshAudio } from "./wav.js";
import { Field, patternImage } from "./field.js";
import { Logo } from "./logo.js";
import { sfx, audio } from "./sfx.js";
import { PadMode } from "./pads.js";

const BUILD = 8;                          // shown in the LOG, so a screenshot tells which version ran

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

// One still frame from a clip, as a canvas (for the background)
function grabFrame(file, at = 0.2) {
  return new Promise(resolve => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = c => { if (settled) return; settled = true; URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(c); };
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.onloadeddata = () => { v.currentTime = Math.min(at, (v.duration || 1) * 0.5); };
    v.onseeked = () => {
      const s = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(v.videoWidth * s)); c.height = Math.max(1, Math.round(v.videoHeight * s));
      try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); done(c); } catch { done(null); }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 10000);
    v.src = url;
  });
}

// ---------- the living background and the logo ----------
let swipe = [1, 1];                       // last drag direction: the logo bursts this way
const field = new Field($("bg"), { onSwipe: (dx, dy) => { swipe = [dx, dy]; } });
field.setImage(patternImage());
const logo = new Logo($("logo"));

// MOSH is the "pad hit": a shockwave through the background and a hard burst on the logo.
// While it's held the logo keeps melting and never heals.
ui.mosh.addEventListener("pointerdown", () => {
  audio();
  logo.hold(true);
  logo.burst(...swipe);
  field.shock(innerWidth / 2, innerHeight / 2, 1);
  sfx.shock();
});
for (const t of ["pointerup", "pointercancel", "pointerleave"]) ui.mosh.addEventListener(t, () => logo.hold(false));

// LIVE PADS: the finished mosh lands here. Every pad hit is a shockwave + a logo burst;
// their MOSH keeps the logo melting.
const pads = new PadMode($("pads"), {
  loadFFmpeg: async () => {
    if (busy) throw new Error("wait for the render to finish first");
    await loadFFmpeg();
    return ffmpeg;
  },
  log,
  onHit: () => { logo.burst(...swipe); field.shock(innerWidth / 2, innerHeight / 2, 0.7); },
  onMosh: on => logo.hold(on),
});

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
  // The background becomes Clip A's picture
  if (which === "A") {
    const frame = await grabFrame(file);
    if (frame) field.setImage(frame);
  }
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
  field.bloom = n / 30;                  // BLOOM also makes the background keep re-applying its vectors
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
    const { order, ...summary } = stats;
    log(`mosh: ${JSON.stringify(summary)}`);
    if (!stats.removedI) log("note: no keyframe found at the cut; the result may barely mosh");
    await ffmpeg.writeFile("moshed.avi", data);

    // The sound, frame by frame in the same order as the moshed picture (bloom stutters too)
    let wav = null;
    try {
      setProgress(0.51, "SOUND");
      await ffmpeg.writeFile("mosh.wav", await buildMoshAudio(audio(), clips.A.file, clips.B.file, framesOf(keepA), order));
      wav = "mosh.wav";
    } catch (e) {
      log(`no sound: ${e.message || e}`);
    }

    // 5. back to a normal H.264 MP4 (+ AAC sound)
    await run(decodeArgs("moshed.avi", "mosh.mp4", wav), 0.52, 0.99, "RENDERING");
    await rm("moshed.avi"); await rm("mosh.wav");
    const mp4 = await ffmpeg.readFile("mosh.mp4");
    await rm("mosh.mp4");

    if (result) URL.revokeObjectURL(result.url);
    const blob = new Blob([mp4.buffer], { type: "video/mp4" });
    result = { blob, url: URL.createObjectURL(blob), name: `mosh-${Date.now()}.mp4`, w: size.w, h: size.h };
    ui.out.src = result.url; ui.save.hidden = false;
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
  // The finished mosh goes onto the pads (the pad screen is the player). If that fails,
  // fall back to the plain video player.
  if (result && ui.out.src === result.url && !result.onPads) {
    result.onPads = true;
    const ok = await pads.loadMoshed(new File([result.blob], result.name, { type: "video/mp4" }), result.w, result.h);
    ui.out.hidden = ok;
    if (ok) $("pads").scrollIntoView({ behavior: "smooth", block: "start" });
    else ui.out.play().catch(() => {});
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
log(`MOSH build ${BUILD}`);
if (!field.ok) log(`background off: ${field.error}`);

// Installable, and the engine is cached after the first run. When a new version of the
// service worker takes over (after a deploy), reload once so the new app code runs.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded && !busy) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(() => {});
}
