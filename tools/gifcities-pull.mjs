// Build clips/gifcities/manifest.json: an index of GifCities GIFs (the Internet Archive's
// GeoCities GIF search) across lots of search terms. Only the index lives in the repo; the app
// loads each GIF straight from blob.gifcities.org, which allows it (Access-Control-Allow-Origin: *).
// GifCities' search itself has no CORS and no JSON API, so the app can't search it live; this
// scrapes its public HTML results instead, slowly and politely.
//
//   node tools/gifcities-pull.mjs [perTerm=60]
// Runs on Node 18+ (global fetch). Also runs in Termux (pkg install nodejs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PER_TERM = Math.max(5, Math.min(200, +(process.argv[2] || 60)));
const DELAY_MS = 700;
const UA = "mosh-gifcities-index/1.0 (+https://github.com/LiveAndDie247/mosh)";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clips", "gifcities", "manifest.json");

// Lots of different textures and motions: good mosh material
const TERMS = [
  "fire", "flames", "water", "ocean", "waves", "rain", "storm", "lightning", "tornado", "clouds", "sky", "sun",
  "moon", "stars", "space", "planet", "galaxy", "comet", "rocket", "ufo", "alien", "robot", "computer", "cyber",
  "matrix", "neon", "glitter", "sparkles", "rainbow", "spiral", "hypno", "vortex", "tunnel", "kaleidoscope",
  "eye", "eyes", "face", "skull", "ghost", "angel", "devil", "dragon", "wizard", "magic", "crystal", "heart",
  "flower", "rose", "butterfly", "bird", "cat", "dog", "fish", "horse", "snake", "spider", "bat", "frog",
  "dance", "dancing", "running", "walking", "spinning", "rotating", "globe", "earth", "explosion", "bomb",
  "smoke", "snow", "snowglobe", "balloons", "fireworks", "candle", "clock", "money", "car", "train", "plane",
  "skateboard", "guitar", "music", "drum", "disco", "party", "construction", "under construction", "email",
  "welcome", "new", "hot", "cool", "wow", "loading", "counter", "flag", "skyline", "city", "tv", "static",
  "glitch", "pixel", "8bit", "pacman", "mario", "dinosaur", "volcano", "jungle", "desert", "mountain",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RESULT = /<a href="([^"]+)"[^>]*>\s*<img width="(\d+)" height="(\d+)" src="https:\/\/blob\.gifcities\.org\/gifcities\/([A-Z0-9]+)\.gif">/g;

async function search(term) {
  const url = `https://gifcities.org/search?q=${encodeURIComponent(term)}&offset=0&page_size=${PER_TERM}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return [...html.matchAll(RESULT)].map(m => ({ id: m[4], w: +m[2], h: +m[3], src: m[1].replace(/&amp;/g, "&") }));
}

const byId = new Map();
let failed = 0;
for (const [i, term] of TERMS.entries()) {
  try {
    const hits = await search(term);
    let added = 0;
    for (const g of hits) {
      if (g.w < 24 || g.h < 24) continue;              // tiny bullets and spacers: not much to mosh
      const e = byId.get(g.id);
      if (e) { if (!e.t.includes(term)) e.t.push(term); continue; }
      byId.set(g.id, { id: g.id, w: g.w, h: g.h, t: [term], src: g.src });
      added++;
    }
    console.log(`[${i + 1}/${TERMS.length}] ${term}: ${hits.length} results, ${added} new (total ${byId.size})`);
  } catch (e) {
    failed++;
    console.warn(`[${i + 1}/${TERMS.length}] ${term}: failed (${e.message})`);
  }
  await sleep(DELAY_MS);
}

if (byId.size === 0) { console.error("No GIFs found: not writing an empty manifest."); process.exit(1); }
const manifest = {
  source: "GifCities (Internet Archive GeoCities GIF search), https://gifcities.org",
  gifBase: "https://blob.gifcities.org/gifcities/",
  generated: new Date().toISOString(),
  terms: TERMS,
  count: byId.size,
  gifs: [...byId.values()],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest));
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${byId.size} GIFs from ${TERMS.length - failed}/${TERMS.length} terms`);
