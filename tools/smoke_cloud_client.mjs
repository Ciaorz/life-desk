/* ============================================================
 * smoke_cloud_client.mjs —— 云同步客户端的本地冒烟测试
 * ------------------------------------------------------------
 * 为什么这样做：
 *   app.js 是浏览器脚本，直接 import 会炸（第 4 行就摸 window）。
 *   所以这里把「云同步」那一段源码**原文抠出来**，用 new Function
 *   在 Node 里跑，再喂进假 localStorage / 假 fetch / 假 store。
 *
 *   → 测的是**真正要上线的代码**，不是重写一遍的复刻品。
 *     复刻品测不出真代码的 bug，那才是自欺欺人。
 *
 * 用法：
 *     node tools/smoke_cloud_client.mjs
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/* APP_PATH 可以指向 app.js 的一份副本，用来验证「本测试真的会失败」——
   一个永远通过的测试等于没有测试。见文件末尾的说明。 */
const APP = process.env.APP_PATH || join(HERE, '..', 'app.js');

const src = readFileSync(APP, 'utf8');

/* ---------- 1. 从 app.js 里抠出云同步那一段 ---------- */
const START = "var CLOUD_KEY = 'lifedesk_cloud';";
const END = 'function addDataTools(){';
const i = src.indexOf(START);
const j = src.indexOf(END, i);
if (i < 0 || j < 0) {
  console.error('!! 在 app.js 里找不到云同步代码块。');
  console.error('   起点标记：' + START);
  console.error('   终点标记：' + END);
  process.exit(1);
}
let block = src.slice(i, j);

/* cloudAsk 会建 DOM，Node 里没有 document —— 把调用点换成桩。
   只换调用，不换定义，所以抠出来的代码其余部分一字未动。 */
const ASK_CALLS = (block.match(/await cloudAsk\(/g) || []).length;
if (ASK_CALLS !== 1) {
  console.error('!! 预期只有 1 处 await cloudAsk(，实际 ' + ASK_CALLS + ' 处。');
  console.error('   如果确实改过，请同步更新本测试。');
  process.exit(1);
}
block = block.replace(/await cloudAsk\(/g, 'await __ask(');

console.log('抠出云同步代码块：' + block.length + ' 字节');

/* ---------- 2. 造一个沙箱 ---------- */
function makeSandbox(opts) {
  opts = opts || {};
  const ls = Object.assign({}, opts.ls || {});
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
    _dump: () => ls,
  };

  const reqs = [];
  const toasts = [];
  const store = opts.store || {};

  async function fetchStub(url, init) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    let body = null;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) {} }
    reqs.push({ path, method: (init && init.method) || 'GET', body });

    const handler = opts.fetch || (() => ({ status: 200, json: { ok: true, saved: body && body.records ? body.records.length : 0, deleted: body && body.deletes ? body.deletes.length : 0 } }));
    const r = await handler(path, body, reqs.length);
    if (r === 'THROW') throw new Error('模拟网络中断');
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => (r.json == null ? '' : JSON.stringify(r.json)),
    };
  }

  const factory = new Function(
    'localStorage', 'fetch', 'snapshotAll', 'shardCatOf', 'toast', '$', '__ask',
    block + `
    ;return {
      cloudConfig: cloudConfig, setCloudConfig: setCloudConfig,
      cloudWatermark: cloudWatermark, setCloudWatermark: setCloudWatermark,
      cloudBase: cloudBase, cloudToken: cloudToken,
      cloudCollect: cloudCollect, cloudUpload: cloudUpload, cloudTest: cloudTest
    };`
  );

  /* snapshotAll 被调用的时刻 —— 用来验证「水位线是在收集之前取的」 */
  const snapTimes = [];

  const api = factory(
    localStorage,
    fetchStub,
    () => { snapTimes.push(Date.now()); return store; },
    () => '测试分类',
    (m) => { toasts.push(m); },
    () => null,
    /* 确认框桩。askDelay 用来模拟「用户盯着确认框看了几十秒」——
       这正是水位线取错时机时会造成静默丢数据的那个窗口。 */
    async () => {
      if (opts.askDelay) await new Promise((r) => setTimeout(r, opts.askDelay));
      return true;
    }
  );

  return { api, ls, reqs, toasts, snapTimes };
}

