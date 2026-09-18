/* ============================================================
 * smoke_isbn_client.mjs —— 客户端「查书」这条路的本地冒烟测试
 * ------------------------------------------------------------
 * 覆盖两件事：
 *   ① normIsbn()  10 位 → 13 位的校验位算法（修过一个真 bug）
 *   ② cloudLookupBook()  优先走自家 /api/isbn/{isbn}，失败要能安静退回老链
 *
 * 手法和 smoke_cloud_client.mjs 一致：把 app.js 里那几段源码**原文抠出来**
 * 用 new Function 跑，测的是真正要上线的代码，不是重写一遍的复刻品。
 *
 * 用法：
 *     node tools/smoke_isbn_client.mjs
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/* APP_PATH 可指向 app.js 的一份副本，用来证明「本测试真的会失败」。
   一个永远通过的测试等于没有测试。 */
const APP = process.env.APP_PATH || join(HERE, '..', 'app.js');
const src = readFileSync(APP, 'utf8');

/* ---------- 抠源码：用「下一段代码的开头」当结束标记 ---------- */
function sliceBetween(startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  if (a < 0) {
    console.error('!! 找不到起点：' + startMarker + '（' + label + '）');
    process.exit(1);
  }
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) {
    console.error('!! 找不到终点：' + endMarker + '（' + label + '）');
    process.exit(1);
  }
  return src.slice(a, b);
}

const cloudBlock = sliceBetween(
  "var CLOUD_KEY = 'lifedesk_cloud';", 'function addDataTools(){', '云同步块');
const normSrc = sliceBetween(
  'function normIsbn(s){', '/* ---------- v65：ISBN 查书数据源', 'normIsbn');
const lookupSrc = sliceBetween(
  'function cloudLookupBook(isbn, cb){', 'function lookupBookByISBN(isbn, cb){',
  'cloudLookupBook');

console.log('抠出源码：云同步块 %d 字节 / normIsbn %d 字节 / cloudLookupBook %d 字节',
  cloudBlock.length, normSrc.length, lookupSrc.length);

/* ---------- 沙箱 ---------- */
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
  async function fetchStub(url, init) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    reqs.push({
      url: String(url),
      path,
      method: (init && init.method) || 'GET',
      auth: (init && init.headers && init.headers.Authorization) || '',
    });
    const r = opts.fetch ? await opts.fetch(path, reqs.length) : { status: 200, json: { ok: true } };
    if (r === 'THROW') throw new Error('模拟网络中断');
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => (r.json == null ? (r.text || '') : JSON.stringify(r.json)),
    };
  }

  const noop = () => {};
  const factory = new Function(
    'localStorage', 'fetch', 'snapshotAll', 'shardCatOf', 'toast', '$',
    cloudBlock + '\n' + normSrc + '\n' + lookupSrc + `
    ;return {
      cloudBase: cloudBase, cloudToken: cloudToken, cloudFetch: cloudFetch,
      normIsbn: normIsbn, cloudLookupBook: cloudLookupBook
    };`
  );
  const api = factory(localStorage, fetchStub, noop, noop, noop, () => null);
  return { api, ls, reqs };
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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* 把回调式 API 包成 Promise（带超时，防止代码永不回调把测试挂住） */
function callLookup(api, isbn) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timedOut: true, book: undefined }), 3000);
    const ret = api.cloudLookupBook(isbn, (book) => {
      clearTimeout(t);
      resolve({ ret, book });
    });
    /* 同步就能拿到返回值（是否发起了请求），先存起来 */
    if (ret !== undefined) { setTimeout(() => {}, 0); }
    Promise.resolve().then(() => { /* 让异步分支有机会跑 */ });
  });
}

const CFG = { lifedesk_cloud: JSON.stringify({ apiBase: 'https://life-desk-api.pages.dev', token: 'tok-1' }) };
const FOUND = {
  status: 200,
  json: {
    ok: true, found: true,
    book: {
      ISBN: '9787506365437', _src: 'Open Library',
      名称: '活着', 作者: '余华', 出版社: '作家出版社', 出版年: '2012',
      封面: 'https://life-desk-api.pages.dev/api/isbn-cover/8231856',
    },
  },
};

