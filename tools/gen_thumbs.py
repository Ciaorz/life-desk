# -*- coding: utf-8 -*-
"""
v95：为 data/images 下的封面生成 WebP 缩略图，输出到平行目录 data/thumbs/。

目的：手机端只同步缩略图（约 15MB）而不是原图（约 132MB），
      配合本地优先架构，让首次同步和浏览都变快。

- 幂等：目标已存在且不比源旧则跳过，可反复运行；新增图片后再跑一次即可。
- 目录结构镜像：data/images/series/xx/a.png -> data/thumbs/series/xx/a.webp
- 用法：python tools/gen_thumbs.py [长边像素，默认 400] [--missing-only]

  --missing-only  只补「完全没有缩略图」的，不去管「有但比源旧」的。
                  什么时候用它：手机上封面改从 Cloudflare R2 取，靠 thumbOf()
                  折算路径，所以「一张都不能少」；而"比源旧"往往只是当年换了
                  编码方式（实测 MAD 5~7，肉眼一样），全量重刷纯属白折腾
                  —— 1269 张要跑十几分钟，还会让 R2/GitHub 平白多出一堆新字节。
"""
import os
import sys
import time
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'images')
DST = os.path.join(ROOT, 'data', 'thumbs')
EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')

# 参数只认纯数字，别把 --missing-only 当成像素值塞进 int()
ONLY_MISSING = '--missing-only' in sys.argv
_nums = [a for a in sys.argv[1:] if a.isdigit()]
LONG_EDGE = int(_nums[0]) if _nums else 400
QUALITY = 82
METHOD = 6  # 压缩越强越慢，6 是速度/体积的较好平衡


def thumb_rel(rel):
    """data/images/series/x/a.png -> series/x/a.webp"""
    base = os.path.splitext(rel)[0]
    return base + '.webp'


def params_file():
    return os.path.join(DST, '.params')


def need_force():
    """尺寸/质量参数变了就要全部重生成（否则会因为「目标比源新」被跳过）。"""
    pf = params_file()
    want = '%d %d' % (LONG_EDGE, QUALITY)
    try:
        with open(pf, 'r', encoding='utf-8') as f:
            return f.read().strip() != want
    except Exception:
        return True


def write_params():
    try:
        os.makedirs(DST, exist_ok=True)
        with open(params_file(), 'w', encoding='utf-8') as f:
            f.write('%d %d' % (LONG_EDGE, QUALITY))
    except Exception as e:
        print('写参数标记失败：%s' % e)


def main():
    if not os.path.isdir(SRC):
        print('找不到源目录：%s' % SRC)
        return 1

    force = need_force()
    if force and ONLY_MISSING:
        print('参数已变更，但 --missing-only 只补缺的，不重刷旧的')
        force = False
    elif force:
        print('参数已变更（或首次运行），将重新生成全部缩略图')

    made = skipped = failed = 0
    src_total = dst_total = 0
    t0 = time.time()

    for dirpath, _dirnames, filenames in os.walk(SRC):
        for fn in filenames:
            if not fn.lower().endswith(EXTS):
                continue
            src_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(src_path, SRC)
            rel = rel.replace('\\', '/')
            out_rel = thumb_rel(rel)
            out_path = os.path.join(DST, *out_rel.split('/'))

            src_size = os.path.getsize(src_path)
            src_total += src_size

            # 幂等：已存在且不比源旧就跳过
            if ONLY_MISSING:
                skip = os.path.exists(out_path)      # 只要在就放过，哪怕比源旧
            elif force:
                skip = False                          # 参数变了 → 全部重刷
            else:
                skip = (os.path.exists(out_path)
                        and os.path.getmtime(out_path) >= os.path.getmtime(src_path))
            if skip:
                dst_total += os.path.getsize(out_path)
                skipped += 1
                continue

            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            try:
                with Image.open(src_path) as im:
                    im.load()
                    w, h = im.size
                    if max(w, h) > LONG_EDGE:
                        scale = LONG_EDGE / float(max(w, h))
                        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                                       Image.LANCZOS)
                    if im.mode not in ('RGB', 'RGBA'):
                        im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
                    im.save(out_path, 'WEBP', quality=QUALITY, method=METHOD)
                dst_total += os.path.getsize(out_path)
                made += 1
                if made % 100 == 0:
                    print('  已生成 %d 张…' % made, flush=True)
            except Exception as e:
                failed += 1
                print('  失败：%s (%s)' % (rel, e))

    write_params()

    def mb(n):
        return '%.1f MB' % (n / 1048576.0)

    print('')
    print('长边 %dpx  质量 %d' % (LONG_EDGE, QUALITY))
    print('新增生成 : %d' % made)
    print('跳过(已有): %d' % skipped)
    print('失败      : %d' % failed)
    print('原图合计  : %s' % mb(src_total))
    print('缩略图合计: %s' % mb(dst_total))
    if src_total:
        print('压缩到    : %.1f%%' % (dst_total * 100.0 / src_total))
    print('耗时      : %.1f 秒' % (time.time() - t0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
