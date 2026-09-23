/* smoke_cloud_load.mjs —— 手机端加载源（直读 Cloudflare）冒烟测试
 *
 * 覆盖 2026-09-18 新增的「手机端改读 Cloudflare」这条链：
 *   ① cloudRowsToSnap   D1 行 → { module:[rows] } 快照（跳墓碑 / 跳软删 / 补 _id/_upd/_rev）
 *   ② mergeLoadRows     云端行 + 本机快照 → 合并结果（字段并集 + 认云端删除）
 *   ③ cloudLoadAllRows  分页拉全量（含 deleted）；没令牌 / 401 / 空 / 断网 → null
 *   ④ fetchAll(gh)      源选择：有令牌优先 Cloudflare，拿不到回退 GitHub Pages
 *
 * 用 new Function 抠真源码跑，测的是要上线的代码，不是重写的复刻品。
 * 用法：node tools/smoke_cloud_load.mjs        （APP_PATH 可喂坏副本验证测试会失败）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_PATH || join(HERE, '..', 'app.js');
const src = readFileSync(APP, 'utf8');

function sliceBetween(startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  if (a < 0) { console.error('!! 找不到起点：' + startMarker + '（' + label + '）'); process.exit(1); }
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) { console.error('!! 找不到终点：' + endMarker + '（' + label + '）'); process.exit(1); }
  return src.slice(a, b);
}

const pDead   = sliceBetween('var CLOUD_DEAD_FIELDS = { _file: 1 };', 'function cloudDlWatermark(){', 'CLOUD_DEAD_FIELDS');
const pTombs  = sliceBetween('function cloudTombstoneMap(){', 'function cloudRowName(r){', 'cloudTombstoneMap');
const pMerge  = sliceBetween('function mergeLoadData(localData, cloudData){', '/* 把算好的方案真正落进内存 store', 'mergeLoadData');
const pLoad   = sliceBetween('function cloudRowsToSnap(rows){', '/* ============ 读取 ============ */', '加载源三件套');
const pFetch  = sliceBetween('function fetchAll(key, cb){', 'function migrateTravelRow(r){', 'fetchAll');

console.log('抠出源码：%d + %d + %d + %d + %d 字节',
  pDead.length, pTombs.length, pMerge.length, pLoad.length, pFetch.length);

/* ---------- 计数 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(label + (extra ? '  → ' + extra : ''));
  return false;
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, label, '实际 ' + a + ' / 期望 ' + e);
}
let _secMark = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); _secMark = pass; }
function sectionEnd() { console.log('    （本节 ' + (pass - _secMark) + ' 项通过）'); }

/* ---------- 沙箱 ---------- */
function makeEnv(opts) {
  opts = opts || {};
  const ls = Object.assign({}, opts.ls || {});
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
    _dump: () => ls,
  };

  const log = { fetch: [], idbSet: [], lcSet: [], render: [], cb: [] };
  const localSnap = opts.local || null;
  const ghSnap = opts.gh || null;
  let _ghCache = null, _ghLoading = null;
  /* 假的 DOM：$ 按 id 取元素。默认什么都取不到（等价于面板没建）。 */
  const els = opts.els || {};
  const $ = (id) => els[id] || null;

  const cloudFetch = async (base, tok, path, o) => {
    log.fetch.push({ path, method: (o && o.method) || 'GET' });
    const r = opts.fetch ? await opts.fetch(path, o) : { status: 200, json: { ok: true } };
    if (r === 'THROW') throw new Error('模拟网络中断');
    return { status: r.status, ok: r.status >= 200 && r.status < 300,
             json: r.json == null ? null : r.json, text: r.text || '' };
  };

  const factory = new Function(
    'localStorage', 'cloudFetch', 'cloudBase', 'cloudToken', '$',
    'idbGet', 'idbSet', 'localCacheGet', 'localCacheSetFrom', 'renderSoon',
    'ghStaticLoadV2', 'ghGetAll', 'loadLocalAll', 'lsGet', 'T', 'MODE',
    'var _ghCache = null, _ghLoading = null;\n' +
    pDead + '\n' + pTombs + '\n' + pMerge + '\n' + pLoad + '\n' + pFetch + '\n' +
    'return { cloudRowsToSnap:cloudRowsToSnap, cloudLoadAllRows:cloudLoadAllRows,' +
    ' mergeLoadRows:mergeLoadRows, fetchAll:fetchAll, setLoadSrc:setLoadSrc,' +
    ' cloudSrcLine:cloudSrcLine,' +
    ' cache:function(){ return _ghCache; }, reset:function(){ _ghCache=null; _ghLoading=null; } };'
  );

  const api = factory(
    localStorage,
    cloudFetch,
    () => (opts.base === undefined ? 'https://cloud.test' : opts.base),
    () => (opts.token === undefined ? 'TOKEN' : opts.token),
    $,
    async () => localSnap,
    (o) => { log.idbSet.push(o); return Promise.resolve(true); },
    () => null,
    (o) => { log.lcSet.push(o); },
    () => { log.render.push(1); },
    async () => ghSnap,
    (cb) => { if (opts.ghApi) opts.ghApi(cb); else cb(null, null, null); },
    (cb) => { cb(opts.localAll || {}); },
    () => [],
    { collection: { page: () => Promise.resolve({ results: [] }) } },
    'gh'
  );
  return { api, log, ls, els, lsStub: localStorage };
}

