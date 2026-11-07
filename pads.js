// PAD MODE: the finished mosh plays here, on loop, with its sound. 4x4 pads, each a slice of the
// clip (picture + sound, together), played live through the live mosh engine. Triggered on
// finger-down, so it feels instant. While a pad plays, the main playback keeps running silently
// underneath and comes back when you let go.
//   ▶/■ play / stop the loop · scrub bar: tap or drag to jump · REC: record what you play
//   (picture + sound) to a video · FULL: full screen
//   REPEAT 1/4..1/32 (+ triplets) locked to BPM  ·  GATE: how much of each repeat plays
//   PITCH: speeds video + audio together  ·  HOLD: keep playing after release  ·  REV: backwards
//   ROLL: repeat speeds up 1/4 -> 1/32 while held  ·  TAPE STOP: everything slows to a halt
//   MOSH (hold): stop showing new frames, push the held picture along the motion (live I-frame removal)
import { audio } from "./sfx.js";
import { LiveEngine, COLORS, GLITCHES } from "./live.js";
import { decodeClip, padSize, PAD_FPS } from "./clipdecode.js";

const REPEATS = [["OFF", 0], ["1/4", 1], ["1/8", 1 / 2], ["1/16", 1 / 4], ["1/32", 1 / 8],
  ["1/4T", 2 / 3], ["1/8T", 1 / 3], ["1/16T", 1 / 6], ["1/32T", 1 / 12]];   // length in beats
const TAPE_TIME = 0.9;        // seconds for TAPE STOP to reach a halt
const ROLL_TIME = 2.0;        // seconds for ROLL to go from 1/4 to 1/32

