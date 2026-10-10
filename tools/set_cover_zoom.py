# -*- coding: utf-8 -*-
"""
set_cover_zoom.py —— 批量调节「封面在卡片框里的缩放」（就是表单里那个百分比）

背景：每条记录的 `封面[0].viewport = {s,x,y}` 控制它在卡片上的显示：
      s = 缩放系数（1 就是 100%，卡片按 `background-size: 145% auto` 铺图），
      x / y = 左右上下偏移。表单里拖滑杆 / 滚轮缩放，改的就是这个。
      淘宝商品图常是方图，放进 3:4.2 的卡片框里上下留白 →
      要放大到 145% 左右才铺满，但一条条手调太累，所以有这个脚本。

用法
----
    # 1) 先干跑：只打印对照表，一个字都不写
    python tools/set_cover_zoom.py --series "全图鉴金属徽章" --only 22-151 --s 1.45

    # 2) 看着没问题再写
    python tools/set_cover_zoom.py --series "全图鉴金属徽章" --only 22-151 --s 1.45 --apply

参数
----
    --series <名>   目标系列（必填）
    --s      1.45   缩放系数。1.45 = 145%（app 允许 0.5 ~ 1.5）
    --only   A-B    只处理「编号」在这个区间里的（留空＝整个系列）
    --ver    冰箱贴|贴纸   只处理「30周年冰箱贴」的某个版本
    --force         连**已经手工调过**的也一起改成目标值
                    （默认跳过：viewport 存在且 s≠1 的视为你手调过的，不动它）

只改什么
----
    只写 `封面[0].viewport.s`（x / y 原样保留），并给改动的行打新 `_upd`、`_rev+1`。
    不动图片文件、不动别的字段。每个被改的数据文件先备份成 `<文件>.bak-zoom-<时间戳>`。

⚠️ 跑之前先让用户 **完全关闭** 电脑端页面（那页面每 20 秒把内存快照全量回写，会盖掉脚本改动）。
⚠️ 跑完点 ☁上传把记录推到 D1，手机端才会看到。
"""

import argparse
import glob
import io
import json
import os
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
TS = time.strftime('%Y%m%d-%H%M%S')
_touched = set()


def log(*a):
    print(*a, flush=True)


def load(p):
    return json.load(io.open(p, encoding='utf-8'))


def dump(p, obj):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2).replace('\n', '\r\n'))


def backup(p):
    ap = os.path.abspath(p)
    if ap in _touched or not os.path.exists(p):
        return
    _touched.add(ap)
    bak = p + '.bak-zoom-' + TS
    shutil.copy2(p, bak)
    log('  已备份 → %s' % os.path.relpath(bak, ROOT))


def pad4(n):
    return str(n).rjust(4, '0')


