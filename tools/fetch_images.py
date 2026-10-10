# -*- coding: utf-8 -*-
"""
fetch_images.py —— 批量抓取图片（主要为淘宝/天猫的 alicdn 图片设计）

用法：
    # 最省事：把清单存成 urls.txt（每行一个地址），然后
    python tools/fetch_images.py urls.txt

    # 常见可选参数
    python tools/fetch_images.py urls.txt --out data/_inbox/pk-badge   # 指定输出目录
    python tools/fetch_images.py urls.txt --resize 800                 # 顺便要 800×800 的缩略图（体积小很多）
    python tools/fetch_images.py names.txt --base https://gw.alicdn.com/bao/uploaded/i1/2214696073021/
    python tools/fetch_images.py urls.txt --numbers                    # 按清单顺序给文件名加 0001- 序号
    python tools/fetch_images.py urls.txt --dry                        # 只报告要下多少，不动手

输入格式自动识别三种：
    ① 纯地址列表（每行一个；# 开头是注释）
    ② JSON 数组（`["url1","url2"]`，可直接用采集脚本复制出来的那段）
    ③ 纯文件名列表（配合 --base 前缀，例如直接从 DevTools 那棵树里复制文件名）

产物：
    输出目录里的图片文件 + `_manifest.json`（记录 地址 / 文件名 / 字节 / 状态，
    之后要把图片和你的条目一一对应时，这份台账很方便）

实测（2026-10-04）：
  · alicdn 不需要 Referer、普通 UA 就能取（拿不存在的路径返回 404 而不是 403 → 没有防盗链）
  · 缩略图语法有效：地址后面接 `_800x800.jpg`（77KB → 21KB）；
    若该缩略图不存在会自动回退成原图，不影响结果
  · `_webp` 后缀只在 `bao/uploaded/...` 那类路径上存在（原本就有的，直接用即可）
"""

import argparse
import concurrent.futures as futures
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif')
CT_EXT = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
          'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif'}
_lock = threading.Lock()
_stat = {'new': 0, 'skip': 0, 'fail': 0, 'bytes': 0}
_fails = []


def log(*a):
    with _lock:
        print(*a, flush=True)


def read_list(path):
    """读清单：支持 JSON 数组 / 纯地址 / 纯文件名。"""
    with io.open(path, encoding='utf-8') as f:
        raw = f.read().strip()
    if not raw:
        return []
    if raw[0] in '[{':
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                out = []
                for x in data:
                    if isinstance(x, str):
                        out.append(x)
                    elif isinstance(x, dict):
                        out.append(x.get('url') or x.get('src') or '')
                return [x for x in out if x]
        except Exception:
            pass
    out = []
    for line in raw.splitlines():
        line = line.strip().strip(',').strip('"').strip("'")
        if not line or line.startswith('#'):
            continue
        out.append(line)
    return out


def build_urls(items, base):
    urls = []
    for it in items:
        if re.match(r'^https?://', it, re.I):
            urls.append(it)
        elif base:
            urls.append(base.rstrip('/') + '/' + it.lstrip('/'))
    return urls


def dedupe(urls, prefer_webp=True):
    """去重；prefer_webp 时同一张图的 .jpg 与 .jpg_webp 只留 WebP 版。"""
    seen, out = set(), []
    for u in urls:
        key = u.split('?')[0]
        if key in seen:
            continue
        seen.add(key)
        out.append(u)
    if prefer_webp:
        has_webp = set(u.split('?')[0][:-len('_webp')] for u in out if u.split('?')[0].endswith('_webp'))
        out = [u for u in out
               if u.split('?')[0].endswith('_webp') or u.split('?')[0] not in has_webp]
    return out


def out_name(url, with_resize=None):
    """由地址推出文件名：`x.jpg_webp` → `x.webp`；非法字符换成 _。"""
    path = urllib.parse.urlparse(url).path
    name = urllib.parse.unquote(path.rsplit('/', 1)[-1]) or 'image'
    if with_resize and re.search(r'_\d+x\d+\.jpe?g$', name, re.I):
        name = re.sub(r'_\d+x\d+\.jpe?g$', '', name, flags=re.I)
    if name.lower().endswith('_webp'):
        # `O1CN01xxx_!!123.jpg_webp` → `O1CN01xxx_!!123.webp`
        # （先去掉 _webp 尾巴，再把 .jpg/.png 换成 .webp，不能直接往末尾拼）
        name = name[:-len('_webp')]
        name = re.sub(r'\.(jpe?g|png)$', '', name, flags=re.I) + '.webp'
    name = re.sub(r'[\\/:*?"<>|]+', '_', name).strip(' .')
    return name or ('image-' + str(int(time.time() * 1000)))


def sized_url(url, n):
    """把地址改成 alicdn 的缩略图形式：去掉已有尺寸/后缀，接上 `_NxN.jpg`。"""
    base = url.split('?')[0]
    base = re.sub(r'_\d+x\d+\.jpe?g$', '', base, flags=re.I)
    base = re.sub(r'_webp$', '', base, flags=re.I)
    return '%s_%dx%d.jpg' % (base, n, n)


def fetch(url, referer=None, timeout=30):
    hdr = {'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8'}
    if referer:
        hdr['Referer'] = referer
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), (r.headers.get('content-type') or '').split(';')[0].strip()


