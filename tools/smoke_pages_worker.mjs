/* ============================================================
 * smoke_pages_worker.mjs —— 部署前的本地冒烟测试
 * ------------------------------------------------------------
 * 为什么需要它：
 *   cloud/pages-upload/_worker.js 是要拖到 Cloudflare 上的东西，
 *   本机没有 Workers 运行时，跑不起来 → 部署完才发现问题是常态。
 *   这里用 Node 直接 import 那个文件，喂假 env（假 D1 / 假 R2），
 *   把关键路径都打一遍。**它只能验证逻辑和路由，不能验证真绑定。**
 *
 * 用法：
 *     node tools/smoke_pages_worker.mjs
 *
 * 通过的话，再拖到 Cloudflare；不通过就别拖，先修。
 * ============================================================ */

import worker from '../cloud/pages-upload/_worker.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, '..', 'cloud', 'pages-upload', 'index.html');

const TOKEN = 'test-token-123';

/* ---------- 假的 D1：只认得出 SQL 的意图，不真查 ---------- */
function fakeD1() {
  const calls = [];
  const batches = [];
  return {
    calls,
    batches,
    prepare(sql) {
      const stmt = {
        sql,
        binds: [],
        bind(...b) { stmt.binds = b; return stmt; },
        async all() {
          if (/GROUP BY module/i.test(sql)) {
            return { results: [{ module: 'collection', n: 3 }, { module: 'media', n: 2 }] };
          }
          return { results: [] };
        },
        async first() {
          if (/MAX\(updated_at\)/i.test(sql)) return { n: 5, last: 1789700000000 };
          return null;
        },
        async run() { return { success: true }; },
      };
      calls.push(stmt);
      return stmt;
    },
    async batch(stmts) {
      batches.push(stmts);
      return stmts.map(() => ({ success: true }));
    },
  };
}

/* ---------- 假的 R2 ---------- */
function fakeR2() {
  const puts = [];
  return {
    puts,
    async get() { return null; },
    async put(k, v) { puts.push(k); },
  };
}

/* ---------- 假的静态资源（Pages 的 ASSETS 绑定） ---------- */
/* 注意：必须是「每次新建一个」，不能共用一个模块级对象 ——
   否则 calls 计数会跨测试累加，第二个测试永远失败（踩过）。 */
