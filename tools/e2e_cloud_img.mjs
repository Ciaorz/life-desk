/* ============================================================
 * e2e_cloud_img.mjs —— 「封面从 Cloudflare R2 取」端到端测试（真浏览器 + 真线上站点）
 * ------------------------------------------------------------
 * 为什么必须存在：
 *   封面这条路线上有一个**只有真浏览器才暴露**的死法：
 *   图片走 CSS background-image / <img src>，这两种请求**带不了 Authorization 头**。
 *   只要 worker 那边的读接口还要认证，所有封面就会静默裂成一片 401 —— 页面上只是"图没了"，
 *   不报任何错，纯逻辑单测永远测不出来。
 *   所以这里必须开真浏览器、接 Network 事件，逐条看图片响应的**真实状态码**。
 *
 * 它做什么（全自动）：
 *   ① 清空 localStorage / IndexedDB / SW / Cache Storage（模拟手机第一次打开）
 *   ② 配好 Cloudflare 地址 + 令牌，刷新
 *   ③ 进「藏品馆」，**再点一个分类磁贴**（[data-act="zone"]），封面才真的渲染出来
 *   ④ 用 CDP Network 事件收集所有封面请求（/api/img/** 或 /data/thumbs|images/**）与状态码
 *   ⑤ 断言：每一条封面请求都是 200；请求路径与面板那行「封面从哪来」自洽
 *
 * ⚠️ 两个踩过的坑，改这个脚本前先看：
 *   · 藏品馆**首页没有封面**，只有分类磁贴（手办/周边/杯盏…）。
 *     只点到首页就断言，会得到「封面请求 0 个」的假失败。必须再点一层 zone。
 *   · 客户端自己会发一次探测请求 cloudImgProbe()（GET 一个不存在的
 *     /api/img/data/thumbs/__probe__.webp）。worker 没重拖时它**必然 401**，
 *     那是设计好的信号。统计封面时必须把 __probe__ 摘掉，否则断言永远红。
 *
 * ⚠️ 这个测试**两种状态都算通过**，因为客户端有「免认证探测」兜底：
 *      · worker 已重拖（读免认证）→ 封面走 /api/img/**，面板显示「来自 Cloudflare R2」
 *      · worker 还是旧版        → 封面走 /data/**，面板显示「走 GitHub 仓库」
 *   两种情况都必须「全部 200」。真正要防的是「切到 R2 了但全是 401」这种半吊子状态。
 *
 * 用法：
 *     # 先起无头浏览器（⚠️ 必须用 run_in_background，行尾 & 会被工具调用结束时杀掉）
 *     "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *       --headless=new --disable-gpu --no-sandbox \
 *       --remote-debugging-port=9225 \
 *       --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-9225" about:blank
 *
 *     CDP_PORT=9225 node tools/e2e_cloud_img.mjs
 *
 * 需要令牌文件 `E:\自制软件\cloud flare D1 R2.txt`（最后一行是 SYNC_TOKEN）。
 * ============================================================ */

import { existsSync, readFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const SITE = process.env.SITE || 'https://ciaorz.github.io/life-desk/';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; failures.push(label + (extra ? ' → ' + extra : '')); console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, label, '实际 ' + A + ' / 期望 ' + B); }

if (!existsSync(TOKEN_FILE)) { console.error('找不到令牌文件：' + TOKEN_FILE); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();

/* ---------- 极简 CDP 客户端 ---------- */
async function connect() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch (e) {
    console.error(`\n连不上 CDP（127.0.0.1:${PORT}）。先起一个无头浏览器：\n`);
    console.error('  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \\');
    console.error('    --headless=new --disable-gpu --no-sandbox \\');
    console.error(`    --remote-debugging-port=${PORT} \\`);
    console.error('    --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-' + PORT + '" about:blank\n');
    console.error('⚠️ 必须用 run_in_background 起，行尾 & 起的进程会在本次工具调用结束时被杀。\n');
    process.exit(2);
  }
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('没有 page 目标'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method) events.push(m);
  };
  return {
    events,
    close: () => ws.close(),
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((res) => waiting.set(mid, res));
    },
    async eval(expr, awaitPromise = false) {
      const r = await this.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise, userGesture: true,
      });
      if (r.result && r.result.exceptionDetails) {
        const ed = r.result.exceptionDetails;
        throw new Error('页面内异常: ' + ((ed.exception && ed.exception.description) || ed.text));
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    },
  };
}