/* ============================================================ */
console.log('\n=== 冒烟测试：客户端查书（normIsbn + cloudLookupBook）===\n');

console.log('[1] normIsbn —— 10 位转 13 位的校验位算法');
await check('10 位 → 13 位，校验位按 ISBN-13 规则重算（曾经算错）', async () => {
  const { api } = makeSandbox();
  const got = api.normIsbn('0306406152');
  assert(got === '9780306406157',
    '应为 9780306406157，实际 ' + got +
    '（若为 9780306406152 说明又用 ISBN-10 的 mod11 校验位当第 13 位了）');
});
await check('另一组：080442957X → 9780804429573', async () => {
  const { api } = makeSandbox();
  const got = api.normIsbn('080442957X');
  assert(got === '9780804429573', '应为 9780804429573，实际 ' + got);
});
await check('13 位原样通过', async () => {
  const { api } = makeSandbox();
  assert(api.normIsbn('9787506365437') === '9787506365437', '13 位不该被改动');
});
await check('带横杠/空格会被清掉', async () => {
  const { api } = makeSandbox();
  assert(api.normIsbn('978-7-5063-6543-7') === '9787506365437', '横杠没清干净');
  assert(api.normIsbn(' 978 7506 365437 ') === '9787506365437', '空格没清干净');
});
await check('位数不对/含字母 → 返回空串（拒绝而不是硬凑）', async () => {
  const { api } = makeSandbox();
  for (const bad of ['abc', '', '978750636543', '97875063654378', '12345678901']) {
    assert(api.normIsbn(bad) === '', JSON.stringify(bad) + ' 应返回空串，实际 ' + api.normIsbn(bad));
  }
});

console.log('\n[2] cloudLookupBook —— 没配置时不该打扰用户');
await check('没配令牌 → 不发起请求，回调 null', async () => {
  const s = makeSandbox();
  let called = false, book = 'unset';
  const ret = s.api.cloudLookupBook('9787506365437', (b) => { called = true; book = b; });
  assert(ret === false, '没配置时应返回 false，实际 ' + ret);
  assert(s.reqs.length === 0, '不该发请求，实际发了 ' + s.reqs.length + ' 个');
  await new Promise((r) => setTimeout(r, 10));
  assert(called && book === null, '仍应回调 null（调用方在等）');
});
await check('令牌是空串 → 同样不发起请求', async () => {
  const s = makeSandbox({ ls: { lifedesk_cloud: JSON.stringify({ apiBase: 'https://x.pages.dev', token: '  ' }) } });
  const ret = s.api.cloudLookupBook('9787506365437', () => {});
  assert(ret === false, '应返回 false，实际 ' + ret);
  assert(s.reqs.length === 0, '不该发请求');
});

