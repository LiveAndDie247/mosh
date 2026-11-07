// MOSH: the UI and the ffmpeg.wasm plumbing. The datamosh itself is in mosh.js, the ffmpeg
// command lines in pipeline.js, the sound in wav.js. The living background is field.js, the
// logo logo.js, the live pads pads.js + live.js, GifCities gif.js.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile } from "./vendor/util/index.js";
import { moshAvi } from "./mosh.js";
import { encodeArgs, decodeArgs, targetSize, framesOf, MAX_SECONDS, FPS } from "./pipeline.js";
import { PAD_MAX } from "./clipdecode.js";
import { bank, makeThumb } from "./bank.js";
import { Daisy } from "./daisy.js";
import { buildMoshAudio } from "./wav.js";
import { Field, patternImage } from "./field.js";
import { Logo } from "./logo.js";
import { sfx, audio } from "./sfx.js";
import { PadMode } from "./pads.js";
import { Layout } from "./layout.js";
import { GifSheet, loadIndex, randomGif, randomVibe, prepareGif, gifURL, gifArgs } from "./gif.js";

const BUILD = 15;                         // shown in the LOG, so a screenshot tells which version ran

// Single-thread core: no SharedArrayBuffer, so it works on GitHub Pages without COOP/COEP
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

const $ = id => document.getElementById(id);
const ui = {
  fileA: $("fileA"), fileB: $("fileB"), cardA: $("cardA"), cardB: $("cardB"), nameA: $("nameA"), nameB: $("nameB"),
  warn: $("warn"), keepA: $("keepA"), keepAOut: $("keepAOut"), mosh: $("mosh"), bar: $("bar"), status: $("status"),
  out: $("out"), save: $("save"), log: $("log"),
  thumbA: $("thumbA"), thumbB: $("thumbB"), randBoth: $("randBoth"), randSettings: $("randSettings"), autoMosh: $("autoMosh"),
};

const clips = { A: null, B: null };       // { file, duration, width, height }
let ffmpeg = null, ready = null, result = null, busy = false, prepping = false;

// ---------- small helpers ----------
const fmtSec = s => `${s.toFixed(1)} s`;
// The LOG: its last line sits in the status bar; tap it for the whole log as an overlay
const logline = $("logline"), logbox = $("logbox");
function log(line) {
  ui.log.textContent += line + "\n";
  if (ui.log.textContent.length > 60000) ui.log.textContent = ui.log.textContent.slice(-40000);
  ui.log.scrollTop = ui.log.scrollHeight;
  logline.textContent = `LOG ▸ ${line}`;
}
logline.addEventListener("click", () => { logbox.hidden = !logbox.hidden; ui.log.scrollTop = ui.log.scrollHeight; });
$("logclose").addEventListener("click", () => { logbox.hidden = true; });
function setProgress(frac, text) {
  if (frac != null) ui.bar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
  if (text) ui.status.textContent = text;
}
const extOf = name => (name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? ".mp4").toLowerCase();
const isGif = f => f.type === "image/gif" || /\.gif$/i.test(f.name);
const card = which => (which === "A" ? ui.cardA : ui.cardB);

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

