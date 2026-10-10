/* ============================================================
 * test_ip_flat_fold.mjs —— v149「IP 库平铺 + 折叠」回归测试
 * ------------------------------------------------------------
 * 为什么这样做：
 *   app.js 是浏览器脚本，直接 import 会炸（开头就摸 window）。
 *   所以把 IP 那一段源码（ipParentName / ipTree / ipScopeNames /
 *   折叠状态读写 / renderIpMode）**原文抠出来**，用 new Function
 *   在 Node 里跑，喂进假 store / 假 localStorage。
 *
 *   → 测的是**真正要上线的代码**，不是重写一遍的复刻品。
 *     复刻品测不出真代码的 bug，那才是自欺欺人。
 *
 * 覆盖（用户 v149 的原始诉求）：
 *   1. 所有 IP 都平铺在**同一张网格**里（不再有通栏的 `.ipkids` 内嵌小网格）。
 *   2. 子 IP 的卡**紧跟在父卡后面**（迪士尼 → 星际宝贝 → 小熊维尼 → 其它 IP）。
 *   3. 父卡右上角有一个折叠开关；点一下 = 子卡全部消失，再点 = 全部回来。
 *   4. 折叠状态只存 localStorage（不动数据、不进同步指纹）。
 *   5. 兜底：三级数据被拉平、父级不存在 → 当顶级、同名只认第一条。
 *
 * 用法：
 *     node tools/test_ip_flat_fold.mjs
 * ============================================================ */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = process.env.APP_PATH || join(ROOT, 'app.js');

const src = readFileSync(APP, 'utf8');

/* ---------- 1. 从 app.js 里抠出 IP 那一段 ---------- */
const START = 'function ipParentName(row){';
const END = 'function renderIpDetail(){';
const i = src.indexOf(START);
const j = src.indexOf(END, i);
if (i < 0 || j < 0) {
  console.error('!! 在 app.js 里找不到 IP 代码块。');
  console.error('   起点标记：' + START);
  console.error('   终点标记：' + END);
  process.exit(1);
}
const block = src.slice(i, j);
/* 抽出来的必须是「平铺 + 折叠」那一版，否则说明抠错段落了 */
if (block.indexOf("act==='ipfold'") >= 0) {
  /* 事件处理不在这一段里，正常 */
}

/* ---------- 2. 造一个最小的运行环境 ---------- */
function makeEnv(ipRows, lsSeed) {
  const store = {
    ip: { rows: ipRows, status: '' },
    collection: { rows: [] },
    series: { rows: [] },
  };
  const ui = { collection: { ipId: null, mode: 'ip' } };
  const _ls = Object.assign({}, lsSeed || {});
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
    setItem(k, v) { _ls[k] = String(v); },
    removeItem(k) { delete _ls[k]; },
  };
  const deps = `
    function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function coverStyle(){ return ''; }
    function hasCover(){ return false; }
    function ownedByCat(items){ var o={}; items.forEach(function(r){ o[r['大类']]=(o[r['大类']]||0)+1; }); return o; }
    function ownedCount(rows){ return rows.reduce(function(s,r){ return s+(Number(r['持有'])||0); },0); }
    function collectionWall(rows){ return '<wall:'+rows.length+'>'; }
    function emptyHTML(a){ return 'EMPTY:'+a; }
    function modeSeg(){ return ''; }
    function csGet(){ return 1; }
    var LEGACY_BOOK_CATS = ['书籍','杂志'];
  `;
  const factory = new Function(
    'store', 'ui', 'localStorage',
    deps + '\n' + block + '\n return { renderIpMode: renderIpMode, ipTree: ipTree, ipScopeNames: ipScopeNames,' +
    ' ipIsFolded: ipIsFolded, ipSetFolded: ipSetFolded, IP_FOLD_KEY: IP_FOLD_KEY };'
  );
  const api = factory(store, ui, localStorage);
  api.store = store; api._ls = _ls; api.localStorage = localStorage;
  return api;
}

/* ---------- 3. 断言小工具 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; failures.push(msg);
  console.error('  ✗ ' + msg);
}
function eq(a, b, msg) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) { fail++; failures.push(msg + '\n      得到 ' + JSON.stringify(a) + '\n      期望 ' + JSON.stringify(b)); console.error('  ✗ ' + msg); return; }
  pass++;
}

/* 从渲染出的 HTML 里按出现顺序取出「卡片标题」 */
function cardNames(html) {
  const out = [];
  const re = /<strong>([^<]*)<\/strong>/g;
  let m;
  while ((m = re.exec(html))) {
    const n = m[1].replace(/\s+$/, '');
    if (n === '新增 IP') continue;         /* 「新增」那张卡不算 */
    out.push(n);
  }
  return out;
}

