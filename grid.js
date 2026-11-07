// The liveanddie.xyz background layer, ported from the site's own #bg drawing code (same colours,
// timing and geometry): a red perspective grid running to a horizon with lines scrolling
// toward you, a spinning blue wireframe cube above the horizon, a faint red flash every 40
// frames, and a dark vignette. Drawn on a transparent canvas, so MOSH's mosh field (dim) shows
// underneath where the site has its tiled video loops.
export class Grid {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.frame = 0;
    const size = () => { this.W = canvas.width = innerWidth; this.H = canvas.height = innerHeight; };
    addEventListener("resize", size);
    size();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.draw();
    if (!still) this.timer = setInterval(() => { if (!document.hidden) this.draw(); }, 66);   // the site's 66 ms
  }

  draw() {
    const { g, W, H } = this;
    const frame = ++this.frame;
    g.clearRect(0, 0, W, H);
    // the grid: rgba(255,0,0,.4), 1px, horizon at 55%, vanishing point drifting sideways
    g.strokeStyle = "rgba(255,0,0,.4)"; g.lineWidth = 1;
    const hz = H * 0.55, vx = W / 2 + Math.sin(frame / 90) * W * 0.08;
    g.beginPath();
    for (let i = -12; i <= 12; i++) {
      const x0 = vx + i * W * 0.09;
      g.moveTo(vx, hz); g.lineTo(x0 + (x0 - vx) * 3, H);
      g.moveTo(vx, hz); g.lineTo(x0 + (x0 - vx) * 3, 0);
    }
    for (let n = 0; n < 14; n++) {
      const yy = hz + Math.pow(n / 14, 2.2) * (H - hz) + (frame * 1.2) % ((H - hz) / 14);
      if (yy < H) { g.moveTo(0, yy); g.lineTo(W, yy); }
    }
    g.moveTo(0, hz); g.lineTo(W, hz);
    g.stroke();
    // the cube: rgba(60,60,255,.8)
    g.strokeStyle = "rgba(60,60,255,.8)";
    const a = frame / 70, b = frame / 110, s = Math.min(W, H) * 0.09, cxp = W * 0.5, cyp = hz - s * 1.6;
    const P = [];
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? 1 : -1, y = i & 2 ? 1 : -1, z = i & 4 ? 1 : -1;
      const x1 = x * Math.cos(a) - z * Math.sin(a);
      let z1 = x * Math.sin(a) + z * Math.cos(a);
      const y1 = y * Math.cos(b) - z1 * Math.sin(b);
      z1 = y * Math.sin(b) + z1 * Math.cos(b);
      const f = 2.6 / (3.6 + z1);
      P.push([cxp + x1 * s * f, cyp + y1 * s * f]);
    }
    g.beginPath();
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const d = i ^ j;
      if (d === 1 || d === 2 || d === 4) { g.moveTo(P[i][0], P[i][1]); g.lineTo(P[j][0], P[j][1]); }
    }
    g.stroke();
    // the flash: every 40 frames, rgba(255,0,0,.12) for 2 frames
    if (frame % 40 < 2) { g.fillStyle = "rgba(255,0,0,.12)"; g.fillRect(0, 0, W, H); }
    // the vignette
    const gr = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.9);
    gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,.88)");
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
}
