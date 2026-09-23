/* ============================================================
 * e2e_cloud_load.mjs —— 「手机端改读 Cloudflare」端到端测试（真浏览器 + 真 D1）
 * ------------------------------------------------------------
 * 为什么必须存在：
 *   这次改动把手机端的【数据来源】从 GitHub Pages 换成了 Cloudflare D1。
 *   来源选错 = 手机看到的是过期的另一份数据，而且不会报错，属于最难发现的一类问题。
 *   所以必须拿真浏览器、真 D1、真站点跑一遍，而不是只跑纯函数。
 *
 * 它做什么（全自动，不用手工准备）：
 *   ① 搭一个【隔离站点】，它的 data/lifedesk.json 里只有 1 条人造记录
 *      （l_e2eload_gh「只在 GitHub 上的记录」）—— 这条就是「GitHub 源」的指纹：
 *      只要它出现，说明读的是 GitHub；它消失，说明读的是 Cloudflare。
 *   ② 无头浏览器打开站点：
 *      A. 不配令牌 → 断言退回 GitHub（load_src=gh，指纹记录在）—— 优雅降级
 *      B. 配好令牌 → 断言改读 Cloudflare（load_src=cloud:N，指纹记录消失，
 *         条数 == /api/stats 的 total）
 *      C. 再刷新一次 → 断言幂等（不重复、不丢、仍走 Cloudflare）
 *      D. 令牌填错 → 断言自动退回 GitHub 且本机已有数据不丢
 *   ③ 打印两条链的真实耗时（performance resource timing）做对比
 *   ④ 全程【只读】D1，不播种也不清理任何东西
 *
 * 用法：
 *     # 1) 起一个无头浏览器（端口别和已有的撞）
 *     "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *       --headless=new --disable-gpu --no-sandbox \
 *       --remote-debugging-port=9224 \
 *       --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-9224" about:blank
 *
 *     # 2) 跑测试
 *     CDP_PORT=9224 node tools/e2e_cloud_load.mjs
 *
 * 需要令牌文件 `E:\自制软件\cloud flare D1 R2.txt`（最后一行是 SYNC_TOKEN）。
 * ============================================================ */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.CDP_PORT || 9224);
const SITE_PORT = Number(process.env.SITE_PORT || 8124);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; failures.push(label + (extra ? ' → ' + extra : '')); console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, label, '实际 ' + A + ' / 期望 ' + B); }

/* ---------- 极简 CDP 客户端（Node 22 自带全局 WebSocket） ---------- */
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

/* ---------- ① 搭隔离站点 ---------- */
const GH_ROW = { _id: 'l_e2eload_gh', 名称: '只在 GitHub 上的记录', _upd: 1700000000000, _rev: 1 };
const MODULES = ['collection', 'travel', 'av', 'study', 'food', 'idea', 'ip', 'series', 'loc', 'checkin', 'recipe'];

function buildSite() {
  const dir = join(tmpdir(), 'lifedesk-e2eload-' + process.pid);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  ['index.html', 'app.js', 'style.css', 'marker-icons.js', 'manifest.webmanifest', 'sw.js', 'server.js']
    .forEach((f) => { if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(dir, f)); });
  const main = {};
  MODULES.forEach((m) => { main[m] = []; });
  main.collection.push(GH_ROW);
  writeFileSync(join(dir, 'data/lifedesk.json'), JSON.stringify(
    { schema: 2, shards: {}, entityFiles: [], layoutVersion: 3, fieldLayout: {}, __main: main }, null, 2));
  return dir;
}

/* ---------- 页面侧小工具 ---------- */
const READ_SNAP = `(function(){
  return new Promise(function(res){
    var req = indexedDB.open('lifedesk', 1);
    req.onupgradeneeded = function(){ var db = req.result; if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache'); };
    req.onsuccess = function(){
      var db = req.result;
      try { var g = db.transaction('cache','readonly').objectStore('cache').get('data');
            g.onsuccess = function(){ res(g.result || {}); }; g.onerror = function(){ res({}); };
      } catch(e){ res({}); }
    };
    req.onerror = function(){ res({}); };
  });
})()`;

/* 一次把「来源 / 条数 / 指纹记录在不在 / D1 独有记录在不在 / 网络耗时」全捞回来。
   markerId 是「只存在于 D1、不存在于隔离站点 GitHub 数据」的真实记录 id ——
   它出现在快照里，就是「确实读了 Cloudflare」的铁证（比 load_src 这种自报家门的标记更硬）。 */