// One still frame from a clip, as a canvas
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
function copyCanvas(src) {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
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

// LIVE PADS: the finished mosh lands here and plays on loop. Every pad hit is a shockwave + a
// logo burst; their MOSH keeps the logo melting.
const pads = new PadMode({ play: $("p-play"), pads: $("p-pads") }, {
  loadFFmpeg: async () => { await loadFFmpeg(); return ffmpeg; },   // ffmpeg.wasm runs one job at a time anyway
  log,
  onHit: () => { logo.burst(...swipe); field.shock(innerWidth / 2, innerHeight / 2, 0.7); },
  onMosh: on => logo.hold(on),
  onFrame: showBehind,
});

// Once a mosh is on the pads, it IS the page background: every frame of the pad screen (pads,
// MOSH, COLOR and GLITCH included) is copied to a full-screen canvas behind the page, and the
// drag-to-smear field retires.
const bgm = $("bgmosh");
let bgCtx = null;
function showBehind(screen) {
  // the pad screen (a canvas drawn 3x) or a video playing a long chain
  const isVideo = screen.tagName === "VIDEO";
  const sw = isVideo ? screen.videoWidth / 2 : screen.width / 3, sh = isVideo ? screen.videoHeight / 2 : screen.height / 3;
  if (!sw || !sh) return;
  if (!bgCtx) {
    bgCtx = bgm.getContext("2d", { alpha: false });
    bgm.hidden = false;
    field.retire();
  }
  const w = Math.round(sw), h = Math.round(sh);
  if (bgm.width !== w || bgm.height !== h) { bgm.width = w; bgm.height = h; }
  bgCtx.drawImage(screen, 0, 0, w, h);
}

// ---------- picking clips ----------
// A clip lands in a slot: from the gallery (a video, or a GIF that gets converted) or from
// GifCities. `thumb` is a GIF URL, so the slot shows it animating; videos show a still.
async function setClip(which, file, thumb = null, label = null) {
  const info = await probe(file);
  clips[which] = { file, label, ...info };
  const name = which === "A" ? ui.nameA : ui.nameB;
  card(which).classList.add("ok");
  name.textContent = `${label || file.name}${info.duration ? ` · ${fmtSec(info.duration)}` : ""}`;
  if (which === "A" && info.duration) {
    ui.keepA.max = Math.max(0.3, info.duration).toFixed(1);
    if (+ui.keepA.value > info.duration) ui.keepA.value = info.duration.toFixed(1);
    updateLabels();
  }
  refresh();
  const box = which === "A" ? ui.thumbA : ui.thumbB;
  let frame = null;
  if (thumb) {
    const img = new Image();
    img.alt = "";
    img.src = thumb;
    box.replaceChildren(img);
  } else {
    frame = await grabFrame(file);
    box.replaceChildren(...(frame ? [frame] : []));
  }
  // The background becomes Clip A's picture
  if (which === "A") {
    if (!frame) frame = await grabFrame(file);
    if (frame) field.setImage(copyCanvas(frame));
  }
}

// Run a GIF job (GifCities or a GIF from the gallery) with the slot showing it's busy
async function gifJob(which, job) {
  if (busy || prepping) return false;
  prepping = true; refresh();
  card(which).classList.add("prep");
  try {
    await loadFFmpeg();
    setProgress(0.3, `GIF → MP4 (${which})`);
    await job();
    return true;
  } catch (e) {
    log(`ERROR: ${e.message || e}`);
    setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 60)}`);
    return false;
  } finally {
    card(which).classList.remove("prep");
    prepping = false; refresh();
  }
}

// GifCities: fetch the GIF from the archive, 4x / 2 s / MP4 in ffmpeg.wasm, into the slot
const useGif = (which, g) => !g ? Promise.resolve(false) : gifJob(which, async () => {
  log(`gifcities ${which}: ${g.id} [${g.v || ""}: ${g.t.join(", ")}] ${g.w}x${g.h}${g.f ? `, ${g.f} frames` : ""}`);
  const file = await prepareGif(ffmpeg, g);
  await setClip(which, file, gifURL(g), `${g.v ? g.v + " · " : ""}${g.t[0]}`);
});

// A GIF from the gallery gets the same treatment
const useGifFile = (which, f) => gifJob(which, async () => {
  await ffmpeg.writeFile("in.gif", await fetchFile(f));
  const ret = await ffmpeg.exec(gifArgs("in.gif", "in.mp4"));
  try { await ffmpeg.deleteFile("in.gif"); } catch {}
  if (ret !== 0) throw new Error("couldn't convert the GIF (see LOG)");
  const data = await ffmpeg.readFile("in.mp4");
  try { await ffmpeg.deleteFile("in.mp4"); } catch {}
  await setClip(which, new File([data], f.name.replace(/\.gif$/i, ".mp4"), { type: "video/mp4" }), URL.createObjectURL(f), f.name);
});

const sheet = new GifSheet((slot, g) => useGif(slot, g));

async function dice(which) {
  try { await loadIndex(); } catch (e) { log(`ERROR: ${e.message || e}`); return; }
  await useGif(which, randomGif(null, randomVibe()));
}

// RANDOM BOTH: two different GIFs from the same vibe, (if ticked) random mosh settings, and
// (if ticked) straight into the mosh
async function randomBoth() {
  if (busy || prepping) return;
  try { await loadIndex(); } catch (e) { log(`ERROR: ${e.message || e}`); return; }
  // Half the time both from one vibe, half the time two vibes collide (footage x weird web)
  const vA = randomVibe(), vB = Math.random() < 0.5 ? vA : randomVibe();
  const a = randomGif(null, vA), b = randomGif(a, vB);
  log(`random both: ${vA || "any"} x ${vB || "any"}`);
  if (!(await useGif("A", a))) return;
  if (!(await useGif("B", b))) return;
  if (ui.randSettings.checked) {
    const max = +ui.keepA.max;
    ui.keepA.value = (0.3 + Math.random() * (max - 0.3) * 0.8).toFixed(1);
    updateLabels();
  }
  if (ui.autoMosh.checked) doMosh();
}

function refresh() {
  const long = Object.entries(clips).filter(([, c]) => c?.duration > MAX_SECONDS);
  const unknown = Object.entries(clips).filter(([, c]) => c && c.duration == null);
  const msgs = [];
  if (long.length) msgs.push(`Clip ${long.map(([k]) => k).join(" and ")} is longer than ${MAX_SECONDS} s. Phones can run out of memory on long clips: trim it first for best results.`);
  if (unknown.length) msgs.push(`Couldn't read the length of clip ${unknown.map(([k]) => k).join(" and ")} in the browser; it may still work.`);
  ui.warn.hidden = !msgs.length;
  ui.warn.textContent = msgs.join(" ");
  ui.mosh.disabled = busy || prepping || !clips.A || !clips.B;
  ui.randBoth.disabled = busy || prepping;
  if (!busy && !prepping) setProgress(0, clips.A && clips.B ? "READY" : "PICK TWO CLIPS");
}

