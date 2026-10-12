/* ============================================================
 * e2e_detail_cdp.mjs —— v168：详情弹窗改版（大封面 + 两行快速编辑）真机验证
 * ------------------------------------------------------------
 * 布局：头部（标题 / ‹ › / ×）→ **大封面**（点一下看原图）→ 名称 + 大类·小类·IP
 *       → 第一行：状态药丸（在库 / 云游 / 想收，可点切换）
 *       → 第二行：快速编辑五项（价格 / 购入时间 / 购入渠道 / 持有数 / 存放位置）
 *       → 底部：删除 / 关闭 / 编辑
 *
 * 用法：  node tools/e2e_detail_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9343;
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-dt');
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
const profile = join(tmpdir(), 'ld-e2e-dt-prof-' + Date.now());
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
  /* ⚠️ 视口要先设大：headless 默认 ~758x426，弹窗底部按钮会被底部悬浮的 #dataTools 盖住 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e.message||e.error));});',
  });
  await send('Page.navigate', {
    url: ONLINE || ('file:///' + join(SITE, 'index.html').replace(/\\/g, '/')),
  });
  await sleep(ONLINE ? 7000 : 3200);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})', returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errors || D.errs));

  console.log('=== v168 详情弹窗改版 真机验证 ===\n');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : null;
  };
  const clickAt = async (sel, nth) => {
    const got = await ev(`(function(){
      var els = document.querySelectorAll(${JSON.stringify(sel)});
      var t = els[${nth || 0}]; if (!t) return '';
      t.scrollIntoView({block:'center'});
      var b = t.getBoundingClientRect();
      return JSON.stringify({x:b.left+b.width/2, y:b.top+b.height/2});
    })()`);
    if (!got) { console.log('    [diag] 找不到元素 ' + sel); return false; }
    const p = JSON.parse(got);
    const blocked = await ev(`(function(){
      var e=document.elementFromPoint(${p.x}, ${p.y});
      var t=document.querySelectorAll(${JSON.stringify(sel)})[${nth || 0}];
      if (!e || !t) return 'null';
      return ((t===e)||t.contains(e)||e.contains(t)) ? '' : (e.tagName+'#'+(e.id||''));
    })()`);
    if (blocked) console.log('    [diag] ' + sel + ' 被遮挡，最顶层=' + blocked);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(320);
    return true;
  };

  /* ---------- 注入一条信息齐全的藏品 ---------- */
  await ev(`(function(){
    var S=window.__store, U=window.__ui;
    S.collection.status='ok'; S.series.status='ok'; S.ip.status='ok'; S.loc.status='ok';
    S.ip.rows=[{_id:'ip1', IP名称:'宝可梦', _upd:1,_rev:1}];
    S.loc.rows=[{_id:'l1', 地点名称:'客厅柜', _upd:1,_rev:1}];
    S.series.rows=[{_id:'se1', 系列名称:'某系列', 所属IP:'宝可梦', 目标数量:0, _upd:1,_rev:1}];
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#8a6f9e"/></svg>';
    S.collection.rows=[
      {_id:'d1', 名称:'测试手办', 大类:'手办', 小类:'景品', IP:'宝可梦', 系列:'某系列',
       状态:['在库'], 持有:2, 编号:'001', 购入价格:180, 购入日期:'2026-09-20',
       购入渠道:'淘宝', 存储地点:'客厅柜', 星级:4, _upd:1,_rev:1,
       封面:[{imageUrl:'data:image/svg+xml,'+encodeURIComponent(svg)}]}
    ];
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='se1'; U.collection.q=''; U.collection.qDraft='';
    U.year=''; U.dlcOpen={};
    window.__render(); return 1; })()`);
  await sleep(500);

  /* ---------- ① 打开详情 ---------- */
  console.log('[①] 弹窗结构：大封面占大面积');
  await clickAt('.poster[data-id="d1"]');
  await sleep(500);
  ok(await ev(`!!document.querySelector('.detail-sheet')`), '详情弹窗打开了');
  ok(await ev(`!!document.querySelector('.dbig')`), '★ 有大封面区');
  const bigH = Number(await ev(`Math.round(document.querySelector('.dbig').getBoundingClientRect().height)`));
  const vh = Number(await ev(`window.innerHeight`));
  ok(bigH >= vh * 0.28, '★ 大封面确实占大面积（' + bigH + 'px / 视口 ' + vh + 'px）');
  ok(await ev(`(document.querySelector('.dbig').getAttribute('style')||'').indexOf('background-image')>=0`),
    '大封面用的是这件东西的图');
  ok(await ev(`(function(){var n=document.querySelector('.dname'); return !!n && n.textContent.indexOf('测试手办')>=0;})()`),
    '名称在');
  ok(await ev(`(function(){var s=document.querySelector('.dsub'); return !!s && s.textContent.indexOf('手办')>=0 && s.textContent.indexOf('宝可梦')>=0;})()`),
    '副信息显示「大类 · 小类 · IP」');

  /* ---------- ② 第一行：状态药丸 ---------- */
  console.log('\n[②] 第一行：状态（可点切换）');
  ok(await ev(`document.querySelectorAll('.dstat .dstat-btn').length === 3`),
    '三个药丸：在库 / 云游 / 想收');
  ok(await ev(`(function(){var b=document.querySelector('.dstat-btn[data-dstat="在库"]'); return !!b && b.classList.contains('on');})()`),
    '当前是「在库」→ 它亮着');
  await clickAt('.dstat-btn[data-dstat="想收"]');
  await sleep(450);
  const st1 = await ev(`JSON.stringify((window.__store.collection.rows.filter(function(r){return r._id==='d1';})[0]||{})['状态'])`);
  ok(String(st1).indexOf('想收') >= 0, '★ 点「想收」→ 状态里有想收（' + st1 + '）');
  ok(String(st1).indexOf('云游') >= 0, '★ 且自动落回「云游」（想收是挂在云游上的附加态，' + st1 + '）');
  ok(await ev(`(function(){var b=document.querySelector('.dstat-btn[data-dstat="想收"]'); return !!b && b.classList.contains('on');})()`),
    '「想收」药丸亮了（弹窗就地重画）');
  await clickAt('.dstat-btn[data-dstat="在库"]');
  await sleep(450);
  const st2 = await ev(`JSON.stringify((window.__store.collection.rows.filter(function(r){return r._id==='d1';})[0]||{})['状态'])`);
  ok(String(st2).indexOf('在库') >= 0 && String(st2).indexOf('想收') < 0,
    '★ 再点「在库」→ 回在库，且想收被清掉（' + st2 + '）');

  /* ---------- ③ 第二行：快速编辑五项 ---------- */
  console.log('\n[③] 第二行：快速编辑（价格 / 时间 / 渠道 / 持有 / 位置）');
  const qn = Number(await ev(`document.querySelectorAll('.dquick .dq').length`));
  ok(qn >= 5, '★ 第二行有 ' + qn + ' 个可点的小块（用户点名的五项都在）');
  const qt = await ev(`document.querySelector('.dquick').textContent`);
  ok(String(qt).indexOf('180') >= 0, '里面有价格 ¥180');
  ok(String(qt).indexOf('2026-09-20') >= 0, '有购入时间');
  ok(String(qt).indexOf('淘宝') >= 0, '有购入渠道');
  ok(String(qt).indexOf('客厅柜') >= 0, '有存放位置');
  ok(await ev(`!!document.querySelector('.dquick .dq-hold')`), '持有是 − / ＋ 步进器');

  /* 点价格 → 就地出输入框；改完回写 */
  await clickAt('.dquick .dq[data-edin="购入价格"]');
  await sleep(350);
  ok(await ev(`!!document.querySelector('.dquick .edin')`), '★ 点价格 → 就地出现输入框（不弹窗）');
  await ev(`(function(){
    var i=document.querySelector('.dquick .edin');
    i.value='260'; i.dispatchEvent(new Event('change',{bubbles:true})); i.blur();
    return 1; })()`);
  await sleep(500);
  ok(Number(await ev(`(window.__store.collection.rows.filter(function(r){return r._id==='d1';})[0]||{})['购入价格']`)) === 260,
    '★ 改成 260 → 写进数据了');

  /* 持有 ＋ */
  const hold0 = Number(await ev(`(function(){var r=window.__store.collection.rows.filter(function(x){return x._id==='d1';})[0]; return r['持有'];})()`));
  await clickAt('.dquick .dq-hold [data-hold="1"]');
  await sleep(450);
  const hold1 = Number(await ev(`(function(){var r=window.__store.collection.rows.filter(function(x){return x._id==='d1';})[0]; return r['持有'];})()`));
  ok(hold1 === hold0 + 1, '★ 点「＋」→ 持有从 ' + hold0 + ' 变 ' + hold1);

  /* ---------- ④ 点大封面看原图 ---------- */
  console.log('\n[④] 点大封面 → 全屏看图');
  await clickAt('.dbig');
  await sleep(450);
  ok(await ev(`!!document.querySelector('.imgfull')`), '★ 点大封面 → 全屏预览打开');
  ok(await ev(`(function(){var p=document.querySelector('.ifpic'); return !!p && (p.getAttribute('style')||'').indexOf('background-image')>=0;})()`),
    '全屏里是同一张图');
  await clickAt('.imgfull');
  await sleep(350);
  ok(!(await ev(`!!document.querySelector('.imgfull')`)), '点任意处 / Esc 能关掉');

  /* ---------- ⑤ 收尾 ---------- */
  console.log('\n[⑤] 底部按钮与报错');
  ok(await ev(`!!document.getElementById('dEdit') && !!document.getElementById('dDel')`),
    '底部「删除 / 编辑」都在');

  const errs = JSON.parse(await ev('JSON.stringify(window.__errs||[])') || '[]');
  ok(errs.length === 0, '页面没有 JS 报错' + (errs.length ? '：' + JSON.stringify(errs) : ''));

  /* 截图 */
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
    await sleep(350);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v168-详情弹窗.png');
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('\n  截图存档：' + p);
  } catch (e) { console.log('  （截图失败：' + (e && e.message) + '）'); }
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
