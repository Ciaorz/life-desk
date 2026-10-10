/* ============================================================
 * test_pk_groups.mjs —— v157「特殊形态 / 图鉴组选项必须和数据对得上」回归测试
 * ------------------------------------------------------------
 * 用户的诉求：
 *   ① 「特殊形态」去掉「无极巨化」；
 *   ② 「图鉴组」增加「伊布」—— 九种伊布横跨六个世代（133/134/135/136 第一，
 *      196/197 第二，470/471 第四，700 第六），按世代筛散得到处都是。
 *
 * 这类「筛选项」最容易出的毛病是**选项和数据脱节**：
 *   · 加了选项但数据没打标 → 点下去一片空白，像坏了；
 *   · 数据有值但选项里没有 → 那些东西永远筛不出来。
 * 所以这个测试不测渲染，专测**两边的一致性**：把 app.js 里的常量抠出来，
 * 跟 data/ 里真实的行比对。
 *
 * 用法：
 *     node tools/test_pk_groups.mjs
 * ============================================================ */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = process.env.APP_PATH || join(ROOT, 'app.js');
const src = readFileSync(APP, 'utf8');

function grabConst(name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[^\\]]*\\])');
  const m = re.exec(src);
  if (!m) throw new Error('找不到常量 ' + name);
  return JSON.parse(m[1].replace(/'/g, '"'));
}
function grabStr(name) {
  /* ⚠️ 不能要求前面是 `var` —— app.js 里是 `var PK_IP = '宝可梦', PK_SERIES = '30周年冰箱贴';`
     两个常量挤在一行，第二个前面是逗号。 */
  const re = new RegExp('\\b' + name + "\\s*=\\s*'([^']*)'");
  const m = re.exec(src);
  if (!m) throw new Error('找不到常量 ' + name);
  return m[1];
}

const PK_FORMS = grabConst('PK_FORMS');
const PK_GROUPS = grabConst('PK_GROUPS');
const PK_IP = grabStr('PK_IP');
const PK_SERIES = grabStr('PK_SERIES');

/* ---------- 读真实数据：只挑 module === collection 的分片 + __main ---------- */
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}
const idx = readJson(join(ROOT, 'data', 'lifedesk.json'));
if (!idx) throw new Error('读不到 data/lifedesk.json');

const rows = [];
(rows.push(...(((idx.__main || {}).collection) || [])));
let shardFiles = [];
for (const [key, info] of Object.entries(idx.shards || {})) {
  if (!info || info.module !== 'collection' || !info.file) continue;
  const p = join(ROOT, 'data', info.file);
  try { statSync(p); } catch (e) { continue; }
  shardFiles.push(info.file);
  const doc = readJson(p);
  if (doc && Array.isArray(doc.rows)) rows.push(...doc.rows);
}
const pk = rows.filter(r => r && r['系列'] === PK_SERIES && r['IP'] === PK_IP);

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

console.log('=== v157 特殊形态 / 图鉴组：选项与数据一致性 ===\n');
console.log(`（扫了 ${shardFiles.length} 个藏品分片，${PK_SERIES} 共 ${pk.length} 行）\n`);

/* ---------- A. 特殊形态 ---------- */
console.log('[A] 特殊形态选项');
{
  ok(PK_FORMS.indexOf('无极巨化') < 0, 'A1 ★「无极巨化」已从筛选选项里去掉');
  ok(PK_FORMS.indexOf('超极巨化') >= 0, 'A2 「超极巨化」还在（别误删）');
  ok(PK_FORMS.indexOf('常规图鉴') >= 0, 'A3 「常规图鉴」还在');

  /* 每个选项都得有对应的行，否则点下去一片空白 */
  const usedForms = {};
  pk.forEach(r => { const v = String(r['特殊形态'] || '').trim(); if (v) usedForms[v] = (usedForms[v] || 0) + 1; });
  PK_FORMS.forEach(f => ok(usedForms[f] > 0, `A4 选项「${f}」在数据里有 ${usedForms[f] || 0} 行（不能是空选项）`));

  /* 数据里剩下的、但选项里已经没有的形态值 —— 明确列出来，让人知道会筛不到 */
  const orphan = Object.keys(usedForms).filter(v => PK_FORMS.indexOf(v) < 0);
  eq(orphan, ['无极巨化'], 'A5 只剩「无极巨化」不在选项里（数据 2 行：无极汰那）');
  ok(usedForms['无极巨化'] === 2, 'A6 无极巨化那 2 行数据仍在（只删了选项，没动数据）');
  /* 它们还能通过图鉴组找到，不会彻底失联 */
  const wj = pk.filter(r => r['特殊形态'] === '无极巨化');
  ok(wj.every(r => String(r['图鉴组'] || '') === '传说宝可梦'),
    'A7 无极巨化那 2 行仍归在「传说宝可梦」组里（选项删了也找得到）');
}

