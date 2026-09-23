/* smoke_cloud_img.mjs —— 「封面搬到 Cloudflare R2」冒烟测试
 *
 * 覆盖 2026-09-24 方案1 的三处改动（抠真源码跑，不是重写的复刻品）：
 *   ① app.js  cloudImgUrl()    相对路径 → R2 绝对地址（含 data/images → data/thumbs 折算、中文 encode）
 *   ② app.js  resolveImgUrl()  非 FSA + 探测通过 → 用 R2；否则原样走 GitHub 相对路径
 *   ③ app.js  cloudImgProbe()  免认证探测（404=通 / 401=没开通 / 网络错=不通）+ 面板那行小字
 *   ④ sw.js   fetch 分发        跨域只接管 /api/img/**，其余跨域放行；
 *                               cacheFirst 要能存 type==='cors' 的响应（否则离线封面全白）
 *
 * 用法：node tools/smoke_cloud_img.mjs     （APP_PATH / SW_PATH 可喂坏副本验证测试会失败）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_PATH || join(HERE, '..', 'app.js');
const SW = process.env.SW_PATH || join(HERE, '..', 'sw.js');
const src = readFileSync(APP, 'utf8');
const swSrc = readFileSync(SW, 'utf8');

function sliceBetween(text, startMarker, endMarker, label) {
  const a = text.indexOf(startMarker);
  if (a < 0) { console.error('!! 找不到起点：' + startMarker + '（' + label + '）'); process.exit(1); }
  const b = text.indexOf(endMarker, a + startMarker.length);
  if (b < 0) { console.error('!! 找不到终点：' + endMarker + '（' + label + '）'); process.exit(1); }
  return text.slice(a, b);
}

/* ---------- 从 app.js 抠出需要的几段 ---------- */
const pImgDir   = sliceBetween(src, "var IMG_DIR = 'images';", 'var THUMB_DIR', 'IMG_DIR');
const pDataPfx  = sliceBetween(src, "var DATA_PREFIX = 'data';", '/* 每个模块用哪个字段当分片键 */', 'DATA_PREFIX');
const pNorm     = sliceBetween(src, 'function normalizeImgPath(u){', '/* ---------- 封面：非 FSA 模式改从 Cloudflare R2 取', 'normalizeImgPath');
const pCloudImg = sliceBetween(src, 'function cloudImgUrl(rel){', '/* ☁ 面板里那行「封面从哪来」 */', 'cloudImgUrl + cloudImgProbe');
const pImgLine  = sliceBetween(src, 'function cloudImgLine(){', 'function resolveImgUrl(u){', 'cloudImgLine');
const pResolve  = sliceBetween(src, 'function resolveImgUrl(u){', '/* v67：是不是「还没落盘」的图', 'resolveImgUrl');
const pThumbOf  = sliceBetween(src, 'function thumbOf(u){', 'function coverImg(row){', 'thumbOf');

/* ---------- 从 sw.js 抠出需要的几段 ---------- */
const swImgCache = sliceBetween(swSrc, "const IMG_CACHE = '", '// 只缓存已知存在的', 'IMG_CACHE');
const swConsts = sliceBetween(swSrc, 'const IMG_RE = /', "self.addEventListener('install'", 'IMG_RE + CLOUD_IMG_RE');
const swFetch  = sliceBetween(swSrc, "self.addEventListener('fetch', (event) => {", '// v95：图片专用', 'fetch 处理器');
const swCacheFirst = sliceBetween(swSrc, 'async function cacheFirst(req) {', 'async function networkFirstHTML(req) {', 'cacheFirst');

console.log('抠出源码：app %d + %d + %d + %d + %d + %d + %d 字节 / sw %d + %d + %d + %d 字节',
  pImgDir.length, pDataPfx.length, pNorm.length, pCloudImg.length, pImgLine.length,
  pResolve.length, pThumbOf.length, swImgCache.length, swConsts.length, swFetch.length, swCacheFirst.length);

/* 三段 sw 源码拼起来用（常量 + 分发 + cacheFirst），别各拼各的 */
const SW_BLOCK = swImgCache + '\n' + swConsts;

