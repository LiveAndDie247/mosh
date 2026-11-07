// The background mosh field: a full-screen WebGL2 canvas behind all the UI.
//
// The picture lives in a texture at 1/4 screen resolution and feeds back into itself every
// frame. A low-res vector field (one vector per 16x16 screen block) says where each block's
// pixels come from, so blocks get dragged along their vectors and leave trails: the same smear
// as the I-frame-removal look. Vectors decay over ~1.5 s and the clean frame heals back in at
// about 1 % per frame. A second small texture holds per-block effects (pixelate, colour rot,
// rewind). Drawn to the screen dim (25 %) and upscaled nearest-neighbour, so it stays blocky.

const SCALE = 4;              // field pixels = screen pixels / 4
const BLOCK = 4;              // field pixels per block (= 16 screen pixels)
const DIM = 0.25;             // brightness on screen
const HEAL = 0.01;            // fraction of the clean frame mixed back in per frame (at 60 fps)
const MAX_V = 8;              // max vector length, field px per frame

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;           // x0, y0, x1, y1 in clip space
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0); }`;

// One feedback step: each pixel takes the pixel its block's vector points back to.
const STEP_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev, uClean, uFx;
uniform highp sampler2D uVec;     // RG32F: field px per frame
uniform vec2 uRes;
uniform float uBlock, uHeal;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy;
  ivec2 cell = ivec2(floor(p / uBlock));
  vec2 v = texelFetch(uVec, cell, 0).xy;
  vec4 fx = texelFetch(uFx, cell, 0);
  vec2 q = p - v;
  // PIXELATE: bigger macroblocks (16 -> 32 -> 64 screen px)
  float lvl = floor(fx.r * 255.0 / 80.0);
  if (lvl > 0.5) { float s = uBlock * exp2(lvl - 1.0); q = (floor(q / s) + 0.5) * s; }
  vec3 c = texture(uPrev, q / uRes).rgb;
  // Chroma drift where blocks move (and where COLOR ROT painted): purple or green per block
  float side = hash(vec2(cell)) > 0.5 ? 1.0 : -1.0;
  float drift = clamp(length(v) / 6.0, 0.0, 1.0) * 0.05 + fx.g * 0.07;
  c += side * drift * vec3(0.55, -0.75, 0.55);
  // Heal back toward the clean frame; REWIND paints it back fast
  vec3 clean = texture(uClean, p / uRes).rgb;
  o = vec4(mix(c, clean, clamp(uHeal + fx.b * 0.3, 0.0, 1.0)), 1.0);
}`;

