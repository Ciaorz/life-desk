/* ============================================================
 * sync-worker.js —— 日常集 · 云同步后端（Cloudflare Worker + D1 + R2）
 * ------------------------------------------------------------
 * 职责：
 *   1. 记录同步   D1 里一条记录一行，业务字段全塞在 data(JSON) 里
 *   2. 图片存取   R2 存缩略图与 800px 图，走 CDN
 *   3. 认证       所有写操作都要带 Authorization: Bearer <SYNC_TOKEN>
 *
 * 设计要点（都是刻意的，改之前先想清楚）
 * ------------------------------------------------------------
 * · D1 用「通用表 + JSON 行」，绝不拆业务表。
 *   因为 App 有自定义字段系统（fieldLayout / customFields / 用户自建大类），
 *   拆成关系型列以后每加一个字段都要改表结构。
 *
 * · 冲突用「字段级合并」，不是「最后写入胜出」。
 *   手机上改状态、电脑上改购入价格，这根本不是冲突，应该自动合并。
 *   客户端提交时把「改动前看到的值」一起带上（base），
 *   服务端逐字段比对：base 和当前值一致 → 安全套用；
 *   不一致 → 只把冲突的那几个字段挑出来让用户决定。
 *
 * · 增量同步靠 updated_at。GET /api/sync?since=<毫秒> 只回比它新的。
 *   删除用软删除（deleted=1），否则别的设备不知道「这条没了」。
 *
 * 部署见同目录 schema.sql 与根目录《云同步部署手册.md》
 * ============================================================ */

const JSON_HEAD = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEAD, ...CORS, ...extra },
  });
}