/* ---------- 计数 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(label + (extra ? '  → ' + extra : ''));
  return false;
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, label, '实际 ' + a + ' / 期望 ' + e);
}
let _secMark = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); _secMark = pass; }
function sectionEnd() { console.log('    （本节 ' + (pass - _secMark) + ' 项通过）'); }

/* ============================================================
 * 沙箱 1：app.js 的封面路径换算
 * ============================================================ */
function makeAppEnv(opts) {
  opts = opts || {};
  const ls = Object.assign({}, opts.ls || {});
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };
  const els = opts.els || {};
  const $ = (id) => els[id] || null;
  const log = { fetch: [] };

  const factory = new Function(
    'localStorage', '$', 'cloudBase', 'fetch', '_fsaHandle', '_imgUrlCache',
    'var _cloudImgBase = null, _cloudImgOk = null;\n' +
    pImgDir + '\n' + pDataPfx + '\n' + pNorm + '\n' + pCloudImg + '\n' + pImgLine + '\n' +
    pThumbOf + '\n' + pResolve + '\n' +
    'return { cloudImgUrl:cloudImgUrl, cloudImgProbe:cloudImgProbe, cloudImgLine:cloudImgLine,' +
    ' resolveImgUrl:resolveImgUrl, thumbOf:thumbOf, normalizeImgPath:normalizeImgPath,' +
    ' setBase:function(v){ _cloudImgBase = v; }, setOk:function(v){ _cloudImgOk = v; },' +
    ' getOk:function(){ return _cloudImgOk; } };'
  );

  const api = factory(
    localStorage, $,
    () => (opts.base === undefined ? 'https://life-desk-api.pages.dev' : opts.base),
    (u, o) => {
      log.fetch.push({ u, o });
      const r = opts.probe ? opts.probe(u) : { status: 404 };
      if (r === 'THROW') return Promise.reject(new Error('网络错误'));
      return Promise.resolve({ status: r.status });
    },
    opts.fsa ? {} : null,
    opts.cache || {}
  );
  return { api, log, ls, els };
}

/* ============================================================
 * ① cloudImgUrl —— 相对路径 → R2 绝对地址
 * ============================================================ */
section('① cloudImgUrl：相对路径 → R2 地址');
{
  const B = 'https://life-desk-api.pages.dev';
  const env = makeAppEnv({});

  eq(env.api.cloudImgUrl('data/thumbs/x/a.webp'),
    B + '/api/img/data/thumbs/x/a.webp', '① thumbs 路径原样映射');
  eq(env.api.cloudImgUrl('data/images/x/a.jpg'),
    B + '/api/img/data/thumbs/x/a.webp',
    '① ★ data/images/x/a.jpg 折成 data/thumbs/x/a.webp（R2 上只有缩略图）');
  eq(env.api.cloudImgUrl('data/images/x/a.png'),
    B + '/api/img/data/thumbs/x/a.webp', '① png 也折成 .webp');
  eq(env.api.cloudImgUrl('images/x/a.jpg'),
    B + '/api/img/data/thumbs/x/a.webp', '① 旧数据缺 data/ 前缀 → normalizeImgPath 补上后再折');

  const cn = env.api.cloudImgUrl('data/images/徽章-封面/皮卡丘 01.jpg');
  eq(cn, B + '/api/img/data/thumbs/%E5%BE%BD%E7%AB%A0-%E5%B0%81%E9%9D%A2/%E7%9A%AE%E5%8D%A1%E4%B8%98%2001.webp',
    '① ★ 中文与空格逐段 encodeURIComponent（斜杠保持原样）');
  ok(cn.indexOf(' ') < 0, '① URL 里不能有裸空格');
  ok(cn.split('/').slice(5).join('/').indexOf('%2F') < 0, '① 斜杠不能被编码成 %2F（worker 靠它切路径）');

  eq(env.api.cloudImgUrl(''), '', '① 空路径 → 空串');
  eq(env.api.cloudImgUrl(null), '', '① null → 空串');

  /* 没配 Cloudflare → 返回空串，让调用方回退相对路径 */
  const envNo = makeAppEnv({ base: '' });
  eq(envNo.api.cloudImgUrl('data/images/x/a.jpg'), '', '① 没配 API 地址 → 空串（回退相对路径）');

  /* _cloudImgBase 有缓存，但 setBase 之后要能立刻反映 */
  const env2 = makeAppEnv({ base: 'https://a.test' });
  eq(env2.api.cloudImgUrl('data/thumbs/x/a.webp'), 'https://a.test/api/img/data/thumbs/x/a.webp', '① 基址 a');
  env2.api.setBase('https://b.test');
  eq(env2.api.cloudImgUrl('data/thumbs/x/a.webp'), 'https://b.test/api/img/data/thumbs/x/a.webp',
    '① 基址缓存被清掉后立刻换到新地址');
  sectionEnd();
}

