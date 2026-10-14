/* ============================================================
 * e2e_rement_cdp.mjs —— v163：「第 N 弹」式系列（re-ment）真机验证
 * ------------------------------------------------------------
 * 场景：一个系列**自己没有封面、只有名字**，封面全挂在每一「弹」（子系列）上。
 * 验证：
 *   ① 系列详情里出现「弹」封面网格（全部 + 每一弹各一张）；
 *   ② 点某一张 = 只看那一弹（复用 seriesChild 筛选），卡片高亮；点「全部」回到整系列；
 *   ③ 系列表单里「添加子系列」能填封面；已有的弹点一下能载回来改（名称 / 数量 / 封面）；
 *   ④ 系列列表卡片：自己没封面时用**第一弹**的封面兜底。
 *
 * 真实鼠标事件点（不是 JS .click()）—— 见 mem-5。
 * 用法：  node tools/e2e_rement_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9341;
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-rm');
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
const profile = join(tmpdir(), 'ld-e2e-rm-prof-' + Date.now());
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
  /* ⚠️ 视口必须先设大：headless 默认窗口只有 ~758x426，
     弹窗底部的按钮会正好落在底部悬浮的 #dataTools（z-index:9999）下面而点不到。 */
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

  console.log('=== v163「弹」式系列（re-ment）真机验证 ===\n');

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

  const SER = 're-ment 宝可梦 掌心系列';
  /* ---------- 注入：无封面的系列 + 3 弹（各带封面）+ 每弹 2 件 ---------- */
  await ev(`(function(){
    var S=window.__store, U=window.__ui;
    S.collection.status='ok'; S.series.status='ok'; S.ip.status='ok';
    S.ip.rows=[{_id:'ip1', IP名称:'宝可梦', _upd:1,_rev:1}];
    /* 造一个真能渲染出来的 SVG 封面（假文件名会 404，截图上就是一片空白，看不出效果） */
    var sv=function(c,t){ return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="'+c+'"/><text x="80" y="76" font-size="32" fill="#fff" font-family="sans-serif" text-anchor="middle">'+t+'</text></svg>'); };
    S.series.rows=[{_id:'rm1', 系列名称:${JSON.stringify(SER)}, 所属IP:'宝可梦', 目标数量:0, _upd:1,_rev:1,
      子系列:[{名称:'第 1 弹', 数量:6, 封面:sv('#c2603f','弹1')},
             {名称:'第 2 弹', 数量:6, 封面:sv('#4a7d9e','弹2')},
             {名称:'第 3 弹', 数量:6, 封面:sv('#5d8a54','弹3')}]}];
    var rows=[];
    ['第 1 弹','第 2 弹','第 3 弹'].forEach(function(d, gi){
      for (var k=1;k<=2;k++){
        rows.push({_id:'i'+gi+'_'+k, 名称:d+' 的第 '+k+' 只', 大类:'手办', 小类:'景品',
          IP:'宝可梦', 系列:${JSON.stringify(SER)}, 子系列:d, 编号:String(gi*2+k).padStart(3,'0'),
          状态:['在库'], 持有:1, _upd:1,_rev:1});
      }
    });
    S.collection.rows=rows;
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='rm1'; U.collection.seriesChild='';
    U.collection.q=''; U.collection.qDraft=''; U.year='';
    window.__render(); return 1; })()`);
  await sleep(500);

  /* ---------- ① 弹的封面网格 ---------- */
  console.log('[①] 系列详情里的「弹」封面网格');
  ok(await ev(`!!document.querySelector('.childwall')`), '系列详情里出现「弹」封面网格');
  ok(await ev(`document.querySelectorAll('.childwall .childcard').length === 4`),
    '★ 一共 4 张卡：全部 + 3 弹（得到 ' + await ev(`document.querySelectorAll('.childwall .childcard').length`) + '）');
  ok(await ev(`(function(){
    var c=document.querySelector('.childcard[data-c="第 2 弹"]'); if(!c) return false;
    var cov=c.querySelector('.ccov'); if(!cov) return false;
    var bg=cov.getAttribute('style')||'';
    return bg.indexOf('svg+xml')>=0; })()`),
    '★ 「第 2 弹」那张卡用的是它自己的封面（卡上有图）');
  ok(await ev(`(function(){
    var a=document.querySelector('.childcard[data-c="第 1 弹"] .ccov').getAttribute('style')||'';
    var b=document.querySelector('.childcard[data-c="第 2 弹"] .ccov').getAttribute('style')||'';
    return a !== b && a.indexOf('svg')>=0 && b.indexOf('svg')>=0; })()`),
    '★ 每一弹用的是各自的封面（两张卡不一样）');
  ok(await ev(`(function(){
    var c=document.querySelector('.childcard[data-c="第 3 弹"]');
    return !!c && (c.querySelector('.ccnt')||{}).textContent === '2'; })()`),
    '卡片右上角标了这一弹有几件（2 件）');

  /* ---------- ② 点卡片 → 只看这一弹 ---------- */
  console.log('\n[②] 点一张卡 = 只看这一弹');
  await clickAt('.childwall .childcard[data-c="第 2 弹"]');
  await sleep(500);
  ok(await ev(`window.__ui.collection.seriesChild === '第 2 弹'`),
    '★ 点「第 2 弹」→ 筛选到该弹');
  const names = await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.wall .poster'),function(p){return (p.querySelector('h4')||{}).textContent;}))`);
  ok(String(names).indexOf('第 2 弹') >= 0 && String(names).indexOf('第 1 弹') < 0,
    '★ 物品墙只剩第 2 弹的东西（' + names + '）');
  ok(await ev(`(function(){ var c=document.querySelector('.childcard[data-c="第 2 弹"]'); return !!c && c.classList.contains('on'); })()`),
    '被选中的那张卡高亮');

  await clickAt('.childwall .childcard[data-c=""]');
  await sleep(500);
  ok(await ev(`window.__ui.collection.seriesChild === ''`), '★ 点「全部」→ 回到整系列');
  ok(await ev(`document.querySelectorAll('.wall .poster').length === 6`),
    '整系列 6 件又都出来了');

  /* ---------- ③ 系列表单里给「弹」填封面 ---------- */
  console.log('\n[③] 系列表单：给每一弹填封面');
  await ev(`(function(){ var U=window.__ui; U.collection.seriesId='rm1'; U.collection.seriesChild=''; window.__render(); return 1; })()`);
  await sleep(400);
  await clickAt('[data-act="edit"][data-key="series"]');
  await sleep(700);
  ok(await ev(`!!document.querySelector('.childpills .childpill')`), '表单里列出已有的 3 弹');
  ok(await ev(`document.querySelectorAll('.childpills .childpill .cpillcov').length === 3`),
    '★ 每一弹的药丸上都有封面缩略图');
  await clickAt('.childpills .childpill .cpick', 1);   /* 点第 2 个（第 2 弹）*/
  await sleep(400);
  ok(await ev(`(function(){ var n=document.querySelector('.childname'); return !!n && n.value === '第 2 弹'; })()`),
    '★ 点药丸 → 名称回填成「第 2 弹」');
  ok(await ev(`(function(){ var u=document.querySelector('.childcovurl'); return !!u && u.value.indexOf('svg+xml')>=0; })()`),
    '★ 封面也回填了（回填的就是这一弹的封面）');
  ok(await ev(`!!document.querySelector('.childrow2 .childcov')`), '有封面小预览');
  ok(await ev(`!!document.querySelector('#childUp')`), '有「上传」按钮');

  /* 改个数量 + 换封面 → 确认 → 保存 */
  await ev(`(function(){
    var c=document.querySelector('.childcnt'); c.value='8';
    var u=document.querySelector('.childcovurl'); u.value='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#aa3366"/></svg>'); u.dispatchEvent(new Event('input',{bubbles:true}));
    return 1; })()`);
  await clickAt('[data-act="childok"]');
  await sleep(400);
  await clickAt('#saveBtn');
  await sleep(1100);
  const childs = JSON.parse(await ev(`JSON.stringify((((window.__store.series.rows||[]).filter(function(r){return r._id==='rm1';})[0]||{})['子系列'])||[])`) || '[]');
  ok(childs[1] && childs[1]['名称'] === '第 2 弹' && Number(childs[1]['数量']) === 8,
    '★ 保存后第 2 弹变成「' + (childs[1] && childs[1]['数量']) + ' 件」（没新增一条）');
  ok(!!(childs[1] && String(childs[1]['封面']||'').indexOf('aa3366')>=0), '★ 封面也换成了新的那张');
  ok(childs.length === 3, '还是 3 弹（改的是原来那条，不是新增）');

  /* ---------- ④ 系列列表卡片：用第一弹封面兜底 ---------- */
  console.log('\n[④] 系列列表卡片（自己没封面 → 用第一弹的）');
  await ev(`(function(){
    var U=window.__ui; U.view='collection'; U.collection.classic=true;
    U.collection.seriesId=null; U.collection.seriesWall=''; U.collection.cat='';
    window.__render(); return 1; })()`);
  await sleep(500);
  ok(await ev(`(function(){
    var c=document.querySelector('.ipseries-card[data-id="rm1"] .ph') ||
          document.querySelector('.ipcard[data-id="rm1"] .ph');
    if (!c) return false;
    var s=c.getAttribute('style')||'';
    return s.indexOf('svg+xml')>=0; })()`),
    '★ 系列卡自己没封面 → 自动用了第一弹的封面（不再是空白/首字）');

  /* ④b v173：系列**自己**有封面时必须显示得出来 ——
     这是回归用例：v170 把封面改成「取景层变量」写法后，系列库那几处 `.ph` 宿主漏了 cv 类，
     变量下发到没有取景层的元素上 ⇒ **系列封面整个消失**（用户报「系列封面看不到了」）。 */
  await ev(`(function(){
    var S=window.__store;
    var sv=function(c,t){ return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="'+c+'"/><text x="80" y="76" font-size="30" fill="#fff" font-family="sans-serif" text-anchor="middle">'+t+'</text></svg>'); };
    S.series.rows[0]['封面']=[{imageUrl:sv('#3355aa','系列'), viewport:{s:1,x:0,y:0,v:2}}];
    window.__render(); return 1; })()`);
  await sleep(520);
  ok(await ev(`(function(){
    var c=document.querySelector('.ipcard[data-id="rm1"] .ph'); if(!c) return false;
    return c.classList.contains('cv') && (c.style.getPropertyValue('--cvi')||'').indexOf('svg+xml')>=0; })()`),
    '★ 系列自己带封面时能显示（宿主有 cv 类 + --cvi 已下发）');
  ok(await ev(`(function(){
    var c=document.querySelector('.ipcard[data-id="rm1"] .ph'); if(!c) return false;
    return (getComputedStyle(c,'::before').backgroundImage||'').indexOf('url(')>=0; })()`),
    '★ 取景层里确实画出了图（computed background-image 里有 url）');
  ok(await ev(`(function(){
    /* 系列详情页头那张（.iphero .ph）也要能显示 */
    var U=window.__ui; U.collection.seriesId='rm1'; window.__render(); return 1; })()`) !== null, '（切到系列详情）');
  await sleep(500);
  ok(await ev(`(function(){
    var c=document.querySelector('.iphero .ph'); if(!c) return false;
    return c.classList.contains('cv') && (getComputedStyle(c,'::before').backgroundImage||'').indexOf('url(')>=0; })()`),
    '★ 系列详情页头的封面也显示正常');

  const errs = JSON.parse(await ev('JSON.stringify(window.__errs||[])') || '[]');
  ok(errs.length === 0, '⑤ 页面没有 JS 报错' + (errs.length ? '：' + JSON.stringify(errs) : ''));

  /* 截图 */
  try {
    await ev(`(function(){
      var U=window.__ui; U.view='collection'; U.collection.classic=true;
      U.collection.seriesId='rm1'; U.collection.seriesChild='';
      window.__render(); return 1; })()`);
    await sleep(400);
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v163-弹式系列.png');
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('\n  截图存档：' + p);

    /* 第二张：系列 + 每一弹都**没有封面** —— 看「只有名字」时的样子（用户点名要试的） */
    await ev(`(function(){
      var S=window.__store;
      (S.series.rows||[]).forEach(function(r){
        if (Array.isArray(r['子系列'])){
          r['子系列']=r['子系列'].map(function(x){ return { 名称:x['名称'], 数量:x['数量'] }; });
        }
      });
      var U=window.__ui; U.collection.seriesId='rm1'; U.collection.seriesChild='';
      window.__render(); return 1; })()`);
    await sleep(400);
    const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const p2 = join(dir, 'v163-没有封面时.png');
    writeFileSync(p2, Buffer.from(shot2.data, 'base64'));
    console.log('  截图存档：' + p2);
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
