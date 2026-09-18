/* ============================================================
 * smoke_cloud_merge.mjs —— 「云 → 本地」下载合并这条路的本地冒烟测试
 * ------------------------------------------------------------
 * 覆盖三件事：
 *   ① cloudMergePlan()   字段并集合并（手机改状态 + 电脑改价格 都不能丢）
 *   ② cloudApplyPlan()   落地：新增 / 覆盖 / 删除 / 幂等
 *   ③ cloudPull()        翻页 + 「同一批 updated_at 相同」的重叠取回 + 水位线
 *
 * 手法和 smoke_isbn_client.mjs 一致：把 app.js 里那段源码**原文抠出来**
 * 用 new Function 跑，测的是真正要上线的代码，不是重写一遍的复刻品。
 *
 * 为什么这个测试必须存在：上传写错了最多云端多几条，本机毫发无伤；
 * 下载写错了是**直接改本机数据**，一个字段判断反了就是静默丢数据。
 *
 * 用法：
 *     node tools/smoke_cloud_merge.mjs
 * 证明「本测试真的会失败」（改坏一份副本再跑）：
 *     APP_PATH=_bugged_app.js node tools/smoke_cloud_merge.mjs
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const block = sliceBetween(
  "var CLOUD_DL_WM_KEY = 'lifedesk_cloud_dl_wm';", 'function addDataTools(){', '下载合并块');

console.log('抠出源码：下载合并块 %d 字节', block.length);

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

  const log = { status: [], toast: [], saves: [] };
  const store = opts.store || {};
  const GH = opts.GH || {};
  const MODE = opts.MODE || 'localfile';

  const cloudFetch = async (base, tok, path, o) => {
    log.fetch = log.fetch || [];
    log.fetch.push({ path, method: (o && o.method) || 'GET' });
    const r = opts.fetch ? await opts.fetch(path, o) : { status: 200, json: { ok: true } };
    if (r === 'THROW') throw new Error('模拟网络中断');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: r.json == null ? null : r.json, text: r.text || '' };
  };

  const factory = new Function(
    'localStorage', 'store', 'cloudFetch', 'cloudStatus', 'cloudBase', 'cloudToken',
    'cloudAsk', 'toast', 'render', 'queueLocalSave', 'localCacheSet', 'lsSet', 'GH', 'MODE',
    'var _cloudBusy = false;\n' + block + '\n' +
    'return { cloudMergePlan:cloudMergePlan, cloudApplyPlan:cloudApplyPlan, cloudPull:cloudPull,' +
    ' mergeLoadData:mergeLoadData,' +
    ' cloudDlWatermark:cloudDlWatermark, setCloudDlWatermark:setCloudDlWatermark,' +
    ' cloudTombstoneMap:cloudTombstoneMap, reset:function(){ _cloudTombs=null; _cloudConflicts=[]; },' +
    ' conflicts:function(){ return _cloudConflicts; } };'
  );

  const api = factory(
    localStorage, store, cloudFetch,
    (m, c) => log.status.push(String(m)),
    () => 'https://example.test',
    () => 'TOKEN',
    async () => true,
    (m) => log.toast.push(String(m)),
    () => log.saves.push('render'),
    () => log.saves.push('queueLocalSave'),
    () => log.saves.push('localCacheSet'),
    (k) => log.saves.push('lsSet:' + k),
    GH, MODE
  );
  return { api, store, log, ls, lsStub: localStorage };
}

function mkStore(rows) {
  return { collection: { rows: rows.slice(), status: rows.length ? 'ok' : 'empty' } };
}

/* ============================================================
 * ① cloudMergePlan —— 字段并集
 * ============================================================ */
section('① cloudMergePlan 字段并集');

{
  const env = makeEnv({ store: mkStore([]) });
  const p = env.api.cloudMergePlan({ id:'l_1', module:'collection', updated_at:1000, data:{ _id:'l_1', 名称:'活着', _upd:900 } });
  ok(p.act === 'insert', '① 本地没有 → insert', p.act);
  eq(p.out.名称, '活着', '① insert 带上名称');
  eq(p.out._id, 'l_1', '① insert 强制写回 _id');
  eq(p.out._upd, 900, '① insert 用 data._upd');
}

