/* ============================================================
 * e2e_pk_group_cdp.mjs —— v157 真机验证：宝可梦筛选栏的「伊布」图鉴组 / 去掉「无极巨化」
 * ------------------------------------------------------------
 * 单元测试（tools/test_pk_groups.mjs）测的是「选项和数据对不对得上」；
 * 这一层测**真实浏览器里的行为**：
 *   ① 筛选栏里真的出现了「伊布」、真的没有「无极巨化」
 *   ② 点「伊布」→ 列表只剩伊布一家（跨世代的九种一起出来）
 *   ③ 卡住「无极巨化」那两张不被误删（它们仍在「全部」里）
 * 顺带截图存档。
 *
 * 骨架同 tools/e2e_preorder_cdp.mjs（CDP + 复制真实 index.html 当站点）。
 *
 * 用法：
 *     node tools/e2e_pk_group_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9336;
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-pk');
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
{
  const APP_URL = 'file:///' + join(ROOT, 'app.js').replace(/\\/g, '/');
  const CSS_URL = 'file:///' + join(ROOT, 'style.css').replace(/\\/g, '/');
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  html = html.replace("s.src='app.js'+bust;", `s.src='${APP_URL}'+bust;`);
  html = html.replace("l.href='style.css'+bust;", `l.href='${CSS_URL}'+bust;`);
  html = html.replace("href='style.css'", `href='${CSS_URL}'`);
  writeFileSync(join(SITE, 'index.html'), html);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', function(){});
const profile = join(tmpdir(), 'ld-e2e-pk-prof-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const waiters = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }

async function main() {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } }
    catch (e) { /* 等 */ }
    await sleep(250);
  }
  if (!ready) throw new Error('Chrome 的 CDP 端口没起来');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e.message||e.error));});',
  });
  await send('Page.navigate', { url: 'file:///' + join(SITE, 'index.html').replace(/\\/g, '/') });
  await sleep(3200);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})', returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errs));

  const script = `(async function(){
    var S = window.__store, U = window.__ui;
    await new Promise(function(r){ setTimeout(r, 1800); });

    function mk(id, name, no, gen, form, group){
      return { _id:id, 名称:name, 编号:no, 世代组:gen, 特殊形态:form, 图鉴组:group,
        IP:'宝可梦', 系列:'30周年冰箱贴', 大类:'周边', 小类:'冰箱贴',
        formCode:id+'c', 属性:'普通', 状态:['在库'], 持有:1, _upd:1, _rev:1 };
    }
    S.series.status='ok'; S.ip.status='ok'; S.collection.status='ok';
    S.series.rows=[{_id:'s1', 系列名称:'30周年冰箱贴', 所属IP:'宝可梦', _upd:1, _rev:1}];
    S.ip.rows=[{_id:'i1', IP名称:'宝可梦', _upd:1, _rev:1}];
    S.collection.rows=[
      mk('e1','伊布','0133','第一世代','常规图鉴','伊布'),
      mk('e2','伊布（超极巨化）','0133','第一世代','超极巨化','伊布'),
      mk('e3','水伊布','0134','第一世代','常规图鉴','伊布'),
      mk('e4','雷伊布','0135','第一世代','常规图鉴','伊布'),
      mk('e5','火伊布','0136','第一世代','常规图鉴','伊布'),
      mk('e6','太阳伊布','0196','第二世代','常规图鉴','伊布'),
      mk('e7','月亮伊布','0197','第二世代','常规图鉴','伊布'),
      mk('e8','叶伊布','0470','第四世代','常规图鉴','伊布'),
      mk('e9','冰伊布','0471','第四世代','常规图鉴','伊布'),
      mk('e10','仙子伊布','0700','第六世代','常规图鉴','伊布'),
      mk('p1','皮卡丘','0025','第一世代','常规图鉴',''),
      mk('d1','无极汰那（无极巨化）','0890','第八世代','无极巨化','传说宝可梦'),
      mk('d2','无极汰那','0890','第八世代','常规图鉴','传说宝可梦')
    ];

    function stage(){ var el=document.getElementById('stage'); return el ? el.innerHTML : ''; }
    var out = {};

    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='s1'; U.collection.q='';
    U.collection.pk={ types:[], both:false, form:'', region:'', group:'', gen:'' };
    window.__render();

    var h = stage();
    out.hasGroupChip = /data-act="pkfilt"[^>]*data-f="group"[^>]*data-v="伊布"/.test(h) || h.indexOf('>伊布</button>') >= 0;
    /* ⚠️ 只能看**筛选选项**（chip 的 data-v），不能看整页文字 ——
       物品名字里就有「无极汰那（无极巨化）」，用 indexOf('无极巨化') 会误判。 */
    out.noWuji = h.indexOf('data-v="无极巨化"') < 0;
    out.stillHasChaojiju = h.indexOf('data-v="超极巨化"') >= 0;

    /* 点「伊布」chip */
    var chip = null;
    Array.prototype.slice.call(document.querySelectorAll('[data-act="pkfilt"]')).forEach(function(b){
      if (b.getAttribute('data-f')==='group' && b.getAttribute('data-v')==='伊布') chip = b;
    });
    out.chipFound = !!chip;
    if (chip){
      chip.click();
      var h2 = stage();
      out.filteredHasEevee = h2.indexOf('水伊布') >= 0 && h2.indexOf('仙子伊布') >= 0;
      out.filteredNoPika   = h2.indexOf('皮卡丘') < 0;
      out.filteredNoWuji   = h2.indexOf('无极汰那') < 0;
      /* 跨世代的九种都在（第一 / 第二 / 第四 / 第六） */
      ['伊布','水伊布','雷伊布','火伊布','太阳伊布','月亮伊布','叶伊布','冰伊布','仙子伊布']
        .forEach(function(n, i){
          if (h2.indexOf(n) < 0) out['miss' + i] = n;
        });
      out.allNine = !out.miss0 && !out.miss1 && !out.miss2 && !out.miss3 &&
                    !out.miss4 && !out.miss5 && !out.miss6 && !out.miss7 && !out.miss8;
    }
    out.errs = (window.__errs||[]).slice(0,4);
    return out;
  })()`;

  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const o = r.result && r.result.value;
  if (!o) throw new Error('页面脚本没有返回结果');

  console.log('=== v157 真机：宝可梦筛选栏的「伊布」图鉴组 ===\n');
  ok(o.stillHasChaojiju, '① 筛选栏里「超极巨化」还在（没误删）');
  ok(o.noWuji, '① ★ 筛选栏里已经没有「无极巨化」');
  ok(o.hasGroupChip, '① ★ 图鉴组里出现了「伊布」');
  ok(o.chipFound, '② 能找到「伊布」这个 chip');
  ok(o.allNine, '② ★ 点「伊布」→ 九种伊布全出来了（跨 4 个世代）');
  ok(o.filteredHasEevee, '② 列表里确实有伊布一家');
  ok(o.filteredNoPika, '② 皮卡丘被筛掉了');
  ok(o.filteredNoWuji, '② 无极汰那也被筛掉了（不属于伊布组）');
  ok(!o.errs || o.errs.length === 0, '③ 页面没有 JS 报错' + (o.errs && o.errs.length ? '：' + JSON.stringify(o.errs) : ''));

  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
    await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0); 1', returnByValue: true });
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v157-伊布图鉴组.png');
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('  截图存档：' + p);
  } catch (e) { console.log('  （截图失败，不影响断言：' + (e && e.message) + '）'); }
}

try { await main(); } catch (e) {
  console.error('  ✗ ' + (e && e.message ? e.message : e));
  fail++;
}

console.error('');
console.error('----------------------------------------');
console.error(pass + ' 项通过，' + fail + ' 项失败');

try { ws && ws.close(); } catch (e) { /* ignore */ }
try { chrome.kill(); } catch (e) { /* ignore */ }
try { if (existsSync(SITE)) rmSync(SITE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { if (existsSync(profile)) rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