function updateLabels() {
  ui.keepAOut.textContent = fmtSec(+ui.keepA.value);
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
// The whole pipeline on two files: encode → delete the keyframe at the cut → sound → MP4.
// Used by MOSH and by DAISY (new links, GROW, MASTER). Returns { blob, w, h, duration, keepA }.
//   keepA: seconds of A · width: 480 (DAISY links 360) · vf: a picture filter (KEEP COLOR)
async function moshFiles(fileA, fileB, { keepA, width = 480, vf = null, from = 0, to = 1 } = {}) {
  const span = f => from + (to - from) * f;
  const [infoA, infoB] = await Promise.all([probe(fileA), probe(fileB)]);
  const inA = `a${extOf(fileA.name || "a.mp4")}`, inB = `b${extOf(fileB.name || "b.mp4")}`;
  try {
    await loadFFmpeg();
    setProgress(span(0.02), "READING CLIPS");
    await ffmpeg.writeFile(inA, await fetchFile(fileA));
    await ffmpeg.writeFile(inB, await fetchFile(fileB));

    // 1-2. scale, concat, MPEG-4 AVI with one keyframe at the cut
    const size = targetSize(infoA.width, infoA.height, width);
    const kA = Math.max(1 / 30, Math.min(keepA, infoA.duration || keepA));
    await run(encodeArgs({ inA, inB, keepA: kA, w: size.w, h: size.h }), span(0.04), span(0.5), "ENCODING");
    await rm(inA); await rm(inB);

    // 3-4. remove the I-frames in JavaScript
    setProgress(span(0.5), "MOSHING");
    const joined = await ffmpeg.readFile("joined.avi");
    await rm("joined.avi");
    const { data, stats } = moshAvi(joined);
    const { order, ...summary } = stats;
    log(`mosh: ${JSON.stringify(summary)}`);
    if (!stats.removedI) log("note: no keyframe found at the cut; the result may barely mosh");
    await ffmpeg.writeFile("moshed.avi", data);

    // The sound, frame by frame in the same order as the moshed picture
    let wav = null;
    try {
      setProgress(span(0.51), "SOUND");
      await ffmpeg.writeFile("mosh.wav", await buildMoshAudio(audio(), fileA, fileB, framesOf(kA), order));
      wav = "mosh.wav";
    } catch (e) {
      log(`no sound: ${e.message || e}`);
    }

    // 5. back to a normal H.264 MP4 (+ AAC sound)
    await run(decodeArgs("moshed.avi", "mosh.mp4", wav, { vf }), span(0.52), span(0.99), "RENDERING");
    await rm("moshed.avi"); await rm("mosh.wav");
    const mp4 = await ffmpeg.readFile("mosh.mp4");
    await rm("mosh.mp4");
    return { blob: new Blob([mp4.buffer], { type: "video/mp4" }), w: size.w, h: size.h, duration: stats.kept / FPS, keepA: kA, infoA, infoB };
  } catch (e) {
    if (ffmpeg) for (const f of [inA, inB, "joined.avi", "moshed.avi", "mosh.wav", "mosh.mp4"]) await rm(f);
    throw e;
  }
}

// Make something the current result: SAVE saves it, the screen plays it (the pads take up to
// 8 s; longer things, like a rendered chain, play as a plain video)
async function showResult(blob, { w, h, duration, name = `mosh-${Date.now()}.mp4`, label = "" }) {
  if (result) URL.revokeObjectURL(result.url);
  result = { blob, url: URL.createObjectURL(blob), name, w, h };
  ui.out.src = result.url; ui.save.hidden = false;
  if (duration > PAD_MAX + 0.05) { ui.out.hidden = true; pads.previewVideo(blob, label); return true; }
  const ok = await pads.loadMoshed(new File([blob], name, { type: "video/mp4" }), w, h);
  ui.out.hidden = ok;
  if (!ok) ui.out.play().catch(() => {});
  return ok;
}

// One lock for everything that uses the engine for a while (MOSH, DAISY)
async function lock(fn) {
  if (busy || prepping) throw new Error("wait: something is still rendering");
  busy = true; document.body.classList.add("busy"); refresh();
  try { return await fn(); }
  finally { busy = false; document.body.classList.remove("busy"); refresh(); }
}

async function doMosh() {
  if (busy || prepping || !clips.A || !clips.B) return;
  ui.save.hidden = true;
  let out = null;
  try {
    out = await lock(() => moshFiles(clips.A.file, clips.B.file, { keepA: +ui.keepA.value }));
    setProgress(1, "DONE");
  } catch (e) {
    console.error(e);
    log(`ERROR: ${e.message || e}`);
    setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 60)}`);
    return;
  }
  // Into the bank (with its sources, so DAISY can re-render it), then onto the screen
  try {
    const thumb = await makeThumb(out.blob);
    await bank.add({ kind: "mosh", label: `${clips.A.label || clips.A.file.name} × ${clips.B.label || clips.B.file.name}`.slice(0, 80),
      blob: out.blob, thumb, w: out.w, h: out.h, duration: out.duration,
      settings: { keepA: out.keepA }, sources: { A: clips.A.file, B: clips.B.file } });
    daisy.refreshBank();
  } catch (e) { log(`bank: ${e.message || e}`); }
  await showResult(out.blob, { ...out, label: "mosh" });
}

// SAVE: if anything is set on the pads (COLOR, GLITCH, PITCH, REV), the saved video is the mosh
// played once through all of it, recorded live; otherwise the clean render. Recordings that
// come out as WebM are turned into MP4 with ffmpeg.wasm, so they share and play everywhere.
let saving = false;
async function save() {
  if (!result || saving) return;
  saving = true;
  ui.save.disabled = true;
  try {
    let blob = result.blob, name = result.name;
    if (pads.hasChanges()) {
      const take = await pads.exportFx(f => setProgress(f * 0.9, `SAVING WITH FX ${Math.round(f * 100)}%`));
      ({ blob, name } = take);
      log(`save: recorded ${name}, ${(blob.size / 1048576).toFixed(1)} MB`);
      if (!blob.type.includes("mp4")) {
        try {
          await loadFFmpeg();
          setProgress(0.92, "SAVING: MP4");
          await ffmpeg.writeFile("take.webm", new Uint8Array(await blob.arrayBuffer()));
          const ret = await ffmpeg.exec(["-i", "take.webm", "-vf", "fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "take.mp4"]);
          await rm("take.webm");
          if (ret !== 0) throw new Error("conversion failed");
          blob = new Blob([(await ffmpeg.readFile("take.mp4")).buffer], { type: "video/mp4" });
          await rm("take.mp4");
          name = name.replace(/\.webm$/, ".mp4");
        } catch (e) {
          log(`save: kept WebM (${e.message || e})`);
        }
      }
      setProgress(1, "SAVED WITH FX");
    }
    await share(blob, name);
  } catch (e) {
    log(`ERROR: ${e.message || e}`);
    setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 60)}`);
  } finally {
    saving = false;
    ui.save.disabled = false;
  }
}

