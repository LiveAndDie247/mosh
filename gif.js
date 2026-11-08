// GifCities in MOSH: the Internet Archive's GeoCities GIFs as clip material, curated into VIBES.
// GifCities' search has no CORS (the browser can't call it), but the GIF files themselves do
// (blob.gifcities.org sends Access-Control-Allow-Origin: *). So tools/gifcities-pull.mjs builds
// an index (clips/gifcities/manifest.json: id, size, frames, vibe, queries, source page) that the
// app browses locally, and each GIF is fetched live from the archive when you pick it.

const INDEX_URL = "clips/gifcities/manifest.json";
let index = null;

// Prepare a GIF for moshing: 4x upscale with nearest-neighbour (crisp pixels, capped at 960 px
// wide), looped to `seconds` (animated GIFs repeat; one-shot GIFs hold their last frame),
// 30 fps, H.264 MP4. Shared with tools/test-gif.mjs.
export function gifArgs(inp, out, seconds = 2) {
  return [
    "-ignore_loop", "0", "-i", inp, "-t", String(seconds), "-an",
    "-vf", `tpad=stop_mode=clone:stop_duration=${seconds},scale='min(iw*4,960)':-2:flags=neighbor,fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", out,
  ];
}

export async function loadIndex() {
  if (index) return index;
  const res = await fetch(INDEX_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`couldn't load the GifCities index (HTTP ${res.status})`);
  index = await res.json();
  index.vibes ||= [];
  for (const g of index.gifs) g.hay = `${g.v || ""} ${g.t.join(" ")} ${g.src}`.toLowerCase();
  return index;
}

export const vibes = () => index?.vibes || [];
export const gifURL = g => `${index?.gifBase || "https://blob.gifcities.org/gifcities/"}${g.id}.gif`;

// GIFs in a vibe ("" = all) matching all words of the query. Always shuffled, so every visit
// shows something new.
export function searchGifs(q, vibe = "") {
  if (!index) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = index.gifs.filter(g => (!vibe || g.v === vibe) && words.every(w => g.hay.includes(w)));
  return shuffle(hits);
}

// The GIFs to draw from: one vibe ("" = all); with `minFrames`, prefer the ones with at least
// that many frames (ones that actually move), unless that leaves fewer than 3.
export function gifPool(vibe = "", minFrames = 0) {
  let all = (index?.gifs || []).filter(g => !vibe || g.v === vibe);
  if (minFrames > 0) { const moving = all.filter(g => (g.f || 0) >= minFrames); if (moving.length >= 3) all = moving; }
  return all;
}

// A random GIF, from one vibe if given; `except` is never returned
export function randomGif(except = null, vibe = "", minFrames = 0) {
  const all = gifPool(vibe, minFrames);
  if (!all.length) return null;
  for (let i = 0; i < 20; i++) { const g = all[(Math.random() * all.length) | 0]; if (g !== except) return g; }
  return all[0];
}

// n distinct random GIFs from a pool: a shuffled copy, so there is never a loop hunting for new ones
export function shuffledGifs(vibe = "", minFrames = 0) {
  return shuffle(gifPool(vibe, minFrames).slice());
}

export function randomVibe() {
  const v = vibes();
  return v.length ? v[(Math.random() * v.length) | 0] : "";
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Fetch the GIF from the archive and turn it into a short MP4 clip (a File) with ffmpeg.wasm
export async function prepareGif(ffmpeg, g) {
  const res = await fetch(gifURL(g));
  if (!res.ok) throw new Error(`couldn't fetch the GIF (HTTP ${res.status})`);
  await ffmpeg.writeFile("gc.gif", new Uint8Array(await res.arrayBuffer()));
  const ret = await ffmpeg.exec(gifArgs("gc.gif", "gc.mp4"));
  try { await ffmpeg.deleteFile("gc.gif"); } catch {}
  if (ret !== 0) throw new Error("couldn't convert the GIF (see LOG)");
  const data = await ffmpeg.readFile("gc.mp4");
  try { await ffmpeg.deleteFile("gc.mp4"); } catch {}
  return new File([data], `gifcities-${g.id}.mp4`, { type: "video/mp4" });
}

// The full-screen sheet: vibe chips, a search box, then a 3-column grid of animated GIFs.
// Tap one: onPick(slot, gif), and the sheet closes.
export class GifSheet {
  constructor(onPick) {
    this.onPick = onPick;
    this.vibe = "";
    const el = (this.el = document.createElement("div"));
    el.className = "gsheet";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "GifCities");
    el.innerHTML = `
      <div class="gsheet-head">
        <div class="gbar">
          <input type="search" class="gsearch" placeholder="search GifCities…" enterkeyhint="search" autocomplete="off">
          <button class="gshuffle" aria-label="Shuffle">↻</button>
          <button class="gclose" aria-label="Close">✕</button>
        </div>
        <div class="gvibes"></div>
      </div>
      <p class="gnote"></p>
      <div class="ggrid"></div>
      <button class="gmore" hidden>MORE</button>
      <p class="gcredit">GIFs from <a href="https://gifcities.org" target="_blank" rel="noopener">GifCities</a>, the Internet Archive's GeoCities GIF search.</p>`;
    document.body.append(el);
    this.input = el.querySelector(".gsearch");
    this.grid = el.querySelector(".ggrid");
    this.note = el.querySelector(".gnote");
    this.more = el.querySelector(".gmore");
    this.chips = el.querySelector(".gvibes");
    el.querySelector(".gclose").addEventListener("click", () => this.close());
    el.querySelector(".gshuffle").addEventListener("click", () => this.render());
    let t = 0;
    this.input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this.render(), 200); });
    this.more.addEventListener("click", () => this.page());
    addEventListener("keydown", e => { if (e.key === "Escape" && !this.el.hidden) this.close(); });
  }

  async open(slot) {
    this.slot = slot;
    this.el.hidden = false;
    document.body.classList.add("sheet-open");
    this.note.textContent = "Loading the index…";
    try {
      const idx = await loadIndex();
      this.note.textContent = "";
      this.input.placeholder = `search ${idx.count.toLocaleString()} GIFs…`;
      if (!this.chips.childElementCount) this.buildChips(idx);
      if (!this.results) this.render();
    } catch (e) {
      this.note.textContent = e.message || String(e);
    }
  }

  buildChips(idx) {
    for (const v of ["", ...idx.vibes]) {
      const b = document.createElement("button");
      b.textContent = v || "all";
      b.dataset.vibe = v;
      b.addEventListener("click", () => { this.vibe = v; this.render(); });
      this.chips.append(b);
    }
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove("sheet-open");
  }

  render() {
    for (const b of this.chips.children) b.classList.toggle("on", b.dataset.vibe === this.vibe);
    const q = this.input.value.trim();
    this.results = searchGifs(q, this.vibe);
    this.shown = 0;
    this.grid.replaceChildren();
    this.el.scrollTop = 0;
    this.note.textContent = q ? `${this.results.length} GIFs` : "";
    if (!this.results.length) this.note.textContent = q ? `Nothing for "${q}" here. Try another vibe, or a word like moon, eye, statue…` : "Nothing here yet.";
    this.page();
  }

  page() {
    const next = this.results.slice(this.shown, this.shown + 48);
    for (const g of next) {
      const b = document.createElement("button");
      b.className = "gcell";
      b.title = `${g.v ? g.v + ": " : ""}${g.t.join(", ")}`;
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = g.t[0];
      img.src = gifURL(g);
      img.onerror = () => b.remove();                        // gone from the archive: drop it
      b.append(img);
      b.addEventListener("click", () => { this.close(); this.onPick(this.slot, g); });
      this.grid.append(b);
    }
    this.shown += next.length;
    this.more.hidden = this.shown >= this.results.length;
  }
}
