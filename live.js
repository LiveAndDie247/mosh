// The live mosh engine (WebGL2). Every pre-decoded frame of both clips sits on the GPU in a
// texture array. Each time the shown frame changes:
//   1. MOTION: block matching finds, for every 8x8 block, where it came from in the previous
//      frame (±8 px): the motion vectors a codec would have stored for a P-frame.
//   2. PICTURE: normally the new frame is shown as is (a keyframe every frame). While MOSH is
//      held, the new frame is NOT shown: the held picture is pushed along the motion vectors
//      instead, plus the P-frame "residual", which is exactly what I-frame removal does. BLOOM
//      freezes the vectors so the same motion keeps re-applying and the smear grows.
// Let go of MOSH and the next frame arrives clean, like a new I-frame.

const RESID = 0.55;              // how much of the P-frame residual gets added while moshing
const ENC = 128 / 255;           // vector encoding: 0.5 in an 8-bit texture = no motion

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

const MOTION_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uF;
uniform float uCur, uPrev;
uniform vec2 uRes;
out vec4 o;
float L(vec2 p, float layer) { return dot(texture(uF, vec3(p / uRes, layer)).rgb, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 b0 = floor(gl_FragCoord.xy) * 8.0;
  float cur[16];
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) cur[j * 4 + i] = L(b0 + vec2(i, j) * 2.0 + 1.0, uCur);
  float best = 1e9;
  vec2 bv = vec2(0.0);
  for (int dy = -4; dy <= 4; dy++) for (int dx = -4; dx <= 4; dx++) {
    vec2 d = vec2(dx, dy) * 2.0;
    float s = 0.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += abs(cur[j * 4 + i] - L(b0 + vec2(i, j) * 2.0 + 1.0 - d, uPrev));
    s += length(d) * 0.004;                     // ties: prefer less motion
    if (s < best) { best = s; bv = d; }
  }
  o = vec4(bv / 32.0 + ${ENC.toFixed(6)}, 0.0, 1.0);
}`;

const MOSH_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2D uPic, uVec;
uniform sampler2DArray uF;
uniform float uCur, uPrev, uMosh, uResid;
uniform vec2 uRes;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 clean = texture(uF, vec3(p / uRes, uCur)).rgb;
  if (uMosh < 0.5) { o = vec4(clean, 1.0); return; }
  ivec2 cell = ivec2(floor(p / 8.0));
  vec2 v = (texelFetch(uVec, cell, 0).xy - ${ENC.toFixed(6)}) * 32.0;
  vec3 c = texture(uPic, (p - v) / uRes).rgb;
  // The P-frame residual: what the encoder adds on top of the motion
  c += (clean - texture(uF, vec3((p - v) / uRes, uPrev)).rgb) * uResid;
  // Chroma drift along the trails: purple or green per block
  float side = hash(vec2(cell)) > 0.5 ? 1.0 : -1.0;
  c += side * clamp(length(v) / 8.0, 0.0, 1.0) * 0.04 * vec3(0.55, -0.75, 0.55);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Picture textures are stored top row first (like the decoded frames), so flip on the way out
const SHOW_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uPic;
out vec4 o;
void main() { o = vec4(texture(uPic, vec2(vUv.x, 1.0 - vUv.y)).rgb, 1.0); }`;

