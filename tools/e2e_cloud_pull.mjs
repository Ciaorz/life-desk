/* ============================================================
 * e2e_cloud_pull.mjs —— 「云 → 本地：下载 + 合并」的端到端测试
 * ------------------------------------------------------------
 * 为什么必须存在：
 *   上传写错了最多云端多几条，本机毫发无伤；**下载是直接改本机数据**，
 *   一个字段判断反了就是静默丢数据。所以这条链路要拿真浏览器 + 真 D1 跑一遍。
 *
 * 它做什么（全自动，不用手工准备）：
 *   ① 在临时目录搭一个【隔离站点】（复制 index.html/app.js/style.css/server.js，
 *      手写一份只有 1 条人造记录的 data/lifedesk.json），起在 8123 端口
 *   ② 往真 D1 播种 2 条测试记录（模拟「手机录完并上传」）
 *   ③ 无头浏览器打开隔离站点 → 配好云同步 → 点「下载」→ 确认合并
 *   ④ 断言字段并集真的生效（云端加的「状态」进来、本机独有的「价格/出版社」没被抹掉）
 *   ⑤ 再点一次，断言幂等
 *   ⑥ 无论成败，把 D1 的测试记录删干净
 *
 * ⚠️ 为什么要隔离站点，不能直接拿项目目录起服务：
 *   gh 模式是从 `location.origin + '/data/'` 读分片的（app.js 的 ghStaticLoadV2）。
 *   用项目目录起服务，它就把真数据加载进来了，人造记录会被挤掉 —— 测的东西就不对了。
 *   同理，快照要读 **IndexedDB**（全量 8MB 顶爆 localStorage 的 5MB 上限，
 *   localCacheSetFrom 会 try/catch 静默吞掉，localStorage 那份可能根本没写进去）。
 *
 * 用法：
 *     # 1) 起一个无头浏览器（端口别和已有的 9222 撞）
 *     "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *       --headless=new --disable-gpu --no-sandbox \
 *       --remote-debugging-port=9223 \
 *       --user-data-dir="C:/Users/<你>/AppData/Local/Temp/edge-cdp-9223" about:blank
 *
 *     # 2) 跑测试
 *     CDP_PORT=9223 node tools/e2e_cloud_pull.mjs
 *
 * 需要令牌文件 `E:\自制软件\cloud flare D1 R2.txt`（最后一行是 SYNC_TOKEN）。
 * 不跑真 D1 时可以用 --offline 跳过（只验界面连线，不验合并）。
 * ============================================================ */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.CDP_PORT || 9223);
const SITE_PORT = Number(process.env.SITE_PORT || 8123);
const BASE = process.env.CLOUD_BASE || 'https://life-desk-api.pages.dev';
const TOKEN_FILE = process.env.TOKEN_FILE || 'E:/自制软件/cloud flare D1 R2.txt';
const OFFLINE = process.argv.includes('--offline');
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
const MODULES = ['collection', 'travel', 'av', 'study', 'food', 'idea', 'ip', 'series', 'loc', 'checkin', 'recipe'];
const ROW2 = { _id: 'l_e2epull2', 名称: 'E2E字段并集测试', 价格: 60, 出版社: '本机出版社', _upd: 1789701000000, _rev: 9 };

function buildSite() {
  const dir = join(tmpdir(), 'lifedesk-e2e-' + process.pid);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  ['index.html', 'app.js', 'style.css', 'marker-icons.js', 'manifest.webmanifest', 'sw.js', 'server.js']
    .forEach((f) => { if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(dir, f)); });
  const main = {};
  MODULES.forEach((m) => { main[m] = []; });
  main.collection.push(ROW2);
  writeFileSync(join(dir, 'data/lifedesk.json'), JSON.stringify(
    { schema: 2, shards: {}, entityFiles: [], layoutVersion: 3, fieldLayout: {}, __main: main }, null, 2));
  return dir;
}

/* ---------- ② D1 播种 / 清理 ---------- */
const SEED = [
  { id: 'l_e2epull1', module: 'collection', cat: '书籍', device: 'e2e',
    data: { _id:'l_e2epull1', 名称:'E2E下载合并测试', 作者:'测试作者', ISBN:'9787506365437',
            大类:'书籍', 标签分类:'人文历史', _upd: 1789700000000, _rev: 1 } },
  /* 这条的「状态」只在云端，本机那份只有 价格/出版社 —— 专门用来验字段并集 */
  { id: 'l_e2epull2', module: 'collection', cat: '书籍', device: 'e2e',
    data: { _id:'l_e2epull2', 名称:'E2E字段并集测试', 状态:'在读', _upd: 1789700000000, _rev: 1 } },
];

