// The live mosh engine (WebGL2). Every pre-decoded frame of the clip sits on the GPU in a
// texture array. Each time the shown frame changes:
//   1. MOTION: block matching finds, for every 8x8 block, where it came from in the previous
//      frame (±8 px): the motion vectors a codec would have stored for a P-frame.
//   2. PICTURE: normally the new frame is shown as is (a keyframe every frame). While MOSH is
//      held, the new frame is NOT shown: the held picture is pushed along the motion vectors
//      instead, plus the P-frame "residual", which is exactly what I-frame removal does. BLOOM
//      freezes the vectors so the same motion keeps re-applying and the smear grows. MELT adds
//      a downward drift to every vector, so the picture slides and drips.
//   3. FX on the way to the screen (and into REC): a COLOR mode (red/black, mono, heat, …) and
//      GLITCH layers (RGB split, macroblock corruption, pixelate, tear, mirror, motion-vector
//      view, strobe), all scaled by one AMOUNT.
// Let go of MOSH and the next frame arrives clean, like a new I-frame.

const RESID = 0.55;              // how much of the P-frame residual gets added while moshing
const ENC = 128 / 255;           // vector encoding: 0.5 in an 8-bit texture = no motion

export const COLORS = ["NORMAL", "RED", "MONO", "CYAN", "ACID", "HEAT", "VAPOR", "INVERT", "POSTER", "1-BIT"];
export const GLITCHES = ["RGB", "BLOCKS", "PIXEL", "TEAR", "MIRROR", "VECTORS", "MELT", "STROBE"];

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
uniform float uCur, uPrev, uMosh, uResid, uMelt, uTime;
uniform vec2 uRes;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 clean = texture(uF, vec3(p / uRes, uCur)).rgb;
  if (uMosh < 0.5) { o = vec4(clean, 1.0); return; }
  ivec2 cell = ivec2(floor(p / 8.0));
  vec2 v = (texelFetch(uVec, cell, 0).xy - ${ENC.toFixed(6)}) * 32.0;
  // MELT: everything drips down (rows are stored top first, so +y is down), each column of
  // blocks at its own speed, with a little sideways wobble
  float col = hash(vec2(float(cell.x), 7.0));
  v += uMelt * vec2(sin(p.y * 0.04 + uTime * 3.0 + col * 6.0) * 0.8, 1.0 + col * 2.5);
  vec3 c = texture(uPic, (p - v) / uRes).rgb;
  // The P-frame residual: what the encoder adds on top of the motion
  c += (clean - texture(uF, vec3((p - v) / uRes, uPrev)).rgb) * uResid;
  // Chroma drift along the trails: purple or green per block
  float side = hash(vec2(cell)) > 0.5 ? 1.0 : -1.0;
  c += side * clamp(length(v) / 8.0, 0.0, 1.0) * 0.04 * vec3(0.55, -0.75, 0.55);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// To the screen. Picture textures are stored top row first, so flip on the way out.
const SHOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPic, uVec;
uniform vec2 uRes;
uniform float uTime, uAmt, uColor, uFlash;
uniform float uRGB, uBlock, uPix, uTear, uMirror, uVecs;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 pic(vec2 uv) { return texture(uPic, clamp(uv, 0.0, 1.0)).rgb; }
vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
float bayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float a = uAmt;
  float tq = floor(uTime * 12.0);                       // glitches re-roll 12 times a second
  if (uMirror > 0.5) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  if (uTear > 0.5) {                                    // horizontal tearing bands
    float band = floor(uv.y * uRes.y / (3.0 + 10.0 * hash(vec2(tq, 3.0))));
    float r = hash(vec2(band, tq));
    if (r < 0.25 + 0.5 * a) uv.x += (hash(vec2(band, tq + 1.0)) - 0.5) * 0.25 * a * step(0.55, r * 2.0);
    uv.x += sin(uv.y * 40.0 + uTime * 9.0) * 0.003 * a;
  }
  vec2 cell = floor(uv * uRes / 16.0);
  bool hit = false;
  if (uBlock > 0.5) {                                   // corrupted macroblocks: wrong place, wrong colour
    float r = hash(cell + tq * 0.37);
    if (r < 0.06 + 0.3 * a) {
      hit = true;
      vec2 jump = floor((vec2(hash(cell + tq), hash(cell - tq)) - 0.5) * 6.0) * 16.0 / uRes;
      uv = (cell * 16.0 + 8.0) / uRes + jump + (fract(uv * uRes / 16.0) - 0.5) * 16.0 / uRes;
    }
  }
  if (uPix > 0.5) {
    float ps = 3.0 + 13.0 * a;
    uv = (floor(uv * uRes / ps) + 0.5) * ps / uRes;
  }
  vec3 c;
  if (uRGB > 0.5) {
    float off = (0.004 + 0.025 * a) * (1.0 + 0.5 * sin(uTime * 7.0));
    c = vec3(pic(uv + vec2(off, 0.0)).r, pic(uv).g, pic(uv - vec2(off, off * 0.3)).b);
  } else c = pic(uv);
  if (hit && hash(cell + tq + 9.0) > 0.5) c = c.brg;    // some broken blocks swap channels too
  if (uVecs > 0.5) {                                    // the motion vectors the mosh rides on
    vec2 v = (texture(uVec, uv).xy - ${ENC.toFixed(6)}) * 32.0;
    float m = clamp(length(v) / 6.0, 0.0, 1.0);
    vec2 inb = fract(uv * uRes / 8.0) - 0.5;
    float edge = step(0.42, max(abs(inb.x), abs(inb.y)));
    c = mix(c, hue(atan(v.y, v.x) / 6.2832 + 0.5), m * (0.55 + 0.4 * a));
    c = mix(c, vec3(0.0), edge * 0.35 * (0.3 + m));
  }
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  int k = int(uColor + 0.5);
  if (k == 1) c = vec3(1.0, 0.06, 0.1) * smoothstep(0.08, 0.9, l) + vec3(0.25) * smoothstep(0.85, 1.0, l);
  else if (k == 2) c = vec3(smoothstep(0.1, 0.9, l));
  else if (k == 3) c = vec3(0.1, 0.95, 1.0) * smoothstep(0.08, 0.9, l);
  else if (k == 4) c = mix(vec3(0.0, 0.04, 0.0), vec3(0.55, 1.0, 0.1), smoothstep(0.1, 0.85, l));
  else if (k == 5) c = l < 0.25 ? mix(vec3(0.0), vec3(0.15, 0.0, 0.6), l / 0.25)
                 : l < 0.5 ? mix(vec3(0.15, 0.0, 0.6), vec3(0.9, 0.0, 0.4), (l - 0.25) / 0.25)
                 : l < 0.75 ? mix(vec3(0.9, 0.0, 0.4), vec3(1.0, 0.65, 0.0), (l - 0.5) / 0.25)
                 : mix(vec3(1.0, 0.65, 0.0), vec3(1.0, 1.0, 0.85), (l - 0.75) / 0.25);
  else if (k == 6) c = mix(vec3(0.17, 0.0, 0.35), vec3(1.0, 0.45, 0.85), l) + vec3(0.0, 0.5, 0.5) * smoothstep(0.75, 1.0, l);
  else if (k == 7) c = 1.0 - c;
  else if (k == 8) c = floor(c * 3.99) / 3.0;
  else if (k == 9) c = vec3(step(bayer(gl_FragCoord.xy), l));
  if (uFlash > 0.5) c = 1.0 - c;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function program(gl, fs) {
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

export class LiveEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.prog = { motion: program(gl, MOTION_FS), mosh: program(gl, MOSH_FS), show: program(gl, SHOW_FS) };
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.arrays = {};
    this.last = { src: null, idx: -1, feedback: false };
    this.bloomAcc = 0;
    this.time = 0;
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

  // Free everything from a previous load (a new mosh replaces the old one)
  release() {
    const gl = this.gl;
    for (const a of Object.values(this.arrays)) gl.deleteTexture(a.t);
    this.arrays = {};
    for (const x of [...(this.pic || []), this.vec]) if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.fb); }
    this.pic = this.vec = null;
    this.last = { src: null, idx: -1, feedback: false };
  }

  // clips: { M } (or any keys) each { w, h, n, frames: Uint8Array (n frames of RGBA, top row first) }
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

  step(arr, cur, prev, mosh, resid, melt) {
    const gl = this.gl, P = this.prog.mosh, next = 1 - this.cur;
    this.draw(P, this.pic[next].fb, this.w, this.h);
    this.bind2d(0, this.pic[this.cur].t, P.u.uPic);
    this.bind2d(1, this.vec.t, P.u.uVec);
    this.bindArray(2, arr, P.u.uF);
    gl.uniform1f(P.u.uCur, cur); gl.uniform1f(P.u.uPrev, prev);
    gl.uniform1f(P.u.uMosh, mosh ? 1 : 0); gl.uniform1f(P.u.uResid, resid);
    gl.uniform1f(P.u.uMelt, melt); gl.uniform1f(P.u.uTime, this.time);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = next;
  }

  // fx: { color: index into COLORS, amount 0..1, flash, and a flag per GLITCHES name (lower case) }
  present(tex, fx = {}) {
    const gl = this.gl, P = this.prog.show, u = P.u;
    this.draw(P, null, this.canvas.width, this.canvas.height);
    this.bind2d(0, tex, u.uPic);
    this.bind2d(1, this.vec.t, u.uVec);
    gl.uniform2f(u.uRes, this.w, this.h);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uAmt, fx.amount ?? 0.5);
    gl.uniform1f(u.uColor, fx.color || 0);
    gl.uniform1f(u.uFlash, fx.flash ? 1 : 0);
    gl.uniform1f(u.uRGB, fx.rgb ? 1 : 0);
    gl.uniform1f(u.uBlock, fx.blocks ? 1 : 0);
    gl.uniform1f(u.uPix, fx.pixel ? 1 : 0);
    gl.uniform1f(u.uTear, fx.tear ? 1 : 0);
    gl.uniform1f(u.uMirror, fx.mirror ? 1 : 0);
    gl.uniform1f(u.uVecs, fx.vectors ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // state: { src, idx: frame number, mosh, bloom, fx }
  render(s, dt) {
    const A = this.arrays[s.src];
    if (!A) return;
    this.time += dt;
    const fx = s.fx || {};
    const melt = fx.melt ? 0.5 + 2 * (fx.amount ?? 0.5) : 0;
    const idx = Math.max(0, Math.min(A.n - 1, s.idx | 0));
    const changed = s.src !== this.last.src || idx !== this.last.idx;
    const feedback = !!(s.mosh || s.bloom || melt);
    let tick = changed;
    if ((s.bloom || melt) && !changed) {           // BLOOM / MELT keep re-applying at the frame rate, even paused
      this.bloomAcc += dt * 24;
      if (this.bloomAcc >= 1) { this.bloomAcc %= 1; tick = true; }
    } else this.bloomAcc = 0;
    if (!feedback && this.last.feedback) tick = true;   // let go: a clean keyframe arrives
    if (tick) {
      const same = s.src === this.last.src && this.last.idx >= 0;
      if (!s.bloom && changed) { if (same) this.motion(A.t, idx, this.last.idx); else this.zeroVec(); }
      this.step(A.t, idx, same ? this.last.idx : idx, feedback, same && !s.bloom ? RESID : 0, melt);
      this.last = { src: s.src, idx, feedback };
    }
    this.present(this.pic[this.cur].t, fx);
  }
}
