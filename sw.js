// Service worker: makes MOSH installable and caches the ~31 MB ffmpeg engine after the
// first run, so later runs start fast. App files: network first (so updates arrive),
// falling back to the cache offline. The engine on jsDelivr: cache first (it's versioned).
const CACHE = "mosh-v12";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "index.html", "style.css", "app.js", "mosh.js", "pipeline.js", "auto.js", "autoui.js", "beat.js", "stars.js", "manifest.webmanifest"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/@ffmpeg/core@")) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  } else if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        // Always revalidate with the server: GitHub Pages lets browsers cache files for 10
        // minutes, which would otherwise keep serving the old app after a deploy.
        const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) || Response.error();
      }
    })());
  }
});
