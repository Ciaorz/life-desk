/* ============================================================
 * sw.js  v14  — 生活工作台
 *
 * 设计原则（沿用 v13 的安全底线，v14 提速）：
 *   1. 导航（HTML）走【网络优先】，永远不返回旧的/坏的缓存，绝不白屏。
 *   2. 子资源（.js / .css / .png / .webp / .json）走【stale-while-revalidate】：
 *      —— 命中缓存立即返回（重复访问秒开，不再每次都回源拉 600KB 的 app.min.js）；
 *      —— 同时后台静默 fetch 最新版写回缓存，下次访问就是新的。
 *   3. 关键资源（app.min.js / style.css）后台拿到新版且 ETag 变化时，发消息让页面
 *      静默刷新一次，保证部署后仍能自动拿到新版（呼应 v59「部署即刷新」的诉求），
 *      SW 生命周期内至多触发一次，页面侧再加时间闸门，杜绝死循环。
 *   4. 绝不拦截跨域请求，避免污染浏览器其它行为。
 *   5. activate 时只清理本 SW 自己的旧缓存，不动其他 SW 的。
 *   6. 任何 fetch 出错就静默放行（return undefined → 默认 fetch 行为），
 *      绝不让一个资源 404 把整个页面卡死。
 * ============================================================ */

const CACHE = 'lifedesk-v62-2026-09-09';

// 只缓存已知存在的、必须的子资源（白名单）。绝不强制 addAll 整个列表
// （之前 v5 因为引用了 4 个 404 文件导致整个 install 失败、SW 永远装不上）
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.min.js',            /* v83：改用压缩版（app.js 仍保留为源文件） */
  './three.min.js',
  './marker-icons.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './images/pin-visited.png',
  './images/sprout-wish.png',
  // 3D 模型文件较大，由 fetch handler 按需懒缓存，不预下载
];

// 关键资源：后台更新且内容变化时，通知页面静默刷新一次
const CRITICAL = /\/(?:app\.min\.js|app\.js|style\.css)(?:[?#]|$)/;

function cacheAdd(cache, u) {
  return cache.add(new Request(u, { cache: 'no-cache' })).catch(() => null);
}

self.addEventListener('install', (event) => {
  // 单文件失败不阻断 install（关键：之前 v5 的死循环就是被这一步卡死的）
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE_URLS.map((u) => cacheAdd(cache, u)))
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
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // 子资源：stale-while-revalidate（命中缓存立即返回，后台静默更新）
  event.respondWith(staleWhileRevalidate(req, url));
});

async function networkFirstHTML(req) {
  try {
    const resp = await fetch(req, { cache: 'no-store' });
    if (resp && resp.status === 200) {
      const clone = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => null);
    }
    return resp;
  } catch (e) {
    // 离线/网络挂了：返回缓存里的 index.html（绝不是空白响应）
    const c = await caches.match('./index.html');
    return c || new Response('<h1>离线</h1><p>请重新联网打开</p>', { headers: { 'Content-Type': 'text/html' } });
  }
}

async function staleWhileRevalidate(req, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const isCritical = CRITICAL.test(url.pathname);

  // 缓存里的签名（ETag 优先，没有就用 Last-Modified 兜底）
  const cachedSig = cached
    ? (cached.headers.get('etag') || cached.headers.get('last-modified'))
    : null;

  const network = fetch(req, { cache: 'no-store' })
    .then(async (resp) => {
      if (resp && resp.status === 200 && resp.type === 'basic') {
        await cache.put(req, resp.clone());
        if (isCritical) {
          const newSig = resp.headers.get('etag') || resp.headers.get('last-modified');
          if (cachedSig && newSig && cachedSig !== newSig) {
            notifyUpdate(url.pathname);
          }
        }
      }
      return resp;
    })
    .catch(() => cached);

  // 有缓存就立即返回缓存（秒开），没有才等网络
  return cached || network;
}

// 整个 SW 生命周期内至多通知一次，避免部署后反复重载
let _notified = false;
function notifyUpdate(path) {
  if (_notified) return;
  _notified = true;
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => c.postMessage({ type: 'SUBRES_UPDATED', url: path }));
  });
}

/* v60：页面端「获取最新数据」按钮发来的清空指令——把本 SW 名下的所有缓存删掉，
   确保下一次网络请求一定能拉到服务器上的最新文件（app.min.js / data/*.json 等）。 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PURGE_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => caches.delete(k).catch(() => null)))
      ).then(() => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true });
        }
      })
    );
  }
});
