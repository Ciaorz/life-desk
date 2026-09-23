#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""push_images_to_r2.py —— 把本机封面缩略图批量推上 Cloudflare R2
================================================================

为什么只推 data/thumbs（不推 data/images）
------------------------------------------
- 手机端渲染封面时请求的就是 `data/thumbs/**.webp`，原图在手机上根本不会被请求。
  机制：`USE_THUMBS` = localStorage['useThumbs'] 覆盖，否则取 `IS_MOBILE`；
  而 `IS_MOBILE` 读的 `window.__IS_MOBILE__` 是 index.html <head> 里那段设备检测设的，
  app.js 是 body 里**动态插入**加载的（index.html:188），所以顺序没问题、手机上就是 true。
  （别被「app.js 第 4 行就读取了」误导成「永远 false」——那是加载顺序搞反了。）
- 结论：**data/thumbs 里一张都不能少**，少一张手机上就是一张裂图（而且不报错）。
  补缺用：`python tools/gen_thumbs.py --missing-only`（只补缺的，不重刷旧的）。
- `data/thumbs` 实测 1445 个 / 21.7 MB；`data/images` 是 1445 个 / 98 MB（原图）。
  手机根本用不到原图，推上去只是白烧流量和 R2 空间。
- 桌面端是 FSA 模式、直接读本地盘，也不需要云端图。
- 万一以后要原图（比如网页版没有本地目录），再单独跑一次 `--dir data/images` 就行。

key 怎么定
----------
**key 就是记录里存的那条相对路径本身**，例如 `data/thumbs/series/帽子-封面/x.webp`。
这样客户端只要把相对路径 encode 一下拼到 `/api/img/` 后面就完事，两边不用各维护一套映射。

用法
----
    python tools/push_images_to_r2.py                  # 干跑：只报告要传什么
    python tools/push_images_to_r2.py --apply          # 真传（带断点续传）
    python tools/push_images_to_r2.py --verify         # 只核对 R2 上有没有（不发数据）
    python tools/push_images_to_r2.py --apply --force  # 忽略续传记录，全部重传
    python tools/push_images_to_r2.py --only series    # 只传路径里含 series 的

续传
----
已传成功的 key 记在 `tools/.r2_uploaded.json`（key → 字节数）。
再次运行只传不在记录里的。文件大小变了（重新生成过缩略图）也会重传。
这个文件删掉就等于「全部重传」，不影响正确性（R2 put 是覆盖写，幂等）。

⚠️ 这一步【不依赖】worker 的「/api/img 读免认证」改动 —— 上传是写操作，本来就要令牌。
   所以可以先把图传好，等 worker 重新拖上去之后，客户端立刻就能读到。
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE = os.environ.get('CLOUD_BASE', 'https://life-desk-api.pages.dev')
TOKEN_FILE = os.environ.get('TOKEN_FILE', r'E:\自制软件\cloud flare D1 R2.txt')
LEDGER = os.path.join(HERE, '.r2_uploaded.json')
DEFAULT_DIR = 'data/thumbs'
# 每个批次的原文字节上限。base64 会膨胀 4/3，所以 3MB → 约 4MB 的 JSON body。
# Cloudflare Worker 的请求体上限是 100MB，3MB 留了足够余量，又能把 1438 个文件压成十几次请求。
BATCH_BYTES = 3 * 1024 * 1024

TYPES = {
    '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.avif': 'image/avif', '.bmp': 'image/bmp',
}


def log(*a):
    print(*a, flush=True)


def read_token():
    if not os.path.isfile(TOKEN_FILE):
        log('✗ 找不到令牌文件：' + TOKEN_FILE)
        sys.exit(2)
    with open(TOKEN_FILE, encoding='utf-8') as f:
        lines = [l.strip() for l in f if l.strip()]
    return lines[-1]


