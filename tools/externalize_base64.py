#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
externalize_base64.py —— 把主索引里内嵌的 base64 封面外置成真实图片文件

背景
----
app.js 的 storageSaveV2() 只对「已建分片的类目」调用 externalizeImages()，
而 __main 里的未分片记录（如 大类=手办/毛绒 但 小类 为空的那批）永远走不到那一步，
于是它们的封面一直以 data:image/...;base64 的形式内嵌在 lifedesk.json 里。
lifedesk.json 因此从 ~200KB 膨胀到 2.3MB，手机端每次打开都要整份下载。

这个脚本做三件事：
  1. 解码 base64，按项目既有约定落盘：
       data/orig/<目录>/<名>.jpg      原始字节（高清存档，桌面专用）
       data/images/<目录>/<名>.webp   最长边 800px，WebP
       data/thumbs/<目录>/<名>.webp   最长边 400px，WebP
  2. 把记录里的 imageUrl 换成相对路径 data/images/<目录>/<名>.webp
  3. 同步更新 data/images/_index.json 的去重索引（bySrc / byHash / files）

目录与命名规则完全照抄 app.js：
  - coverBaseParts(cat, row)：记录有「系列」→ series/{cat}-封面-01/，否则 {cat}-封面/
  - 文件名：{cat}-{条目名}-{0001}.webp（编号在该文件夹内取现有最大值 +1）
  - hashBytes()：FNV-1a 32 位，取低 8 位十六进制

用法
----
    python tools/externalize_base64.py            # 空转，只打印计划
    python tools/externalize_base64.py --apply    # 真正执行（会先写 .bak 备份）
"""
import base64
import json
import os
import re
import shutil
import sys
import datetime

from PIL import Image
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
INDEX_FILE = os.path.join(DATA, 'lifedesk.json')
IMG_INDEX_FILE = os.path.join(DATA, 'images', '_index.json')

IMG_FIELDS = ['封面', '照片', 'IP图像', '系列封面', '图片']
STR_IMG_FIELDS = ['封面图片']

IMG_MAX = 800
THUMB_MAX = 400
IMG_Q = 88
THUMB_Q = 75

APPLY = '--apply' in sys.argv


def safe_file_name(s):
    """对应 app.js 的 safeFileName()：去非法字符、限长 60"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', str(s or '')).strip()
    return s[:60] or '未命名'


def hash_bytes(u8):
    """对应 app.js 的 hashBytes()：FNV-1a 32 位"""
    h = 0x811c9dc5
    for b in u8:
        h ^= b
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) & 0xFFFFFFFF
    return ('00000000' + format(h, 'x'))[-8:]


def row_display_name(r):
    for k in ['名称', '计划', '地点', '店名', '菜名', '菜谱名', 'IP名称', '系列名称', '地点名称', '内容']:
        v = str(r.get(k) or '').strip()
        if v:
            return safe_file_name(v)
    return ''


def cover_dir_parts(cat, row):
    """对应 coverBaseParts() + series 分文件夹规则"""
    base = safe_file_name(cat) + '-封面'
    if str(row.get('系列') or '').strip():
        return ['series', base + '-01']
    return [base]


def max_seq(folder):
    """对应 scanMaxImageSeqFor()：扫 -数字.扩展名 取最大"""
    if not os.path.isdir(folder):
        return 0
    mx = 0
    for name in os.listdir(folder):
        m = re.search(r'-(\d+)\.[^.]+$', name)
        if m:
            v = int(m.group(1))
            if v > mx:
                mx = v
    return mx


