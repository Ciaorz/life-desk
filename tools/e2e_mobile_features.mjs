/* ============================================================
 * e2e_mobile_features.mjs —— 手机端「轻改 + 扫码录书」可达性 + 云端查书真联通
 * ------------------------------------------------------------
 * 验证：
 *   ① 手机仿真下，藏品馆卡片 → 详情 → 编辑（轻改入口可达）
 *   ② 学习计划模块有「+ 书籍」录入入口，书籍表单含 搜书 / 📷 扫码 / 🖼 照片识别
 *   ③ 填 ISBN 点「搜书」→ 云端 /api/isbn 真联通，自动填「名称」
 *
 * 摄像头无法在无头环境测，但「扫码 → 识别串 → 查书填表」与「搜书」共用回填链路，搜书通即证明可用。
 * 用法：先起无头 Edge（run_in_background），再 CDP_PORT=9225 node tools/e2e_mobile_features.mjs
 * ============================================================ */
import { existsSync, readFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const SITE = process.env.SITE || 'https://ciaorz.github.io/life-desk/';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
function ok(c, l, x) { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; failures.push(l + (x ? ' → ' + x : '')); console.log('  ❌ ' + l + (x ? '  → ' + x : '')); } }

if (!existsSync(TOKEN_FILE)) { console.error('找不到令牌文件：' + TOKEN_FILE); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();

async function connect() {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch (e) { console.error(`连不上 CDP（127.0.0.1:${PORT}）。先起无头浏览器。`); process.exit(2); }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method) events.push(m); };
  return {
    events,
    close: () => ws.close(),
    send(method, params = {}) { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise((res) => waiting.set(mid, res)); },
    async eval(expr, awaitPromise = false) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true }); if (r.result && r.result.exceptionDetails) throw new Error('页面内异常: ' + ((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text)); return r.result && r.result.result ? r.result.result.value : undefined; },
  };
}
async function waitFor(cdp, expr, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await cdp.eval(`(function(){ try { return !!(${expr}); } catch(e){ return false; } })()`);
    if (v) return true;
    await sleep(500);
  }
  return false;
}
async function clickSel(cdp, sel) {
  return cdp.eval(`(function(){ var b=document.querySelector(${JSON.stringify(sel)}); if(b){ b.click(); return true; } return false; })()`);
}