def one(url, args, seq=None):
    name = out_name(url, args.resize)
    if args.numbers and seq:
        name = '%04d-%s' % (seq, name)
    dst = os.path.join(args.out, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 0 and not args.force:
        with _lock:
            _stat['skip'] += 1
        return {'url': url, 'file': name, 'bytes': os.path.getsize(dst), 'status': 'skip'}
    tries = []
    if args.resize:
        tries.append(sized_url(url, args.resize))
    tries.append(url)
    last_err, used = None, None
    for i, u in enumerate(tries):
        for attempt in range(args.retries):
            try:
                data, ctype = fetch(u, args.referer, args.timeout)
                used = u
                break
            except urllib.error.HTTPError as e:
                last_err = 'HTTP %s' % e.code
                if e.code in (400, 401, 403, 404):        # 缩略图不存在 → 直接换原图
                    break
                time.sleep(0.6 * (attempt + 1))
            except Exception as e:
                last_err = str(e)[:60]
                time.sleep(0.6 * (attempt + 1))
        if used:
            break
    if not used:
        with _lock:
            _stat['fail'] += 1
            _fails.append((url, last_err))
        log('   ✗ %-58s %s' % (name[:58], last_err))
        return {'url': url, 'file': name, 'bytes': 0, 'status': 'fail', 'error': last_err}

    if not os.path.splitext(name)[1] or os.path.splitext(name)[1].lower() not in IMG_EXT:
        name += CT_EXT.get(ctype, '.img')
        dst = os.path.join(args.out, name)
    with io.open(dst, 'wb') as f:
        f.write(data)
    with _lock:
        _stat['new'] += 1
        _stat['bytes'] += len(data)
    tag = '' if used == url else '（缩略图）'
    log('   ✓ %-58s %7.1f KB%s' % (name[:58], len(data) / 1024.0, tag))
    return {'url': url, 'file': name, 'bytes': len(data), 'status': 'ok', 'used': used}


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('listfile', help='清单文件：地址列表 / JSON 数组 / 文件名列表')
    ap.add_argument('--out', default=None, help='输出目录（默认 data/_inbox/alicdn-<日期时间>）')
    ap.add_argument('--base', default=None, help='文件名清单用的前缀地址')
    ap.add_argument('--resize', type=int, default=0, metavar='N',
                    help='顺便取 N×N 缩略图（alicdn 语法，如 --resize 800；取不到会自动回退原图）')
    ap.add_argument('--keep-both', action='store_true', help='同一张图的 .jpg 与 .jpg_webp 都下')
    ap.add_argument('--workers', type=int, default=6, help='并发数（默认 6）')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 个（试跑用）')
    ap.add_argument('--retries', type=int, default=3, help='每个地址重试次数（默认 3）')
    ap.add_argument('--timeout', type=int, default=30, help='单次请求超时秒数')
    ap.add_argument('--referer', default=None, help='自定义 Referer（一般不用）')
    ap.add_argument('--force', action='store_true', help='已存在也重下')
    ap.add_argument('--numbers', action='store_true',
                    help='按清单里的顺序给文件名加 4 位序号（0001-xxx.jpg）——'
                         '商品详情图通常是按顺序排的（如全套徽章图按图鉴号），'
                         '加序号后便于按号码对应')
    ap.add_argument('--dry', action='store_true', help='只报告，不下载')
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not args.out:
        args.out = os.path.join(root, 'data', '_inbox',
                                'alicdn-' + time.strftime('%Y%m%d-%H%M'))
    args.out = os.path.abspath(args.out)

    items = read_list(args.listfile)
    urls = dedupe(build_urls(items, args.base), prefer_webp=not args.keep_both)
    if args.limit:
        urls = urls[:args.limit]
    print('=' * 74)
    print('清单：%s' % os.path.relpath(args.listfile, root))
    print('读到 %d 条 → 去重后 %d 个地址' % (len(items), len(urls)))
    print('输出：%s' % os.path.relpath(args.out, root).replace(os.sep, '/'))
    if args.resize:
        print('缩略图：优先取 %d×%d（取不到自动回退原图）' % (args.resize, args.resize))
    print('=' * 74)
    if not urls:
        print('没有可下载的地址。'); return 1
    if args.dry:
        for u in urls[:10]:
            print('   · %s' % out_name(u, args.resize))
        if len(urls) > 10:
            print('   … 其余 %d 个' % (len(urls) - 10))
        print('\n【干跑】未下载。去掉 --dry 即可开始。')
        return 0

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    recs = []
    with futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        for rec in ex.map(lambda t: one(t[1], args, t[0]), enumerate(urls, 1)):
            recs.append(rec)
    dt = time.time() - t0

    man = os.path.join(args.out, '_manifest.json')
    with io.open(man, 'w', encoding='utf-8') as f:
        json.dump({'when': time.strftime('%Y-%m-%d %H:%M:%S'), 'source': os.path.basename(args.listfile),
                   'resize': args.resize, 'items': recs}, f, ensure_ascii=False, indent=1)

    print('-' * 74)
    print('完成：新下 %d ｜ 已存在跳过 %d ｜ 失败 %d ｜ 共 %.1f MB ｜ 用时 %.1f 秒'
          % (_stat['new'], _stat['skip'], _stat['fail'], _stat['bytes'] / 1048576.0, dt))
    print('台账：%s' % os.path.relpath(man, root).replace(os.sep, '/'))
    if _fails:
        print('失败清单（前 10）：')
        for u, e in _fails[:10]:
            print('   %s\n      %s' % (u[:110], e))
    return 1 if _stat['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