/* 让 fetchAll 里那串 await 跑完（stub 都是立刻 resolve，几个宏任务足够） */
async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

function row(id, mk, upd, extra) {
  return Object.assign({
    id, module: mk, cat: null, rev: 1, updated_at: upd, deleted: false,
    data: { _id: id, _upd: upd },
  }, extra || {});
}

/* ============================================================
 * ① cloudRowsToSnap —— D1 行 → 加载快照
 * ============================================================ */
section('① cloudRowsToSnap：D1 行 → 加载快照');
{
  const env = makeEnv({
    ls: { lifedesk_tombstones: JSON.stringify([{ id: 'c', key: 'k', at: 999 }]) },
  });
  const snap = env.api.cloudRowsToSnap([
    { id: 'a', module: 'collection', rev: 3, updated_at: 100, deleted: false,
      data: { _id: 'a', 名称: '甲', _upd: 90, _rev: 2 } },
    { id: 'b', module: 'collection', rev: 1, updated_at: 200, deleted: true,
      data: { _id: 'b', 名称: '乙', _upd: 180 } },
    { id: 'c', module: 'collection', rev: 1, updated_at: 300, deleted: false,
      data: { _id: 'c', 名称: '丙', _upd: 280 } },
    { id: 'd', module: 'collection', rev: 1, updated_at: 400, deleted: false,
      data: null },
    { id: '', module: 'collection', updated_at: 500, data: {} },
    { id: 'e', module: '', updated_at: 600, data: {} },
  ]);
  eq(Object.keys(snap), ['collection'], '① 只产出有 module 的模块');
  eq(snap.collection.map((r) => r._id), ['a', 'd'], '① 软删 b、墓碑 c、无 id 的都被剔掉');
  const a = snap.collection[0];
  eq(a.名称, '甲', '① 字段原样带过来');
  eq(a._upd, 90, '① _upd 取 data._upd');
  eq(a._rev, 3, '① _rev 取 max(data._rev, row.rev)');
  const d = snap.collection[1];
  eq(d._upd, 400, '① data 没有 _upd → 退回 row.updated_at');
  eq(d._rev, 1, '① data 没有 _rev → 取 row.rev');

  const env2 = makeEnv({});
  eq(env2.api.cloudRowsToSnap(null), {}, '① 入参 null → 空快照，不炸');
  eq(env2.api.cloudRowsToSnap([{ id: 'x', module: 'ip', updated_at: 1, data: { _file: '/a/b.json' } }]).ip[0]._file,
    '/a/b.json', '① _file 照收（是否剥掉由 mergeLoadData 的 CLOUD_DEAD_FIELDS 决定）');
  sectionEnd();
}

/* ============================================================
 * ② mergeLoadRows —— 云端行 + 本机快照
 * ============================================================ */