function makeAssets() {
  return {
    calls: 0,
    async fetch(req) {
      this.calls++;
      return new Response('<html>index</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

function makeEnv() {
  return { DB: fakeD1(), IMG: fakeR2(), SYNC_TOKEN: TOKEN, ASSETS: makeAssets() };
}

/* ---------- 测试小工具 ---------- */
let pass = 0, fail = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log('  ✅ ' + name);
    pass++;
  } catch (e) {
    console.log('  ❌ ' + name + '\n       ' + (e && e.message ? e.message : e));
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function call(env, path, opts = {}) {
  const req = new Request('https://life-desk-api.pages.dev' + path, opts);
  return worker.fetch(req, env, {});
}

/* ============================================================ */

console.log('\n=== 冒烟测试：cloud/pages-upload/_worker.js ===\n');

console.log('[1] 健康检查（不需要令牌）');
await check('/api/ping 返回 ok:true', async () => {
  const r = await call(makeEnv(), '/api/ping');
  assert(r.status === 200, '状态码应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true, 'ok 应为 true');
  assert(j.service === 'life-desk-sync', 'service 名字不对：' + j.service);
});

console.log('\n[2] 认证（REQUIRE_READ_AUTH = true，读也要令牌）');
await check('/api/stats 不带令牌 → 401', async () => {
  const r = await call(makeEnv(), '/api/stats');
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('/api/stats 带错令牌 → 401', async () => {
  const r = await call(makeEnv(), '/api/stats', { headers: { authorization: 'Bearer wrong' } });
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('401 响应也带 CORS 头（否则手机端只会看到 CORS 报错）', async () => {
  const r = await call(makeEnv(), '/api/stats');
  assert(r.headers.get('access-control-allow-origin') === '*', '缺 CORS 头');
});
await check('/api/img 的【读】刻意免认证（封面是 CSS 背景图，带不了 Authorization 头）', async () => {
  const r = await call(makeEnv(), '/api/img/data/thumbs/%E5%BE%BD%E7%AB%A0/a.webp');
  assert(r.status !== 401, '不该是 401（否则手机端封面会全裂），实际 ' + r.status);
  assert(r.status === 404, '假 R2 里没这个对象 → 应为 404，实际 ' + r.status);
});
await check('HEAD /api/img 同样免认证', async () => {
  const r = await call(makeEnv(), '/api/img/data/thumbs/x/a.webp', { method: 'HEAD' });
  assert(r.status !== 401, 'HEAD 也不该 401，实际 ' + r.status);
});
await check('★ PUT /api/img 不带令牌 → 401（写操作一个都不能松）', async () => {
  const r = await call(makeEnv(), '/api/img/data/thumbs/x/a.webp', { method: 'PUT', body: 'x' });
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('★ POST /api/img 不带令牌 → 401', async () => {
  const r = await call(makeEnv(), '/api/img/data/thumbs/x/a.webp', { method: 'POST', body: 'x' });
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('★ /api/img-batch 不带令牌 → 401（别被 /api/img 的读豁免误伤）', async () => {
  const r = await call(makeEnv(), '/api/img-batch', { method: 'POST', body: '{"items":[]}' });
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('★ 读的 key 必须是 data/images|thumbs 开头（不许当开放代理）', async () => {
  const env = makeEnv();
  for (const bad of ['/api/img/etc/passwd', '/api/img/data/other/a.webp', '/api/img/', '/api/img/data/images']) {
    const r = await call(env, bad);
    assert(r.status === 400, bad + ' 应被拒（400），实际 ' + r.status);
  }
});
await check('带令牌 PUT /api/img → ok:true 且真的写进 R2', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/img/data/thumbs/x/a.webp', {
    method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body: 'fake-bytes',
  });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true, 'ok 应为 true');
  assert(env.IMG.puts.includes('data/thumbs/x/a.webp'), 'R2 没收到这个 key：' + JSON.stringify(env.IMG.puts));
});
await check('带令牌 /api/img-batch 但 key 非法 → 拒绝（令牌泄露也写不进任意 key）', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/img-batch', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ items: [{ key: 'evil/x.bin', data: 'AAAA' }] }),
  });
  assert(r.status === 400, '应为 400，实际 ' + r.status);
  assert(env.IMG.puts.length === 0, '不该写进 R2：' + JSON.stringify(env.IMG.puts));
});
await check('带令牌 /api/img-batch 且 key 合法 → 写入成功', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/img-batch', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ items: [{ key: 'data/thumbs/x/a.webp', data: 'AAAA', type: 'image/webp' }] }),
  });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.uploaded === 1, 'uploaded 应为 1，实际 ' + j.uploaded);
  assert(env.IMG.puts.includes('data/thumbs/x/a.webp'), 'R2 没收到这个 key');
});

console.log('\n[3] D1 绑定与业务逻辑');
await check('/api/stats 带对令牌 → ok:true，且读到了假 D1 的数据', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/stats', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true, 'ok 应为 true');
  assert(j.total === 5, 'total 应为 5（来自假 D1），实际 ' + j.total);
  assert(Array.isArray(j.byModule) && j.byModule.length === 2, 'byModule 应有两组');
});
await check('/api/sync?since=0 走增量分支', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/sync?since=0&limit=10', {
    headers: { authorization: 'Bearer ' + TOKEN },
  });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true, 'ok 应为 true');
  assert(Array.isArray(j.rows), 'rows 应为数组');
});

console.log('\n[3b] 批量上传（桌面端同步走这个接口）');
/* 这个接口是为了避开「1414 条记录 = 1414 个请求」而加的。
   重点验：真的走了 D1 的 batch()、rev 在 SQL 里自增、删除能同批、超量会截断。 */
const BATCH_HDR = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };

await check('批量接口需要令牌（和别的接口一样）', async () => {
  const r = await call(makeEnv(), '/api/records-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: [{ id: 'a', data: {} }] }),
  });
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('3 条记录 → 只调 1 次 DB.batch，saved:3', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({
      device: 'desktop',
      records: [
        { id: 'b1', module: 'collection', cat: '书籍', data: { _id: 'b1', 书名: '一' } },
        { id: 'b2', module: 'collection', cat: '书籍', data: { _id: 'b2', 书名: '二' } },
        { id: 'b3', module: 'collection', cat: '书籍', data: { _id: 'b3', 书名: '三' } },
      ],
    }),
  });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true && j.saved === 3, 'saved 应为 3，实际 ' + j.saved);
  assert(env.DB.batches.length === 1, 'DB.batch 应被调用 1 次，实际 ' + env.DB.batches.length);
  assert(env.DB.batches[0].length === 3, 'batch 里应有 3 条语句，实际 ' + env.DB.batches[0].length);
});
await check('rev 靠 SQL 自增（records.rev + 1），没有额外的 SELECT', async () => {
  const env = makeEnv();
  await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({ records: [{ id: 'r1', data: {} }] }),
  });
  const sql = env.DB.batches[0][0].sql;
  assert(/records\.rev \+ 1/.test(sql), 'SQL 里应有 records.rev + 1，实际：' + sql);
  const selects = env.DB.calls.filter((c) => /^\s*SELECT/i.test(c.sql)).length;
  assert(selects === 0, '不该有额外 SELECT，实际 ' + selects + ' 次');
});
await check('每条语句 6 个绑定参数（D1 单查询上限 100，留足余量）', async () => {
  const env = makeEnv();
  await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({ records: [{ id: 'p1', module: 'collection', cat: null, data: {} }] }),
  });
  const binds = env.DB.batches[0][0].binds;
  assert(binds.length === 6, '应为 6 个绑定参数，实际 ' + binds.length);
});
await check('删除能和上传放进同一批', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({ records: [{ id: 'x1', data: {} }], deletes: ['d1', 'd2'] }),
  });
  const j = await r.json();
  assert(j.saved === 1 && j.deleted === 2, 'saved/deleted 不对：' + JSON.stringify(j));
  assert(env.DB.batches[0].length === 3, 'batch 里应有 3 条语句（1 上传 + 2 删除）');
  assert(/deleted = 1/.test(env.DB.batches[0][2].sql), '删除语句必须是软删除（deleted = 1）');
});
await check('超过 100 条会被服务端截断（防止单次请求过大）', async () => {
  const env = makeEnv();
  const many = [];
  for (let i = 0; i < 150; i++) many.push({ id: 'm' + i, data: {} });
  const r = await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({ records: many }),
  });
  const j = await r.json();
  assert(j.saved === 100, '应被截断到 100，实际 ' + j.saved);
});
await check('空请求体不报错，返回 saved:0', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({}),
  });
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true && j.saved === 0, '应返回 saved:0');
});
await check('缺 id 的记录会被拒绝（而不是静默丢数据）', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/records-batch', {
    method: 'POST',
    headers: BATCH_HDR,
    body: JSON.stringify({ records: [{ module: 'collection' }] }),
  });
  assert(r.status === 400, '应为 400，实际 ' + r.status);
  assert(env.DB.batches.length === 0, '被拒绝时不该写库');
});

console.log('\n[3c] ISBN 查书（服务端代查，绕开国内 DNS 污染）');
/* 这组测试的意义：openlibrary.org 在国内解析成 face:b00c 假 IP，
   浏览器直连和用户自己配的代理都不通，所以查书必须由 Pages 代查。
   这里把全局 fetch 换成假的，验证「选哪几个上游、怎么兜底、封面怎么改写」。 */

const ISBN_HDR = { authorization: 'Bearer ' + TOKEN };

/* 造一个够用的假 Response（不依赖 undici 对 content-length 的处理） */
function fakeRes(body, status = 200, headers = {}) {
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = String(headers[k]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    async json() { return JSON.parse(body); },
    async text() { return body; },
    body,
  };
}

/* 临时替换全局 fetch，跑完一定还原（否则后面的测试会连不上网） */
async function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, o) => {
    const url = typeof u === 'string' ? u : String(u && u.url ? u.url : u);
    seen.push(url);
    const r = handler(url, o);
    if (r === undefined) throw new Error('假 fetch 没处理这个地址：' + url);
    return r;
  };
  try { return await fn(seen); } finally { globalThis.fetch = orig; }
}

const OL_BOOKS = (isbn) => JSON.stringify({
  ['ISBN:' + isbn]: {
    title: '活着',
    authors: [{ name: '余华' }],
    publishers: [{ name: '作家出版社' }],
    publish_date: '2012年8月',
    cover: { large: 'https://covers.openlibrary.org/b/id/8231856-L.jpg' },
  },
});