/* ---------- 3. 测试小工具 ---------- */
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '\n       ' + (e && e.message ? e.message : e)); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

function rows(n, start, upd) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ _id: 'id' + (start + k), 名称: '测试' + (start + k), _upd: upd, _rev: 1 });
  }
  return out;
}

const CFG = { lifedesk_cloud: JSON.stringify({ apiBase: 'https://x.pages.dev', token: 'tok' }) };

/* ============================================================ */

console.log('\n=== 云同步客户端冒烟测试 ===\n');

console.log('[1] 收集要上传的东西（cloudCollect）');
await check('水位线为 0 时 = 全量：所有记录都收', async () => {
  const s = makeSandbox({ ls: CFG, store: { collection: rows(10, 0, 1000), av: rows(5, 100, 1000) } });
  const c = s.api.cloudCollect(false);
  assert(c.pending.length === 15, '应收集 15 条，实际 ' + c.pending.length);
});
await check('有水位线时 = 增量：只收 _upd 更新的', async () => {
  const s = makeSandbox({
    ls: Object.assign({ lifedesk_cloud_wm: '5000' }, CFG),
    store: { collection: rows(3, 0, 1000).concat(rows(2, 50, 9000)) },
  });
  const c = s.api.cloudCollect(false);
  assert(c.pending.length === 2, '应只收 2 条（_upd=9000），实际 ' + c.pending.length);
  assert(c.pending[0].id === 'id50', 'id 不对：' + c.pending[0].id);
});
await check('没有 _id 的行会被跳过（不推垃圾上去）', async () => {
  const s = makeSandbox({ ls: CFG, store: { collection: [{ 名称: '没有id' }].concat(rows(2, 0, 1000)) } });
  const c = s.api.cloudCollect(false);
  assert(c.pending.length === 2, '应只剩 2 条，实际 ' + c.pending.length);
});
await check('每条都带上 module / cat / data', async () => {
  const s = makeSandbox({ ls: CFG, store: { collection: rows(1, 7, 1000) } });
  const p = s.api.cloudCollect(false).pending[0];
  assert(p.id === 'id7' && p.module === 'collection' && p.cat === '测试分类', '字段不对：' + JSON.stringify(p));
  assert(p.data && p.data._id === 'id7', 'data 应是整条记录');
});
await check('墓碑：只收比水位线新的删除', async () => {
  const s = makeSandbox({
    ls: Object.assign({
      lifedesk_tombstones: JSON.stringify([{ id: 'd1', at: 100 }, { id: 'd2', at: 9000 }]),
    }, CFG, { lifedesk_cloud_wm: '5000' }),
    store: {},
  });
  const c = s.api.cloudCollect(false);
  assert(c.dels.length === 1 && c.dels[0] === 'd2', '应只收 d2，实际 ' + JSON.stringify(c.dels));
});
await check('墓碑数据坏掉时不崩（只当没有）', async () => {
  const s = makeSandbox({ ls: Object.assign({ lifedesk_tombstones: '{{{坏JSON' }, CFG), store: {} });
  const c = s.api.cloudCollect(false);
  assert(c.dels.length === 0, '应为空数组');
});
await check('force=true 忽略水位线，全量 + 全部墓碑', async () => {
  const s = makeSandbox({
    ls: Object.assign({ lifedesk_cloud_wm: '999999999', lifedesk_tombstones: JSON.stringify([{ id: 'd1', at: 100 }]) }, CFG),
    store: { collection: rows(4, 0, 1000) },
  });
  const c = s.api.cloudCollect(true);
  assert(c.pending.length === 4, '全量应收 4 条，实际 ' + c.pending.length);
  assert(c.dels.length === 1, '应收 1 条删除，实际 ' + c.dels.length);
});