section('② mergeLoadRows：并集 + 认云端删除');
{
  const local = { collection: [
    { _id: 'x', 名称: '手机刚录', _upd: 5 },          /* 本机独有 → 必须保住 */
    { _id: 'd1', 名称: '云端删了', _upd: 10 },         /* 云端删除更晚 → 删 */
    { _id: 'd2', 名称: '删完又改', _upd: 30 },         /* 本机改得更晚 → 留 */
    { _id: 'k', 名称: '两边都有', _upd: 40 },
  ] };
  const rows = [
    row('d1', 'collection', 20, { deleted: true, data: { _id: 'd1', _upd: 10 } }),
    row('d2', 'collection', 20, { deleted: true, data: { _id: 'd2', _upd: 20 } }),
    row('k', 'collection', 60, { data: { _id: 'k', 名称: '云端改的', 价格: 9, _upd: 60 } }),
    row('n', 'collection', 70, { data: { _id: 'n', 名称: '云端新增', _upd: 70 } }),
  ];
  const env = makeEnv({});
  const merged = env.api.mergeLoadRows(local, rows);
  const ids = merged.collection.map((r) => r._id).sort();
  eq(ids, ['d2', 'k', 'n', 'x'], '② 本机独有 x 保住 / 云端新增 n 补入 / 云端删的 d1 去掉');
  ok(ids.includes('d2'), '② 本机删完之后又改过（_upd 30 > 删除时间 20）→ 保留本机');
  ok(!ids.includes('d1'), '② 云端删除更晚（20 > 本机 _upd 10）→ 删掉');
  const k = merged.collection.find((r) => r._id === 'k');
  eq(k.名称, '云端改的', '② 真冲突：_upd 较新的云端赢');
  eq(k.价格, 9, '② 只有云端有的字段 → 并集保留');
  const x = merged.collection.find((r) => r._id === 'x');
  eq(x.名称, '手机刚录', '② ★ 手机刚录、还没推的记录绝不被冲掉');

  const again = env.api.mergeLoadRows(merged, rows);
  eq(JSON.stringify(again), JSON.stringify(merged), '② 幂等：再合一次结果不变');

  /* 墓碑里的 id：云端有也不能复活（且本机快照里残留的同 id 也要被剔掉） */
  const envT = makeEnv({ ls: { lifedesk_tombstones: JSON.stringify([{ id: 'k', key: 'k', at: 999 }]) } });
  const mT = envT.api.mergeLoadRows(local, rows);
  ok(!mT.collection.some((r) => r._id === 'k'),
    '② ★ 本机墓碑里的 id 绝不复活（本机快照里残留的同 id 也被剔掉）');
  ok(!mT.collection.some((r) => r._id === 'd1'), '② 墓碑与删除不冲突，d1 仍被云端删除带走');
  eq(mT.collection.map((r) => r._id).sort(), ['d2', 'n', 'x'], '② 剔掉墓碑 id 后其余不受影响');

  /* 云端删一条本机根本没有的 → 不炸 */
  const envN = makeEnv({});
  const mN = envN.api.mergeLoadRows({ collection: [{ _id: 'z', _upd: 1 }] },
    [row('ghost', 'collection', 50, { deleted: true, data: { _id: 'ghost' } })]);
  eq(mN.collection.map((r) => r._id), ['z'], '② 云端删的 id 本机没有 → 无副作用');

  /* 没有删除行时走纯并集（与 mergeLoadData 一致） */
  const envP = makeEnv({});
  const mP = envP.api.mergeLoadRows({ collection: [{ _id: 'x', _upd: 1 }] },
    [row('y', 'collection', 2, { data: { _id: 'y', _upd: 2 } })]);
  eq(mP.collection.map((r) => r._id).sort(), ['x', 'y'], '② 无删除行 → 纯并集');

  /* 本机为 null（首次访问）→ 等于云端 */
  const envF = makeEnv({});
  const mF = envF.api.mergeLoadRows(null, [row('a', 'collection', 1, { data: { _id: 'a', _upd: 1 } })]);
  eq(mF.collection.map((r) => r._id), ['a'], '② 本机为空 → 直接取云端');

  /* 运行期字段 _file 不该被带回来 */
  const envD = makeEnv({});
  const mD = envD.api.mergeLoadRows({ ip: [{ _id: 'p1', _upd: 10 }] },
    [row('p1', 'ip', 10, { data: { _id: 'p1', _upd: 10, _file: 'data/ip/a.json' } })]);
  ok(mD.ip[0]._file === undefined, '② ★ CLOUD_DEAD_FIELDS：_file 不带回本机');
  sectionEnd();
}

