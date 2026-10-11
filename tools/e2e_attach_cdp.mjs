/* ============================================================
 * e2e_attach_cdp.mjs —— v162 附件（DLC / 特典…）真机验证
 * ------------------------------------------------------------
 * ① 卡片**右下角**的类型标签（不是封面里），点了才在右边并出附件展示卡；
 *    多个类型可同时展开、一个类型下多个附件出多张卡；再点收回。
 * ② 编辑表单里「归位」后面的「附件」按钮 → 右边并出附件面板（左=本体，右=附件）；
 *    添加附件、填名称/类型/价格（输入不重绘、焦点不丢）、保存进数据。
 *
 * 真实鼠标事件点（不是 JS .click()）—— 见 mem-5。
 *
 * 用法：
 *     node tools/e2e_attach_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9339;
const ONLINE = process.env.E2E_URL || '';
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-at');
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
const profile = join(tmpdir(), 'ld-e2e-at-prof-' + Date.now());
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
  /* ⚠️ 视口必须先设大：headless 默认窗口只有 ~758x426，详情弹窗底部的
     「编辑 / 保存」按钮会正好落在底部悬浮的 #dataTools（position:fixed; z-index:9999）
     下面而点不到 —— 是**测试环境**的坑，不是产品 bug。 */
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
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.Errs || D.errs));

  console.log('=== v162 附件（DLC / 特典）真机验证 ===\n');

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
    /* 点之前确认「那个坐标上最顶层的就是目标（或它的祖先/后代）」——
       否则说明被别的元素盖住了（真机上就是「点了没反应」）。 */
    const blocked = await ev(`(function(){
      var e=document.elementFromPoint(${p.x}, ${p.y});
      var t=document.querySelectorAll(${JSON.stringify(sel)})[${nth || 0}];
      if (!e || !t) return 'null';
      var inside = (t===e) || t.contains(e) || e.contains(t);
      return inside ? '' : (e.tagName+'#'+(e.id||'')+' act='+(e.getAttribute&&e.getAttribute('data-act')||''));
    })()`);
    if (blocked) console.log('    [diag] ' + sel + ' 被遮挡，最顶层=' + blocked);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(320);
    return true;
  };

  /* ---------- 注入数据：一条挂 2 个附件（DLC + 特典）、一条没有 ---------- */
  await ev(`(function(){
    var S=window.__store, U=window.__ui;
    S.collection.status='ok'; S.series.status='ok'; S.ip.status='ok';
    S.ip.rows=[];
    S.series.rows=[{_id:'se1', 系列名称:'某系列', 所属IP:'宝可梦', 目标数量:0, _upd:1,_rev:1}];
    S.collection.rows=[
      {_id:'a1', 名称:'带附件的手办', 大类:'手办', 小类:'景品', IP:'宝可梦', 系列:'某系列',
       状态:['在库'], 持有:1, 编号:'001', _upd:1,_rev:1,
       附件:[{名称:'特典亚克力立牌', 类型:'DLC', 价格:120},
             {名称:'限定挂件', 类型:'特典', 价格:80}]},
      {_id:'a2', 名称:'没有附件的', 大类:'手办', IP:'宝可梦', 系列:'某系列',
       状态:['在库'], 持有:1, 编号:'002', _upd:1,_rev:1}
    ];
    U.view='collection'; U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='se1'; U.collection.q=''; U.collection.qDraft='';
    U.collection.classic=true; U.collection.view='wall';
    U.year='';
    U.dlcOpen={};
    window.__render(); return 1; })()`);
  await sleep(500);
  console.log('  诊断：卡片 id = ' + await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.poster'),function(p){return p.getAttribute('data-id');}))`));

  /* ---------- ① 卡片右下角的类型标签 ---------- */
  console.log('[①] 卡片右下角的类型标签');
  ok(await ev(`!!document.querySelector('.poster .dlctags .dlctag[data-t="DLC"]')`),
    '有附件的卡片上出现 DLC 标签');
  ok(await ev(`!!document.querySelector('.poster .dlctags .dlctag[data-t="特典"]')`),
    '特典标签也在（一个类型一个标签）');
  ok(await ev(`(function(){
    var t=document.querySelector('.poster .dlctags .dlctag');
    return !!t && !t.closest('.cover'); })()`),
    '★ 标签不在封面里（用户要求：放整个卡片的右下角，不是封面右下角）');
  ok(await ev(`(function(){
    var p=document.querySelector('.poster.hasdlc'); if(!p) return false;
    var t=p.querySelector('.dlctags'); if(!t) return false;
    var pb=p.getBoundingClientRect(), tb=t.getBoundingClientRect();
    return (pb.right - tb.right) < 14 && (pb.bottom - tb.bottom) < 16; })()`),
    '★ 标签确实贴着卡片的右下角');
  ok(await ev(`(function(){
    var t=document.querySelector('.poster .dlctag'); if(!t) return false;
    var b=t.getBoundingClientRect();
    return b.height >= 20 && b.width >= 26; })()`),
    '★ 标签的点击热区够大（用户报「容易点不到」）—— 实测 '
      + await ev(`(function(){var b=document.querySelector('.poster .dlctag').getBoundingClientRect(); return Math.round(b.width)+'×'+Math.round(b.height);})()`));
  ok(await ev(`(function(){
    var p=document.querySelector('.poster[data-id="a2"]');
    return !!p && !p.querySelector('.dlctag'); })()`),
    '没附件的卡片上不出现标签');
  ok(!(await ev(`!!document.querySelector('.dlccard')`)), '默认收起（画面里没有附件展示卡）');

  /* ---------- ①b 点标签 → 展开附件展示卡 ---------- */
  await clickAt('.poster .dlctags .dlctag[data-t="DLC"]');
  ok(await ev(`!!document.querySelector('.dlccard')`), '★ 真实鼠标点 DLC 标签 → 右边并出附件展示卡');
  ok(await ev(`(function(){ var c=document.querySelector('.dlccard');
    return !!c && (c.querySelector('.dlckind')||{}).textContent === 'DLC'; })()`),
    '展示卡左上角写着 DLC');
  ok(await ev(`(function(){ var c=document.querySelector('.dlccard');
    return !!c && c.textContent.indexOf('特典亚克力立牌')>=0; })()`),
    '展示卡上是附件名称');
  ok(await ev(`(function(){ var c=document.querySelector('.dlccard');
    return !!c && c.textContent.indexOf('120')>=0; })()`),
    '展示卡上带价格');

  await clickAt('.poster .dlctags .dlctag[data-t="DLC"]');
  ok(!(await ev(`!!document.querySelector('.dlccard')`)), '★ 再点一次 DLC → 展示卡收起（默认隐藏）');

  await clickAt('.poster .dlctags .dlctag[data-t="DLC"]');
  await clickAt('.poster .dlctags .dlctag[data-t="特典"]');
  ok(await ev(`document.querySelectorAll('.dlccard').length === 2`),
    '★ 两个类型可以同时展开（附件能挂多个）');
  await clickAt('.poster .dlctags .dlctag[data-t="DLC"]');
  await clickAt('.poster .dlctags .dlctag[data-t="特典"]');

  /* ---------- ② 附件编辑面板 ---------- */
  console.log('\n[②] 附件编辑页（左右并排）');
  await clickAt('.poster[data-id="a1"]');
  await sleep(450);
  await clickAt('#dEdit');
  await sleep(600);
  ok(await ev(`!!document.querySelector('.sheet [data-act="attopen"]')`), '表单头部有「附件」按钮');
  ok(await ev(`(function(){
    var g=document.querySelector('[data-act="guiwei"]'), a=document.querySelector('[data-act="attopen"]');
    if(!g||!a) return false;
    return !!(g.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); })()`),
    '★ 「附件」按钮就在「归位」后面');

  await clickAt('[data-act="attopen"]');
  ok(await ev(`!!document.querySelector('.sheet-attach')`), '★ 点「附件」→ 右边并出附件面板');
  ok(await ev(`!!document.querySelector('.sheet-attach [data-act="attsave"]')`),
    '★ 附件面板自带「保存」按钮（用户不用再去左边找）');
  ok(await ev(`!!document.querySelector('.sheet-attach .att-tip')`),
    '并有一句「改完要点保存」的提示');
  ok(await ev(`document.getElementById('sheetHost').classList.contains('pair')`),
    '弹出层切成了并排布局');
  ok(await ev(`(function(){
    var s=document.querySelectorAll('#sheetHost .sheet');
    if(s.length<2) return false;
    var m=s[0].getBoundingClientRect(), a=s[1].getBoundingClientRect();
    return a.left >= m.right - 10; })()`),
    '★ 附件面板在本体的**右边**（一左一右）');
  ok(await ev(`document.querySelectorAll('.attitem').length === 2`),
    '面板里列出已有的 2 个附件');

  await clickAt('[data-act="attadd"]');
  ok(await ev(`!!document.querySelector('[data-att-f="名称"]') &&
               !!document.querySelector('[data-att-f="类型"]') &&
               !!document.querySelector('[data-att-f="价格"]') &&
               !!document.querySelector('[data-att-f="封面"]')`),
    '★ 「＋ 添加附件」后出现名称 / 类型 / 价格 / 封面 四个字段');

  await ev(`(function(){
    var i=document.querySelector('[data-att-f="名称"]');
    i.focus(); i.value='限定亚克力立牌'; i.dispatchEvent(new Event('input',{bubbles:true}));
    return 1; })()`);
  ok(await ev(`document.activeElement && document.activeElement.getAttribute('data-att-f')==='名称'`),
    '★ 输入时不重绘表单、焦点没丢');
  ok(await ev(`(function(){
    var b=document.querySelectorAll('.attitem')[2];
    return !!b && b.querySelector('span').textContent === '限定亚克力立牌'; })()`),
    '左侧列表的名字跟着变');

  await ev(`(function(){
    var t=document.querySelector('[data-att-f="类型"]');
    t.value='DLC'; t.dispatchEvent(new Event('input',{bubbles:true}));
    var p=document.querySelector('[data-att-f="价格"]');
    p.value='199'; p.dispatchEvent(new Event('input',{bubbles:true}));
    return 1; })()`);
  ok(await ev(`(function(){
    var b=document.querySelectorAll('.attitem')[2];
    return !!b && b.querySelector('b').textContent === 'DLC'; })()`),
    '类型改成 DLC，列表标签跟着变');

  /* ---------- ②b v165：附件封面的「粘贴 + 缩放 / 位移」 ---------- */
  console.log('\n[②b] 附件封面：缩放 / 位移 + 粘贴');
  ok(await ev(`!!document.querySelector('[data-att-prev]')`), '面板里有封面预览框');
  ok(await ev(`(function(){ var b=document.querySelector('.attvp-bar'); return !!b && b.hidden; })()`),
    '还没封面时，缩放条是收起的');

  await ev(`(function(){
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#7a9c74"/></svg>';
    var i=document.querySelector('[data-att-f="封面"]');
    i.value='data:image/svg+xml,'+encodeURIComponent(svg);
    i.dispatchEvent(new Event('input',{bubbles:true}));
    return 1; })()`);
  await sleep(200);
  ok(await ev(`(function(){ var b=document.querySelector('.attvp-bar'); return !!b && !b.hidden; })()`),
    '★ 填了封面 → 缩放条出现');
  ok(await ev(`(function(){
    var p=document.querySelector('[data-att-prev]');
    var sz=p.style.backgroundSize||'';
    return sz !== '' && sz.indexOf('cover') < 0; })()`),
    '★ 预览用的是「视口」尺寸（不再写死 cover）');

  await clickAt('[data-att-zoom="0.15"]');
  await sleep(200);
  const z1 = Number(await ev(`document.querySelector('[data-att-zoomslider]').value`));
  ok(z1 > 1, '★ 点「＋」→ 缩放值变大（' + z1.toFixed(2) + '）');
  ok(await ev(`document.querySelector('[data-att-pct]').textContent === Math.round(Number(document.querySelector('[data-att-zoomslider]').value)*100)+'%'`),
    '百分比读数跟着变');
  await clickAt('[data-att-reset]');
  await sleep(200);
  ok(Number(await ev(`document.querySelector('[data-att-zoomslider]').value`)) === 1, '点「重置」→ 回到 100%');
  /* 再放大两档：好验证「视口」确实写进了数据（默认值不写字段） */
  await clickAt('[data-att-zoom="0.15"]');
  await clickAt('[data-att-zoom="0.15"]');
  await sleep(200);

  /* 面板截图：保存按钮 + 附件封面的缩放条 */
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 950, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const shotA = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dirA = join(ROOT, '下载图', '_预览');
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, 'v165-附件面板.png'), Buffer.from(shotA.data, 'base64'));
    console.log('\n截图存档：附件面板');
  } catch (e) { /* ignore */ }

  await clickAt('#saveBtn');
  await sleep(900);
  const saved = JSON.parse(await ev(`(function(){
    var r=(window.__store.collection.rows||[]).filter(function(x){return x._id==='a1';})[0]||{};
    return JSON.stringify({att:r['附件']||null}); })()`) || '{}');
  ok(!!(saved.att && saved.att.length === 3),
    '★ 保存后附件进了数据（原来 2 个 + 新增 1 = ' + (saved.att ? saved.att.length : 0) + '）');
  const last = (saved.att || [])[2] || {};
  ok(last['名称'] === '限定亚克力立牌' && last['类型'] === 'DLC', '新增的那个名称 / 类型都对');
  ok(last['价格'] === 199 && typeof last['价格'] === 'number', '★ 价格存成数字 199（不是字符串）');
  /* ②b 里填封面的是**刚新增的那个附件**（attSel 指向它，就是 last） */
  ok(!!(last['封面'] && String(last['封面']).indexOf('svg+xml') >= 0),
    '★ 附件封面进了数据（填的 SVG 带回去了）');
  ok(!!last['封面视口'] && typeof last['封面视口']['s'] === 'number',
    '★ 封面视口（缩放/位移）也跟着存进去了：' + JSON.stringify(last['封面视口']));

  /* 回到卡片墙：新增的附件要能在卡片上看到。
     ⚠️ 卡片墙 (.poster) 出现在**经典视图的系列详情**里：
       classic=true（经典列表/管理） + seriesId 指向某个系列 → 走 renderSeriesDetail → collectionWall。
       （classic=false 是 3D 博物馆展厅 renderCollectionMuseum，那里没有 .poster 卡片。） */
  await ev(`(function(){ var U=window.__ui;
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId='se1'; U.dlcOpen={};
    window.__render(); return 1; })()`);
  await sleep(400);
  ok(await ev(`!!document.querySelector('.poster[data-id="a1"] .dlctag[data-t="DLC"]')`),
    '卡片上又能看到 DLC 标签（数据真的落进去了）');

  const errs = JSON.parse(await ev('JSON.stringify(window.__errs||[])') || '[]');
  ok(errs.length === 0, '③ 页面没有 JS 报错' + (errs.length ? '：' + JSON.stringify(errs) : ''));

  /* 截图：展开一个附件卡 */
  try {
    await ev(`(function(){ var U=window.__ui; U.dlcOpen={'a1|DLC':true}; window.__render(); return 1; })()`);
    await sleep(400);
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v162-附件卡片.png');
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
