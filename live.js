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
  setClips(clips) {
    const gl = this.gl, any = clips.A || clips.B;
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

  present() {
    const gl = this.gl, P = this.prog.show;
    this.draw(P, null, this.canvas.width, this.canvas.height);
    this.bind2d(0, this.pic[this.cur].t, P.u.uPic);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    this.present();
  }
}
