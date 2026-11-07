// PAD MODE: 4x4 pads, each a slice of the clip (picture + sound, together), played live
// through the live mosh engine. Triggered on finger-down, so it feels instant.
//   REPEAT 1/4..1/32 (+ triplets) locked to BPM  ·  GATE: how much of each repeat plays
//   PITCH: speeds video + audio together  ·  HOLD: keep playing after release  ·  REV: backwards
//   ROLL: repeat speeds up 1/4 -> 1/32 while held  ·  TAPE STOP: everything slows to a halt
//   MOSH (hold): stop showing new frames, push the held picture along the motion (live I-frame removal)
//   BLOOM (hold): freeze the motion so it keeps re-applying
import { audio } from "./sfx.js";
import { LiveEngine } from "./live.js";
import { decodeClip, padSize, PAD_FPS } from "./clipdecode.js";

const REPEATS = [["OFF", 0], ["1/4", 1], ["1/8", 1 / 2], ["1/16", 1 / 4], ["1/32", 1 / 8],
  ["1/4T", 2 / 3], ["1/8T", 1 / 3], ["1/16T", 1 / 6], ["1/32T", 1 / 12]];   // length in beats
const TAPE_TIME = 0.9;        // seconds for TAPE STOP to reach a halt
const ROLL_TIME = 2.0;        // seconds for ROLL to go from 1/4 to 1/32