async function probe(cdp, markerId) {
  return await cdp.eval(`(async function(){
    var MARKER = ${JSON.stringify(String(markerId || ''))};
    var s = await ${READ_SNAP};
    var total = 0, mods = {}, hasGh = false, hasMarker = false;
    Object.keys(s || {}).forEach(function(k){
      total += (s[k]||[]).length; mods[k] = (s[k]||[]).length;
      (s[k]||[]).forEach(function(r){
        var id = String(r && r._id);
        if (id === 'l_e2eload_gh') hasGh = true;
        if (MARKER && id === MARKER) hasMarker = true;
      });
    });
    var perf = performance.getEntriesByType('resource').map(function(e){
      return { name: String(e.name).split('?')[0].split('/').slice(-2).join('/'),
               q: String(e.name).indexOf('?') >= 0 ? String(e.name).split('?')[1] : '',
               dur: Math.round(e.duration),
               size: e.decodedBodySize || e.transferSize || 0 };
    }).filter(function(e){ return e.name.indexOf('api/sync') >= 0 || e.name.indexOf('lifedesk.json') >= 0; });
    return { src: localStorage.getItem('lifedesk_load_src') || '',
             total: total, mods: mods, hasGh: hasGh, hasMarker: hasMarker,
             cfg: !!localStorage.getItem('lifedesk_cloud'), perf: perf };
  })()`, true);
}

async function resetAndReload(cdp) {
  await cdp.eval(`(async function(){
    try { localStorage.clear(); } catch(e){}
    await new Promise(function(res){ var r = indexedDB.deleteDatabase('lifedesk');
      r.onsuccess = function(){res(1);}; r.onerror = function(){res(0);}; r.onblocked = function(){res(0);}; });
    return 1;
  })()`, true);
  await cdp.eval('location.reload()');
  await sleep(4500);
}

async function setCloudAndReload(cdp, apiBase, token) {
  await cdp.eval(`(function(){
    localStorage.setItem('lifedesk_cloud', JSON.stringify(${JSON.stringify({ apiBase, token })}));
    return 1;
  })()`);
  await cdp.eval('location.reload()');
  await sleep(5000);
}

/* ---------- 主流程 ---------- */
let token = '';
if (!existsSync(TOKEN_FILE)) { console.error('找不到令牌文件：' + TOKEN_FILE); process.exit(2); }
token = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();

