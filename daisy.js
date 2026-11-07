// DAISY CHAIN MODE: a drawer along the bottom of the device.
//   BANK  : every finished mosh / link / chain (bank.js). Tap: preview it + actions (→ A, → B,
//           → PAD, + CHAIN). Long-press: delete.
//   CHAIN : link 1 → link 2 → …, with a JOIN chip between every two links (tap: MOSH → BLOOM →
//           SOUP → CUT; hold a BLOOM chip: its count). Drag a link sideways to reorder, swipe it
//           up to remove. "+ NEW LINK": a fresh mosh of two random GifCities clips.
//   GROW  : the last frame of the chain's final link becomes the new clip A, a random clip B
//           (GifCities or the bank) drags it, and the result is appended: each link grows out of
//           the one before. GROW xN does it N times, then renders the chain.
//   LOOP, KEEP COLOR, FRESH BLOOD; RENDER CHAIN (360 px) and MASTER (every link re-moshed from
//   its sources at 480 px). Every rendered chain goes into the bank, so it can be a link too.
import { chainEncodeArgs, chainStarts, decodeArgs, keepColorVf, targetSize, FPS } from "./pipeline.js";
import { moshChain } from "./mosh.js";
import { buildChainAudio } from "./wav.js";

const JOINS = ["mosh", "bloom", "soup", "cut"];
const BLOOM_COUNTS = [4, 8, 16, 30];
const LINK_W = 360, MASTER_W = 480, MAX_CHAIN_S = 60;
const KEY = "mosh.daisy";

export class Daisy {
  constructor(root, o) {
    this.root = root; this.o = o;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    this.chain = Array.isArray(saved.chain) ? saved.chain : [];        // [{ id, join, count }]
    this.loop = !!saved.loop; this.keep = saved.keep ?? 40; this.fresh = saved.fresh ?? 20; this.n = saved.n ?? 10;
    this.items = []; this.urls = new Map(); this.sel = null; this.stop = false; this.running = false;
    this.build();
    this.refreshBank();
  }

  save() { localStorage.setItem(KEY, JSON.stringify({ chain: this.chain, loop: this.loop, keep: this.keep, fresh: this.fresh, n: this.n })); }
  toggle(open = this.root.hidden) { this.root.hidden = !open; }
  readout(t) { this.read.textContent = t; }

