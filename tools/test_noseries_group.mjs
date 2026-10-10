/* ============================================================
 * test_noseries_group.mjs —— v153「没有系列归属 = 按 大类 · 小类 展示」回归测试
 * ------------------------------------------------------------
 * 用户原话：
 *   「没有系列归属的物品展示的板块，不要叫未归类，而是按照 大类·小类 进行展示管理。
 *     例如一家鼠抬蘑菇，这个不属于任何系列，但它是手办·景品，那么就以这个名字来统御。
 *     别写未归类，这个名字没有人情味，而且搞得它们没有系列归属的好像是孤儿。」
 *
 * 所以这里钉住三件事：
 *   ① 名字规则：`大类 · 小类`（缺小类就只用大类，都没有才退回「藏品」）
 *   ② 分组：同一「大类·小类」的聚成一块，顺序稳定（每次渲染都一样）
 *   ③ **界面上再也不会出现「未归类 / 未归入系列 / 未绑定」** —— 这是用户的硬要求
 *
 * 抠真实源码跑（catSubLabel / groupByCatSub / catSubBlocks），配假 ui 与假渲染函数。
 *
 * 用法：
 *     node tools/test_noseries_group.mjs
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

const code = ['catSubLabel', 'groupByCatSub', 'catSubBlocks'].map(extractFn).join('\n\n');

function makeEnv(view) {
  const ui = { collection: { view: view || 'wall' } };
  const deps = `
    function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function ownedCount(rows){ var n=0; (rows||[]).forEach(function(r){ n += (Number(r['持有'])||1); }); return n; }
    function collectionWall(rows){ return '<wall:'+rows.length+'>'; }
    function collectionList(rows){ return '<list:'+rows.length+'>'; }
    function renderPagedWall(rows){ return '<paged:'+rows.length+'>'; }
  `;
  const factory = new Function('ui', deps + '\n' + code + `
    return { catSubLabel:catSubLabel, groupByCatSub:groupByCatSub, catSubBlocks:catSubBlocks, ui:ui };`);
  return factory(ui);
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
const mk = (o) => Object.assign({ _id: 'r', 名称: '物件', 持有: 1 }, o);

console.log('=== v153「没有系列归属 → 按 大类 · 小类 展示」回归测试 ===\n');

/* ---------- A. 名字规则 ---------- */
console.log('[A] 名字 = 大类 · 小类');
{
  const E = makeEnv();
  eq(E.catSubLabel(mk({ 大类: '手办', 小类: '景品' })), '手办 · 景品', 'A1 ★ 用户的例子：手办 · 景品');
  eq(E.catSubLabel(mk({ 大类: '周边', 小类: '冰箱贴' })), '周边 · 冰箱贴', 'A2 周边 · 冰箱贴');
  eq(E.catSubLabel(mk({ 大类: '手办' })), '手办', 'A3 只有大类 → 只用大类');
  eq(E.catSubLabel(mk({ 小类: '景品' })), '景品', 'A4 只有小类 → 只用小类');
  eq(E.catSubLabel(mk({})), '藏品', 'A5 都没有 → 兜底「藏品」（不是「未归类」）');
  eq(E.catSubLabel(mk({ 大类: '书籍', 小分类: '小说' })), '书籍 · 小说', 'A6 兼容书籍的「小分类」字段名');
  eq(E.catSubLabel(mk({ 大类: '  手办  ', 小类: ' 景品 ' })), '手办 · 景品', 'A7 前后空格被修掉');
  eq(E.catSubLabel(null), '藏品', 'A8 null 也不崩');
}

