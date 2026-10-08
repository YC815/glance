// 離線時也打得開：自己的檔案先問網路、失敗才用快取；字型用快取優先。
// /api/ 不經過這裡（前端自己把最後一筆存在 localStorage）。
var CACHE = "glance-v1";
var SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.indexOf("/api/") !== -1) return;
    event.respondWith(
      fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match("index.html"); });
      })
    );
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
  }
});
