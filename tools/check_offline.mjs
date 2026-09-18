/* ============================================================
 * check_offline.mjs —— 「这次改动有没有把离线能力搞坏？」
 * ------------------------------------------------------------
 * 为什么需要它：
 *   index.html 里有一行 `shouldEnable = SW_ENABLED && protocol === 'https:'`
 *   —— **Service Worker 只在 https 下注册**（localhost / file:// 一律跳过）。
 *   所以离线能力**在本地服务器上永远测不出来**，只能在真实站点上验。
 *   而「离线能不能打开」正是这个项目最不能坏的东西（出门没网也要能查藏品）。
 *
 * 它做什么：
 *   用本机已装的 Edge/Chrome + 原生 CDP（不需要 puppeteer/playwright）：
 *     ① 加载页面，确认没有自家 JS 异常、面板 DOM 都在
 *     ② 确认 SW 已注册、app.js / style.css 都进了 Cache Storage
 *     ③ **把网络切断后重新加载**，确认页面仍然完整可用（不是 Chrome 错误页）
 *
 * 用法：
 *     # 1) 起一个无头浏览器（端口别和已有的 9222 撞）
 *     "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *       --headless=new --disable-gpu --no-sandbox \
 *       --remote-debugging-port=9223 \
 *       --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-9223" about:blank
 *
 *     # 2) 跑测试（默认打线上站点）
 *     CDP_PORT=9223 node tools/check_offline.mjs
 *     CDP_PORT=9223 TEST_URL=https://ciaorz.github.io/life-desk/ node tools/check_offline.mjs
 *
 * ⚠️ 不要用 9222 —— 那上面可能开着用户/IDE 的真实会话，本脚本会改写页面状态。
 * ============================================================ */

const PORT = Number(process.env.CDP_PORT || 9223);
const URL0 = process.env.TEST_URL || 'https://ciaorz.github.io/life-desk/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 极简 CDP 客户端（Node 22 自带全局 WebSocket） ---------- */
async function getJSON(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}

