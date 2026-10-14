/* ============================================================
 * e2e_form_status_cdp.mjs —— 表单里「状态」勾选互斥的真机验证
 * ------------------------------------------------------------
 * 用户报的问题（截图）：在「添加」页面点「在库」时，「云游」没有被自动取消。
 *
 * 表单里的状态是 4 个 checkbox（在库 / 云游 / 想收 / 已预订），
 * 规矩是 v155 定的：**在库和云游二选一，有一个亮着**；
 * 勾「在库」要把另外三个全清掉。
 *
 * 这个脚本按用户的操作路径走一遍（点「药丸」label，不是直接点 input）：
 *   打开添加表单 → 点「云游」→ 点「在库」→ 看 DOM 勾选 + 保存后的数据。
 *
 * 用法：
 *     node tools/e2e_form_status_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9337;
/* 传了 E2E_URL 就跑线上那一份（用来分辨「代码真有 bug」和「浏览器还留着旧 app.js」）。 */
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-fs');
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
const profile = join(tmpdir(), 'ld-e2e-fs-prof-' + Date.now());
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
  /* ⚠️ 必须先把视口设成桌面尺寸：headless 默认窗口只有 ~758×426，
     会命中手机端媒体查询（`.fgrid{grid-template-columns:1fr}`）把表单塌成单列 ——
     那样「四个字段挤在一行」这类断言会假红（宽度设对了、布局却是一列）。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
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

  const script = `(async function(){
    var S = window.__store, U = window.__ui;
    await new Promise(function(r){ setTimeout(r, 1800); });

    S.series.status='ok'; S.ip.status='ok'; S.collection.status='ok';
    S.series.rows=[{_id:'s1', 系列名称:'Road Trip 第二弹', 所属IP:'宝可梦', _upd:1, _rev:1}];
    S.ip.rows=[{_id:'i1', IP名称:'宝可梦', _upd:1, _rev:1}];
    S.collection.rows=[];

    function openAdd(){
      var b = document.querySelector('[data-act="add"][data-key="collection"]');
      if (!b){ b=document.createElement('button');
        b.setAttribute('data-act','add'); b.setAttribute('data-key','collection');
        document.body.appendChild(b); }
      b.click();
    }
    function box(){ return document.querySelector('.checksrow[data-k="状态"]'); }
    function st(){
      var o = {};
      [].slice.call(box().querySelectorAll('input[type="checkbox"]')).forEach(function(i){
        o[i.getAttribute('data-v')] = i.checked;
      });
      return o;
    }
    function pill(v){   /* 用户点的是那颗「药丸」（label），不是里面的 input */
      var ins = [].slice.call(box().querySelectorAll('input[type="checkbox"]'));
      for (var i=0;i<ins.length;i++) if (ins[i].getAttribute('data-v')===v) return ins[i].closest('label') || ins[i];
      return null;
    }

    var out = { steps: [] };
    openAdd();
    out.hasBox = !!box();
    out.count = box() ? box().querySelectorAll('input[type="checkbox"]').length : 0;
    out.init = st();

    var p = pill('云游');
    out.pillIsLabel = !!(p && p.tagName === 'LABEL');
    if (p) p.click();
    out.afterCloud = st();

    p = pill('在库');
    if (p) p.click();
    out.afterOwn = st();

    /* 保存看看数据侧 */
    var nameInp = document.querySelector('[data-f="名称"]');
    if (nameInp){
      nameInp.value = '栈桥凳';
      nameInp.dispatchEvent(new Event('input', {bubbles:true}));
    }
    var saveBtn = document.querySelector('.sheet [data-act="save"], .sheet .btn.primary');
    out.saveBtn = !!saveBtn;
    if (saveBtn){
      saveBtn.click();
      await new Promise(function(r){ setTimeout(r, 700); });
      var r0 = (S.collection.rows || []).filter(function(x){ return x['名称']==='栈桥凳'; })[0];
      out.savedStatus = r0 ? r0['状态'] : null;
    }
    out.errs = (window.__errs||[]).slice(0,4);
    return out;
  })()`;

  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const o = r.result && r.result.value;
  if (!o) throw new Error('页面脚本没有返回结果');

  console.log('=== 表单「状态」勾选互斥 真机验证 ===\n');
  console.log('  初始：' + JSON.stringify(o.init));
  console.log('  点「云游」后：' + JSON.stringify(o.afterCloud));
  console.log('  再点「在库」后：' + JSON.stringify(o.afterOwn));
  console.log('');
  ok(o.hasBox, '找到状态勾选区');
  ok(o.count === 4, '状态区有 4 个选项（在库/云游/想收/已预订）');
  ok(o.pillIsLabel, '点击目标就是那颗「药丸」label');
  ok(o.init && o.init['在库'] === true && o.init['云游'] !== true, '新建表单默认是「在库」');
  ok(o.afterCloud && o.afterCloud['云游'] === true, '点「云游」→ 云游亮了');
  ok(o.afterCloud && o.afterCloud['在库'] !== true, '点「云游」→ 在库自动取消');
  ok(o.afterOwn && o.afterOwn['在库'] === true, '★ 点「在库」→ 在库亮了');
  ok(o.afterOwn && o.afterOwn['云游'] !== true, '★ 点「在库」→ 云游自动取消（用户报的就是这条）');
  ok(o.afterOwn && o.afterOwn['想收'] !== true && o.afterOwn['已预订'] !== true, '附加态也没被带上');
  if (o.saveBtn) ok(JSON.stringify(o.savedStatus) === JSON.stringify(['在库']), '保存后数据里就是 ["在库"]（得到 ' + JSON.stringify(o.savedStatus) + '）');
  ok(!o.errs || o.errs.length === 0, '页面没有 JS 报错' + (o.errs && o.errs.length ? '：' + JSON.stringify(o.errs) : ''));

  /* ---------- 第二轮：**用真实鼠标事件**点（和用户拿手点完全一样）----------
     ⚠️ 第一轮用的是 element.click()（JS 触发）——它绕过了「元素被遮挡 / 布局错位」这类问题。
        用户报的场景必须用真实鼠标坐标点才算数：先 scrollIntoView，再拿 boundingRect
        的中心坐标发 mousePressed/mouseReleased。 */
  console.log('\n  —— 第二轮：真实鼠标点击 ——\n');

  async function openForm() {
    await send('Runtime.evaluate', {
      expression: `(function(){
        var x = document.querySelector('.sheet .x'); if (x) x.click();
        var b = document.querySelector('[data-act="add"][data-key="collection"]');
        if (!b){ b = document.createElement('button');
          b.setAttribute('data-act','add'); b.setAttribute('data-key','collection');
          document.body.appendChild(b); }
        b.click(); return 1; })()`,
      returnByValue: true,
    });
    await sleep(450);
  }
  async function pillCenter(v) {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){
        var box = document.querySelector('.checksrow[data-k="状态"]'); if (!box) return '';
        var ins = [].slice.call(box.querySelectorAll('input[type="checkbox"]'));
        var t = null;
        ins.forEach(function(i){ if (i.getAttribute('data-v')===${JSON.stringify(v)}) t = i.closest('label') || i; });
        if (!t) return '';
        t.scrollIntoView({block:'center'});
        var b = t.getBoundingClientRect();
        var cover = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
        return JSON.stringify({ x: b.left + b.width/2, y: b.top + b.height/2,
          w: Math.round(b.width), h: Math.round(b.height),
          coverTag: cover ? cover.tagName : '', coverIsInside: !!(cover && t.contains(cover)) });
      })()`,
      returnByValue: true,
    });
    return r.result.value ? JSON.parse(r.result.value) : null;
  }
  async function realClick(pt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await sleep(320);
  }
  async function checkedNow() {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){
        var o = {};
        [].slice.call(document.querySelectorAll('.checksrow[data-k="状态"] input[type="checkbox"]'))
          .forEach(function(i){ o[i.getAttribute('data-v')] = i.checked; });
        return JSON.stringify(o); })()`,
      returnByValue: true,
    });
    return JSON.parse(r.result.value || '{}');
  }

  await openForm();
  const ptCloud = await pillCenter('云游');
  ok(!!ptCloud && ptCloud.w > 8 && ptCloud.h > 8, '「云游」药丸有可点面积（' +
    (ptCloud ? ptCloud.w + '×' + ptCloud.h : '—') + '）');
  ok(!!ptCloud && ptCloud.coverIsInside, '药丸中心处的元素就在它内部（没被别的东西盖住）');
  await realClick(ptCloud);
  console.log('  真实鼠标点「云游」后：' + JSON.stringify(await checkedNow()));

  const ptOwn = await pillCenter('在库');
  await realClick(ptOwn);
  const after = await checkedNow();
  const toastTxt = await send('Runtime.evaluate', {
    expression: `(function(){ var t=document.getElementById('toast'); return t ? t.textContent : ''; })()`,
    returnByValue: true,
  });
  const tip = String(toastTxt.result.value || '');
  console.log('  真实鼠标点「在库」后：' + JSON.stringify(after));
  console.log('  页面提示：' + JSON.stringify(tip));
  console.log('');
  ok(after['在库'] === true, '★ 真实鼠标点「在库」→ 在库亮了');
  ok(after['云游'] !== true, '★ 真实鼠标点「在库」→ 云游自动取消');
  ok(!after['想收'] && !after['已预订'], '附加态也没被带上');
  ok(tip.indexOf('在库') >= 0 && tip.indexOf('云游') >= 0,
    '★ 界面上明说了「已切到在库，云游自动取消了」（用户能看见反馈，不再靠猜）');

  /* ---------- 第三轮：手办「比例」字段的条件显示（v160）---------- */
  console.log('\n  —— 第三轮：手办比例 ——\n');

  async function ev2(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : null;
  }
  await openForm();
  ok(await ev2(`!!document.querySelector('.catfield[data-onlycat]')`), '③ 表单里有「比例」字段（带 onlycat 标记）');
  ok(await ev2(`(function(){var c=document.querySelector('.catfield[data-onlycat]');
      return !!c && !c.classList.contains('is-hidden');})()`), '③★ 大类是手办 → 比例显示出来');
  ok(await ev2(`(function(){var i=document.querySelector('[data-f="比例"]');
      return !!i && i.tagName==='INPUT' && !!i.getAttribute('list');})()`), '③ 比例是「可选可输」（input+datalist）');
  ok(await ev2(`(function(){var i=document.querySelector('[data-f="比例"]');
      var dl=document.getElementById(i.getAttribute('list')); if(!dl) return false;
      return Array.prototype.some.call(dl.querySelectorAll('option'), function(o){ return o.value==='1/7'; });})()`),
    '③ 候选里有 1/7 这类常用比例');

  await ev2(`(function(){var s=document.querySelector('[data-f="大类"]');
    var opt=null; Array.prototype.slice.call(s.options).forEach(function(o){ if(o.value && o.value!=='手办') opt=o.value; });
    s.value=opt; s.dispatchEvent(new Event('change',{bubbles:true})); return opt;})()`);
  await sleep(250);
  ok(await ev2(`(function(){var c=document.querySelector('.catfield[data-onlycat]');
      return c.classList.contains('is-hidden');})()`), '③★ 换成别的大类 → 比例自动藏起来');

  await ev2(`(function(){var s=document.querySelector('[data-f="大类"]');
    s.value='手办'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  await sleep(250);
  ok(await ev2(`(function(){var c=document.querySelector('.catfield[data-onlycat]');
      return !c.classList.contains('is-hidden');})()`), '③ 改回手办 → 比例又出来了');

  /* ---------- 第四轮：备注名按钮让位 + 四个字段挤成一行（v169）---------- */
  console.log('\n  —— 第四轮：备注名让位 & 一行放下 ——\n');
  await openForm();
  await sleep(400);

  const st0 = JSON.parse(await ev2(`(function(){
    var g=document.querySelector('.fgrid');
    var c=document.querySelector('.altfield');
    return JSON.stringify({
      fg12: !!g && g.classList.contains('fg12'),
      btn: !!document.querySelector('.altadd'),
      altHidden: !c || c.classList.contains('is-hidden')
    });})()`) || '{}');
  ok(st0.fg12 === false, '④（起手）还没点备注 → 仍是 4 栏制');
  ok(st0.altHidden, '④（起手）备注名输入框是藏着的');
  ok(st0.btn, '④（起手）名称框里那个「＋ 备注」按钮在');

  await ev2(`(function(){ document.querySelector('.altadd').click(); return 1; })()`);
  await sleep(400);

  const st1 = JSON.parse(await ev2(`(function(){
    var g=document.querySelector('.fgrid');
    var btn=document.querySelector('.altadd');
    var w={}, top={};
    /* ⚠️ v174：「小类」是 t:'dyn' 字段 —— 它渲染成 dynwrap + select[data-dyn-sel]，没有 data-f。
       上一版这里只按 [data-f] 找，小类永远找不到 ⇒ 断言被 hasSub 静默跳过，
       于是「小类没拿到 --w、被挤到第二行」这个 bug 一直没被测试拦住。
       ⚠️ 注意：这段注释在模板字符串里，**不能写反引号**（会把字符串提前截断）。 */
    function ctrl(k){ return document.querySelector('[data-f="'+k+'"], [data-dyn-sel="'+k+'"], .dynwrap[data-k="'+k+'"]'); }
    ['名称','备注名','大类','小类'].forEach(function(k){
      var i=ctrl(k);
      var cell=i && i.closest ? i.closest('.f') : null;
      w[k]  = cell ? (cell.style.getPropertyValue('--w')||'').trim() : 'x';
      top[k]= cell ? Math.round(cell.getBoundingClientRect().top) : -1;
    });
    return JSON.stringify({
      btnDisp: btn ? getComputedStyle(btn).display : 'none',
      fg12: !!g && g.classList.contains('fg12'),
      w: w, top: top
    });})()`) || '{}');

  ok(st1.btnDisp === 'none', '④★ 点完「＋ 备注」→ 按钮自己隐藏了（不再挡着名字）');
  ok(st1.fg12, '④★ 表单切到 12 栏制');
  /* v174：四个格子必须**都能找到**（小类的选择器见上）—— 缺一个就说明选择器又漏了 */
  ok(st1.top['小类'] > 0, '④★ 找得到「小类」那格（dyn 字段：data-dyn-sel，没有 data-f）');
  ok(st1.w['名称'] === '4' && st1.w['备注名'] === '4' && st1.w['大类'] === '2' && st1.w['小类'] === '2',
    '④★ 宽度 4 : 4 : 2 : 2（≈ 40% : 40% : 20% : 20%）—— 实际 ' + JSON.stringify(st1.w));
  const tops = ['名称','备注名','大类','小类'].map(function(k){ return st1.top[k]; });
  ok(tops.every(function(t){ return t > 0; }) && (Math.max.apply(null, tops) - Math.min.apply(null, tops)) < 8,
    '④★ 名称 / 备注名 / 大类 / 小类 在**同一行**（不再换行）—— top=' + JSON.stringify(tops));
  /* 一行 12 栏必须正好占满（4+4+2+2）—— 多一栏就会把最后一个挤下去 */
  ok(await ev2(`(function(){
    var g=document.querySelector('.fgrid'), last=g.querySelector('.f.q:nth-child(4)')||null;
    var cells=Array.prototype.slice.call(g.children).filter(function(c){
      var t=Math.round(c.getBoundingClientRect().top);
      return t === Math.round(g.querySelector('.f').getBoundingClientRect().top); });
    var used=0; cells.forEach(function(c){ used += parseFloat(c.style.getPropertyValue('--w')||'0'); });
    return cells.length === 4 && Math.abs(used - 12) < 0.01; })()`),
    '④★ 第一行正好 4 个格子、--w 合计 12 栏（占满一行）');
  ok(await ev2(`(function(){
    var i=document.querySelector('[data-f="备注名"]'); return !!i && i.offsetParent !== null; })()`),
    '④ 备注名输入框确实露出来了');

  /* 最后重新点一遍「云游」让提示条停在画面上，截一张存档 —— 给用户看"现在有反馈了" */
  try {
    const pt2 = await pillCenter('云游');
    await realClick(pt2);
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
    await sleep(350);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v158-状态互斥提示.png');
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
