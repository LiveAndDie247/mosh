// MOSH BANK: every finished mosh (and every rendered chain) is kept on the phone, in IndexedDB:
// the MP4, a thumbnail, its settings and its source clips, so it can be reused: back into slot A
// or B, onto a pad, or as a link in a DAISY CHAIN (and re-rendered from its sources by MASTER).
//   item: { id, created, kind: "mosh" | "link" | "chain", label, blob, thumb, w, h, duration,
//           settings: { keepA, vf, ... }, sources: { A: File, B: File } | { links: [ids] } }
const DB = "mosh-bank", STORE = "items";
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("bank: transaction aborted"));
  });
}

export const bank = {
  async add(item) {
    const it = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, created: Date.now(), ...item };
    await tx("readwrite", s => s.put(it));
    return it;
  },
  async get(id) { return tx("readonly", s => s.get(id)); },
  async list() {
    const all = (await tx("readonly", s => s.getAll())) || [];
    return all.sort((a, b) => b.created - a.created);
  },
  async remove(id) { await tx("readwrite", s => s.delete(id)); },
};

// A small JPEG of one frame (for the shelf and the chain strip)
export function makeThumb(blob, at = 0.6, width = 192) {
  return new Promise(resolve => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let done = false;
    const end = r => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(r); };
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.onloadeddata = () => { v.currentTime = Math.min(at, (v.duration || 1) * 0.6); };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = width; c.height = Math.max(2, Math.round((width * v.videoHeight) / (v.videoWidth || 1)));
      try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); c.toBlob(b => end(b), "image/jpeg", 0.8); } catch { end(null); }
    };
    v.onerror = () => end(null);
    setTimeout(() => end(null), 8000);
    v.src = url;
  });
}
