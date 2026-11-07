// Build clips/gifcities/manifest.json: a curated index of GifCities GIFs (the Internet Archive's
// GeoCities GIF search), grouped into VIBES. A healthy mix of two kinds:
//   footage: real people and film (walking, dancing, faces, crowds, old movies, TV)
//   web:     weird old-internet GIFs (dancing babies, spinning 3D heads, spirals, vaporwave)
// Only the index lives in the repo; the app loads each GIF straight from blob.gifcities.org,
// which allows it (Access-Control-Allow-Origin: *). GifCities' search has no CORS and no JSON
// API, so the app can't search it live; this reads its public HTML results instead, slowly and
// politely.
//
// Curation:
//   - semantic search (GifCities' /special-search, image-similarity based), falling back to the
//     normal keyword search
//   - every candidate is downloaded and parsed: it must really animate (>= MIN_FRAMES frames),
//     be big enough, and not be a banner
//   - footage must also look photographic: it compresses badly (>= MIN_BPP bytes per pixel per
//     frame) and uses a real palette (>= MIN_COLORS); flat clip art doesn't
//
//   node tools/gifcities-pull.mjs [perQuery=30]
// Runs on Node 18+ (global fetch). Also runs in Termux (pkg install nodejs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PER_QUERY = Math.max(5, Math.min(200, +(process.argv[2] || 30)));
const DELAY_MS = 700;
const MIN_FRAMES = 6, MAX_ASPECT = 2.2, MAX_BYTES = 3_000_000;
const MIN_SIDE = { footage: 100, web: 80 };
const MIN_BPP = 0.12, MIN_COLORS = 64;          // footage only
const UA = "mosh-gifcities-index/3.0 (+https://github.com/LiveAndDie247/mosh)";
const BLOB = "https://blob.gifcities.org/gifcities/";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clips", "gifcities", "manifest.json");

export const VIBES = {
  // footage
  people: { kind: "footage", q: ["person walking", "woman walking down the street", "man smiling", "girl laughing",
    "people talking", "old man", "woman hair blowing in the wind", "man smoking a cigarette", "couple kissing", "man waving"] },
  dance: { kind: "footage", q: ["people dancing", "woman dancing", "man dancing", "breakdance", "dancing at a club",
    "ballet dancer", "aerobics workout", "disco dancing", "music video dancer", "dancing couple"] },
  faces: { kind: "footage", q: ["face close up", "woman face", "man face", "eyes looking at camera", "person crying",
    "person screaming", "person laughing", "wink", "person talking to the camera", "head turning"] },
  crowd: { kind: "footage", q: ["crowd of people", "concert crowd", "people cheering", "house party", "rave",
    "parade", "nightclub", "city street traffic", "people on the subway", "times square"] },
  film: { kind: "footage", q: ["black and white movie", "old film footage", "silent film", "horror movie scene",
    "kung fu fight", "film noir", "car chase", "explosion in a movie", "1950s footage", "home video"] },
  tv: { kind: "footage", q: ["news anchor", "tv commercial", "talk show host", "music video", "game show",
    "weather report", "sitcom scene", "singer on stage", "basketball dunk", "boxing punch"] },
  // weird internet
  weird: { kind: "web", q: ["dancing baby", "dancing hamster", "creepy face", "spinning head", "dancing skeleton",
    "alien dancing", "evil clown", "morphing face", "dancing banana", "weird animation"] },
  "3d": { kind: "web", q: ["3d rotating head", "chrome spinning logo", "3d rendered character", "3d rotating globe",
    "spinning 3d skull", "3d dancing figure", "rendered robot", "3d tunnel flythrough", "rotating crystal", "wireframe"] },
  hypno: { kind: "web", q: ["hypnotic spiral", "psychedelic", "kaleidoscope", "rotating eye", "vortex tunnel",
    "plasma swirl", "fractal", "optical illusion", "trippy face", "melting"] },
  vapor: { kind: "web", q: ["vaporwave aesthetic", "greek statue bust", "palm trees sunset", "dolphin jumping",
    "windows 95", "old computer", "tv static", "glitch", "neon city", "pixel art"] },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One search result: <a href="SRC"...><img ... width=W height=H ... src=".../gifcities/ID.gif">
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

// Walk the GIF's blocks: real size, frame count, total duration (s), biggest palette
export function gifInfo(b) {
  if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return null;
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  let p = 13, colors = 0;
  if (b[10] & 0x80) { colors = 2 << (b[10] & 7); p += 3 * colors; }
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
      if (flags & 0x80) { const n = 2 << (flags & 7); colors = Math.max(colors, n); p += 3 * n; }
      p++;                                   // LZW minimum code size
      skipSub();
    } else break;                            // 0x3B trailer (or junk)
  }
  return { w, h, frames, colors, dur: delay / 100 };
}

async function vet(g, kind) {
  const res = await fetch(`${BLOB}${g.id}.gif`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length > MAX_BYTES) return null;
  const i = gifInfo(b);
  if (!i || i.frames < MIN_FRAMES) return null;
  if (Math.min(i.w, i.h) < MIN_SIDE[kind] || Math.max(i.w / i.h, i.h / i.w) > MAX_ASPECT) return null;
  if (kind === "footage") {
    if (i.colors < MIN_COLORS) return null;
    if (b.length / (i.w * i.h * i.frames) < MIN_BPP) return null;   // flat clip art, not footage
  }
  return i;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 1. candidates from every query
  const cand = new Map();
  const queries = Object.entries(VIBES).flatMap(([v, { q }]) => q.map(x => [v, x]));
  let failed = 0;
  for (const [i, [vibe, q]] of queries.entries()) {
    try {
      const { hits, how } = await search(q);
      const min = MIN_SIDE[VIBES[vibe].kind];
      let added = 0;
      for (const g of hits) {
        if (g.w && g.h && (Math.min(g.w, g.h) < min || Math.max(g.w / g.h, g.h / g.w) > MAX_ASPECT)) continue;
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
      const kind = VIBES[g.v].kind;
      const info = await vet(g, kind);
      if (info) keep.push({ ...g, k: kind, w: info.w, h: info.h, f: info.frames, d: +info.dur.toFixed(2) });
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
    kinds: Object.fromEntries(Object.entries(VIBES).map(([v, { kind }]) => [v, kind])),
    counts,
    count: keep.length,
    gifs: keep,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest));
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${keep.length} GIFs (${JSON.stringify(counts)}), ${failed} queries failed`);
}
