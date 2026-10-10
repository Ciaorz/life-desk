/* ============================================================
 * verify_cover_fix.mjs —— 闭环验证：修好的 6 张冰箱贴封面在真机真线上确实能加载
 * ------------------------------------------------------------
 * 只验证「修复生效」这一件事：
 *   ① 加载线上站点（手机仿真 + 配 Cloudflare），确认 app 正常启动、走云读；
 *   ② 用页面内 fetch（与 <img> 同一网络路径、同源 CORS 放行）去取这 6 张封面的
 *      /api/img/... 真实 URL，量返回字节数 → 必须全 >0（之前是 0）；
 *   ③ 顺手在藏品馆搜「冰箱贴」，把页面上真实渲染出来的封面 URL 里含
 *      "冰箱贴-封面" 的摘出来，证明它们确实进了 DOM（不是只存在于数据里）。
 * ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const SITE = process.env.SITE || 'https://ciaorz.github.io/life-desk/';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(TOKEN_FILE)) { console.error('找不到令牌文件'); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();
let pass = 0, fail = 0; const failures = [];
function ok(c, l, x) { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; failures.push(l + (x ? ' → ' + x : '')); console.log('  ❌ ' + l + (x ? '  → ' + x : '')); } }

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  return { close: () => ws.close(),
    send(m, p = {}) { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p })); return new Promise((r) => waiting.set(mid, r)); },
    eval(expr, a = false) { return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: a, userGesture: true }).then((r) => { if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result && r.result.result ? r.result.result.value : undefined; }); } };
}
const cdp = await connect();
await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

console.log('\n=== 1. 打开线上站点 + 配 Cloudflare + 刷新 ===');
async function goto(url, ms) { await cdp.send('Page.navigate', { url }); await sleep(ms); }
/* 冷启动时首个导航偶尔会落到 Edge 同步引导页（title 不是本站），先预热一次 */
let t0 = await cdp.eval('document.title');
if (!/生活工作台/.test(t0 || '')) { await goto(SITE, 6000); }
await goto(SITE, 5000);
await cdp.eval(`(async function(){ try{ localStorage.clear(); }catch(e){}
  await new Promise(function(res){ var r=indexedDB.deleteDatabase('lifedesk'); r.onsuccess=function(){res(1)}; r.onerror=function(){res(0)}; r.onblocked=function(){res(0)}; });
  try{ var rs=await navigator.serviceWorker.getRegistrations(); for(var i=0;i<rs.length;i++) await rs[i].unregister(); }catch(e){}
  try{ var ks=await caches.keys(); for(var j=0;j<ks.length;j++) await caches.delete(ks[j]); }catch(e){}
  return 1; })()`, true);
await cdp.eval(`(function(){ localStorage.setItem('lifedesk_cloud', JSON.stringify(${JSON.stringify({ apiBase: BASE, token: TOKEN })})); })()`);
await goto(SITE, 2500);
let src = '';
for (let i = 0; i < 14; i++) {
  src = await cdp.eval(`(localStorage.getItem('lifedesk_load_src')||'')`);
  if (src.indexOf('cloud:') === 0) break;
  await sleep(1500);
}
ok(src.indexOf('cloud:') === 0, '1.1 手机已切到 Cloudflare 读取（' + src + '）');

