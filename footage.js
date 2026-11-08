// FOOTAGE: short public-domain film clips (Prelinger, via tools/footage-pull.mjs), served from
// this site. Real video, so it moshes smooth where GIFs go grainy.
const URL_ = "clips/footage/manifest.json";
let man = null;

export async function loadFootage() {
  if (man) return man;
  const res = await fetch(URL_, { cache: "no-cache" });
  if (!res.ok) throw new Error("no footage library yet (run tools/footage-pull.mjs)");
  man = await res.json();
  man.vibes ||= [...new Set(man.clips.map(c => c.v))];
  return man;
}

export const footageURL = c => `clips/footage/${c.f}`;

// A shuffled copy of one vibe's clips ("" = all). `minMotion`: prefer clips that move at least
// that much (manifest `m`, mean frame difference), unless that leaves fewer than 3.
export function shuffledFootage(vibe = "", minMotion = 0) {
  let a = (man?.clips || []).filter(c => !vibe || c.v === vibe).slice();
  if (minMotion > 0) { const mv = a.filter(c => (c.m ?? 99) >= minMotion && !c.cuts); if (mv.length >= 3) a = mv; }   // melt styles: moving, and no film edit inside (an edit repaints the picture clean)
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
