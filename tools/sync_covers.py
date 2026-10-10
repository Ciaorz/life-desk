# -*- coding: utf-8 -*-
"""
一条命令搞定「新封面 → 手机端可见」的全流程。

背景（为什么需要它）：
  记录和封面是**两条独立的线**——
    · 记录（系列/物品本身）：app 里的「上传」→ Cloudflare D1
    · 封面图片字节：data/thumbs/*.webp → Cloudflare R2（app 不管这件事）
  手机端 USE_THUMBS 恒为 true，只读 data/thumbs 下的 webp。
  所以电脑端新加/换了一张封面之后，如果只点了 app 里的「上传」，
  手机端就会：记录看得到、封面裂图，而点上传还一直回「没有需要上传的改动」。

这个脚本做两件事（等价于手动跑这两条）：
  1) python tools/gen_thumbs.py --missing-only     补出缺失的缩略图
  2) python tools/push_images_to_r2.py --apply     把新缩略图推到 R2

用法：
    python tools/sync_covers.py            # 补缩略图 + 真传
    python tools/sync_covers.py --dry      # 只报告，不真传（推之前先看一眼）
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable or 'python'


def run(args, title):
    print('\n' + '=' * 62)
    print('▶ ' + title)
    print('=' * 62)
    r = subprocess.run([PY] + args, cwd=ROOT)
    return r.returncode == 0


def main():
    dry = '--dry' in sys.argv

    ok1 = run([os.path.join('tools', 'gen_thumbs.py'), '--missing-only'],
              '第 1 步 / 补缺失的缩略图（已有的不动）')
    if not ok1:
        print('\n✗ 第 1 步失败，先看看上面的报错（多半是没装 Pillow：pip install pillow）')
        return 1

    push_args = [os.path.join('tools', 'push_images_to_r2.py')]
    if not dry:
        push_args.append('--apply')
    ok2 = run(push_args, '第 2 步 / 推到 Cloudflare R2' + ('（干跑，不会真传）' if dry else ''))
    if not ok2:
        print('\n✗ 第 2 步失败')
        return 1

    print('\n' + '=' * 62)
    if dry:
        print('✓ 干跑完成。确认无误后去掉 --dry 再来一次。')
    else:
        print('✓ 完成。手机端刷新一次（或点 ⟳）就能看到新封面了。')
        print('  ⚠️ 记录那边如果也改过，记得在 app 里点一次「上传」。')
    print('=' * 62)
    return 0


if __name__ == '__main__':
    sys.exit(main())
