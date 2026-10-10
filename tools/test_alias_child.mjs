/* ============================================================
 * test_alias_child.mjs —— v159 两件事的回归测试
 * ------------------------------------------------------------
 * ① 系列里的**子系列聚拢**：同子系列的物品连续显示，中间不插别的。
 *    用户原话：「系列里面如果有子系列，子系列的物品自动集中显示，中间不插入别的物品，
 *    子系列的物品连续在一起显示。」
 * ② **备注名**（别名）：`名称` 黑色 + `备注名` 灰色小一号；
 *    用户原话：「有些东西的名称太长了，我想分成两个部分……在显示卡显示该物品的时候，
 *    名称黑色字·灰色备注名，备注名字体也要比名字小一号。」
 *
 * 抠真实源码跑（`groupByChildSeries` / `nameHTML`），配一个最小 esc 桩。
 *
 * 用法：
 *     node tools/test_alias_child.mjs
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

const code = ['groupByChildSeries', 'nameHTML'].map(extractFn).join('\n\n');
const factory = new Function(`
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  ${code}
  return { groupByChildSeries:groupByChildSeries, nameHTML:nameHTML };`);
const E = factory();

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
const mk = (id, child, no) => ({ _id: id, 名称: '物品' + id, 子系列: child || '', 编号: no || '' });
const ids = (rows) => rows.map(r => r._id);

console.log('=== v159 子系列聚拢 + 备注名 回归测试 ===\n');

/* ---------- A. 子系列聚拢 ---------- */
console.log('[A] groupByChildSeries：同子系列连续显示');
{
  /* 模拟 Road trip：按编号排完序后，三套混着插 */
  const rows = [
    mk('a1', '徽章'), mk('b1', '冰箱贴'), mk('a2', '徽章'),
    mk('c1', '行李牌'), mk('b2', '冰箱贴'), mk('a3', '徽章'),
  ];
  const g = E.groupByChildSeries(rows, ['徽章', '冰箱贴', '行李牌']);
  eq(ids(g), ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'], 'A1 ★ 三套各自聚成一段，中间不被别的插入');
  eq(g.length, rows.length, 'A2 一条不多一条不少');

  /* 子系列之间的先后 = 系列里登记的顺序（不是字母序、也不是首次出现序） */
  const g2 = E.groupByChildSeries(rows, ['行李牌', '冰箱贴', '徽章']);
  eq(ids(g2), ['c1', 'b1', 'b2', 'a1', 'a2', 'a3'], 'A3 子系列的先后跟着**登记顺序**走');

  /* 没登记的按首次出现 */
  const g3 = E.groupByChildSeries(rows, []);
  eq(ids(g3), ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'], 'A4 没登记过就按首次出现的先后聚拢');

  /* 没填子系列的排最后，且组内保持原顺序 */
  const mixed = [
    mk('x1', ''), mk('a1', '徽章'), mk('x2', ''), mk('a2', '徽章'),
  ];
  const g4 = E.groupByChildSeries(mixed, ['徽章']);
  eq(ids(g4), ['a1', 'a2', 'x1', 'x2'], 'A5 没填子系列的排在最后，组内保持原顺序');

  /* 只有部分子系列有物品 —— 空的那组不该产生空段 */
  const g5 = E.groupByChildSeries([mk('a1', '徽章')], ['徽章', '冰箱贴', '行李牌']);
  eq(ids(g5), ['a1'], 'A6 登记了但没物品的子系列不占位');

  /* 边界 */
  eq(E.groupByChildSeries([], ['徽章']), [], 'A7 空列表 → 空');
  eq(ids(E.groupByChildSeries([mk('z1', '')], [])), ['z1'], 'A8 全都没子系列 → 原样返回');
  /* 子系列名两头有空格也要认 */
  const g6 = E.groupByChildSeries([mk('s1', ' 徽章 '), mk('s2', '徽章')], ['徽章']);
  eq(ids(g6), ['s1', 's2'], 'A9 子系列名前后空格不影响归组');
}

/* ---------- B. 备注名展示 ---------- */
console.log('[B] nameHTML：名称（黑）+ 备注名（灰小字）');
{
  const h1 = E.nameHTML({ 名称: '便携式折叠凳', 备注名: '小凳子' });
  ok(h1.indexOf('便携式折叠凳') >= 0, 'B1 主名在里面');
  ok(h1.indexOf('小凳子') >= 0, 'B2 备注名也在里面');
  ok(/<span class="altname">小凳子<\/span>/.test(h1), 'B3 ★ 备注名包在 .altname 里（灰、小一号靠这个类）');
  ok(h1.indexOf('便携式折叠凳') < h1.indexOf('小凳子'), 'B4 主名在前、备注名在后');

  const h2 = E.nameHTML({ 名称: '普通的东西' });
  eq(h2, '普通的东西', 'B5 没填备注名就只输出名称（不留空 span）');
  eq(E.nameHTML({ 名称: '甲', 备注名: '   ' }), '甲', 'B6 备注名只有空格 → 当没填');

  eq(E.nameHTML({}), '未命名', 'B7 连名称都没有 → 未命名');
  eq(E.nameHTML(null), '未命名', 'B8 null 也不崩');

  /* 转义：名称里带尖括号不能把卡片结构撑破 */
  const h3 = E.nameHTML({ 名称: '<b>x</b>', 备注名: 'a&b' });
  ok(h3.indexOf('<b>x</b>') < 0, 'B9 ★ 名称里的 HTML 被转义（不会撑破卡片）');
  ok(h3.indexOf('&lt;b&gt;') >= 0, 'B10 转义成了实体');
  ok(h3.indexOf('a&amp;b') >= 0, 'B11 备注名也转义');

  /* 超长名称 + 超长备注名也能正常输出 */
  const long = E.nameHTML({ 名称: '很长'.repeat(40), 备注名: '别名'.repeat(40) });
  ok(long.indexOf('很长') >= 0 && long.indexOf('别名'.repeat(40)) >= 0 && /altname/.test(long),
    'B12 超长名称+备注名能正常输出（' + long.length + ' 字符）');
}

console.log('\n----------------------------------------');
console.log(pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f, n) => console.log('  ' + (n + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