// PAINT layer on top of the video: the side tools (smear, swirl, melt, …) write vectors and
// effects per 8x8 block; painted blocks feed back into themselves and heal back to the video
// as their paint fades. Untouched blocks show the video exactly.
const PAINT_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc, uPrev, uFx;
uniform highp sampler2D uPv;
uniform vec2 uRes;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy;
  ivec2 cell = ivec2(floor(p / 8.0));
  vec4 fx = texelFetch(uFx, cell, 0);
  vec3 src = texture(uSrc, p / uRes).rgb;
  if (fx.a < 0.004) { o = vec4(src, 1.0); return; }
  vec2 v = texelFetch(uPv, cell, 0).xy;
  vec2 q = p - v;
  float lvl = floor(fx.r * 255.0 / 80.0);
  if (lvl > 0.5) { float s = 8.0 * exp2(lvl - 1.0); q = (floor(q / s) + 0.5) * s; }
  vec3 c = texture(uPrev, q / uRes).rgb;
  float side = hash(vec2(cell)) > 0.5 ? 1.0 : -1.0;
  c += side * (clamp(length(v) / 6.0, 0.0, 1.0) * 0.05 + fx.g * 0.07) * vec3(0.55, -0.75, 0.55);
  float heal = clamp(mix(1.0, 0.03, fx.a) + fx.b * 0.3, 0.0, 1.0);
  o = vec4(clamp(mix(c, src, heal), 0.0, 1.0), 1.0);
}`;

// Draw a texture into a rectangle (STAMP)
const RECT_VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0); }`;
const COPY_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main() { o = texture(uTex, vUv); }`;

const MAX_V = 10;               // paint vectors, image px per frame

function program(gl, fs, vs = VS) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
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

export class LiveEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.prog = {
      motion: program(gl, MOTION_FS), mosh: program(gl, MOSH_FS), show: program(gl, SHOW_FS),
      paint: program(gl, PAINT_FS), copy: program(gl, COPY_FS, RECT_VS),
    };
    this.ok = false;            // true once clips are loaded (the paint tools check this)
    this.shocks = [];
    this.wipeState = null;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.arrays = {};
    this.last = { src: null, idx: -1, feedback: false };
    this.bloomAcc = 0;
  }

  tex2d(w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t, fb };
  }

  // clips: { A?, B? } each { w, h, n, frames: Uint8Array (n frames of RGBA, top row first) }
  texRaw(w, h, internal, format, type, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  // Free everything from a previous load (a new mosh replaces the old one)
  release() {
    const gl = this.gl;
    for (const a of Object.values(this.arrays)) gl.deleteTexture(a.t);
    this.arrays = {};
    for (const x of [...(this.pic || []), this.vec, ...(this.ppic || [])]) if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.fb); }
    for (const t of [this.pvTex, this.fxTex, this.stampTex]) if (t) gl.deleteTexture(t);
    this.pic = this.ppic = this.vec = this.pvTex = this.fxTex = this.stampTex = null;
    this.last = { src: null, idx: -1, feedback: false };
    this.ok = false;
  }

  setClips(clips) {
    this.release();
    const gl = this.gl, any = Object.values(clips).find(Boolean);
    this.w = any.w; this.h = any.h;
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.bw = this.w / 8; this.bh = this.h / 8;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    for (const [k, c] of Object.entries(clips)) {
      if (!c) continue;
      const n = Math.min(c.n, maxLayers);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, c.w, c.h, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, c.frames.subarray(0, n * c.w * c.h * 4));
      for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, v);
      if (gl.getError() === gl.OUT_OF_MEMORY) throw new Error("not enough GPU memory for the clip frames");
      this.arrays[k] = { t, n };
    }
    this.pic = [this.tex2d(this.w, this.h), this.tex2d(this.w, this.h)];
    this.cur = 0;
    this.vec = this.tex2d(this.bw, this.bh);
    this.zeroVec();

    // Paint layer: its own picture (ping-pong) and per-block vectors / effects
    this.ppic = [this.tex2d(this.w, this.h), this.tex2d(this.w, this.h)];
    this.pcur = 0;
    const n = this.bw * this.bh;
    this.pv = new Float32Array(n * 2);
    this.pix = new Float32Array(n); this.rot = new Float32Array(n); this.rew = new Float32Array(n); this.wgt = new Float32Array(n);
    this.fxBytes = new Uint8Array(n * 4);
    this.pvTex = this.texRaw(this.bw, this.bh, gl.RG32F, gl.RG, gl.FLOAT, this.pv);
    this.fxTex = this.texRaw(this.bw, this.bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.fxBytes);
    this.shocks = []; this.wipeState = null;
    this.ok = true;
  }

  zeroVec() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vec.fb);
    gl.clearColor(ENC, ENC, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(prog, fb, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
  }
  bindArray(unit, tex, loc) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex); gl.uniform1i(loc, unit); }
  bind2d(unit, tex, loc) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); }

  motion(arr, cur, prev) {
    const gl = this.gl, P = this.prog.motion;
    this.draw(P, this.vec.fb, this.bw, this.bh);
    this.bindArray(0, arr, P.u.uF);
    gl.uniform1f(P.u.uCur, cur); gl.uniform1f(P.u.uPrev, prev);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  step(arr, cur, prev, mosh, resid) {
    const gl = this.gl, P = this.prog.mosh, next = 1 - this.cur;
    this.draw(P, this.pic[next].fb, this.w, this.h);
    this.bind2d(0, this.pic[this.cur].t, P.u.uPic);
    this.bind2d(1, this.vec.t, P.u.uVec);
    this.bindArray(2, arr, P.u.uF);
    gl.uniform1f(P.u.uCur, cur); gl.uniform1f(P.u.uPrev, prev);
    gl.uniform1f(P.u.uMosh, mosh ? 1 : 0); gl.uniform1f(P.u.uResid, resid);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = next;
  }

  present(tex) {
    const gl = this.gl, P = this.prog.show;
    this.draw(P, null, this.canvas.width, this.canvas.height);
    this.bind2d(0, tex, P.u.uPic);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- the paint layer (every display frame) ----------
  paintFrame(dt) {
    const gl = this.gl, n = this.bw * this.bh;
    for (const s of this.shocks) {                       // shockwave rings
      s.t += dt;
      const ring = s.t * 420, width = 24;
      for (let j = 0; j < this.bh; j++) for (let i = 0; i < this.bw; i++) {
        const dx = (i + 0.5) * 8 - s.x, dy = (j + 0.5) * 8 - s.y, d = Math.hypot(dx, dy);
        const w = 1 - Math.abs(d - ring) / width;
        if (w > 0 && d > 0.5) { const k = j * this.bw + i; this.addVec(k, (dx / d) * 4 * w * s.power, (dy / d) * 4 * w * s.power); this.mark(k, w * s.power); }
      }
    }
    this.shocks = this.shocks.filter(s => s.t < 0.7);
    if (this.wipeState) {                                 // WIPE: everything slides off, then back to the video
      const w = this.wipeState;
      w.t += dt;
      for (let k = 0; k < n; k++) { this.pv[k * 2] = w.vx; this.pv[k * 2 + 1] = w.vy; this.wgt[k] = 1; }
      if (w.t > 0.55) { this.wipeState = null; this.pv.fill(0); this.wgt.fill(0); this.pix.fill(0); this.rot.fill(0); }
    }
    const keep = Math.exp(-2 * dt), fx = this.fxBytes;
    for (let k = 0; k < n; k++) {
      this.pv[k * 2] *= keep; this.pv[k * 2 + 1] *= keep;
      this.wgt[k] = Math.max(0, this.wgt[k] - dt / 2);  // paint fades over ~2 s, then it's the video again
      this.pix[k] = Math.max(0, this.pix[k] - dt / 6);
      this.rot[k] = Math.max(0, this.rot[k] - dt / 3);
      this.rew[k] = Math.max(0, this.rew[k] - dt * 2);
      fx[k * 4] = Math.min(255, this.pix[k] * 80);
      fx[k * 4 + 1] = this.rot[k] * 255;
      fx[k * 4 + 2] = this.rew[k] * 255;
      fx[k * 4 + 3] = Math.max(this.wgt[k], Math.min(1, this.pix[k]), this.rot[k]) * 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.pvTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bw, this.bh, gl.RG, gl.FLOAT, this.pv);
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bw, this.bh, gl.RGBA, gl.UNSIGNED_BYTE, fx);
    const P = this.prog.paint, next = 1 - this.pcur;
    this.draw(P, this.ppic[next].fb, this.w, this.h);
    this.bind2d(0, this.pic[this.cur].t, P.u.uSrc);
    this.bind2d(1, this.ppic[this.pcur].t, P.u.uPrev);
    this.bind2d(2, this.fxTex, P.u.uFx);
    this.bind2d(3, this.pvTex, P.u.uPv);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.pcur = next;
  }

  // ---------- paint tools (same API as the background field; client coordinates) ----------
  local(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const s = Math.min(r.width / this.w, r.height / this.h) || 1;   // object-fit: contain
    return [(x - r.left - (r.width - this.w * s) / 2) / s, (y - r.top - (r.height - this.h * s) / 2) / s, s];
  }
  each(x, y, r, fn) {
    const [ix, iy, s] = this.local(x, y), ir = Math.max(8, r / s);
    const i0 = Math.max(0, Math.floor((ix - ir) / 8)), i1 = Math.min(this.bw - 1, Math.floor((ix + ir) / 8));
    const j0 = Math.max(0, Math.floor((iy - ir) / 8)), j1 = Math.min(this.bh - 1, Math.floor((iy + ir) / 8));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * 8 - ix, dy = (j + 0.5) * 8 - iy, d = Math.hypot(dx, dy);
      if (d < ir) { const t = 1 - d / ir; fn(j * this.bw + i, dx, dy, d, t * t * (3 - 2 * t)); }
    }
  }
  addVec(k, vx, vy, mix = 0) {
    let x = this.pv[k * 2] * (1 - mix) + vx, y = this.pv[k * 2 + 1] * (1 - mix) + vy;
    const l = Math.hypot(x, y);
    if (l > MAX_V) { x *= MAX_V / l; y *= MAX_V / l; }
    this.pv[k * 2] = x; this.pv[k * 2 + 1] = y;
  }
  mark(k, w) { this.wgt[k] = Math.min(1, Math.max(this.wgt[k], w)); }

  smear(x, y, dx, dy, r) {
    if (!this.ok) return;
    const s = this.local(x, y)[2], vx = (dx / s) * 0.6, vy = (dy / s) * 0.6;
    this.each(x, y, r, (k, _a, _b, _c, w) => { this.addVec(k, vx * w, vy * w); this.mark(k, w); });
  }
  swirl(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, dx, dy, d, w) => {
      if (d < 0.01) return;
      const s = 3 * w;
      this.addVec(k, (-dy / d) * s - (dx / d) * 0.3 * w, (dx / d) * s - (dy / d) * 0.3 * w, 0.35);
      this.mark(k, w);
    });
  }
  melt(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _a, _b, _c, w) => { this.addVec(k, (Math.random() - 0.5) * 0.8 * w, 3 * w, 0.3); this.mark(k, w); });
  }
  explode(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r * 2.2, (k, dx, dy, d, w) => {
      const s = (6 + Math.random() * 4) * (0.3 + w);
      this.addVec(k, d ? (dx / d) * s : 0, d ? (dy / d) * s : 0, 1);
      this.mark(k, 1);
    });
    this.shock(x, y, 0.6);
  }
  shatter(x, y, r) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _a, _b, _c, w) => {
      this.mark(k, w);
      if (Math.hypot(this.pv[k * 2], this.pv[k * 2 + 1]) > 1) return;
      const a = Math.random() * Math.PI * 2, s = (2 + Math.random() * 4) * w;
      this.addVec(k, Math.cos(a) * s, Math.sin(a) * s, 1);
    });
  }
  pixelate(x, y, r, dt) { if (this.ok) this.each(x, y, r, (k, _a, _b, _c, w) => { this.pix[k] = Math.min(3.2, this.pix[k] + dt * 1.6 * w); this.mark(k, w * 0.5); }); }
  colorRot(x, y, r, dt) { if (this.ok) this.each(x, y, r, (k, _a, _b, _c, w) => { this.rot[k] = Math.min(1, this.rot[k] + dt * 3 * w); this.mark(k, w * 0.5); }); }
  rewind(x, y, r, dt) {
    if (!this.ok) return;
    this.each(x, y, r, (k, _a, _b, _c, w) => {
      this.rew[k] = Math.min(1, this.rew[k] + dt * 6 * w);
      this.pv[k * 2] *= 0.6; this.pv[k * 2 + 1] *= 0.6; this.pix[k] = 0; this.rot[k] = 0;
      this.wgt[k] = Math.max(0, this.wgt[k] - dt * 4 * w);
    });
  }
  stamp(src, x, y, size) {
    if (!this.ok || !src) return;
    const gl = this.gl, sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    if (!sw || !sh) return;
    if (!this.stampTex) this.stampTex = this.texRaw(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const [ix, iy, s] = this.local(x, y), half = size / s / 2;
    const hw = sw >= sh ? half : (half * sw) / sh, hh = sw >= sh ? (half * sh) / sw : half;
    const P = this.prog.copy, cx = v => (v / this.w) * 2 - 1, cy = v => (v / this.h) * 2 - 1;
    this.draw(P, this.ppic[this.pcur].fb, this.w, this.h);
    gl.uniform4f(P.u.uRect, cx(ix - hw), cy(iy - hh), cx(ix + hw), cy(iy + hh));
    this.bind2d(0, this.stampTex, P.u.uTex);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    for (let j = Math.max(0, Math.floor((iy - hh) / 8)); j <= Math.min(this.bh - 1, Math.floor((iy + hh) / 8)); j++)
      for (let i = Math.max(0, Math.floor((ix - hw) / 8)); i <= Math.min(this.bw - 1, Math.floor((ix + hw) / 8)); i++) this.mark(j * this.bw + i, 1);
  }
  wipe(dx, dy) {
    if (!this.ok) return;
    const l = Math.hypot(dx, dy) || 1;
    this.wipeState = { t: 0, vx: (dx / l) * 9, vy: (dy / l) * 9 };
  }
  shock(x, y, power = 1) {
    if (!this.ok) return;
    const [ix, iy] = this.local(x, y);
    this.shocks.push({ x: ix, y: iy, t: 0, power });
  }
  snapshot() {
    if (!this.ok) return null;
    const gl = this.gl, px = new Uint8Array(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppic[this.pcur].fb);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w: this.w, h: this.h, px, pv: this.pv.slice(), wgt: this.wgt.slice(), pix: this.pix.slice(), rot: this.rot.slice() };
  }
  restore(s) {
    if (!this.ok || !s || s.w !== this.w || s.h !== this.h) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.ppic[this.pcur].t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, s.px);
    this.pv.set(s.pv); this.wgt.set(s.wgt); this.pix.set(s.pix); this.rot.set(s.rot); this.rew.fill(0);
    this.wipeState = null; this.shocks = [];
    return true;
  }

  // state: { src: "A" | "B", idx: frame number, mosh, bloom }
  render(s, dt) {
    const A = this.arrays[s.src];
    if (!A) return;
    const idx = Math.max(0, Math.min(A.n - 1, s.idx | 0));
    const changed = s.src !== this.last.src || idx !== this.last.idx;
    const feedback = !!(s.mosh || s.bloom);
    let tick = changed;
    if (s.bloom && !changed) {                     // BLOOM keeps re-applying at the frame rate, even paused
      this.bloomAcc += dt * 24;
      if (this.bloomAcc >= 1) { this.bloomAcc %= 1; tick = true; }
    } else this.bloomAcc = 0;
    if (!feedback && this.last.feedback) tick = true;   // let go: a clean keyframe arrives
    if (tick) {
      const same = s.src === this.last.src && this.last.idx >= 0;
      if (!s.bloom && changed) { if (same) this.motion(A.t, idx, this.last.idx); else this.zeroVec(); }
      this.step(A.t, idx, same ? this.last.idx : idx, feedback, same && !s.bloom ? RESID : 0);
      this.last = { src: s.src, idx, feedback };
    }
    this.paintFrame(dt);
    this.present(this.ppic[this.pcur].t);
  }
}
