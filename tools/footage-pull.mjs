// Build the FOOTAGE library: short clips of public-domain film from the Internet Archive's
// Prelinger collection, cut by vibe, saved into clips/footage/ with a manifest the app reads.
// archive.org doesn't send CORS headers, so the app can't fetch the films itself: the clips are
// pulled once, here, and served from the site (same origin).
//
// Run in Termux (needs node 18+ and ffmpeg):   node tools/footage-pull.mjs
// Options: --per 30 (clips per vibe)  --len 5 (seconds per clip)  --only love,party
//          --measure: only tag the clips already pulled with how much they move (m), then stop
// Safe to re-run: it adds to what's there and skips films it already used.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PER = +arg("per", 30), LEN = +arg("len", 5), PER_FILM = 3;
const ONLY = arg("only", "") ? arg("only", "").split(",") : null;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "clips/footage");
const MAN = path.join(OUT, "manifest.json");

// What each vibe searches for, inside the Prelinger collection (public-domain ephemeral films)
// Matched against TITLE and SUBJECT only (a full-text search pulls in "About Bananas").
const VIBES = {
  love:  "dating OR date OR romance OR courtship OR kiss OR marriage OR wedding OR sweetheart OR love OR boy OR girl OR popular OR engagement",
  party: "party OR dance OR dancing OR teenagers OR teen OR prom OR nightclub OR jukebox OR rock OR swing OR ballroom",
  home:  "\"home movie\" OR \"home movies\" OR birthday OR vacation OR picnic OR christmas OR backyard",
  tv:    "commercial OR commercials OR television OR advertising OR jingle OR cartoon OR \"tv spot\"",
};

const man = fs.existsSync(MAN) ? JSON.parse(fs.readFileSync(MAN, "utf8")) : { vibes: [], clips: [], films: [] };
man.films ||= [];
const usedFilms = new Set(man.films);

