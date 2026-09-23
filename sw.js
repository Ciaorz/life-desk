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
 *   4. 跨域请求默认不拦截（避免污染浏览器其它行为）；
 *      ⚠️ 2026-09-24 起有【一个例外】：Cloudflare R2 上的封面 /api/img/**，
 *      因为封面搬到 R2 后成了跨域，不拦就完全没离线缓存（见下方 CLOUD_IMG_RE）。
 *   5. activate 时只清理本 SW 自己的旧缓存，不动其他 SW 的。
 *   6. 任何 fetch 出错就静默放行（return undefined → 默认 fetch 行为），
 *      绝不让一个资源 404 把整个页面卡死。
 * ============================================================ */

/* v96m：每次部署请 bump 这个版本号 —— 浏览器只有发现 sw.js 字节变了才会安装新 SW，
   版本号不变 → 手机上永远拿不到新的 app.js / style.css（这就是"PWA 不更新"的根因）。 */
/* v101（2026-09-18）：加了云同步上传 + 服务端查书，离线能力不受影响（逐条对照过）。
/* v103（2026-09-18）：这次改的仍是 app.js —— 加了「云同步下载 + 字段级合并」
   （☁ 面板里的「下载 / 全量下载」按钮），以及根治「手机录完刷新即丢」的
   mergeLoadData 并集逻辑（刷新加载第②步从「整份覆盖」改成「字段并集」）。
   ⚠️ 离线能力依旧不受影响，逐条对照过：
     - app.js / style.css 仍在 PRECACHE_URLS 里 → 断网照样能打开、能改数据
     - 图片仍在独立的 IMG_CACHE（cacheFirst，绝不回源）→ 离线封面不失效
     - /api/* 跨域调用被「只处理同源」放行 → SW 不掺和，断网静默降级
   所以 bump 版本号只是让新 app.js 尽快落地，不会牺牲离线。
   ⚠️ 这条改动最关键的一点：手机端必须拿到新版 app.js 才能修好「刷新即丢」，
   所以这次 push **务必** bump 版本号（否则手机永远跑旧逻辑）。 */
/* v106（2026-09-24）：封面搬到 Cloudflare R2 + 手机端改读 Cloudflare。
   ⚠️ 这一版**真的动了 SW 的缓存行为**（v103 那版只是让 app.js 尽快落地）：
     - fetch 处理器原来对跨域一律放行 → R2 上的封面（pages.dev/api/img/**）
       会被整个跳过、完全不缓存 → 出门没网封面全白。现在单独放行这一个路径走 cacheFirst。
     - cacheFirst 原来只存 resp.type === 'basic'，跨域带 CORS 的响应 type 是 'cors'
       会被丢掉；现在两者都存（'opaque' 仍然不存）。
   ⚠️ 线上 sw.js 曾被手工上传成 v104，所以这次直接跳到 v106 —— bump 前先查线上版本号，
      撞版本号 = 手机沿用旧缓存、先跑一遍旧 app.js。 */
const CACHE = 'lifedesk-v106-2026-09-24';

/* v96m：图片单独放一个「不随版本清理」的缓存桶。
   以前图片和代码共用 CACHE，每次部署 bump 版本号，activate 会把图片一起删光，
   于是离线封面全部失效、出门没网又得重新下载一遍所有图。现在代码随便升级，图片缓存不受影响。 */
const IMG_CACHE = 'lifedesk-imgs-v1';

// 只缓存已知存在的、必须的子资源（白名单）。绝不强制 addAll 整个列表
// （之前 v5 因为引用了 4 个 404 文件导致整个 install 失败、SW 永远装不上）
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',                /* 直接缓存源文件（本地优先，编辑即生效） */
  /* v95：three.min.js 已从预缓存移除——它改由 ensureEarthAssets() 进入遐方坞时按需加载，
     这里若预缓存，装 SW 时会白下 593KB，抵消首屏瘦身的收益。首次按需加载时仍会被 fetch 处理器缓存。 */
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

// v95：图片一律走 cache-first（本地优先）。
// 原因：封面是不可变的，原来也走 SWR，导致每次访问都把看过的图整份重下一次
// （平均 102KB × 上千张），这正是"缓存了但还是慢"的根因。
const IMG_RE = /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i;

/* 2026-09-24：封面搬到 Cloudflare R2（https://<项目>.pages.dev/api/img/...）之后，
   图片请求变成【跨域】。以前 fetch 处理器对跨域一律 `return` 放行 → SW 完全不缓存
   → 出门没网时封面全白，「离线看封面」这个核心体验直接坏掉。
   所以跨域也要拦 —— 但【只拦封面这一个路径】，其余跨域请求
   （/api/sync、/api/isbn、高德地图瓦片…）照旧放行，SW 绝不掺和业务接口。 */
