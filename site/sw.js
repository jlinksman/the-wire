// The Wire — offline shell. The page opens instantly from cache, then refreshes.
// data.json is never cached here (app.js keeps its own copy); auth redirects pass through.
const SHELL = "wire-shell-v2";
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-180.png", "icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("wire-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/data.json") || url.searchParams.has("reauth")) return;
  // Stale-while-revalidate: answer from cache now, update the cache in the background.
  e.respondWith(caches.open(SHELL).then(async (cache) => {
    const key = e.request.mode === "navigate" ? "index.html" : e.request;
    const cached = await cache.match(key);
    const fresh = fetch(e.request, { redirect: "manual" }).then((res) => {
      if (res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