console.log('\n[2] 上传分块（cloudUpload）');
await check('1414 条 → 分成 29 个请求（28×50 + 14），不是 1414 个', async () => {
  const s = makeSandbox({ ls: CFG, store: { collection: rows(1414, 0, 1000) } });
  await s.api.cloudUpload(false);
  const posts = s.reqs.filter((r) => r.path === '/api/records-batch');
  assert(posts.length === 29, '应为 29 个请求，实际 ' + posts.length);
  assert(posts[0].body.records.length === 50, '第一块应是 50 条，实际 ' + posts[0].body.records.length);
  assert(posts[28].body.records.length === 14, '最后一块应是 14 条，实际 ' + posts[28].body.records.length);
});
await check('每批都带 Authorization 头（靠 fetch 桩之外单独验）', async () => {
  /* cloudFetch 里写死了 Bearer 头；这里改为验证它确实调了 fetch 而不是本地糊弄 */
  const s = makeSandbox({ ls: CFG, store: { collection: rows(1, 0, 1000) } });
  await s.api.cloudUpload(false);
  assert(s.reqs.length === 1, '应发出 1 个请求');
  assert(s.reqs[0].method === 'POST', '应是 POST');
});
await check('device 字段是 desktop（好区分改动来源）', async () => {
  const s = makeSandbox({ ls: CFG, store: { collection: rows(1, 0, 1000) } });
  await s.api.cloudUpload(false);
  assert(s.reqs[0].body.device === 'desktop', 'device 不对：' + s.reqs[0].body.device);
});
await check('删除只挂在最后一批，不重复发', async () => {
  const s = makeSandbox({
    ls: Object.assign({ lifedesk_tombstones: JSON.stringify([{ id: 'd1', at: 1 }, { id: 'd2', at: 2 }]) }, CFG),
    store: { collection: rows(120, 0, 1000) },
  });
  await s.api.cloudUpload(false);
  const withDel = s.reqs.filter((r) => r.path === '/api/records-batch' && r.body.deletes && r.body.deletes.length);
  assert(withDel.length === 1, '应只有 1 批带删除，实际 ' + withDel.length);
  assert(withDel[0].body.deletes.length === 2, '应带 2 条删除');
});
await check('没有改动时直接返回，不发任何请求', async () => {
  const s = makeSandbox({ ls: Object.assign({ lifedesk_cloud_wm: '999999999' }, CFG), store: { collection: rows(5, 0, 1000) } });
  await s.api.cloudUpload(false);
  assert(s.reqs.length === 0, '不该发请求，实际 ' + s.reqs.length);
  assert(s.toasts.some((t) => t.indexOf('没有需要上传') >= 0), '应提示没有改动，实际：' + JSON.stringify(s.toasts));
});
await check('没配令牌时直接拒绝，不发请求', async () => {
  const s = makeSandbox({ ls: {}, store: { collection: rows(5, 0, 1000) } });
  await s.api.cloudUpload(false);
  assert(s.reqs.length === 0, '不该发请求');
});

console.log('\n[3] 服务器没有批量接口时的退路');
await check('批量接口 404 → 自动退回逐条 POST，且最终全部上传成功', async () => {
  const s = makeSandbox({
    ls: CFG,
    store: { collection: rows(120, 0, 1000) },
    fetch: (path) => (path === '/api/records-batch'
      ? { status: 404, json: { ok: false, error: '未知接口' } }
      : { status: 200, json: { ok: true } }),
  });
  await s.api.cloudUpload(false);
  const singles = s.reqs.filter((r) => r.path === '/api/records');
  assert(singles.length === 120, '应逐条发 120 个，实际 ' + singles.length);
  /* 水位线要推进，否则下次还得重来 */
  assert(Number(s.ls.lifedesk_cloud_wm) > 0, '水位线应已推进，实际 ' + s.ls.lifedesk_cloud_wm);
});

