/* ============================================================
 * e2e_owned_hold_cdp.mjs —— 「点卡片上的在库按钮 → 持有自动变 1」端到端验证
 * ------------------------------------------------------------
 * 为什么还要做这一层（单元测试已经覆盖了函数逻辑）：
 *   用户报过两轮「点了在库，持有还是没变 1」。函数逻辑对 ≠ 用户点得到、点得对。
 *   这一层验证的是**真实浏览器 + 真实 app.js + 真实事件委托**：
 *     DOM 里真有那个按钮 → click 真的走到 toggleRowStatus → 数据真的变了。
 *
 * 做法：起 headless Chrome（CDP），打开一个只引 app.js 的最小页面，
 *   等 window.__store 就绪 → 注入一条「云游 / 持有空」的藏品 → render()
 *   → 用 querySelector 找到 `[data-act="pkquick"][data-s="在库"]` → click()
 *   → 回读 store 里的 状态 / 持有。
 *
 * 用法：
 *     node tools/e2e_owned_hold_cdp.mjs
 * ============================================================ */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 9333;
const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* ---------- 合成测试站点：复制真实 index.html，只把 app.js / style.css 指向项目根 ----------
 * 为什么不用「最小页面」：app.js 启动时会给一堆 DOM 节点绑事件（少一个就
 * `Cannot set properties of null (setting 'onclick')` 直接中断，window.__store 都不生成）。
 * 直接复用真实 index.html 的骨架最省事，也最接近用户实际环境。
 * 站点建在**系统临时目录**，绝不落在项目里（免得被 push_to_github 一起推上线）。 */
