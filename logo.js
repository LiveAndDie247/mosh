// The MOSH logo: plain Times New Roman bold, really datamoshed. The text is drawn to a canvas,
// cut into 8x8 macroblocks, and each block copies its pixels from where its motion vector points
// back to, frame after frame, so blocks drag and leave smear trails; the trails' pixels drift
// purple or green. Idle: it melts, then a "keyframe" redraws it clean, every few seconds.
// burst(): a hard mosh in a direction (MOSH taps). hold(true): keeps melting, never heals.

const W = 480, H = 144, B = 8, BW = W / B, BH = H / B;
const IDLE = 5.0;              // seconds between keyframes
const CLEAN_FOR = 0.6;         // how long it stays clean after a keyframe

export class Logo {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.vx = new Float32Array(BW * BH);
    this.vy = new Float32Array(BW * BH);
    this.imgData = this.ctx.createImageData(W, H);
    this.work = new Uint32Array(this.imgData.data.buffer);
    this.next = new Uint32Array(W * H);
    this.held = false;
    this.t = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.clean = this.drawClean();
    this.keyframe();
    this.paint();
    document.fonts?.ready?.then(() => { this.clean = this.drawClean(); this.keyframe(); this.paint(); });
    this.raf = 0;
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  drawClean() {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#fff";
    g.font = 'bold 124px "Times New Roman", Times, serif';
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillText("MOSH", W / 2, H - 24);
    return new Uint32Array(g.getImageData(0, 0, W, H).data.buffer.slice(0));
  }

  keyframe() { this.work.set(this.clean); this.vx.fill(0); this.vy.fill(0); }
  paint() { this.ctx.putImageData(this.imgData, 0, 0); }

  start() {
    if (this.raf || this.reduced) return;
    let last = performance.now();
    const loop = now => {
      this.raf = requestAnimationFrame(loop);
      const dt = (now - last) / 1000;
      if (dt < 1 / 30) return;                         // 30 fps is plenty for the logo
      last = now;
      this.step(Math.min(dt, 0.1));
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  step(dt) {
    this.t += dt;
    if (!this.held && this.t > IDLE) { this.t = 0; this.keyframe(); }   // a new keyframe arrives
    if (this.held || this.t > CLEAN_FOR) {                              // melting
      const p = this.held ? 0.14 : 0.05, s = this.held ? 1.3 : 0.55;
      for (let k = 0; k < BW * BH; k++) {
        if (Math.random() < p) { this.vy[k] += Math.random() * s; this.vx[k] += (Math.random() - 0.5) * s * 0.5; }
      }
    }
    this.advect();
    for (let k = 0; k < BW * BH; k++) { this.vx[k] *= 0.9; this.vy[k] *= 0.9; }
    this.paint();
  }

  // A hard mosh: blocks jump in the direction of (dx, dy)
  burst(dx, dy) {
    const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    for (let k = 0; k < BW * BH; k++) {
      if (Math.random() < 0.75) {
        const s = 3 + Math.random() * 7;
        this.vx[k] += ux * s + (Math.random() - 0.5) * 2;
        this.vy[k] += uy * s + (Math.random() - 0.5) * 2;
      }
    }
    this.t = Math.max(this.t, CLEAN_FOR);
    this.advect(); this.advect();
    this.paint();
  }

  hold(on) {
    this.held = on;
    if (!on) this.t = Math.min(this.t, IDLE - 1.5);      // let go: it re-forms soon after
  }

  // Each block copies its pixels from (x - v); moved pixels drift purple or green
  advect() {
    const src = this.work, dst = this.next;
    dst.set(src);
    for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
      const k = by * BW + bx, vx = this.vx[k], vy = this.vy[k];
      const m = Math.abs(vx) + Math.abs(vy);
      if (m < 0.15) continue;
      const ox = Math.round(vx), oy = Math.round(vy);
      const tint = Math.min(26, m * 5) | 0, purple = (bx + by) & 1;
      for (let yy = 0; yy < B; yy++) {
        const y = by * B + yy, sy = Math.min(H - 1, Math.max(0, y - oy));
        for (let xx = 0; xx < B; xx++) {
          const x = bx * B + xx, sx = Math.min(W - 1, Math.max(0, x - ox));
          let px = src[sy * W + sx];
          const a = px >>> 24;
          if (a > 16 && tint) {
            let r = px & 255, g = (px >>> 8) & 255, b = (px >>> 16) & 255;
            if (purple) { r += tint; b += tint; g -= tint; } else { g += tint; r -= tint; b -= tint; }
            r = r < 0 ? 0 : r > 255 ? 255 : r;
            g = g < 0 ? 0 : g > 255 ? 255 : g;
            b = b < 0 ? 0 : b > 255 ? 255 : b;
            px = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
          }
          dst[y * W + x] = px;
        }
      }
    }
    src.set(dst);
  }
}