async function share(blob, name) {
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  // (after a long FX save the tap has "expired", so sharing can be refused: then it downloads)
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "MOSH" }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- wire up ----------
for (const [which, input] of [["A", ui.fileA], ["B", ui.fileB]]) {
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    if (isGif(f)) useGifFile(which, f);
    else setClip(which, f);
  });
}
// Each slot: [GALLERY] [GIFCITIES] [🎲]; tapping the card itself opens the gallery too
for (const b of document.querySelectorAll(".slot-btns button")) {
  b.addEventListener("click", () => {
    const which = b.dataset.slot;
    if (b.dataset.act === "gallery") (which === "A" ? ui.fileA : ui.fileB).click();
    else if (b.dataset.act === "gif") sheet.open(which);
    else dice(which);
  });
}
for (const [c, input] of [[ui.cardA, ui.fileA], [ui.cardB, ui.fileB]]) {
  c.addEventListener("click", () => { if (!prepping) input.click(); });
  c.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
}
ui.randBoth.addEventListener("click", randomBoth);
ui.keepA.addEventListener("input", updateLabels);
ui.mosh.addEventListener("click", doMosh);
ui.save.addEventListener("click", save);
updateLabels();
refresh();
log(`MOSH build ${BUILD}`);

// The device: 1600x900, scaled to fit; logs the real size of the smallest text (25 design px)
const layout = new Layout({
  device: $("device"), rotate: $("rotate"), toggle: $("portraitMode"), anyway: $("rotateAnyway"),
  onFit: (s, turned) => log(`layout: ${innerWidth}x${innerHeight}${turned ? " turned" : ""}, scale ${s.toFixed(3)}, smallest text ${(25 * s).toFixed(1)}px`),
});

