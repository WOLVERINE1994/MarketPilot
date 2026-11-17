// Minimal service worker so the dashboard can be installed as a phone app.
// Live prices must never come from a cache, so every request goes to the network;
// only the offline fallback page is cached.
const OFFLINE = "/offline.html";
self.addEventListener("install", event => {
  event.waitUntil(caches.open("mp-v1").then(cache => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate") return; // API, SSE and assets: plain network
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