def fit(im, max_side):
    w, h = im.size
    if max(w, h) <= max_side:
        return im
    scale = max_side / float(max(w, h))
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def main():
    idx = json.load(open(INDEX_FILE, encoding='utf-8'))
    img_index = json.load(open(IMG_INDEX_FILE, encoding='utf-8')) if os.path.exists(IMG_INDEX_FILE) else \
        {'schema': 1, 'bySrc': {}, 'byHash': {}, 'files': {}}
    for k in ('bySrc', 'byHash', 'files'):
        img_index.setdefault(k, {})

    main_tables = idx.get('__main') or {}
    plan = []
    seq_cache = {}

    for module, rows in main_tables.items():
        if not isinstance(rows, list):
            continue
        for r in rows:
            if not isinstance(r, dict):
                continue
            targets = []
            for f in IMG_FIELDS:
                arr = r.get(f)
                if isinstance(arr, list):
                    for it in arr:
                        if isinstance(it, dict):
                            targets.append((it, 'imageUrl'))
            for f in STR_IMG_FIELDS:
                if isinstance(r.get(f), str) and r[f].startswith('data:image/'):
                    targets.append((r, f))
            for holder, key in targets:
                u = holder.get(key) or ''
                if not u.startswith('data:image/'):
                    continue
                head, _, b64 = u.partition(',')
                ext_src = 'png' if 'image/png' in head else 'jpg'
                try:
                    raw = base64.b64decode(b64)
                except Exception as e:
                    print('  !! 解码失败 %s: %s' % (r.get('名称'), e))
                    continue
                cat = str(r.get('大类') or module or 'collection').strip() or 'collection'
                parts = cover_dir_parts(cat, r)
                folder_key = '/'.join(parts)
                if folder_key not in seq_cache:
                    seq_cache[folder_key] = max_seq(os.path.join(DATA, 'images', *parts))
                seq_cache[folder_key] += 1
                seq = seq_cache[folder_key]
                dn = row_display_name(r)
                stem = safe_file_name(cat) + '-' + (dn + '-' if dn else '') + '%04d' % seq
                plan.append({
                    'module': module, 'name': r.get('名称'), 'cat': cat,
                    'parts': parts, 'stem': stem, 'ext_src': ext_src,
                    'raw': raw, 'holder': holder, 'key': key, 'seq': seq,
                    'old': u,
                })

    total_raw = sum(len(p['raw']) for p in plan)
    print('=' * 74)
    print('计划外置 %d 张内嵌封面，原始字节合计 %.1f KB' % (len(plan), total_raw / 1024))
    print('=' * 74)
    for p in plan:
        rel = 'data/images/%s/%s.webp' % ('/'.join(p['parts']), p['stem'])
        print('  %-12s %-16s -> %s' % (str(p['name'])[:12], p['cat'], rel))
    print()
    if not plan:
        print('没有需要外置的内嵌封面。')
        return
    if not APPLY:
        print('（空转模式，未写入任何文件。加 --apply 真正执行）')
        return

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    shutil.copy2(INDEX_FILE, INDEX_FILE + '.bak-ext' + stamp)
    if os.path.exists(IMG_INDEX_FILE):
        shutil.copy2(IMG_INDEX_FILE, IMG_INDEX_FILE + '.bak-ext' + stamp)
    print('已备份：lifedesk.json.bak-ext%s' % stamp)

    saved_img = saved_thumb = 0
    for p in plan:
        parts = p['parts']
        stem = p['stem']
        # orig：原始字节
        d_orig = os.path.join(DATA, 'orig', *parts)
        os.makedirs(d_orig, exist_ok=True)
        with open(os.path.join(d_orig, stem + '.' + p['ext_src']), 'wb') as f:
            f.write(p['raw'])
        # images / thumbs：转 WebP
        im = Image.open(io.BytesIO(p['raw']))
        if im.mode not in ('RGB', 'RGBA'):
            im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
        d_img = os.path.join(DATA, 'images', *parts)
        d_th = os.path.join(DATA, 'thumbs', *parts)
        os.makedirs(d_img, exist_ok=True)
        os.makedirs(d_th, exist_ok=True)
        big = fit(im, IMG_MAX)
        big.save(os.path.join(d_img, stem + '.webp'), 'WEBP', quality=IMG_Q, method=6)
        small = fit(im, THUMB_MAX)
        small.save(os.path.join(d_th, stem + '.webp'), 'WEBP', quality=THUMB_Q, method=6)
        saved_img += 1
        saved_thumb += 1

        rel = 'data/images/%s/%s.webp' % ('/'.join(parts), stem)
        p['holder'][p['key']] = rel

        h = hash_bytes(p['raw'])
        img_index['files'][rel] = {
            'hash': h, 'src': p['old'], 'size': len(p['raw']),
            'ext': 'webp', 'added': datetime.date.today().isoformat(),
        }
        img_index['bySrc'][p['old']] = rel
        img_index['byHash'][h] = rel

    with open(INDEX_FILE, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)
    with open(IMG_INDEX_FILE, 'w', encoding='utf-8') as f:
        json.dump(img_index, f, ensure_ascii=False)

    new_size = os.path.getsize(INDEX_FILE)
    print('完成：写入 images %d 张、thumbs %d 张' % (saved_img, saved_thumb))
    print('lifedesk.json 现在 %.1f KB' % (new_size / 1024))


if __name__ == '__main__':
    main()