// ---------- DAISY CHAIN ----------
// A random GifCities clip, ready to mosh: { file, label }
async function randomGifFile() {
  await loadIndex();
  const g = randomGif(null, randomVibe());
  if (!g) throw new Error("the GifCities index is empty");
  await loadFFmpeg();
  log(`gifcities: ${g.id} [${g.v}: ${g.t[0]}]`);
  return { file: await prepareGif(ffmpeg, g), label: `${g.v} · ${g.t[0]}` };
}

// The last picture of a clip, as a 1 s still clip (GROW grows each link out of the last one's tail)
async function tailStill(blob) {
  await loadFFmpeg();
  await ffmpeg.writeFile("tail.mp4", new Uint8Array(await blob.arrayBuffer()));
  let ret = await ffmpeg.exec(["-sseof", "-0.25", "-i", "tail.mp4", "-frames:v", "1", "-update", "1", "-y", "tail.png"]);
  await rm("tail.mp4");
  if (ret !== 0) throw new Error("couldn't grab the tail frame");
  ret = await ffmpeg.exec(["-loop", "1", "-i", "tail.png", "-t", "1", "-r", String(FPS),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-y", "tailA.mp4"]);
  await rm("tail.png");
  if (ret !== 0) throw new Error("couldn't make the tail clip");
  const data = await ffmpeg.readFile("tailA.mp4");
  await rm("tailA.mp4");
  return new File([data], `tail-${Date.now()}.mp4`, { type: "video/mp4" });
}

const daisy = new Daisy($("daisy"), {
  bank, makeThumb, layout, log, setProgress, lock, moshFiles, randomGifFile, tailStill, showResult,
  ffmpeg: async () => { await loadFFmpeg(); return ffmpeg; }, run, rm, audio,
  toSlot: (which, item) => setClip(which, new File([item.blob], `${item.id}.mp4`, { type: "video/mp4" }), null, item.label),
  toPad: (item, url) => pads.arm(new File([item.blob], `${item.id}.mp4`, { type: "video/mp4" }), item.label, url),
});
$("daisyBtn").addEventListener("click", () => daisy.toggle());
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
