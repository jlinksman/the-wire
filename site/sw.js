// The Wire — service worker. Goals, in order: never stop the app from opening, always
// run the newest deployed version, and still open when offline.
//   - Opening the app (navigation): the browser's own request, untouched, so sign-in
//     redirects and slow connections behave exactly as without a service worker. Only
//     if the network fails outright does the saved copy of the page open instead.
//   - Script, styles, icons: network first, saved copy if the network fails.
//   - data.json, brief, version.json and sign-in requests are never touched.
// Every deploy stamps VERSION, so the browser sees a changed worker and installs it.
const VERSION = "__VERSION__";
const SHELL = "wire-shell-" + VERSION;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("wire-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.endsWith("/data.json") || p.endsWith("/brief") || p.endsWith("/version.json") || p.startsWith("/cdn-cgi/") || url.searchParams.has("reauth")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(SHELL).then((c) => c.put("index.html", copy)); }
      return res;
    }).catch(async () => (await (await caches.open(SHELL)).match("index.html")) || Response.error()));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await (await caches.open(SHELL)).match(req)) || Response.error()));
});
