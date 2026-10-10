/* ============================================================
 * e2e_noseries_cdp.mjs —— v153 真机验证：界面上再没有「未归类 / 未绑定」
 * ------------------------------------------------------------
 * 用户的原话是「不要叫未归类，按 大类 · 小类 展示」。单元测试测了名字与分组规则，
 * 这一层测**真实 app.js 渲染出来的 DOM**：
 *   ① 系列视图下，没有系列归属的物品按「手办 · 景品」这样分组
 *   ② IP 库里也没了「未绑定 IP」，同样按大类·小类归置
 *   ③ 整个页面上**一次都不出现**「未归类 / 未归入系列 / 未绑定」
 *
 * 骨架同 tools/e2e_preorder_cdp.mjs（CDP + 复制真实 index.html 当站点）。
 *
 * 用法：
 *     node tools/e2e_noseries_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9335;
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SITE = join(tmpdir(), 'ld-e2e-ns');
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
/* 关浏览器时 CDP 连接会断，可能留下没人 await 的请求 → 表现为"未处理的 rejection"，
   让脚本以退出码 1 结束（断言明明全过）。这里吞掉它：断言结果才是唯一的判据。 */
process.on('unhandledRejection', function(){});
const profile = join(tmpdir(), 'ld-e2e-ns-prof-' + Date.now());
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
    ].join('\n'),
  });
  await send('Page.navigate', { url: 'file:///' + join(SITE, 'index.html').replace(/\\/g, '/') });
  await sleep(3500);

  const diag = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({store:typeof window.__store, errs:window.__errs||[]})', returnByValue: true,
  });
  const D = JSON.parse(diag.result.value || '{}');
  if (D.store !== 'object') throw new Error('app 没启动；页面错误 ' + JSON.stringify(D.errs));

  const script = `(async function(){
    var S = window.__store, U = window.__ui;
    await new Promise(function(r){ setTimeout(r, 2000); });

    /* 造数据：一件「手办 · 景品」（用户举的例子：一家鼠抬蘑菇）+ 一个真系列 + 一件无 IP 的东西 */
    S.series.status='ok'; S.ip.status='ok'; S.collection.status='ok';
    S.series.rows=[{_id:'s1', 系列名称:'欢趣白昼', 所属IP:'三丽鸥', _upd:1, _rev:1}];
    S.ip.rows=[{_id:'i1', IP名称:'三丽鸥', _upd:1, _rev:1}];
    S.collection.rows=[
      {_id:'c1', 名称:'一家鼠抬蘑菇', 大类:'手办', 小类:'景品', 状态:['在库'], 持有:1, _upd:1, _rev:1},
      {_id:'c2', 名称:'某个冰箱贴', 大类:'周边', 小类:'冰箱贴', 状态:['在库'], 持有:1, _upd:1, _rev:1},
      {_id:'c3', 名称:'系列里的东西', 大类:'周边', 小类:'冰箱贴', 系列:'欢趣白昼', IP:'三丽鸥',
       状态:['在库'], 持有:1, _upd:1, _rev:1}
    ];

    function stage(){ var el=document.getElementById('stage'); return el ? el.innerHTML : ''; }

    /* ① 系列视图（封面墙 · 按系列分组） */
    U.view='collection'; U.collection.classic=true; U.collection.view='wall';
    U.collection.wallGroup='series'; U.collection.mode='cat'; U.collection.cat=''; U.collection.sub='';
    U.collection.ipId=null; U.collection.seriesId=null; U.collection.q=''; U.collection.page=1; U.collection.pageSize=0;
    window.__render();
    var hv = stage();

    /* ② IP 库 */
    U.collection.mode='ip'; U.collection.ipId=null;
    window.__render();
    var hi = stage();

    return {
      seriesHasCatSub: hv.indexOf('手办 · 景品') >= 0,
      seriesHasSub2:   hv.indexOf('周边 · 冰箱贴') >= 0,
      seriesHasOld:    hv.indexOf('未归类') >= 0,
      seriesHasSeries: hv.indexOf('欢趣白昼') >= 0,
      ipHasCatSub:     hi.indexOf('手办 · 景品') >= 0,
      ipHasOld:        hi.indexOf('未绑定') >= 0,
      ipHasOld2:       hi.indexOf('未归类') >= 0,
      errs: (window.__errs||[]).slice(0,5)
    };
  })()`;

  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const o = r.result && r.result.value;
  if (!o) throw new Error('页面脚本没有返回结果');

  console.log('=== v153 真机验证：没有系列归属 → 按「大类 · 小类」 ===\n');
  ok(o.seriesHasSeries, '① 系列视图里原来的系列卡片还在（没被这轮改动弄丢）');
  ok(o.seriesHasCatSub, '① ★ 无系列的手办按「手办 · 景品」归置（就是用户举的那个例子）');
  ok(o.seriesHasSub2, '① 无系列的周边按「周边 · 冰箱贴」归置（分成了不同的块，没有混成一坨）');
  ok(!o.seriesHasOld, '① ★ 系列视图里不再出现「未归类」');
  ok(o.ipHasCatSub, '② IP 库里没挂 IP 的也按「手办 · 景品」归置');
  ok(!o.ipHasOld, '② ★ IP 库里不再出现「未绑定 IP」');
  ok(!o.ipHasOld2, '② IP 库里也不出现「未归类」');
  ok(!o.errs || o.errs.length === 0, '③ 页面没有 JS 报错' + (o.errs && o.errs.length ? '：' + JSON.stringify(o.errs) : ''));

  /* 截图存档 */
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 880, height: 1100, deviceScaleFactor: 2, mobile: false });
    await send('Runtime.evaluate', {
      expression: `(function(){ var U=window.__ui;
        U.collection.mode='cat'; U.collection.view='wall'; U.collection.wallGroup='series';
        U.collection.classic=true; U.collection.ipId=null;
        window.__render(); window.scrollTo(0,0); return 1; })()`, returnByValue: true,
    });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = join(ROOT, '下载图', '_预览');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'v153-无系列按大类小类.png');
    writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log('  截图存档：' + p);
  } catch (e) { console.log('  （截图失败，不影响断言：' + (e && e.message) + '）'); }
}

/* ---------- 跑测试 ---------- */
try { await main(); } catch (e) {
  console.error('  ✗ ' + (e && e.message ? e.message : e));
  fail++;
}

/* ⚠️ 收尾顺序有讲究（踩了半小时才定位到）：
   统计**必须打在关浏览器之前**。ws.close() / chrome.kill() 会让 Node 判定"可以退出了"，
   于是 await 之后的顶层续体不再执行 —— 表现就是"断言全过、但最后两行永远看不到、退出码还是 1"。
   另外统计走 console.error（stderr 同步写），stdout 走管道时是异步的，进程一退就丢。 */
console.error('');
console.error('----------------------------------------');
console.error(pass + ' 项通过，' + fail + ' 项失败');

/* 先把小目录清掉（快），再关浏览器；exit 放最后一步 —— 它前面任何"可能让 Node 提前退出"的
   动作（关 WS / kill Chrome）都可能把 exitCode 弄乱，所以让 process.exit 的显式参数收口。 */
try { if (existsSync(SITE)) rmSync(SITE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { ws && ws.close(); } catch (e) { /* ignore */ }
try { chrome.kill(); } catch (e) { /* ignore */ }
try { if (existsSync(profile)) rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
