// The background mosh field: a full-screen WebGL2 canvas behind all the UI.
//
// The picture lives in a texture at 1/4 screen resolution and feeds back into itself every
// frame. A low-res vector field (one vector per 16x16 screen block) says where each block's
// pixels come from, so dragging a finger drags the picture into trails: the same smear as the
// I-frame-removal look. Vectors decay over ~1.5 s and the clean frame heals back in at about
// 1 % per frame. Drawn dim (25 %) and upscaled nearest-neighbour, so it stays blocky.

const SCALE = 4;              // field pixels = screen pixels / 4
const BLOCK = 4;              // field pixels per block (= 16 screen pixels)
const DIM = 0.25;             // brightness on screen
const HEAL = 0.01;            // fraction of the clean frame mixed back in per frame (at 60 fps)
const MAX_V = 8;              // max vector length, field px per frame
const RADIUS = 56;            // smear radius, screen px

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0); }`;

// One feedback step: each pixel takes the pixel its block's vector points back to
const STEP_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev, uClean;
uniform highp sampler2D uVec;
uniform vec2 uRes;
uniform float uBlock, uHeal;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy;
  ivec2 cell = ivec2(floor(p / uBlock));
  vec2 v = texelFetch(uVec, cell, 0).xy;
  vec3 c = texture(uPrev, (p - v) / uRes).rgb;
  float side = hash(vec2(cell)) > 0.5 ? 1.0 : -1.0;          // chroma drift on moving blocks
  c += side * clamp(length(v) / 6.0, 0.0, 1.0) * 0.05 * vec3(0.55, -0.75, 0.55);
  o = vec4(mix(c, texture(uClean, p / uRes).rgb, uHeal), 1.0);
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
uniform sampler2D uImg;
out vec4 o;
void main() { o = vec4(texture(uImg, vUv).rgb, 1.0); }`;