console.log('\n=== 2. 页面内 fetch 这 6 张封面（修复后必须非 0 字节）===');
const KEYS = [
  'data/thumbs/series/冰箱贴-封面-01/0008-冰箱贴-卡咪龟.webp',
  'data/thumbs/series/冰箱贴-封面-01/0018-冰箱贴-大比鸟.webp',
  'data/thumbs/series/冰箱贴-封面-01/0026_02-冰箱贴-超级雷丘Ｘ.webp',
  'data/thumbs/series/冰箱贴-封面-01/0053-冰箱贴-猫老大.webp',
  'data/thumbs/series/冰箱贴-封面-02/0079-冰箱贴-呆呆兽.webp',
  'data/thumbs/series/冰箱贴-封面-02/0093-冰箱贴-鬼斯通.webp',
];
const fetchExpr = `(async function(){
  var base = ${JSON.stringify(BASE)};
  var keys = ${JSON.stringify(KEYS)};
  var out = [];
  for (var i=0;i<keys.length;i++){
    var segs = keys[i].split('/');
    var url = base + '/api/img/' + segs.map(function(s){ return encodeURIComponent(s); }).join('/');
    try {
      var r = await fetch(url, { cache: 'no-store' });
      var buf = await r.arrayBuffer();
      out.push({ key: keys[i], status: r.status, bytes: buf.byteLength });
    } catch(e){ out.push({ key: keys[i], status: 0, bytes: 0, err: String(e) }); }
  }
  return out;
})()`;
const fetched = await cdp.eval(fetchExpr, true);
(fetched || []).forEach((o) => {
  const name = (o.key || '').split('/').pop();
  console.log('   ' + (o.status || 'ERR') + '  ' + (o.bytes || 0) + ' B  ' + name + (o.err ? '  (' + o.err + ')' : ''));
  ok(o.status === 200 && o.bytes > 0, '2.x ' + name + ' 返回真实封面（' + (o.bytes || 0) + ' B）');
});

console.log('\n=== 3. 开冰箱贴详情，确认详情里真实渲染出封面 URL 且能加载 ===');
/* 3.1 进藏品馆（默认 3D 展厅）→ 切到经典列表（才有搜索框） */
await cdp.eval(`(function(){ var el=document.querySelector('[data-act="go"][data-key="collection"]'); if(el) el.click(); })()`);
await sleep(4000);
await cdp.eval(`(function(){ var b=document.querySelector('[data-act="collclassic"]'); if(b) b.click(); })()`);
await sleep(4000);
/* 3.2 搜「冰箱贴」（命中 系列=30周年冰箱贴 等），触发一次重新渲染 */
await cdp.eval(`(function(){ var i=document.getElementById('q_collection'); if(i){ i.value='冰箱贴'; i.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
await cdp.eval(`(function(){ var b=document.querySelector('[data-act="dosearch"][data-k="collection"]'); if(b) b.click(); })()`);
await sleep(6000);
/* 3.3 点第一张卡开详情（详情 .ph 用的是 coverImg→resolveImgUrl→thumbOf 的真实封面） */
const cardN = await cdp.eval(`(function(){
  var cards=document.querySelectorAll('[data-act="item"][data-key="collection"]');
  if(!cards.length) return 0;
  cards[0].click(); return cards.length;
})()`);
console.log('   搜索命中卡片数：' + cardN);
/* 3.4 等详情 .sheet .ph 出现（带 background-image） */
let phStyle = '';
for (let i = 0; i < 20; i++) {
  phStyle = await cdp.eval(`(function(){ var p=document.querySelector('.sheet .ph'); return p ? (p.getAttribute('style')||'') : ''; })()`);
  if (phStyle && /background-image/.test(phStyle)) break;
  await sleep(800);
}
let detailUrl = '';
const dm = phStyle.match(/url\('([^']+)'\)/);
if (dm) { try { detailUrl = decodeURIComponent(dm[1]); } catch (e) { detailUrl = dm[1]; } }
console.log('   详情封面 URL：' + (detailUrl || '(未取到)'));
ok(/冰箱贴-封面/.test(detailUrl), '3.1 详情里渲染出的是冰箱贴封面（' + detailUrl.slice(-46) + '）');
/* 3.5 真去取这张封面，证明它在线上能加载（不是 0 字节 / 裂图） */
const loaded = await cdp.eval(`(async function(){
  var url=${JSON.stringify(detailUrl)};
  if(!url) return {status:0,bytes:0};
  try{ var r=await fetch(url,{cache:'no-store'}); var b=await r.arrayBuffer(); return {status:r.status,bytes:b.byteLength}; }
  catch(e){ return {status:-1,bytes:0,err:String(e)}; }
})()`, true);
console.log('   详情封面加载：' + (loaded && loaded.status) + '  ' + (loaded && loaded.bytes || 0) + ' B' + (loaded && loaded.err ? '  (' + loaded.err + ')' : ''));
ok(loaded && loaded.status === 200 && loaded.bytes > 0, '3.2 详情封面真实加载成功（' + (loaded && loaded.bytes || 0) + ' B）');

cdp.close();
console.log('\n' + '─'.repeat(56));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
