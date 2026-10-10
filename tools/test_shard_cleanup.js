/* v145 沙箱验证：把 app.js 里**真实的** storageSaveV2 / shardCatOf 源码抠出来，
   配一个「内存文件系统」跑，验证「删空一个分片后，它的 data.json 会被重写成 rows:[]」。
   直接测真源码，不复制逻辑。 */
'use strict';
const fs = require('node:fs');

const SRC = fs.readFileSync('app.js', 'utf8');

/* 按名字抠函数源码（花括号配对，跳过字符串/注释）。⚠️ 必须带上 async 前缀，
   否则抠出来的函数体里 await 直接语法报错。 */
function grab(name){
  const at = SRC.indexOf('async function ' + name + '(') >= 0
    ? SRC.indexOf('async function ' + name + '(')
    : SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到函数 ' + name);
  let i = SRC.indexOf('{', at), depth = 0, inS = null, inLC = false, inBC = false;
  for (let j = at; j < SRC.length; j++){
    const c = SRC[j], n = SRC[j + 1];
    if (inLC){ if (c === '\n') inLC = false; continue; }
    if (inBC){ if (c === '*' && n === '/'){ inBC = false; j++; } continue; }
    if (inS){ if (c === '\\'){ j++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/'){ inLC = true; j++; continue; }
    if (c === '/' && n === '*'){ inBC = true; j++; continue; }
    if (c === "'" || c === '"' || c === '`'){ inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}'){ depth--; if (depth === 0) return SRC.slice(at, j + 1); }
  }
  throw new Error('没闭合 ' + name);
}

const srcSave = grab('storageSaveV2');
const srcCat  = grab('shardCatOf');
console.log('抠到 storageSaveV2：%d 字符；shardCatOf：%d 字符', srcSave.length, srcCat.length);

/* ---------------- 内存文件系统 + 桩 ---------------- */
function makeEnv(files, srcOverride){
  const srcSaveUse = srcOverride || srcSave;
  const FS = {};                                  // path -> 对象
  Object.keys(files).forEach(p => { FS[p] = JSON.parse(JSON.stringify(files[p])); });
  const log = { writes: [], reads: [] };
  let IDX = null;

  const env = {
    SCHEMA_V2: 2,
    SHARD_FIELD: { travel:'状态', collection:'小类', av:'大类', study:'领域', food:'类型', recipe:'', idea:'分类' },
    _fsaHandle: { fake: true },
    store: { collection: { rows: [] }, ip: { rows: [] }, series: { rows: [] } },
    JSON,
    console,
    Object,
    String,
    Number,
    Array,
    Promise,
    setTimeout,
    /* 索引 */
    fsReadIndex: async () => JSON.parse(JSON.stringify(IDX)),
    fsWriteIndex: async (o) => { IDX = JSON.parse(JSON.stringify(o)); log.writes.push(['lifedesk.json', null]); return true; },
    /* 分片文件 */
    fsReadJSON:     async (p) => (FS[p] ? JSON.parse(JSON.stringify(FS[p])) : null),
    fsReadJSONAt:   async (p) => (FS[p] ? JSON.parse(JSON.stringify(FS[p])) : null),
    fsWriteJSON:    async (p, o) => { FS[p] = JSON.parse(JSON.stringify(o)); log.writes.push([p, JSON.stringify(o.rows || [])]); return true; },
    fsWriteJSONAt:  async (p, o) => { FS[p] = JSON.parse(JSON.stringify(o)); log.writes.push([p, JSON.stringify(o.rows || [])]); return true; },
    /* 目录枚举（ip/series 实体文件）—— 测试里给空 */
    entityExistingFiles: async () => [],
    saveEntityModule:    async () => { },
    externalizeImages:   async () => { },
    writeReadme:         async () => { },
    /* 命名规则：直接用 app.js 里的真源码行为（这两处规则简单，这里照抄签名） */
    shardFileName: (cat) => cat + '-data.json',
    coverDirName:  (cat) => cat + '-封面'
  };

  /* 把真源码装进沙箱：函数体内直接用 env 的键名 */
  const names = Object.keys(env);
  const runner = new Function(
    names.join(','),
    srcCat + '\n' + srcSaveUse + '\nreturn { save: storageSaveV2, cat: shardCatOf };'
  );
  const api = runner.apply(null, names.map(n => env[n]));
  return {
    save: api.save,
    FS,
    log,
    setIdx: (o) => { IDX = JSON.parse(JSON.stringify(o)); },
    getIdx: () => IDX
  };
}

/* ---------------- 造数据 ---------------- */
const IDX0 = {
  schema: 2,
  shards: {
    ip:     { module: 'ip', dirShard: true, dir: 'ip', coverDir: 'ip' },
    series: { module: 'series', dirShard: true, dir: 'series', coverDir: '系列' },
    '书籍':      { file: '书籍/书籍-data.json',     module: 'collection', coverDir: '书籍-封面',     group: '书籍' },
    '工具语言':  { file: '书籍/工具语言-data.json', module: 'collection', coverDir: '工具语言-封面', group: '书籍', kind: 'booktag' },
    '德语':      { file: '书籍/德语-data.json',     module: 'collection', coverDir: '德语-封面',     group: '书籍', kind: 'booksub', parent: '工具语言' },
    '徽章':      { file: '徽章-data.json',          module: 'collection', coverDir: '徽章-封面' }
  },
  __main: { collection: [] },
  entityFiles: [],
  layoutVersion: 1, fieldLayout: {}, customFields: {}
};

const A = { _id:'l_mtp91urf5z6b4', 名称:'中国古代文化常识辞典', 大类:'书籍', 小类:null, 标签分类:null, _upd:1789699895277, _rev:1 };
const B = { _id:'l_mtpbg5je5ghp7', 名称:'中国古代文化常识辞典', 大类:'书籍', 小类:null, 标签分类:'工具语言', _upd:1789699895277, _rev:1 };
const C = { _id:'b_1', 名称:'皮卡丘徽章', 大类:'周边', 小类:'徽章', _upd:1, _rev:1 };
const D = { _id:'x_1', 名称:'散件', 大类:'周边', 小类:null, _upd:1, _rev:1 };   // 未分片 → __main

let pass = 0, fail = 0;
function eq(got, want, label){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望 ' + w + '\n      实得 ' + g); }
}

(async () => {
  console.log('\n=== 场景1：删掉「未分类」那本（书籍分片变空）===');
  {
    const e = makeEnv({
      '书籍/书籍-data.json':     { schema:2, cat:'书籍',     module:'collection', rows:[A] },
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] },
      '徽章-data.json':          { schema:2, cat:'徽章',     module:'collection', rows:[C] }
    });
    e.setIdx(IDX0);
    const ok = await e.save({ collection:[B, C, D], ip:[], series:[] });
    eq(ok, true, 'save 返回 true');
    eq(e.FS['书籍/书籍-data.json'].rows, [], '★ 书籍-data.json 被重写成 rows:[]（这就是以前不会发生的事）');
    eq(e.FS['书籍/书籍-data.json'].cat, '书籍', '空文件的 cat 保留');
    eq(e.FS['书籍/书籍-data.json'].module, 'collection', '空文件的 module 保留');
    eq(e.FS['书籍/工具语言-data.json'].rows.length, 1, '工具语言那份还在');
    eq(e.FS['书籍/工具语言-data.json'].rows[0]._id, 'l_mtpbg5je5ghp7', '剩下的是「工具语言」那一本');
    eq(e.FS['徽章-data.json'].rows.length, 1, '别的分片没被动');
    eq(Object.keys(e.getIdx().shards).length, Object.keys(IDX0.shards).length, 'shards 登记表没被改小');
    eq(e.getIdx().__main.collection.length, 1, '未分片的记录进了 __main');
    eq(e.getIdx().__main.collection[0]._id, 'x_1', '__main 里是那条散件');
  }

  console.log('\n=== 场景2：再存一次（幂等 —— 空文件不该被反复重写）===');
  {
    const e = makeEnv({
      '书籍/书籍-data.json':     { schema:2, cat:'书籍', module:'collection', rows:[] },   // 已经是空的
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] }
    });
    e.setIdx(IDX0);
    await e.save({ collection:[B], ip:[], series:[] });
    const hits = e.log.writes.filter(w => w[0] === '书籍/书籍-data.json');
    eq(hits.length, 0, '已经是空的 → 不再写它（幂等）');
  }

  console.log('\n=== 场景3：不新建文件（不留空 data.json 垃圾）===');
  {
    const e = makeEnv({
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] }
    });
    e.setIdx(IDX0);   // 注册了 德语 / 徽章 等，但盘上没有文件
    await e.save({ collection:[B], ip:[], series:[] });
    eq(e.FS['书籍/德语-data.json'] === undefined, true, '德语-data.json 没被凭空创建');
    eq(e.FS['徽章-data.json'] === undefined, true, '徽章-data.json 没被凭空创建');
  }

  console.log('\n=== 场景4：两个分片都还有行 → 正常全写（回归）===');
  {
    const e = makeEnv({
      '书籍/书籍-data.json':     { schema:2, cat:'书籍', module:'collection', rows:[] },
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[] }
    });
    e.setIdx(IDX0);
    await e.save({ collection:[A, B], ip:[], series:[] });
    eq(e.FS['书籍/书籍-data.json'].rows[0]._id, 'l_mtp91urf5z6b4', '书籍分片写入了 A');
    eq(e.FS['书籍/工具语言-data.json'].rows[0]._id, 'l_mtpbg5je5ghp7', '工具语言分片写入了 B');
  }

  console.log('\n=== 场景5：内容没变 → 不写（省盘 / 不刷新 mtime）===');
  {
    const e = makeEnv({
      '书籍/书籍-data.json':     { schema:2, cat:'书籍', module:'collection', rows:[A] },
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] }
    });
    e.setIdx(IDX0);
    await e.save({ collection:[A, B], ip:[], series:[] });
    const hits = e.log.writes.filter(w => w[0] !== 'lifedesk.json');
    eq(hits.length, 0, '两个分片内容一致 → 一个都没写');
  }

  console.log('\n=== 场景6：删空的是普通分片（徽章）===');
  {
    const e = makeEnv({
      '徽章-data.json':          { schema:2, cat:'徽章', module:'collection', rows:[C] },
      '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] }
    });
    e.setIdx(IDX0);
    await e.save({ collection:[B], ip:[], series:[] });
    eq(e.FS['徽章-data.json'].rows, [], '徽章-data.json 也被清空（不是只对书籍生效）');
  }

  console.log('\n=== 场景7：对照实验 —— 把 v145 那段摘掉（= 旧代码）===');
  {
    const s = srcSave.indexOf('/* v145：把「已经没有记录」的分类文件清空');
    const e2 = srcSave.indexOf('/* v68：逐实体写 IP / 系列');
    if (s < 0 || e2 < 0) { fail++; console.log('  ✗ 找不到 v145 段落，无法做对照'); }
    else {
      const oldSrc = srcSave.slice(0, s) + srcSave.slice(e2);
      const e = makeEnv({
        '书籍/书籍-data.json':     { schema:2, cat:'书籍',     module:'collection', rows:[A] },
        '书籍/工具语言-data.json': { schema:2, cat:'工具语言', module:'collection', rows:[B] }
      }, oldSrc);
      e.setIdx(IDX0);
      await e.save({ collection:[B], ip:[], series:[] });
      eq(e.FS['书籍/书籍-data.json'].rows.length, 1,
         '★ 旧代码：书籍-data.json 里那条【还在】—— 这就是「删不掉、自己冒出来」');
      eq(e.FS['书籍/书籍-data.json'].rows[0]._id, 'l_mtp91urf5z6b4', '旧代码留下的正是那条删不掉的');
    }
  }

  console.log('\n=== 结果：%d 通过 / %d 失败 ===', pass, fail);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(2); });