export class PadMode {
  constructor(root, opts) {
    this.root = root;
    this.o = opts;            // { loadFFmpeg, log, onHit, onMosh }
    this.clips = {};
    this.sel = "M";           // the finished mosh
    this.voice = null;
    this.pitch = 1; this.gate = 0.6; this.bpm = 120; this.repeatIdx = 0;
    this.holdOn = false; this.revOn = false;
    this.moshHeld = false; this.bloomHeld = false; this.rollHeld = false;
    this.lastSlice = 0;
    this.raf = 0;
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.loaded && this.start()));
    this.shell();
  }

  // ---------- before loading ----------
  shell() {
    this.root.innerHTML = `
      <div class="pads-head"><b>LIVE PADS</b></div>
      <p class="pads-msg">Hit MOSH above: the finished mosh lands here on the pads, with its sound.</p>`;
    this.msg = this.root.querySelector(".pads-msg");
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
      this.status("Loading the mosh onto the pads…");
      const ff = await this.o.loadFFmpeg();
      const clip = await decodeClip(ff, file, padSize(w, h), this.ac, p => this.status(`Loading onto the pads… ${Math.round(p * 100)}%`));
      if (!this.engine) this.build();
      this.engine.setClips({ M: clip });
      clip.frames = null;                                       // it lives on the GPU now
      this.clips = { M: clip };
      this.sel = "M";
      this.shownSrc = "M"; this.shownIdx = 0;
      this.syncUI();
      this.loaded = true;
      this.status(`${clip.n} frames · ${(clip.duration).toFixed(1)} s${clip.silent ? " · no sound" : ""}`);
      this.start();
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
    const r = this.root;
    r.innerHTML = `
      <div class="pads-head"><b>LIVE PADS</b><span class="pads-msg"></span></div>
      <canvas class="live-screen"></canvas>
      <div class="pad-grid"></div>
      <div class="fn-row"></div>
      <div class="seg rep"></div>
      <div class="faders">
        <label><span>GATE</span><output class="o-gate"></output><input type="range" class="f-gate" min="10" max="100" value="60"></label>
        <label><span>PITCH</span><output class="o-pitch"></output><input type="range" class="f-pitch" min="-100" max="100" value="0"></label>
        <label><span>BPM</span><output class="o-bpm"></output><input type="range" class="f-bpm" min="60" max="180" value="120"></label>
      </div>`;
    this.msg = r.querySelector(".pads-msg");
    const screen = r.querySelector(".live-screen");
    this.engine = new LiveEngine(screen);

    // 16 pads
    const grid = r.querySelector(".pad-grid");
    this.pads = [];
    for (let i = 0; i < 16; i++) {
      const p = document.createElement("button");
      p.className = "pad";
      p.textContent = String(i + 1);
      p.addEventListener("pointerdown", e => { e.preventDefault(); this.trigger(i); });
      for (const t of ["pointerup", "pointercancel", "pointerleave"]) p.addEventListener(t, () => this.release(i));
      p.addEventListener("contextmenu", e => e.preventDefault());
      grid.append(p);
      this.pads.push(p);
    }

    // Function row: hold buttons + toggles
    const fn = r.querySelector(".fn-row");
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
    holdBtn("BLOOM", () => { this.bloomHeld = true; }, () => { this.bloomHeld = false; });
    holdBtn("ROLL", () => this.rollOn(), () => this.rollOff());
    toggle("HOLD", () => { this.holdOn = !this.holdOn; if (!this.holdOn && this.voice && !this.voice.held) this.stopVoice(); else if (this.voice) this.voice.latched = this.holdOn; return this.holdOn; });
    toggle("REV", () => (this.revOn = !this.revOn));
    holdBtn("TAPE STOP", () => this.tapeStop(), () => {});

    // Repeat
    const rep = r.querySelector(".rep");
    this.repBtns = REPEATS.map(([label], i) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { this.repeatIdx = i; this.syncUI(); });
      rep.append(b);
      return b;
    });

    // Faders
    const f = sel => r.querySelector(sel);
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
  }

  syncUI() {
    (this.repBtns || []).forEach((b, i) => b.classList.toggle("on", i === this.repeatIdx));
    this.light();
  }
  light() {
    const v = this.voice;
    (this.pads || []).forEach((p, i) => p.classList.toggle("on", !!v && v.src === this.sel && v.slice === i));
  }

  // ---------- playing ----------
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
    this.lastSlice = i;
    const beats = this.repeatBeats(t);
    this.play(v, t, beats ? Math.min(len, ((beats * 60) / this.bpm) * this.gate) : len);
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
    this.light();
  }

  // Start one piece of the slice at time `at`, lasting `dur` seconds of the clip
  play(v, at, dur) {
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
        this.play(v, next, Math.min(v.len, interval * this.gate));
        v.lastAt = next;
        next = v.lastAt + (this.repeatBeats(next) * 60) / this.bpm;
      }
    } else {
      const last = v.segs[v.segs.length - 1];
      const end = last ? last.at + last.dur / this.pitch : t;
      if (end < t + 0.05) { this.play(v, end, v.len); v.lastAt = end; }
    }
  }

  setPitch(p) {
    this.pitch = p;
    const v = this.voice;
    if (v && !v.tape) for (const { n } of v.nodes) n.playbackRate.setTargetAtTime(p, this.ac.currentTime, 0.02);
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

  // TAPE STOP: sound and picture slow to a halt together
  tapeStop() {
    const v = this.voice;
    if (!v || v.tape) return;
    const t0 = this.ac.currentTime;
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
  start() {
    if (this.raf || !this.loaded) return;
    let last = performance.now();
    const loop = now => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  tick(dt) {
    const t = this.ac.currentTime;
    this.schedule(t);
    const v = this.voice;
    let src = this.shownSrc, idx = this.shownIdx;
    if (v) {
      // The picture follows the sound: same slice, same position, same speed
      while (v.segs.length > 1 && v.segs[1].at <= t) { v.segs.shift(); v.elapsed = 0; }
      const seg = v.segs[0];
      if (seg && t >= seg.at) v.elapsed += dt * this.rateAt(v, t);
      const e = Math.min(v.elapsed, seg ? seg.dur : 0);
      const pos = v.rev ? v.start + v.len - e - 1e-4 : v.start + e;
      src = v.src;
      idx = Math.floor(pos * PAD_FPS);
      if (v.tape && t > v.tape.t0 + TAPE_TIME) { this.voice = null; this.light(); }
    }
    this.shownSrc = src; this.shownIdx = idx;
    this.engine.render({ src, idx, mosh: this.moshHeld, bloom: this.bloomHeld }, dt);
  }
}
