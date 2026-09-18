#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
restore_orphan_books.py —— 把只存在于旧快照里的 2 本书补回各自的分片文件

背景
----
`data/_legacy_index_20260918.json` 是 v1 单文件时代顶层 collection 键的归档。
清理时逐条比对发现，有 2 本书只在旧快照里、当前数据中已找不到：

    《上海水鸟观察入门指南》        小分类=观鸟  标签分类=自然科技
    《词根溯源解码 300词根速记…》    小分类=英语  标签分类=工具语言

而 `data/书籍/观鸟-data.json` 与 `data/书籍/英语-data.json` 恰好是空的
（两个文件存在、rows 为空），说明它们本该落在这里。

按 app.js 的 shardCatOf() 规则：collection 模块下「大类=书籍」时，
分片名 = 小分类 || 标签分类 || '书籍'，所以这两条分别归 观鸟 / 英语。

用法
----
    python tools/restore_orphan_books.py            # 空转
    python tools/restore_orphan_books.py --apply    # 执行
"""
import json
import os
import shutil
import sys
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
ARCHIVE = os.path.join(DATA, '_legacy_index_20260918.json')

TARGETS = [
    # (记录名开头, 目标分片文件)
    ('上海水鸟观察入门指南', '书籍/观鸟-data.json'),
    ('词根溯源解码', '书籍/英语-data.json'),
]

APPLY = '--apply' in sys.argv


def main():
    if not os.path.exists(ARCHIVE):
        print('找不到归档文件：%s' % ARCHIVE)
        return
    arc = json.load(open(ARCHIVE, encoding='utf-8'))
    legacy = (arc.get('tables') or {}).get('collection') or []
    print('归档里共 %d 条记录' % len(legacy))

    plan = []
    for prefix, rel in TARGETS:
        hit = None
        for r in legacy:
            if isinstance(r, dict) and str(r.get('名称') or '').startswith(prefix):
                hit = r
                break
        if not hit:
            print('  !! 归档里找不到「%s」' % prefix)
            continue
        plan.append((rel, hit))

    # 冲突检查：目标分片里是否已经有同 _id
    print()
    for rel, rec in plan:
        p = os.path.join(DATA, rel)
        cur = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'rows': []}
        ids = {r.get('_id') for r in (cur.get('rows') or []) if isinstance(r, dict)}
        dup = rec.get('_id') in ids
        print('  %-24s -> %-26s 现有 %d 条  %s'
              % (str(rec.get('名称'))[:24], rel, len(cur.get('rows') or []),
                 '（已存在，跳过）' if dup else '（待补入）'))

    print()
    if not APPLY:
        print('（空转模式。加 --apply 真正执行）')
        return

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    for rel, rec in plan:
        p = os.path.join(DATA, rel)
        cur = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {
            'schema': 2, 'cat': os.path.basename(rel).replace('-data.json', ''),
            'module': 'collection', 'rows': [],
        }
        cur.setdefault('rows', [])
        if rec.get('_id') in {r.get('_id') for r in cur['rows'] if isinstance(r, dict)}:
            print('  跳过（已存在）：%s' % rel)
            continue
        shutil.copy2(p, p + '.bak-restore' + stamp)
        cur['rows'].append(rec)
        cur.setdefault('schema', 2)
        cur.setdefault('module', 'collection')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(cur, f, ensure_ascii=False, indent=2)
        print('  已补入 %s：%s（现在 %d 条）' % (rel, rec.get('名称'), len(cur['rows'])))

    print()
    print('完成。原文件已备份为 *.bak-restore%s' % stamp)


if __name__ == '__main__':
    main()