const getJSON = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function search(q) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`collection:prelinger AND mediatype:movies AND (title:(${q}) OR subject:(${q}))`)}` +
    `&fl[]=identifier&fl[]=title&rows=200&output=json&sort[]=downloads+desc`;
  return (await getJSON(url)).response.docs;
}

// The smallest MP4 derivative of a film, with its length in seconds
async function mp4Of(id) {
  const meta = await getJSON(`https://archive.org/metadata/${id}`);
  const vids = (meta.files || []).filter(f => /\.mp4$/i.test(f.name) && +f.length > LEN * 4);
  if (!vids.length) return null;
  vids.sort((a, b) => (+a.size || 1e12) - (+b.size || 1e12));
  const f = vids.find(v => /512kb/i.test(v.name)) || vids[0];
  return { url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`, dur: +f.length };
}

// Cut one clip: seek straight into the remote file (ffmpeg uses range requests, so the whole film
// isn't downloaded), 480 wide, 30 fps, no sound, small. Returns false if the cut came out empty.
function cut(url, at, out) {
  execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", url, "-t", String(LEN), "-an",
    "-vf", "scale=480:-2,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart", out],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 120000 });
  return fs.existsSync(out) && fs.statSync(out).size > 20000;
}

// How much a clip moves, in pixels per frame at 480 wide (the reference melt's opening is ~0.55).
// Frame difference would count film grain and webcam noise as motion, so this is real block
// matching: 160x160 gray frames, 10 frames apart (so slow motion adds up to whole pixels), a
// grid of 16px blocks each searched +-6 px for its best match; the mean best shift, scaled back
// to 480 and to one frame.
function motionOf(file) {
  const S = 160, raw = execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-an",
    "-vf", `scale=${S}:${S}:force_original_aspect_ratio=increase,crop=${S}:${S},fps=30`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 64 << 20 });
  const n = Math.floor(raw.length / (S * S)), GAP = 10, B = 16, R = 6, mags = [];
  const at = (k, x, y) => raw[k * S * S + y * S + x];
  for (let k = 0; k + GAP < n; k += 5) {
    for (let by = 12; by + B <= S - 12; by += 16) for (let bx = 12; bx + B <= S - 12; bx += 16) {
      let best = Infinity, bdx = 0, bdy = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        let sad = 0;
        for (let y = 0; y < B; y += 2) for (let x = 0; x < B; x += 2) sad += Math.abs(at(k, bx + x, by + y) - at(k + GAP, bx + x + dx, by + y + dy));
        if (sad < best) { best = sad; bdx = dx; bdy = dy; }
      }
      mags.push(Math.hypot(bdx, bdy));
    }
  }
  if (!mags.length) return 0;
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  return +((mean * (480 / S)) / GAP).toFixed(2);
}
if (process.argv.includes("--measure")) {                  // tag what's already there, then stop
  let n = 0;
  for (const c of man.clips) {
    if (c.m != null) continue;
    try { c.m = motionOf(path.join(OUT, c.f)); n++; } catch { c.m = 0; }
    process.stdout.write(`${c.v}/${path.basename(c.f)}: ${c.m}\n`);
  }
  fs.writeFileSync(MAN, JSON.stringify(man));
  const ms = man.clips.map(c => c.m || 0).sort((a, b) => a - b);
  console.log(`measured ${n} clips; motion min ${ms[0]} median ${ms[ms.length >> 1]} max ${ms[ms.length - 1]}; ${man.clips.filter(c => (c.m || 0) >= 0.3).length}/${man.clips.length} move enough for VORTEX`);
  process.exit(0);
}

for (const [vibe, q] of Object.entries(VIBES)) {
  if (ONLY && !ONLY.includes(vibe)) continue;
  fs.mkdirSync(path.join(OUT, vibe), { recursive: true });
  let have = man.clips.filter(c => c.v === vibe).length;
  console.log(`\n== ${vibe}: have ${have}, want ${PER}`);
  if (have >= PER) continue;
  let docs = [];
  try { docs = await search(q); } catch (e) { console.log(`  search failed: ${e.message}`); continue; }
  for (const d of docs) {
    if (have >= PER) break;
    if (usedFilms.has(d.identifier)) continue;
    usedFilms.add(d.identifier); man.films.push(d.identifier);
    let src;
    try { src = await mp4Of(d.identifier); } catch (e) { console.log(`  ${d.identifier}: ${e.message}`); continue; }
    if (!src) continue;
    console.log(`  ${d.identifier} (${Math.round(src.dur)}s) ${d.title || ""}`);
    for (let k = 0; k < PER_FILM && have < PER; k++) {
      // random spots, away from titles at the start and credits at the end
      const at = src.dur * (0.12 + 0.76 * Math.random());
      const file = `${vibe}/${d.identifier.replace(/[^\w-]/g, "_").slice(0, 40)}_${k}.mp4`;
      try {
        if (!cut(src.url, at, path.join(OUT, file))) continue;
        let m = 0; try { m = motionOf(path.join(OUT, file)); } catch {}
        man.clips.push({ f: file, v: vibe, t: (d.title || d.identifier).slice(0, 60), d: LEN, src: d.identifier, m });
        have++;
        fs.writeFileSync(MAN, JSON.stringify(man));          // save as we go: safe to stop any time
      } catch (e) { console.log(`    cut failed: ${(e.message || e).toString().slice(0, 80)}`); }
    }
    await sleep(300);                                          // be polite to the archive
  }
  console.log(`  -> ${have} ${vibe} clips`);
}

man.vibes = [...new Set(man.clips.map(c => c.v))];
fs.writeFileSync(MAN, JSON.stringify(man));
const mb = man.clips.reduce((n, c) => { try { return n + fs.statSync(path.join(OUT, c.f)).size; } catch { return n; } }, 0) / 1048576;
console.log(`\nDONE: ${man.clips.length} clips (${man.vibes.join(", ")}), ${mb.toFixed(1)} MB in clips/footage/`);