const CLOUD_IMG_RE = /^\/api\/img\//;

function cacheAdd(cache, u) {
  return cache.add(new Request(u, { cache: 'no-cache' })).catch(() => null);
}

self.addEventListener('install', (event) => {
  // 单文件失败不阻断 install（关键：之前 v5 的死循环就是被这一步卡死的）
  /* v96o：不再自动 skipWaiting —— 否则新 SW 一装好就抢走控制权，用户没机会「手动」决定何时更新。
     现在新 SW 装好后停在 waiting 状态，由同步设置里的「抓取最新版本」按钮发 SKIP_WAITING 才接管。
     注：首次安装（没有旧 SW 在控）仍会自动激活，因为 activate 里 self.clients.claim() 会立即认领页面。 */
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE_URLS.map((u) => cacheAdd(cache, u)))
    )
  );
});

self.addEventListener('activate', (event) => {
  // 只清自己版本的旧缓存，不动其他 SW 的数据
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          /* v96m：排除 IMG_CACHE —— 升级代码版本时保留离线图片 */
          .filter((k) => k.startsWith('lifedesk-') && k !== CACHE && k !== IMG_CACHE)
          .map((k) => caches.delete(k).catch(() => null))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只处理 GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* 跨域：只接管 Cloudflare R2 上的封面（见 CLOUD_IMG_RE 注释），其余一律放行。
     放行是刻意的 —— /api/sync 这些业务接口必须让浏览器直接跟服务端说话，
     SW 一旦缓存它们，就会出现「明明同步过了还是旧数据」这种最难查的问题。 */
  if (url.origin !== self.location.origin) {
    if (CLOUD_IMG_RE.test(url.pathname)) event.respondWith(cacheFirst(req));
    return;
  }

  // 导航请求（HTML）：网络优先 → 离线时给上次缓存的 index.html
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // v95：图片本地优先——命中缓存直接返回，完全不发网络请求（离线也能看）
  if (IMG_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 子资源：stale-while-revalidate（命中缓存立即返回，后台静默更新）
  event.respondWith(staleWhileRevalidate(req, url));
});

// v95：图片专用——有缓存就用缓存，绝不回源；没缓存才下载并写入缓存
async function cacheFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  /* v96m：兼容旧版——升级前图片存在主 CACHE 里，先回退查一次并顺手搬进 IMG_CACHE，
     避免用户升级后「离线封面全没了」又要重下一次。 */
  try {
    const old = await caches.match(req);
    if (old) { cache.put(req, old.clone()).catch(() => null); return old; }
  } catch (e) {}
  try {
    const resp = await fetch(req);
    /* v96m：同源图 resp.type 是 'basic'；R2 上的封面是跨域但带 CORS 头的，type 是 'cors'。
       两种都得能存，否则搬到 R2 之后离线封面就全没了。
       'opaque'（跨域且没有 CORS 头）状态码读不到、内容也没法校验，坚决不存。 */
    if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
      await cache.put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    // 离线且没缓存：给一个空响应，不让单个图片把页面卡死
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

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

  /* v96m：后台更新改为「条件请求」——带上 If-None-Match / If-Modified-Since。
     服务器回 304 就表示文件没变，此时不下载任何响应体（只有几十字节的头部，几乎零流量），
     直接沿用缓存。改之前是无条件整份重下，几十个数据分片每次都白吃一遍流量，
     这正是"点一次最新就要重新下载所有旧数据"的原因。 */
  const cachedEtag = cached ? cached.headers.get('etag') : null;
  const cachedLM = cached ? cached.headers.get('last-modified') : null;
  const condHeaders = new Headers(req.headers);
  if (cachedEtag) condHeaders.set('If-None-Match', cachedEtag);
  else if (cachedLM) condHeaders.set('If-Modified-Since', cachedLM);

  const network = fetch(new Request(req, { headers: condHeaders }), { cache: 'no-store' })
    .then(async (resp) => {
      if (resp && resp.status === 304 && cached) return cached;   /* 未变化：零流量沿用缓存 */
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
      /* v96m：保留 IMG_CACHE —— 点「最新」只想刷代码和数据，不该把辛辛苦苦离线好的封面删掉 */
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== IMG_CACHE).map((k) => caches.delete(k).catch(() => null))
        )
      ).then(() => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true });
        }
      })
    );
  } else if (data.type === 'SKIP_WAITING') {
    /* v96o：手动更新按钮发来的「接管」指令 —— 让停在 waiting 的新 SW 立即激活，
       接管现有页面，随后页面侧会 reload 拉取新代码。 */
    event.waitUntil(
      self.skipWaiting().then(() => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'ACK' });
      })
    );
  }
});