await check('/api/isbn 需要令牌', async () => {
  const r = await call(makeEnv(), '/api/isbn/9787506365437');
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('ISBN 不合法 → 400（服务端自己再校验，不信客户端）', async () => {
  const r = await call(makeEnv(), '/api/isbn/abc', { headers: ISBN_HDR });
  assert(r.status === 400, '应为 400，实际 ' + r.status);
});
await check('13 位 ISBN → 查到书，中文字段名和客户端一致', async () => {
  const env = makeEnv();
  const r = await withFetch((u) => (u.includes('/api/books?bibkeys') ? fakeRes(OL_BOOKS('9787506365437')) : undefined),
    () => call(env, '/api/isbn/9787506365437', { headers: ISBN_HDR }));
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true && j.found === true, '应查到：' + JSON.stringify(j));
  assert(j.book.名称 === '活着', '名称不对：' + j.book.名称);
  assert(j.book.作者 === '余华', '作者不对：' + j.book.作者);
  assert(j.book.出版社 === '作家出版社', '出版社不对：' + j.book.出版社);
  assert(j.book.出版年 === '2012', '出版年应提取成 4 位，实际 ' + j.book.出版年);
  assert(j.book.ISBN === '9787506365437', 'ISBN 应回填归一化后的值');
});
await check('带横杠/空格的 ISBN 会被归一化', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes(OL_BOOKS('9787506365437')),
    () => call(env, '/api/isbn/' + encodeURIComponent('978-7-5063-6543-7'), { headers: ISBN_HDR }));
  const j = await r.json();
  assert(j.found === true, '归一化后应能查到：' + JSON.stringify(j));
  assert(j.book.ISBN === '9787506365437', '归一化结果不对：' + j.book.ISBN);
});
await check('封面被改写成我们自己的 /api/isbn-cover/（原地址国内加载不出来）', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes(OL_BOOKS('9787506365437')),
    () => call(env, '/api/isbn/9787506365437', { headers: ISBN_HDR }));
  const j = await r.json();
  assert(j.book.封面 === 'https://life-desk-api.pages.dev/api/isbn-cover/8231856',
    '封面应指向本站，实际：' + j.book.封面);
  assert(!/covers\.openlibrary\.org/.test(j.book.封面), '不该把被墙的原始地址透出去');
});
await check('第一级查不到 → 自动兜底到 /isbn/{isbn}.json，作者再查 work', async () => {
  const env = makeEnv();
  const r = await withFetch((u) => {
    if (u.includes('/api/books?bibkeys')) return fakeRes('{}');
    if (/openlibrary\.org\/isbn\/\d+\.json/.test(u)) {
      return fakeRes(JSON.stringify({
        title: '三体', publishers: ['重庆出版社'], publish_date: '2008',
        covers: [1234567], works: [{ key: '/works/OL123W' }],
      }));
    }
    if (u.endsWith('/works/OL123W.json')) {
      return fakeRes(JSON.stringify({ authors: [{ author: { key: '/authors/OL9A' } }] }));
    }
    if (u.endsWith('/authors/OL9A.json')) return fakeRes(JSON.stringify({ name: '刘慈欣' }));
    return undefined;
  }, () => call(env, '/api/isbn/9787536692930', { headers: ISBN_HDR }));
  const j = await r.json();
  assert(j.found === true, '兜底应查到：' + JSON.stringify(j));
  assert(j.book.名称 === '三体' && j.book.作者 === '刘慈欣', '兜底结果不对：' + JSON.stringify(j.book));
  assert(j.book.封面 === 'https://life-desk-api.pages.dev/api/isbn-cover/1234567', '封面 id 应来自 covers[0]');
});
await check('三级全查不到 → found:false，但 ok:true（查无此书不是错误）', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes('{}'),
    () => call(env, '/api/isbn/9999999999999', { headers: ISBN_HDR }));
  assert(r.status === 200, '应为 200（不该报 5xx），实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true && j.found === false, '应为 ok:true + found:false：' + JSON.stringify(j));
  assert(j.book === null, 'book 应为 null');
});
await check('上游挂了也返回 ok:true + found:false，并把上游报错带回来', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes('boom', 503),
    () => call(env, '/api/isbn/9787506365437', { headers: ISBN_HDR }));
  assert(r.status === 200, '上游 503 不该让本接口也 5xx，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === true && j.found === false, '应优雅降级：' + JSON.stringify(j));
  assert(Array.isArray(j.upstream) && j.upstream.length > 0, '应带回上游错误便于排查');
});