/* 先问一下 D1 现在有多少条（用来断言「手机上看到的条数 == 云端条数」） */
let statsTotal = -1, syncRows = -1, syncBytes = 0, d1Marker = '';
try {
  const r = await fetch(BASE + '/api/stats', { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j && j.ok) statsTotal = Number(j.total) || 0;
  const r2 = await fetch(BASE + '/api/sync?since=0&limit=5000', { headers: { Authorization: 'Bearer ' + token } });
  const raw = await r2.text();
  syncBytes = raw.length;
  const j2 = JSON.parse(raw);
  if (j2 && j2.ok) {
    syncRows = (j2.rows || []).length;
    /* 挑一条「活着的 collection 记录」当 D1 独有指纹 */
    const cand = (j2.rows || []).find((x) => x && !x.deleted && x.module === 'collection' && String(x.id) !== 'l_e2eload_gh');
    if (cand) d1Marker = String(cand.id);
  }
} catch (e) { console.error('⚠️ 读 D1 统计失败：' + e.message); }

const siteDir = buildSite();
console.log('隔离站点：' + siteDir);
console.log('D1：/api/stats total=' + statsTotal + '，/api/sync?since=0 返回 ' + syncRows
  + ' 行 / ' + Math.round(syncBytes / 1024) + 'KB（含软删）');
console.log('D1 独有指纹记录：' + (d1Marker || '（没取到！断言会退化）'));
const srv = spawn(process.execPath, ['server.js', String(SITE_PORT)], { cwd: siteDir, stdio: 'ignore' });
await sleep(1200);

let cdp = null;
let exitCode = 0;
try {
  cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  console.log('\n=== 1. 打开隔离站点（没配令牌）→ 应该退回 GitHub ===');
  await cdp.eval(`location.href = ${JSON.stringify(`http://127.0.0.1:${SITE_PORT}/index.html`)}`);
  await sleep(4000);
  await resetAndReload(cdp);
  const a = await probe(cdp, d1Marker);
  console.log('  load_src=' + a.src + ' 合计=' + a.total + ' 指纹记录=' + a.hasGh + ' D1指纹=' + a.hasMarker);
  eq(a.src, 'gh', '1.1 ★ 没配令牌 → 退回 GitHub（行为与改动前一致）');
  ok(a.hasGh, '1.2 指纹记录在（确实读的是 GitHub）');
  ok(!a.hasMarker, '1.3 D1 独有的记录不在（确认此刻没读 Cloudflare）');
  eq(a.total, 1, '1.4 只有隔离站点那 1 条人造记录');

  console.log('\n=== 2. 配好令牌 → 应该改读 Cloudflare ===');
  await setCloudAndReload(cdp, BASE, token);
  const b = await probe(cdp, d1Marker);
  console.log('  load_src=' + b.src + ' 合计=' + b.total + ' 指纹记录=' + b.hasGh + ' D1指纹=' + b.hasMarker);
  console.log('  模块分布：' + JSON.stringify(b.mods));
  ok(/^cloud:\d+$/.test(b.src), '2.1 ★ load_src 变成 cloud:N（真的去读 Cloudflare 了）', b.src);
  ok(b.hasMarker, '2.2 ★ D1 独有的记录进来了（数据来自 Cloudflare 的铁证）');
  ok(b.perf.some((e) => e.q.indexOf('since=0') >= 0), '2.3 请求了 /api/sync?since=0（全量）',
    JSON.stringify(b.perf));
  eq(b.total, statsTotal + 1,
    '2.4 ★ 云端 ' + statsTotal + ' 条一条不少 + 本机独有 1 条（并集规则）');
  ok(b.hasGh, '2.5 ★ 本机独有的记录没被云端冲掉（并集规则：宁可多留不可误删）');
  const cloudSync = b.perf.filter((e) => e.name.indexOf('api/sync') >= 0);
  if (cloudSync.length) {
    const e = cloudSync[0];
    /* 跨域资源的 size 字段会被浏览器抹成 0（没有 Timing-Allow-Origin），
       所以体积用测试进程自己那次请求量到的 syncBytes。 */
    console.log('  Cloudflare 一次拉全量：' + e.dur + 'ms / ' + Math.round(syncBytes / 1024)
      + 'KB（' + cloudSync.length + ' 个请求）');
  }

  console.log('\n=== 2b. ☁ 面板里能看到「数据来自 Cloudflare」 ===');
  await cdp.eval(`(function(){
    document.querySelector('[data-act="sync"]').click();
    var hd = document.querySelector('[data-sync-toggle="syncBodyCloud"]');
    var bd = document.getElementById('syncBodyCloud');
    if (bd && bd.style.display === 'none' && hd) hd.click();
    return 1;
  })()`);
  await sleep(400);
  const panelTxt = await cdp.eval(`(document.getElementById('cloudSrcLine')||{}).textContent || ''`);
  console.log('  面板来源行：' + String(panelTxt));
  ok(/Cloudflare/.test(panelTxt), '2b.1 ★ 面板显示「本次数据来自 Cloudflare」', panelTxt);
  ok(/云端 14\d\d 条/.test(panelTxt), '2b.2 面板显示了云端条数', panelTxt);
  await cdp.eval(`(function(){ var b=document.getElementById('ghClose'); if(b) b.click(); return 1; })()`);

  console.log('\n=== 3. 再刷新一次 → 幂等（不重复、不丢、仍走 Cloudflare） ===');
  await cdp.eval('location.reload()');
  await sleep(5000);
  const c = await probe(cdp, d1Marker);
  console.log('  load_src=' + c.src + ' 合计=' + c.total + ' D1指纹=' + c.hasMarker);
  ok(/^cloud:/.test(c.src), '3.1 第二次仍然走 Cloudflare');
  eq(c.total, b.total, '3.2 总条数没变（没重复插入）');
  eq(Object.keys(c.mods).sort(), Object.keys(b.mods).sort(), '3.3 模块集合没变');
  ok(c.hasMarker, '3.4 D1 指纹仍在');

  console.log('\n=== 4. 令牌填错 → 自动退回 GitHub，且本机数据不丢 ===');
  await setCloudAndReload(cdp, BASE, 'WRONG-TOKEN-0000');
  const d = await probe(cdp, d1Marker);
  console.log('  load_src=' + d.src + ' 合计=' + d.total + ' 指纹记录=' + d.hasGh + ' D1指纹=' + d.hasMarker);
  eq(d.src, 'gh', '4.1 ★ 令牌不对 → 退回 GitHub，不白屏不报错');
  eq(d.total, b.total, '4.2 ★ 本机已有数据一条没丢（条数与上一步相同）');
  ok(d.hasGh && d.hasMarker, '4.3 两边独有的记录都还在（GitHub 指纹 + D1 指纹）');

  console.log('\n=== 5. 页面异常 ===');
  /* 只看「自家站点」的异常：浏览器扩展（Grammarly 之类）的报错不算数。
     扩展脚本的 url 不在本站 origin 上。 */
  const ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => {
    const dd = e.params.exceptionDetails;
    const frameUrl = dd.url || (dd.stackTrace && dd.stackTrace.callFrames
      && dd.stackTrace.callFrames.map((f) => f.url).filter(Boolean)[0]) || '';
    return { url: frameUrl, text: dd.text };
  }).filter((x) => !x.url || x.url.indexOf(ORIGIN) === 0);
  ok(errs.length === 0, '5.1 页面没有自家 JS 异常', JSON.stringify(errs.slice(0, 2)));

  const netErrs = cdp.events.filter((e) => e.method === 'Network.loadingFailed')
    .map((e) => e.params).filter((p) => !p.blockedReason && String(p.errorText || '').indexOf('ABORTED') < 0);
  if (netErrs.length) console.log('  （网络失败事件 ' + netErrs.length + ' 个，可能是刷新打断，非必失败）');
} catch (e) {
  console.error('\n脚本炸了：' + (e && e.stack || e));
  exitCode = 2;
}

/* ---------- 收尾 ---------- */
if (cdp) cdp.close();
try { srv.kill(); } catch (e) {}
try { rmSync(siteDir, { recursive: true, force: true }); } catch (e) { console.log('（临时目录稍后手动清理：' + siteDir + '）'); }

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
process.exit(exitCode || (fail ? 1 : 0));
