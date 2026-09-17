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

    const needAuth = p.startsWith('/api/sync')
      || p.startsWith('/api/records')
      || p.startsWith('/api/img')
      || p.startsWith('/api/meta');
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