/* ---------- 4. 真实数据 ---------- */
function realIpRows() {
  const dir = join(ROOT, 'data', 'ip');
  const rows = [];
  readdirSync(dir).filter(f => /-data\.json$/.test(f)).sort().forEach(f => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      (j.rows || []).forEach(r => rows.push(r));
    } catch (e) { /* 坏文件跳过 */ }
  });
  return rows;
}

console.log('=== v149 IP 库「平铺 + 折叠」回归测试 ===\n');

/* --- 场景 A：用真实 data/ip/*.json --- */
const realRows = realIpRows();
console.log('[A] 真实数据（data/ip/*.json，共 ' + realRows.length + ' 个 IP）');
{
  const api = makeEnv(realRows);
  const html = api.renderIpMode();

  ok(realRows.some(r => r['IP名称'] === '迪士尼'), 'A1 真实数据里能读到「迪士尼」');

  ok(html.indexOf('class="ipkids"') < 0, 'A2 不再输出通栏的内嵌区块 .ipkids（改成平铺）');
  ok(html.indexOf('ipgrid-sub') < 0, 'A3 列表页不再用 .ipgrid-sub（那是详情页专属）');

  const names = cardNames(html);
  const di = names.indexOf('迪士尼');
  ok(di >= 0, 'A4 网格里有迪士尼卡');
  if (di >= 0) {
    const kids = ['星际宝贝', '小熊维尼'].filter(n => names.indexOf(n) >= 0);
    ok(kids.length === 2, 'A5 星际宝贝 / 小熊维尼 都出现在同一张网格里（实测到 ' + kids.length + ' 个）');
    ok(names[di + 1] === '星际宝贝' || names[di + 1] === '小熊维尼',
      'A6 子 IP 紧跟父卡后面（迪士尼后面第一个是：' + names[di + 1] + '）');
    /* 连续三个位置应该是迪士尼 + 它的两个子 IP（顺序不定） */
    const after = names.slice(di + 1, di + 3).slice().sort();
    eq(after, ['小熊维尼', '星际宝贝'].sort(), 'A7 迪士尼后面紧跟着它的两个子 IP');
  }
  /* 其它顶级 IP 不能被「吞掉」—— 数量要对得上 */
  const tree = api.ipTree();
  eq(names.length, tree.tops.length + (tree.children['迪士尼'] || []).length,
    'A8 网格里的卡数 = 顶级 IP 数 + 迪士尼的子 IP 数（其它顶级 IP 一张不少）');

  /* 开关只长在有子 IP 的父卡上 */
  const folds = (html.match(/data-act="ipfold"/g) || []).length;
  eq(folds, 1, 'A9 只有迪士尼卡带折叠开关（共 ' + folds + ' 个）');
  ok(html.indexOf('▾') >= 0, 'A10 默认展开 → 开关显示 ▾');
  ok(html.indexOf('class="ipcard ipparent') >= 0, 'A11 父卡带 .ipparent');
  ok(html.indexOf('ipchild') >= 0, 'A12 子卡带 .ipchild');
  ok(/data-name="迪士尼"/.test(html), 'A13 开关带 data-name="迪士尼"');
  /* 开关必须在 ipopen 的卡内部（否则点开关会误开详情页） */
  const cardStart = html.lastIndexOf('data-act="ipopen"', html.indexOf('data-act="ipfold"'));
  ok(cardStart >= 0 && cardStart < html.indexOf('data-act="ipfold"'),
    'A14 折叠开关在 ipopen 卡片内部（靠 closest 取内层按钮）');

  /* 数据侧的「上级IP」原封不动 —— 展示改了不代表数据改了 */
  const xljb = realRows.filter(r => r['IP名称'] === '星际宝贝')[0];
  ok(xljb && String(xljb['上级IP']) === '迪士尼', 'A15 真实数据里 星际宝贝.上级IP 仍是「迪士尼」（只改展示）');
}