async function d1(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error('D1 ' + method + ' ' + path + ' → HTTP ' + r.status + ' ' + t);
  return t;
}
async function cleanupD1(token) {
  if (!token) return;
  for (const r of SEED) {
    try { console.log('  DELETE ' + r.id + ' → ' + await d1('DELETE', '/api/records/' + r.id, null, token)); }
    catch (e) { console.log('  ⚠️ 删除失败：' + e.message); }
  }
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

/* 取「当前真正可见」的确认框 —— 页面上可能同时存在多个 .backdrop */
const VISIBLE_DLG = `(function(){
  var all = document.querySelectorAll('.backdrop');
  for (var i = all.length - 1; i >= 0; i--){
    var ov = all[i], r = ov.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && ov.querySelector('#cloudYes')){
      var ps = ov.querySelectorAll('p');
      return { title: (ov.querySelector('h2')||{}).textContent || '',
               msg: (ps[ps.length-1]||{}).textContent || '' };
    }
  }
  return null;
})()`;

async function snap(cdp, id) {
  return await cdp.eval(`(async function(){ var s = await ${READ_SNAP};
    var total = 0; Object.keys(s).forEach(function(k){ total += (s[k]||[]).length; });
    return { n: (s.collection||[]).length, total: total, mods: Object.keys(s).length,
             row: (s.collection||[]).filter(function(x){ return String(x._id)===${JSON.stringify(id)}; })[0] || null }; })()`, true);
}

/* ---------- 主流程 ---------- */
let token = '';
if (!OFFLINE) {
  if (!existsSync(TOKEN_FILE)) { console.error('找不到令牌文件：' + TOKEN_FILE); process.exit(2); }
  token = readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/).pop().trim();
}

const siteDir = buildSite();
console.log('隔离站点：' + siteDir);
const srv = spawn(process.execPath, ['server.js', String(SITE_PORT)], { cwd: siteDir, stdio: 'ignore' });
await sleep(1200);

