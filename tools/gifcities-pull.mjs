// Build clips/gifcities/manifest.json: a curated index of GifCities GIFs (the Internet Archive's
// GeoCities GIF search), grouped into VIBES. Only the index lives in the repo; the app loads each
// GIF straight from blob.gifcities.org, which allows it (Access-Control-Allow-Origin: *).
// GifCities' search has no CORS and no JSON API, so the app can't search it live; this reads its
// public HTML results instead, slowly and politely.
//
// Curation, so every GIF is a vibe and not a goofy clip-art bullet:
//   - semantic search (GifCities' /special-search, image-similarity based) with mood queries,
//     falling back to the normal keyword search
//   - every candidate is downloaded and parsed: it must really animate (>= MIN_FRAMES frames),
//     be big enough to have texture (>= MIN_SIDE px), not be a banner, and not be huge
//
//   node tools/gifcities-pull.mjs [perQuery=40]
// Runs on Node 18+ (global fetch). Also runs in Termux (pkg install nodejs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PER_QUERY = Math.max(5, Math.min(200, +(process.argv[2] || 40)));
const DELAY_MS = 700;
const MIN_FRAMES = 6, MIN_SIDE = 80, MAX_ASPECT = 2.2, MAX_BYTES = 1_500_000;
const UA = "mosh-gifcities-index/2.0 (+https://github.com/LiveAndDie247/mosh)";
const BLOB = "https://blob.gifcities.org/gifcities/";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clips", "gifcities", "manifest.json");

// Each vibe: mood queries. Semantic search understands the mood, not just the file name.
export const VIBES = {
  vapor: ["vaporwave aesthetic", "greek statue bust", "palm trees sunset", "pink purple sunset", "dolphin jumping",
    "retro grid horizon", "marble statue", "pastel clouds", "tropical beach", "fountain"],
  space: ["galaxy nebula", "spinning planet", "starfield", "earth from space", "rotating moon", "comet",
    "saturn rings", "black hole", "aurora", "shooting star"],
  hypno: ["hypnotic spiral", "psychedelic", "kaleidoscope", "fractal", "optical illusion", "vortex tunnel",
    "rotating eye", "plasma swirl", "trippy pattern", "warp tunnel"],
  water: ["ocean waves", "underwater", "jellyfish", "rain on water", "waterfall", "koi fish", "bubbles",
    "ripples", "liquid metal", "lava lamp"],
  fire: ["burning fire", "flames", "candle flame", "explosion", "volcano lava", "lightning storm",
    "fireworks night", "sparks", "sun flare", "smoke"],
  cyber: ["cyberspace", "matrix code", "wireframe", "3d rotating chrome", "hologram", "neon city",
    "computer screen", "virtual reality", "circuit", "rotating crystal"],
  dream: ["angel wings", "roses falling", "butterflies", "glitter sparkle", "moon and stars night", "fairy",
    "flowers blooming", "hearts", "crystal ball", "mermaid"],
  night: ["city at night", "neon sign", "highway at night", "rainy window", "dark forest", "full moon",
    "ghost", "skull", "candles", "eye blinking"],
  glitch: ["tv static", "glitch", "vhs", "television", "old computer", "pixel art", "8bit", "noise",
    "loading", "scanlines"],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One search result: <a href="SRC"...><img ... width=W height=H ... src=".../gifcities/ID.gif">
// (attributes in any order, so both search pages parse the same way)
function parseResults(html) {
  const out = [];
  for (const m of html.matchAll(/<a href="([^"]+)"[^>]*>\s*<img([^>]*)>/g)) {
    const attrs = m[2];
    const id = attrs.match(/gifcities\/([A-Za-z0-9]+)\.gif/)?.[1];
    if (!id) continue;
    const w = +(attrs.match(/width="?(\d+)/)?.[1] || 0), h = +(attrs.match(/height="?(\d+)/)?.[1] || 0);
    out.push({ id, w, h, src: m[1].replace(/&amp;/g, "&") });
  }
  return out;
}

