/* ============================================================
 * test_preorder.mjs —— v152「预定物管理 + 模糊出货日期」回归测试
 * ------------------------------------------------------------
 * 用户要的行为（原话）：
 *   「预定的东西单独管理，要填预定日期 / 预定出货日期，有出货日历提醒什么时候出货，
 *     放在总览页替换掉『最近留下的』；出货日期允许模糊（只有月份、日子空着），允许选季度。」
 *
 * 为什么这样做：
 *   app.js 是浏览器脚本，直接 import 会炸。所以把相关源码**原文抠出来**
 *   （模糊日期那套 + 预定物面板），用 new Function 在 Node 里跑，配假 store/ui。
 *   → 测的是**真正要上线的代码**，不是重写一遍的复刻品。
 *
 * 重点覆盖「容易写错又难发现」的那几处：
 *   · 模糊日期的解析/文案/落格/逾期判定（月末 vs 月初，季度边界，闰年 2 月）
 *   · 只有月份的出货期**不会在月初就被误判成逾期**（这是设计上的关键决定）
 *   · 面板只收「已预订」，在库/云游的东西不许混进来
 *   · 日历按月份落格：别的月份的东西不能出现在当月格子里
 *
 * 用法：
 *     node tools/test_preorder.mjs
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = process.env.APP_PATH || join(ROOT, 'app.js');
const src = readFileSync(APP, 'utf8');

function extractFn(name) {
  let i = src.indexOf('\nfunction ' + name + '(');
  i = (i >= 0) ? i + 1 : src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('在 app.js 里找不到函数 ' + name);
  let j = src.indexOf('{', i);
  let depth = 0, inS = null, inLine = false, inBlock = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k], n = src[k + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
    if (inS) { if (c === '\\') { k++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inLine = true; k++; continue; }
    if (c === '/' && n === '*') { inBlock = true; k++; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}
function extractVar(decl) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('找不到变量声明 ' + decl);
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '\n' && depth === 0) return src.slice(i, k);
  }
  return src.slice(i, i + 400);
}

const FUZZY_FNS = ['fzPad2', 'fuzzyDateInfo', 'fuzzyDateKey', 'fuzzyDateEndKey',
  'fuzzyDateText', 'fuzzyDateIsVague', 'fuzzyDaysFromToday'];
const PO_FNS = ['poTodayKey', 'poRows', 'poSort', 'poWhenText', 'poDueChip', 'poBookedChip',
  'poInlineEditHTML', 'poInlineCommit', 'poCardHTML', 'poMonthCalHTML', 'poCalHTML', 'preorderPanel'];
const code = [
  extractVar('var FUZZY_Q_NAME'),
  extractVar('var FUZZY_Q_FIRST_MONTH'),
  extractVar('var CHANNEL_PRESETS'),
  ...FUZZY_FNS.map(extractFn),
  ...PO_FNS.map(extractFn),
  extractFn('channelOptionsAll'),
].join('\n\n');

function makeEnv(rows, poCal) {
  const store = { collection: { rows: rows || [], status: 'ok' } };
  const ui = { view: 'overview', poCal: poCal || '', poEdit: null };
  const log = { toasts: [], renders: 0, patches: [] };
  const deps = `
    var LEGACY_BOOK_CATS = ['书籍','杂志'];
    function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function hasStatus(r, v){
      var s = r && r['状态'];
      var a = Array.isArray(s) ? s : String(s==null?'':s).split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      return a.indexOf(v) >= 0;
    }
    function coverStyle(){ return ''; }
    function hasCover(){ return false; }
    function emptyHTML(a,b){ return 'EMPTY:' + a; }
    function toast(m){ log.toasts.push(m); }
    function render(){ log.renders++; }
    /* 就地编辑写盘的最后一步：桩成直接改 store 里的行（真代码里是 patchRowFields） */
    function patchRowFields(key, id, patch){
      var row = (store[key].rows||[]).filter(function(r){ return String(r._id)===String(id); })[0];
      if (!row) return false;
      var changed = false;
      Object.keys(patch).forEach(function(k){
        var nv = (patch[k]===''||patch[k]==null) ? null : patch[k];
        if (String(row[k]==null?'':row[k]) !== String(nv==null?'':nv)){ row[k]=nv; changed=true; }
      });
      if (changed) log.patches.push({ id:id, patch:patch });
      return changed;
    }
  `;
  const factory = new Function('store', 'ui', 'log', deps + '\n' + code + `
    return { fuzzyDateInfo:fuzzyDateInfo, fuzzyDateKey:fuzzyDateKey, fuzzyDateEndKey:fuzzyDateEndKey,
             fuzzyDateText:fuzzyDateText, fuzzyDateIsVague:fuzzyDateIsVague,
             fuzzyDaysFromToday:fuzzyDaysFromToday, fzPad2:fzPad2,
             poSort:poSort, poRows:poRows, preorderPanel:preorderPanel, poCalHTML:poCalHTML,
             poMonthCalHTML:poMonthCalHTML, poCardHTML:poCardHTML, poInlineEditHTML:poInlineEditHTML,
             poInlineCommit:poInlineCommit, channelOptionsAll:channelOptionsAll,
             poDueChip:poDueChip, poWhenText:poWhenText, store:store, ui:ui, log:log };`);
  return factory(store, ui, log);
}

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; failures.push(msg); console.error('  ✗ ' + msg);
}
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; return; }
  fail++; failures.push(msg + '｜得到 ' + JSON.stringify(a) + ' 期望 ' + JSON.stringify(b));
  console.error('  ✗ ' + msg + '（得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');
}

/* 相对今天的日期串，避免写死年份让测试过期 */
function fz2(n) { return (n < 10 ? '0' : '') + n; }
function dayOffset(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + fz2(d.getMonth() + 1) + '-' + fz2(d.getDate());
}
function curYM() {
  const d = new Date();
  return d.getFullYear() + '-' + fz2(d.getMonth() + 1);
}
function nextYM() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1);
  return d.getFullYear() + '-' + fz2(d.getMonth() + 1);
}
/* 相对今天偏移 n 个月的 `YYYY-MM` */
function monthOffset(n) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n);
  return d.getFullYear() + '-' + fz2(d.getMonth() + 1);
}
function mkRow(o) {
  return Object.assign({ _id: 'x' + Math.random().toString(36).slice(2, 7), 名称: '物件', 大类: '周边',
    状态: ['已预订'], 持有: null, 预定日期: '', 预定出货日期: '' }, o);
}

console.log('=== v152 预定物管理 / 模糊出货日期 回归测试 ===\n');

/* ---------- A. 模糊日期解析 ---------- */
console.log('[A] fuzzyDateInfo 解析');
{
  const E = makeEnv([]);
  const I = E.fuzzyDateInfo;
  eq(I('2026-11-15'), { kind: 'day', y: 2026, m: 11, d: 15 }, 'A1 精确日期');
  eq(I('2026-11'), { kind: 'month', y: 2026, m: 11 }, 'A2 只有月份');
  eq(I('2026-Q4'), { kind: 'quarter', y: 2026, q: 4 }, 'A3 季度 Q 写法');
  eq(I('2026Q1'), { kind: 'quarter', y: 2026, q: 1 }, 'A4 季度没横杠也认');
  eq(I('2026年第四季度'), { kind: 'quarter', y: 2026, q: 4 }, 'A5 中文季度');
  eq(I('2026'), { kind: 'year', y: 2026 }, 'A6 只有年份');
  eq(I('2026-1-5'), { kind: 'day', y: 2026, m: 1, d: 5 }, 'A7 月日没补零也认');
  eq(I('2026/11/15'), { kind: 'day', y: 2026, m: 11, d: 15 }, 'A8 斜杠分隔也认');
  eq(I(''), null, 'A9 空串 → null');
  eq(I(null), null, 'A10 null → null（不崩）');
  eq(I('不知道'), null, 'A11 乱写的 → null');
  eq(I('2026-13'), { kind: 'year', y: 2026 }, 'A12 月份非法（13）→ 退化成只知道年份');
  eq(I('2026-02-30'), { kind: 'month', y: 2026, m: 2 }, 'A13 日非法（30 号不存在）→ 退化成只到月');
}

/* ---------- B. 落格键 vs 最晚键 ---------- */
console.log('[B] fuzzyDateKey（最早）/ fuzzyDateEndKey（最晚）');
{
  const E = makeEnv([]);
  eq(E.fuzzyDateKey('2026-11-15'), '2026-11-15', 'B1 精确 → 自己');
  eq(E.fuzzyDateKey('2026-11'), '2026-11-01', 'B2 只有月 → 该月 1 号（日历落在月初格）');
  eq(E.fuzzyDateKey('2026-Q4'), '2026-10-01', 'B3 四季度 → 10 月 1 号（Q4 的第一个月）');
  eq(E.fuzzyDateKey('2026-Q1'), '2026-01-01', 'B4 一季度 → 1 月 1 号');
  eq(E.fuzzyDateKey('2026'), '2026-01-01', 'B5 只有年 → 1 月 1 号');
  eq(E.fuzzyDateKey(''), '', 'B6 空 → 空');

  eq(E.fuzzyDateEndKey('2026-11-15'), '2026-11-15', 'B7 精确 → 自己');
  eq(E.fuzzyDateEndKey('2026-11'), '2026-11-30', 'B8 只有月 → 该月最后一天 ★');
  eq(E.fuzzyDateEndKey('2026-02'), '2026-02-28', 'B9 平年 2 月 → 28 号');
  eq(E.fuzzyDateEndKey('2028-02'), '2028-02-29', 'B10 闰年 2 月 → 29 号');
  eq(E.fuzzyDateEndKey('2026-Q4'), '2026-12-31', 'B11 四季度 → 12 月 31 号');
  eq(E.fuzzyDateEndKey('2026-Q1'), '2026-03-31', 'B12 一季度 → 3 月 31 号');
  eq(E.fuzzyDateEndKey('2026-Q2'), '2026-06-30', 'B13 二季度 → 6 月 30 号');
  eq(E.fuzzyDateEndKey('2026'), '2026-12-31', 'B14 只有年 → 年底');
}

/* ---------- C. 文案 / 模糊判定 ---------- */
console.log('[C] 文案与模糊判定');
{
  const E = makeEnv([]);
  eq(E.fuzzyDateText('2026-11-15'), '2026·11·15', 'C1 精确');
  eq(E.fuzzyDateText('2026-11'), '2026 年 11 月', 'C2 只有月');
  eq(E.fuzzyDateText('2026-Q4'), '2026 年四季度', 'C3 季度');
  eq(E.fuzzyDateText('2026'), '2026 年', 'C4 只有年');
  ok(E.fuzzyDateIsVague('2026-11') === true, 'C5 只有月 → 模糊');
  ok(E.fuzzyDateIsVague('2026-Q4') === true, 'C6 季度 → 模糊');
  ok(E.fuzzyDateIsVague('2026-11-15') === false, 'C7 精确日期 → 不模糊');
}

/* ---------- D. 倒计时（关键：模糊日期按「最晚」算） ---------- */
console.log('[D] 倒计时 / 逾期判定');
{
  const E = makeEnv([]);
  eq(E.fuzzyDaysFromToday(dayOffset(3)), 3, 'D1 三天后 → 3');
  eq(E.fuzzyDaysFromToday(dayOffset(0)), 0, 'D2 今天 → 0');
  eq(E.fuzzyDaysFromToday(dayOffset(-2)), -2, 'D3 两天前 → -2');
  /* ★ 核心：这个月还没过完，就不该报逾期 */
  const thisMonth = curYM();
  const dThis = E.fuzzyDaysFromToday(thisMonth);
  ok(dThis >= 0, 'D4 ★ 「' + thisMonth + '」（只有月份）本月内不算逾期（得到 ' + dThis + '）');
  const lastMonth = (function () {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + fz2(d.getMonth() + 1);
  })();
  ok(E.fuzzyDaysFromToday(lastMonth) < 0, 'D5 上个月（只有月份）→ 已经过完了，算逾期');
}

/* ---------- E. 排序 ---------- */
console.log('[E] 排序');
{
  const E = makeEnv([]);
  const rows = [
    mkRow({ 名称: '没填日期' }),
    mkRow({ 名称: '下个月', 预定出货日期: nextYM() }),
    mkRow({ 名称: '今天', 预定出货日期: dayOffset(0) }),
    mkRow({ 名称: '没填日期2' }),
  ];
  const s = E.poSort(rows).map(function (r) { return r['名称']; });
  eq(s[0], '今天', 'E1 最近的排最前');
  eq(s[1], '下个月', 'E2 其次');
  eq(s.slice(2).sort(), ['没填日期', '没填日期2'].sort(), 'E3 没填出货日期的排在最后');
  eq(s.length, 4, 'E4 一条不少');
}

/* ---------- F. 面板：只收「已预订」 ---------- */
console.log('[F] 面板只收「已预订」');
{
  const E = makeEnv([
    mkRow({ _id: 'a1', 名称: '预定中的甲', 预定出货日期: dayOffset(10) }),
    mkRow({ _id: 'a2', 名称: '已经在库的乙', 状态: ['在库'], 预定出货日期: dayOffset(10) }),
    mkRow({ _id: 'a3', 名称: '云游的丙', 状态: ['云游'] }),
    mkRow({ _id: 'a4', 名称: '书籍', 大类: '书籍', 状态: ['已预订'] }),
  ]);
  eq(E.poRows().length, 1, 'F1 只有「已预订」的算预定物（在库 / 云游 / 书籍都不算）');
  const html = E.preorderPanel();
  ok(html.indexOf('预定中的甲') >= 0, 'F2 预定物出现在面板里');
  ok(html.indexOf('已经在库的乙') < 0, 'F3 在库的东西不混进预定物面板');
  ok(html.indexOf('云游的丙') < 0, 'F4 云游的不混进来');
  ok(html.indexOf('书籍') < 0, 'F5 书籍（文渊斋）不混进来');
}

/* ---------- G. 空状态 ---------- */
console.log('[G] 空状态');
{
  const E = makeEnv([]);
  const html = E.preorderPanel();
  ok(html.indexOf('EMPTY:还没有预定中的东西') >= 0, 'G1 没有预定物时给空状态提示');
  ok(html.indexOf('已预订') >= 0, 'G2 提示里告诉用户「怎么让东西出现在这里」');
  ok(html.indexOf('data-act="go"') >= 0, 'G3 提供「去藏品馆」的入口');
  ok(html.indexOf('po-cal') < 0, 'G4 空的时候不画日历（免得一片空格子）');
}

/* ---------- H. 提醒条 ---------- */
console.log('[H] 提醒条');
{
  const E = makeEnv([
    mkRow({ _id: 'l1', 名称: '逾期的', 预定出货日期: dayOffset(-5) }),
    mkRow({ _id: 's1', 名称: '快出的', 预定出货日期: dayOffset(2) }),
    mkRow({ _id: 'n1', 名称: '没日期的' }),
  ]);
  const html = E.preorderPanel();
  ok(/po-alert late/.test(html), 'H1 有逾期 → 红条');
  ok(html.indexOf('已过预计出货日') >= 0, 'H2 逾期文案');
  ok(/po-alert soon/.test(html), 'H3 有 7 天内的 → 黄条');
  ok(/po-alert todo/.test(html), 'H4 有没填出货日期的 → 灰条');
  ok(html.indexOf('逾期的') >= 0 && html.indexOf('快出的') >= 0, 'H5 提醒条里点了名字');
}

/* ---------- I. 日历落格（v154：一排三个月） ---------- */
console.log('[I] 出货日历落格');
{
  const thisM = curYM(), nextM = nextYM(), farM = monthOffset(3);
  const E = makeEnv([
    mkRow({ _id: 'c1', 名称: '本月十号', 预定出货日期: thisM + '-10' }),
    mkRow({ _id: 'c2', 名称: '下个月的', 预定出货日期: nextM + '-03' }),
    mkRow({ _id: 'c3', 名称: '很远的', 预定出货日期: farM + '-05' }),
  ], thisM);
  const cal = E.poCalHTML(E.poRows());
  const blocks = (cal.match(/po-monthcal/g) || []).length;
  eq(blocks, 3, 'I1 ★ 一排三个月（用户嫌一个月拉得太宽）');
  ok(cal.indexOf('data-id="c1"') >= 0, 'I2 本月的落格在');
  ok(cal.indexOf('data-id="c2"') >= 0, 'I3 ★ 下个月的也在窗口里（不翻页就看得见）');
  ok(cal.indexOf('data-id="c3"') < 0, 'I4 隔着三个月的挤不进来（窗口只含前后各一个月）');
  ok(/po-calgrid/.test(cal), 'I5 三个月包在 .po-calgrid 里（手机端靠它只留中间一个）');
  ok(/data-act="pocal"/.test(cal), 'I6 翻月按钮还在');

  /* 窗口整体滑动：基准月 +1 → 原本在右边的变成中间 */
  const E2 = makeEnv([mkRow({ _id: 'c2', 名称: '下个月的', 预定出货日期: nextM + '-03' })], nextM);
  ok(E2.poCalHTML(E2.poRows()).indexOf('data-id="c2"') >= 0, 'I7 把基准月翻到它那月也看得到');

  /* 模糊日期（季度）落在季度第一个月 */
  const E3 = makeEnv([mkRow({ _id: 'q1', 名称: '三季度出货', 预定出货日期: '2099-Q3' })], '2099-07');
  const cal3 = E3.poCalHTML(E3.poRows());
  ok(cal3.indexOf('data-id="q1"') >= 0, 'I8 季度（Q3）落到 7 月那格');
  ok(/po-ev vague/.test(cal3), 'I9 ★ 模糊日期带 .vague 虚线圈，不假装它很确定');
  /* 只有月份的也落在 1 号 */
  const E4 = makeEnv([mkRow({ _id: 'm1', 名称: '只到月', 预定出货日期: '2099-07' })], '2099-07');
  ok(E4.poCalHTML(E4.poRows()).indexOf('data-id="m1"') >= 0, 'I10 只有月份的落到该月 1 号那格');

  /* 单月渲染：格数是 7 的整数倍（补齐整周，最后一行不会缺角）
     ⚠️ 数格子要用 `class="po-cell` 而不是 `po-cell` —— 容器的 `po-cells` 也含这个子串。 */
  const one = E.poMonthCalHTML([], 2026, 2);
  const cellN = (one.match(/class="po-cell[ "]/g) || []).length;
  ok(cellN % 7 === 0 && cellN >= 28, 'I11 单月格数是 7 的整数倍（2026-02 共 ' + cellN + ' 格）');
  ok(/2026 年 2 月/.test(one), 'I12 单月日历带完整标题（跨年时也看得清）');
}