console.log('\n[3] cloudLookupBook —— 配好了就走自家接口');
await check('请求路径是 /api/isbn/{isbn}，且带 Bearer 令牌', async () => {
  const s = makeSandbox({ ls: CFG, fetch: () => FOUND });
  await callLookup(s.api, '9787506365437');
  await new Promise((r) => setTimeout(r, 20));
  assert(s.reqs.length === 1, '应只发 1 个请求，实际 ' + s.reqs.length);
  assert(s.reqs[0].path === '/api/isbn/9787506365437', '路径不对：' + s.reqs[0].path);
  assert(s.reqs[0].auth === 'Bearer tok-1', '缺 Bearer 令牌：' + s.reqs[0].auth);
});
await check('查到书 → 规整成客户端的中文字段结构', async () => {
  const s = makeSandbox({ ls: CFG, fetch: () => FOUND });
  let got = null;
  s.api.cloudLookupBook('9787506365437', (b) => { got = b; });
  await new Promise((r) => setTimeout(r, 20));
  assert(got && got['名称'] === '活着', '名称不对：' + JSON.stringify(got));
  assert(got['作者'] === '余华', '作者不对');
  assert(got['出版社'] === '作家出版社', '出版社不对');
  assert(got['出版年'] === '2012', '出版年不对');
  assert(got['ISBN'] === '9787506365437', 'ISBN 不对');
  assert(got._src === 'Open Library', '_src 应透传服务端给的来源：' + got._src);
  assert(/\/api\/isbn-cover\/8231856$/.test(got['封面']), '封面应指向本站代理：' + got['封面']);
});
await check('字段两边带空格 → 会被 trim（免得写进记录里带脏字符）', async () => {
  const s = makeSandbox({
    ls: CFG,
    fetch: () => ({ status: 200, json: { ok: true, found: true, book: {
      ISBN: ' 9787506365437 ', 名称: '  活着  ', 作者: ' 余华 ', 出版社: '作家出版社 ', 出版年: ' 2012 ',
    } } }),
  });
  let got = null;
  s.api.cloudLookupBook('9787506365437', (b) => { got = b; });
  await new Promise((r) => setTimeout(r, 20));
  assert(got['名称'] === '活着', '名称没 trim：' + JSON.stringify(got['名称']));
  assert(got['作者'] === '余华', '作者没 trim');
  assert(got['出版年'] === '2012', '出版年没 trim');
  assert(got['ISBN'] === '9787506365437', 'ISBN 没 trim');
});
await check('服务端没给 _src → 回落成「云同步」，不会变成 undefined', async () => {
  const s = makeSandbox({
    ls: CFG,
    fetch: () => ({ status: 200, json: { ok: true, found: true, book: { ISBN: '9787506365437', 名称: '活着' } } }),
  });
  let got = null;
  s.api.cloudLookupBook('9787506365437', (b) => { got = b; });
  await new Promise((r) => setTimeout(r, 20));
  assert(got._src === '云同步', '_src 应为「云同步」，实际 ' + got._src);
});

console.log('\n[4] cloudLookupBook —— 失败必须安静退回老链（绝不能抛）');
/* 这一组最重要：接口还没重新部署时是 404，令牌填错是 401。
   这两种情况下必须老老实实回调 null，让老的「豆瓣/OL/京东」长链继续跑，
   而不是在用户填表时弹一个错误框。 */
const quietCases = [
  ['接口还没部署（404）', () => ({ status: 404, json: { ok: false, error: '未知接口' } })],
  ['令牌不对（401）', () => ({ status: 401, json: { ok: false, error: 'unauthorized' } })],
  ['服务器 500', () => ({ status: 500, json: { ok: false, error: 'boom' } })],
  ['查无此书（found:false）', () => ({ status: 200, json: { ok: true, found: false, book: null } })],
  ['有 book 但没书名', () => ({ status: 200, json: { ok: true, found: true, book: { ISBN: '9787506365437', 名称: '' } } })],
  ['返回的不是 JSON', () => ({ status: 200, text: '<html>oops</html>' })],
  ['网络直接抛异常', () => 'THROW'],
];
for (const [label, mk] of quietCases) {
  await check(label + ' → 回调 null，不抛异常', async () => {
    const s = makeSandbox({ ls: CFG, fetch: mk });
    let called = false, got = 'unset';
    let threw = null;
    try {
      s.api.cloudLookupBook('9787506365437', (b) => { called = true; got = b; });
    } catch (e) { threw = e; }
    assert(!threw, '不该同步抛异常：' + threw);
    await new Promise((r) => setTimeout(r, 30));
    assert(called, '应回调（否则调用方的长链永远不会启动）');
    assert(got === null, '应回调 null，实际 ' + JSON.stringify(got));
  });
}
await check('404 时仍然返回 true（表示「确实尝试过了」，便于调用方区分）', async () => {
  const s = makeSandbox({ ls: CFG, fetch: () => ({ status: 404, json: {} }) });
  const ret = s.api.cloudLookupBook('9787506365437', () => {});
  assert(ret === true, '配好了就该返回 true，实际 ' + ret);
  await new Promise((r) => setTimeout(r, 20));
});

/* ============================================================ */
console.log('\n----------------------------------------');
console.log('通过 %d 项，失败 %d 项', pass, fail);
if (fail === 0) {
  console.log('结果：✅ 客户端查书逻辑没问题。');
} else {
  console.log('结果：❌ 有问题，先修。');
}
console.log('');
process.exit(fail === 0 ? 0 : 1);