/* ---------- B. 图鉴组 ---------- */
console.log('[B] 图鉴组选项');
{
  ok(PK_GROUPS.indexOf('伊布') >= 0, 'B1 ★ 图鉴组新增了「伊布」');
  eq(PK_GROUPS[PK_GROUPS.length - 1], '伊布', 'B2 「伊布」排在最后（原有四组顺序不动）');
  ok(PK_GROUPS.indexOf('初始的伙伴') >= 0, 'B3 原有四组都还在');

  const usedRows = {};
  pk.forEach(r => { const v = String(r['图鉴组'] || '').trim(); if (v) usedRows[v] = (usedRows[v] || 0) + 1; });
  PK_GROUPS.forEach(g => ok(usedRows[g] > 0, `B4 选项「${g}」在数据里有 ${usedRows[g] || 0} 行（不能是空选项）`));
  const orphanG = Object.keys(usedRows).filter(v => PK_GROUPS.indexOf(v) < 0);
  eq(orphanG, [], 'B5 数据里的图鉴组值全都在选项里（不会有筛不出来的）');
}

/* ---------- C. 九种伊布 ---------- */
console.log('[C] 九种伊布');
{
  const EEVEE = [133, 134, 135, 136, 196, 197, 470, 471, 700];
  const dexOf = v => { const s = String(v || '').replace(/^[#＃]/, '').trim(); return /^\d+$/.test(s) ? parseInt(s, 10) : null; };
  const ev = pk.filter(r => EEVEE.indexOf(dexOf(r['编号'])) >= 0);

  ok(ev.length > 0, `C1 找到伊布一家的行 ${ev.length} 条`);

  /* 每一条都必须打上「伊布」组 */
  const notTagged = ev.filter(r => String(r['图鉴组'] || '').trim() !== '伊布');
  eq(notTagged.map(r => r['名称']), [], 'C2 ★ 九种伊布的每一条都归在图鉴组「伊布」里');

  /* 九个编号一个都不能少 */
  const haveDex = Array.from(new Set(ev.map(r => dexOf(r['编号'])))).sort((a, b) => a - b);
  eq(haveDex, EEVEE.slice().sort((a, b) => a - b), 'C3 ★ 九个编号齐全：' + EEVEE.join('/'));

  /* 跨度确实很大 —— 这正是要单独成组的理由 */
  const gens = Array.from(new Set(ev.map(r => String(r['世代组'] || '')))).sort();
  ok(gens.length >= 4, `C4 它们横跨 ${gens.length} 个世代（${gens.join('/')}）—— 所以图鉴组才有用`);

  /* 超极巨化那个形态也跟着一起收 */
  const gmax = ev.filter(r => String(r['名称']).indexOf('超极巨化') >= 0);
  ok(gmax.length > 0, `C5 「伊布（超极巨化）」也归进「伊布」组（${gmax.length} 条）`);

  /* 冰箱贴版 / 贴纸版是两份记录，两边都要有 */
  const names = {};
  ev.forEach(r => { names[String(r['名称'])] = (names[String(r['名称']) ] || 0) + 1; });
  const multi = Object.keys(names).filter(n => names[n] > 1);
  ok(multi.length === Object.keys(names).length,
    `C6 每个名字都有多份记录（冰箱贴版 + 贴纸版）都打了标：${Object.keys(names).length} 个名字 / ${ev.length} 条`);

  /* 伊布不在「初始的伙伴」里（免得两组抢同一只） */
  const bp = pk.filter(r => String(r['图鉴组'] || '') === '初始的伙伴');
  ok(!bp.some(r => EEVEE.indexOf(dexOf(r['编号'])) >= 0), 'C7 伊布一家没有被「初始的伙伴」组占用（一行只有一个图鉴组）');
}

/* ---------- D. 幂等：脚本重跑不该再改任何东西 ---------- */
console.log('[D] 数据当前状态');
{
  const ev = pk.filter(r => [133, 134, 135, 136, 196, 197, 470, 471, 700]
    .indexOf(parseInt(String(r['编号'] || '').replace(/^[#＃]/, ''), 10)) >= 0);
  const tagged = ev.filter(r => String(r['图鉴组'] || '') === '伊布').length;
  eq(tagged, ev.length, `D1 全部 ${ev.length} 条都已打标（tools/add_eevee_group.py 再跑一次会报"没有需要补充的"）`);
}

console.log('\n----------------------------------------');
console.log(pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f, n) => console.log('  ' + (n + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