async function connect() {
  let list;
  try {
    list = await getJSON('/json/list');
  } catch (e) {
    console.error(`\n连不上 CDP（127.0.0.1:${PORT}）。先起一个无头浏览器：\n`);
    console.error('  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \\');
    console.error('    --headless=new --disable-gpu --no-sandbox \\');
    console.error(`    --remote-debugging-port=${PORT} \\`);
    console.error('    --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-' + PORT + '" about:blank\n');
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

/* 浏览器扩展（Grammarly 等）的报错不算我们的问题 */
function ownErrors(events) {
  return events.filter((e) => {
    const s = JSON.stringify(e);
    if (/chrome-extension:\/\//.test(s)) return false;
    if (e.method === 'Runtime.exceptionThrown') return true;
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') return true;
    return false;
  });
}

let pass = 0, fail = 0;
function ok(n, v) { pass++; console.log('  ✅ ' + n + (v !== undefined ? '  → ' + v : '')); }
function bad(n, v) { fail++; console.log('  ❌ ' + n + (v !== undefined ? '  → ' + v : '')); }
function assert(n, cond, v) { cond ? ok(n, v) : bad(n, v); }

/* ---------- 主流程 ---------- */
const c = await connect();
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Network.enable');
await c.send('ServiceWorker.enable').catch(() => {});
await c.send('Emulation.setDeviceMetricsOverride',
  { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

console.log('\n=== 目标：' + URL0 + ' ===');
if (URL0.indexOf('https://') !== 0) {
  console.log('  ⚠️ 不是 https —— SW 不会注册，离线部分必然失败。这个脚本只对 https 站点有意义。');
}

console.log('\n[1] 首次加载（联网）');
await c.send('Page.navigate', { url: URL0 });
await sleep(9000);

const snap = JSON.parse(await c.eval(`(function(){
  var $ = function(id){ return document.getElementById(id); };
  var panel = $('ghPanel');
  var firstHd = panel ? panel.querySelector('.sync-hd') : null;
  return JSON.stringify({
    title: document.title,
    navKids: (function(){ var n=$('nav'); return n? n.children.length : -1; })(),
    errLayer: (function(){ var e=document.querySelector('.js-error,#jsError,#errBar');
                           return e? (e.textContent||'').slice(0,100) : ''; })(),
    hasPanel: !!panel,
    hasBody: !!$('syncBodyCloud'),
    firstSection: firstHd ? firstHd.getAttribute('data-sync-toggle') : null,
    ids: ['cloudApiBase','cloudToken','cloudSaveTest','cloudUploadBtn','cloudFullBtn','cloudStatus']
           .map(function(i){ return i + '=' + (!!$(i)); }).join(' '),
    tokenType: (function(){ var t=$('cloudToken'); return t? t.type : null; })(),
    statusText: (function(){ var t=$('cloudStatus'); return t? t.textContent.trim().slice(0,60) : null; })()
  });
})()`));

assert('页面标题已渲染', !!(snap.title && snap.title.length), snap.title);
assert('主导航已渲染', snap.navKids > 0, snap.navKids + ' 个子元素');
assert('没有全局错误提示层', !snap.errLayer, snap.errLayer || undefined);

console.log('\n[2] 云同步面板 DOM');
assert('同步面板 #ghPanel 存在', snap.hasPanel);
assert('云同步区块 #syncBodyCloud 存在', snap.hasBody);
assert('云同步是第一个折叠区块', snap.firstSection === 'syncBodyCloud', snap.firstSection);
assert('六个控件 id 全部到位', snap.ids.indexOf('false') < 0, snap.ids);
assert('令牌框是 password 类型', snap.tokenType === 'password', snap.tokenType);
assert('状态行已初始化', !!snap.statusText, snap.statusText || '(空)');

const tj = JSON.parse(await c.eval(`(function(){
  var hd = document.querySelector('[data-sync-toggle="syncBodyCloud"]');
  if(!hd) return JSON.stringify({e:'NO_HD'});
  var body = document.getElementById('syncBodyCloud');
  var before = getComputedStyle(body).display;
  hd.click();
  return JSON.stringify({before: before, after: getComputedStyle(body).display});
})()`));
assert('点标题能展开云同步区块', tj.before === 'none' && tj.after !== 'none',
  tj.before + ' → ' + tj.after);

console.log('\n[3] Service Worker 与缓存');
const sw = JSON.parse(await c.eval(`(async function(){
  if(!('serviceWorker' in navigator)) return JSON.stringify({err:'NO_SW_API'});
  var rs = await navigator.serviceWorker.getRegistrations();
  var ks = await caches.keys();
  var counts = {};
  for (var i=0;i<ks.length;i++){ var cc = await caches.open(ks[i]);
    counts[ks[i]] = (await cc.keys()).length; }
  var found = {app:false, css:false};
  for (var i=0;i<ks.length;i++){ var cc = await caches.open(ks[i]);
    var reqs = await cc.keys();
    for (var j=0;j<reqs.length;j++){
      /* 用 indexOf，别写正则字面量 —— 这段代码在 Node 模板字符串里，
         \\/ 和 \\. 会被当转义吃掉，正则会塌成 // 行注释。踩过。 */
      var u = String(reqs[j].url);
      if (u.indexOf('/app.js') >= 0) found.app = ks[i];
      if (u.indexOf('/style.css') >= 0) found.css = ks[i];
    }
  }
  return JSON.stringify({
    n: rs.length,
    scope: rs.length ? rs[0].scope : null,
    active: rs.length && rs[0].active ? rs[0].active.state : null,
    controller: !!navigator.serviceWorker.controller,
    caches: counts, app: found.app, css: found.css
  });
})()`, true));

assert('SW 已注册', sw.n > 0, sw.scope);
assert('SW 已激活', !!sw.active, sw.active);
console.log('  ℹ️  Cache Storage：' + JSON.stringify(sw.caches));
assert('app.js 已进缓存', !!sw.app, sw.app);
assert('style.css 已进缓存', !!sw.css, sw.css);

/* 再刷一次让 SW 接管（首访时 controller 通常是 null） */
await c.send('Page.navigate', { url: URL0 });
await sleep(6000);
assert('第二次加载后 SW 已接管页面', await c.eval('!!navigator.serviceWorker.controller'));

console.log('\n[4] 断网重载（关键）');
await c.send('Network.emulateNetworkConditions',
  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await c.send('Page.navigate', { url: URL0 });
await sleep(9000);

const off = JSON.parse(await c.eval(`(function(){
  var $ = function(id){ return document.getElementById(id); };
  var link = document.querySelector('link[rel="stylesheet"]');
  return JSON.stringify({
    title: document.title,
    /* Chrome 断网错误页有 #main-frame-error，标题会变成主机名。
       只断言「标题非空」会把错误页也判成通过 —— 假阳性，踩过。 */
    errPage: !!document.querySelector('#main-frame-error, .neterror'),
    navKids: (function(){ var n=$('nav'); return n? n.children.length : -1; })(),
    hasPanel: !!$('ghPanel'),
    hasBody: !!$('syncBodyCloud'),
    cssLoaded: link ? !!link.sheet : null,
    bodyLen: (document.body.innerHTML || '').length
  });
})()`));

assert('断网后不是 Chrome 错误页', !off.errPage, off.errPage ? '是错误页！' : undefined);
assert('断网后标题正确', !!(off.title && off.title.indexOf('日常集') >= 0), off.title);
assert('断网后导航已渲染', off.navKids > 0, off.navKids + ' 个子元素');
assert('断网后云同步面板仍在（app.js 从缓存跑起来了）', off.hasPanel && off.hasBody);
assert('断网后样式表已加载', !!off.cssLoaded, String(off.cssLoaded));
assert('断网后 DOM 内容完整', off.bodyLen > 5000, off.bodyLen + ' 字节');

assert('全程没有自家 JS 异常', ownErrors(c.events).length === 0,
  ownErrors(c.events).length ? JSON.stringify(ownErrors(c.events)[0]).slice(0, 260) : undefined);

/* ---------- 恢复 ---------- */
await c.send('Network.emulateNetworkConditions',
  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await c.send('Emulation.clearDeviceMetricsOverride');
c.close();

console.log('\n----------------------------------------');
console.log('通过 %d 项，失败 %d 项', pass, fail);
console.log(fail === 0 ? '结果：✅ 离线能力完好。' : '结果：❌ 有问题，看上面。');
console.log('');
process.exit(fail === 0 ? 0 : 1);
