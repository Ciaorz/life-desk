#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strip_legacy_keys.py —— 清掉主索引里 v1 时代遗留的顶层数据键

背景
----
lifedesk.json 在拆分成分片之前，是「一个文件装所有数据」的格式：顶层直接是
{ collection:[...], travel:[...], av:[...], ... }。
拆成 schema 2 之后，真正的数据来源变成了：
    idx.__main（未分片记录） + idx.shards（各分片文件） + idx.entityFiles（ip/series 实体文件）
顶层那些 list 键就再也没人读了。

已核实（app.js）：
  - storageLoadV2()   只读 idx.__main / idx.shards / entityFiles
  - ghStaticLoadV2()  同上
  - 只有 migrateToShards() / maybeOfferMigration() 会读顶层键，
    而它们都在 _shardMode === true（索引已是 schema 2）时直接 return，永不触发。

这 11 个键合计约 720 KB，占索引原本体积的三分之一，手机端每次打开都要白下。
脚本会先把它们原样归档到 data/_legacy_index_<日期>.json，再从 lifedesk.json 里删除。

用法
----
    python tools/strip_legacy_keys.py            # 空转
    python tools/strip_legacy_keys.py --apply    # 执行
"""
import json
import os
import shutil
import sys
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
INDEX_FILE = os.path.join(DATA, 'lifedesk.json')

LEGACY_KEYS = ['collection', 'travel', 'av', 'study', 'food', 'idea',
               'ip', 'series', 'loc', 'checkin', 'recipe']

APPLY = '--apply' in sys.argv


def main():
    idx = json.load(open(INDEX_FILE, encoding='utf-8'))
    present = [k for k in LEGACY_KEYS if isinstance(idx.get(k), list)]
    if not present:
        print('没有遗留键需要清理。')
        return

    archive = {}
    total = 0
    print('=' * 70)
    print('将从 lifedesk.json 移除以下遗留键：')
    for k in present:
        v = idx[k]
        sz = len(json.dumps(v, ensure_ascii=False).encode('utf-8'))
        total += sz
        print('  %-12s %5d 行  %8.1f KB' % (k, len(v), sz / 1024))
    print('  合计 %.1f KB' % (total / 1024))
    print('=' * 70)

    if not APPLY:
        print('（空转模式。加 --apply 真正执行）')
        return

    stamp = datetime.date.today().strftime('%Y%m%d')
    arch_file = os.path.join(DATA, '_legacy_index_%s.json' % stamp)
    for k in present:
        archive[k] = idx[k]
    with open(arch_file, 'w', encoding='utf-8') as f:
        json.dump({'note': 'v1 单文件时代的顶层数据键归档，App 不读取。仅作追溯/找回用。',
                   'archivedAt': datetime.datetime.now().isoformat(timespec='seconds'),
                   'tables': archive}, f, ensure_ascii=False, indent=2)

    shutil.copy2(INDEX_FILE, INDEX_FILE + '.bak-strip' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    for k in present:
        del idx[k]
    with open(INDEX_FILE, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)

    print('已归档 -> %s (%.1f KB)' % (os.path.relpath(arch_file, ROOT),
                                      os.path.getsize(arch_file) / 1024))
    print('lifedesk.json 现在 %.1f KB' % (os.path.getsize(INDEX_FILE) / 1024))
    print('剩余顶层键：%s' % ', '.join(idx.keys()))


if __name__ == '__main__':
    main()