async function getHTML(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function search(q) {
  const enc = encodeURIComponent(q);
  try {
    const hits = parseResults(await getHTML(`https://gifcities.org/special-search?q=${enc}&flavor=semantic&offset=0&page_size=${PER_QUERY}`));
    if (hits.length) return { hits, how: "semantic" };
  } catch {}
  await sleep(DELAY_MS);
  return { hits: parseResults(await getHTML(`https://gifcities.org/search?q=${enc}&offset=0&page_size=${PER_QUERY}`)), how: "keyword" };
}

// Walk the GIF's blocks: real size, frame count, total duration (s)
export function gifInfo(b) {
  if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return null;
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  let p = 13;
  if (b[10] & 0x80) p += 3 << ((b[10] & 7) + 1);
  const skipSub = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
  let frames = 0, delay = 0;
  while (p < b.length) {
    const k = b[p++];
    if (k === 0x21) {
      const label = b[p++];
      if (label === 0xf9 && b[p] >= 4) delay += (b[p + 2] | (b[p + 3] << 8)) || 10;
      skipSub();
    } else if (k === 0x2c) {
      frames++;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 << ((flags & 7) + 1);
      p++;                                   // LZW minimum code size
      skipSub();
    } else break;                            // 0x3B trailer (or junk)
  }
  return { w, h, frames, dur: delay / 100 };
}

async function vet(g) {
  const res = await fetch(`${BLOB}${g.id}.gif`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length > MAX_BYTES) return null;
  const i = gifInfo(b);
  if (!i || i.frames < MIN_FRAMES) return null;
  if (Math.min(i.w, i.h) < MIN_SIDE || Math.max(i.w / i.h, i.h / i.w) > MAX_ASPECT) return null;
  return { ...i, bytes: b.length };
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 1. candidates from every query
  const cand = new Map();
  const queries = Object.entries(VIBES).flatMap(([v, qs]) => qs.map(q => [v, q]));
  let failed = 0;
  for (const [i, [vibe, q]] of queries.entries()) {
    try {
      const { hits, how } = await search(q);
      let added = 0;
      for (const g of hits) {
        if (g.w && g.h && (Math.min(g.w, g.h) < MIN_SIDE || Math.max(g.w / g.h, g.h / g.w) > MAX_ASPECT)) continue;
        const e = cand.get(g.id);
        if (e) { if (!e.t.includes(q)) e.t.push(q); continue; }
        cand.set(g.id, { id: g.id, v: vibe, t: [q], src: g.src });
        added++;
      }
      console.log(`[${i + 1}/${queries.length}] ${vibe} / "${q}" (${how}): ${hits.length} results, ${added} new`);
    } catch (e) {
      failed++;
      console.warn(`[${i + 1}/${queries.length}] ${vibe} / "${q}": failed (${e.message})`);
    }
    await sleep(DELAY_MS);
  }

  // 2. download and vet every candidate
  const list = [...cand.values()], keep = [];
  console.log(`vetting ${list.length} candidates…`);
  await pool(list, 6, async (g, i) => {
    try {
      const info = await vet(g);
      if (info) keep.push({ ...g, w: info.w, h: info.h, f: info.frames, d: +info.dur.toFixed(2) });
    } catch {}
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${list.length}, kept ${keep.length}`);
  });

  if (keep.length < 50) { console.error(`Only ${keep.length} GIFs passed: not writing the manifest.`); process.exit(1); }
  const counts = Object.fromEntries(Object.keys(VIBES).map(v => [v, keep.filter(g => g.v === v).length]));
  const manifest = {
    source: "GifCities (Internet Archive GeoCities GIF search), https://gifcities.org",
    gifBase: BLOB,
    generated: new Date().toISOString(),
    vibes: Object.keys(VIBES),
    counts,
    count: keep.length,
    gifs: keep,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest));
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${keep.length} GIFs (${JSON.stringify(counts)}), ${failed} queries failed`);
}
