/* ============================================================
 * e2e_alias_child_cdp.mjs —— v159 真机验证
 * ------------------------------------------------------------
 * ① 「＋ 备注」：表单里点它才冒出「备注名」那一行；填完保存，卡片上是
 *    「名称（黑）+ 备注名（灰小字）」。
 * ② 子系列聚拢：系列详情里同一子系列的物品连续显示、中间不插别的。
 *
 * 用真实鼠标事件点（不是 JS .click()）—— 排查"点了没反应"必须这样，见 mem-5。
 *
 * 用法：
 *     node tools/e2e_alias_child_cdp.mjs
 *     E2E_URL='https://…/?nosw' node tools/e2e_alias_child_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9338;
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-ac');
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
const profile = join(tmpdir(), 'ld-e2e-ac-prof-' + Date.now());
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
  await send('Page.navigate', {
    url: ONLINE || ('file:///' + join(SITE, 'index.html').replace(/\\/g, '/')),
  });
  await sleep(ONLINE ? 7000 : 3200);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})', returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errs));

  console.log('=== v159 备注名 + 子系列聚拢 真机验证 ===\n');

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
    if (!got) return false;
    const p = JSON.parse(got);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(320);
    return true;
  };

  /* ---------- ① 「＋ 备注」 ---------- */
  await ev(`(function(){
    var S=window.__store;
    S.collection.status='ok'; S.series.status='ok'; S.ip.status='ok';
    S.series.rows=[]; S.ip.rows=[]; S.collection.rows=[];
    var b=document.querySelector('[data-act="add"][data-key="collection"]');
    if(!b){ b=document.createElement('button');
      b.setAttribute('data-act','add'); b.setAttribute('data-key','collection');
      document.body.appendChild(b); }
    b.click(); return 1; })()`);
  await sleep(500);

  ok(await ev(`!!document.querySelector('[data-act="altadd"]')`), '① 名称输入框里有「＋ 备注」按钮');
  ok(await ev(`(function(){ var w=document.querySelector('[data-f="备注名"]');
      return !!w && !!w.closest('.f') && w.closest('.f').classList.contains('is-hidden'); })()`),
    '① 没点之前，「备注名」那一行是收起的');

  await clickAt('[data-act="altadd"]');
  ok(await ev(`(function(){ var w=document.querySelector('[data-f="备注名"]');
      return !!w && !w.closest('.f').classList.contains('is-hidden'); })()`),
    '①★ 真实鼠标点「＋ 备注」→ 「备注名」那一行出来了');
  ok(await ev(`document.activeElement && document.activeElement.getAttribute('data-f')==='备注名'`),
    '① 并且光标已经落在备注名输入框里');

  /* v161：字段顺序 + 动态宽度 —— 名称 1/4 + 备注名 1/4（紧挨着）、系列 1/4 + 比例 1/4。
     ⚠️ 取值要兼容两类：普通字段用 data-f；dyn 字段（IP/系列/小类）用 .dynwrap[data-k]。 */
  const LAY = `(function(){
    var cells = Array.prototype.slice.call(document.querySelectorAll('.fgrid .f'));
    var o = { order: [], nameCls:'', altCls:'', seriesCls:'', scaleCls:'' };
    cells.forEach(function(c){
      var i = c.querySelector('[data-f]'), k = '';
      if (i) k = i.getAttribute('data-f');
      else { var w = c.querySelector('.dynwrap[data-k]'); if (w) k = w.getAttribute('data-k'); }
      if (!k) return;
      if (o.order.length < 8) o.order.push(k);
      if (k==='名称') o.nameCls = c.className;
      if (k==='备注名') o.altCls = c.className;
      if (k==='系列') o.seriesCls = c.className;
      if (k==='比例') o.scaleCls = c.className;
    });
    return JSON.stringify(o); })()`;
  const L = JSON.parse(await ev(LAY) || '{}');
  console.log('  字段顺序：' + L.order.join(' / '));
  ok(L.order.slice(0,4).join(' ') === '名称 备注名 大类 小类',
    '①★ 顺序：名称 → 备注名 → 大类 → 小类');
  ok(L.order.indexOf('比例') === L.order.indexOf('系列') + 1, '①★ 「比例」紧跟在「系列」后面');
  ok(/\bq\b/.test(L.seriesCls), '① 手办时「系列」占 1/4（' + L.seriesCls + '）');
  ok(!/is-hidden/.test(L.altCls), '① 点了「＋ 备注」后备注名格子露出来了');
  ok(/\bq\b/.test(L.nameCls), '①★ 备注名出现 → 「名称」缩成 1/4（' + L.nameCls + '）');

  /* 换成非手办：比例藏起来、「系列」撑回 1/2 */
  await ev(`(function(){var b=document.querySelector('[data-f="大类"]');
    var opt=null; Array.prototype.slice.call(b.options).forEach(function(o){ if(o.value && o.value!=='手办') opt=o.value; });
    b.value=opt; b.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  await sleep(250);
  const L2 = JSON.parse(await ev(LAY) || '{}');
  ok(!/\bq\b/.test(L2.seriesCls), '①★ 不是手办 → 「系列」撑回 1/2（' + L2.seriesCls + '）');
  await ev(`(function(){var b=document.querySelector('[data-f="大类"]');
    b.value='手办'; b.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  await sleep(200);

  /* 填名称 + 备注名，保存 */
  await ev(`(function(){
    var n=document.querySelector('[data-f="名称"]');
    n.value='便携式折叠凳'; n.dispatchEvent(new Event('input',{bubbles:true}));
    var a=document.querySelector('[data-f="备注名"]');
    a.value='小凳子'; a.dispatchEvent(new Event('input',{bubbles:true}));
    return 1; })()`);
  await ev(`(function(){
    var b=document.querySelector('.sheet [data-act="save"], .sheet .btn.primary'); if(b) b.click(); return 1; })()`);
  await sleep(800);

  const saved = JSON.parse(await ev(`(function(){
    var r=(window.__store.collection.rows||[]).filter(function(x){return x['名称']==='便携式折叠凳';})[0]||{};
    return JSON.stringify({alt:r['备注名']||null}); })()`) || '{}');
  ok(saved.alt === '小凳子', '① 保存后备注名进了数据（' + JSON.stringify(saved.alt) + '）');

  /* 卡片上要显示「名称 + 灰小字备注名」 */
  await ev(`(function(){ var U=window.__ui;
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId=null; U.collection.q='';
    window.__render(); return 1; })()`);
  await sleep(400);
  const card = await ev(`(function(){
    var h4=null;
    Array.prototype.slice.call(document.querySelectorAll('.poster h4')).forEach(function(x){
      if (x.textContent.indexOf('便携式折叠凳')>=0) h4=x; });
    if(!h4) return '';
    var s=h4.querySelector('.altname');
    return JSON.stringify({ name:h4.textContent, hasAlt:!!s, altTxt:s?s.textContent:'',
      altSize:s?getComputedStyle(s).fontSize:'', nameSize:getComputedStyle(h4).fontSize,
      altColor:s?getComputedStyle(s).color:'' });
  })()`);
  const c = JSON.parse(card || '{}');
  ok(c.hasAlt, '①★ 卡片上出现了备注名');
  ok(c.name === '便携式折叠凳小凳子', '① 卡片上「名称+备注名」连着显示（' + c.name + '）');
  ok(parseFloat(c.altSize) < parseFloat(c.nameSize),
    '①★ 备注名的字号比名称小（' + c.altSize + ' < ' + c.nameSize + '）');

  /* ---------- ② 子系列聚拢 ---------- */
  await ev(`(function(){
    var S=window.__store;
    S.series.rows=[{_id:'rt', 系列名称:'Road Trip', 所属IP:'宝可梦',
      子系列:[{名称:'徽章',数量:0},{名称:'冰箱贴',数量:0},{名称:'行李牌',数量:0}], _upd:1,_rev:1}];
    function mk(id,n,no,child){ return {_id:id, 名称:n, 编号:no, 子系列:child, 系列:'Road Trip',
      IP:'宝可梦', 大类:'周边', 小类:'冰箱贴', 状态:['在库'], 持有:1, _upd:1,_rev:1}; }
    /* 故意让编号交错：徽章 001 / 冰箱贴 002 / 徽章 003 / 行李牌 004 / 冰箱贴 005 */
    S.collection.rows=[ mk('a1','徽章甲','001','徽章'), mk('b1','冰箱贴乙','002','冰箱贴'),
      mk('a2','徽章丙','003','徽章'), mk('c1','行李牌丁','004','行李牌'),
      mk('b2','冰箱贴戊','005','冰箱贴'), mk('a3','徽章己','006','徽章') ];
    /* 顺带放一条**带备注名**的，好让截图上一眼看到「名称 + 灰小字别名」 */
    var ex = mk('ex1','便携式折叠凳','007','');
    ex['备注名'] = '小凳子';
    S.collection.rows.push(ex);
    var U=window.__ui;
    U.view='collection'; U.collection.mode='cat'; U.collection.seriesId='rt';
    U.collection.ipId=null; U.collection.seriesChild='';
    window.__render(); return 1; })()`);
  await sleep(500);
  const order = await ev(`(function(){
    var out=[];
    Array.prototype.slice.call(document.querySelectorAll('.poster')).forEach(function(p){
      out.push(p.getAttribute('data-id')); });
    return JSON.stringify(out);
  })()`);
  const ord = JSON.parse(order || '[]');
  console.log('  系列详情的卡片顺序：' + JSON.stringify(ord));
  ok(ord.length >= 6, '② 系列详情里 6 件都在（' + ord.length + '）');
  const childOf = { a1:'徽章', a2:'徽章', a3:'徽章', b1:'冰箱贴', b2:'冰箱贴', c1:'行李牌', ex1:'' };
  let contiguous = true, seen = {};
  let prev = null;
  ord.forEach(function(id){
    const ch = childOf[id];
    if (ch !== prev){
      if (seen[ch]) contiguous = false;   /* 同一子系列被切开了 */
      seen[ch] = 1; prev = ch;
    }
  });
  ok(contiguous, '②★ 同一子系列的卡片连续在一起，中间没插别的');
  ok(ord.join(',').indexOf('a1,a2,a3') >= 0, '②★ 徽章三张挨着（登记顺序里它排第一）');
  ok(ord.join(',').indexOf('b1,b2') >= 0, '② 冰箱贴两张挨着');
  const errs = JSON.parse(await ev('JSON.stringify(window.__errs||[])') || '[]');
  ok(errs.length === 0, '③ 页面没有 JS 报错' + (errs.length ? '：' + JSON.stringify(errs) : ''));

  /* 截图 */
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1100, deviceScaleFactor: 2, mobile: false });
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v159-子系列聚拢.png');
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('  截图存档：' + p);
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