/* ============================================================
 * ③ cloudLoadAllRows —— 拉全量 / 分页 / 各种失败
 * ============================================================ */
section('③ cloudLoadAllRows：拉全量 / 分页 / 失败回退');
{
  /* 没配令牌 → null，且一次网络都不发 */
  const env0 = makeEnv({ token: '' });
  const r0 = await env0.api.cloudLoadAllRows();
  ok(r0 === null, '③ 没配令牌 → null');
  eq(env0.log.fetch.length, 0, '③ 没配令牌 → 不发请求');

  /* 没配地址 → null */
  const env0b = makeEnv({ base: '' });
  ok((await env0b.api.cloudLoadAllRows()) === null, '③ 没配地址 → null');

  /* 正常：1422 条一把拉回 */
  const env1 = makeEnv({
    fetch: (p) => ({ status: 200, json: { ok: true, hasMore: false, nextSince: 100,
      rows: [row('a', 'collection', 1, { data: { _id: 'a', _upd: 1 } }),
             row('b', 'collection', 2, { data: { _id: 'b', _upd: 2 } })] } }),
  });
  const r1 = await env1.api.cloudLoadAllRows();
  eq(r1 && r1.length, 2, '③ 一次拉回 2 条');
  eq(env1.log.fetch.length, 1, '③ 没有更多 → 只发 1 个请求');
  ok(env1.log.fetch[0].path.indexOf('since=0') >= 0, '③ ★ 从 0 开始（全量）');
  ok(env1.log.fetch[0].path.indexOf('limit=2000') >= 0, '③ limit=2000');

  /* 401 → null */
  const env2 = makeEnv({ fetch: () => ({ status: 401, json: null, text: 'unauthorized' }) });
  ok((await env2.api.cloudLoadAllRows()) === null, '③ 401 → null（调用方回退 GitHub）');

  /* 空云端 → null（当作没拿到，走回退，避免把手机刷成 0 件） */
  const env3 = makeEnv({ fetch: () => ({ status: 200, json: { ok: true, hasMore: false, rows: [] } }) });
  ok((await env3.api.cloudLoadAllRows()) === null, '③ 云端 0 条 → null，不把本机刷成空');

  /* 断网 → null，不抛 */
  const env4 = makeEnv({ fetch: () => 'THROW' });
  ok((await env4.api.cloudLoadAllRows()) === null, '③ 网络异常 → null，不往外抛');

  /* 分页：第一页被 limit 截断 → 从 nextSince-1 接着拉 */
  let page = 0;
  const env5 = makeEnv({
    fetch: () => {
      page++;
      if (page === 1) return { status: 200, json: { ok: true, hasMore: true, nextSince: 1000,
        rows: [row('a', 'collection', 900, { data: { _id: 'a', _upd: 900 } }),
               row('b', 'collection', 1000, { data: { _id: 'b', _upd: 1000 } })] } };
      return { status: 200, json: { ok: true, hasMore: false, nextSince: 1200,
        rows: [row('c', 'collection', 1200, { data: { _id: 'c', _upd: 1200 } })] } };
    },
  });
  const r5 = await env5.api.cloudLoadAllRows();
  eq((r5 || []).map((r) => r.id), ['a', 'b', 'c'], '③ 分页把两页拼齐');
  eq(env5.log.fetch.length, 2, '③ 分页发了 2 个请求');
  ok(env5.log.fetch[1].path.indexOf('since=999') >= 0,
    '③ ★ 第二页从 nextSince-1 起算（重叠 1 毫秒防漏）', env5.log.fetch[1].path);

  /* 同一批时间戳完全相同 → 第二页没有新 id → 立刻收手，不空转 40 次 */
  let page2 = 0;
  const env6 = makeEnv({
    fetch: () => {
      page2++;
      return { status: 200, json: { ok: true, hasMore: true, nextSince: 500,
        rows: [row('a', 'collection', 500, { data: { _id: 'a', _upd: 500 } })] } };
    },
  });
  const r6 = await env6.api.cloudLoadAllRows();
  eq((r6 || []).map((r) => r.id), ['a'], '③ 时间戳撞车时至少拿到不重复的部分');
  ok(env6.log.fetch.length <= 3, '③ ★ 撞车不死循环（请求数 ≤ 3，实际 ' + env6.log.fetch.length + '）');
  sectionEnd();
}

