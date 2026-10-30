// Keeps the driver page itself on the phone so it opens with no signal; entries made offline are
// queued by the page and sent when signal returns. API calls are never cached.
const CACHE = "yb-driver-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/driver", "/icon.png", "/driver-manifest.json"])).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (!["/driver", "/driver/", "/icon.png", "/driver-manifest.json"].includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("/driver"))));
});
