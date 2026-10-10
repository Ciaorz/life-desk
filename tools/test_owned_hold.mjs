/* ============================================================
 * test_owned_hold.mjs —— 「在库 ⇒ 持有至少 1」回归测试（v150 / v151）
 * ------------------------------------------------------------
 * 用户要的行为（原话）：
 *   「所有界面，只要点击了在库，持有数自动变 1；如果有 2 个或多个，我自己再添加就可以。」
 *
 * 为什么这样做：
 *   app.js 是浏览器脚本，直接 import 会炸。所以把相关函数**原文抠出来**
 *   （stArr / clearOwnedConflicts / holdPatchForStatus / patchRowFields /
 *     toggleRowStatus …），用 new Function 在 Node 里跑，配假 store。
 *   → 测的是**真正要上线的代码**。
 *
 * 覆盖的入口：
 *   ① 卡片上的快速按钮 `toggleRowStatus`（走 patchRowFields，本地/文件/gh 模式）
 *   ② 同一个函数在「已经是在库、但持有还空着」时的行为（v151 修的那条）
 *   ③ holdPatchForStatus 本身的边界（空 / 0 / 负数 / 字符串 / ≥1 不覆盖）
 *   ④ 不白刷 _upd：值没变就不动时间戳（v127 的老约定不能被打破）
 *
 * 用法：
 *     node tools/test_owned_hold.mjs
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = process.env.APP_PATH || join(ROOT, 'app.js');
const src = readFileSync(APP, 'utf8');

/* ---------- 按函数名抠源码（配对花括号，跳过字符串与注释） ---------- */
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

const NEEDED = [
  'stArr', 'hasStatus', 'normalizeOwnStatus', 'clearOwnedConflicts', 'ownedExtraStatuses',
  'holdPatchForStatus', 'cloudStableStr', 'patchIsNoop', 'patchRowFields', 'toggleRowStatus',
];
const code = [
  extractVar('var OWNED_CONFLICT_STATUS'),
  extractVar('var OWN_STATUS_EXTRA'),
  extractVar('var DATE_FIELDS'),
  ...NEEDED.map(extractFn),
].join('\n\n');