const SHOW_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uImg;
uniform float uDim;
out vec4 o;
void main() { o = vec4(texture(uImg, vUv).rgb * uDim, 1.0); }`;

const COPY_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 o;
void main() { vec4 c = texture(uTex, vUv); o = vec4(c.rgb, c.a * uAlpha); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}
function link(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "program link failed");
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.error = null;
    this.bloom = 0;                 // 0..1: BLOOM keeps re-applying the last vectors
    this.tilt = [0, 0];             // gentle global push from phone tilt
    this.onFrame = null;            // called before each step with dt (paint tools that act while held)
    this.shocks = [];
    this.wipeState = null;
    this.cleanSrc = null;
    try {
      const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
      if (!gl) throw new Error("WebGL2 is not available");
      this.gl = gl;
      this.prog = { step: link(gl, STEP_FS), show: link(gl, SHOW_FS), copy: link(gl, COPY_FS) };
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.ok = true;
    } catch (e) {
      this.error = e.message || String(e);
      return;
    }
    canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); this.ok = false; this.stop(); });
    this.resize();
    let t = 0;
    addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => this.resize(), 150); });
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  // ---------- setup ----------
  tex(w, h, internal, format, type, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize() {
    if (!this.ok) return;
    const gl = this.gl;
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    if (w === this.sw && h === this.sh) return;
    this.sw = w; this.sh = h;
    this.canvas.width = w; this.canvas.height = h;
    this.bw = Math.ceil(w / (SCALE * BLOCK)); this.bh = Math.ceil(h / (SCALE * BLOCK));
    this.fw = this.bw * BLOCK; this.fh = this.bh * BLOCK;
    for (const t of [this.img?.[0], this.img?.[1], this.clean, this.vecTex, this.fxTex, this.stampTex]) if (t) gl.deleteTexture(t);
    for (const f of this.fb || []) gl.deleteFramebuffer(f);
    const RGBA = [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    this.img = [this.tex(this.fw, this.fh, ...RGBA), this.tex(this.fw, this.fh, ...RGBA)];
    this.fb = this.img.map(t => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return f;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.clean = this.tex(this.fw, this.fh, ...RGBA);
    this.stampTex = null;
    const n = this.bw * this.bh;
    this.vec = new Float32Array(n * 2);
    this.pix = new Float32Array(n); this.rot = new Float32Array(n); this.rew = new Float32Array(n);
    this.fxBytes = new Uint8Array(n * 4);
    this.vecTex = this.tex(this.bw, this.bh, gl.RG32F, gl.RG, gl.FLOAT, this.vec);
    this.fxTex = this.tex(this.bw, this.bh, ...RGBA);
    this.cur = 0;
    this.setImage(this.cleanSrc);
  }

  // Draw a picture (img / video / canvas / ImageBitmap), cover-fit, as the clean frame; then a keyframe
  setImage(src) {
    if (!this.ok) return;
    this.cleanSrc = src;
    const c = document.createElement("canvas");
    c.width = this.fw; c.height = this.fh;
    const g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
    if (src) {
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      if (sw && sh) {
        const s = Math.max(c.width / sw, c.height / sh);
        g.drawImage(src, (c.width - sw * s) / 2, (c.height - sh * s) / 2, sw * s, sh * s);
      }
    }
    this.upload(this.clean, c);
    this.keyframe();
  }

  upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  // Draw a texture into the current field image. rect in field px (x0, y0, x1, y1), GL orientation.
  blit(tex, rect, alpha = 1, blend = false) {
    const gl = this.gl, { p, u } = this.prog.copy;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[this.cur]);
    gl.viewport(0, 0, this.fw, this.fh);
    gl.useProgram(p);
    const cx = x => (x / this.fw) * 2 - 1, cy = y => (y / this.fh) * 2 - 1;
    gl.uniform4f(u.uRect, cx(rect[0]), cy(rect[1]), cx(rect[2]), cy(rect[3]));
    gl.uniform1f(u.uAlpha, alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.uTex, 0);
    if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (blend) gl.disable(gl.BLEND);
  }

  // A fresh keyframe: the clean picture, no motion
  keyframe() {
    if (!this.ok) return;
    this.blit(this.clean, [0, 0, this.fw, this.fh]);
    this.vec.fill(0); this.pix.fill(0); this.rot.fill(0); this.rew.fill(0);
  }

  // ---------- coordinates ----------
  toField(x, y) { return [(x / this.sw) * this.fw, (1 - y / this.sh) * this.fh]; }
  // Every block within radius r (screen px) of (x, y): fn(index, dx, dy, dist, falloff 0..1), field px
  each(x, y, r, fn) {
    const [fx, fy] = this.toField(x, y), fr = Math.max(BLOCK, r / SCALE);
    const i0 = Math.max(0, Math.floor((fx - fr) / BLOCK)), i1 = Math.min(this.bw - 1, Math.floor((fx + fr) / BLOCK));
    const j0 = Math.max(0, Math.floor((fy - fr) / BLOCK)), j1 = Math.min(this.bh - 1, Math.floor((fy + fr) / BLOCK));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * BLOCK - fx, dy = (j + 0.5) * BLOCK - fy, d = Math.hypot(dx, dy);
      if (d < fr) { const t = 1 - d / fr; fn(j * this.bw + i, dx, dy, d, t * t * (3 - 2 * t)); }
    }
  }
  addVec(k, vx, vy, mix = 0) {
    let x = this.vec[k * 2] * (1 - mix) + vx, y = this.vec[k * 2 + 1] * (1 - mix) + vy;
    const l = Math.hypot(x, y);
    if (l > MAX_V) { x *= MAX_V / l; y *= MAX_V / l; }
    this.vec[k * 2] = x; this.vec[k * 2 + 1] = y;
  }

  // ---------- tools (screen coordinates) ----------
  // SMEAR: drag blocks the way the finger moves
  smear(x, y, dx, dy, r) {
    if (!this.ok) return;
    const vx = (dx / this.sw) * this.fw, vy = -(dy / this.sh) * this.fh;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => this.addVec(k, vx * w * 0.6, vy * w * 0.6));
  }
  // SWIRL: a spinning vortex around the finger
  swirl(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, dx, dy, d, w) => {
      if (d < 0.01) return;
      const s = 2.4 * w;
      this.addVec(k, (-dy / d) * s - (dx / d) * 0.25 * w, (dx / d) * s - (dy / d) * 0.25 * w, 0.35);
    });
  }
  // MELT: everything under the finger drips down
  melt(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => this.addVec(k, (Math.random() - 0.5) * 0.6 * w, -2.6 * w, 0.3));
  }
  // EXPLODE: radial burst outward
  explode(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r * 2.2, (k, dx, dy, d, w) => {
      const s = (5 + Math.random() * 3) * (0.3 + w);
      this.addVec(k, d ? (dx / d) * s : 0, d ? (dy / d) * s : 0, 1);
    });
    this.shock(x, y, 0.6);
  }
  // SHATTER: blocks slide off in random directions
  shatter(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => {
      if (Math.hypot(this.vec[k * 2], this.vec[k * 2 + 1]) > 0.8) return;
      const a = Math.random() * Math.PI * 2, s = (1.5 + Math.random() * 3) * w;
      this.addVec(k, Math.cos(a) * s, Math.sin(a) * s, 1);
    });
  }
  // PIXELATE: bigger macroblocks the longer you hold (16 -> 32 -> 64)
  pixelate(x, y, r, dt) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => { this.pix[k] = Math.min(3.2, this.pix[k] + dt * 1.6 * w); });
  }
  // COLOR ROT: chroma drifts purple / green
  colorRot(x, y, r, dt) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => { this.rot[k] = Math.min(1, this.rot[k] + dt * 3 * w); });
  }
  // REWIND: paint the clean picture back in
  rewind(x, y, r, dt) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _dx, _dy, _d, w) => {
      this.rew[k] = Math.min(1, this.rew[k] + dt * 6 * w);
      this.vec[k * 2] *= 0.6; this.vec[k * 2 + 1] *= 0.6; this.pix[k] = 0; this.rot[k] = 0;
    });
  }
  // STAMP: drop a picture into the field (then it gets moshed like everything else)
  stamp(src, x, y, size) {
    if (!this.ok || !src) return;
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    if (!sw || !sh) return;
    if (!this.stampTex) this.stampTex = this.tex(1, 1, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
    this.upload(this.stampTex, src);
    const [fx, fy] = this.toField(x, y);
    const s = size / SCALE / 2, hw = sw >= sh ? s : (s * sw) / sh, hh = sw >= sh ? (s * sh) / sw : s;
    this.blit(this.stampTex, [fx - hw, fy - hh, fx + hw, fy + hh], 1, true);
  }
  // WIPE: the whole field slides off one way, then a fresh keyframe arrives
  wipe(dx, dy) {
    if (!this.ok) return;
    const l = Math.hypot(dx, dy) || 1;
    this.wipeState = { t: 0, vx: (dx / l) * 7, vy: (-dy / l) * 7 };
  }
  // Shockwave ring from (x, y): MOSH hits, explosions
  shock(x, y, power = 1) { if (this.ok) this.shocks.push({ x, y, t: 0, power }); }

  // ---------- undo ----------
  snapshot() {
    if (!this.ok) return null;
    const gl = this.gl, px = new Uint8Array(this.fw * this.fh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[this.cur]);
    gl.readPixels(0, 0, this.fw, this.fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { fw: this.fw, fh: this.fh, px, vec: this.vec.slice(), pix: this.pix.slice(), rot: this.rot.slice() };
  }
  restore(s) {
    if (!this.ok || !s || s.fw !== this.fw || s.fh !== this.fh) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.img[this.cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.fw, this.fh, gl.RGBA, gl.UNSIGNED_BYTE, s.px);
    this.vec.set(s.vec); this.pix.set(s.pix); this.rot.set(s.rot); this.rew.fill(0);
    this.wipeState = null; this.shocks = [];
    return true;
  }

  // ---------- frame loop ----------
  start() {
    if (!this.ok || this.raf) return;
    this.last = performance.now();
    const loop = now => {
      this.raf = requestAnimationFrame(loop);
      if (now - this.last < 1000 / 61) return;          // cap at 60 fps (120 Hz phones)
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  frame(dt) {
    const gl = this.gl, n = this.bw * this.bh;
    this.onFrame?.(dt);

    // Shockwaves: an expanding ring pushing blocks outward
    for (const s of this.shocks) {
      s.t += dt;
      const ring = (s.t * 1400) / SCALE, width = 70 / SCALE;
      const [fx, fy] = this.toField(s.x, s.y);
      for (let j = 0; j < this.bh; j++) for (let i = 0; i < this.bw; i++) {
        const dx = (i + 0.5) * BLOCK - fx, dy = (j + 0.5) * BLOCK - fy, d = Math.hypot(dx, dy);
        const w = 1 - Math.abs(d - ring) / width;
        if (w > 0 && d > 0.5) this.addVec(j * this.bw + i, (dx / d) * 3.5 * w * s.power, (dy / d) * 3.5 * w * s.power);
      }
    }
    this.shocks = this.shocks.filter(s => s.t < 0.7);

    // Wipe: everything slides one way, then a keyframe
    if (this.wipeState) {
      const w = this.wipeState;
      w.t += dt;
      for (let k = 0; k < n; k++) { this.vec[k * 2] = w.vx; this.vec[k * 2 + 1] = w.vy; }
      if (w.t > 0.55) { this.wipeState = null; this.keyframe(); }
    }

    // Tilt: a gentle push everywhere
    if (this.tilt[0] || this.tilt[1]) for (let k = 0; k < n; k++) this.addVec(k, this.tilt[0] * dt * 6, this.tilt[1] * dt * 6);

    // Decay: vectors fade over ~1.5 s (BLOOM keeps re-applying them); effects heal slowly
    const keep = Math.exp(-2 * dt * (1 - 0.97 * this.bloom));
    for (let i = 0; i < this.vec.length; i++) this.vec[i] *= keep;
    const fx = this.fxBytes;
    for (let k = 0; k < n; k++) {
      this.pix[k] = Math.max(0, this.pix[k] - dt / 6);
      this.rot[k] = Math.max(0, this.rot[k] - dt / 3);
      this.rew[k] = Math.max(0, this.rew[k] - dt * 2);
      fx[k * 4] = Math.min(255, this.pix[k] * 80);
      fx[k * 4 + 1] = this.rot[k] * 255;
      fx[k * 4 + 2] = this.rew[k] * 255;
      fx[k * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.vecTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bw, this.bh, gl.RG, gl.FLOAT, this.vec);
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bw, this.bh, gl.RGBA, gl.UNSIGNED_BYTE, fx);

    // Feedback step: img[cur] -> img[next]
    const next = 1 - this.cur, { p, u } = this.prog.step;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[next]);
    gl.viewport(0, 0, this.fw, this.fh);
    gl.useProgram(p);
    gl.uniform4f(u.uRect, -1, -1, 1, 1);
    gl.uniform2f(u.uRes, this.fw, this.fh);
    gl.uniform1f(u.uBlock, BLOCK);
    gl.uniform1f(u.uHeal, Math.min(1, HEAL * dt * 60));
    const bind = (unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unit); };
    bind(0, this.img[this.cur], "uPrev"); bind(1, this.clean, "uClean"); bind(2, this.vecTex, "uVec"); bind(3, this.fxTex, "uFx");
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = next;

    // To the screen: dim, nearest-neighbour upscale
    const sh = this.prog.show;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(sh.p);
    gl.uniform4f(sh.u.uRect, -1, -1, 1, 1);
    gl.uniform1f(sh.u.uDim, DIM);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img[this.cur]); gl.uniform1i(sh.u.uImg, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// A stand-in picture when there's no clip yet
export function patternImage(w = 360, h = 640) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const bands = ["#ff2a3c", "#ffb000", "#19f0ff", "#7a3cff", "#20d060", "#ffffff"];
  for (let i = 0; i < 16; i++) {
    g.fillStyle = bands[i % bands.length];
    g.beginPath();
    g.moveTo(-h + i * 90, 0); g.lineTo(-h + i * 90 + 45, 0); g.lineTo(i * 90 + 45, h); g.lineTo(i * 90, h);
    g.fill();
  }
  g.fillStyle = "rgba(0,0,0,.55)";
  for (let y = 0; y < h; y += 40) for (let x = (y / 40) % 2 ? 0 : 40; x < w; x += 80) g.fillRect(x, y, 40, 40);
  g.fillStyle = "#fff";
  g.font = 'bold 110px "Times New Roman", Times, serif';
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("MOSH", w / 2, h / 2);
  return c;
}