/* ============================================================
 * ② resolveImgUrl —— 什么时候用 R2、什么时候用相对路径
 * ============================================================ */
section('② resolveImgUrl：R2 / 相对路径 / FSA 三条分支');
{
  const B = 'https://life-desk-api.pages.dev';

  /* 手机端（无 FSA）+ 探测通过 → R2 */
  const e1 = makeAppEnv({});
  e1.api.setOk(true);
  eq(e1.api.resolveImgUrl('data/images/x/a.jpg'), B + '/api/img/data/thumbs/x/a.webp',
    '② ★ 非 FSA + 探测通过 → 走 R2');

  /* 手机端 + 探测没通过（worker 还没重拖）→ 相对路径 */
  const e2 = makeAppEnv({});
  e2.api.setOk(false);
  eq(e2.api.resolveImgUrl('data/images/x/a.jpg'), 'data/images/x/a.jpg',
    '② ★ 探测没通过 → 原样相对路径（继续走 GitHub Pages，不裂 401）');

  /* 探测结果未知（还没探完）→ 也要走相对路径，不能盲切 */
  const e2b = makeAppEnv({});
  eq(e2b.api.resolveImgUrl('data/images/x/a.jpg'), 'data/images/x/a.jpg',
    '② 探测未完成（null）→ 先走相对路径，等探完重绘再切');

  /* 没配 Cloudflare → 相对路径 */
  const e3 = makeAppEnv({ base: '' });
  e3.api.setOk(true);
  eq(e3.api.resolveImgUrl('data/images/x/a.jpg'), 'data/images/x/a.jpg',
    '② 没配 API 地址 → 相对路径');

  /* FSA（电脑端连了本地目录）：走 _imgUrlCache 里的 blob，绝不能变成 R2 地址 */
  const e4 = makeAppEnv({ fsa: true, cache: { 'data/images/x/a.jpg': 'blob:https://site/abc' } });
  e4.api.setOk(true);
  eq(e4.api.resolveImgUrl('data/images/x/a.jpg'), 'blob:https://site/abc',
    '② ★ FSA 模式 → 用本地 blob，不走 R2');

  /* 已经是绝对地址 / data: / blob: → 原样 */
  const e5 = makeAppEnv({});
  e5.api.setOk(true);
  eq(e5.api.resolveImgUrl('https://cdn.test/a.jpg'), 'https://cdn.test/a.jpg', '② 外链原样返回');
  eq(e5.api.resolveImgUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', '② data: 原样返回');
  eq(e5.api.resolveImgUrl('blob:https://site/x'), 'blob:https://site/x', '② blob: 原样返回');
  eq(e5.api.resolveImgUrl(''), '', '② 空串 → 空串');

  /* _imgUrlCache 命中优先于 R2（FSA 之外的场景也可能有缓存，比如刚上传的图） */
  const e6 = makeAppEnv({ cache: { 'data/images/x/a.jpg': 'blob:https://site/hit' } });
  e6.api.setOk(true);
  eq(e6.api.resolveImgUrl('data/images/x/a.jpg'), 'blob:https://site/hit',
    '② 缓存命中优先（比 R2 更靠前）');
  sectionEnd();
}

/* ============================================================
 * ③ cloudImgProbe —— 免认证探测 + 面板那行字
 * ============================================================ */
section('③ cloudImgProbe / cloudImgLine');
{
  const cases = [
    { status: 404, want: true, why: '404 = 能进到业务分支 → 免认证已开通' },
    { status: 200, want: true, why: '200（万一探到真文件）也算通' },
    { status: 401, want: false, why: '401 = worker 还是旧版，读要令牌' },
    { status: 403, want: false, why: '403 同样视为没开通' },
    { status: 500, want: true, why: '5xx 不是认证问题 → 仍可尝试（真 500 时图片自己会失败）' },
  ];
  for (const c of cases) {
    const env = makeAppEnv({ probe: () => ({ status: c.status }) });
    let got = null;
    env.api.cloudImgProbe((v) => { got = v; });
    await new Promise((r) => setTimeout(r, 5));
    eq(got, c.want, '③ HTTP ' + c.status + ' → ' + c.want + '（' + c.why + '）');
  }

  /* 网络错 → false */
  {
    const env = makeAppEnv({ probe: () => 'THROW' });
    let got = null;
    env.api.cloudImgProbe((v) => { got = v; });
    await new Promise((r) => setTimeout(r, 5));
    eq(got, false, '③ 网络异常 → false（不切 R2）');
  }

  /* 没配地址 → false，且一个请求都不发 */
  {
    const env = makeAppEnv({ base: '' });
    let got = null;
    env.api.cloudImgProbe((v) => { got = v; });
    await new Promise((r) => setTimeout(r, 5));
    eq(got, false, '③ 没配 API 地址 → false');
    eq(env.log.fetch.length, 0, '③ 没配地址 → 不发请求');
  }

  /* 探到的是「不存在的 key」→ 必须是 404 才能判定通；顺便确认请求路径 */
  {
    const env = makeAppEnv({ probe: () => ({ status: 404 }) });
    env.api.cloudImgProbe(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const u = env.log.fetch[0].u;
    ok(u.indexOf('/api/img/data/thumbs/__probe__.webp') >= 0, '③ 探的路径是 /api/img/data/thumbs/__probe__.webp', u);
    ok(env.log.fetch[0].o && env.log.fetch[0].o.cache === 'no-store', '③ 探测请求带 cache:no-store（别被 SW/HTTP 缓存骗）');
  }

  /* 只探一次：第二次直接回缓存值，不再发请求 */
  {
    const env = makeAppEnv({ probe: () => ({ status: 404 }) });
    env.api.cloudImgProbe(() => {});
    await new Promise((r) => setTimeout(r, 5));
    let second = null;
    env.api.cloudImgProbe((v) => { second = v; });
    eq(second, true, '③ 第二次调用同步拿到缓存结果');
    eq(env.log.fetch.length, 1, '③ ★ 只发一次探测请求（第二次不再发）');
  }

  /* 面板那行字 */
  {
    const el = { textContent: '', style: {} };
    const env = makeAppEnv({ els: { cloudImgLine: el } });
    env.api.cloudImgLine();
    ok(/探测/.test(el.textContent), '③ 未知状态 → 显示「正在探测…」', el.textContent);

    env.api.setOk(true); env.api.cloudImgLine();
    ok(/Cloudflare R2/.test(el.textContent), '③ 通了 → 显示「来自 Cloudflare R2」', el.textContent);
    eq(el.style.color, '#1a7f37', '③ 通了用绿色');

    env.api.setOk(false); env.api.cloudImgLine();
    ok(/GitHub 仓库/.test(el.textContent), '③ 没通 → 显示走 GitHub 仓库', el.textContent);
    ok(/_worker\.js/.test(el.textContent), '③ 没通时告诉用户要重新拖 _worker.js', el.textContent);
    eq(el.style.color, '#c77700', '③ 没通用橙色');

    /* 面板不存在时不能炸 */
    const envNo = makeAppEnv({});
    let threw = false;
    try { envNo.api.cloudImgLine(); } catch (e) { threw = true; }
    ok(!threw, '③ 面板不存在时 cloudImgLine 不炸');
  }
  sectionEnd();
}

/* ============================================================
 * ④ sw.js —— 跨域封面的缓存分发
 * ============================================================ */
section('④ sw.js：fetch 分发 + cacheFirst 认 cors');
{
  const ORIGIN = 'https://ciaorz.github.io';
  const IMG_CACHE = 'lifedesk-imgs-v1';

  function makeSw(opts) {
    opts = opts || {};
    const handlers = [];
    const self = {
      location: { origin: ORIGIN },
      addEventListener(type, fn) { if (type === 'fetch') handlers.push(fn); },
    };
    const store = new Map(Object.entries(opts.cache || {}));
    const opened = [];
    const caches = {
      open: async (name) => {
        opened.push(name);
        return {
          match: async (req) => store.get(typeof req === 'string' ? req : req.url) || undefined,
          put: async (req, resp) => { store.set(typeof req === 'string' ? req : req.url, resp); },
        };
      },
      match: async (req) => store.get(typeof req === 'string' ? req : req.url) || undefined,
    };
    const fetched = [];
    const fetchFn = (req) => {
      fetched.push(typeof req === 'string' ? req : req.url);
      const r = opts.network ? opts.network(req) : { status: 200, type: 'cors', clone() { return this; } };
      if (r === 'THROW') return Promise.reject(new Error('offline'));
      return Promise.resolve(r);
    };
    const factory = new Function(
      'self', 'caches', 'fetch', 'Response', 'Request', 'Headers', 'URL',
      'networkFirstHTML', 'staleWhileRevalidate',
      'function networkFirstHTML(r){ return "networkFirstHTML"; }\n' +
      'function staleWhileRevalidate(r, u){ return "staleWhileRevalidate"; }\n' +
      SW_BLOCK + '\n' + swFetch + '\n' + swCacheFirst + '\n' +
      'return { CLOUD_IMG_RE:CLOUD_IMG_RE, IMG_RE:IMG_RE, cacheFirst:cacheFirst, store:null };'
    );
    factory(self, caches, fetchFn, Response, Request, Headers, URL,
      () => 'networkFirstHTML', () => 'staleWhileRevalidate');
    return { handlers, self, store, opened, fetched, caches, fetchFn, IMG_CACHE };
  }

  function fire(env, url, extra) {
    let captured;
    let called = false;
    const req = Object.assign({
      method: 'GET', url, mode: 'no-cors', headers: new Headers(),
    }, extra || {});
    env.handlers[0]({ request: req, respondWith(p) { called = true; captured = p; } });
    return { called, captured };
  }

  /* 同源图片 → cacheFirst（用 404 做哨兵：注入的两个桩返回的是字符串，只有 cacheFirst 会回传对象） */
  {
    const env = makeSw({ network: () => ({ status: 404 }) });
    const r = fire(env, ORIGIN + '/life-desk/data/thumbs/x/a.webp');
    ok(r.called, '④ 同源 .webp → 被 SW 接管');
    eq((await r.captured).status, 404, '④ 同源图片走 cacheFirst（回传的是网络响应对象，不是桩的字符串）');
  }
  /* 跨域 /api/img/** → 也要接管（这次改动的核心） */
  {
    const env = makeSw({});
    const r = fire(env, 'https://life-desk-api.pages.dev/api/img/data/thumbs/x/a.webp');
    ok(r.called, '④ ★ 跨域 /api/img/** 被接管（否则离线封面全白）');
  }
  /* 跨域 /api/sync → 必须放行，SW 绝不掺和业务接口 */
  {
    const env = makeSw({});
    const r = fire(env, 'https://life-desk-api.pages.dev/api/sync?since=0');
    ok(!r.called, '④ ★ 跨域 /api/sync 放行（缓存它会出现「同步过了还是旧数据」）');
  }
  /* 跨域 /api/img-batch → 不匹配 /api/img/（没斜杠），放行 */
  {
    const env = makeSw({});
    const r = fire(env, 'https://life-desk-api.pages.dev/api/img-batch');
    ok(!r.called, '④ /api/img-batch 不匹配 /api/img/ → 放行');
  }
  /* 跨域其它资源（高德瓦片）→ 放行 */
  {
    const env = makeSw({});
    const r = fire(env, 'https://webrd01.is.autonavi.com/appmaptile?x=1');
    ok(!r.called, '④ 高德地图瓦片等其它跨域 → 放行');
  }
  /* 同源 app.js → SWR */
  {
    const env = makeSw({});
    const r = fire(env, ORIGIN + '/life-desk/app.js');
    ok(r.called, '④ 同源 app.js → 接管');
    eq(await r.captured, 'staleWhileRevalidate', '④ 同源 app.js 走 staleWhileRevalidate');
  }
  /* 导航 → networkFirstHTML */
  {
    const env = makeSw({});
    const r = fire(env, ORIGIN + '/life-desk/', { mode: 'navigate' });
    eq(await r.captured, 'networkFirstHTML', '④ 导航请求走 networkFirstHTML');
  }
  /* 非 GET → 一律不管 */
  {
    const env = makeSw({});
    const r = fire(env, 'https://life-desk-api.pages.dev/api/img/data/thumbs/x.webp', { method: 'PUT' });
    ok(!r.called, '④ PUT 不接管（写操作让浏览器直连）');
  }

  /* cacheFirst：跨域带 CORS 的 200 必须存进 IMG_CACHE */
  {
    const env = makeSw({ network: () => ({ status: 200, type: 'cors', clone() { return this; } }) });
    const url = 'https://life-desk-api.pages.dev/api/img/data/thumbs/x/a.webp';
    const resp = await env.caches.open(IMG_CACHE).then(() => null);   // 只为建桶
    const out = await (new Function(
      'self', 'caches', 'fetch', 'Response', 'Request', 'Headers', 'URL',
      SW_BLOCK + '\n' + swCacheFirst + '\nreturn cacheFirst;'
    ))(env.self, env.caches, env.fetchFn, Response, Request, Headers, URL)(new Request(url));
    eq(out && out.status, 200, '④ cacheFirst 把网络响应返回给页面');
    ok(env.store.has(url), '④ ★ type===\'cors\' 的 200 被写进 IMG_CACHE（离线封面靠它）');
    ok(env.opened.indexOf(IMG_CACHE) >= 0, '④ 确实开的是 IMG_CACHE 这个桶：' + JSON.stringify(env.opened));
  }
  /* cacheFirst：opaque 响应不能存（状态码读不到，没法校验） */
  {
    const env = makeSw({ network: () => ({ status: 200, type: 'opaque', clone() { return this; } }) });
    const url = 'https://life-desk-api.pages.dev/api/img/data/thumbs/x/b.webp';
    await (new Function(
      'self', 'caches', 'fetch', 'Response', 'Request', 'Headers', 'URL',
      SW_BLOCK + '\n' + swCacheFirst + '\nreturn cacheFirst;'
    ))(env.self, env.caches, env.fetchFn, Response, Request, Headers, URL)(new Request(url));
    ok(!env.store.has(url), '④ opaque 响应不存（存了也读不出内容）');
  }
  /* cacheFirst：命中缓存就绝不回源 */
  {
    const cachedResp = { status: 200, type: 'cors' };
    const env = makeSw({ cache: { 'https://life-desk-api.pages.dev/api/img/data/thumbs/x/a.webp': cachedResp } });
    const url = 'https://life-desk-api.pages.dev/api/img/data/thumbs/x/a.webp';
    const out = await (new Function(
      'self', 'caches', 'fetch', 'Response', 'Request', 'Headers', 'URL',
      SW_BLOCK + '\n' + swCacheFirst + '\nreturn cacheFirst;'
    ))(env.self, env.caches, env.fetchFn, Response, Request, Headers, URL)(new Request(url));
    eq(out, cachedResp, '④ 命中缓存直接返回缓存对象');
    eq(env.fetched.length, 0, '④ ★ 命中缓存时一个网络请求都不发（离线可看封面）');
  }
  /* 版本号必须已经 bump 过（否则手机沿用旧缓存） */
  {
    const m = /const CACHE = '([^']+)'/.exec(swSrc);
    ok(!!m, '④ sw.js 里有 CACHE 常量');
    ok(m && !/v105/.test(m[1]), '④ ★ CACHE 不能还停在 v105（改动后必须 bump）', m && m[1]);
  }
  sectionEnd();
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(56));
if (fail) {
  console.log('失败 %d 项：', fail);
  failures.forEach((f) => console.log('  ✗ ' + f));
  console.log('通过 %d / 失败 %d', pass, fail);
  process.exit(1);
}
console.log('通过 %d / 失败 %d', pass, fail);
console.log('全部通过 ✅');
