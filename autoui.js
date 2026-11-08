// The AUTO MOSH panel: sources (a GifCities vibe and/or your own clips), length, shape, style,
// a song (BPM detected, TAP to fix), one big button. Re-tap for a new take of the same setup.
import { planAuto, runAuto, STYLES } from "./auto.js";
import { detectBpm, tapper } from "./beat.js";
import { loadIndex, shuffledGifs, gifURL } from "./gif.js";
import { loadFootage, shuffledFootage, footageURL } from "./footage.js";

const LENGTHS = [15, 30, 60];
const KEY = "mosh.auto";

export function initAuto(root, d) {
  // d: { loadFFmpeg, ffmpeg(), run, rm, setProgress, log, lock, showResult, bank, makeThumb, refreshBank, audio, probe }
  let s = { vibe: "mix", fvibe: "mix", seconds: 30, ratio: "1:1", style: "VORTEX", gifs: 8, bpm: 120, offset: 0 };
  try { s = { ...s, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}
  if (!STYLES[s.style]) s.style = "VORTEX";            // a style from an older build that's gone now
  const own = [];                    // [{ file, kind, duration, ext }]
  let song = null;                   // { file, duration }
  let vibeVals = [];
  let noFootage = false;               // the footage library hasn't been pulled yet                 // the GifCities vibes, for SURPRISE
  const save = () => { const { bpm, offset, ...keep } = s; localStorage.setItem(KEY, JSON.stringify(keep)); };

  root.innerHTML = `
    <div class="a-row a-frow" hidden><span class="a-lab">FOOTAGE</span><div class="seg a-vibes a-fvibes"></div></div>
    <div class="a-row"><span class="a-lab">GIFS</span><div class="seg a-vibes a-gvibes"></div></div>
    <div class="a-row"><span class="a-lab">YOURS</span><div class="a-own"><button class="a-add">+ ADD CLIPS</button><span class="a-ownlist">none · GIFs or videos from your phone</span><button class="a-clear" hidden>CLEAR</button></div></div>
    <div class="a-row"><span class="a-lab">LENGTH</span><div class="seg a-len"></div></div>
    <div class="a-row"><span class="a-lab">SHAPE</span><div class="seg a-ratio"></div></div>
    <div class="a-row"><span class="a-lab">STYLE</span><div class="seg a-style"></div></div>
    <div class="a-row"><span class="a-lab">SONG</span><div class="a-own"><button class="a-song">+ ADD SONG</button><span class="a-songname">none · cuts land on the beat</span></div></div>
    <div class="a-row a-bpmrow"><span class="a-lab">BPM</span><div class="a-bpm"><output class="a-bpmout"></output><button class="a-tap">TAP</button><button class="a-bm">−</button><button class="a-bp">+</button></div></div>
    <div class="a-row a-offrow" hidden><span class="a-lab">START</span><div class="a-off"><output class="a-offout"></output><input type="range" class="a-offset" min="0" max="60" step="0.5" value="0"></div></div>
    <div class="a-gorow">
      <button class="a-surprise">🎲 SURPRISE</button>
      <button class="big a-go">AUTO MOSH</button>
    </div>
    <p class="a-note">SURPRISE picks a vibe + style and goes — one tap, no decisions. Every tap is a new take; they land in the BANK.</p>
    <input type="file" class="a-files" accept="video/*,image/gif" multiple hidden>
    <input type="file" class="a-songfile" accept="audio/*,video/*" hidden>`;
  const q = c => root.querySelector(c);

  function seg(box, items, get, set) {
    box.replaceChildren(...items.map(([label, v]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { set(v); sync(); });
      b.dataset.v = String(v);
      return b;
    }));
    box._get = get;
  }
  function sync() {
    for (const box of root.querySelectorAll(".seg")) for (const b of box.children) b.classList.toggle("on", b.dataset.v === String(box._get()));
    q(".a-bpmout").textContent = `${s.bpm}`;
    q(".a-offout").textContent = `${(+s.offset).toFixed(1)} s`;
    q(".a-ownlist").textContent = own.length ? `${own.length} clip${own.length > 1 ? "s" : ""}: ${own.map(c => c.file.name).join(", ")}`.slice(0, 90) : "none · GIFs or videos from your phone";
    q(".a-clear").hidden = !own.length;
    q(".a-go").textContent = `AUTO MOSH ${s.seconds}s`;
    save();
  }
  seg(q(".a-len"), LENGTHS.map(n => [`${n}s`, n]), () => s.seconds, v => (s.seconds = v));
  seg(q(".a-ratio"), [["1:1 POST", "1:1"], ["9:16 REEL", "9:16"], ["16:9 YT", "16:9"]], () => s.ratio, v => (s.ratio = v));
  seg(q(".a-style"), Object.keys(STYLES).map(k => [k, k]), () => s.style, v => (s.style = v));
  // FOOTAGE (real film clips, the smooth melt) — only if the library has been pulled
  loadFootage().then(m => {
    q(".a-frow").hidden = false;
    seg(q(".a-fvibes"), [["MIX", "mix"], ["NONE", "none"], ...m.vibes.map(v => [v.toUpperCase(), v])], () => s.fvibe, v => (s.fvibe = v));
    sync();
  }).catch(() => { noFootage = true; });
  loadIndex().then(idx => {
    vibeVals = idx.vibes.slice();
    seg(q(".a-gvibes"), [["MIX", "mix"], ["NONE", "none"], ...idx.vibes.map(v => [v.toUpperCase(), v])], () => s.vibe, v => (s.vibe = v));
    sync();
  }).catch(e => d.log(`auto: no GifCities index (${e.message || e})`));

  // your clips
  q(".a-add").addEventListener("click", () => q(".a-files").click());
  q(".a-files").addEventListener("change", async e => {
    for (const f of e.target.files) {
      const gif = f.type === "image/gif" || /\.gif$/i.test(f.name);
      const info = gif ? { duration: 2 } : await d.probe(f);
      own.push({ file: f, kind: gif ? "gif" : "video", duration: info.duration || 4, ext: (f.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] || ".mp4").toLowerCase() });
    }
    e.target.value = "";
    sync();
  });
  q(".a-clear").addEventListener("click", () => { own.length = 0; sync(); });

  // the song
  const tap = tapper();
  q(".a-song").addEventListener("click", () => q(".a-songfile").click());
  q(".a-songfile").addEventListener("change", async e => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    q(".a-songname").textContent = `${f.name} · finding the beat…`;
    try {
      const r = await detectBpm(d.audio(), f);
      song = { file: f, duration: r.duration };
      s.bpm = r.bpm; s.offset = 0;
      q(".a-offset").max = Math.max(0, Math.floor(r.duration - 5));
      q(".a-offset").value = 0;
      q(".a-offrow").hidden = false;
      q(".a-songname").textContent = `${f.name} · ${r.bpm} BPM${r.sure ? "" : "?"} · ${Math.round(r.duration)} s`;
    } catch (err) {
      song = null;
      q(".a-songname").textContent = `couldn't read that song (${err.message || err})`;
    }
    sync();
  });
  q(".a-tap").addEventListener("click", () => { const b = tap(); if (b) { s.bpm = Math.max(40, Math.min(240, b)); sync(); } });
  q(".a-bm").addEventListener("click", () => { s.bpm = Math.max(40, s.bpm - 1); sync(); });
  q(".a-bp").addEventListener("click", () => { s.bpm = Math.min(240, s.bpm + 1); sync(); });
  q(".a-offset").addEventListener("input", e => { s.offset = +e.target.value; sync(); });

  // GO
  // Fetch up to n distinct GIFs, several at once so a bigger pool doesn't mean a long wait.
  // Walks a shuffled copy of the pool, so a small vibe just yields fewer GIFs: it can't spin.
  async function fetchFootage(n) {
    if (!n || s.fvibe === "none") return [];
    const m = await loadFootage().catch(() => null);
    if (!m) return [];
    const pool = shuffledFootage(s.fvibe === "mix" ? "" : s.fvibe, STYLES[s.style]?.vmotion || 0), out = [];
    let next = 0;
    const grab = async () => {
      while (out.length < n && next < pool.length) {
        const c = pool[next++];
        try {
          const res = await fetch(footageURL(c));
          if (!res.ok) continue;
          const data = new Uint8Array(await res.arrayBuffer());
          if (out.length < n) { out.push({ kind: "video", ext: ".mp4", duration: c.d || 5, data, label: c.t }); d.setProgress(0.04 + 0.08 * out.length / n, `AUTO: FOOTAGE ${out.length}/${n}`); }
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, n) }, grab));
    return out;
  }

  async function fetchGifs(n) {
    if (!n) return [];
    const idx = await loadIndex(), out = [];
    const minFrames = STYLES[s.style]?.moving || 0;     // melt styles want GIFs that actually move
    const pool = shuffledGifs(s.vibe === "mix" ? "" : s.vibe, minFrames);
    if (!pool.length) throw new Error(`no GIFs in that vibe (${idx.count} in the index)`);
    let next = 0, done = 0;
    const grab = async () => {
      while (out.length < n && next < pool.length) {
        const g = pool[next++];
        try {
          const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
          const res = await fetch(gifURL(g), { signal: ctl.signal });
          clearTimeout(t);
          if (!res.ok) continue;
          const data = new Uint8Array(await res.arrayBuffer());
          if (out.length < n) { out.push({ kind: "gif", data, label: g.t[0] }); d.setProgress(0.04 + 0.08 * (++done) / n, `AUTO: GIF ${done}/${n}`); }
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, n) }, grab));
    if (!out.length) throw new Error(`couldn't reach GifCities (${idx.count} GIFs in the index)`);
    return out.slice(0, n);
  }

  async function go() {
    let wake = null;
    try { wake = await navigator.wakeLock?.request("screen"); } catch {}
    try {
      const out = await d.lock(async () => {
        await d.loadFFmpeg();
        d.setProgress(0.03, "AUTO: GATHERING");
        // enough GIFs that a longer clip doesn't recycle the same few: roughly one per cut, capped
        const want = Math.max(8, Math.min(26, Math.round(s.seconds / 2.2)));
        const useFoot = !noFootage && s.fvibe !== "none", useGif = s.vibe !== "none";
        // footage and GIFs together split the pool; your own clips take half of it
        const share = (useFoot && useGif ? 0.5 : 1) * (own.length ? 0.5 : 1);
        const nFoot = useFoot ? Math.max(3, Math.round(want * share)) : 0;
        const nGifs = useGif ? Math.max(own.length ? 4 : 3, Math.round(want * share)) : 0;
        if (!nGifs && !nFoot && !own.length) throw new Error("pick FOOTAGE or a GIF vibe, or add your own clips");
        const sources = [...await fetchFootage(nFoot), ...await fetchGifs(nGifs)];
        if (!sources.length && !own.length) throw new Error("couldn't load any clips");
        for (const c of own) sources.push({ kind: c.kind, ext: c.ext, duration: c.duration, data: new Uint8Array(await c.file.arrayBuffer()), label: c.file.name });
        const segs = planAuto({ seconds: s.seconds, bpm: s.bpm, style: s.style, pool: sources, seed: Date.now() });
        d.log(`auto: ${segs.length} cuts from ${sources.length} sources, ${s.style}, ${s.bpm} BPM, ${s.seconds}s ${s.ratio}`);
        const music = song ? { data: new Uint8Array(await song.file.arrayBuffer()), ext: (song.file.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] || ".mp3").toLowerCase(), offset: +s.offset } : null;
        return runAuto({ ffmpeg: d.ffmpeg(), run: d.run, rm: d.rm, setProgress: d.setProgress, log: d.log }, { sources, segs, ratio: s.ratio, music });
      });
      d.setProgress(1, `DONE · ${out.duration.toFixed(1)} s`);
      try {
        const thumb = await d.makeThumb(out.blob, out.duration / 3);
        await d.bank.add({ kind: "chain", label: `auto ${s.style.toLowerCase()} ${Math.round(out.duration)}s`, blob: out.blob, thumb, w: out.w, h: out.h, duration: out.duration, settings: { auto: { ...s } }, sources: {} });
        d.refreshBank();
      } catch (e) { d.log(`bank: ${e.message || e}`); }
      await d.showResult(out.blob, { w: out.w, h: out.h, duration: out.duration, name: `mosh-auto-${Date.now()}.mp4`, label: `auto ${s.style}` });
      document.querySelector("#player")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      console.error(e);
      d.log(`AUTO: ${e.message || e}`);
      d.setProgress(0, `ERROR: ${(e.message || e).toString().slice(0, 60)}`);
    } finally {
      try { await wake?.release(); } catch {}
    }
  }
  q(".a-go").addEventListener("click", go);
  q(".a-surprise").addEventListener("click", () => {
    const styles = Object.keys(STYLES);
    s.style = styles[Math.floor(Math.random() * styles.length)];
    // if they've added their own clips, keep using them + a random vibe; otherwise a random GifCities vibe
    const pool = vibeVals.length ? vibeVals.slice() : ["mix"];
    if (own.length) pool.push("mix");
    s.vibe = pool[Math.floor(Math.random() * pool.length)] || "mix";
    sync();
    go();
  });
  sync();
}
