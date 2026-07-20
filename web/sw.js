// Service worker — makes the PWA installable and lets the app shell load
// offline. The MediaPipe WASM/model and API calls are network-first (with a
// runtime cache) since they're large / dynamic.

const SHELL_CACHE = "bm-shell-v26";
const RUNTIME_CACHE = "bm-runtime-v1";

const SHELL = [
  "./",
  "./index.html",
  "./receiver.html",
  "./receiver.webmanifest",
  "./manifest.webmanifest",
  "./css/app.css",
  "./icons/icon.svg",
  "./js/app.js",
  "./js/version.js",
  "./js/config.js",
  "./js/notifications.js",
  "./js/ui/charts.js",
  "./js/core/types.js",
  "./js/core/lips.js",
  "./js/core/smoothing.js",
  "./js/core/stats.js",
  "./js/core/nostrils.js",
  "./js/core/ignore.js",
  "./js/core/talking.js",
  "./js/capture/camera.js",
  "./js/vision/faceLandmarker.js",
  "./js/vision/faceSensor.js",
  "./js/pipeline/pipeline.js",
  "./js/storage/uploader.js",
  "./js/storage/localStore.js",
  "./js/ui/overlay.js",
  "./js/ui/tabs.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never cache API POSTs

  const url = new URL(req.url);

  // Never cache metadata/stats API responses — always go to network.
  if (url.pathname.startsWith("/api/")) return;

  // App shell (same origin): cache-first.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
    return;
  }

  // Cross-origin (MediaPipe CDN, model): stale-while-revalidate.
  e.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