/* ---------- 造运行环境（localfile 模式 = 走 patchRowFields 那条路） ---------- */
function makeEnv() {
  const store = {
    collection: { rows: [], status: 'ok' },
  };
  const calls = { localSave: 0, ghSave: 0, cache: 0 };
  const factory = new Function('store', 'calls', `
    var MODE = 'localfile';
    function queueLocalSave(){ calls.localSave++; }
    function queueGhSave(){ calls.ghSave++; }
    function localCacheSet(){ calls.cache++; }
    function lsSet(){ calls.cache++; }
    function num(v){ var n=Number(v); return isFinite(n)?n:0; }
    function normDateStr(v){
      if (v == null || v === '') return v;
      var s = String(v).trim();
      var m = s.match(/^(\\d{4})[-.\\/](\\d{1,2})[-.\\/](\\d{1,2})$/);
      if (!m) return v;
      var out = m[1] + '-' + ('0'+m[2]).slice(-2) + '-' + ('0'+m[3]).slice(-2);
      return (out === s) ? v : out;
    }
    /* db 模式专用（本测试走 localfile，不会执行到，但函数体里引用了它） */
    function updateRow(){ throw new Error('不该走 updateRow：本测试是 localfile 模式'); }
    function activeFields(){ return []; }
    function fieldVal(){ return null; }

    ${code}

    return {
      toggleRowStatus: toggleRowStatus,
      holdPatchForStatus: holdPatchForStatus,
      normalizeOwnStatus: normalizeOwnStatus,
      clearOwnedConflicts: clearOwnedConflicts,
      patchRowFields: patchRowFields,
      store: store,
    };
  `);
  const env = factory(store, calls);
  env.calls = calls;
  return env;
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

/* 造一行藏品并放进 store，返回它 */
function row(env, status, hold) {
  const r = { _id: 'r1', 名称: '测试物品', 状态: status, 持有: hold, _upd: 1000, _rev: 1 };
  env.store.collection.rows = [r];
  return r;
}
const get = (env) => env.store.collection.rows[0];

console.log('=== 「在库 ⇒ 持有至少 1」回归测试 ===\n');

/* ---------- A. holdPatchForStatus 边界 ---------- */
console.log('[A] holdPatchForStatus 边界');
{
  const env = makeEnv();
  const h = env.holdPatchForStatus;
  eq(h(['在库'], null), { 持有: 1 }, 'A1 在库 + 持有空 → 补 1');
  eq(h(['在库'], ''), { 持有: 1 }, 'A2 在库 + 持有空串 → 补 1');
  eq(h(['在库'], 0), { 持有: 1 }, 'A3 在库 + 持有 0（云游切过来的）→ 补 1');
  eq(h(['在库'], '0'), { 持有: 1 }, 'A4 在库 + 持有字符串 "0" → 补 1');
  eq(h(['在库'], -2), { 持有: 1 }, 'A5 在库 + 持有负数 → 补 1');
  eq(h(['在库'], 'abc'), { 持有: 1 }, 'A6 在库 + 持有非法值 → 补 1');
  eq(h(['在库'], 1), {}, 'A7 在库 + 持有 1 → 不动（本来就是 1）');
  eq(h(['在库'], 3), {}, 'A8 ★ 在库 + 持有 3 → 一个字不改（用户手填的多件不能被压成 1）');
  eq(h(['在库'], '5'), {}, 'A9 在库 + 持有 "5" → 不动');
  eq(h([], null), {}, 'A10 状态为空 → 不补');
  eq(h(['云游'], null), {}, 'A11 只有云游 → 不补（未入手，持有该是 0）');
  eq(h(['想收'], null), {}, 'A12 只有想收 → 不补');
  eq(h('在库,想收', null), { 持有: 1 }, 'A13 状态是逗号串 → 也认得出来');
  eq(h('云游,想收', 0), {}, 'A14 逗号串里没有在库 → 不补');
  eq(h(null, null), {}, 'A15 状态为 null → 不补（不崩）');
}

/* ---------- B. 快速按钮：各种「点成在库」的起点 ---------- */
console.log('[B] 快速按钮 toggleRowStatus（点「在库」）');
{
  const cases = [
    ['B1 无状态 + 持有空', [], null, ['在库'], 1],
    ['B2 云游 + 持有 0', ['云游'], 0, ['在库'], 1],
    ['B3 云游 + 持有空', ['云游'], null, ['在库'], 1],
    ['B4 想收 + 持有空', ['想收'], null, ['在库'], 1],
    ['B5 想收+已预订 共存', ['想收', '已预订'], null, ['在库'], 1],
    /* 「已出」是历史状态（STATES_OWN 里早就去掉了，现网数据一条都没有）——
       v155 的 normalize 只认 在库/云游/想收/已预订，遇到它就规整掉。 */
    ['B6 已出 + 持有空（历史状态，会被归一掉）', ['已出'], null, ['在库'], 1],
  ];
  cases.forEach(([name, st, hold, wantSt, wantHold]) => {
    const env = makeEnv();
    row(env, st, hold);
    const on = env.toggleRowStatus('collection', 'r1', '在库');
    eq(get(env)['状态'], wantSt, name + ' → 状态变成「在库」（其余互斥状态清掉）');
    eq(get(env)['持有'], wantHold, name + ' → 持有补成 1');
    ok(on === true, name + ' → 返回 true（已标记为在库）');
  });
}

/* ---------- C. v151：已经是在库、但持有还空着（老数据的痛点） ---------- */
console.log('[C] 已经在库但持有没记 —— 点一下应该是「补齐」而不是「取消」');
{
  const env = makeEnv();
  row(env, ['在库'], null);
  const on = env.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env)['状态'], ['在库'], 'C1 仍然是在库（没有被误取消）');
  eq(get(env)['持有'], 1, 'C2 ★ 持有补成 1 —— 这正是用户报的那条');
  ok(on === true, 'C3 返回 true');

  const env2 = makeEnv();
  row(env2, ['在库'], 0);
  env2.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env2)['持有'], 1, 'C4 持有是 0（云游切过来留下的）也一样补成 1');

  /* 脏数据：在库 + 想收，持有空 */
  const env3 = makeEnv();
  row(env3, ['在库', '想收'], null);
  env3.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env3)['状态'], ['在库'], 'C5 在库+想收（脏）→ 只清掉多余的，保留在库');
  eq(get(env3)['持有'], 1, 'C6 同一趟把持有补成 1');

  /* 干净的「在库 + 持有 3」→ 才是真的再点一次取消 */
  const env4 = makeEnv();
  row(env4, ['在库'], 3);
  const on4 = env4.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env4)['状态'], ['云游'], 'C7 ★ 在库且持有 3 → 再点一次取消，**落回云游**（v155：不是变空）');
  eq(get(env4)['持有'], 3, 'C8 取消在库时持有保持 3 不变');
  ok(on4 === false, 'C9 返回 false（已取消）');
}