export class PadMode {
  // roots: { play: the center panel (screen, transport, COLOR, GLITCH), pads: the right panel
  // (pads, function row, REPEAT, faders) }. Both are built right away, so the device is complete
  // before the first mosh.
  constructor(roots, opts) {
    this.root = roots.play;
    this.padRoot = roots.pads;
    this.o = opts;            // { loadFFmpeg, log, onHit, onMosh, onFrame }
    this.clips = {};
    this.sel = "M";           // the finished mosh
    this.voice = null;
    this.pitch = 1; this.gate = 0.6; this.bpm = 120; this.repeatIdx = 0;
    this.holdOn = false; this.revOn = false;
    this.moshHeld = false; this.rollHeld = false;
    this.lastSlice = 0;
    this.raf = 0;
    this.fx = { color: 0, amount: 0.5 };   // COLOR mode + GLITCH flags (live.js), into REC too
    // main playback (the transport)
    this.playing = false; this.tpos = 0; this.tnode = null; this.ttape = null; this.lastT = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.wasPlaying = this.playing; this.pause(); this.stopLoop(); }
      else if (this.loaded) { this.startLoop(); if (this.wasPlaying) this.play(); }
    });
    try { this.build(); }
    catch (e) {
      this.buildError = e;
      this.root.innerHTML = `<h2 class="ph"><span>03</span> PLAY</h2><p class="screen-msg">The live screen needs WebGL2: ${e.message || e}</p>`;
    }
  }

  status(text) { if (this.msg) this.msg.textContent = text; }

  // Load the finished mosh (an MP4 file) onto the pads. Returns true if it worked.
  async loadMoshed(file, w, h) {
    if (this.loading) return false;
    this.loading = true;
    try {
      if (!this.ac) {
        this.ac = audio();
        if (!this.ac) throw new Error("Web Audio isn't available");
        this.out = this.ac.createGain();
        this.out.gain.value = 0.9;
        this.out.connect(this.ac.destination);
      }
      if (this.voice) this.stopVoice();
      this.pause();
      this.status("Loading the mosh onto the pads…");
      const ff = await this.o.loadFFmpeg();
      const clip = await decodeClip(ff, file, padSize(w, h), this.ac, p => this.status(`Loading onto the pads… ${Math.round(p * 100)}%`));
      if (!this.engine) throw this.buildError || new Error("no live screen");
      this.engine.setClips({ M: clip });
      this.root.querySelector(".screen-msg").hidden = true;
      clip.frames = null;                                       // it lives on the GPU now
      this.clips = { M: clip };
      this.sel = "M";
      this.shownSrc = "M"; this.shownIdx = 0; this.tpos = 0;
      this.syncUI();
      this.loaded = true;
      this.status(`${clip.n} frames · ${(clip.duration).toFixed(1)} s${clip.silent ? " · no sound" : ""}`);
      this.startLoop();
      this.play();
      this.o.log?.(`pads: mosh loaded, ${clip.n} frames ${clip.w}x${clip.h}${clip.silent ? " (no audio)" : ""}`);
      return true;
    } catch (e) {
      console.error(e);
      this.status(`Couldn't load the pads: ${e.message || e}`);
      this.o.log?.(`pads error: ${e.message || e}`);
      return false;
    } finally {
      this.loading = false;
    }
  }

  // ---------- the pad UI ----------
  build() {
    const r = this.root, pr = this.padRoot;
    r.innerHTML = `
      <h2 class="ph"><span>03</span> PLAY<span class="pads-msg"></span></h2>
      <div class="screen-wrap">
        <canvas class="live-screen"></canvas>
        <p class="screen-msg">Hit MOSH: the finished mosh plays here on loop, with its sound.<br>Then play it on the pads.</p>
        <span class="rec-dot" hidden>● REC</span>
      </div>
      <div class="scrub"><div class="scrub-fill"></div><div class="scrub-head"></div></div>
      <div class="transport">
        <button class="t-play">▶ PLAY</button>
        <button class="t-rec">● REC</button>
        <button class="t-full">FULL</button>
      </div>
      <a class="rec-save" hidden></a>
      <div class="fx-head"><span class="sub-h">COLOR</span></div>
      <div class="seg colors"></div>
      <div class="fx-head"><span class="sub-h">GLITCH</span><button class="fx-rand">🎲 FX</button><button class="fx-clear">CLEAR</button></div>
      <div class="glitch-row"></div>
      <div class="faders">
        <label><span>AMOUNT</span><output class="o-amt"></output><input type="range" class="f-amt" min="0" max="100" value="50"></label>
      </div>`;
    pr.innerHTML = `
      <h2 class="ph"><span>04</span> PADS</h2>
      <div class="pad-grid"></div>
      <div class="fn-row"></div>
      <div class="sub-h">REPEAT</div>
      <div class="seg rep"></div>
      <div class="faders">
        <label><span>GATE</span><output class="o-gate"></output><input type="range" class="f-gate" min="10" max="100" value="60"></label>
        <label><span>PITCH</span><output class="o-pitch"></output><input type="range" class="f-pitch" min="-100" max="100" value="0"></label>
        <label><span>BPM</span><output class="o-bpm"></output><input type="range" class="f-bpm" min="60" max="180" value="120"></label>
      </div>`;
    this.msg = r.querySelector(".pads-msg");
    const screen = (this.screen = r.querySelector(".live-screen"));
    this.engine = new LiveEngine(screen);

    // Transport
    this.playBtn = r.querySelector(".t-play");
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.recBtn = r.querySelector(".t-rec");
    this.recBtn.addEventListener("click", () => (this.rec ? this.recStop() : this.recStart()));
    // FULL: the whole app full screen, locked sideways (the lock only works in full screen)
    r.querySelector(".t-full").addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) { await document.exitFullscreen(); return; }
        const el = document.documentElement;
        await (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: "hide" });
        try { await globalThis.screen.orientation?.lock?.("landscape"); } catch (e) { this.o.log?.(`orientation lock: ${e.message || e}`); }
      } catch (e) {
        this.o.log?.(`fullscreen: ${e.message || e}`);
      }
    });
    this.scrubFill = r.querySelector(".scrub-fill");
    this.scrubHead = r.querySelector(".scrub-head");
    const scrub = r.querySelector(".scrub");
    // offsetX is in the bar's own (unscaled, unrotated) coordinates, so this works however the
    // device is scaled or turned
    const seek = e => {
      const c = this.clips[this.sel];
      if (!c) return;
      this.seek(Math.max(0, Math.min(0.9999, e.offsetX / scrub.offsetWidth)) * c.duration);
    };
    scrub.addEventListener("pointerdown", e => { e.preventDefault(); scrub.setPointerCapture(e.pointerId); seek(e); });
    scrub.addEventListener("pointermove", e => { if (scrub.hasPointerCapture(e.pointerId)) seek(e); });

    // 16 pads
    const grid = pr.querySelector(".pad-grid");
    this.pads = [];
    for (let i = 0; i < 16; i++) {
      const p = document.createElement("button");
      p.className = "pad";
      p.innerHTML = `<i></i><span>${i + 1}</span>`;
      p.addEventListener("pointerdown", e => { e.preventDefault(); this.trigger(i); });
      for (const t of ["pointerup", "pointercancel", "pointerleave"]) p.addEventListener(t, () => this.release(i));
      p.addEventListener("contextmenu", e => e.preventDefault());
      grid.append(p);
      this.pads.push(p);
    }

    // Function row: hold buttons + toggles
    const fn = pr.querySelector(".fn-row");
    const holdBtn = (label, on, off) => {
      const b = document.createElement("button");
      b.className = "fn"; b.textContent = label;
      b.addEventListener("pointerdown", e => { e.preventDefault(); b.classList.add("on"); on(); });
      for (const t of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(t, () => { if (b.classList.contains("on")) { b.classList.remove("on"); off(); } });
      b.addEventListener("contextmenu", e => e.preventDefault());
      fn.append(b);
    };
    const toggle = (label, fnc) => {
      const b = document.createElement("button");
      b.className = "fn"; b.textContent = label;
      b.addEventListener("click", () => { b.classList.toggle("on", fnc()); });
      fn.append(b);
    };
    holdBtn("MOSH", () => { this.moshHeld = true; this.o.onMosh?.(true); this.o.onHit?.(); }, () => { this.moshHeld = false; this.o.onMosh?.(false); });
    holdBtn("ROLL", () => this.rollOn(), () => this.rollOff());
    toggle("HOLD", () => { this.holdOn = !this.holdOn; if (!this.holdOn && this.voice && !this.voice.held) this.stopVoice(); else if (this.voice) this.voice.latched = this.holdOn; return this.holdOn; });
    toggle("REV", () => { this.revOn = !this.revOn; if (this.playing) this.restartT(); return this.revOn; });
    holdBtn("TAPE STOP", () => this.tapeStop(), () => {});

    // Repeat
    const rep = pr.querySelector(".rep");
    this.repBtns = REPEATS.map(([label], i) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { this.repeatIdx = i; this.syncUI(); });
      rep.append(b);
      return b;
    });

    // Faders
    const f = sel => r.querySelector(sel) || pr.querySelector(sel);
    const gate = f(".f-gate"), pitch = f(".f-pitch"), bpm = f(".f-bpm");
    const upd = () => {
      this.gate = +gate.value / 100;
      this.setPitch(Math.pow(2, +pitch.value / 100));
      this.bpm = +bpm.value;
      f(".o-gate").textContent = `${gate.value}%`;
      f(".o-pitch").textContent = `${this.pitch.toFixed(2)}×`;
      f(".o-bpm").textContent = String(this.bpm);
    };
    for (const el of [gate, pitch, bpm]) el.addEventListener("input", upd);
    pitch.addEventListener("dblclick", () => { pitch.value = 0; upd(); });   // double-tap: back to 1×
    upd();

    // FX: one COLOR mode, any number of GLITCH layers, one AMOUNT
    const colors = r.querySelector(".colors");
    this.colorBtns = COLORS.map((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { this.fx.color = i; this.syncFx(); });
      colors.append(b);
      return b;
    });
    const glitch = r.querySelector(".glitch-row");
    this.glitchBtns = GLITCHES.map(label => {
      const key = label.toLowerCase(), b = document.createElement("button");
      b.className = "fn"; b.textContent = label;
      b.addEventListener("click", () => { this.fx[key] = !this.fx[key]; this.syncFx(); this.o.onHit?.(); });
      glitch.append(b);
      return [key, b];
    });
    const amt = f(".f-amt");
    const updAmt = () => { this.fx.amount = +amt.value / 100; f(".o-amt").textContent = `${amt.value}%`; };
    amt.addEventListener("input", updAmt);
    updAmt();
    r.querySelector(".fx-rand").addEventListener("click", () => {
      this.fx.color = Math.random() < 0.3 ? 0 : 1 + ((Math.random() * (COLORS.length - 1)) | 0);
      for (const [key] of this.glitchBtns) this.fx[key] = Math.random() < (key === "strobe" || key === "mirror" ? 0.15 : 0.35);
      amt.value = 25 + ((Math.random() * 70) | 0);
      updAmt();
      this.syncFx();
      this.o.onHit?.();
    });
    r.querySelector(".fx-clear").addEventListener("click", () => {
      this.fx.color = 0;
      for (const [key] of this.glitchBtns) this.fx[key] = false;
      this.syncFx();
    });
    this.syncFx();
  }

  syncFx() {
    (this.colorBtns || []).forEach((b, i) => b.classList.toggle("on", i === this.fx.color));
    for (const [key, b] of this.glitchBtns || []) b.classList.toggle("on", !!this.fx[key]);
  }

  syncUI() {
    (this.repBtns || []).forEach((b, i) => b.classList.toggle("on", i === this.repeatIdx));
    if (this.playBtn) {
      this.playBtn.textContent = this.playing ? "■ STOP" : "▶ PLAY";
      this.playBtn.classList.toggle("on", this.playing);
    }
    this.light();
  }
  light() {
    const v = this.voice;
    (this.pads || []).forEach((p, i) => p.classList.toggle("on", !!v && v.src === this.sel && v.slice === i));
  }

  // ---------- main playback: the whole mosh on loop ----------
  play() {
    if (!this.loaded) return;
    if (this.ac.state === "suspended") this.ac.resume();
    this.killT();
    this.playing = true;
    this.ttape = null;
    this.startT();
    this.syncUI();
  }
  pause() {
    this.playing = false;
    this.ttape = null;
    this.killT();
    this.syncUI();
  }
  seek(pos) {
    this.tpos = pos;
    if (this.playing) this.restartT();
    else if (!this.voice) this.shownIdx = Math.floor(pos * PAD_FPS);
  }
  restartT() { this.killT(); this.startT(); }

  // A looping source from the current position (backwards when REV is on)
  startT() {
    const c = this.clips[this.sel], ac = this.ac;
    if (!c) return;
    const t = ac.currentTime + 0.01;
    const buf = this.revOn ? c.rev : c.audio;
    const loopEnd = Math.min(buf.duration, c.duration);
    const n = ac.createBufferSource();
    n.buffer = buf;
    n.loop = true; n.loopStart = 0; n.loopEnd = loopEnd;
    n.playbackRate.value = this.pitch;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(this.voice ? 0 : 1, t + 0.01);
    n.connect(g).connect(this.out);
    const off = this.revOn ? c.duration - this.tpos : this.tpos;
    n.start(t, Math.max(0, Math.min(loopEnd - 0.001, off)));
    this.tnode = { n, g, ducked: !!this.voice };
    this.lastT = ac.currentTime;
  }
  killT() {
    const x = this.tnode;
    this.tnode = null;
    if (!x) return;
    const t = this.ac.currentTime;
    try {
      x.g.gain.cancelScheduledValues(t);
      x.g.gain.setValueAtTime(x.g.gain.value, t);
      x.g.gain.linearRampToValueAtTime(0, t + 0.01);
      x.n.stop(t + 0.02);
    } catch {}
  }
  // The pads take over the sound while they play; the loop comes back when they stop
  duck(on) {
    const x = this.tnode;
    if (!x || x.ducked === on) return;
    x.ducked = on;
    const t = this.ac.currentTime;
    x.g.gain.cancelScheduledValues(t);
    x.g.gain.setTargetAtTime(on ? 0 : 1, t, 0.008);
  }
  // Advance the playhead on the audio clock, at the same speed as the sound
  advanceT(t) {
    const c = this.clips[this.sel];
    const from = this.lastT;
    this.lastT = t;
    if (!this.playing || !c || t <= from) return;
    let rate = this.pitch;
    if (this.ttape) {
      rate = this.pitch * Math.max(0, 1 - (t - this.ttape.t0) / TAPE_TIME);
      if (t > this.ttape.t0 + TAPE_TIME) { this.pause(); return; }
    }
    const d = (t - from) * rate * (this.revOn ? -1 : 1);
    this.tpos = (((this.tpos + d) % c.duration) + c.duration) % c.duration;
  }

  // ---------- REC: record the screen + the sound to a video ----------
  // onBlob(blob, name): where the finished recording goes (default: the SAVE TAKE button)
  recStart(onBlob = null) {
    if (!this.loaded || this.rec) return false;
    if (!this.screen.captureStream || typeof MediaRecorder === "undefined") { this.status("Recording isn't supported in this browser"); return false; }
    const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const type = types.find(t => MediaRecorder.isTypeSupported?.(t)) || "";
    const stream = this.screen.captureStream(30);
    const dest = this.ac.createMediaStreamDestination();
    this.out.connect(dest);
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
    const chunks = [];
    let mr;
    try { mr = new MediaRecorder(stream, { ...(type && { mimeType: type }), videoBitsPerSecond: 8_000_000 }); }
    catch (e) { try { this.out.disconnect(dest); } catch {} this.status(`Can't record: ${e.message || e}`); return false; }
    mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      try { this.out.disconnect(dest); } catch {}
      for (const tr of stream.getTracks()) tr.stop();
      const mime = (mr.mimeType || type || "video/webm").split(";")[0];
      const blob = new Blob(chunks, { type: mime });
      const name = `mosh-live-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
      (onBlob || ((b, n) => this.saveTake(b, n)))(blob, name);
    };
    mr.start(250);
    this.rec = mr;
    this.recBtn.classList.add("rec-on");
    this.recBtn.textContent = "■ STOP REC";
    this.root.querySelector(".rec-dot").hidden = false;
    if (!this.playing && !this.voice) this.play();
    return true;
  }

  // Anything set that changes how the mosh looks or sounds (so SAVE has to record it)?
  hasChanges() {
    const glitch = GLITCHES.some(g => this.fx[g.toLowerCase()]);
    return this.loaded && (this.fx.color !== 0 || glitch || Math.abs(this.pitch - 1) > 0.001 || this.revOn);
  }

  // SAVE with everything that's set: play the whole mosh once from the start, through the
  // COLOR / GLITCH / PITCH / REV settings, and record it (picture + sound) in real time.
  // Resolves to { blob, name }.
  exportFx(onProgress) {
    return new Promise((resolve, reject) => {
      if (!this.loaded) return reject(new Error("nothing on the pads yet"));
      if (this.rec) return reject(new Error("stop REC first"));
      const c = this.clips[this.sel];
      if (this.voice) this.stopVoice();
      this.ttape = null;
      this.tpos = this.revOn ? c.duration - 0.001 : 0;
      this.play();
      const ok = this.recStart((blob, name) => resolve({ blob, name: name.replace("mosh-live", "mosh-fx") }));
      if (!ok) return reject(new Error("recording isn't supported in this browser"));
      const len = c.duration / this.pitch + 0.15, t0 = performance.now();
      const tick = () => {
        const f = (performance.now() - t0) / 1000 / len;
        onProgress?.(Math.min(1, f));
        if (f >= 1) this.recStop();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  recStop() {
    if (!this.rec) return;
    this.rec.stop();
    this.rec = null;
    this.recBtn.classList.remove("rec-on");
    this.recBtn.textContent = "● REC";
    this.root.querySelector(".rec-dot").hidden = true;
  }
  saveTake(blob, name) {
    const a = this.root.querySelector(".rec-save");
    if (a.href) URL.revokeObjectURL(a.href);
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.textContent = `SAVE TAKE (${(blob.size / 1048576).toFixed(1)} MB)`;
    a.hidden = false;
    a.onclick = async e => {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        e.preventDefault();
        try { await navigator.share({ files: [file], title: "MOSH" }); } catch {}
      }
    };
    this.o.log?.(`rec: ${name}, ${(blob.size / 1048576).toFixed(1)} MB`);
  }

  // ---------- pads ----------
  repeatBeats(t) {
    if (this.rollHeld) return Math.pow(1 / 8, Math.min(1, (t - this.rollT0) / ROLL_TIME));   // 1/4 -> 1/32
    return REPEATS[this.repeatIdx][1];
  }

  trigger(i) {
    if (!this.loaded) return;
    if (this.ac.state === "suspended") this.ac.resume();
    const t = this.ac.currentTime + 0.003;
    if (this.voice) this.cut(this.voice, t);
    const c = this.clips[this.sel], len = c.duration / 16;
    const v = { src: this.sel, slice: i, start: i * len, len, rev: this.revOn, held: true, latched: this.holdOn,
      segs: [], nodes: [], elapsed: 0, lastAt: t };
    this.voice = v;
    this.duck(true);
    this.lastSlice = i;
    const beats = this.repeatBeats(t);
    this.play1(v, t, beats ? Math.min(len, ((beats * 60) / this.bpm) * this.gate) : len);
    this.light();
    this.o.onHit?.();
  }

  release(i) {
    const v = this.voice;
    if (!v || v.slice !== i || !v.held) return;
    v.held = false;
    if (!v.latched && !this.rollHeld) this.stopVoice();
    this.light();
  }

  stopVoice() {
    if (this.voice) this.cut(this.voice, this.ac.currentTime);
    this.voice = null;
    this.duck(false);
    this.light();
  }

  // Start one piece of the slice at time `at`, lasting `dur` seconds of the clip
  play1(v, at, dur) {
    const c = this.clips[v.src], ac = this.ac;
    const buf = v.rev ? c.rev : c.audio;
    const off = Math.max(0, Math.min(buf.duration - 0.001, v.rev ? c.duration - (v.start + v.len) : v.start));
    const n = ac.createBufferSource();
    n.buffer = buf;
    n.playbackRate.value = this.pitch;
    const g = ac.createGain(), real = dur / this.pitch;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + 0.003);                 // tiny fades: no clicks
    g.gain.setValueAtTime(1, at + Math.max(0.004, real - 0.006));
    g.gain.linearRampToValueAtTime(0, at + real);
    n.connect(g).connect(this.out);
    n.start(at, off, dur);
    v.nodes = v.nodes.filter(x => x.end > ac.currentTime - 0.1);
    v.nodes.push({ n, g, at, end: at + real });
    v.segs.push({ at, dur });
  }

  cut(v, at) {
    for (const { n, g } of v.nodes) {
      try {
        g.gain.cancelScheduledValues(at);
        g.gain.setValueAtTime(g.gain.value, at);
        g.gain.linearRampToValueAtTime(0, at + 0.008);
        n.stop(at + 0.01);
      } catch {}
    }
    v.nodes = [];
  }

  // Keep repeats (or the slice loop) going while the pad is held / latched
  schedule(t) {
    const v = this.voice;
    if (!v || v.tape) return;
    const beats = this.repeatBeats(t);
    if (beats) {
      const interval = (beats * 60) / this.bpm;
      let next = v.lastAt + interval;
      while (next < t + 0.05) {
        this.play1(v, next, Math.min(v.len, interval * this.gate));
        v.lastAt = next;
        next = v.lastAt + (this.repeatBeats(next) * 60) / this.bpm;
      }
    } else {
      const last = v.segs[v.segs.length - 1];
      const end = last ? last.at + last.dur / this.pitch : t;
      if (end < t + 0.05) { this.play1(v, end, v.len); v.lastAt = end; }
    }
  }

  setPitch(p) {
    this.pitch = p;
    const t = this.ac?.currentTime ?? 0;
    const v = this.voice;
    if (v && !v.tape) for (const { n } of v.nodes) n.playbackRate.setTargetAtTime(p, t, 0.02);
    if (this.tnode && !this.ttape) this.tnode.n.playbackRate.setValueAtTime(p, t);
  }

  rollOn() {
    if (!this.loaded) return;
    this.rollHeld = true;
    this.rollT0 = this.ac.currentTime;
    if (!this.voice) { this.trigger(this.lastSlice); this.voice.held = false; }
    this.voice.lastAt = this.ac.currentTime;
  }
  rollOff() {
    this.rollHeld = false;
    const v = this.voice;
    if (v && !v.held && !v.latched) this.stopVoice();
  }

  // TAPE STOP: sound and picture slow to a halt together (the pad playing, or the main loop)
  tapeStop() {
    const v = this.voice;
    if (!this.loaded) return;
    const t0 = this.ac.currentTime;
    if (!v) {
      if (!this.playing || this.ttape || !this.tnode) return;
      this.ttape = { t0 };
      const { n } = this.tnode;
      n.playbackRate.cancelScheduledValues(t0);
      n.playbackRate.setValueAtTime(this.pitch, t0);
      n.playbackRate.linearRampToValueAtTime(0.0001, t0 + TAPE_TIME);
      return;
    }
    if (v.tape) return;
    v.tape = { t0 };
    for (const { n, g, at } of v.nodes) {
      try {
        if (at > t0) { n.stop(t0); continue; }                     // repeats not started yet: drop
        n.playbackRate.cancelScheduledValues(t0);
        n.playbackRate.setValueAtTime(this.pitch, t0);
        n.playbackRate.linearRampToValueAtTime(0.0001, t0 + TAPE_TIME);
        g.gain.cancelScheduledValues(t0);
        g.gain.setValueAtTime(g.gain.value, t0);
        g.gain.setValueAtTime(g.gain.value, t0 + TAPE_TIME - 0.05);
        g.gain.linearRampToValueAtTime(0, t0 + TAPE_TIME);
        n.stop(t0 + TAPE_TIME + 0.02);
      } catch {}
    }
    v.segs = v.segs.filter(s => s.at <= t0);
  }

  rateAt(v, t) {
    if (v.tape) return this.pitch * Math.max(0, 1 - (t - v.tape.t0) / TAPE_TIME);
    return this.pitch;
  }

  // ---------- the frame loop ----------
  startLoop() {
    if (this.raf || !this.loaded) return;
    let last = performance.now();
    this.lastT = this.ac.currentTime;
    const loop = now => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stopLoop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  tick(dt) {
    const t = this.ac.currentTime;
    this.schedule(t);
    this.advanceT(t);
    const v = this.voice, c = this.clips[this.sel];
    let src = this.shownSrc, idx = this.shownIdx, pos = this.tpos;
    if (v) {
      // The picture follows the sound: same slice, same position, same speed
      while (v.segs.length > 1 && v.segs[1].at <= t) { v.segs.shift(); v.elapsed = 0; }
      const seg = v.segs[0];
      if (seg && t >= seg.at) v.elapsed += dt * this.rateAt(v, t);
      const e = Math.min(v.elapsed, seg ? seg.dur : 0);
      pos = v.rev ? v.start + v.len - e - 1e-4 : v.start + e;
      src = v.src;
      idx = Math.floor(pos * PAD_FPS);
      if (v.tape && t > v.tape.t0 + TAPE_TIME) { this.voice = null; this.duck(false); this.light(); }
    } else if (this.playing) {
      src = this.sel;
      idx = Math.floor(this.tpos * PAD_FPS);
    }
    if (c) idx = Math.max(0, Math.min(c.n - 1, idx));
    this.shownSrc = src; this.shownIdx = idx;
    if (c && this.scrubHead) {
      this.scrubHead.style.left = `${(pos / c.duration) * 100}%`;
      this.scrubFill.style.width = `${(this.tpos / c.duration) * 100}%`;
    }
    // STROBE: flips the picture on every 1/8 note at the BPM
    const flash = !!this.fx.strobe && ((t * this.bpm) / 30) % 1 < 0.22;
    this.engine.render({ src, idx, mosh: this.moshHeld, fx: { ...this.fx, flash } }, dt);
    this.o.onFrame?.(this.screen);                 // the page background mirrors the screen
  }
}
