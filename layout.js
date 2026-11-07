// The device layout: the whole app is one 1600x900 landscape rectangle, scaled to fit the
// screen (never scrolling). In portrait it either asks you to rotate the phone (default) or
// turns the rectangle 90° to fill the screen; that's a setting, kept in localStorage.
export const DESIGN_W = 1600, DESIGN_H = 900;
const KEY = "mosh.portrait";             // "ask" | "rotate"

export class Layout {
  constructor({ device, rotate, toggle, anyway, onFit }) {
    this.device = device; this.rotate = rotate; this.toggle = toggle; this.onFit = onFit;
    this.mode = localStorage.getItem(KEY) === "rotate" ? "rotate" : "ask";
    toggle.addEventListener("click", () => this.setMode(this.mode === "ask" ? "rotate" : "ask"));
    anyway.addEventListener("click", () => this.setMode("rotate"));
    const fit = () => this.fit();
    addEventListener("resize", fit);
    addEventListener("orientationchange", () => setTimeout(fit, 150));
    visualViewport?.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", () => setTimeout(fit, 100));
    this.fit();
  }

  setMode(m) {
    this.mode = m;
    localStorage.setItem(KEY, m);
    this.fit();
  }

  fit() {
    const W = visualViewport?.width || innerWidth, H = visualViewport?.height || innerHeight;
    const portrait = H > W;
    this.toggle.textContent = `PORTRAIT: ${this.mode === "ask" ? "ASK TO ROTATE" : "TURN SIDEWAYS"}`;
    if (portrait && this.mode === "ask") {
      this.rotate.hidden = false;
      this.device.style.visibility = "hidden";
      return;
    }
    this.rotate.hidden = true;
    this.device.style.visibility = "";
    const turned = portrait;                       // portrait + "rotate": the device lies on its side
    const s = turned ? Math.min(W / DESIGN_H, H / DESIGN_W) : Math.min(W / DESIGN_W, H / DESIGN_H);
    this.device.style.transform = `${turned ? "rotate(90deg) " : ""}scale(${s})`;
    const key = `${W}x${H}${turned}`;
    if (key !== this.lastKey) { this.lastKey = key; this.scale = s; this.onFit?.(s, turned); }
  }
}