/* ---------- D. 不会误伤：持有本来就是 1 的干净数据 + 想收不动持有 ---------- */
console.log('[D] 不误伤已有数据');
{
  const env = makeEnv();
  row(env, ['在库'], 1);
  env.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env)['状态'], ['云游'], 'D1 ★ 取消在库 → 立刻变成「云游」（用户报的那条：以前会变空）');
  eq(get(env)['持有'], 1, 'D2 持有还是 1（不动用户填的数）');

  const env2 = makeEnv();
  row(env2, ['在库'], 2);
  env2.toggleRowStatus('collection', 'r1', '想收');
  eq(get(env2)['状态'], ['云游', '想收'], 'D3 ★ 点「想收」→ 在库被去掉，基础态落回云游');
  eq(get(env2)['持有'], 2, 'D4 ★ 点「想收」不动持有（可能是「已有一件，还想再收一件」）');

  /* 往返：持有 3 的在库 → 取消 → 再加回来，持有不能变 */
  const env3 = makeEnv();
  row(env3, ['在库'], 3);
  env3.toggleRowStatus('collection', 'r1', '在库');   // 取消
  env3.toggleRowStatus('collection', 'r1', '在库');   // 加回来
  eq(get(env3)['状态'], ['在库'], 'D5 点两次回到在库');
  eq(get(env3)['持有'], 3, 'D6 往返之后持有仍是 3（没被压成 1）');
}

/* ---------- E. 落盘与时间戳 ---------- */
console.log('[E] 落盘 / 时间戳');
{
  const env = makeEnv();
  row(env, ['云游'], null);
  const before = env.calls.localSave;
  env.toggleRowStatus('collection', 'r1', '在库');
  eq(get(env)['_rev'], 2, 'E1 _rev +1');
  ok(get(env)['_upd'] > 1000, 'E2 _upd 刷新（否则云端/另一端拉不到这次改动）');
  ok(env.calls.localSave > before, 'E3 触发了落盘（localfile → queueLocalSave）');

  /* 值没变 → 不白刷时间戳（v127 的老约定：点一下再点回来不该报「待上传 1 条」） */
  const env3 = makeEnv();
  const r3 = row(env3, ['在库'], 5);
  r3._upd = 1000; r3._rev = 1;
  const wrote = env3.patchRowFields('collection', 'r1', { 状态: ['在库'], 持有: 5 });
  ok(wrote === false, 'E5 补丁和现值完全一样 → 不写（返回 false）');
  eq(r3._upd, 1000, 'E6 没变就不刷 _upd');
  eq(r3._rev, 1, 'E7 没变就不动 _rev');
}

/* ---------- N. normalizeOwnStatus：状态形态（v155 唯一的形态入口） ---------- */
console.log('[N] normalizeOwnStatus：状态模型');
{
  const E = makeEnv();
  const N = E.normalizeOwnStatus;
  eq(N([]), ['云游'], 'N1 ★ 空状态 → 云游（不再允许"没有状态"）');
  eq(N(null), ['云游'], 'N2 null → 云游');
  eq(N(''), ['云游'], 'N3 空串 → 云游');
  eq(N(undefined), ['云游'], 'N4 undefined → 云游（连字段都没有的旧数据）');
  eq(N(['在库']), ['在库'], 'N5 在库 → 在库');
  eq(N(['云游']), ['云游'], 'N6 云游 → 云游');
  eq(N(['在库', '云游']), ['在库'], 'N7 ★ 在库 + 云游 → 只留在库');
  eq(N(['在库', '想收', '已预订']), ['在库'], 'N8 ★ 在库 + 附加态 → 附加态全清（东西到手了）');
  eq(N(['想收']), ['云游', '想收'], 'N9 ★ 只有想收 → 补上云游（附加态挂在云游上）');
  eq(N(['已预订']), ['云游', '已预订'], 'N10 ★ 只有已预订 → 补上云游');
  eq(N(['想收', '已预订']), ['云游', '想收', '已预订'], 'N11 两个附加态都在 → 都保留');
  eq(N(['云游', '已预订']), ['云游', '已预订'], 'N12 本来就合法 → 原样返回');
  eq(N('想收'), ['云游', '想收'], 'N13 逗号串也认');
  eq(N('在库,想收'), ['在库'], 'N14 逗号串：在库优先');
  eq(N(['已出']), ['云游'], 'N15 历史状态「已出」→ 归一成云游（现网数据里一条都没有）');
  /* 幂等：同样的输入跑两次结果一致（写盘前可能被调多次） */
  const once = N(['想收', '已出']);
  eq(N(once), once, 'N16 幂等：已合法的形态再归一不变');
  /* ⚠️ 返回新数组、不动入参 —— 调用处必须写 `arr = normalizeOwnStatus(arr)` */
  const src = ['想收'];
  const out = N(src);
  eq(src, ['想收'], 'N17 ★ 不动入参（以前 clearOwnedConflicts 是原地改，语义变了）');
  ok(out !== src, 'N18 返回的确实是新数组');
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