function fail(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

/* 认证：常量时间比较，避免时序侧信道 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(req, env) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  return timingSafeEqual(m[1], env.SYNC_TOKEN || '');
}

/* 读请求也建议带 token（数据是你的私人收藏，不该公开可读）。
   如果你想「只读接口完全公开、写接口要 token」，把下面 requireRead 改成 false。 */
const REQUIRE_READ_AUTH = true;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ---------- 健康检查（不需要认证，用来确认部署成功） ---------- */
    if (p === '/api/ping') {
      return json({ ok: true, service: 'life-desk-sync', time: Date.now() });
    }

    /* 需要认证的路径前缀。
       ⚠️ 2026-09-18 修 bug：这里原来漏了 /api/stats，而 REQUIRE_READ_AUTH = true
       本意是「读也要令牌」，结果 /api/stats 完全裸奔 —— 任何人知道地址就能读到
       总条数和各模块条数。已补上。
       注意：/api/img-batch 是靠 '/api/img' 这个前缀覆盖到的，别把它拆成单独一项。

       ⚠️ /api/isbn-cover/* 刻意【不要】认证：
         封面是公开图片，而且必须能被 <img src> 和普通 fetch 直接取用 ——
         这两种请求都带不了 Authorization 头，一加认证，所有封面会全裂成 401。
         「不许当开放代理」这件事由「id 必须是纯数字」的校验兜住，不靠认证。
         （/api/isbn 查书本身仍然要令牌，因为会消耗上游配额。） */
    const needAuth = (p.startsWith('/api/sync')
      || p.startsWith('/api/records')
      || p.startsWith('/api/img')
      || p.startsWith('/api/meta')
      || p.startsWith('/api/stats')
      || p.startsWith('/api/isbn'))
      && !p.startsWith('/api/isbn-cover');
    if (needAuth && !(REQUIRE_READ_AUTH ? authorized(request, env) : (request.method === 'GET' || authorized(request, env)))) {
      return fail('unauthorized', 401);
    }

    try {
      /* ================= 记录：拉增量 ================= */
      if (p === '/api/sync' && request.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const limit = Math.min(Number(url.searchParams.get('limit') || 2000) || 2000, 5000);
        const module = url.searchParams.get('module');

        let sql = 'SELECT id, module, cat, data, rev, updated_at, deleted FROM records WHERE updated_at > ?';
        const binds = [since];
        if (module) { sql += ' AND module = ?'; binds.push(module); }
        sql += ' ORDER BY updated_at ASC LIMIT ?';
        binds.push(limit);

        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const rows = (results || []).map((r) => ({
          id: r.id,
          module: r.module,
          cat: r.cat,
          rev: r.rev,
          updated_at: r.updated_at,
          deleted: !!r.deleted,
          data: safeParse(r.data),
        }));
        const serverTime = Date.now();
        return json({
          ok: true,
          since,
          serverTime,
          /* 还有没有更多：有的话客户端拿 nextSince 接着拉 */
          hasMore: rows.length >= limit,
          nextSince: rows.length ? rows[rows.length - 1].updated_at : since,
          count: rows.length,
          rows,
        });
      }

      /* ================= 记录：全量计数（客户端用来对账） ================= */
      if (p === '/api/stats' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT module, COUNT(*) AS n FROM records WHERE deleted = 0 GROUP BY module'
        ).all();
        const total = await env.DB.prepare(
          'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM records WHERE deleted = 0'
        ).first();
        return json({ ok: true, byModule: results || [], total: total?.n || 0, lastUpdate: total?.last || 0 });
      }

      /* ================= 记录：新增 / 整条覆盖 ================= */
      if (p === '/api/records' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !body.id) return fail('需要 id');
        const now = Date.now();
        const device = String(body.device || 'unknown').slice(0, 40);
        const module = String(body.module || 'collection');
        const cat = body.cat == null ? null : String(body.cat);
        const data = JSON.stringify(body.data || {});
        const id = String(body.id);

        const cur = await env.DB.prepare('SELECT rev FROM records WHERE id = ?').bind(id).first();
        const rev = cur ? (cur.rev || 1) + 1 : 1;
        await env.DB.prepare(
          `INSERT INTO records (id, module, cat, data, rev, updated_at, deleted, device)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             module = excluded.module, cat = excluded.cat, data = excluded.data,
             rev = excluded.rev, updated_at = excluded.updated_at,
             deleted = 0, device = excluded.device`
        ).bind(id, module, cat, data, rev, now, device).run();

        return json({ ok: true, id, rev, updated_at: now });
      }

      /* ================= 记录：批量上传（桌面端全量/增量同步走这里） =================
       *
       * 为什么需要它：逐条 POST /api/records 的话，1414 条记录要发 1414 个请求，
       * 又慢又脆（中途断一次得重来）。这里用 D1 的 batch() 一次写多条。
       *
       * 两个刻意的设计：
       *   1) rev 用 `records.rev + 1` 在 SQL 里自增，而不是先 SELECT 再累加。
       *      省一次查询，也避开「单查询最多 100 个绑定参数」的限制
       *      （如果先 SELECT ... WHERE id IN (?,?,...)，100 条就正好顶到上限）。
       *   2) 每条语句 6 个参数，服务端单次上限 100 条 —— 客户端按 50 条分块发，
       *      双保险，任何一边改坏了另一边还能兜住。
       *
       * body: { records:[{id,module,cat,data}], deletes:["id1","id2"], device }
       */
      if (p === '/api/records-batch' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return fail('请求体不是合法 JSON');

        const MAX_ONE_CALL = 100;
        const list = Array.isArray(body.records) ? body.records.slice(0, MAX_ONE_CALL) : [];
        const del = Array.isArray(body.deletes) ? body.deletes.slice(0, MAX_ONE_CALL) : [];
        if (!list.length && !del.length) {
          return json({ ok: true, saved: 0, deleted: 0, updated_at: Date.now() });
        }

        for (const r of list) {
          if (!r || !r.id) return fail('每条记录都需要 id');
        }

        const now = Date.now();
        const device = String(body.device || 'unknown').slice(0, 40);
        const stmts = [];

        for (const r of list) {
          stmts.push(env.DB.prepare(
            `INSERT INTO records (id, module, cat, data, rev, updated_at, deleted, device)
             VALUES (?, ?, ?, ?, 1, ?, 0, ?)
             ON CONFLICT(id) DO UPDATE SET
               module = excluded.module, cat = excluded.cat, data = excluded.data,
               rev = records.rev + 1, updated_at = excluded.updated_at,
               deleted = 0, device = excluded.device`
          ).bind(
            String(r.id),
            String(r.module || 'collection'),
            r.cat == null ? null : String(r.cat),
            JSON.stringify(r.data || {}),
            now, device
          ));
        }

        /* 删除也走同一批：软删除，让别的设备知道「这条没了」 */
        for (const id of del) {
          stmts.push(env.DB.prepare(
            `UPDATE records SET deleted = 1, rev = rev + 1, updated_at = ?, device = ?
             WHERE id = ?`
          ).bind(now, device, String(id)));
        }

        await env.DB.batch(stmts);
        return json({ ok: true, saved: list.length, deleted: del.length, updated_at: now });
      }

      /* ================= 记录：字段级合并（手机端轻量改走这里） ================= */
      if (p.startsWith('/api/records/') && request.method === 'PATCH') {
        const id = decodeURIComponent(p.slice('/api/records/'.length));
        const body = await request.json().catch(() => null);
        if (!body || !body.patch || typeof body.patch !== 'object') return fail('需要 patch 对象');

        const cur = await env.DB.prepare(
          'SELECT module, cat, data, rev, updated_at, deleted FROM records WHERE id = ?'
        ).bind(id).first();
        if (!cur) return fail('记录不存在：' + id, 404);

        const curData = safeParse(cur.data) || {};
        const base = (body.base && typeof body.base === 'object') ? body.base : null;
        const patch = body.patch;
        const applied = {}, conflicts = {};

        for (const k of Object.keys(patch)) {
          if (base && Object.prototype.hasOwnProperty.call(base, k)) {
            const same = JSON.stringify(base[k]) === JSON.stringify(curData[k] ?? null);
            if (!same) { conflicts[k] = { mine: patch[k], theirs: curData[k] ?? null }; continue; }
          }
          applied[k] = patch[k];
        }

        /* 一个字段都合并不进去 → 让用户来定，不改库 */
        if (!Object.keys(applied).length && Object.keys(conflicts).length) {
          return json({ ok: false, reason: 'conflict', conflicts, record: { id, rev: cur.rev, data: curData } }, 409);
        }

        const next = { ...curData, ...applied };
        const now = Date.now();
        const rev = (cur.rev || 1) + 1;
        const device = String(body.device || 'unknown').slice(0, 40);
        await env.DB.prepare(
          'UPDATE records SET data = ?, rev = ?, updated_at = ?, device = ? WHERE id = ?'
        ).bind(JSON.stringify(next), rev, now, device, id).run();

        return json({
          ok: true, id, rev, updated_at: now,
          applied: Object.keys(applied),
          conflicts,
          record: { id, rev, data: next },
        });
      }

      /* ================= 记录：删除（软删除，让别的设备知道） ================= */
      if (p.startsWith('/api/records/') && request.method === 'DELETE') {
        const id = decodeURIComponent(p.slice('/api/records/'.length));
        const cur = await env.DB.prepare('SELECT rev FROM records WHERE id = ?').bind(id).first();
        if (!cur) return fail('记录不存在：' + id, 404);
        const now = Date.now();
        const rev = (cur.rev || 1) + 1;
        await env.DB.prepare(
          'UPDATE records SET deleted = 1, rev = ?, updated_at = ?, device = ? WHERE id = ?'
        ).bind(rev, now, String(url.searchParams.get('device') || 'unknown').slice(0, 40), id).run();
        return json({ ok: true, id, rev, updated_at: now });
      }

      /* ================= meta（字段布局 / 自定义字段等配置） ================= */
      if (p === '/api/meta' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT k, v, updated_at FROM meta').all();
        const out = {};
        (results || []).forEach((r) => { out[r.k] = safeParse(r.v); });
        return json({ ok: true, meta: out });
      }
      if (p === '/api/meta' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !body.key) return fail('需要 key');
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO meta (k, v, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
        ).bind(String(body.key), JSON.stringify(body.value ?? null), now).run();
        return json({ ok: true, key: body.key, updated_at: now });
      }

      /* ================= 图片：R2 读写 ================= */
      if (p.startsWith('/api/img/')) {
        const key = decodeURIComponent(p.slice('/api/img/'.length));
        if (!key || key.includes('..')) return fail('非法路径');

        if (request.method === 'GET' || request.method === 'HEAD') {
          const obj = await env.IMG.get(key);
          if (!obj) return new Response('not found', { status: 404, headers: CORS });
          const h = new Headers(CORS);
          h.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
          h.set('etag', obj.httpEtag);
          /* 封面是不可变的（内容变了就换文件名），所以可以长缓存 */
          h.set('cache-control', 'public, max-age=31536000, immutable');
          return new Response(request.method === 'HEAD' ? null : obj.body, { headers: h });
        }

        if (request.method === 'PUT' || request.method === 'POST') {
          const buf = await request.arrayBuffer();
          if (!buf.byteLength) return fail('空文件');
          const ctype = request.headers.get('content-type') || 'image/webp';
          await env.IMG.put(key, buf, { httpMetadata: { contentType: ctype } });
          return json({ ok: true, key, size: buf.byteLength });
        }
        return fail('不支持的方法', 405);
      }

      /* ================= 图片：批量上传（桌面端同步用） ================= */
      if (p === '/api/img-batch' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.items)) return fail('需要 items 数组');
        let ok = 0;
        const failed = [];
        for (const it of body.items) {
          try {
            if (!it || !it.key || typeof it.data !== 'string') { failed.push(it && it.key); continue; }
            const bin = Uint8Array.from(atob(it.data), (c) => c.charCodeAt(0));
            await env.IMG.put(it.key, bin, {
              httpMetadata: { contentType: it.type || 'image/webp' },
            });
            ok++;
          } catch (e) { failed.push(it && it.key); }
        }
        return json({ ok: true, uploaded: ok, failed });
      }

      /* ================= ISBN 查书（服务端代查） =================
       *
       * 为什么必须放在服务端：
       *   openlibrary.org / covers.openlibrary.org / r.jina.ai 在国内全部被
       *   DNS 污染（解析成 face:b00c 那个假 IP），直连和代理两条路都不通。
       *   Cloudflare 不在墙内，从这里 fetch 完全正常。
       *   → 这一步顺便把电脑端那个坏掉的查书功能也修好了。
       *
       * 返回结构刻意和客户端 lookupBookByISBN 一致（中文键），才能直接替换：
       *   { ISBN, _src, 名称, 作者, 出版社, 出版年, 封面 }
       * 「封面」指向我们自己的 /api/isbn-cover/{id}，因为 covers.openlibrary.org
       * 同样被墙，直接给原地址的话图片加载不出来。
       *
       * 三个数据源依次兜底：/api/books（一次带全）→ /isbn/{isbn}.json → /search.json
       */
      if (p.startsWith('/api/isbn/') && request.method === 'GET') {
        const isbn = normIsbn(decodeURIComponent(p.slice('/api/isbn/'.length)));
        if (!isbn) return fail('ISBN 不合法（应为 10 位或 13 位）');

        const self = url.origin;
        const book = { ISBN: isbn, _src: '', 名称: '', 作者: '', 出版社: '', 出版年: '', 封面: '' };
        let coverId = '';
        const errs = [];

        async function ol(url2) {
          try {
            const r = await fetch(url2, {
              headers: { Accept: 'application/json', 'User-Agent': 'life-desk-sync/1.0' },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!r.ok) { errs.push('HTTP ' + r.status); return null; }
            return await r.json();
          } catch (e) {
            errs.push(String(e && e.message ? e.message : e));
            return null;
          }
        }
        function year(v) { const m = String(v || '').match(/\d{4}/); return m ? m[0] : ''; }

        /* ① /api/books?bibkeys —— 一次就带回书名/作者/出版社/年份/封面 */
        const bk = await ol('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data');
        const one = bk && bk['ISBN:' + isbn];
        if (one) {
          book.名称 = String(one.title || '').trim();
          if (one.authors && one.authors.length) {
            book.作者 = one.authors.map((a) => String((a && a.name) || '').trim()).filter(Boolean).join(' / ');
          }
          if (one.publishers && one.publishers.length) book.出版社 = String((one.publishers[0] || {}).name || '').trim();
          book.出版年 = year(one.publish_date);
          if (one.cover) coverId = coverIdOf(one.cover.large || one.cover.medium || '');
          if (book.名称) book._src = 'Open Library';
        }

        /* ② 兜底：edition 记录。作者挂在 work 上，要再查一次 */
        if (!book.名称) {
          const ed = await ol('https://openlibrary.org/isbn/' + isbn + '.json');
          if (ed && ed.title) {
            book.名称 = String(ed.title).trim();
            if (ed.publishers && ed.publishers.length) book.出版社 = String(ed.publishers[0]).trim();
            book.出版年 = year(ed.publish_date);
            if (ed.covers && ed.covers.length) coverId = String(ed.covers[0]);
            book._src = 'Open Library';
            const wk = ed.works && ed.works[0] && ed.works[0].key;
            if (wk) {
              const w = await ol('https://openlibrary.org' + wk + '.json');
              const keys = ((w && w.authors) || [])
                .map((a) => a && a.author && a.author.key).filter(Boolean).slice(0, 3);
              if (keys.length) {
                const names = await Promise.all(keys.map((k) =>
                  ol('https://openlibrary.org' + k + '.json').then((a) => a && a.name)));
                book.作者 = names.filter(Boolean).join(' / ');
              }
            }
          }
        }

        /* ③ 再兜底：全文搜索（命中率略高，但字段少） */
        if (!book.名称) {
          const sr = await ol('https://openlibrary.org/search.json?q=isbn:' + isbn
            + '&fields=title,author_name,publish_date,publisher,cover_i&limit=1');
          const doc = sr && sr.docs && sr.docs[0];
          if (doc && doc.title) {
            book.名称 = String(doc.title).trim();
            book.作者 = (doc.author_name || []).slice(0, 3).join(' / ');
            book.出版社 = (doc.publisher && doc.publisher[0]) || '';
            book.出版年 = year(doc.publish_date);
            if (doc.cover_i) coverId = String(doc.cover_i);
            book._src = 'Open Library 搜索';
          }
        }

        if (!book.名称) {
          /* 查不到不算错误（很多中文书 OpenLibrary 确实没有），但把上游报错带回去便于排查 */
          return json({ ok: true, found: false, isbn, book: null, upstream: errs.slice(0, 3) });
        }
        if (coverId) book.封面 = self + '/api/isbn-cover/' + coverId;
        return json({ ok: true, found: true, book });
      }

      /* ================= 封面中转 =================
       * covers.openlibrary.org 同样被墙，所以图片也由服务端代取。
       * id 只允许纯数字 —— 否则这就成了一个「任意 URL 代理」，
       * 别人能拿它去刷任意地址，属于必须堵掉的口子。
       */
      if (p.startsWith('/api/isbn-cover/') && request.method === 'GET') {
        const id = decodeURIComponent(p.slice('/api/isbn-cover/'.length));
        if (!/^\d{1,12}$/.test(id)) return fail('封面 id 必须是数字');
        try {
          const r = await fetch('https://covers.openlibrary.org/b/id/' + id + '-L.jpg', {
            headers: { Accept: 'image/*' },
            cf: { cacheTtl: 604800, cacheEverything: true },
          });
          if (!r.ok) return fail('封面不存在', 404);
          /* OpenLibrary 对没有封面的书会返回一张 1x1 占位图，且状态码是 200。
             靠体积挡掉，免得占位图被当成真封面存进记录。 */
          const len = Number(r.headers.get('content-length') || 0);
          if (len && len < 1000) return fail('封面不存在（占位图）', 404);
          return new Response(r.body, {
            status: 200,
            headers: {
              'content-type': r.headers.get('content-type') || 'image/jpeg',
              'cache-control': 'public, max-age=604800',
              'access-control-allow-origin': '*',
            },
          });
        } catch (e) {
          return fail('取封面失败：' + (e && e.message ? e.message : e), 502);
        }
      }

      return fail('未知接口：' + p, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

function safeParse(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* ISBN 归一化 + 校验。客户端传什么都不该信，服务端必须自己再校验一遍。
   去掉横杠和空格，10 位（末位可能是 X）和 13 位都收。 */
function normIsbn(s) {
  const t = String(s == null ? '' : s).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (t.length === 13) return /^\d{13}$/.test(t) ? t : '';
  if (t.length === 10) return /^\d{9}[\dX]$/.test(t) ? t : '';
  return '';
}

/* 从 covers.openlibrary.org 的地址里抠出封面 id：
   https://covers.openlibrary.org/b/id/11973290-L.jpg → "11973290" */
function coverIdOf(u) {
  const m = String(u || '').match(/\/b\/id\/(\d+)/);
  return m ? m[1] : '';
}