def collect_files():
    """返回 [(路径, 容器对象), …]；容器对象改了要写回"""
    out = []
    idx_path = os.path.join(DATA, 'lifedesk.json')
    idx = load(idx_path)
    main = idx.get('__main') or {}
    if isinstance(main, dict):
        for mk, arr in main.items():
            if isinstance(arr, list):
                out.append((idx_path, ('__main', idx, mk), arr))
    for p in sorted(glob.glob(os.path.join(DATA, '**', '*-data.json'), recursive=True)):
        if '_bak' in p:
            continue
        try:
            d = load(p)
        except Exception as e:
            log('[!] 读不了 %s：%s' % (p, e))
            continue
        rows = d.get('rows') if isinstance(d, dict) else d
        if isinstance(rows, list):
            out.append((p, ('shard', d), rows))
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--series', required=True, help='目标系列名')
    ap.add_argument('--s', type=float, default=1.45, help='缩放系数（1.45 = 145%%）')
    ap.add_argument('--only', default='', help='编号区间，如 22-151')
    ap.add_argument('--ver', default='', help='只处理某个版本（如 贴纸）')
    ap.add_argument('--force', action='store_true', help='已经手工调过的也一起改')
    ap.add_argument('--apply', action='store_true', help='真的写盘（默认只干跑）')
    args = ap.parse_args()

    target = round(float(args.s), 2)
    if target < 0.5 or target > 1.5:
        log('[!] 缩放系数必须在 0.5 ~ 1.5 之间（app 的滑杆范围），你给的是 %s' % target)
        return 2

    lo = hi = None
    if args.only:
        m = re.match(r'^\s*(\d+)\s*(?:-\s*(\d+))?\s*$', args.only)
        if not m:
            log('[!] --only 格式应为 A-B，例如 22-151')
            return 2
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo

    files = collect_files()

    hits = []          # (编号, 行, 文件路径, 容器)
    for p, container, rows in files:
        for r in rows:
            if not isinstance(r, dict):
                continue
            if str(r.get('系列') or '').strip() != args.series:
                continue
            if args.ver and str(r.get('版本') or '').strip() != args.ver:
                continue
            no = str(r.get('编号') or '').strip()
            if not no.isdigit():
                continue
            n = int(no)
            if lo is not None and not (lo <= n <= hi):
                continue
            hits.append((n, r, p, container))
    hits.sort(key=lambda x: x[0])

    log('=' * 74)
    log('系列：%s%s' % (args.series, ('（版本=%s）' % args.ver) if args.ver else ''))
    log('范围：%s   目标缩放：%d%%' % (args.only or '整个系列', round(target * 100)))
    log('=' * 74)

    todo, same, tuned, nocover = [], [], [], []
    for n, r, p, container in hits:
        imgs = r.get('封面')
        if not (isinstance(imgs, list) and imgs and isinstance(imgs[0], dict) and imgs[0].get('imageUrl')):
            nocover.append(n)
            continue
        vp = imgs[0].get('viewport') or {}
        s = vp.get('s')
        if s is not None and abs(float(s) - target) < 1e-6:
            same.append((n, r))
            continue
        if s is not None and abs(float(s) - 1.0) > 1e-6 and not args.force:
            tuned.append((n, r, float(s)))
            continue
        todo.append((n, r, p, container, (float(s) if s is not None else None)))

    log('')
    log('对照表（前 20 条）：')
    for n, r, p, container, old in todo[:20]:
        log('  %s  %-10s  %s → %d%%' % (
            pad4(n), r.get('名称') or '?',
            ('%d%%' % round(old * 100)) if old else '默认', round(target * 100)))
    if len(todo) > 20:
        log('  … 还有 %d 条' % (len(todo) - 20))

    log('')
    log('小结：要改 %d 条 ｜ 已经是 %d%% 的 %d 条 ｜ 手工调过(跳过) %d 条 ｜ 没有封面 %d 条'
        % (len(todo), round(target * 100), len(same), len(tuned), len(nocover)))
    if tuned:
        log('  手工调过的：%s%s' % (
            ', '.join('%s(%d%%)' % (pad4(n), round(s * 100)) for n, _, s in tuned[:20]),
            '  …' if len(tuned) > 20 else ''))
    if nocover:
        log('  没有封面的：%s%s' % (
            ', '.join(pad4(n) for n in nocover[:20]), '  …' if len(nocover) > 20 else ''))

    if not args.apply:
        log('')
        log('（干跑，什么都没写。确认后加 --apply）')
        return 0

    if not todo:
        log('')
        log('没有需要改的，收工。')
        return 0

    done = set()
    for n, r, p, container, old in todo:
        imgs = r['封面']
        vp = imgs[0].get('viewport')
        if not isinstance(vp, dict):
            vp = {'s': 1, 'x': 0, 'y': 0}
        vp['s'] = target
        vp.setdefault('x', 0)
        vp.setdefault('y', 0)
        imgs[0]['viewport'] = vp
        r['_upd'] = int(time.time() * 1000)
        r['_rev'] = int(r.get('_rev') or 0) + 1
        done.add(id(r))

    written = []
    for p, container, rows_ in files:
        if not any(id(r) in done for r in rows_):
            continue
        backup(p)
        dump(p, container[1])
        written.append(os.path.relpath(p, ROOT))
    log('')
    log('写盘完成：改了 %d 条；动了 %d 个数据文件' % (len(todo), len(written)))
    for w in written:
        log('  · %s' % w)
    log('')
    log('=' * 74)
    log('下一步：重开页面 → 点 ☁上传把记录推到 D1（手机端才会看到）')
    log('=' * 74)
    return 0


if __name__ == '__main__':
    sys.exit(main())