def http(path, method='GET', body=None, token=None, timeout=180):
    # ⚠️ 这个自定义 UA 不是装饰，是必须的：
    #    Cloudflare 会把 Python 默认 UA（Python-urllib/3.x）当成机器人挡掉，
    #    返回一页 HTML 的 403「error code: 1010」——不是 worker 的响应。
    #    排查时如果看到 1010 / HTML，先怀疑 UA，别怀疑 R2 里的对象。
    headers = {'User-Agent': 'life-desk-r2-push/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:                     # 网络层错误（超时 / 连接被断）
        return 0, str(e).encode('utf-8')


def collect(root_dir):
    """返回 [(key, abs_path, size)]，按 key 排序（让分批结果稳定、可续传）。"""
    base = os.path.join(ROOT, *root_dir.split('/'))
    if not os.path.isdir(base):
        log('✗ 目录不存在：' + base)
        sys.exit(2)
    out = []
    for dirpath, _dirnames, filenames in os.walk(base):
        for fn in filenames:
            if fn.startswith('.'):
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext not in TYPES:
                continue
            ap = os.path.join(dirpath, fn)
            rel = os.path.relpath(ap, ROOT).replace(os.sep, '/')
            try:
                out.append((rel, ap, os.path.getsize(ap)))
            except OSError:
                pass
    out.sort(key=lambda x: x[0])
    return out


def load_ledger():
    if not os.path.isfile(LEDGER):
        return {}
    try:
        with open(LEDGER, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_ledger(d):
    tmp = LEDGER + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, LEDGER)


def make_batches(items):
    """按原文字节预算分批。单个文件超预算也单独成一批（不硬塞）。"""
    batch, size = [], 0
    for it in items:
        if batch and size + it[2] > BATCH_BYTES:
            yield batch
            batch, size = [], 0
        batch.append(it)
        size += it[2]
    if batch:
        yield batch


def do_upload(token, todo, ledger):
    total_files = len(todo)
    total_bytes = sum(x[2] for x in todo)
    done_files = done_bytes = 0
    failed = []

    batches = list(make_batches(todo))
    log('分 %d 批上传（每批原文 ≤ %.1f MB）\n' % (len(batches), BATCH_BYTES / 1048576))

    for bi, batch in enumerate(batches, 1):
        items = []
        for key, ap, _size in batch:
            with open(ap, 'rb') as f:
                raw = f.read()
            items.append({
                'key': key,
                'data': base64.b64encode(raw).decode('ascii'),
                'type': TYPES.get(os.path.splitext(key)[1].lower(), 'image/webp'),
            })
        body = {'items': items}

        ok = False
        last = ''
        for attempt in range(1, 4):
            status, resp = http('/api/img-batch', 'POST', body, token)
            txt = resp.decode('utf-8', 'replace')[:200]
            if status == 200:
                try:
                    j = json.loads(txt)
                except Exception:
                    j = {}
                if j.get('ok'):
                    ok = True
                    bad = j.get('failed') or []
                    for k in bad:
                        failed.append(k)
                    break
                last = 'ok:false ' + txt
            else:
                last = 'HTTP %s %s' % (status, txt)
            if attempt < 3:
                log('   ⚠️ 第 %d 批第 %d 次失败（%s），2 秒后重试…' % (bi, attempt, last))
                time.sleep(2)

        if not ok:
            log('   ✗ 第 %d/%d 批最终失败：%s' % (bi, len(batches), last))
            failed.extend(k for k, _a, _s in batch)
            continue

        for key, _ap, size in batch:
            ledger[key] = size
            done_files += 1
            done_bytes += size
        save_ledger(ledger)                     # 每批落一次盘：中途断了也能续
        log('   ✓ 第 %2d/%d 批  %4d 个 / %6.2f MB   （累计 %d/%d 个，%.1f/%.1f MB）'
            % (bi, len(batches), len(batch), sum(x[2] for x in batch) / 1048576,
               done_files, total_files, done_bytes / 1048576, total_bytes / 1048576))

    return done_files, done_bytes, failed


def do_verify(token, items):
    log('核对 R2（逐个 HEAD，%d 个）…\n' % len(items))
    missing, present, other = [], 0, []
    for i, (key, _ap, size) in enumerate(items, 1):
        path = '/api/img/' + '/'.join(urllib.parse.quote(seg) for seg in key.split('/'))
        status, _ = http(path, 'HEAD', None, token, timeout=30)
        if status in (200, 304):
            present += 1
        elif status == 404:
            missing.append(key)
        else:
            other.append('%s → HTTP %s' % (key, status))
        if i % 200 == 0:
            log('   …已核对 %d/%d' % (i, len(items)))
    log('\n在 R2 上：%d 个' % present)
    log('缺失：%d 个' % len(missing))
    if missing:
        for k in missing[:15]:
            log('   ✗ ' + k)
        if len(missing) > 15:
            log('   …还有 %d 个' % (len(missing) - 15))
    if other:
        log('异常响应：%d 个' % len(other))
        for k in other[:10]:
            log('   ? ' + k)
    return present, missing, other


def main():
    args = sys.argv[1:]
    apply_ = '--apply' in args
    verify = '--verify' in args
    force = '--force' in args
    only = ''
    root_dir = DEFAULT_DIR
    for i, a in enumerate(args):
        if a == '--only' and i + 1 < len(args):
            only = args[i + 1]
        if a == '--dir' and i + 1 < len(args):
            root_dir = args[i + 1].replace('\\', '/').strip('/')

    token = read_token()
    items = collect(root_dir)
    if only:
        items = [x for x in items if only in x[0]]
    if not items:
        log('✗ 没找到可传的图片（目录 %s%s）' % (root_dir, ('，过滤 ' + only) if only else ''))
        sys.exit(1)

    total = sum(x[2] for x in items)
    log('=' * 66)
    log('目标 : %s' % BASE)
    log('目录 : %s' % root_dir)
    log('图片 : %d 个 / %.2f MB' % (len(items), total / 1048576))
    log('模式 : %s' % ('核对 R2' if verify else ('【真传】' if apply_ else '【干跑】只报告')))
    log('=' * 66)

    if verify:
        present, missing, other = do_verify(token, items)
        log('\n' + ('全部都在 R2 上 ✅' if not missing and not other else '有缺口，跑 --apply 补上'))
        sys.exit(0 if (not missing and not other) else 1)

    ledger = load_ledger()
    if force:
        todo = items
        log('\n--force：忽略续传记录，全部重传')
    else:
        todo = [x for x in items if ledger.get(x[0]) != x[2]]
        skipped = len(items) - len(todo)
        if skipped:
            log('\n续传：跳过已传过的 %d 个（大小一致），本次要传 %d 个' % (skipped, len(todo)))

    if not todo:
        log('\n没有需要上传的。核对一下：python tools/push_images_to_r2.py --verify')
        sys.exit(0)

    if not apply_:
        log('\n【干跑】没有上传任何东西。前 8 个示例：')
        for key, _ap, size in todo[:8]:
            log('   %8d B  %s' % (size, key))
        log('\n确认无误后：python tools/push_images_to_r2.py --apply')
        sys.exit(0)

    log('')
    t0 = time.time()
    done_files, done_bytes, failed = do_upload(token, todo, ledger)
    dt = time.time() - t0

    log('\n' + '=' * 66)
    log('上传完成：%d/%d 个 / %.2f MB，用时 %.1f 秒'
        % (done_files, len(todo), done_bytes / 1048576, dt))
    if failed:
        log('失败 %d 个：' % len(failed))
        for k in failed[:20]:
            log('   ✗ ' + k)
        log('再跑一次会自动续传（已成功的不会重传）。')
        sys.exit(1)
    log('建议再核对一次：python tools/push_images_to_r2.py --verify')
    log('=' * 66)


if __name__ == '__main__':
    main()