{
  const local = { _id:'l_2', 名称:'活着', 价格:50, _upd:900, _rev:3 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_2', module:'collection', rev:3, updated_at:1000, data:{ _id:'l_2', 名称:'活着', 价格:50, _upd:900, _rev:3 } });
  ok(p.act === 'same', '② 一模一样 → same', p.act);
  eq(env.api.conflicts().length, 0, '② 无冲突');
}

/* ★ 核心场景：手机加了「状态」，电脑改了「价格」且电脑更新 —— 两边都不能丢 */
{
  const local = { _id:'l_3', 名称:'活着', 价格:60, _upd:2000, _rev:5 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({
    id:'l_3', module:'collection', rev:2, updated_at:1500,
    data:{ _id:'l_3', 名称:'活着', 状态:'在读', _upd:1000, _rev:2 },
  });
  ok(p.act === 'update', '③ 手机加字段 + 电脑改字段 → update', p.act);
  eq(p.out.状态, '在读', '③ ★ 手机加的「状态」保住了');
  eq(p.out.价格, 60, '③ ★ 电脑改的「价格」没被云端旧值盖掉');
  eq(env.api.conflicts().length, 0, '③ 这不算冲突（不同字段）');
}

/* 反过来：电脑更新，云端只带了状态，云端没有价格 → 价格并集保留 */
{
  const local = { _id:'l_4', 名称:'活着', _upd:500 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({
    id:'l_4', module:'collection', updated_at:2000,
    data:{ _id:'l_4', 名称:'活着', 状态:'想读', _upd:2000 },
  });
  ok(p.act === 'update', '④ 云端更新 → update');
  eq(p.out.状态, '想读', '④ 取云端的状态');
  eq(p.out.名称, '活着', '④ 本地独有字段保留');
}

/* 真冲突：两边都改了「价格」 */
{
  const local = { _id:'l_5', 名称:'活着', 价格:60, _upd:2000 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_5', module:'collection', updated_at:1500, data:{ _id:'l_5', 价格:55, _upd:1000 } });
  eq(p.out.价格, 60, '⑤ 同字段冲突，本机较新 → 本机赢');
  ok(env.api.conflicts().length === 1, '⑤ 冲突被记下来', String(env.api.conflicts().length));
  eq(env.api.conflicts()[0].fields, ['价格'], '⑤ 冲突字段名是「价格」');
}
{
  const local = { _id:'l_6', 名称:'活着', 价格:60, _upd:1000 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_6', module:'collection', updated_at:2000, data:{ _id:'l_6', 价格:55, _upd:2000 } });
  eq(p.out.价格, 55, '⑥ 同字段冲突，云端较新 → 云端赢');
  ok(env.api.conflicts().length === 1, '⑥ 冲突仍然被记下来');
}

/* null 不算「改过」，不该报冲突 */
{
  const local = { _id:'l_7', 名称:'活着', 状态:null, _upd:1000 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_7', module:'collection', updated_at:2000, data:{ _id:'l_7', 状态:'在读', _upd:2000 } });
  eq(p.out.状态, '在读', '⑦ 本机空值 → 取云端值');
  eq(env.api.conflicts().length, 0, '⑦ 空值 vs 有值 不算冲突');
}

/* _upd / _rev 取两边最大值 */
{
  const local = { _id:'l_8', 名称:'活着', _upd:1000, _rev:7 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_8', module:'collection', rev:2, updated_at:2000, data:{ _id:'l_8', 作者:'余华', _upd:2000, _rev:2 } });
  eq(p.out._upd, 2000, '⑧ _upd 取较大值');
  eq(p.out._rev, 7, '⑧ _rev 取较大值（本机 7 不被云端 2 打回去）');
}

/* 墓碑：本机删过的绝不复活 */
{
  const local = { _id:'l_9', 名称:'活着', _upd:1000 };
  const env = makeEnv({
    store: mkStore([local]),
    ls: { lifedesk_tombstones: JSON.stringify([{ id:'l_9', key:'collection', at: 5000 }]) },
  });
  const p = env.api.cloudMergePlan({ id:'l_9', module:'collection', updated_at:9000, data:{ _id:'l_9', 名称:'活着', _upd:9000 } });
  ok(p.act === 'skip', '⑨ 本机墓碑 → skip（不复活）', p.act);
  eq(env.store.collection.rows.length, 1, '⑨ 记录本身没被动');
}

/* 云端软删 */
{
  const local = { _id:'l_10', 名称:'活着', _upd:1000 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_10', module:'collection', deleted:true, updated_at:5000 });
  ok(p.act === 'del', '⑩ 云端已删 → del', p.act);
}
{
  const local = { _id:'l_11', 名称:'活着', _upd:9000 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_11', module:'collection', deleted:true, updated_at:5000 });
  ok(p.act === 'same', '⑪ 云端删了但本机更新 → 保留本机', p.act);
  ok(env.api.conflicts().length === 1, '⑪ 这种「删除 vs 编辑」也报出来');
}

/* 运行期字段 _file（ip/series 的目录分片位置标记）：本机没有就别带回来。
   2026-09-18 实测：D1 里有 8 条（2 ip + 6 series）带着它，
   并集会把它们全算成「有改动」，其实本机一切正常。 */
{
  const local = { _id:'l_12', IP名称:'宝可梦', _upd:1000, _rev:1 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({
    id:'l_12', module:'collection', updated_at:2000,
    data:{ _id:'l_12', IP名称:'宝可梦', _file:'ip/宝可梦-data.json', _upd:1000, _rev:1 },
  });
  ok(p.act === 'same', '⑬ ★ 云端多出的运行期 _file 不算「有改动」', p.act);
  ok(p.out && p.out._file === undefined, '⑬ 也不写回本机');
}
{
  /* localfile 模式本机也有 _file → 值相同，照旧 same，不能误判成冲突 */
  const local = { _id:'l_13', IP名称:'宝可梦', _file:'ip/宝可梦-data.json', _upd:1000, _rev:1 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({
    id:'l_13', module:'collection', updated_at:2000,
    data:{ _id:'l_13', IP名称:'宝可梦', _file:'ip/宝可梦-data.json', _upd:1000, _rev:1 },
  });
  ok(p.act === 'same', '⑭ 两边都有 _file 且相同 → same', p.act);
}
{
  /* 本机有、云端没有 → 并集保留（不能因为它在死键表里就把本机的删掉） */
  const local = { _id:'l_14', IP名称:'宝可梦', _file:'ip/宝可梦-data.json', _upd:2000, _rev:1 };
  const env = makeEnv({ store: mkStore([local]) });
  const p = env.api.cloudMergePlan({ id:'l_14', module:'collection', updated_at:1000, data:{ _id:'l_14', IP名称:'宝可梦', _upd:2000, _rev:1 } });
  ok(p.act === 'same', '⑮ 本机的 _file 云端没有 → 不动它', p.act);
}

/* 本机没有的模块 → 不动，也不炸 */
{
  const env = makeEnv({ store: mkStore([]) });
  const p = env.api.cloudMergePlan({ id:'x_1', module:'nonexistent', updated_at:1, data:{ _id:'x_1' } });
  ok(p.act === 'skip', '⑫ 未知模块 → skip', p.act);
  const p2 = env.api.cloudMergePlan({ module:'collection', data:{} });
  ok(p2.act === 'skip', '⑫ 没有 id → skip');
}

sectionEnd();

/* ============================================================
 * ② cloudApplyPlan —— 落地
 * ============================================================ */
section('② cloudApplyPlan 落地');

{
  const env = makeEnv({ store: mkStore([{ _id:'l_a', 名称:'旧', _upd:1 }]) });
  const api = env.api;
  const ins = api.cloudMergePlan({ id:'l_new', module:'collection', updated_at:100, data:{ _id:'l_new', 名称:'新', _upd:100 } });
  eq(api.cloudApplyPlan({ id:'l_new', module:'collection' }, ins), 'insert', '① apply insert');
  eq(env.store.collection.rows.length, 2, '① 行数 +1');
  eq(env.store.collection.rows[0]._id, 'l_new', '① 插到最前面');

  const upd = api.cloudMergePlan({ id:'l_a', module:'collection', updated_at:200, data:{ _id:'l_a', 名称:'新名', _upd:200 } });
  eq(api.cloudApplyPlan({ id:'l_a', module:'collection' }, upd), 'update', '② apply update');
  eq(env.store.collection.rows.length, 2, '② 行数不变');
  eq(env.store.collection.rows.filter(r => r._id === 'l_a')[0].名称, '新名', '② 字段被替换');

  const del = api.cloudMergePlan({ id:'l_a', module:'collection', deleted:true, updated_at:300 });
  eq(api.cloudApplyPlan({ id:'l_a', module:'collection' }, del), 'del', '③ apply del');
  eq(env.store.collection.rows.length, 1, '③ 行被删掉');

  /* 幂等：同一份方案再算一次，应该是 same */
  const again = api.cloudMergePlan({ id:'l_new', module:'collection', updated_at:100, data:{ _id:'l_new', 名称:'新', _upd:100 } });
  ok(again.act === 'same', '④ 幂等：合并过的再合一次是 same', again.act);
}

sectionEnd();

/* ============================================================
 * ③ cloudPull —— 翻页 / 重叠取回 / 水位线
 * ============================================================ */
section('③ cloudPull 翻页与水位线');

function fakeSyncDb(rows) {
  return (path) => {
    const m = /since=(\d+)/.exec(path);
    const since = Number(m ? m[1] : 0);
    const limit = 2000;
    const all = rows.filter(r => r.updated_at > since).sort((a, b) => a.updated_at - b.updated_at);
    const page = all.slice(0, limit);
    const nextSince = page.length ? page[page.length - 1].updated_at : since;
    return { status: 200, json: { ok:true, since, serverTime: Date.now(), hasMore: page.length >= limit, nextSince, count: page.length, rows: page } };
  };
}

/* 关键：服务端一次 batch 共用一个 updated_at。第 2000 行和后面 10 行时间戳相同，
   若翻页用 since=nextSince（严格大于）就会把后面那 10 行永久跳过。 */
{
  const rows = [];
  for (let i = 1; i <= 2000; i++) rows.push({ id:'r' + i, module:'collection', updated_at: i, data:{ _id:'r' + i, 名称:'书' + i, _upd: i } });
  for (let i = 2001; i <= 2010; i++) rows.push({ id:'r' + i, module:'collection', updated_at: 2000, data:{ _id:'r' + i, 名称:'书' + i, _upd: 2000 } });

  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb(rows) });
  await env.api.cloudPull(false);

  eq(env.store.collection.rows.length, 2010, '① ★ 时间戳相同的那 10 条也被取回（-1ms 重叠）');
  ok(env.api.cloudDlWatermark() === 2000, '① 水位线推进到 2000', String(env.api.cloudDlWatermark()));
  const noGuard = env.log.status.join(' ').indexOf('没能全部取回') < 0;
  ok(noGuard, '① 没有触发「取不完」告警');
}

/* 全部行时间戳完全相同 → 一定会取不完，必须明确告警而不是假装成功 */
{
  const rows = [];
  for (let i = 1; i <= 2100; i++) rows.push({ id:'s' + i, module:'collection', updated_at: 7777, data:{ _id:'s' + i, 名称:'书' + i, _upd: 7777 } });
  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb(rows) });
  await env.api.cloudPull(false);
  eq(env.store.collection.rows.length, 2000, '② 只取回一页');
  ok(env.log.status.join(' ').indexOf('没能全部取回') >= 0, '② ★ 明确告警，不假装成功');
}

/* 云端没有新内容 */
{
  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb([]) });
  await env.api.cloudPull(false);
  ok(env.log.toast.join(' ').indexOf('没有新内容') >= 0, '③ 空云端 → 提示没有新内容');
}

/* 401 不该推进水位线 */
{
  const env = makeEnv({ store: mkStore([]), fetch: () => ({ status: 401, json: { ok:false } }) });
  await env.api.cloudPull(false);
  ok(env.api.cloudDlWatermark() === 0, '④ 401 时不推进水位线', String(env.api.cloudDlWatermark()));
  ok(env.log.status.join(' ').indexOf('401') >= 0, '④ 状态栏报 401');
}

/* 网络中断不该推进水位线，也不该改数据 */
{
  const env = makeEnv({ store: mkStore([{ _id:'keep', 名称:'原样', _upd:1 }]), fetch: () => 'THROW' });
  await env.api.cloudPull(false);
  eq(env.store.collection.rows.length, 1, '⑤ 网络中断时本机数据没动');
  ok(env.api.cloudDlWatermark() === 0, '⑤ 网络中断时不推进水位线');
}

/* 增量：since 从水位线起算，旧记录不再重复取 */
{
  const rows = [{ id:'n1', module:'collection', updated_at: 100, data:{ _id:'n1', 名称:'A', _upd:100 } }];
  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb(rows) });
  await env.api.cloudPull(false);
  eq(env.api.cloudDlWatermark(), 100, '⑥ 水位线记到 100');
  const seen = env.log.fetch.map(f => f.path);
  ok(seen[0].indexOf('since=0') >= 0, '⑥ 第一次从 0 开始', seen[0]);

  /* 第二次：新记录 200 */
  rows.push({ id:'n2', module:'collection', updated_at: 200, data:{ _id:'n2', 名称:'B', _upd:200 } });
  await env.api.cloudPull(false);
  const seen2 = env.log.fetch.slice(1).map(f => f.path);
  ok(seen2[0].indexOf('since=100') >= 0, '⑥ 第二次从水位线 100 起算', seen2[0]);
  eq(env.store.collection.rows.length, 2, '⑥ 两条都在');
}

/* 全量下载忽略水位线 */
{
  const rows = [{ id:'f1', module:'collection', updated_at: 100, data:{ _id:'f1', 名称:'A', _upd:100 } }];
  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb(rows), ls: { lifedesk_cloud_dl_wm: '999999' } });
  await env.api.cloudPull(true);
  const p = env.log.fetch[0].path;
  ok(p.indexOf('since=0') >= 0, '⑦ 全量下载从 0 起算（忽略水位线）', p);
}

sectionEnd();

/* ============================================================
 * ④ 水位线键必须和上传的分开
 * ============================================================ */
section('④ 上传 / 下载水位线互不干扰');

{
  const env = makeEnv({ store: mkStore([]), fetch: fakeSyncDb([]) });
  env.api.setCloudDlWatermark(12345);
  ok(env.api.cloudDlWatermark() === 12345, '① 下载水位线能存能取');
  const dump = env.lsStub._dump();
  ok(Object.prototype.hasOwnProperty.call(dump, 'lifedesk_cloud_dl_wm'), '① 用的是 lifedesk_cloud_dl_wm');
  ok(!Object.prototype.hasOwnProperty.call(dump, 'lifedesk_cloud_wm'), '① ★ 没碰上传的 lifedesk_cloud_wm');
}

sectionEnd();

/* ============================================================
 * ⑤ 墓碑解析
 * ============================================================ */
section('⑤ 墓碑解析');

{
  const env = makeEnv({
    store: mkStore([]),
    ls: { lifedesk_tombstones: JSON.stringify([{ id:1, at:5 }, { id:'a', at:6 }, null, { at:7 }]) },
  });
  const m = env.api.cloudTombstoneMap();
  eq(Object.keys(m).sort(), ['1', 'a'], '① 只认有 id 的，id 统一转字符串');
  eq(m['a'], 6, '① at 被读出来');
}
{
  const env = makeEnv({ store: mkStore([]), ls: { lifedesk_tombstones: '{{坏 JSON' } });
  eq(env.api.cloudTombstoneMap(), {}, '② 坏 JSON 不炸，返回空表');
}

sectionEnd();

/* ============================================================
 * ⑥ mergeLoadData —— 刷新加载时的并集（根治「手机录完刷新即丢」）
 *   这是 gh 模式加载路径 ② 真正调用的函数：把「本机 IndexedDB 快照」
 *   和「从仓库拉回的 st」并起来，绝不能让 st 整份覆盖 local。
 * ============================================================ */
section('⑥ mergeLoadData 刷新并集');

const env = makeEnv({});   /* mergeLoadData 是纯函数，不需要 store / 快照 */

{
  /* ★ 核心：本机有手机刚录、没推的；云端没有这条 → 必须保本机 */
  const local = { collection: [ { _id:'l_phone', 名称:'手机刚录的书', 价格:39, _upd:5000, _rev:1 } ] };
  const cloud = { collection: [ { _id:'l_old', 名称:'旧书', _upd:100, _rev:1 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq((out.collection || []).length, 2, '① ★ 手机录的书 + 云端旧书 都在（没被覆盖掉）');
  ok((out.collection || []).some(r => r._id === 'l_phone'), '① ★ 手机录的 l_phone 存活');
  ok((out.collection || []).some(r => r._id === 'l_old'), '① 云端旧书也补进来了');
}
{
  /* 反过来：云端有新增、本机没有 → 取云端 */
  const local = { collection: [] };
  const cloud = { collection: [ { _id:'l_new', 名称:'桌面推的新书', _upd:9000, _rev:1 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq(out.collection.length, 1, '② 云端新增被拉进本机');
  eq(out.collection[0]._id, 'l_new', '② id 正确');
}
{
  /* 两边都有、云端更新 → 云端赢（手机拿到桌面的最新改动） */
  const local = { collection: [ { _id:'l_b', 名称:'书B', 价格:50, _upd:100 } ] };
  const cloud = { collection: [ { _id:'l_b', 名称:'书B', 价格:88, _upd:9000 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq(out.collection[0].价格, 88, '③ 云端更新的「价格」覆盖本机旧值');
  eq(out.collection[0]._upd, 9000, '③ _upd 取较大值');
}
{
  /* 两边都有、本机更新（手机刚改过）→ 本机赢，云端旧值不回灌 */
  const local = { collection: [ { _id:'l_c', 名称:'书C', 状态:'在读', _upd:9000 } ] };
  const cloud = { collection: [ { _id:'l_c', 名称:'书C', 状态:'想读', _upd:100 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq(out.collection[0].状态, '在读', '④ ★ 手机改的「状态」没被云端旧值盖掉');
}
{
  /* 字段并集：手机加的字段 + 云端加的字段 都留着（同 cloudMergePlan 的根） */
  const local = { collection: [ { _id:'l_d', 名称:'书D', 状态:'在读', _upd:2000 } ] };
  const cloud = { collection: [ { _id:'l_d', 名称:'书D', 价格:60, _upd:1000 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq(out.collection[0].状态, '在读', '⑤ 手机独有的是状态 → 留');
  eq(out.collection[0].价格, 60, '⑤ 云端独有的是价格 → 留');
}
{
  /* 运行期字段 _file：本机没有就别带回来（和 cloudMergePlan 一致） */
  const local = { ip: [ { _id:'l_ip', IP名称:'宝可梦', _upd:1000 } ] };
  const cloud = { ip: [ { _id:'l_ip', IP名称:'宝可梦', _file:'ip/宝可梦-data.json', _upd:2000 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  ok(out.ip[0]._file === undefined, '⑥ 云端多出的 _file 不写回本机', JSON.stringify(out.ip[0]));
  eq(out.ip[0]._upd, 2000, '⑥ 但 _upd 仍是云端的较新值');
}
{
  /* 幂等：merged 再跟同一个 cloud 合并，行数不翻倍、字段不变 */
  const local = { collection: [ { _id:'l_e', 名称:'书E', _upd:100 } ] };
  const cloud = { collection: [ { _id:'l_e', 名称:'书E（云端更新）', _upd:5000 } ] };
  const once = env.api.mergeLoadData(local, cloud);
  const twice = env.api.mergeLoadData(once, cloud);
  eq(twice.collection.length, 1, '⑦ 幂等：行数不翻倍');
  eq(twice.collection[0].名称, '书E（云端更新）', '⑦ 字段幂等稳定');
}
{
  /* 多模块：collection + study 各管各的，互不串 */
  const local = { collection: [ { _id:'c1', 名称:'c', _upd:1 } ], study: [ { _id:'s1', 标题:'计划', _upd:1 } ] };
  const cloud = { collection: [ { _id:'c2', 名称:'c2', _upd:1 } ] };
  const out = env.api.mergeLoadData(local, cloud);
  eq(out.collection.length, 2, '⑧ collection 两行');
  eq(out.study.length, 1, '⑧ study 一行没被吞');
  eq(out.study[0]._id, 's1', '⑧ study 的 s1 在');
}
{
  /* 空本机（首次访问）→ 直接等于云端，不炸 */
  const out = env.api.mergeLoadData({}, { collection: [ { _id:'x', 名称:'x', _upd:1 } ] });
  eq(out.collection.length, 1, '⑨ 空本机 → 取云端');
  /* 空云端 → 直接等于本机 */
  const out2 = env.api.mergeLoadData({ collection: [ { _id:'y', 名称:'y', _upd:1 } ] }, {});
  eq(out2.collection.length, 1, '⑨ 空云端 → 保本机');
}

sectionEnd();

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(56));
console.log('通过 %d / 失败 %d', pass, fail);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
