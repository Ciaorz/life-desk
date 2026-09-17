#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
webp_assets.py —— 把站点装饰图（images/*.png|jpg）转成 WebP

背景
----
images/ 目录有 22 MB 的装饰图，其中「藏品馆」的 6 张大类卡片单张 1.4–1.8 MB，
手机端一进藏品馆就要多下约 9 MB。这些图是 PNG（RGBA 无损），体积虚高得厉害。

实测（q85）：
    cat_fluffy.png   1746 KB -> 148 KB   (9%)
    film-cover.png   2935 KB -> 330 KB   (11%)
    idea-sky.png     1745 KB -> 196 KB   (11%)
    study-bg.png      317 KB -> 335 KB   (106%)  ← 本来就已经压得很好的，转完反而更大

所以这里不搞「一刀切全转」，而是逐张判断：
只有 WebP 比原图小 20% 以上才转，否则原样保留。
转完的原始 PNG/JPG 挪到 images/_orig/（已被 .gitignore 排除），确认无误后可自行删除。

用法
----
    python tools/webp_assets.py            # 空转，只打印计划
    python tools/webp_assets.py --apply    # 执行转换（会顺带改写 app.js / style.css 里的引用）
"""
import os
import re
import shutil
import sys
import io

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(ROOT, 'images')
ORIG_DIR = os.path.join(IMAGES, '_orig')
QUALITY = 85
MIN_SAVING = 0.20           # 至少要省 20% 才值得转

# 这两个没有任何引用，直接挪走不转
UNUSED = ['film.png', 'bookcase-cover.png']
# 太小、没必要动的
SKIP_SMALL = ['pin-visited.png', 'sprout-wish.png']

REF_FILES = ['app.js', 'style.css']
APPLY = '--apply' in sys.argv


def webp_bytes(im, q=QUALITY):
    b = io.BytesIO()
    im.save(b, 'WEBP', quality=q, method=6)
    return b.getvalue()


def main():
    srcs = []
    for name in sorted(os.listdir(IMAGES)):
        if not re.search(r'\.(png|jpe?g)$', name, re.I):
            continue
        if name in SKIP_SMALL or name in UNUSED:
            continue
        srcs.append(name)

    plan, skipped = [], []
    for name in srcs:
        p = os.path.join(IMAGES, name)
        orig = os.path.getsize(p)
        try:
            im = Image.open(p)
            if im.mode not in ('RGB', 'RGBA'):
                im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
            data = webp_bytes(im)
        except Exception as e:
            print('  !! 处理失败 %s: %s' % (name, e))
            continue
        if len(data) < orig * (1 - MIN_SAVING):
            plan.append((name, orig, len(data), im.size))
        else:
            skipped.append((name, orig, len(data)))

    print('=' * 78)
    print('将转成 WebP（%d 个）：' % len(plan))
    for name, o, n, size in plan:
        print('  %-26s %5dx%-5d %8.0f KB -> %7.0f KB  (省 %2.0f%%)'
              % (name, size[0], size[1], o / 1024, n / 1024, 100 - 100.0 * n / o))
    tot_o = sum(x[1] for x in plan)
    tot_n = sum(x[2] for x in plan)
    print('  小计 %.1f MB -> %.1f MB（省 %.1f MB）' % (tot_o / 1048576, tot_n / 1048576, (tot_o - tot_n) / 1048576))
    print()
    print('保持原样（转了不划算，%d 个）：' % len(skipped))
    for name, o, n in skipped:
        print('  %-26s %8.0f KB -> %7.0f KB  (省 %2.0f%%)' % (name, o / 1024, n / 1024, 100 - 100.0 * n / o))
    print()
    print('无引用、直接挪走：%s' % ', '.join(UNUSED))
    print('=' * 78)

    if not APPLY:
        print('（空转模式。加 --apply 真正执行）')
        return

    os.makedirs(ORIG_DIR, exist_ok=True)
    mapping = {}
    for name, o, n, size in plan:
        p = os.path.join(IMAGES, name)
        im = Image.open(p)
        if im.mode not in ('RGB', 'RGBA'):
            im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
        out = os.path.splitext(name)[0] + '.webp'
        with open(os.path.join(IMAGES, out), 'wb') as f:
            f.write(webp_bytes(im))
        shutil.move(p, os.path.join(ORIG_DIR, name))
        mapping[name] = out
    for name in UNUSED:
        p = os.path.join(IMAGES, name)
        if os.path.exists(p):
            shutil.move(p, os.path.join(ORIG_DIR, name))

    # 改写引用（按文件名从长到短替换，避免 film.png 抢先命中 film-cover.png 的一部分）
    changed = 0
    for rel in REF_FILES:
        fp = os.path.join(ROOT, rel)
        if not os.path.exists(fp):
            continue
        # 项目里的 app.js / style.css 是 CRLF 换行，必须原样保留，
        # 否则整个文件会被改写成 LF，diff 会变成「全文都改了」。
        # 所以读和写都带 newline=''（不做换行转换）。
        s = open(fp, encoding='utf-8', newline='').read()
        before = s
        for old, new in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
            s = s.replace(old, new)
        if s != before:
            open(fp, 'w', encoding='utf-8', newline='').write(s)
            changed += 1
            print('已更新引用：%s' % rel)

    print()
    print('完成：转换 %d 个文件，改写 %d 个引用文件' % (len(mapping), changed))
    print('原始文件已挪到 images/_orig/（%d 个）' % len(os.listdir(ORIG_DIR)))
    print('images/ 现在 %.1f MB' % (sum(os.path.getsize(os.path.join(IMAGES, f))
                                       for f in os.listdir(IMAGES) if os.path.isfile(os.path.join(IMAGES, f))) / 1048576))


if __name__ == '__main__':
    main()