/* ============================================================
 * ④ fetchAll（gh 模式）—— 源选择
 * ============================================================ */
section('④ fetchAll：有令牌优先 Cloudflare，拿不到回退 GitHub');
{
  /* A. 云端通 → 用云端，不碰 GitHub */
  const envA = makeEnv({
    local: { collection: [{ _id: 'x', 名称: '手机刚录', _upd: 5 }] },
    gh: { collection: [{ _id: 'g', 名称: 'GitHub 的', _upd: 1 }] },
    fetch: () => ({ status: 200, json: { ok: true, hasMore: false, nextSince: 9,
      rows: [row('a', 'collection', 9, { data: { _id: 'a', 名称: '云端的', _upd: 9 } })] } }),
  });
  let gotA = [];
  envA.api.fetchAll('collection', (rows) => { gotA.push(rows); });
  await flush();
  const idsA = (envA.api.cache().collection || []).map((r) => r._id).sort();
  eq(idsA, ['a', 'x'], '④ ★ 云端数据 + 本机独有的都在');
  eq(envA.ls.lifedesk_load_src, 'cloud:1', '④ 记下加载来源 cloud:1');
  ok(envA.log.idbSet.length === 1, '④ 合并结果落盘 IndexedDB 一次');
  eq(gotA[gotA.length - 1].map((r) => r._id).sort(), ['a', 'x'], '④ 回调拿到合并结果');

  /* B. 没令牌 → 回退 GitHub */
  const envB = makeEnv({
    token: '',
    local: { collection: [{ _id: 'x', _upd: 5 }] },
    gh: { collection: [{ _id: 'g', 名称: 'GitHub 的', _upd: 1 }] },
  });
  envB.api.fetchAll('collection', () => {});
  await flush();
  eq((envB.api.cache().collection || []).map((r) => r._id).sort(), ['g', 'x'],
    '④ ★ 没令牌 → 走 GitHub Pages（行为与改动前一致）');
  eq(envB.ls.lifedesk_load_src, 'gh', '④ 记下加载来源 gh');

  /* C. 云端 401 → 回退 GitHub */
  const envC = makeEnv({
    gh: { collection: [{ _id: 'g', _upd: 1 }] },
    fetch: () => ({ status: 401, json: null }),
  });
  envC.api.fetchAll('collection', () => {});
  await flush();
  eq((envC.api.cache().collection || []).map((r) => r._id), ['g'], '④ 云端 401 → 回退 GitHub');

  /* D. 云端删除 → 本机跟着删；本机改得更晚 → 留 */
  const envD = makeEnv({
    local: { collection: [
      { _id: 'd1', 名称: '云端删了', _upd: 10 },
      { _id: 'd2', 名称: '删完又改', _upd: 30 },
    ] },
    fetch: () => ({ status: 200, json: { ok: true, hasMore: false, nextSince: 20,
      rows: [row('d1', 'collection', 20, { deleted: true, data: { _id: 'd1', _upd: 10 } }),
             row('d2', 'collection', 20, { deleted: true, data: { _id: 'd2', _upd: 20 } })] } }),
  });
  envD.api.fetchAll('collection', () => {});
  await flush();
  eq((envD.api.cache().collection || []).map((r) => r._id), ['d2'],
    '④ ★ 桌面在云端删掉的，手机刷新后跟着消失（本机改得更晚的除外）');

  /* E. 首次访问（本机啥都没有）→ 云端数据直接交付 */
  const envE = makeEnv({
    fetch: () => ({ status: 200, json: { ok: true, hasMore: false, nextSince: 5,
      rows: [row('a', 'collection', 5, { data: { _id: 'a', 名称: '云端的', _upd: 5 } })] } }),
  });
  const gotE = [];
  envE.api.fetchAll('collection', (rows) => { gotE.push(rows); });
  await flush();
  eq(gotE.length, 1, '④ 首次访问：只交付一次（不走「先渲染本机」那条）');
  eq(gotE[0].map((r) => r._id), ['a'], '④ 首次访问：拿到云端数据');

  /* F. 云端与 GitHub 都拿不到，本机有数据 → 沿用本机，不报错 */
  const envF = makeEnv({
    local: { collection: [{ _id: 'x', _upd: 5 }] },
    fetch: () => 'THROW',
    gh: null,
  });
  envF.api.fetchAll('collection', () => {});
  await flush();
  eq((envF.api.cache().collection || []).map((r) => r._id), ['x'], '④ 两条链都挂 → 沿用本机快照');

  /* G. 回退 GitHub 那条链也要认墓碑（改动前 GitHub 快照会把本机删掉的记录带回来） */
  const envG = makeEnv({
    token: '',
    ls: { lifedesk_tombstones: JSON.stringify([{ id: 'g', key: 'g', at: 999 }]) },
    gh: { collection: [{ _id: 'g', 名称: '本机已删', _upd: 1 },
                       { _id: 'h', 名称: '正常的', _upd: 1 }] },
  });
  envG.api.fetchAll('collection', () => {});
  await flush();
  eq((envG.api.cache().collection || []).map((r) => r._id), ['h'],
    '④ ★ GitHub 回退链也认墓碑，不把本机删掉的记录带回来');
  sectionEnd();
}