/* ---------- B. 分组 ---------- */
console.log('[B] 分组与顺序');
{
  const E = makeEnv();
  const rows = [
    mk({ _id: 'a', 大类: '周边', 小类: '冰箱贴' }),
    mk({ _id: 'b', 大类: '手办', 小类: '景品' }),
    mk({ _id: 'c', 大类: '周边', 小类: '冰箱贴' }),
    mk({ _id: 'd', 大类: '赏戏', 小类: '电影' }),
    mk({ _id: 'e', 大类: '手办', 小类: '景品' }),
  ];
  const g = E.groupByCatSub(rows);
  eq(g.length, 3, 'B1 分出 3 组');
  const labels = g.map(function (x) { return x.label; });
  ok(labels.indexOf('手办 · 景品') >= 0 && labels.indexOf('周边 · 冰箱贴') >= 0, 'B2 分组标题就是「大类 · 小类」');
  /* 固定顺序：按名字排（中文） */
  eq(labels, labels.slice().sort(function (a, b) { return a.localeCompare(b, 'zh'); }), 'B3 顺序稳定（每次渲染都一样，不会乱跳）');
  /* 同一组的两条要在一起 */
  const gi = labels.indexOf('手办 · 景品');
  eq(g[gi].rows.length, 2, 'B4 同类的两条归到一组');
  eq(g[labels.indexOf('周边 · 冰箱贴')].rows.length, 2, 'B5 周边 · 冰箱贴 两条一组');
  /* 顺序稳定性：同样的数据多跑几次结果一致 */
  eq(E.groupByCatSub(rows).map(function (x) { return x.label; }), labels, 'B6 同样的数据重复分组结果一致');
  eq(E.groupByCatSub([]).length, 0, 'B7 空数组 → 0 组');
}

/* ---------- C. 出块（标题 + 件数 + 卡片墙），且不能出现旧措辞 ---------- */
console.log('[C] 渲染出的块');
{
  const E = makeEnv('wall');
  const rows = [
    mk({ _id: 'a', 大类: '手办', 小类: '景品', 名称: '一家鼠抬蘑菇' }),
    mk({ _id: 'b', 大类: '周边', 小类: '冰箱贴' }),
  ];
  const html = E.catSubBlocks(rows);
  ok(html.indexOf('一家鼠抬蘑菇') >= 0 || html.indexOf('<wall:1>') >= 0, 'C1 物品被渲染出来');
  ok(html.indexOf('手办 · 景品') >= 0, 'C2 分组标题是「手办 · 景品」');
  ok(html.indexOf('周边 · 冰箱贴') >= 0, 'C3 另一个分组也在');
  ok(html.indexOf('<wall:1>') >= 0, 'C4 每组一个卡片墙');
  ok(/<h4>手办 · 景品 <i>1<\/i><\/h4>/.test(html), 'C5 标题里带件数');
  /* ★ 用户硬要求 */
  ok(html.indexOf('未归类') < 0, 'C6 ★ 不出现「未归类」');
  ok(html.indexOf('未归入系列') < 0, 'C7 ★ 不出现「未归入系列」');
  ok(html.indexOf('未绑定') < 0, 'C8 ★ 不出现「未绑定」');

  /* 列表视图要跟着走 */
  const E2 = makeEnv('list');
  ok(E2.catSubBlocks(rows).indexOf('<list:1>') >= 0, 'C9 列表视图下用列表渲染');

  /* 分组数很少时不分页（分页状态是全局的，多组共用会串） */
  ok(E.catSubBlocks(rows).indexOf('<paged:') < 0, 'C10 小组不分页');
  const many = [];
  for (let i = 0; i < 250; i++) many.push(mk({ 大类: '手办', 小类: '景品' }));
  ok(E.catSubBlocks(many).indexOf('<paged:250>') >= 0, 'C11 某组超过 200 条才交回分页');

  /* owned 选项：件数按持有累加、并带「件」字（系列库/П库那两处用） */
  const E3 = makeEnv();
  const owned = E3.catSubBlocks([mk({ 大类: '手办', 小类: '景品', 持有: 3 })], { mt: true, owned: true });
  ok(/<h4>手办 · 景品 <i>3 件<\/i><\/h4>/.test(owned), 'C12 owned 模式：件数按持有累加并带「件」');
  ok(owned.indexOf('margin-top:24px') >= 0, 'C13 mt 模式：带上边距');
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
