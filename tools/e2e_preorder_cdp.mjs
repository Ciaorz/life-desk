/* ============================================================
 * e2e_preorder_cdp.mjs —— v152 预定物管理：真实浏览器端到端验证
 * ------------------------------------------------------------
 * 单元测试（tools/test_preorder.mjs）测的是函数逻辑；这一层测的是
 * **真实 app.js + 真实 DOM + 真实事件委托**：
 *   ① 总览页渲染出来的确实是「预定物管理」，不是「最近留下的」
 *   ② 出货日历真的画出来、今天的格子有 today 标记
 *   ③ 点「到货了」→ 数据真的从「已预订」变成「在库」、持有补成 1
 *   ④ 点翻月 → ui.poCal 真的变了、标题跟着变
 *   ⑤ 表单里「预定出货日期」真的是三段下拉，且**选季度**能存成 `2026-Q4`
 *
 * 骨架与 tools/e2e_owned_hold_cdp.mjs 相同（CDP + 复制真实 index.html 当站点，
 * 靠 window.__store / __ui / __render 三个调试钩子注入数据）。
 *
 * 用法：
 *     node tools/e2e_preorder_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9334;
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-po');
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
const profile = join(tmpdir(), 'ld-e2e-po-prof-' + Date.now());
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
    source: [
      'window.__errs=[];',
      'window.addEventListener("error",function(e){ window.__errs.push(String(e.message||e.error)); });',
      'window.addEventListener("unhandledrejection",function(e){ window.__errs.push("REJ: "+String(e.reason)); });',
    ].join('\n'),
  });
  await send('Page.navigate', { url: 'file:///' + join(SITE, 'index.html').replace(/\\/g, '/') });
  await sleep(3500);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})',
    returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errs));

  const script = `(async function(){
    var S = window.__store, U = window.__ui;
    await new Promise(function(r){ setTimeout(r, 2000); });   /* 等 loadAll 那轮跑完 */

    function p2(n){ return (n<10?'0':'')+n; }
    function off(n){ var d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+n);
      return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
    function curYM(){ var d=new Date(); return d.getFullYear()+'-'+p2(d.getMonth()+1); }
    function nextYM(){ var d=new Date(); d.setDate(1); d.setMonth(d.getMonth()+1);
      return d.getFullYear()+'-'+p2(d.getMonth()+1); }

    function inject(){
      U.view = 'overview';
      U.poCal = '';
      U.poEdit = null;
      U.collection.ipId = null; U.collection.seriesId = null;
      S.collection.status = 'ok';
      S.collection.rows = [
        { _id:'po1', 名称:'预定中的手办', 大类:'手办', IP:'宝可梦', 状态:['已预订'], 持有:null,
          预定日期: off(-5), 预定出货日期: off(3), _upd:1, _rev:1 },
        { _id:'po2', 名称:'季度出货的玩偶', 大类:'毛绒', IP:'三丽鸥', 状态:['已预订'], 持有:0,
          预定日期: off(-20), 预定出货日期: new Date().getFullYear()+'-Q4', _upd:1, _rev:1 },
        { _id:'po3', 名称:'没填日期的', 大类:'周边', 状态:['已预订'], 持有:null, _upd:1, _rev:1 },
        { _id:'po4', 名称:'在库的不该出现', 大类:'周边', 状态:['在库'], 持有:2, _upd:1, _rev:1 }
      ];
      window.__render();
    }
    function stage(){ var el=document.getElementById('stage'); return el ? el.innerHTML : ''; }

    var out = {};

    /* ① 总览页 = 预定物管理（不是「最近留下的」） */
    inject();
    var h1 = stage();
    out.hasPanel      = h1.indexOf('预定物管理') >= 0;
    out.noOldTimeline = h1.indexOf('最近留下的') < 0;
    out.hasCal        = h1.indexOf('po-monthcal') >= 0 && h1.indexOf('po-calgrid') >= 0;
    out.hasToday      = h1.indexOf('po-cell today') >= 0;
    out.count3        = h1.indexOf('3 件在预定中') >= 0;
    out.noInLibRow    = h1.indexOf('在库的不该出现') < 0;
    /* v156：总览页的金额面板不再重复显示「累计投入」（用户说它和「充电量」是同一个数） */
    out.hasCharge      = h1.indexOf('充电量') >= 0;
    out.noDoubleCharge = h1.indexOf('累计投入') < 0;

    /* ② 逼真的模糊日期：季度那条要带虚线圈 */
    out.hasVague      = /po-ev vague/.test(h1);

    /* ③ 点「到货了」 */
    var btn = document.querySelector('[data-act="porecv"][data-id="po1"]');
    out.recvBtn = !!btn;
    if (btn){
      btn.click();
      var r1 = S.collection.rows.filter(function(r){ return r._id==='po1'; })[0] || {};
      out.recvStatus = r1['状态'];
      out.recvHold   = r1['持有'];
    }

    /* ④ 翻月 */
    inject();
    var nextM = nextYM();
    var nbtn = document.querySelector('[data-act="pocal"][data-d="1"]');
    out.calBtn = !!nbtn;
    if (nbtn){
      nbtn.click();
      out.poCalAfterNext = U.poCal;
      out.calAfterNextIsNext = (U.poCal === nextM);
      var back = document.querySelector('[data-act="pocal"][data-d="0"]');
      if (back){ back.click(); out.poCalAfterBack = U.poCal; }
    }

    /* ⑤ v154：编辑表单里**不再有**「预定日期 / 预定出货日期」（用户嫌占地方）——
       这两个日期改到总览页的预定物卡片上就地编辑（见 ⑦）。
       顺带验一下「购入渠道」变成了可选可输。 */
    function openAdd(){
      var b = document.querySelector('[data-act="add"][data-key="collection"]');
      if (!b){
        b = document.createElement('button');
        b.setAttribute('data-act','add'); b.setAttribute('data-key','collection');
        document.body.appendChild(b);
      }
      b.click();
    }
    function closeSheet(){ var x = document.querySelector('.sheet .x'); if (x) x.click(); }

    inject();
    openAdd();
    out.formHasPreorderFields = !!(document.querySelector('.sheet [data-f="预定出货日期"]') ||
                                   document.querySelector('.sheet [data-fy="预定日期"]'));
    var chInp = document.querySelector('[data-f="购入渠道"]');
    out.channelIsInputList = !!(chInp && chInp.tagName === 'INPUT' && chInp.getAttribute('list'));
    var dl = chInp ? document.getElementById(chInp.getAttribute('list')) : null;
    var dlOpts = dl ? Array.prototype.slice.call(dl.querySelectorAll('option')) : [];
    out.channelPresetCount = dlOpts.length;
    out.channelHasTaobao = dlOpts.some(function(o){ return o.value === '淘宝'; });
    out.channelHasGuyue  = dlOpts.some(function(o){ return o.value === '古月鸟'; });
    /* 手打的清单外渠道照样能填进去 */
    if (chInp){
      chInp.value = '楼下小店';
      chInp.dispatchEvent(new Event('input', { bubbles:true }));
      out.channelFreeText = (document.querySelector('[data-f="购入渠道"]') || {}).value;
    }
    closeSheet();

    /* ⑥ 出货日历：一排三个月 */
    inject();
    out.calMonthBlocks = document.querySelectorAll('.po-monthcal').length;

    /* ⑦ 卡片上点日期标签 → 就地展开 → 选完立刻写进数据（不弹窗） */
    var chip = document.querySelector('[data-act="poedit"][data-id="po1"][data-f="预定出货日期"]');
    out.chipClickable = !!chip;
    if (chip){
      chip.click();
      var ed = document.querySelector('.po-inlineedit[data-id="po1"]');
      out.inlineOpened = !!ed;
      out.inlineSegCount = ed ? ed.querySelectorAll('[data-poseg]').length : 0;
      var sy = ed ? ed.querySelector('[data-poseg="y"]') : null;
      var sg = ed ? ed.querySelector('[data-poseg="g"]') : null;
      /* ⚠️ 点下拉不能把详情页（.sheet）打开 —— 编辑区那层 data-act 得把点击吃掉 */
      if (sy) sy.click();
      out.sheetNotOpenedBySelect = !document.querySelector('.sheet');
      if (sy && sg){
        sy.value = '2027'; sg.value = 'Q4';
        sg.dispatchEvent(new Event('change', { bubbles:true }));
        var r2 = S.collection.rows.filter(function(r){ return r._id==='po1'; })[0] || {};
        out.inlineSaved = r2['预定出货日期'];
        out.stillEditing = !!document.querySelector('.po-inlineedit[data-id="po1"]');
      }
      var done = document.querySelector('[data-act="poeditdone"]');
      if (done) done.click();
      out.inlineClosed = !document.querySelector('.po-inlineedit');
    }

    out.errs = (window.__errs||[]).slice(0,5);
    return out;
  })()`;

  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const o = r.result && r.result.value;
  if (!o) throw new Error('页面脚本没有返回结果');

  /* ---------- 视觉核对：把总览页截下来存档 ---------- */
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 880, height: 1250, deviceScaleFactor: 2, mobile: false,
    });
    await send('Runtime.evaluate', {
      expression: `(function(){
        var U=window.__ui, S=window.__store;
        function p2(n){ return (n<10?'0':'')+n; }
        function off(n){ var d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+n);
          return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
        function ym(n){ var d=new Date(); d.setDate(1); d.setMonth(d.getMonth()+n);
          return d.getFullYear()+'-'+p2(d.getMonth()+1); }
        U.view='overview'; U.poCal='';
        S.collection.status='ok';
        S.collection.rows=[
          {_id:'s1',名称:'30周年冰箱贴 · 梦幻',大类:'周边',小类:'冰箱贴',IP:'宝可梦',系列:'30周年冰箱贴',
           状态:['已预订'],持有:null,预定日期:off(-6),预定出货日期:off(2),_upd:1,_rev:1},
          {_id:'s2',名称:'星际宝贝 毛绒挂件',大类:'毛绒',IP:'星际宝贝',状态:['已预订'],持有:null,
           预定日期:off(-24),预定出货日期:ym(-1),_upd:1,_rev:1},
          {_id:'s3',名称:'三丽鸥 库洛米 手办',大类:'手办',IP:'三丽鸥',状态:['已预订'],持有:0,
           预定日期:off(-12),预定出货日期:ym(1),_upd:1,_rev:1},
          {_id:'s4',名称:'迪士尼 米老鼠 摆件',大类:'居陈',IP:'米老鼠',状态:['已预订'],持有:null,
           预定日期:off(-30),预定出货日期:new Date().getFullYear()+'-Q4',_upd:1,_rev:1},
          {_id:'s5',名称:'某店铺 盲盒整箱',大类:'周边',IP:'三丽鸥',状态:['已预订'],持有:null,
           预定日期:off(-3),_upd:1,_rev:1}
        ];
        window.__render(); window.scrollTo(0,0); return 1; })()`,
      returnByValue: true,
    });
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const shotDir = join(ROOT, '下载图', '_预览');
    mkdirSync(shotDir, { recursive: true });
    const outPath = join(shotDir, 'v154-预定物管理-三个月日历.png');
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    console.log('  截图存档：' + outPath);
  } catch (e) {
    console.log('  （截图这一步失败，不影响断言：' + (e && e.message) + '）');
  }

  console.log('=== v152 预定物管理 · 真实浏览器端到端 ===\n');
  ok(o.hasPanel, '① 总览页渲染出「预定物管理」面板');
  ok(o.noOldTimeline, '① 原来「最近留下的」已经不在页面上');
  ok(o.hasCal, '② 出货日历画出来了');
  ok(o.hasToday, '② 今天的格子上有 today 标记');
  ok(o.count3, '② 顶部提示「3 件在预定中」（只算已预订的）');
  ok(o.noInLibRow, '② 「在库」的东西没有混进预定物面板');
  ok(o.hasCharge, '② 总览页的「充电量」还在');
  ok(o.noDoubleCharge, '② ★ 不再重复显示「累计投入」（和充电量是同一个数）');
  ok(o.hasVague, '② 季度出货的事件带 .vague 虚线圈标记');
  ok(o.recvBtn, '③ 卡片上有「到货了」按钮');
  ok(JSON.stringify(o.recvStatus) === JSON.stringify(['在库']), '③ 点「到货了」→ 状态变成「在库」（得到 ' + JSON.stringify(o.recvStatus) + '）');
  ok(o.recvHold === 1, '③ 点「到货了」→ 持有补成 1（得到 ' + JSON.stringify(o.recvHold) + '）');
  ok(o.calBtn, '④ 日历上有「下个月」按钮');
  ok(o.calAfterNextIsNext, '④ 点下个月 → ui.poCal 真的翻过去了（' + o.poCalAfterNext + '）');
  ok(o.poCalAfterBack === '', '④ 「回到本月」把 poCal 清空（' + JSON.stringify(o.poCalAfterBack) + '）');
  ok(!o.formHasPreorderFields, '⑤ ★ 编辑表单里已经没有「预定日期 / 预定出货日期」（用户嫌占地方）');
  ok(o.channelIsInputList, '⑤ ★ 购入渠道变成「可选可输」（input + datalist）');
  ok(o.channelPresetCount >= 7, '⑤ 渠道候选有 ' + o.channelPresetCount + ' 项');
  ok(o.channelHasTaobao && o.channelHasGuyue, '⑤ 预设里有 淘宝 / 古月鸟');
  ok(o.channelFreeText === '楼下小店', '⑤★ 清单外的渠道照样能手打（' + o.channelFreeText + '）');
  ok(o.calMonthBlocks === 3, '⑥ ★ 出货日历一排 ' + o.calMonthBlocks + ' 个月');
  ok(o.chipClickable, '⑦ 卡片上的日期标签可点');
  ok(o.inlineOpened, '⑦ ★ 点一下就在卡片上就地展开（不弹窗）');
  ok(o.inlineSegCount === 3, '⑦ 编辑区是三个下拉');
  ok(o.sheetNotOpenedBySelect, '⑦ ★ 点下拉不会误开详情页');
  ok(o.inlineSaved === '2027-Q4', '⑦ 选「2027 + 四季度」→ 立刻写进数据（得到 ' + o.inlineSaved + '）');
  ok(o.stillEditing, '⑦ 写完之后编辑区还在（可以接着改下一段）');
  ok(o.inlineClosed, '⑦ 点 ✓ 能收起');
  ok(!o.errs || o.errs.length === 0, '⑧ 页面没有 JS 报错' + (o.errs && o.errs.length ? '：' + JSON.stringify(o.errs) : ''));
}

try {
  await main();
} catch (e) {
  console.error('  ✗ ' + (e && e.message ? e.message : e));
  fail++;
} finally {
  /* 这里只做「关浏览器」—— 统计放到它**之前**打，见下方注释 */
}

/* ⚠️ 统计必须打在「关浏览器」之前（这个坑花了不少时间才定位）：
   ws.close() / chrome.kill() 之后，Node 会判定「没有待办了」直接结束进程，
   await 之后的顶层续体就不再执行 —— 表现就是「断言全过，但最后两行统计永远看不到」。
   另外统计走 console.error（stderr 是同步写）；console.log 走管道时是异步的，进程一退就丢。 */
console.error('');
console.error('----------------------------------------');
console.error(pass + ' 项通过，' + fail + ' 项失败');

try { ws && ws.close(); } catch (e) { /* ignore */ }
try { chrome.kill(); } catch (e) { /* ignore */ }
try { if (existsSync(SITE)) rmSync(SITE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { if (existsSync(profile)) rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