let cdp = null; let exitCode = 0;
try {
  cdp = await connect();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

  console.log('\n=== 1. 打开线上站点 + 配 Cloudflare + 刷新 ===');
  await cdp.eval(`location.href = ${JSON.stringify(SITE)}`);
  await sleep(5000);
  await cdp.eval(`(async function(){ try{ localStorage.clear(); }catch(e){}
    await new Promise(function(res){ var r=indexedDB.deleteDatabase('lifedesk'); r.onsuccess=function(){res(1)}; r.onerror=function(){res(0)}; r.onblocked=function(){res(0)}; });
    try{ var rs=await navigator.serviceWorker.getRegistrations(); for(var i=0;i<rs.length;i++) await rs[i].unregister(); }catch(e){}
    try{ var ks=await caches.keys(); for(var j=0;j<ks.length;j++) await caches.delete(ks[j]); }catch(e){}
    return 1; })()`, true);
  await cdp.eval(`(function(){ localStorage.setItem('lifedesk_cloud', JSON.stringify(${JSON.stringify({ apiBase: BASE, token: TOKEN })})); })()`);
  cdp.events.length = 0;
  await cdp.eval('location.reload()');
  await sleep(9000);
  const src = await cdp.eval(`(localStorage.getItem('lifedesk_load_src')||'')`);
  ok(src.indexOf('cloud:') === 0, '1.1 手机已切到 Cloudflare 读取（' + src + '）');

  console.log('\n=== 2. 手机轻改入口：藏品馆卡片 → 详情 → 编辑（先走，避免先开别的模块干扰加载）===');
  await clickSel(cdp, '[data-act="go"][data-key="collection"]');
  await sleep(20000);                                                   // 等藏品馆数据从 Cloudflare 加载完
  const hasZone = await waitFor(cdp, "document.querySelector('[data-act=\"zone\"]')", 15000);
  ok(hasZone, '2.1 藏品馆展厅渲染（透视展柜）');
  /* v96g：点一个大类磁贴（zone）→ 进经典列表。经典列表默认按「系列」分组，
     只出 seriesopen 系列卡、不出单件卡片；要点「按物品」扁平化，单件卡片
     （data-act="item" data-key="collection"）才平铺出来。 */
  let hasItem = false;
  if (hasZone) {
    await cdp.eval(`(function(){ var z=document.querySelector('[data-act=\"zone\"]'); if(z) z.click(); })()`);
    await sleep(6000);
    hasItem = await cdp.eval("document.querySelectorAll('[data-act=\"item\"][data-key=\"collection\"]').length") > 0;
    if (!hasItem) {
      await cdp.eval(`(function(){ var b=document.querySelector('[data-act=\"f\"][data-k=\"wallGroup\"][data-v=\"item\"]'); if(b) b.click(); })()`);
      hasItem = await waitFor(cdp, "document.querySelector('[data-act=\"item\"][data-key=\"collection\"]')", 12000);
    }
  }
  ok(hasItem, '2.2 经典列表出现藏品单件卡片（藏品数据已从 Cloudflare 加载）');
  if (hasItem) {
    await clickSel(cdp, '[data-act="item"][data-key="collection"]');
    const hasEdit = await waitFor(cdp, "document.getElementById('dEdit')", 8000);
    ok(hasEdit, '2.3 藏品详情有「编辑」按钮（手机轻改入口）');
    if (hasEdit) {
      await clickSel(cdp, '#dEdit');
      const editForm = await waitFor(cdp, "(function(){ var h=document.getElementById('sheetHost'); return h && !h.hidden && h.querySelector('[data-f=\"名称\"]'); })()", 8000);
      ok(editForm, '2.4 点「编辑」打开录入表单（状态/想收/短评 等字段可改）');
    }
  }
  await clickSel(cdp, '[data-x="1"]'); await sleep(1200);                 // 关掉详情/表单

  console.log('\n=== 3. 学习计划模块 → 录入书籍入口 + 扫码/查书模块 ===');
  await clickSel(cdp, '[data-act="go"][data-key="study"]');
  const hasBookAdd = await waitFor(cdp, "document.querySelector('[data-act=\"bookadd\"]')", 15000);
  ok(hasBookAdd, '3.1 学习计划模块有「+ 书籍」录入入口');
  await clickSel(cdp, '[data-act="bookadd"]');
  const fm = await waitFor(cdp, "document.querySelector('[data-f=\"ISBN\"]')", 8000);
  const mod = await cdp.eval(`(function(){
    return { isbn: !!document.querySelector('[data-f=\"ISBN\"]'),
      look: !!document.querySelector('[data-act=\"isbnlookup\"]'),
      cam:  !!document.querySelector('[data-act=\"isbnlivecam\"]'),
      photo:!!document.querySelector('[data-act=\"isbnphoto\"]') }; })()`);
  console.log('   表单模块：' + JSON.stringify(mod));
  ok(mod.isbn, '3.2 书籍表单含 ISBN 输入框');
  ok(mod.look, '3.3 含「搜书」按钮（联网查书）');
  ok(mod.cam, '3.4 含「📷 扫码」按钮（实时摄像头扫码）');
  ok(mod.photo, '3.5 含「🖼 照片识别」入口');

  console.log('\n=== 4. 填 ISBN 点「搜书」→ 云端 /api/isbn 真联通回填 ===');
  await cdp.eval(`(function(){ var i=document.querySelector('[data-f=\"ISBN\"]'); if(i){ i.value='9787544253994'; i.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
  await clickSel(cdp, '[data-act="isbnlookup"]');
  const filled = await waitFor(cdp, "(function(){ var n=document.querySelector('[data-f=\"名称\"]'); return n && n.value && n.value.length>0; })()", 10000);
  const nameVal = await cdp.eval(`(document.querySelector('[data-f=\"名称\"]')||{}).value||''`);
  console.log('   回填结果：名称="' + nameVal + '"');
  ok(filled, '4.1 云端查书成功，自动填入「名称」', nameVal || '未填入');

  console.log('\n=== 5. 页面异常 ===');
  const ORIGIN = new URL(SITE).origin;
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => { const dd = e.params.exceptionDetails; return { u: (dd.url || ''), t: dd.text }; }).filter((x) => !x.u || x.u.indexOf(ORIGIN) === 0);
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