/* ---------- J. 卡片与按钮（v154：日期标签可点、就地编辑） ---------- */
console.log('[J] 卡片 / 操作');
{
  const E = makeEnv([
    mkRow({ _id: 'p1', 名称: '卡上的甲', IP: '宝可梦', 预定日期: '2026-09-01', 预定出货日期: dayOffset(20) }),
  ], curYM());
  const html = E.preorderPanel();
  ok(html.indexOf('data-act="popen" data-id="p1"') >= 0, 'J1 卡片可点开物品（popen）');
  ok(html.indexOf('data-act="porecv" data-id="p1"') >= 0, 'J2 卡片上有「到货了」按钮');
  ok(html.indexOf('预订 2026·09·01') >= 0, 'J3 显示预定日期');
  ok(html.indexOf('宝可梦') >= 0, 'J4 显示 IP');
  ok(html.indexOf('po-chip') >= 0, 'J5 出货日期做成 chip');
  ok(/data-act="poedit" data-id="p1" data-f="预定出货日期"/.test(html), 'J6 ★ 出货日期标签可点（就地编辑）');
  ok(/data-act="poedit" data-id="p1" data-f="预定日期"/.test(html), 'J7 ★ 预定日期标签也可点');

  const E2 = makeEnv([mkRow({ _id: 'p2', 名称: '没日期' })]);
  const h2 = E2.preorderPanel();
  ok(h2.indexOf('＋ 填出货日期') >= 0, 'J8 没填出货日期 → 显示可点的「＋ 填出货日期」');
  ok(h2.indexOf('＋ 填预定日期') >= 0, 'J9 没填预定日期 → 显示可点的「＋ 填预定日期」');
  /* 卡片自己不再是一句「还没填…」的死提示（提醒条里那句是给用户看的提醒，保留） */
  const cardNoDue = E2.poCardHTML(E2.store.collection.rows[0]);
  ok(cardNoDue.indexOf('还没填') < 0 && cardNoDue.indexOf('data-act="poedit"') >= 0,
    'J10 卡片上是能点的入口，不是干巴巴的提示');

  const cal = E.poCalHTML(E.poRows());
  ok(cal.indexOf('data-act="popen"') >= 0, 'J11 日历里的事件条也可点开物品');
}

