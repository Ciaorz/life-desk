import { existsSync, readFileSync } from 'node:fs';
const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const SITE = process.env.SITE || 'https://ciaorz.github.io/life-desk/';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(TOKEN_FILE)) { console.error('no token'); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  return { send(m, p = {}) { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p })); return new Promise((r) => waiting.set(mid, r)); },
    eval(expr, a = false) { return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: a, userGesture: true }).then((r) => { if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result && r.result.result ? r.result.result.value : undefined; }); },
    close: () => ws.close() };
}
const cdp = await connect();
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
await cdp.eval(`location.href = ${JSON.stringify(SITE)}`); await sleep(5000);
await cdp.eval(`(async function(){ try{ localStorage.clear(); }catch(e){}
  await new Promise(function(res){ var r=indexedDB.deleteDatabase('lifedesk'); r.onsuccess=function(){res(1)}; r.onerror=function(){res(0)}; r.onblocked=function(){res(0)}; });
  try{ var rs=await navigator.serviceWorker.getRegistrations(); for(var i=0;i<rs.length;i++) await rs[i].unregister(); }catch(e){}
  try{ var ks=await caches.keys(); for(var j=0;j<ks.length;j++) await caches.delete(ks[j]); }catch(e){}
  return 1; })()`, true);
await cdp.eval(`(function(){ localStorage.setItem('lifedesk_cloud', JSON.stringify(${JSON.stringify({ apiBase: BASE, token: TOKEN })})); })()`);
await cdp.eval('location.reload()'); await sleep(9000);
await clickGo('collection'); await sleep(18000);
async function clickGo(key){ await cdp.eval(`(function(){ var el=document.querySelector('[data-act="go"][data-key="${key}"]'); if(el) el.click(); })()`); }
const before = await cdp.eval(`(function(){
  var z=document.querySelector('[data-act="zone"]');
  return { hasZone: !!z, zoneV: z && z.getAttribute('data-v'),
    uiClassic: (window.ui && ui.collection) ? ui.collection.classic : 'n/a',
    uiCat: (window.ui && ui.collection) ? ui.collection.cat : 'n/a',
    uiMode: (window.ui && ui.collection) ? ui.collection.mode : 'n/a',
    actCounts: (function(){ var m={}; document.querySelectorAll('[data-act]').forEach(function(n){ var a=n.getAttribute('data-act'); m[a]=(m[a]||0)+1; }); return m; })(),
    stageText: (document.getElementById('stage')||{}).textContent ? document.getElementById('stage').textContent.slice(0,120) : '(empty)' };
})()`);
console.log('点击分类前:', JSON.stringify(before, null, 1));
await cdp.eval(`(function(){ var z=document.querySelector('[data-act="zone"]'); if(z) z.click(); })()`);
await sleep(6000);
const afterZone = await cdp.eval(`(function(){
  return { seriesopen: document.querySelectorAll('[data-act="seriesopen"]').length,
    itemColl: document.querySelectorAll('[data-act="item"][data-key="collection"]').length };
})()`);
console.log('zone 之后:', JSON.stringify(afterZone));
/* 试「按物品」扁平化 */
await cdp.eval(`(function(){ var b=document.querySelector('[data-act="f"][data-k="wallGroup"][data-v="item"]'); if(b) b.click(); })()`);
await sleep(6000);
const afterFlat = await cdp.eval(`(function(){
  return { seriesopen: document.querySelectorAll('[data-act="seriesopen"]').length,
    itemColl: document.querySelectorAll('[data-act="item"][data-key="collection"]').length,
    itemAny: document.querySelectorAll('[data-act="item"]').length };
})()`);
console.log('按物品之后:', JSON.stringify(afterFlat));
/* 试点系列 → 系列详情 */
await cdp.eval(`(function(){ var b=document.querySelector('[data-act="seriesopen"]'); if(b) b.click(); })()`);
await sleep(6000);
const afterSeries = await cdp.eval(`(function(){
  return { itemColl: document.querySelectorAll('[data-act="item"][data-key="collection"]').length };
})()`);
console.log('点系列之后:', JSON.stringify(afterSeries));
process.exit(0);
const after = await cdp.eval(`(function(){
  return {
    uiClassic: (window.ui && ui.collection) ? ui.collection.classic : 'n/a',
    uiCat: (window.ui && ui.collection) ? ui.collection.cat : 'n/a',
    uiMode: (window.ui && ui.collection) ? ui.collection.mode : 'n/a',
    itemColl: document.querySelectorAll('[data-act="item"][data-key="collection"]').length,
    itemAny: document.querySelectorAll('[data-act="item"]').length,
    zone: document.querySelectorAll('[data-act="zone"]').length,
    cabinet: document.querySelectorAll('[data-act="cabinet"]').length,
    actCounts: (function(){ var m={}; document.querySelectorAll('[data-act]').forEach(function(n){ var a=n.getAttribute('data-act'); m[a]=(m[a]||0)+1; }); return m; })(),
    stageText: (document.getElementById('stage')||{}).textContent ? document.getElementById('stage').textContent.slice(0,160) : '(empty)' };
})()`);
console.log('点击分类后:', JSON.stringify(after, null, 1));
cdp.close(); process.exit(0);