console.log('\n[3d] 封面中转（必须堵死「任意 URL 代理」这个口子）');
await check('/api/isbn-cover 刻意【不】要令牌（<img src> 带不了 Authorization 头）', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes('BINARY', 200, { 'content-type': 'image/jpeg', 'content-length': '5000' }),
    () => call(env, '/api/isbn-cover/8231856'));
  assert(r.status === 200, '不带令牌也应能取到封面，实际 ' + r.status);
});
await check('/api/isbn 查书本身仍然要令牌（会消耗上游配额）', async () => {
  const r = await call(makeEnv(), '/api/isbn/9787506365437');
  assert(r.status === 401, '应为 401，实际 ' + r.status);
});
await check('非数字 id → 400（否则就成了开放代理）', async () => {
  /* 这些是「真能到达 worker」的形式：URL 编码后的斜杠、域名、字母。 */
  const bad = [
    'abc',
    '12x45',
    encodeURIComponent('https://evil.com/a.jpg'),
    encodeURIComponent('1/../../x'),   /* %2F 不会被 URL 解析器规范化，会原样到 worker */
    encodeURIComponent('8231856-L.jpg'),
  ];
  for (const id of bad) {
    const r = await call(makeEnv(), '/api/isbn-cover/' + id, { headers: ISBN_HDR });
    assert(r.status === 400, 'id=' + id + ' 应为 400，实际 ' + r.status);
  }
});
await check('裸的 ../ 会被 URL 解析器在进 worker 前就规范化掉（够不到 handler）', async () => {
  /* 注意：这里断言的不是 400，而是「根本到不了 /api/isbn-cover」。
     路径里的 .. 由 URL 解析器折叠，worker 收到的已经是 /x，
     于是走静态转发分支。也就是说裸 .. 连入口都进不来。 */
  const r = await call(makeEnv(), '/api/isbn-cover/1/../../x', { headers: ISBN_HDR });
  assert(r.status !== 200 || !/isbn-cover/.test(r.url || ''),
    '裸 .. 不该被当作 isbn-cover 处理');
  assert(r.status === 200 || r.status === 404, '实际状态 ' + r.status);
});
await check('数字 id → 200，且只向 covers.openlibrary.org 的固定模板取图', async () => {
  const env = makeEnv();
  let asked = '';
  const r = await withFetch((u) => {
    asked = u;
    return fakeRes('BINARY', 200, { 'content-type': 'image/jpeg', 'content-length': '5000' });
  }, () => call(env, '/api/isbn-cover/8231856', { headers: ISBN_HDR }));
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  assert(asked === 'https://covers.openlibrary.org/b/id/8231856-L.jpg',
    '取图地址必须是固定模板拼出来的，实际：' + asked);
  assert(r.headers.get('content-type') === 'image/jpeg', '应透传 content-type');
  assert((r.headers.get('cache-control') || '').includes('max-age'), '应带缓存头，省得每次都回源');
});
await check('OpenLibrary 的 1x1 占位图（<1000 字节）→ 404，不当成真封面', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes('X', 200, { 'content-type': 'image/jpeg', 'content-length': '988' }),
    () => call(env, '/api/isbn-cover/8231856', { headers: ISBN_HDR }));
  assert(r.status === 404, '应为 404，实际 ' + r.status);
});
await check('上游 404 → 也返回 404', async () => {
  const env = makeEnv();
  const r = await withFetch(() => fakeRes('not found', 404),
    () => call(env, '/api/isbn-cover/8231856', { headers: ISBN_HDR }));
  assert(r.status === 404, '应为 404，实际 ' + r.status);
});

