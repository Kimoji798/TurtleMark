/* TurtleMark Service Worker：应用外壳离线缓存 */
const CACHE = 'turtlemark-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 应用外壳：缓存优先
  if (ASSETS.some(a => url.pathname.endsWith(a.replace('./', '')) || url.pathname.endsWith('/'))) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  // AI 模型与 onnxruntime 资源：网络优先，成功后写入缓存（下次离线可用）
  if (url.pathname.includes('/assets/onnx/') || url.pathname.includes('/assets/model/')) {
    event.respondWith(
      caches.match(req).then(hit => {
        const network = fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    );
    return;
  }

  // 其他同源请求：网络优先，失败回退缓存
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
