#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
add_timestamps.py —— 给所有存量记录补同步时间戳（_upd / _rev）

为什么需要：
  电脑端和手机端要「增量同步」——只推/拉上次同步之后改动过的记录，
  而不是每次都全量搬运上千条。这要求每条记录带一个「最后修改时间」。
  历史数据里没有这个字段，所以用本脚本补一个统一的基线值：
      _upd = 基线毫秒时间戳（默认取脚本运行时刻，可用 --ts 覆盖）
      _rev = 1（改过几次，之后每次保存 +1）

  补完之后，app.js 里的 localUpsert / patchRow / patchRowFields 会在每次
  保存时自动刷新这两个字段（v102 起）。

覆盖范围：
  - data/lifedesk.json 的 __main.* 各行
  - data/lifedesk.json 里 shards / entityFiles 指向的所有分片文件

用法（在项目根目录执行）：
    python tools/add_timestamps.py            # 干跑，只报告不改动
    python tools/add_timestamps.py --apply    # 真正写入，先备份 .bak-ts<时间>
    python tools/add_timestamps.py --apply --ts 1758200000000   # 指定基线

安全性：
  - 默认干跑，必须显式 --apply 才写盘
  - 写盘前对每个文件生成 <原名>.bak-tsYYYYMMDD-HHMMSS 备份
  - 只增不改：已有 _upd 的记录一律跳过，不动其它任何字段
  - 保持原格式：LF 换行、2 空格缩进、无行尾换行、ensure_ascii=False
"""

import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
INDEX = os.path.join(DATA, 'lifedesk.json')

DRY = True
BASE_TS = int(time.time() * 1000)
STAMP = time.strftime('%Y%m%d-%H%M%S')


def load(path):
    with open(path, 'r', encoding='utf-8', newline='') as f:
        return json.load(f)


def dump(path, obj):
    """按项目既有格式写回：LF、2 空格缩进、无行尾换行。"""
    txt = json.dumps(obj, ensure_ascii=False, indent=2)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(txt)


def backup(path):
    bak = path + '.bak-ts' + STAMP
    with open(path, 'rb') as src, open(bak, 'wb') as dst:
        dst.write(src.read())
    return bak


def stamp_rows(rows):
    """给缺时间戳的行补上，返回补了几条。就地修改。"""
    n = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        if r.get('_upd'):
            continue
        r['_upd'] = BASE_TS
        r['_rev'] = 1
        n += 1
    return n


def collect_shard_paths(index):
    """从 lifedesk.json 里收集所有分片文件的绝对路径（去重、保序）。"""
    paths = []
    seen = set()

    def add(rel):
        ap = os.path.normpath(os.path.join(DATA, rel.replace('/', os.sep)))
        if ap not in seen:
            seen.add(ap)
            paths.append(ap)

    shards = index.get('shards') or {}
    if isinstance(shards, dict):
        for _cat, desc in shards.items():
            if not isinstance(desc, dict):
                continue
            if desc.get('file'):
                add(desc['file'])

    ef = index.get('entityFiles') or []
    if isinstance(ef, list):
        for rel in ef:
            if isinstance(rel, str):
                add(rel)

    return paths


def main():
    global DRY, BASE_TS

    args = sys.argv[1:]
    if '--apply' in args:
        DRY = False
    if '--ts' in args:
        try:
            BASE_TS = int(args[args.index('--ts') + 1])
        except (IndexError, ValueError):
            print('!! --ts 需要一个整数毫秒时间戳')
            return 1

    if not os.path.exists(INDEX):
        print('!! 找不到主索引：%s' % INDEX)
        return 1

    print('=' * 66)
    print('基线时间戳 : %d  (%s)' % (BASE_TS, time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(BASE_TS / 1000))))
    print('模式       : %s' % ('【干跑】只报告，不写盘' if DRY else '【写入】会先备份再改'))
    print('=' * 66)

    index = load(INDEX)
    total = 0
    touched_files = 0

    # ---- 1) 主索引里的 __main ----
    main_blk = index.get('__main')
    if isinstance(main_blk, dict):
        n_main = 0
        for cat, rows in main_blk.items():
            if isinstance(rows, list):
                n_main += stamp_rows(rows)
        if n_main:
            touched_files += 1
            total += n_main
            print('%-46s  %4d 条' % ('lifedesk.json  __main', n_main))
            if not DRY:
                backup(INDEX)
                dump(INDEX, index)
                print('    └ 已写入 + 备份 %s.bak-ts%s' % (os.path.basename(INDEX), STAMP))
        else:
            print('%-46s  %4d 条' % ('lifedesk.json  __main', 0))
    else:
        print('lifedesk.json  没有 __main 块（跳过）')

    # ---- 2) 所有分片文件 ----
    paths = collect_shard_paths(index)
    print('-' * 66)
    print('主索引登记的分片文件共 %d 个' % len(paths))
    print('-' * 66)

    for ap in paths:
        rel = os.path.relpath(ap, DATA).replace(os.sep, '/')
        if not os.path.exists(ap):
            print('%-46s  !! 文件不存在' % rel)
            continue
        try:
            obj = load(ap)
        except Exception as e:
            print('%-46s  !! 读取失败：%s' % (rel, e))
            continue

        rows = obj.get('rows') if isinstance(obj, dict) else None
        if not isinstance(rows, list):
            print('%-46s  -- 无 rows 数组，跳过' % rel)
            continue

        n = stamp_rows(rows)
        if n:
            touched_files += 1
            total += n
            print('%-46s  %4d 条' % (rel, n))
            if not DRY:
                backup(ap)
                dump(ap, obj)
        else:
            print('%-46s  %4d 条' % (rel, 0))

    print('=' * 66)
    print('合计：%d 个文件、%d 条记录被补上 _upd/_rev' % (touched_files, total))
    if DRY:
        print('这是干跑。确认无误后加 --apply 真正写入。')
    else:
        print('已写入。备份后缀：.bak-ts%s' % STAMP)
    print('=' * 66)
    return 0


if __name__ == '__main__':
    sys.exit(main())