let cdp = null;
let exitCode = 0;
try {
  /* ③ 播种 */
  if (!OFFLINE) {
    console.log('\n=== 0. 往 D1 播种 2 条测试记录 ===');
    for (const r of SEED) console.log('  POST /api/records ' + r.id + ' → ' + await d1('POST', '/api/records', r, token));
  } else {
    console.log('\n=== 0. --offline：跳过 D1 播种，只验界面连线 ===');
  }

  cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  console.log('\n=== 1. 打开隔离站点（本机已有 l_e2epull2，带价格） ===');
  await cdp.eval(`location.href = ${JSON.stringify(`http://127.0.0.1:${SITE_PORT}/index.html`)}`);
  await sleep(4000);
  /* 重置：清 localStorage + IndexedDB，否则第二次跑时快照里还留着上次拉的数据 */
  await cdp.eval(`(async function(){
    try { localStorage.clear(); } catch(e){}
    await new Promise(function(res){ var r = indexedDB.deleteDatabase('lifedesk');
      r.onsuccess = function(){res(1);}; r.onerror = function(){res(0);}; r.onblocked = function(){res(0);}; });
    return 1;
  })()`, true);
  await cdp.eval('location.reload()');
  await sleep(4500);

  const before = await snap(cdp, 'l_e2epull2');
  console.log('  下载前 l_e2epull2 = ' + JSON.stringify(before.row));
  ok(before.n === 1, '1.1 隔离站点只有 1 条人造记录', String(before.n));
  ok(before.row && before.row.价格 === 60, '1.2 本机已有 价格=60');
  ok(before.row && !('状态' in before.row), '1.3 本机没有 状态（等云端补上）');

  console.log('\n=== 2. 打开云同步面板并保存配置 ===');
  await cdp.eval(`(function(){
    document.querySelector('[data-act="sync"]').click();
    var hd = document.querySelector('[data-sync-toggle="syncBodyCloud"]');
    var bd = document.getElementById('syncBodyCloud');
    if (bd && bd.style.display === 'none') hd.click();
    return 1;
  })()`);
  const btns = await cdp.eval(`(function(){
    return { pull: !!document.getElementById('cloudPullBtn'), full: !!document.getElementById('cloudFullPullBtn'),
             up: !!document.getElementById('cloudUploadBtn') };
  })()`);
  eq(btns, { pull: true, full: true, up: true }, '2.1 上传/下载/全量下载按钮都在');

  if (OFFLINE) {
    console.log('\n（--offline：到界面连线为止）');
  } else {
    await cdp.eval(`(function(){
      document.getElementById('cloudApiBase').value = ${JSON.stringify(BASE)};
      document.getElementById('cloudToken').value = ${JSON.stringify(token)};
      document.getElementById('cloudSaveTest').click();
      return 1;
    })()`);
    await sleep(7000);
    const st1 = await cdp.eval(`(document.getElementById('cloudStatus')||{}).textContent || ''`);
    console.log('  状态栏：' + st1.replace(/\n/g, ' | '));
    ok(st1.indexOf('通了') >= 0, '2.2 「保存并测试」连通云端');

    console.log('\n=== 3. 点「下载」→ 看确认框 → 确认合并 ===');
    await cdp.eval(`document.getElementById('cloudPullBtn').click()`);
    await sleep(8000);
    const dlg = await cdp.eval(VISIBLE_DLG);
    if (dlg) console.log('  确认框：' + dlg.title + ' | ' + dlg.msg.replace(/\n/g, ' ⏎ '));
    ok(!!dlg, '3.1 下载前弹了确认框');
    ok(dlg && dlg.title.indexOf('下载') >= 0, '3.2 标题含「下载」', dlg && dlg.title);
    ok(dlg && dlg.msg.indexOf('字段') >= 0 && dlg.msg.indexOf('冲突') >= 0, '3.3 确认框说明了合并规则');

    await cdp.eval(`(function(){ var y=document.querySelector('#cloudYes'); if(y) y.click(); return 1; })()`);
    await sleep(15000);
    const st2 = await cdp.eval(`(document.getElementById('cloudStatus')||{}).textContent || ''`);
    console.log('  下载后状态栏：' + st2.replace(/\n/g, ' | '));

    console.log('\n=== 4. 核对合并结果（真 D1 → 真浏览器） ===');
    const after = await snap(cdp, 'l_e2epull2');
    const r1 = (await snap(cdp, 'l_e2epull1')).row;
    console.log('  l_e2epull2 = ' + JSON.stringify(after.row));
    console.log('  l_e2epull1 = ' + JSON.stringify(r1));
    console.log('  全模块合计 ' + after.total + ' 条 / ' + after.mods + ' 个模块');

    ok(after.total > 1400, '4.1 ★ 全量拉回来了（合计 ' + after.total + ' 条）', String(after.total));
    ok(r1 && r1.名称 === 'E2E下载合并测试', '4.2 ★ 云端新记录被下载进来了');
    ok(r1 && r1.作者 === '测试作者' && r1.ISBN === '9787506365437', '4.3 新记录字段完整');
    ok(after.row && after.row.状态 === '在读', '4.4 ★ 云端加的「状态」并集进来了');
    ok(after.row && after.row.价格 === 60, '4.5 ★ 本机改的「价格」没被云端抹掉');
    ok(after.row && after.row.出版社 === '本机出版社', '4.6 ★ 本机独有的字段也保住了');
    ok(after.row && after.row._rev === 9, '4.7 _rev 取两边较大值（本机 9 不被云端 1 打回）');
    ok(/1 更新/.test(st2), '4.8 只有 1 条被合并更新（不虚报）', st2);
    const wm = await cdp.eval(`localStorage.getItem('lifedesk_cloud_dl_wm')`);
    ok(Number(wm) > 0, '4.9 下载水位线推进了', wm);

    console.log('\n=== 5. 再点一次下载（幂等检查） ===');
    await cdp.eval(`document.getElementById('cloudPullBtn').click()`);
    await sleep(6000);
    if (await cdp.eval(VISIBLE_DLG)) {
      await cdp.eval(`(function(){ var y=document.querySelector('#cloudYes'); if(y) y.click(); return 1; })()`);
      await sleep(10000);
    }
    const st3 = await cdp.eval(`(document.getElementById('cloudStatus')||{}).textContent || ''`);
    console.log('  第二次下载后状态栏：' + st3.replace(/\n/g, ' | '));
    ok(st3.indexOf('没有需要合并') >= 0 || st3.indexOf('没有新改动') >= 0, '5.1 ★ 第二次下载没有改动（幂等）', st3);
    const after2 = await snap(cdp, 'l_e2epull2');
    eq(after2.total, after.total, '5.2 总条数没变（没重复插入）');
    ok(after2.row && after2.row.价格 === 60 && after2.row.状态 === '在读' && after2.row.出版社 === '本机出版社',
       '5.3 合并结果稳定', JSON.stringify(after2.row));
  }

  console.log('\n=== 6. 页面异常 ===');
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => {
    const d = e.params.exceptionDetails;
    return { url: d.url || (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || '', text: d.text };
  }).filter((x) => x.url.indexOf('chrome-extension://') < 0);
  ok(errs.length === 0, '6.1 页面没有自家 JS 异常', JSON.stringify(errs.slice(0, 2)));
} catch (e) {
  console.error('\n脚本炸了：' + (e && e.stack || e));
  exitCode = 2;
}

/* ---------- 收尾 ---------- */
if (cdp) cdp.close();
if (!OFFLINE) { console.log('\n=== 清理 D1 测试记录 ==='); await cleanupD1(token); }
try { srv.kill(); } catch (e) {}
rmSync(siteDir, { recursive: true, force: true });

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
process.exit(exitCode || (fail ? 1 : 0));