  // ---------- UI ----------
  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="dz-head"><h2 class="ph"><span>05</span> DAISY CHAIN</h2><span class="dz-read"></span><button class="dz-close" aria-label="Close">✕</button></div>
      <div class="dz-body">
        <div class="dz-left">
          <div class="dz-row"><div class="dz-lab">BANK</div><div class="dz-shelf"></div></div>
          <div class="dz-row"><div class="dz-lab">CHAIN</div><div class="dz-chain"></div></div>
        </div>
        <div class="dz-ctl">
          <div class="dz-sel"></div>
          <div class="dz-grid"><button class="dz-grow">GROW</button><button class="dz-growN">GROW ×<b></b></button><button class="dz-minus">−</button><button class="dz-plus">+</button></div>
          <div class="dz-grid3"><button class="dz-loop">LOOP</button><button class="dz-render">RENDER CHAIN</button><button class="dz-master">MASTER</button></div>
          <label class="dz-f"><span>KEEP COLOR</span><output class="o-keep"></output><input type="range" class="f-keep" min="0" max="100"></label>
          <label class="dz-f"><span>FRESH BLOOD</span><output class="o-fresh"></output><input type="range" class="f-fresh" min="0" max="100"></label>
        </div>
      </div>`;
    const q = s => r.querySelector(s);
    this.read = q(".dz-read"); this.shelf = q(".dz-shelf"); this.strip = q(".dz-chain"); this.selBox = q(".dz-sel");
    q(".dz-close").addEventListener("click", () => this.toggle(false));
    this.growBtn = q(".dz-grow"); this.growNBtn = q(".dz-growN");
    this.growBtn.addEventListener("click", () => this.act(() => this.grow(), "GROW"));
    this.growNBtn.addEventListener("click", () => (this.running ? (this.stop = true) : this.act(() => this.growN(this.n), "GROW ×N")));
    q(".dz-minus").addEventListener("click", () => { this.n = Math.max(3, this.n - 1); this.sync(); });
    q(".dz-plus").addEventListener("click", () => { this.n = Math.min(20, this.n + 1); this.sync(); });
    this.loopBtn = q(".dz-loop");
    this.loopBtn.addEventListener("click", () => { this.loop = !this.loop; this.sync(); });
    q(".dz-render").addEventListener("click", () => this.act(() => this.render({ width: LINK_W }), "RENDER"));
    q(".dz-master").addEventListener("click", () => this.act(() => this.master(), "MASTER"));
    const keep = q(".f-keep"), fresh = q(".f-fresh");
    keep.value = this.keep; fresh.value = this.fresh;
    keep.addEventListener("input", () => { this.keep = +keep.value; this.sync(); });
    fresh.addEventListener("input", () => { this.fresh = +fresh.value; this.sync(); });
    this.sync();
  }

  sync() {
    const q = s => this.root.querySelector(s);
    q(".dz-growN b").textContent = this.n;
    this.growNBtn.firstChild.textContent = this.running ? "■ STOP " : "GROW ×";
    this.loopBtn.classList.toggle("on", this.loop);
    q(".o-keep").textContent = this.keep;
    q(".o-fresh").textContent = `${this.fresh}%`;
    this.save();
    this.drawChain();
  }

  url(it) {
    if (!it?.thumb) return "";
    if (!this.urls.has(it.id)) this.urls.set(it.id, URL.createObjectURL(it.thumb));
    return this.urls.get(it.id);
  }

  async refreshBank() {
    try { this.items = await this.o.bank.list(); }
    catch (e) { this.o.log(`bank: ${e.message || e}`); this.items = []; }
    const ids = new Set(this.items.map(i => i.id));
    this.chain = this.chain.filter(l => ids.has(l.id));
    this.drawShelf();
    this.sync();
  }

  item(id) { return this.items.find(i => i.id === id); }

  drawShelf() {
    this.shelf.replaceChildren();
    if (!this.items.length) {
      const p = document.createElement("p");
      p.className = "dz-empty";
      p.textContent = "Every finished mosh lands here. Hit MOSH, or + NEW LINK below.";
      this.shelf.append(p);
    }
    for (const it of this.items) {
      const el = document.createElement("div");
      el.className = `dz-item${this.sel === it.id ? " sel" : ""}`;
      el.innerHTML = `<img alt=""><span>${it.kind === "chain" ? "⛓ " : ""}${(it.duration || 0).toFixed(1)}s</span>`;
      el.querySelector("img").src = this.url(it);
      el.title = it.label || it.kind;
      this.press(el, () => this.select(it), () => this.remove(it));
      this.shelf.append(el);
    }
    this.drawSel();
  }

  // tap / long-press on one element
  press(el, onTap, onHold) {
    let t = 0, held = false;
    el.addEventListener("pointerdown", () => { held = false; t = setTimeout(() => { held = true; onHold(); }, 600); });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, e => {
      clearTimeout(t);
      if (ev === "pointerup" && !held) onTap(e);
    });
    el.addEventListener("contextmenu", e => e.preventDefault());
  }

  async select(it) {
    this.sel = it.id;
    this.drawShelf();
    try { await this.o.showResult(it.blob, { w: it.w, h: it.h, duration: it.duration, label: it.label || it.kind }); }
    catch (e) { this.o.log(`preview: ${e.message || e}`); }
  }

  drawSel() {
    const it = this.item(this.sel);
    this.selBox.replaceChildren();
    if (!it) { this.selBox.innerHTML = `<p class="dz-hint">tap a bank item: preview it, then → A · → B · → PAD · + CHAIN. Hold: delete.</p>`; return; }
    for (const [label, fn] of [
      ["→ A", () => this.o.toSlot("A", it)],
      ["→ B", () => this.o.toSlot("B", it)],
      ["→ PAD", () => this.o.toPad(it, this.url(it))],
      ["+ CHAIN", () => this.addLink(it.id)],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      this.selBox.append(b);
    }
  }

  async remove(it) {
    if (!confirm(`Delete this ${it.kind} from the bank?`)) return;
    await this.o.bank.remove(it.id);
    if (this.urls.has(it.id)) { URL.revokeObjectURL(this.urls.get(it.id)); this.urls.delete(it.id); }
    if (this.sel === it.id) this.sel = null;
    this.refreshBank();
  }

  addLink(id) {
    this.chain.push({ id, join: "mosh", count: 8 });
    this.sync();
  }

  chainSeconds() {
    return this.chain.reduce((s, l) => s + (this.item(l.id)?.duration || 0), 0);
  }

  drawChain() {
    if (!this.strip) return;
    this.strip.replaceChildren();
    this.chain.forEach((l, i) => {
      const it = this.item(l.id);
      if (i > 0) {
        const chip = document.createElement("button");
        chip.className = `dz-join j-${l.join}`;
        chip.textContent = l.join === "bloom" ? `BLOOM ×${l.count}` : l.join.toUpperCase();
        chip.title = "tap: MOSH → BLOOM → SOUP → CUT · hold BLOOM: count";
        this.press(chip, () => { l.join = JOINS[(JOINS.indexOf(l.join) + 1) % JOINS.length]; this.sync(); },
          () => { if (l.join === "bloom") { l.count = BLOOM_COUNTS[(BLOOM_COUNTS.indexOf(l.count) + 1) % BLOOM_COUNTS.length]; this.sync(); } });
        this.strip.append(chip);
      }
      const el = document.createElement("div");
      el.className = "dz-link";
      el.innerHTML = `<img alt=""><span>${i + 1}</span>`;
      el.querySelector("img").src = this.url(it);
      this.dragLink(el, i);
      this.strip.append(el);
    });
    const add = document.createElement("button");
    add.className = "dz-new";
    add.textContent = "+ NEW LINK";
    add.addEventListener("click", () => this.act(() => this.newLink(), "NEW LINK"));
    this.strip.append(add);
    const s = this.chainSeconds(), long = s > MAX_CHAIN_S;
    this.root.classList.toggle("too-long", long);
    if (!this.running) {
      if (long) this.readout(`${this.chain.length} links · ${s.toFixed(1)} s: over ${MAX_CHAIN_S} s, the phone may run out of memory`);
      else this.readout(this.chain.length ? `${this.chain.length} links · ${s.toFixed(1)} s${this.loop ? " · LOOP" : ""}` : "");
    }
  }

  // Drag a link sideways to move it; swipe it up to remove it; tap to preview it
  dragLink(el, i) {
    let start = null;
    const reset = () => { start = null; el.style.transform = ""; el.style.opacity = ""; el.classList.remove("drag"); };
    el.addEventListener("pointerdown", e => { start = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", e => {
      if (!start) return;
      const d = this.o.layout.toLocal(e.clientX - start.x, e.clientY - start.y);
      el.style.transform = d.y < -20 && -d.y > Math.abs(d.x) ? `translateY(${d.y}px)` : `translateX(${d.x}px)`;
      el.style.opacity = d.y < -70 ? 0.3 : 1;
      el.classList.add("drag");
    });
    el.addEventListener("pointerup", e => {
      if (!start) return;
      const d = this.o.layout.toLocal(e.clientX - start.x, e.clientY - start.y);
      reset();
      if (d.y < -70 && -d.y > Math.abs(d.x)) { this.chain.splice(i, 1); this.sync(); return; }
      if (Math.abs(d.x) > 14) {
        const chip = el.previousElementSibling?.classList.contains("dz-join") ? el.previousElementSibling : null;
        const pitch = el.offsetWidth + (chip?.offsetWidth || 90) + 16;
        const to = Math.max(0, Math.min(this.chain.length - 1, i + Math.round(d.x / pitch)));
        if (to !== i) { const [l] = this.chain.splice(i, 1); this.chain.splice(to, 0, l); this.sync(); }
        return;
      }
      const it = this.item(this.chain[i]?.id);
      if (it) this.select(it);
    });
    el.addEventListener("pointercancel", reset);
  }

  // ---------- doing things ----------
  async act(fn, what) {
    try { await this.o.lock(fn); }
    catch (e) {
      console.error(e);
      this.o.log(`${what}: ${e.message || e}`);
      this.readout(`${what}: ${(e.message || e).toString().slice(0, 80)}`);
      this.o.setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 50)}`);
    } finally {
      this.running = false; this.stop = false; this.sync();
    }
  }

  // Store a new link in the bank and append it to the chain
  async keepLink(out, label, sources, settings) {
    const thumb = await this.o.makeThumb(out.blob);
    const it = await this.o.bank.add({ kind: "link", label, blob: out.blob, thumb, w: out.w, h: out.h, duration: out.duration, settings, sources });
    this.items.unshift(it);
    this.chain.push({ id: it.id, join: "mosh", count: 8 });
    this.drawShelf();
    this.sync();
    return it;
  }

  async newLink() {
    this.readout("NEW LINK: two random GifCities clips…");
    const a = await this.o.randomGifFile(), b = await this.o.randomGifFile();
    const keepA = +(0.4 + Math.random() * 1.2).toFixed(2);
    const vf = keepColorVf(this.keep);
    const out = await this.o.moshFiles(a.file, b.file, { keepA, width: LINK_W, vf });
    const it = await this.keepLink(out, `${a.label} × ${b.label}`, { A: a.file, B: b.file }, { keepA: out.keepA, vf });
    await this.o.showResult(it.blob, { ...it, label: "new link" });
  }

  // One generation: grow a new link out of the tail of the last one
  async grow(gen = "") {
    const last = this.item(this.chain[this.chain.length - 1]?.id);
    const fresh = !last || Math.random() * 100 < this.fresh;
    this.readout(`GROW${gen}: ${fresh ? "fresh blood (a clean GifCities clip)" : `the tail of link ${this.chain.length}`}…`);
    const A = fresh ? await this.o.randomGifFile() : { file: await this.o.tailStill(last.blob), label: "tail" };
    // B: usually a GifCities clip, sometimes something from the bank
    const pool = this.items.filter(i => i.kind !== "chain" && i.duration < 12);
    const pick = pool.length && Math.random() < 0.3 ? pool[(Math.random() * pool.length) | 0] : null;
    const B = pick ? { file: new File([pick.blob], `${pick.id}.mp4`, { type: "video/mp4" }), label: `bank ${pick.kind}` } : await this.o.randomGifFile();
    const keepA = fresh ? +(0.4 + Math.random() * 1.2).toFixed(2) : 0.5;
    const vf = keepColorVf(this.keep);
    const out = await this.o.moshFiles(A.file, B.file, { keepA, width: LINK_W, vf });
    const it = await this.keepLink(out, `${A.label} × ${B.label}`, { A: A.file, B: B.file }, { keepA: out.keepA, vf, grown: !fresh });
    await this.o.showResult(it.blob, { ...it, label: `link ${this.chain.length}` });   // the running preview
  }

  async growN(n) {
    this.running = true; this.stop = false; this.sync();
    for (let k = 1; k <= n && !this.stop; k++) {
      await this.grow(` ${k}/${n}`);
      if (this.chainSeconds() > MAX_CHAIN_S) { this.o.log(`GROW: stopped at ${MAX_CHAIN_S} s`); break; }
    }
    if (this.chain.length >= 2) await this.render({ width: LINK_W });
  }

  // ---------- RENDER CHAIN ----------
  // links: bank items, in chain order (MASTER passes re-moshed ones). One mpeg4 AVI with
  // keyframes exactly at the joins, the joins moshed (moshChain), the sound in the same order, MP4.
  async render({ width, links = null, tag = "" }) {
    const o = this.o;
    const chain = this.chain.filter(l => this.item(l.id));
    const items = links || chain.map(l => this.item(l.id));
    if (items.length < 2) throw new Error("a chain needs at least 2 links");
    const seq = this.loop ? [...items, items[0]] : items;
    const frames = seq.map(it => Math.max(2, Math.round(it.duration * FPS)));
    const starts = chainStarts(frames);
    const secs = frames.reduce((a, b) => a + b, 0) / FPS;
    if (secs > MAX_CHAIN_S) o.log(`RENDER: ${secs.toFixed(1)} s is over ${MAX_CHAIN_S} s; the phone may run out of memory`);
    const size = targetSize(items[0].w, items[0].h, width);
    const ff = await o.ffmpeg();
    const t0 = performance.now();
    const step = (f, text) => { o.setProgress(f, text); this.readout(`${tag}${text}`); };

    step(0.02, `RENDER: writing ${seq.length} links`);
    const inputs = [];
    try {
      for (const [i, it] of seq.entries()) { const n = `c${i}.mp4`; await ff.writeFile(n, new Uint8Array(await it.blob.arrayBuffer())); inputs.push(n); }
      step(0.05, "RENDER: encoding");
      await o.run(chainEncodeArgs({ inputs, frames, w: size.w, h: size.h }), 0.05, 0.6, `${tag}CHAIN ENCODE`);
      for (const n of inputs) await o.rm(n);
      step(0.6, "RENDER: moshing the joins");
      const avi = await ff.readFile("chain.avi");
      await o.rm("chain.avi");
      // the join into link k+1 is set on that link's chip; the LOOP join (back into link 1) moshes
      const joins = seq.slice(1).map((_, k) => {
        const l = chain[k + 1];
        return { at: starts[k + 1], type: l?.join || "mosh", count: l?.count ?? 8 };
      });
      const { data, stats } = moshChain(avi, joins);
      o.log(`chain: ${JSON.stringify({ ...stats, order: undefined })}`);
      await ff.writeFile("chain-m.avi", data);
      let wav = null;
      try {
        step(0.62, "RENDER: sound");
        await ff.writeFile("chain.wav", await buildChainAudio(o.audio(), seq.map(it => it.blob), frames, stats.order));
        wav = "chain.wav";
      } catch (e) { o.log(`chain: no sound (${e.message || e})`); }
      const ss = this.loop ? frames[0] / FPS : 0;          // LOOP: drop the first copy of link 1
      await o.run(decodeArgs("chain-m.avi", "chain.mp4", wav, { ss }), 0.64, 0.98, `${tag}CHAIN MP4`);
      await o.rm("chain-m.avi"); await o.rm("chain.wav");
      const mp4 = await ff.readFile("chain.mp4");
      await o.rm("chain.mp4");
      const blob = new Blob([mp4.buffer], { type: "video/mp4" });
      const duration = (stats.kept - (this.loop ? frames[0] : 0)) / FPS;
      const thumb = await o.makeThumb(blob, duration / 2);
      const it = await o.bank.add({
        kind: "chain", label: `chain ×${items.length}${this.loop ? " loop" : ""}${width >= MASTER_W ? " master" : ""}`,
        blob, thumb, w: size.w, h: size.h, duration,
        settings: { width, loop: this.loop, joins: chain.slice(1).map(l => ({ join: l.join, count: l.count })) },
        sources: { links: chain.map(l => l.id) },
      });
      this.items.unshift(it);
      this.sel = it.id;
      this.drawShelf();
      step(1, `CHAIN DONE: ${duration.toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      await o.showResult(blob, { w: size.w, h: size.h, duration, name: `mosh-chain-${Date.now()}.mp4`, label: it.label });
      return it;
    } catch (e) {
      for (const n of [...inputs, "chain.avi", "chain-m.avi", "chain.wav", "chain.mp4"]) await o.rm(n);
      throw e;
    }
  }

  // MASTER: every link re-moshed from its own sources at 480 px, then the chain at 480 px
  async master() {
    const items = this.chain.map(l => this.item(l.id)).filter(Boolean);
    if (items.length < 2) throw new Error("a chain needs at least 2 links");
    const hi = [];
    for (const [k, it] of items.entries()) {
      this.readout(`MASTER ${k + 1}/${items.length}: re-moshing at ${MASTER_W} px`);
      if (it.sources?.A && it.sources?.B) {
        const out = await this.o.moshFiles(it.sources.A, it.sources.B, { keepA: it.settings?.keepA ?? 1, width: MASTER_W, vf: it.settings?.vf || null });
        hi.push({ ...it, blob: out.blob, w: out.w, h: out.h, duration: out.duration });
      } else hi.push(it);                                    // a chain used as a link: as it is
    }
    return this.render({ width: MASTER_W, links: hi, tag: "MASTER: " });
  }
}
