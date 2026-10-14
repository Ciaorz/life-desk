/* ============================================================
 * e2e_cover_pan_cdp.mjs —— v170：封面「取景方向」一致性真机验证
 * ------------------------------------------------------------
 * 用户原话：「物品的封面上下调节和详情页的上下调节，和展示卡的上下调节，好像是不一样的，
 *            就是我在编辑页里面把封面往上拉，在展示卡和详情页反而会向下移动。」
 *
 * 根因：位移原来是 background-position:(50-x)% (50-y)%，x/y 是「背景**溢出**的百分比」，
 *      方向会随「图是否溢出框」翻转；卡片 3/4.2 / 预览 3/4 / 详情 min(50vh,440px)
 *      三个框宽高比不同 ⇒ 同一个 y 三处方向不一样。
 * 修法：位移改成取景层（.cv::before）的 transform:translate(x%, y%)，百分比相对框自身，
 *      与图大图小无关 ⇒ 方向恒定 + 与拖拽 1:1 跟手。
 *
 * 本测试只认「图形在框里的实际位置」（__panProbe 量的是 image_top），不认实现细节。
 * 用法：node tools/e2e_cover_pan_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9355;
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-pan');
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
const profile = join(tmpdir(), 'ld-e2e-pan-prof-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f2 = (v) => (v == null ? 'null' : Number(v).toFixed(2));

async function main() {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } }
    catch (e) { }
    await sleep(250);
  }
  if (!ready) throw new Error('Chrome 的 CDP 端口没起来');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  /* ⚠️ 视口先设桌面尺寸（headless 默认 ~758x426 会命中手机端媒体查询，几何断言会假红） */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e.message||e.error));});',
  });
  await send('Page.navigate', { url: ONLINE || ('file:///' + join(SITE, 'index.html').replace(/\\/g, '/')) });
  await sleep(ONLINE ? 7000 : 3200);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})', returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errs));

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
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(340);
    return true;
  };

  console.log('=== v170 封面取景方向一致性 真机验证 ===\n');

  /* __panProbe：量「图在框里的实际位置」。只认渲染结果（取景层的 transform + 背景尺寸），
     不认实现细节 —— 换实现也不用改测试。 */
  await ev(`window.__panProbe = async function(sel){
    var el = document.querySelector(sel); if (!el) return null;
    var pcs = getComputedStyle(el, '::before');
    var b = el.getBoundingClientRect();
    var m = /matrix\\(([^)]+)\\)/.exec(pcs.transform || '');
    var ty = 0, tx = 0;
    if (m){ var q = m[1].split(','); tx = parseFloat(q[4]); ty = parseFloat(q[5]); }
    var bs = String(pcs.backgroundSize || '').trim();
    /* ⚠️ v172：框**不再等于宿主的高度** —— 卡片底部要给「徽标留白」让出 1/6
       （.poster .cover.cv::before{bottom:calc(100%/6)}）。所以尺寸一律取取景层自己的盒，
       否则卡片那一路量出来的位置是错的（图会被算到留白里去）。 */
    var lw = parseFloat(pcs.width) || b.width;
    var lh = parseFloat(pcs.height) || b.height;
    var raw = (el.style.getPropertyValue('--cvi') || '').replace(/^url\\(\\s*['"]?/, '').replace(/['"]?\\s*\\)$/, '');
    var nat = await new Promise(function(res){
      if (!raw) return res([0,0]);
      var i = new Image();
      i.onload = function(){ res([i.naturalWidth, i.naturalHeight]); };
      i.onerror = function(){ res([0,0]); };
      i.src = raw;
    });
    var pm = /([\\d.]+)%/.exec(bs), rw = lw, rh = lw;
    if (pm && nat[0]){ rw = lw * parseFloat(pm[1]) / 100; rh = rw * nat[1] / nat[0]; }
    else if (/contain/i.test(bs) && nat[0]){ var k = Math.min(lw/nat[0], lh/nat[1]); rw = nat[0]*k; rh = nat[1]*k; }
    else if (nat[0]){ rh = lw * nat[1] / nat[0]; }
    var top = (lh - rh) / 2 + ty;      /* 图层内：图的上边缘离图层顶多远 */
    var left = (lw - rw) / 2 + tx;     /* 图层内：图的左边缘离图层左多远（v173 用） */
    return { w:Math.round(lw), h:Math.round(lh), rw:Math.round(rw), rh:Math.round(rh),
             tx:tx, ty:ty, top:top, left:left, frac: top / lh, nat:nat, bs:bs };
  };`);

  /* ---------- 注入：一张**正方形**封面（正是老 bug 最容易翻车的形状） ---------- */
  await ev(`(function(){
    var S=window.__store, U=window.__ui;
    S.collection.status='ok'; S.series.status='ok'; S.ip.status='ok';
    S.ip.rows=[{_id:'ip1', IP名称:'宝可梦', _upd:1,_rev:1}];
    S.series.rows=[{_id:'se1', 系列名称:'某系列', 所属IP:'宝可梦', 目标数量:0, _upd:1,_rev:1}];
    var sq='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#7a9c74"/><rect y="0" width="300" height="150" fill="#c2603f"/></svg>';
    S.collection.rows=[
      { _id:'q1', 名称:'方形封面', 大类:'手办', 小类:'景品', IP:'宝可梦', 系列:'某系列',
        状态:['在库'], 持有:1, 编号:'001', _upd:1,_rev:1,
        封面:[{imageUrl:'data:image/svg+xml,'+encodeURIComponent(sq), viewport:{s:1,x:0,y:0,v:2}}] },
      /* 老数据：没打 v:2（换算单位之前调的位移）—— 一律当 0，宁可居中也不乱飞 */
      { _id:'q2', 名称:'老数据封面', 大类:'手办', 小类:'景品', IP:'宝可梦', 系列:'某系列',
        状态:['在库'], 持有:1, 编号:'002', _upd:1,_rev:1,
        封面:[{imageUrl:'data:image/svg+xml,'+encodeURIComponent(sq), viewport:{s:1,x:0,y:97}}] }
    ];
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='se1'; U.collection.q=''; U.collection.qDraft='';
    U.year=''; U.dlcOpen={};
    window.__render(); return 1; })()`);
  await sleep(600);

  /* 把 q1 的位移设成 y，重新渲染（卡片墙） */
  async function setPan(y) {
    await ev(`(function(){
      var r = window.__store.collection.rows.filter(function(x){ return x._id==='q1'; })[0];
      r['封面'][0].viewport = { s:1, x:0, y:${y}, v:2 };
      window.__render(); return 1; })()`);
    await sleep(320);
  }

  /* ---------- ① 展示卡：y 越大，图越往下（跟手方向） ---------- */
  console.log('[①] 展示卡：y 增大 → 图往下走（不再反向）');
  await setPan(-30);
  const cM = await ev(`window.__panProbe('.poster[data-id="q1"] .cover')`);
  await setPan(0);
  const c0 = await ev(`window.__panProbe('.poster[data-id="q1"] .cover')`);
  await setPan(30);
  const cP = await ev(`window.__panProbe('.poster[data-id="q1"] .cover')`);
  ok(!!c0 && !!cM && !!cP, '能量到卡片封面的取景（框 ' + f2(c0 && c0.w) + '×' + f2(c0 && c0.h) + '）');
  ok(c0.nat[0] === 300 && c0.nat[1] === 300, '测试图是正方形（' + (c0.nat||[]).join('×') + '）—— 老写法正是在这种图上翻车');
  ok(cM.top < c0.top && c0.top < cP.top,
    '★ 图的位置随 y 单调下移（y=-30 → ' + f2(cM.top) + 'px，y=0 → ' + f2(c0.top) + 'px，y=30 → ' + f2(cP.top) + 'px）');

  /* ---------- ② 详情大图：方向和卡片一致 ---------- */
  console.log('\n[②] 详情大图：方向与展示卡一致');
  await setPan(-30);
  await clickAt('.poster[data-id="q1"]');
  await sleep(500);
  const dM = await ev(`window.__panProbe('.dbig')`);
  await ev(`(function(){ window.__store.collection.rows.filter(function(x){return x._id==='q1';})[0]['封面'][0].viewport={s:1,x:0,y:30,v:2}; return 1; })()`);
  await ev(`(function(){ var x=document.querySelector('[data-x="1"]'); if(x) x.click(); return 1; })()`);
  await sleep(300);
  await clickAt('.poster[data-id="q1"]');
  await sleep(500);
  const dP = await ev(`window.__panProbe('.dbig')`);
  ok(!!dM && !!dP, '能量到详情大图的取景（框 ' + f2(dM && dM.w) + '×' + f2(dM && dM.h) + '）');
  ok(dM.top < dP.top,
    '★ 详情页同样是「y 增大 → 图往下」（y=-30 → ' + f2(dM && dM.top) + 'px，y=30 → ' + f2(dP && dP.top) + 'px）');
  ok(dM.top !== cM.top, '（详情框尺寸和卡片不同 —— 但方向一致，这正是修好后的期望）');

  /* ---------- ③ 表单预览：方向和前两处一致 ---------- */
  console.log('\n[③] 编辑页封面预览：方向与卡片 / 详情一致');
  await clickAt('#dEdit');
  await sleep(600);
  const fHas = await ev(`!!document.querySelector('.imgwrap .imgprev')`);
  ok(fHas, '编辑页里找到封面预览（.imgprev）');
  const fP = await ev(`window.__panProbe('.imgwrap .imgprev')`);
  await ev(`(function(){
    var i=document.querySelector('[data-img-prev]');
    var host=document.querySelector('.imgwrap');
    /* 直接按新单位把位移设成 -30：模拟用户把图往上拉 */
    i.style.setProperty('--cvy','-30%');
    return 1; })()`);
  await sleep(200);
  const fM = await ev(`window.__panProbe('.imgwrap .imgprev')`);
  ok(!!fP && !!fM, '能量到编辑页预览的取景（框 ' + f2(fP && fP.w) + '×' + f2(fP && fP.h) + '）');
  ok(fM.top < fP.top, '★ 编辑页同样是「y 负值 → 图往上」（y=30 → ' + f2(fP && fP.top) + 'px，y=-30 → ' + f2(fM && fM.top) + 'px）');

  /* ---------- ④ 三处相对取景一致（WYSIWYG） ---------- */
  console.log('\n[④] 三处「取景」的相对位置一致（同一 y 应得到同一个画面）');
  await setPan(20);
  const c20 = await ev(`window.__panProbe('.poster[data-id="q1"] .cover')`);
  await ev(`(function(){ var x=document.querySelector('[data-x="1"]'); if(x) x.click(); return 1; })()`);
  await sleep(250);
  await clickAt('.poster[data-id="q1"]');
  await sleep(450);
  const d20 = await ev(`window.__panProbe('.dbig')`);
  await clickAt('#dEdit');
  await sleep(600);
  await ev(`(function(){ document.querySelector('[data-img-prev]').style.setProperty('--cvy','20%'); return 1; })()`);
  await sleep(200);
  const f20 = await ev(`window.__panProbe('.imgwrap .imgprev')`);
  ok(!!c20 && !!d20 && !!f20, '三处都量到了（卡片 / 详情 / 预览）');
  ok(near(c20.frac, f20.frac, 0.03),
    '★ 卡片与编辑页预览取景一致（图的上边缘位置占框高：卡片 ' + (c20.frac * 100).toFixed(1) + '% vs 预览 ' + (f20.frac * 100).toFixed(1) + '%）');
  ok(near(c20.frac, d20.frac, 0.03),
    '★ 卡片与详情大图取景一致（卡片 ' + (c20.frac * 100).toFixed(1) + '% vs 详情 ' + (d20.frac * 100).toFixed(1) + '%）');

  /* ---------- ⑤ 拖拽 1:1 跟手 ---------- */
  console.log('\n[⑤] 编辑页拖拽：拖多少像素，图就走多少（1:1、方向一致）');
  /* 先「重置」到 0（否则拖拽会从数据里的旧值开始算，断言没法对） */
  await clickAt('[data-img-reset]');
  await sleep(250);
  const before = await ev(`document.querySelector('[data-img-prev]').style.getPropertyValue('--cvy')`);
  /* ⚠️ 预览框很高（6/7），不先滚到视口中间的话中心点会落在屏幕外，鼠标事件打不到 */
  const box = await ev(`(function(){
    var el=document.querySelector('[data-img-prev]');
    el.scrollIntoView({block:'center'});
    var b=el.getBoundingClientRect();
    return JSON.stringify({x:b.left+b.width/2, y:b.top+b.height/2, h:el.clientHeight, vh:window.innerHeight}); })()`);
  const bb = JSON.parse(box);
  if (!(bb.y > 10 && bb.y < bb.vh - 10)) console.log('    [diag] 预览中心 y=' + Math.round(bb.y) + ' 视口高=' + bb.vh);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bb.x, y: bb.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bb.x, y: bb.y, button: 'left', clickCount: 1 });
  for (const dy of [-15, -30, -45, -60]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bb.x, y: bb.y + dy, button: 'left' });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bb.x, y: bb.y - 60, button: 'left', clickCount: 1 });
  await sleep(300);
  const after = await ev(`document.querySelector('[data-img-prev]').style.getPropertyValue('--cvy')`);
  const bN = parseFloat(before) || 0, aN = parseFloat(after) || 0;
  const want = bN - 60 / bb.h * 100;   /* 往上拖 60px = 位移减少 60/框高 的量 */
  ok(aN < bN, '★ 往上拖 → y 变小（图跟着往上走）：' + before + ' → ' + after);
  ok(near(aN, want, 3), '★ 位移量与拖动距离 1:1（拖 60px、框高 ' + Math.round(bb.h) + 'px → 期望 ' + f2(want) + '%，实际 ' + f2(aN) + '%）');

  /* ---------- ⑥ 老数据（没 v:2 标记）不会乱飞 ---------- */
  console.log('\n[⑥] 老单位数据：位移先不生效（居中），迁移后才按新值走');
  await ev(`(function(){ var x=document.querySelector('[data-x="1"]'); if(x) x.click(); return 1; })()`);
  await sleep(250);
  const oldP = await ev(`window.__panProbe('.poster[data-id="q2"] .cover')`);
  const oldVp = await ev(`(function(){ var r=window.__store.collection.rows.filter(function(x){return x._id==='q2';})[0];
    return JSON.stringify(r['封面'][0].viewport); })()`);
  ok(!!oldP, '老数据那张卡也渲染出来了');
  ok(near(oldP.ty, 0, 0.6), '★ 老位移 y=97 被忽略（取景层 ty=' + f2(oldP.ty) + 'px）—— 不会因为换了单位而飞出框外');
  ok(JSON.parse(oldVp).y === 97, '数据本身没被动过（还是 97，等迁移脚本换算）：' + oldVp);

  /* ---------- ⑦ 放大后拖动：位移被夹住，框里不留白边（v173） ---------- */
  console.log('\n[⑦] 放大后拖动：位移被夹住，不留白边（v173）');
  /* ⚠️ ⑥ 里把弹窗关掉了 —— 先重新打开编辑页，否则取不到 .imgprev */
  await clickAt('.poster[data-id="q1"]');
  await sleep(450);
  await clickAt('#dEdit');
  await sleep(700);
  ok(await ev(`!!document.querySelector('.imgwrap .imgprev')`), '重新打开编辑页（⑦ 用）');
  await ev(`(function(){
    var sl=document.querySelector('[data-img-zoomslider]');
    sl.value='1.5'; sl.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(260);
  await ev(`(function(){
    var sx=document.querySelector('[data-img-panslider-x]'), sy=document.querySelector('[data-img-panslider-y]');
    sx.value='100'; sx.dispatchEvent(new Event('input',{bubbles:true}));
    sy.value='100'; sy.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(300);
  const z8 = await ev(`window.__panProbe('.imgwrap .imgprev')`);
  ok(!!z8 && z8.w > 0, '量到放大 150% 后的取景（框 ' + f2(z8 && z8.w) + '×' + f2(z8 && z8.h) + '）');
  /* 正方形图 + 框 6/7：150% 时横向可动半幅 = 50×(1.5−1) = 25%，
     纵向 = 50×(1.5×6/7 − 1) ≈ 14.29% —— 滑杆推到 100 也只能到这个值 */
  /* ⚠️ 探针的 tx/ty 是从 matrix 里抠出来的**像素**，要换算成「占框宽/框高的比例」再比 */
  const txPct = z8.tx / z8.w * 100, tyPct = z8.ty / z8.h * 100;
  ok(near(txPct, 25, 1), '★ 横向位移被夹到 25%（推到 100 也只有 ' + f2(txPct) + '%）');
  ok(near(tyPct, 14.29, 1), '★ 纵向位移被夹到 ≈14.29%（得到 ' + f2(tyPct) + '%）');
  ok(z8.left <= 0.5 && z8.left + z8.rw >= z8.w - 0.5,
    '★ 图横向仍然盖满框（左边 ' + f2(z8.left) + ' ≤ 0，右边 ' + f2(z8.left + z8.rw) + ' ≥ ' + f2(z8.w) + '）—— 不露白边');
  ok(z8.top <= 0.5 && z8.top + z8.rh >= z8.h - 0.5,
    '★ 图纵向也盖满框（顶 ' + f2(z8.top) + ' ≤ 0，底 ' + f2(z8.top + z8.rh) + ' ≥ ' + f2(z8.h) + '）');
  /* 图比框小（未放大）时**不夹** —— 那是用户故意挪动看图外的空白，别去动他 */
  await ev(`(function(){
    var sl=document.querySelector('[data-img-zoomslider]');
    sl.value='1'; sl.dispatchEvent(new Event('input',{bubbles:true}));
    var sy=document.querySelector('[data-img-panslider-y]');
    sy.value='60'; sy.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(300);
  const z9 = await ev(`window.__panProbe('.imgwrap .imgprev')`);
  ok(near(z9.ty / z9.h * 100, 60, 1), '★ 没放大（图填不满框）时**不夹**，位移照旧生效（ty=' + f2(z9.ty / z9.h * 100) + '%）');

  /* ---------- ⑦ 无 JS 报错 ---------- */
  const errs = await ev(`JSON.stringify((window.__errs||[]).slice(0,4))`);
  ok(errs === '[]', '没有 JS 报错 ' + (errs === '[]' ? '' : errs));

  /* ---------- 截图存档 ---------- */
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'v170-取景方向一致.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  截图存档：v170-取景方向一致.png');
  } catch (e) { }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  try { chrome.kill(); } catch (e) { }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('出错：', e && e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