/* --- 场景 B：折叠 / 展开 --- */
console.log('[B] 折叠与展开');
{
  const api = makeEnv(realRows);
  const before = cardNames(api.renderIpMode());
  ok(before.indexOf('星际宝贝') >= 0, 'B1 展开态能看到子 IP');

  api.ipSetFolded('迪士尼', true);
  const foldedHtml = api.renderIpMode();
  const after = cardNames(foldedHtml);
  ok(after.indexOf('星际宝贝') < 0 && after.indexOf('小熊维尼') < 0, 'B2 折叠后子 IP 卡全部消失');
  ok(after.indexOf('迪士尼') >= 0, 'B3 折叠后父卡还在');
  ok(after.length === before.length - 2, 'B4 只少了那 2 张子卡');
  ok(foldedHtml.indexOf('▸') >= 0, 'B5 折叠态开关显示 ▸');
  ok(/data-act="ipfold"/.test(foldedHtml), 'B6 折叠态开关仍在（可以点回来）');
  ok(after.indexOf('宝可梦') >= 0 || after.indexOf('海贼王') >= 0, 'B7 其它顶级 IP 不受影响');

  api.ipSetFolded('迪士尼', false);
  eq(cardNames(api.renderIpMode()), before, 'B8 再点一次 → 完全回到展开态');

  /* 状态只落 localStorage，键名和对得上 */
  api.ipSetFolded('迪士尼', true);
  ok(api._ls[api.IP_FOLD_KEY] && JSON.parse(api._ls[api.IP_FOLD_KEY])['迪士尼'] === 1,
    'B9 折叠状态存进 localStorage（键=IP 名字）');
  ok(/^lifedesk_ipfold$/.test(api.IP_FOLD_KEY), 'B10 用的键就是 lifedesk_ipfold');
}

/* --- 场景 C：默认展开 + 状态跟着名字走 --- */
console.log('[C] 默认值与键名');
{
  const api = makeEnv(realRows);
  eq(Object.keys(JSON.parse(JSON.stringify(api._ls))).length, 0, 'C1 全新环境 localStorage 里没有任何折叠记录');
  ok(api.ipIsFolded('迪士尼') === false, 'C2 没记录过 = 默认展开（新挂的子 IP 不会被藏起来）');
  api.ipSetFolded('迪士尼', true);
  ok(api.ipIsFolded('迪士尼') === true, 'C3 写入后读得到');
  api.ipSetFolded('迪士尼', false);
  ok(Object.keys(JSON.parse(api._ls[api.IP_FOLD_KEY] || '{}')).length === 0, 'C4 取消折叠后不留垃圾键');
  /* 坏 localStorage 不能把页面搞崩 */
  const bad = makeEnv(realRows, { lifedesk_ipfold: '{{{' });
  ok(bad.ipIsFolded('迪士尼') === false, 'C5 localStorage 内容坏掉时按「未折叠」处理，不抛错');
  ok(bad.renderIpMode().length > 0, 'C6 坏 localStorage 也能正常渲染');
}

/* --- 场景 D：数据侧的兜底（v148 的老规矩不能回退） --- */
console.log('[D] 兜底与边界');
{
  const mk = (n, p) => ({ _id: 'x_' + n, IP名称: n, 上级IP: p });
  /* 父级名字打错 → 当顶级，不能消失 */
  const a = makeEnv([mk('迪士尼', null), mk('星际宝贝', '迪斯尼')]);
  ok(a.ipTree().tops.indexOf('星际宝贝') >= 0, 'D1 上级名字不存在 → 当顶级 IP（不会从库里消失）');
  ok(a.renderIpMode().indexOf('星际宝贝') >= 0, 'D2 兜底後它照样渲染出来');

  /* 自己指向自己 → 当顶级，不会成环 */
  const b = makeEnv([mk('A', 'A')]);
  eq(b.ipTree().tops, ['A'], 'D3 上级=自己 → 当顶级（不成环）');

  /* 三层被拉平成两层 */
  const c = makeEnv([mk('顶级', null), mk('中层', '顶级'), mk('底层', '中层')]);
  const t = c.ipTree();
  ok(t.tops.indexOf('中层') >= 0 || t.tops.indexOf('底层') >= 0, 'D4 三层数据被拉平（不留孤儿）');
  ok(t.parentOf['底层'] === '', 'D5 第三层被拉平成顶级');
  ok(t.parentOf['中层'] === '顶级', 'D6 合法的那一层父子关系保留');

  /* 同名只认第一条 */
  const d = makeEnv([mk('同名', null), mk('同名', null)]);
  eq(d.ipTree().tops.length, 1, 'D7 同名 IP 只认第一条记录（不会渲染出两张同名卡）');

  /* 没有子 IP 的顶级卡不带开关 */
  const e = makeEnv([mk('独立IP', null)]);
  ok(e.renderIpMode().indexOf('data-act="ipfold"') < 0, 'D8 没有子 IP 的卡不带折叠开关');

  /* 折叠一个「根本没有子 IP」的名字 → 无副作用 */
  e.ipSetFolded('独立IP', true);
  ok(e.renderIpMode().indexOf('独立IP') >= 0, 'D9 折叠一个没有子 IP 的名字，页面照常');
}

/* ---------- 结果 ---------- */
console.log('\n----------------------------------------');
console.log(pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f, n) => console.log('  ' + (n + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