/* ---------- K. 卡片上的就地编辑（不弹窗） ---------- */
console.log('[K] 卡片就地编辑');
{
  const E = makeEnv([mkRow({ _id: 'k1', 名称: '甲', 预定出货日期: '' })]);
  const row = E.store.collection.rows[0];
  ok(E.poCardHTML(row).indexOf('po-inlineedit') < 0, 'K1 平时不展开编辑区');

  E.ui.poEdit = { id: 'k1', f: '预定出货日期' };
  const card = E.poCardHTML(row);
  ok(card.indexOf('po-inlineedit') >= 0, 'K2 ★ 点一下标签 → 卡片上就地展开（不弹窗）');
  ok(/data-poseg="y"/.test(card) && /data-poseg="g"/.test(card) && /data-poseg="d"/.test(card),
    'K3 出货日期是「年 / 月或季度 / 日」三个下拉');
  ok(/data-act="poeditnoop"/.test(card), 'K4 ★ 编辑区带 data-act（否则点下拉会被当成「点开详情」）');
  ok(/data-act="poeditdone"/.test(card), 'K5 有收起按钮');

  /* 合成：假的下拉盒子 */
  function box(id, f, vals) {
    return {
      getAttribute: function (n) { return n === 'data-id' ? id : (n === 'data-f' ? f : null); },
      querySelector: function (sel) {
        const m = /data-poseg="([a-z])"/.exec(sel);
        if (!m) return null;
        const v = vals[m[1]];
        return (v == null) ? null : { value: String(v) };
      },
    };
  }
  E.poInlineCommit(box('k1', '预定出货日期', { y: '2027', g: 'Q4', d: '' }));
  eq(row['预定出货日期'], '2027-Q4', 'K6 选 2027 + 四季度 → 存成 2027-Q4');
  E.poInlineCommit(box('k1', '预定出货日期', { y: '2027', g: 'M11', d: '8' }));
  eq(row['预定出货日期'], '2027-11-08', 'K7 选 2027 + 11 月 + 8 日 → 2027-11-08');
  E.poInlineCommit(box('k1', '预定出货日期', { y: '2027', g: 'M11', d: '' }));
  eq(row['预定出货日期'], '2027-11', 'K8 日留空 → 只到月 2027-11');
  E.poInlineCommit(box('k1', '预定出货日期', { y: '2027', g: '', d: '' }));
  eq(row['预定出货日期'], '2027', 'K9 只选年 → 2027');
  E.poInlineCommit(box('k1', '预定出货日期', { y: '', g: '', d: '' }));
  eq(row['预定出货日期'], null, 'K10 全清空 → 存成 null（明确清掉，不是留个空串）');

  /* 预定日期那套（年 / 月 / 日） */
  E.poInlineCommit(box('k1', '预定日期', { y: '2027', m: '3', d: '5' }));
  eq(row['预定日期'], '2027-03-05', 'K11 预定日期：年+月+日 → 2027-03-05（补零）');
  E.poInlineCommit(box('k1', '预定日期', { y: '2027', m: '', d: '' }));
  eq(row['预定日期'], '2027', 'K12 预定日期只选年 → 2027');

  /* 值没变 → 不写盘、不刷 _upd（沿用 v127 的老约定） */
  const before = E.log.patches.length;
  E.poInlineCommit(box('k1', '预定日期', { y: '2027', m: '', d: '' }));
  eq(E.log.patches.length, before, 'K13 值没变就不写盘（不白刷 _upd、不报待上传）');

  /* 编辑态是按 (id, 字段) 精确匹配的 —— 同一条的另一半不会跟着展开 */
  E.ui.poEdit = { id: 'k1', f: '预定出货日期' };
  const c2 = E.poCardHTML(E.store.collection.rows[0]);
  const edits = (c2.match(/po-inlineedit/g) || []).length;
  eq(edits, 1, 'K14 一次只展开一个日期（另一个仍是标签）');
}

