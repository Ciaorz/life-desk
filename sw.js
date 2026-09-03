/* ============================================================
 * sw.js  v9  — 生活工作台
 *
 * 设计原则（避免之前 v2/v3/v4/v5 的"坏 SW 卡死"事故）：
 *   1. 导航（HTML）走【网络优先】，永远不返回旧的/坏的缓存，绝不白屏。
 *   2. 子资源（.js / .css / .png / .webp / .json）走【缓存优先 + 后台静默更新】，
 *      离线时仍能秒开。
 *   3. 绝不拦截跨域请求，避免污染浏览器其它行为。
 *   4. activate 时只清理本 SW 自己的旧缓存，不动其他 SW 的。
 *   5. 任何 fetch 出错就静默放行（return undefined → 默认 fetch 行为），
 *      绝不让一个资源 404 把整个页面卡死。
 * ============================================================ */

const CACHE = 'lifedesk-v41-2026-09-03';

// 只缓存已知存在的、必须的子资源（白名单）。绝不强制 addAll 整个列表
// （之前 v5 因为引用了 4 个 404 文件导致整个 install 失败、SW 永远装不上）
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './three.min.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './images/pin-visited.png',
  './images/sprout-wish.png',
  // 3D 模型文件较大，由 fetch handler 按需懒缓存，不预下载
];

self.addEventListener('install', (event) => {
  // 单文件失败不阻断 install（关键：之前 v5 的死循环就是被这一步卡死的）
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((u) =>
          cache.add(new Request(u, { cache: 'no-cache' })).catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // 只清自己版本的旧缓存，不动其他 SW 的数据
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('lifedesk-') && k !== CACHE)
          .map((k) => caches.delete(k).catch(() => null))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只处理 GET、只处理同源
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求（HTML）：网络优先 → 离线时给上次缓存的 index.html
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // 网络正常：把新 HTML 顺手塞进缓存
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => null);
          }
          return resp;
        })
        .catch(() =>
          // 离线/网络挂了：返回缓存里的 index.html（绝不是空白响应）
          caches.match('./index.html').then((c) => c || new Response('<h1>离线</h1><p>请重新联网打开</p>', { headers: { 'Content-Type': 'text/html' } }))
        )
    );
    return;
  }

  // 子资源：缓存优先，后台静默拉取新版（stale-while-revalidate）
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => null);
          }
          return resp;
        })
        .catch(() => cached); // 离线时直接给缓存
      return cached || networkFetch;
    })
  );
});