/* ---------- 页面侧探查 ---------- */
const PROBE = `(function(){
  var bgs = document.querySelectorAll('[style*="background-image"]');
  var n = 0, api = 0, rel = 0, sample = [];
  for (var i = 0; i < bgs.length; i++){
    var s = bgs[i].getAttribute('style') || '';
    var isApi = s.indexOf('/api/img/') >= 0;
    var isRel = s.indexOf('data/thumbs/') >= 0 || s.indexOf('data/images/') >= 0;
    /* 只认「封面」。页面上还有一堆模块装饰图（images/museum-bg.png 之类），
       它们也带 background-image，混进来会让「渲染出封面了吗」永远为真。 */
    if (!isApi && !isRel) continue;
    n++;
    if (isApi) api++; else rel++;
    if (sample.length < 3) sample.push(s.slice(0, 130));
  }
  var imgs = document.querySelectorAll('img[src]');
  var imgApi = 0, imgRel = 0;
  for (var j = 0; j < imgs.length; j++){
    var u = imgs[j].getAttribute('src') || '';
    if (u.indexOf('/api/img/') >= 0) imgApi++;
    else if (u.indexOf('data/thumbs/') >= 0 || u.indexOf('data/images/') >= 0) imgRel++;
  }
  return {
    imgLine: (document.getElementById('cloudImgLine') || {}).textContent || '',
    srcLine: (document.getElementById('cloudSrcLine') || {}).textContent || '',
    loadSrc: localStorage.getItem('lifedesk_load_src') || '',
    bgAll: bgs.length,
    covers: n, coverApi: api, coverRel: rel, sample: sample,
    imgTags: imgs.length, imgApi: imgApi, imgRel: imgRel,
  };
})()`;

function collectImageResponses(cdp) {
  const byId = new Map();
  cdp.events.forEach((e) => {
    if (e.method === 'Network.requestWillBeSent') byId.set(e.params.requestId, e.params.request.url);
    if (e.method === 'Network.responseReceived') {
      const u = byId.get(e.params.requestId) || e.params.response.url;
      byId.set(e.params.requestId, { url: u, status: e.params.response.status, mime: e.params.response.mimeType });
    }
  });
  const out = [];
  byId.forEach((v) => {
    if (!v || typeof v === 'string') return;
    if (v.url.indexOf('/api/img/') >= 0 || v.url.indexOf('/data/thumbs/') >= 0 || v.url.indexOf('/data/images/') >= 0) out.push(v);
  });
  return out;
}