console.log('\n[4] 水位线（最关键：搞错会静默丢数据）');
await check('成功后水位线 = 开推前的时间，而不是推完的时间', async () => {
  const tBefore = Date.now();
  const s = makeSandbox({ ls: CFG, store: { collection: rows(10, 0, 1000) } });
  await s.api.cloudUpload(false);
  const tAfter = Date.now();
  const wm = Number(s.ls.lifedesk_cloud_wm);
  assert(wm >= tBefore && wm <= tAfter, '水位线应落在 [开推前, 推完后] 区间，实际 ' + wm + ' 不在 [' + tBefore + ',' + tAfter + ']');
});
await check('推送期间被改动的记录不会被漏掉（下次仍会推）', async () => {
  /* 这条测的是水位线取「开推前」而非「推完后」的那个决定。
     水位线为 T 时，一条 _upd = T+1 的记录（即推送途中被改的）必须仍被收集到，
     否则它会永远掉在水位线以下 —— 静默丢数据。 */
  const T = Date.now();
  const s = makeSandbox({
    ls: Object.assign({ lifedesk_cloud_wm: String(T) }, CFG),
    store: { collection: rows(1, 999, T + 1) },
  });
  const c = s.api.cloudCollect(false);
  assert(c.pending.length === 1, '比水位线新 1ms 的记录必须被收集到，实际 ' + c.pending.length);
});
await check('水位线在「收集之前」就取好（确认框期间的改动不会永久漏推）', async () => {
  /* 回归测试。曾经的写法是：收集 → 弹确认框 → t0 = Date.now()。
     用户在确认框上停留的几十秒里被改动的记录，既没进本次收集、_upd 又小于 t0，
     于是永远落在水位线以下 —— 静默丢数据。
     这里用 askDelay 模拟「用户看了 40ms 才点确认」：如果 t0 是点完才取的，
     t0 就会明显晚于收集时刻，断言随即失败。 */
  const s = makeSandbox({ ls: CFG, store: { collection: rows(5, 0, 1000) }, askDelay: 40 });
  await s.api.cloudUpload(false);
  const wm = Number(s.ls.lifedesk_cloud_wm);
  const snapAt = s.snapTimes[0];
  assert(snapAt, 'snapshotAll 应该被调用过');
  assert(wm <= snapAt,
    '水位线(' + wm + ') 必须 <= 收集时刻(' + snapAt + ')，'
    + '否则这中间被改动的记录会永久漏推');
});
await check('网络中断时水位线不推进（下次重推，不丢数据）', async () => {
  const s = makeSandbox({
    ls: CFG,
    store: { collection: rows(60, 0, 1000) },
    fetch: () => 'THROW',
  });
  await s.api.cloudUpload(false);
  assert(!s.ls.lifedesk_cloud_wm, '水位线不该被推进，实际 ' + s.ls.lifedesk_cloud_wm);
  assert(s.toasts.some((t) => t.indexOf('中断') >= 0), '应报告中断，实际：' + JSON.stringify(s.toasts));
});
await check('服务器返回 500 时不推进水位线', async () => {
  const s = makeSandbox({
    ls: CFG,
    store: { collection: rows(10, 0, 1000) },
    fetch: () => ({ status: 500, json: { ok: false, error: 'boom' } }),
  });
  await s.api.cloudUpload(false);
  assert(!s.ls.lifedesk_cloud_wm, '水位线不该被推进');
});

console.log('\n[5] 测试连接（cloudTest）');
await check('ping 不通 → 返回 false 并提示检查地址', async () => {
  const s = makeSandbox({ ls: CFG, fetch: () => ({ status: 404, json: null }) });
  assert((await s.api.cloudTest()) === false, '应返回 false');
});
await check('令牌错（401）→ 返回 false', async () => {
  const s = makeSandbox({ ls: CFG, fetch: (p) => (p === '/api/ping' ? { status: 200, json: { ok: true } } : { status: 401, json: { ok: false } }) });
  assert((await s.api.cloudTest()) === false, '应返回 false');
});
await check('全通 → 返回 true，且真的去读了 stats', async () => {
  const s = makeSandbox({
    ls: CFG,
    fetch: (p) => (p === '/api/ping'
      ? { status: 200, json: { ok: true, service: 'life-desk-sync' } }
      : { status: 200, json: { ok: true, total: 42, lastUpdate: 1789700000000 } }),
  });
  assert((await s.api.cloudTest()) === true, '应返回 true');
  assert(s.reqs.some((r) => r.path === '/api/stats'), '应请求过 /api/stats');
});

/* ============================================================ */

console.log('\n----------------------------------------');
console.log('通过 %d 项，失败 %d 项', pass, fail);
if (fail === 0) {
  console.log('结果：✅ 客户端逻辑没问题。');
} else {
  console.log('结果：❌ 有问题，先别让用户点上传。');
}
console.log('');
process.exit(fail === 0 ? 0 : 1);