/* ---------- L. 购入渠道候选（v154） ---------- */
console.log('[L] 购入渠道「可选可输」的候选');
{
  const E = makeEnv([
    mkRow({ _id: 'g1', 名称: '甲', 购入渠道: '古月鸟' }),
    mkRow({ _id: 'g2', 名称: '乙', 购入渠道: '闲鱼' }),
    mkRow({ _id: 'g3', 名称: '丙', 购入渠道: '同事代购' }),
    mkRow({ _id: 'g4', 名称: '丁' }),
  ]);
  const opts = E.channelOptionsAll();
  ['淘宝', '京东', '小红书', '抖音', '古月鸟', '千树模玩', '闲鱼'].forEach(function (n, i) {
    ok(opts.indexOf(n) >= 0, 'L' + (i + 1) + ' 预设里有「' + n + '」');
  });
  ok(opts.indexOf('同事代购') >= 0, 'L8 ★ 数据里用过的渠道也进候选（老写法不会被丢掉）');
  eq(opts.length, Array.from(new Set(opts)).length, 'L9 候选不重复');
  eq(opts[0], '淘宝', 'L10 预设排在前面（下拉第一屏就是常用那几个）');
  ok(opts.indexOf('') < 0 && opts.indexOf(null) < 0, 'L11 空值不进候选');
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