/* ---------- 主流程 ---------- */
let cdp = null;
let exitCode = 0;
try {
  cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  /* 移动端仿真：三条一起设，否则 IS_MOBILE 判定落空、走的是桌面分支（USE_THUMBS=false） */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  console.log('\n=== 1. 打开线上站点并彻底清干净（模拟手机第一次打开） ===');
  console.log('  站点：' + SITE);
  await cdp.eval(`location.href = ${JSON.stringify(SITE)}`);
  await sleep(6000);
  await cdp.eval(`(async function(){
    try { localStorage.clear(); } catch(e){}
    await new Promise(function(res){ var r = indexedDB.deleteDatabase('lifedesk');
      r.onsuccess=function(){res(1)}; r.onerror=function(){res(0)}; r.onblocked=function(){res(0)}; });
    try { var rs = await navigator.serviceWorker.getRegistrations();
          for (var i=0;i<rs.length;i++) await rs[i].unregister(); } catch(e){}
    try { var ks = await caches.keys(); for (var j=0;j<ks.length;j++) await caches.delete(ks[j]); } catch(e){}
    return 1;
  })()`, true);

  console.log('\n=== 2. 配好 Cloudflare 并刷新 ===');
  await cdp.eval(`(function(){
    localStorage.setItem('lifedesk_cloud', JSON.stringify(${JSON.stringify({ apiBase: BASE, token: TOKEN })}));
    return 1;
  })()`);
  cdp.events.length = 0;                       /* 只统计刷新之后的网络 */
  await cdp.eval('location.reload()');
  await sleep(9000);

  const boot = await cdp.eval(PROBE);
  console.log('  数据来源行：' + (boot.srcLine || '(空)'));
  console.log('  封面来源行：' + (boot.imgLine || '(空)'));
  ok(boot.loadSrc.indexOf('cloud:') === 0, '2.1 数据确实来自 Cloudflare（' + boot.loadSrc + '）');
  ok(!!boot.imgLine, '2.2 面板「封面从哪来」那行有内容', boot.imgLine);
  ok(/Cloudflare R2/.test(boot.imgLine) || /GitHub 仓库/.test(boot.imgLine),
    '2.3 封面来源行说的是这两种之一（不能还在「正在探测」）', boot.imgLine);

  console.log('\n=== 3. 进「藏品馆」→ 再点一个分类，把封面渲染出来 ===');
  /* 踩过的坑：藏品馆首页只有分类磁贴（手办 / 周边 / 杯盏…），
     封面要再往里点一层才出来 —— 分类磁贴的标记是 [data-act="zone"][data-v="手办"]。
     只停在首页的话，页面上一张封面都没有，测试会误判成「封面全没发请求」。 */
  await cdp.eval(`(function(){
    var el = document.querySelector('[data-act="go"][data-key="collection"]');
    if (!el){
      var all = document.querySelectorAll('[data-act]');
      for (var i = 0; i < all.length; i++){
        if ((all[i].textContent || '').indexOf('藏品馆') >= 0) { el = all[i]; break; }
      }
    }
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(7000);

  const zone = await cdp.eval(`(function(){
    var z = document.querySelector('[data-act="zone"]');
    if (!z) return '';
    z.click();
    return z.getAttribute('data-v') || '?';
  })()`);
  console.log('  点了分类：' + (zone || '(这层没有分类磁贴)'));
  await sleep(8000);

  let after = await cdp.eval(PROBE);
  if (after.covers + after.imgTags === 0) {
    /* 兜底：换个确定会渲染封面的模块（遐方坞 / 影音厅） */
    console.log('  藏品馆这层没渲染出封面，改去「遐方坞」兜底…');
    await cdp.eval(`(function(){
      var el = document.querySelector('[data-act="go"][data-key="travel"]');
      if (el) el.click();
      return !!el;
    })()`);
    await sleep(8000);
    after = await cdp.eval(PROBE);
  }
  console.log('  封面元素 ' + after.covers + ' 个（api/img ' + after.coverApi + ' / 相对路径 ' + after.coverRel + '）'
    + '；带 background-image 的元素共 ' + after.bgAll + ' 个（含模块装饰图，不算封面）');
  console.log('  <img> ' + after.imgTags + ' 个（api/img ' + after.imgApi + ' / 相对路径 ' + after.imgRel + '）');
  after.sample.forEach((s) => console.log('    例：' + s));

  console.log('\n=== 4. 逐条核对封面请求的真实状态码 ===');
  await sleep(3000);                            /* 等懒加载把图拉完 */
  const allReq = collectImageResponses(cdp);
  /* ⚠️ 必须把客户端自己的探测请求摘掉：
     cloudImgProbe() 会故意 GET 一个不存在的 key（__probe__.webp）来判断
     「worker 开通了免认证读图没有」。worker 还没重拖时它必然 401 ——
     那是设计好的信号，不是封面失败。混进来会让断言永远红。 */
  const probes = allReq.filter((r) => r.url.indexOf('__probe__') >= 0);
  const resp = allReq.filter((r) => r.url.indexOf('__probe__') < 0);
  const bad = resp.filter((r) => r.status !== 200 && r.status !== 304);
  const viaApi = resp.filter((r) => r.url.indexOf('/api/img/') >= 0);
  const viaStatic = resp.filter((r) => r.url.indexOf('/api/img/') < 0);
  const viaThumb = resp.filter((r) => r.url.indexOf('/data/thumbs/') >= 0);
  console.log('  探测请求 ' + probes.length + ' 个（状态 ' + probes.map((r) => r.status).join(',') + ' —— 401 属正常，说明 worker 还没重拖）');
  console.log('  封面请求共 ' + resp.length + ' 个：/api/img ' + viaApi.length + ' 个，静态 /data 路径 ' + viaStatic.length + ' 个，其中缩略图 ' + viaThumb.length + ' 个');
  if (bad.length) {
    console.log('  非 200 的：');
    bad.slice(0, 8).forEach((r) => console.log('    ' + r.status + '  ' + r.url.slice(0, 120)));
  }
  ok(resp.length > 0, '4.1 ★ 真的发出了封面请求（' + resp.length + ' 个）');
  ok(bad.length === 0, '4.2 ★★ 所有封面响应都是 200（没有一个 401/404 —— 这就是「封面全裂」的判据）');
  ok(!resp.some((r) => r.status === 401), '4.3 特别确认没有 401（CSS 背景图带不了令牌头）');
  /* 404 单独拎出来：data/thumbs 里少一张缩略图，手机上就是一张裂图，
     而且因为「不报错」所以极难发现 —— 正是这条断言在盯它。 */
  const nf = resp.filter((r) => r.status === 404);
  ok(nf.length === 0, '4.3b 没有 404（缩略图一张都不能缺）', nf.slice(0, 3).map((r) => r.url.slice(-60)).join(' | '));

  const saysR2 = /Cloudflare R2/.test(boot.imgLine);
  if (saysR2) {
    ok(viaApi.length > 0, '4.4 ★ 面板说走 R2，就确实有 /api/img 请求');
    ok(viaStatic.length === 0, '4.5 面板说走 R2，就不该再有 /data 静态图片请求', String(viaStatic.length));
    ok(after.coverApi > 0, '4.6 ★ 页面上真的有封面用的是 /api/img 地址（' + after.coverApi + ' 个）');
  } else {
    ok(viaStatic.length > 0, '4.7 面板说走 GitHub 仓库，就确实有 /data 静态图片请求');
    ok(viaApi.length === 0, '4.8 面板说没切 R2，就不该有 /api/img 请求（客户端兜底生效）');
    console.log('  ℹ️ 当前 worker 还是旧版（/api/img 读要令牌）→ 客户端已优雅退回 GitHub。');
    console.log('     把 cloud/pages-upload/_worker.js 重新拖一次 Cloudflare Pages，再跑本测试就会切到 R2。');
  }

  ok(after.covers + after.imgTags > 0, '4.9 ★ 页面上确实渲染出了封面（' + (after.covers + after.imgTags) + ' 个）');
  /* 手机要是去拉 data/images 原图（105MB）而不是 data/thumbs（21MB），流量会翻 5 倍 */
  ok(viaThumb.length > 0, '4.10 封面走的是缩略图 data/thumbs，不是原图', viaThumb.length + '/' + resp.length);


  console.log('\n=== 5. 页面异常 ===');
  const ORIGIN = new URL(SITE).origin;
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => {
    const dd = e.params.exceptionDetails;
    const u = dd.url || (dd.stackTrace && dd.stackTrace.callFrames
      && dd.stackTrace.callFrames.map((f) => f.url).filter(Boolean)[0]) || '';
    return { u, t: dd.text };
  }).filter((x) => !x.u || x.u.indexOf(ORIGIN) === 0);
  ok(errs.length === 0, '5.1 页面没有自家 JS 异常', JSON.stringify(errs.slice(0, 2)));
} catch (e) {
  console.error('\n脚本炸了：' + (e && e.stack || e));
  exitCode = 2;
}

if (cdp) cdp.close();
console.log('\n' + '─'.repeat(56));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
process.exit(exitCode || (fail ? 1 : 0));