console.log('\n[4] 路由兜底');
await check('未知的 /api/xxx → 404 且是 JSON', async () => {
  const r = await call(makeEnv(), '/api/nope', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert(r.status === 404, '应为 404，实际 ' + r.status);
  const j = await r.json();
  assert(j.ok === false, 'ok 应为 false');
});

console.log('\n[5] CORS 预检');
await check('OPTIONS /api/records → 204 + 允许的 methods', async () => {
  const r = await call(makeEnv(), '/api/records', { method: 'OPTIONS' });
  assert(r.status === 204, '应为 204，实际 ' + r.status);
  assert(
    (r.headers.get('access-control-allow-methods') || '').includes('PATCH'),
    '允许的方法里应有 PATCH'
  );
});

console.log('\n[6] 静态资源转发（高级模式的关键：非 API 必须交给 ASSETS）');
await check('GET / → 转给 ASSETS，且 ASSETS 真被调用', async () => {
  const env = makeEnv();
  const r = await call(env, '/');
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  assert(env.ASSETS.calls === 1, 'ASSETS.fetch 应被调用 1 次，实际 ' + env.ASSETS.calls);
  const t = await r.text();
  assert(t.includes('index'), '应返回 index.html 的内容');
});
await check('GET /some/static.js → 也转给 ASSETS', async () => {
  const env = makeEnv();
  const r = await call(env, '/some/static.js');
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  assert(env.ASSETS.calls === 1, 'ASSETS.fetch 应被调用');
});
await check('没有 ASSETS 绑定时也不崩，给一句人话', async () => {
  const env = { DB: fakeD1(), IMG: fakeR2(), SYNC_TOKEN: TOKEN };
  const r = await call(env, '/');
  assert(r.status === 200, '应为 200，实际 ' + r.status);
  const t = await r.text();
  assert(t.includes('/api/ping'), '应提示去访问 /api/ping');
});

console.log('\n[7] 自检页 index.html 的连线');
/* 页面逻辑靠 getElementById 取元素，改 HTML 时很容易把 id 改掉而 JS 没跟着改，
   结果就是「点了没反应」，而且要等部署完在手机上才发现。这里静态查一遍。 */
await check('index.html 里每个 $("id") 都真的存在', async () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const defined = new Set();
  const reId = /\bid="([^"]+)"/g;
  let m;
  while ((m = reId.exec(html))) defined.add(m[1]);

  const used = new Set();
  const reUse = /\$\('([^']+)'\)/g;
  while ((m = reUse.exec(html))) used.add(m[1]);

  const missing = [...used].filter((x) => !defined.has(x));
  assert(missing.length === 0, '这些 id 被 JS 引用了但 HTML 里没有：' + missing.join(', '));
  assert(used.size >= 8, '只找到 ' + used.size + ' 个 id 引用，可能 HTML 结构被改坏了');
});
await check('index.html 引用的 API 路径都在预期内（没有手滑写错的接口名）', async () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  /* 这里刻意【不】要求路径后面紧跟引号：/api/isbn/{ISBN} 是拼出来的，
     后面跟的是斜杠。只抓 /api/ 开头的路径前缀，再比对白名单。 */
  const apis = [...html.matchAll(/(\/api\/[a-z-]+)/g)].map((x) => x[1]);
  const uniq = [...new Set(apis)].sort();
  const expected = ['/api/isbn', '/api/isbn-cover', '/api/ping', '/api/stats'];
  const extra = uniq.filter((x) => !expected.includes(x));
  assert(extra.length === 0, '自检页出现了预期外的接口：' + extra.join(', '));
  assert(uniq.includes('/api/ping'), '缺 /api/ping');
  assert(uniq.includes('/api/stats'), '缺 /api/stats');
  assert(uniq.includes('/api/isbn'), '缺 /api/isbn（查书自检卡没了？）');
});
await check('index.html 有查书自检卡，且真的会去调 /api/isbn/', async () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  assert(/id="isbnBtn"/.test(html), '缺 isbnBtn 按钮');
  assert(/fetch\('\/api\/isbn\/'/.test(html), '没找到对 /api/isbn/ 的 fetch 调用');
  assert(/isbnBtn'\)\.addEventListener/.test(html), '按钮没绑事件');
  /* 封面靠 <img src> 加载，带不了 Authorization 头 —— 所以服务端必须放行
     /api/isbn-cover。这里确保页面没有画蛇添足地去带令牌。 */
  assert(/fetch\('\/api\/isbn\/'[\s\S]{0,400}?authorization: 'Bearer ' \+ tok/.test(html),
    '查书请求应带 Bearer 令牌');
});

/* ============================================================ */

console.log('\n----------------------------------------');
console.log('通过 %d 项，失败 %d 项', pass, fail);
if (fail === 0) {
  console.log('结果：✅ 逻辑没问题，可以拖到 Cloudflare 了。');
  console.log('      （注意：真绑定 / 真令牌还得部署后在线上验一次）');
} else {
  console.log('结果：❌ 先别部署，把上面的问题修掉。');
}
console.log('');
process.exit(fail === 0 ? 0 : 1);
