// MOSH PAINT: a chunky toolbar that slides out from the left edge; every tool writes into the
// background mosh field differently. Big pixel-art icons on 90s grey bevel buttons, three brush
// sizes, a big WIPE, a big UNDO (10 low-res snapshots of the field), mute and tilt toggles.
// All icons are original 12x12 pixel art, drawn here from strings.
import { voice, sfx, audio, isMuted, setMuted } from "./sfx.js";

const SIZES = [28, 56, 110];                 // brush radius, screen px
const UNDO_MAX = 10;

const PALETTE = {
  k: "#000000", w: "#ffffff", r: "#e8202a", y: "#ffd400", b: "#2050ff", g: "#18c040",
  p: "#a030e0", o: "#ff8a00", c: "#20e0ff", s: "#808080", n: "#8a4a10",
};
const ICONS = {
  smear: [
    "..........kk", ".........kyk", "........kyk.", ".......kyk..", "......knk...", ".....knk....",
    "....kkk.....", "...krrk.....", "..krrrk.....", ".krrrk......", "krrkk.......", "kkk.........",
  ],
  swirl: [
    "....kkkk....", "..kkbbbbkk..", ".kbbkkkkbbk.", ".kbk....kbk.", "kbk..kk..kbk", "kbk.kbbk.kbk",
    "kbk.kb.k.kbk", "kbk..k..kbk.", ".kbk...kbk..", ".kbbkkkbk...", "..kkbbbk....", "....kkk.....",
  ],
  melt: [
    "kkkkkkkkkkkk", "kyyyyyyyyyyk", "kyyyyyyyyyyk", "kykyykyyykyk", "kkkyykykkkyk", "..kyyk.k.kyk",
    "..kyyk...kyk", "..kyyk...kk.", "...kk.......", "............", "....kk......", "...kyyk.....",
  ],
  explode: [
    ".......y.o..", "......o.y...", ".....kk.....", "....k.......", "...kk.......", "..krrk......",
    "..krwrk.....", "..krrrk.....", "..krwrk.....", "..krrrk.....", "..krrrk.....", "...kkk......",
  ],
  shatter: [
    "kkkkkkkkkkkk", "kcc.kccck..k", "kcck.kcck.ck", "kck.ccc.kcck", "kk.cccck.cck", "kcc.kc.kcc.k",
    "kccck.kcccck", "k.kccck.kcck", "kcc.kccc.kck", "kcck.cck.cck", "kc.kcck.kc.k", "kkkkkkkkkkkk",
  ],
  pixelate: [
    "kkkkkkkkkkkk", "krrrggbbbppk", "krrrggbbbppk", "krrrggbbbppk", "kyyyyccccssk", "kyyyyccccssk",
    "kyyyyccccssk", "kbbbbbbrrrrk", "kbbbbbbrrrrk", "kggppppyyyyk", "kggppppyyyyk", "kkkkkkkkkkkk",
  ],
  colorrot: [
    ".....kk.....", "....kppk....", "....kppk....", "...kpppgk...", "...kppggk...", "..kppggggk..",
    "..kpggggggk.", ".kpwgggggggk", ".kpwggggggk.", "..kpgggggk..", "...kkkkkk...", "............",
  ],
  stamp: [
    "....kkkk....", "...krrrrk...", "...krrrrk...", "....krrk....", "....krrk....", "..kkkkkkkk..",
    ".knnnnnnnnk.", ".knnnnnnnnk.", ".kkkkkkkkkk.", "............", ".kwwkwwkwwk.", "............",
  ],
  rewind: [
    "............", "....k....k..", "...kk...kk..", "..kgk..kgk..", ".kggk.kggk..", "kgggkkgggk..",
    ".kggk.kggk..", "..kgk..kgk..", "...kk...kk..", "....k....k..", "............", "............",
  ],
  wipe: [
    "............", "......kk....", "......kyk...", "kkkkkkkyyk..", "kyyyyyyyyyk.", "kyyyyyyyyyyk",
    "kyyyyyyyyyk.", "kkkkkkkyyk..", "......kyk...", "......kk....", "............", "............",
  ],
  undo: [
    "...kkkkkk...", "..kyyyyyyk..", ".kyyyyyyyyk.", "kyykyyyykyyk", "kykykyykykyk", "kyykyyyykyyk",
    "kyyyyyyyyyyk", "kyykkkkkkyyk", "kyyykrrkyyyk", ".kyyyrrkyyk.", "..kyyykyyk..", "...kkkkkk...",
  ],
  sound: [
    "............", ".....k......", "....kk......", ".kkkkk...k..", ".kwwwk.k..k.", ".kwwwk..k.k.",
    ".kwwwk..k.k.", ".kwwwk.k..k.", ".kkkkk...k..", "....kk......", ".....k......", "............",
  ],
};