function link(gl, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "program link failed");
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export class Field {
  constructor(canvas, { onSwipe } = {}) {
    this.canvas = canvas;
    this.onSwipe = onSwipe;
    this.ok = false;
    this.error = null;
    this.bloom = 0;                 // 0..1: BLOOM keeps re-applying the last vectors
    this.shocks = [];
    this.cleanSrc = null;
    try {
      const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
      if (!gl) throw new Error("WebGL2 is not available");
      this.gl = gl;
      this.prog = { step: link(gl, STEP_FS), show: link(gl, SHOW_FS), copy: link(gl, COPY_FS) };
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.ok = true;
    } catch (e) {
      this.error = e.message || String(e);
      return;
    }
    canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); this.ok = false; this.stop(); });
    this.bindDrag();
    this.resize();
    let t = 0;
    addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => this.resize(), 150); });
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  // Drag on empty background to smear it. Vertical drags still scroll the page (pan-y).
  bindDrag() {
    const c = this.canvas;
    c.style.touchAction = "pan-y";
    let down = null;
    c.addEventListener("pointerdown", e => { down = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    c.addEventListener("pointermove", e => {
      if (!down || e.pointerId !== down.id) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      this.smear(e.clientX, e.clientY, dx, dy, RADIUS);
      if (Math.hypot(dx, dy) > 3) this.onSwipe?.(dx, dy);
      down.x = e.clientX; down.y = e.clientY;
    });
    for (const t of ["pointerup", "pointercancel"]) c.addEventListener(t, () => { down = null; });
  }

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
    for (const t of [this.img?.[0], this.img?.[1], this.clean, this.vecTex]) if (t) gl.deleteTexture(t);
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
    this.vec = new Float32Array(this.bw * this.bh * 2);
    this.vecTex = this.tex(this.bw, this.bh, gl.RG32F, gl.RG, gl.FLOAT, this.vec);
    this.cur = 0;
    this.setImage(this.cleanSrc);
  }

  // Draw a picture (img / video / canvas / ImageBitmap), cover-fit, as the clean frame
  setImage(src) {
    if (!this.ok) return;
    this.cleanSrc = src;
    const c = document.createElement("canvas");
    c.width = this.fw; c.height = this.fh;
    const g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
    const sw = src?.videoWidth || src?.width, sh = src?.videoHeight || src?.height;
    if (sw && sh) {
      const s = Math.max(c.width / sw, c.height / sh);
      g.drawImage(src, (c.width - sw * s) / 2, (c.height - sh * s) / 2, sw * s, sh * s);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.clean);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // A keyframe: the clean picture, no motion
    const P = this.prog.copy;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[this.cur]);
    gl.viewport(0, 0, this.fw, this.fh);
    gl.useProgram(P.p);
    gl.uniform4f(P.u.uRect, -1, -1, 1, 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.clean); gl.uniform1i(P.u.uImg, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.vec.fill(0);
  }

  addVec(k, vx, vy) {
    let x = this.vec[k * 2] + vx, y = this.vec[k * 2 + 1] + vy;
    const l = Math.hypot(x, y);
    if (l > MAX_V) { x *= MAX_V / l; y *= MAX_V / l; }
    this.vec[k * 2] = x; this.vec[k * 2 + 1] = y;
  }

  // Drag the blocks under (x, y) the way the finger moves (screen coordinates)
  smear(x, y, dx, dy, r) {
    if (!this.ok) return;
    const fx = (x / this.sw) * this.fw, fy = (1 - y / this.sh) * this.fh, fr = Math.max(BLOCK, r / SCALE);
    const vx = (dx / this.sw) * this.fw * 0.6, vy = -(dy / this.sh) * this.fh * 0.6;
    const i0 = Math.max(0, Math.floor((fx - fr) / BLOCK)), i1 = Math.min(this.bw - 1, Math.floor((fx + fr) / BLOCK));
    const j0 = Math.max(0, Math.floor((fy - fr) / BLOCK)), j1 = Math.min(this.bh - 1, Math.floor((fy + fr) / BLOCK));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5) * BLOCK - fx, (j + 0.5) * BLOCK - fy);
      if (d >= fr) continue;
      const t = 1 - d / fr, w = t * t * (3 - 2 * t);
      this.addVec(j * this.bw + i, vx * w, vy * w);
    }
  }

  // Shockwave ring from (x, y): MOSH and pad hits
  shock(x, y, power = 1) { if (this.ok) this.shocks.push({ x, y, t: 0, power }); }

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
    const gl = this.gl;
    for (const s of this.shocks) {
      s.t += dt;
      const ring = (s.t * 1400) / SCALE, width = 70 / SCALE;
      const fx = (s.x / this.sw) * this.fw, fy = (1 - s.y / this.sh) * this.fh;
      for (let j = 0; j < this.bh; j++) for (let i = 0; i < this.bw; i++) {
        const dx = (i + 0.5) * BLOCK - fx, dy = (j + 0.5) * BLOCK - fy, d = Math.hypot(dx, dy);
        const w = 1 - Math.abs(d - ring) / width;
        if (w > 0 && d > 0.5) this.addVec(j * this.bw + i, (dx / d) * 3.5 * w * s.power, (dy / d) * 3.5 * w * s.power);
      }
    }
    this.shocks = this.shocks.filter(s => s.t < 0.7);

    const keep = Math.exp(-2 * dt * (1 - 0.97 * this.bloom));   // fade ~1.5 s; BLOOM keeps them
    for (let i = 0; i < this.vec.length; i++) this.vec[i] *= keep;
    gl.bindTexture(gl.TEXTURE_2D, this.vecTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bw, this.bh, gl.RG, gl.FLOAT, this.vec);

    const next = 1 - this.cur, { p, u } = this.prog.step;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[next]);
    gl.viewport(0, 0, this.fw, this.fh);
    gl.useProgram(p);
    gl.uniform4f(u.uRect, -1, -1, 1, 1);
    gl.uniform2f(u.uRes, this.fw, this.fh);
    gl.uniform1f(u.uBlock, BLOCK);
    gl.uniform1f(u.uHeal, Math.min(1, HEAL * dt * 60));
    const bind = (unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unit); };
    bind(0, this.img[this.cur], "uPrev"); bind(1, this.clean, "uClean"); bind(2, this.vecTex, "uVec");
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = next;

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

// A stand-in picture until a clip is picked: colour bands and a checker, no text
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
  return c;
}