const SITE = join(tmpdir(), 'ld-e2e-site');
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
const APP_URL = 'file:///' + join(ROOT, 'app.js').replace(/\\/g, '/');
const CSS_URL = 'file:///' + join(ROOT, 'style.css').replace(/\\/g, '/');
{
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  html = html.replace("s.src='app.js'+bust;", `s.src='${APP_URL}'+bust;`);
  html = html.replace("l.href='style.css'+bust;", `l.href='${CSS_URL}'+bust;`);
  html = html.replace("href='style.css'", `href='${CSS_URL}'`);
  writeFileSync(join(SITE, 'index.html'), html);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEEP = process.argv.includes('--keep');

/* ---------- 起浏览器 ---------- */
const profile = join(tmpdir(), 'ld-e2e-' + Date.now());
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

async function main() {
  /* 等 CDP 端口 */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { ready = true; break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!ready) throw new Error('Chrome 的 CDP 端口没起来');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用页面');

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
  /* 页面里最早的错误收集器 —— 必须在导航前注入。
     ⚠️ 这里拼的是「要发给浏览器执行的源码字符串」，别在字符串里写真实的换行
        （写成多行会把注入脚本本身搞成语法错误，然后你会看到「一个错误都没有」的假象）。 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: [
      'window.__errs=[];window.__logs=[];',
      'window.addEventListener("error",function(e){',
      '  var st=String((e.error&&e.error.stack)||"");',
      '  var cut=st.indexOf(String.fromCharCode(10));',
      '  window.__errs.push("ERR: "+(e.message||e.error)+" @ "+st.slice(0, cut<0?160:cut));',
      '});',
      'window.addEventListener("unhandledrejection",function(e){ window.__errs.push("REJ: "+String(e.reason)); });',
      '["error","warn","log"].forEach(function(k){ var o=console[k];',
      '  console[k]=function(){ try{ window.__logs.push(k+": "+Array.prototype.slice.call(arguments).map(String).join(" ")); }catch(e){} return o.apply(console,arguments); };',
      '});',
    ].join('\n'),
  });

  const url = 'file:///' + join(SITE, 'index.html').replace(/\\/g, '/');
  await send('Page.navigate', { url });
  await sleep(4000);                       /* 等 app.js 启动 + loadAll 那一轮异步跑完 */

  /* 先诊断一次：app 到底起没起来、卡在哪 */
  const diag = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasStore: typeof window.__store,
      hasRender: typeof window.__render,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      stageLen: (document.getElementById('stage')||{}).innerHTML ? document.getElementById('stage').innerHTML.length : -1,
      errs: window.__errs || [],
      logs: (window.__logs||[]).slice(0,12)
    })`, returnByValue: true,
  });
  const D = JSON.parse((diag.result && diag.result.value) || '{}');

  if (D.hasStore !== 'object' || D.hasRender !== 'function') {
    console.error('  诊断：app 没起来');
    console.error('    window.__store   = ' + D.hasStore);
    console.error('    window.__render  = ' + D.hasRender);
    console.error('    #stage 内容长度  = ' + D.stageLen);
    console.error('    页面错误 ' + JSON.stringify(D.errs, null, 0));
    console.error('    控制台 ' + JSON.stringify(D.logs, null, 0));
    throw new Error('app.js 在这个最小页面里没启动（见上方诊断）');
  }

  const script = `(async function(){
    var S = window.__store, U = window.__ui;
    if (!S || !window.__render) return { err: 'app 没启动（window.__store 不存在）' };
    /* 等 loadAll 那一轮异步结束，免得它回头把我们注入的行冲掉 */
    await new Promise(function(r){ setTimeout(r, 2500); });

    var results = [];
    function inject(status, hold){
      U.view = 'collection';             /* 主区域切到藏品馆 */
      U.collection.classic = true;       /* 从 3D 展厅切到「经典列表」（卡片墙才有快速按钮） */
      U.collection.mode = 'cat';
      U.collection.cat = ''; U.collection.sub = '';
      U.collection.ipId = null; U.collection.seriesId = null;
      S.collection.status = 'ok';
      S.collection.rows = [{
        _id: 'e2e1', 名称: '测试物品', 大类: '周边', 小类: '徽章',
        状态: status, 持有: hold, _upd: 1, _rev: 1
      }];
      window.__render();
    }
    function clickOwned(){
      var all = document.querySelectorAll('[data-act="pkquick"]').length;
      var b = document.querySelector('[data-act="pkquick"][data-s="在库"]');
      if (!b){
        var st = document.getElementById('stage');
        return { err: '找不到「在库」按钮（页面上 pkquick 按钮共 ' + all + ' 个）',
                 rows: (S.collection.rows || []).length, view: U.view,
                 mode: U.collection.mode,
                 html: (st ? st.innerHTML : '(没有 #stage)').replace(/\\s+/g, ' ').slice(0, 400) };
      }
      b.click();
      var r = S.collection.rows[0] || {};
      return { 状态: r['状态'], 持有: r['持有'], 名称: r['名称'] };
    }

    /* 场景1：云游 + 持有空 → 点「在库」 */
    inject(['云游'], null);
    results.push({ 场景: '云游 + 持有空', 结果: clickOwned(), 期望: { 状态: ['在库'], 持有: 1 } });

    /* 场景2：无状态 + 持有空 */
    inject([], null);
    results.push({ 场景: '无状态 + 持有空', 结果: clickOwned(), 期望: { 状态: ['在库'], 持有: 1 } });

    /* 场景3：想收 + 持有空 */
    inject(['想收'], null);
    results.push({ 场景: '想收 + 持有空', 结果: clickOwned(), 期望: { 状态: ['在库'], 持有: 1 } });

    /* 场景4（v151 修的那条）：已经是在库、持有还空着 → 点一下应补齐、而不是取消 */
    inject(['在库'], null);
    results.push({ 场景: '已在库 + 持有空', 结果: clickOwned(), 期望: { 状态: ['在库'], 持有: 1 } });

    /* 场景5：在库 + 持有 3 → 再点一次才是取消；v155 起取消**落回云游**（不是变空） */
    inject(['在库'], 3);
    results.push({ 场景: '在库 + 持有 3（点一下=取消→云游）', 结果: clickOwned(), 期望: { 状态: ['云游'], 持有: 3 } });

    /* 场景6（v155 用户报的）：空状态的老数据 → 点「在库」应正常变成在库 */
    inject([], null);
    results.push({ 场景: '空状态（老数据）点在库', 结果: clickOwned(), 期望: { 状态: ['在库'], 持有: 1 } });

    return { results: results };
  })()`;

  const out = await send('Runtime.evaluate', {
    expression: script, awaitPromise: true, returnByValue: true,
  });
  return out.result && out.result.value;
}

let pass = 0, fail = 0;
try {
  const data = await main();
  console.log('=== 端到端：真实浏览器里点「在库」按钮 ===\n');
  if (!data || data.err) {
    console.error('  ✗ 运行失败：' + (data && data.err));
    fail++;
  } else {
    data.results.forEach((r, i) => {
      const got = r.结果 || {};
      if (got.err) {
        fail++;
        console.log(`  ✗ ${String(i + 1).padStart(2)}. ${r.场景}\n        ${got.err}`);
        if (i === 0) {
          console.log('        rows=' + got.rows + ' view=' + got.view + ' mode=' + got.mode);
          console.log('        #stage = ' + got.html);
        }
        return;
      }
      const good = JSON.stringify(got.状态) === JSON.stringify(r.期望.状态)
        && got.持有 === r.期望.持有;
      const line = `  ${good ? '✓' : '✗'} ${String(i + 1).padStart(2)}. ${r.场景}\n`
        + `        得到 状态=${JSON.stringify(got.状态)} 持有=${JSON.stringify(got.持有)}`
        + `   期望 状态=${JSON.stringify(r.期望.状态)} 持有=${JSON.stringify(r.期望.持有)}`;
      if (good) { pass++; console.log(line); }
      else { fail++; console.log(line); }
    });
  }
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

try { ws && ws.close(); } catch (e) {}
try { chrome.kill(); } catch (e) {}
try { if (existsSync(SITE) && !KEEP) rmSync(SITE, { recursive: true, force: true }); } catch (e) {}
if (KEEP) console.error('（页面保留在 ' + SITE + '）');
try { if (existsSync(profile)) rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