const TOOLS = [
  ["smear", "smear"], ["swirl", "swirl"], ["melt", "melt"], ["explode", "boom"], ["shatter", "shatter"],
  ["pixelate", "pixel"], ["colorrot", "rot"], ["stamp", "stamp"], ["rewind", "rewind"],
];

function iconURL(rows) {
  const c = document.createElement("canvas");
  c.width = 12; c.height = 12;
  const g = c.getContext("2d");
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (PALETTE[ch]) { g.fillStyle = PALETTE[ch]; g.fillRect(x, y, 1, 1); }
  }));
  return c.toDataURL();
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const img = (name, alt = "") => `<img src="${iconURL(ICONS[name])}" alt="${alt}">`;

export class Paint {
  constructor({ field, onSwipe, getStamp }) {
    this.field = field;
    this.onSwipe = onSwipe;
    this.getStamp = getStamp;
    this.open = false;
    this.tool = "smear";
    this.size = 1;
    this.undoStack = [];
    this.down = null;
    this.v = null;
    this.lastDir = [-1, 0];
    this.build();
    this.bindPointer();
    field.onFrame = dt => this.tick(dt);
  }

  // ---------- toolbar ----------
  build() {
    this.tab = el("button", "paint-tab", img("smear", "Paint tools"));
    this.tab.setAttribute("aria-label", "Paint tools");
    this.tab.setAttribute("aria-expanded", "false");
    this.tab.addEventListener("click", () => this.setOpen(!this.open));

    const bar = (this.bar = el("aside", "paint-bar"));
    bar.setAttribute("aria-label", "MOSH PAINT");
    bar.append(el("div", "paint-title", "MOSH PAINT"));

    const grid = el("div", "tool-grid");
    this.toolBtns = {};
    for (const [id, label] of TOOLS) {
      const b = el("button", "bevel tool", `${img(id)}<span>${label}</span>`);
      b.addEventListener("click", () => { this.tool = id; this.sync(); });
      this.toolBtns[id] = b;
      grid.append(b);
    }
    bar.append(grid);

    const sizes = el("div", "sizes");
    this.sizeBtns = SIZES.map((r, i) => {
      const b = el("button", "bevel size", `<span style="width:${10 + i * 10}px;height:${10 + i * 10}px"></span>`);
      b.setAttribute("aria-label", ["small", "medium", "large"][i] + " brush");
      b.addEventListener("click", () => { this.size = i; this.sync(); });
      sizes.append(b);
      return b;
    });
    bar.append(sizes);

    const wipe = el("button", "bevel big-btn", `${img("wipe")}<span>WIPE</span>`);
    wipe.addEventListener("click", () => {
      audio();
      const [dx, dy] = this.lastDir;
      this.pushUndo();
      this.field.wipe(dx, dy);
      sfx.whoosh();
    });
    const undo = el("button", "bevel big-btn", `${img("undo")}<span>UNDO</span>`);
    undo.addEventListener("click", () => this.undo());
    bar.append(wipe, undo);

    const row = el("div", "mini-row");
    this.muteBtn = el("button", "bevel mini", `${img("sound")}<span>sound</span>`);
    this.muteBtn.addEventListener("click", () => { setMuted(!isMuted()); this.sync(); });
    this.tiltBtn = el("button", "bevel mini", `<b class="tilt-glyph">⤡</b><span>tilt</span>`);
    this.tiltBtn.addEventListener("click", () => this.toggleTilt());
    row.append(this.muteBtn, this.tiltBtn);
    bar.append(row);

    document.body.append(bar, this.tab);
    this.sync();
  }

  setOpen(open) {
    this.open = open;
    this.bar.classList.toggle("open", open);
    document.body.classList.toggle("painting", open);
    this.tab.setAttribute("aria-expanded", String(open));
    // Open: the whole background is a canvas. Closed: vertical drags still scroll the page.
    this.field.canvas.style.touchAction = open ? "none" : "pan-y";
  }

