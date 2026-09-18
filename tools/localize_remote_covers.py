#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
localize_remote_covers.py —— 把记录里指向外网的封面（豆瓣等）落成本地文件

为什么要做：
  手机端要能离线看，桌面端要能秒开。封面如果还是 https://img9.doubanio.com/...
  这种外链，一旦对方防盗链、图床挂了、或者手机没网，封面就是一片空白。
  正常路径是 App 自己（externalizeImages）在保存时下载落地，但历史数据里
  可能残留外链，本脚本就是补这个漏。

处理策略（对每条外链封面）：
  1) 先在 data/images/**-封面/ 里按「文件名包含该条记录名称」找现成本地图。
     找到就直接把 JSON 指过去 —— 这种情况很常见：记录被删过又恢复，
     但封面文件还留在磁盘上，不用重新下载。
  2) 找不到就下载 → 转 WebP → 落到 data/images/<封面目录>/<目录名>-<名称>-NNNN.webp
     封面目录按「标签分类 / 小分类 / 大类 + -封面」推断，找不到就落到「<大类>-封面」。

用法（在项目根目录执行）：
    python tools/localize_remote_covers.py            # 干跑，只报告
    python tools/localize_remote_covers.py --apply    # 真正写入

写盘前会备份所有被改动的 JSON（.bak-cover<时间>）。
"""

import json
import os
import re
import shutil
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
IMAGES = os.path.join(DATA, 'images')
INDEX = os.path.join(DATA, 'lifedesk.json')
IMG_INDEX = os.path.join(IMAGES, '_index.json')

DRY = True
STAMP = time.strftime('%Y%m%d-%H%M%S')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

IMG_FIELDS = ['封面', '照片', '图片', '海报', '封面图']


def log(*a):
    print(*a)


def load(p):
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return json.load(f)


def dump(p, o):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(o, ensure_ascii=False, indent=2))


def backup(p):
    b = p + '.bak-cover' + STAMP
    if not os.path.exists(b):
        shutil.copy2(p, b)
    return b


def safe_name(s):
    """对齐 app.js 的 safeFileName：去掉路径分隔符与非法字符。"""
    s = str(s or '')
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', '', s)
    return s.strip()


def all_cover_dirs():
    if not os.path.isdir(IMAGES):
        return []
    return [d for d in os.listdir(IMAGES)
            if d.endswith('-封面') and os.path.isdir(os.path.join(IMAGES, d))]


def find_existing(name, dirs):
    """在封面目录里按文件名找现成图，返回 data/ 相对路径或 None。

    匹配规则（放宽，因为历史改名很常见）：
      文件名去掉「<目录前缀>-」和「-NNNN.ext」后得到「图上的名字」，
      只要它与记录名称互为前缀（任一方包含另一方的前 6 个字以上）就算命中。
    例：记录名「词根溯源解码 …让词汇记忆更有规律」
        文件名「英语-词根溯源解码 …掌握一个词根，串联一组单词-0001.webp」
        图上名字是记录名的前缀 → 命中。
    """
    key = safe_name(name)
    if not key:
        return None
    hits = []
    for d in dirs:
        full = os.path.join(IMAGES, d)
        if not os.path.isdir(full):
            continue
        # 目录名 "英语-封面" → 文件名前缀 "英语-"
        dir_prefix = d[:-len('-封面')] + '-'
        for fn in os.listdir(full):
            stem = os.path.splitext(fn)[0]
            if stem.startswith(dir_prefix):
                stem = stem[len(dir_prefix):]
            stem = re.sub(r'-\d{4}$', '', stem)
            if not stem:
                continue
            if stem == key or stem.startswith(key) or key.startswith(stem):
                hits.append('data/images/%s/%s' % (d, fn))
    if not hits:
        return None
    hits.sort()
    return hits[0]


def guess_cover_dir(shard_dir, row):
    """推断封面目录名（带 -封面 后缀）。

    优先级对齐 app.js 的 coverDirFromDataRel：
      1) 分片文件推导出来的目录（书籍/英语-data.json → 英语-封面）
      2) 小分类 / 标签分类 / 大类 + -封面（仅当该目录已存在）
      3) 大类 + -封面（不存在则新建）
    """
    cands = []
    if shard_dir:
        cands.append(shard_dir)
    for k in ('小分类', '标签分类', '分类', '大类', '模块'):
        v = safe_name(row.get(k))
        if v:
            cands.append(v + '-封面')
    for c in cands:
        if os.path.isdir(os.path.join(IMAGES, c)):
            return c
    # 都没有就新建「大类-封面」
    v = safe_name(row.get('大类')) or '未分类'
    return v + '-封面'


def next_seq(dirname):
    full = os.path.join(IMAGES, dirname)
    mx = 0
    if os.path.isdir(full):
        for fn in os.listdir(full):
            m = re.search(r'-(\d{4})\.\w+$', fn)
            if m:
                mx = max(mx, int(m.group(1)))
    return mx + 1


def download(url):
    """下载图片字节。

    坑：豆瓣对「不像浏览器」的请求会返回一段 988 字节的防盗链 HTML
    （<script>function ...），HTTP 状态仍是 200，字节也不是图片。
    所以这里补齐浏览器常用头，并且下载后校验确实是图片（JPEG/PNG/GIF/WebP/BMP）。
    """
    import urllib.error

    hdrs = {
        'User-Agent': UA,
        'Referer': 'https://book.douban.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
    }

    def looks_like_image(b):
        if len(b) < 256:
            return False
        return (b[:3] == b'\xff\xd8\xff' or b[:8] == b'\x89PNG\r\n\x1a\n'
                or b[:6] in (b'GIF87a', b'GIF89a')
                or (b[:4] == b'RIFF' and b[8:12] == b'WEBP')
                or b[:2] == b'BM')

    def via_urllib():
        req = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def via_curl():
        import subprocess
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix='.img')
        os.close(fd)
        try:
            rc = subprocess.call(['curl', '-sL', '--max-time', '40',
                                  '-A', UA, '-e', 'https://book.douban.com/',
                                  '-o', tmp, url])
            if rc != 0:
                return b''
            with open(tmp, 'rb') as f:
                return f.read()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    for attempt in (via_urllib, via_curl):
        try:
            b = attempt()
        except Exception:
            b = b''
        if looks_like_image(b):
            return b
    return b''


def to_webp(raw, dest_path):
    """把字节转成 WebP 落盘；失败返回 False。"""
    from PIL import Image
    import io
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGB')
    im.save(dest_path, 'WEBP', quality=90, method=6)
    return True


def scan_remote():
    """遍历所有分片 + __main。

    返回 (objs, items)：
      objs  —— {绝对路径: 解析后的 JSON 对象}，改完直接按这个序列化回去
      items —— [(文件绝对路径, row, 字段, 索引, url), ...]
    """
    idx = load(INDEX)
    objs = {INDEX: idx}
    files = []
    for _c, d in (idx.get('shards') or {}).items():
        if isinstance(d, dict) and d.get('file'):
            files.append(d['file'])
    files += [f for f in (idx.get('entityFiles') or []) if isinstance(f, str)]

    out = []

    def scan_rows(rows, path, shard_dir):
        for r in rows:
            if not isinstance(r, dict):
                continue
            for f in IMG_FIELDS:
                arr = r.get(f)
                if not isinstance(arr, list):
                    continue
                for i, it in enumerate(arr):
                    if isinstance(it, dict) and isinstance(it.get('imageUrl'), str) \
                            and it['imageUrl'].startswith('http'):
                        out.append((path, r, f, i, it['imageUrl'], shard_dir))

    for rel in files:
        p = os.path.join(DATA, rel.replace('/', os.sep))
        if not os.path.exists(p):
            continue
        obj = load(p)
        if isinstance(obj, dict) and isinstance(obj.get('rows'), list):
            objs[p] = obj
            # 分片名 → 封面目录：书籍/英语-data.json → 英语-封面
            shard_dir = os.path.basename(rel).replace('-data.json', '') + '-封面'
            scan_rows(obj['rows'], p, shard_dir)

    main = idx.get('__main')
    if isinstance(main, dict):
        for cat, rows in main.items():
            if isinstance(rows, list):
                scan_rows(rows, INDEX, safe_name(cat) + '-封面')
    return objs, out


def main():
    global DRY
    if '--apply' in sys.argv:
        DRY = False

    log('=' * 70)
    log('模式：%s' % ('【干跑】只报告' if DRY else '【写入】会先备份再改'))
    log('=' * 70)

    objs, items = scan_remote()
    if not items:
        log('没有发现外链封面，全部已是本地文件。')
        return 0

    log('发现 %d 处外链封面：\n' % len(items))
    dirs = all_cover_dirs()
    changed_files = set()
    newly_made = []

    for path, row, field, i, url, shard_dir in items:
        name = row.get('名称') or row.get('标题') or '(无名)'
        rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
        log('  · %s' % name)
        log('    文件 %s  字段 %s[%d]' % (rel, field, i))
        log('    外链 %s' % url[:88])

        hit = find_existing(name, dirs)
        if hit:
            log('    → 磁盘上已有现成图，直接引用：%s' % hit)
            if not DRY:
                row[field][i]['imageUrl'] = hit
                changed_files.add(path)
            continue

        # 需要下载
        dname = guess_cover_dir(shard_dir, row)
        seq = next_seq(dname)
        fn = '%s-%s-%04d.webp' % (dname[:-len('-封面')], safe_name(name), seq)
        dest_rel = 'data/images/%s/%s' % (dname, fn)
        dest_abs = os.path.join(IMAGES, dname, fn)
        log('    → 磁盘上没有，需下载 → %s' % dest_rel)
        if DRY:
            continue
        try:
            raw = download(url)
        except Exception as e:
            log('      !! 下载失败，保留原链接：%s' % e)
            continue
        if not raw:
            log('      !! 下载回来不是图片（多半被防盗链挡了），保留原链接')
            continue
        os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
        try:
            to_webp(raw, dest_abs)
        except Exception as e:
            log('      !! 转 WebP 失败，保留原链接：%s' % e)
            continue
        row[field][i]['imageUrl'] = dest_rel
        changed_files.add(path)
        newly_made.append(dest_abs)
        log('      已落地 %d B' % os.path.getsize(dest_abs))

    log('\n' + '=' * 70)
    if DRY:
        log('干跑结束。确认无误后加 --apply。')
        return 0

    for p in sorted(changed_files):
        backup(p)
        dump(p, objs[p])
        log('已写入 %s（备份 .bak-cover%s）' % (os.path.relpath(p, ROOT), STAMP))

    if newly_made:
        log('\n新增了 %d 张图，正在补缩略图…' % len(newly_made))
        rc = os.system('"%s" "%s"' % (sys.executable, os.path.join(ROOT, 'tools', 'gen_thumbs.py')))
        log('gen_thumbs.py 退出码 %d' % rc)

    log('=' * 70)
    return 0


if __name__ == '__main__':
    sys.exit(main())
