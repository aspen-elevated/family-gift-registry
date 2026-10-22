/* Family Gift Registry service worker.
   Makes the home-screen app open fast: the page itself is fetched fresh when the
   network answers quickly and comes from the saved copy when it doesn't.
   Registry data (Google Apps Script) is never cached here. */
var VERSION = 'gr-kit-shell-v1';
var FONTS = 'gr-kit-fonts-v1';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'mock-api.js', 'apps-script/Core.js',
  'manifest.webmanifest', 'assets/topo.svg', 'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== FONTS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return caches.open(VERSION).then(function (cache) {
    var net = fetch(req).then(function (res) { if (res.ok) cache.put(req, res.clone()); return res; });
    var slow = new Promise(function (resolve) { setTimeout(resolve, 3500); });
    var cached = function () { return cache.match(req, { ignoreSearch: true }); };
    // Use the network if it answers within 3.5 s; otherwise the saved copy (and keep updating it).
    return Promise.race([net, slow.then(cached)]).then(function (res) { return res || net; })
      .catch(function () { return cached().then(function (res) { return res || caches.match('./'); }); });
  });
}
function cacheFirst(req, name) {
  return caches.open(name).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (/\.(png|svg|jpg|webp)$/.test(url.pathname)) e.respondWith(cacheFirst(req, VERSION));
    else e.respondWith(networkFirst(req));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(cacheFirst(req, FONTS));
  // everything else (Apps Script, store images) goes straight to the network
});