/* ============================================================
 * ⑤ 面板那行「数据来源」小字
 * ============================================================ */
section('⑤ cloudSrcLine：面板里显示数据来源');
{
  const mk = (txt) => ({ el: { textContent: txt, style: {} }, env: null });

  /* 面板没建（$ 拿不到元素）→ 静默跳过，不炸 */
  const envNoEl = makeEnv({});
  let threw = false;
  try { envNoEl.api.setLoadSrc('cloud:1422'); } catch (e) { threw = true; }
  ok(!threw, '⑤ 面板不存在时 setLoadSrc 不炸');
  eq(envNoEl.ls.lifedesk_load_src, 'cloud:1422', '⑤ 来源仍然记进 localStorage');

  const el = { textContent: '', style: {} };
  const env = makeEnv({ els: { cloudSrcLine: el } });

  env.api.setLoadSrc('cloud:1425');
  ok(/Cloudflare/.test(el.textContent) && /1425/.test(el.textContent),
    '⑤ cloud:N → 提示「本次数据来自 Cloudflare（云端 1425 条）」', el.textContent);
  eq(el.style.color, '#1a7f37', '⑤ 走 Cloudflare 时用绿色');

  env.api.setLoadSrc('gh');
  ok(/GitHub 兜底/.test(el.textContent), '⑤ gh → 提示当前走 GitHub 兜底', el.textContent);
  eq(el.style.color, '#c77700', '⑤ 兜底时用橙色（提醒用户去填令牌）');

  env.api.setLoadSrc('api');
  ok(/GitHub API 兜底/.test(el.textContent), '⑤ api → 提示走 GitHub API 兜底', el.textContent);

  env.api.setLoadSrc('');
  eq(el.textContent, '', '⑤ 空值 → 清空这行');

  /* fetchAll 走完要真的把来源写进面板 */
  const el2 = { textContent: '', style: {} };
  const env2 = makeEnv({
    els: { cloudSrcLine: el2 },
    fetch: () => ({ status: 200, json: { ok: true, hasMore: false, nextSince: 5,
      rows: [row('a', 'collection', 5, { data: { _id: 'a', _upd: 5 } })] } }),
  });
  env2.api.fetchAll('collection', () => {});
  await flush();
  ok(/Cloudflare/.test(el2.textContent), '⑤ ★ 加载完成后面板自动显示数据来源', el2.textContent);
  sectionEnd();
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(56));
if (fail) {
  console.log('失败 %d 项：', fail);
  failures.forEach((f) => console.log('  ✗ ' + f));
  console.log('通过 %d / 失败 %d', pass, fail);
  process.exit(1);
}
console.log('通过 %d / 失败 %d', pass, fail);
console.log('全部通过 ✅');
