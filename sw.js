// Service Worker：缓存应用壳 + 数据，使 App 离线可用（底图瓦片需联网）。
const CACHE = "shuili-app-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/store.js",
  "./js/io.js",
  "./js/app.js",
  "./data.json",
  "./lib/leaflet.css",
  "./lib/leaflet.js",
  "./lib/images/marker-icon.png",
  "./lib/images/marker-icon-2x.png",
  "./lib/images/marker-shadow.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 天地图瓦片与第三方请求：网络优先，失败回退缓存
  if (url.hostname.includes("tianditu") || url.hostname.includes("arcgisonline")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // 本地资源：缓存优先，同时后台更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((resp) => {
        if (resp && resp.status === 200 && resp.type === "basic") {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