  sync() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle("on", id === this.tool);
    this.sizeBtns.forEach((b, i) => b.classList.toggle("on", i === this.size));
    this.muteBtn.classList.toggle("muted", isMuted());
    this.muteBtn.querySelector("span").textContent = isMuted() ? "muted" : "sound";
    this.tiltBtn.classList.toggle("on", !!this.tiltOn);
  }

  // ---------- undo ----------
  pushUndo() {
    const s = this.field.snapshot();
    if (!s) return;
    this.undoStack.push(s);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
  }
  undo() {
    audio();
    sfx.nope();
    const s = this.undoStack.pop();
    if (s) this.field.restore(s);
  }

  // ---------- tilt (optional gentle smear) ----------
  async toggleTilt() {
    if (this.tiltOn) {
      this.tiltOn = false;
      removeEventListener("deviceorientation", this.onTilt);
      this.field.tilt = [0, 0];
      this.sync();
      return;
    }
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === "function" && (await DOE.requestPermission()) !== "granted") return;
    } catch { return; }
    let base = null;
    this.onTilt = e => {
      if (e.beta == null || e.gamma == null) return;
      if (!base) base = [e.beta, e.gamma];
      const c = v => Math.max(-1, Math.min(1, v / 30));
      this.field.tilt = [c(e.gamma - base[1]) * 0.5, -c(e.beta - base[0]) * 0.5];
    };
    addEventListener("deviceorientation", this.onTilt);
    this.tiltOn = true;
    this.sync();
  }

  // ---------- painting on the background ----------
  get radius() { return this.open ? SIZES[this.size] : SIZES[1]; }
  get activeTool() { return this.open ? this.tool : "smear"; }   // closed: plain smearing

  bindPointer() {
    const c = this.field.canvas;
    c.style.touchAction = "pan-y";
    c.addEventListener("pointerdown", e => this.onDown(e));
    c.addEventListener("pointermove", e => this.onMove(e));
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) c.addEventListener(t, e => this.onUp(e));
  }

  onDown(e) {
    if (!this.field.ok || this.down) return;
    audio();
    try { this.field.canvas.setPointerCapture(e.pointerId); } catch {}
    this.pushUndo();
    const x = e.clientX, y = e.clientY, tool = this.activeTool;
    this.down = { id: e.pointerId, x, y, t: performance.now(), tool };
    if (tool === "explode") { this.field.explode(x, y, this.radius); sfx.boom(); }
    if (tool === "stamp") {
      const src = this.getStamp?.();
      if (src) { this.field.stamp(src, x, y, this.radius * 3); sfx.boing(); } else sfx.nope();
    }
    this.v = voice(tool);
  }

  onMove(e) {
    const d = this.down;
    if (!d || e.pointerId !== d.id) return;
    const x = e.clientX, y = e.clientY, now = performance.now();
    const dx = x - d.x, dy = y - d.y, dt = Math.max(1, now - d.t) / 1000;
    if (d.tool === "smear") this.field.smear(x, y, dx, dy, this.radius);
    if (d.tool === "shatter") this.field.shatter(x, y, this.radius);
    if (Math.hypot(dx, dy) > 3) { this.lastDir = [dx, dy]; this.onSwipe?.(dx, dy); }
    this.v?.update(Math.hypot(dx, dy) / dt, y / innerHeight);
    d.x = x; d.y = y; d.t = now;
  }

  // Tools that keep working while the finger is held still
  tick(dt) {
    const d = this.down;
    if (!d) return;
    const f = this.field, r = this.radius;
    if (d.tool === "swirl") f.swirl(d.x, d.y, r);
    else if (d.tool === "melt") f.melt(d.x, d.y, r);
    else if (d.tool === "pixelate") f.pixelate(d.x, d.y, r, dt);
    else if (d.tool === "colorrot") f.colorRot(d.x, d.y, r, dt);
    else if (d.tool === "rewind") f.rewind(d.x, d.y, r, dt);
  }

  onUp(e) {
    const d = this.down;
    if (!d || e.pointerId !== d.id) return;
    this.down = null;
    this.v?.stop();
    this.v = null;
  }
}
