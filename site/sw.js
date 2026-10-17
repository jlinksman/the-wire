// The Wire — service worker. Goal: always run the newest deployed version, and still
// open when offline.
//   - Page, script and styles: network first (3.5 s timeout), saved copy only as a fallback.
//   - data.json, brief, version.json and sign-in redirects are never touched here.
// Every deploy stamps VERSION, so the browser sees a changed worker and installs it at once.
const VERSION = "__VERSION__";
const SHELL = "wire-shell-" + VERSION;
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-180.png", "icon-192.png"];
const TIMEOUT_MS = 3500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("wire-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.endsWith("/data.json") || p.endsWith("/brief") || p.endsWith("/version.json") || url.searchParams.has("reauth")) return;
  const key = e.request.mode === "navigate" ? "index.html" : e.request;
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await Promise.race([
        fetch(e.request, { redirect: "manual", cache: "no-cache" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      if (res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    } catch (err) {
      const saved = await cache.match(key);
      if (saved) return saved;
      throw err;
    }
  })());
});
