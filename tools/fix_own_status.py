#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v155 数据修复：把「状态」归一到合法形态（和 app.js 里的 normalizeOwnStatus 完全同一套规则）。

背景（用户报的）：
    在「30周年冰箱贴」里误把某件标成「在库」，发现其实没买，取消在库之后
    **状态变成空** —— 那条东西从「在库 / 云游 / 想收」三个筛选里同时消失，看着就像"丢了"。

用户拍板的状态模型：
    · **基础状态「在库 / 云游」二选一，必须有一个亮着**（不存在"没有状态"的藏品）；
    · **「想收 / 已预订」是挂在「云游」上的附加态**（东西还没到手，但想要 / 已经订了）。
    合法形态只有三种：
        ['在库']                       到手了
        ['云游']                       还没到手
        ['云游', '想收'(, '已预订')]     还没到手 + 附加

本脚本把库里**存量**的脏形态一次收敛掉：
    空 / 缺字段      → ['云游']
    ['想收']         → ['云游','想收']
    ['已预订']       → ['云游','已预订']
    ['在库','想收']  → ['在库']
    ['在库','云游']  → ['在库']

扫描范围（**只碰藏品**，其它模块一个都不动）：
    · data/lifedesk.json 的 __main['collection']（内嵌主分片）
    · data/*-data.json 里 idx.shards 标了 module == 'collection' 的那些
      ⚠️ 靠 shards 的 module 字段判定，不靠文件名 —— 分片里混着 av / travel /
         food / study / idea 的行（赏戏、留音、美食、想去的地方…），
         它们的「状态」是**字符串**（想去/去过、想看/在看…），规则完全不同，绝不能按本脚本改。

改写记录后会把该记录的 _upd 打新、_rev +1：这样本地比云端新，
下次在 app 里点一次「上传」就能把这批修正同步到 Cloudflare（也不会被旧版本盖回来）。

默认**干跑**（只报告），确认无误后加 --apply 才真正写盘。
改前会把每个涉及的 JSON 备份成 <原名>.bak-ownstatus-<日期>。
幂等：重复运行第二次会报「没有需要修复的记录」。

⚠️ 跑之前先让用户在电脑端**完全关闭**页面（刷新不够）—— 那个页面每 20 秒会把内存快照
   全量写回磁盘，会把脚本的改动直接盖掉。写完观察 40 秒 mtime 不变才算安全。
"""
import json
import io
import os
import sys
import time
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = time.strftime('%Y%m%d')
LABEL = 'bak-ownstatus-' + TODAY
EXTRA = ['想收', '已预订']


def st_arr(v):
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [s.strip() for s in str(v or '').split(',') if s.strip()]


def fix_arr(v):
    """归一到合法形态；本来就已经合法就返回 None（幂等的关键）。"""
    a = st_arr(v)
    if '在库' in a:
        out = ['在库']
    else:
        out = ['云游'] + [s for s in EXTRA if s in a]
    return None if out == a else out


def collection_files():
    """[(路径, kind)]，kind: 'index' 或 'rows'。只挑 module == collection 的分片。"""
    out = []
    idx_path = os.path.join(ROOT, 'data', 'lifedesk.json')
    idx = None
    if os.path.isfile(idx_path):
        try:
            idx = json.load(io.open(idx_path, encoding='utf-8'))
        except Exception as e:
            print('  ! 读不了主索引：%s' % e)
        else:
            out.append((idx_path, 'index'))
    if not idx:
        return out
    for key, info in (idx.get('shards') or {}).items():
        if not isinstance(info, dict):
            continue
        if info.get('module') != 'collection':
            continue
        f = info.get('file')
        if not f:
            continue
        p = os.path.join(ROOT, 'data', f)
        if os.path.isfile(p):
            out.append((p, 'rows'))
        else:
            print('  ! 分片文件不存在：%s（跳过）' % f)
    return out


def rows_of(doc, kind):
    if kind == 'index':
        m = doc.get('__main') or {}
        rs = m.get('collection')
        return [(m, 'collection')] if isinstance(rs, list) else []
    rs = doc.get('rows') if isinstance(doc, dict) else None
    return [(doc, 'rows')] if isinstance(rs, list) else []


def main():
    apply = '--apply' in sys.argv
    now = int(time.time() * 1000)
    total = 0
    touched = []
    print('=' * 72)
    print('把「状态」归一到合法形态（在库 / 云游 必有一个亮着）'
          + ('  ** 真正写盘 **' if apply else '  （干跑，不写盘）'))
    print('=' * 72)

    files = collection_files()
    print('待检查的藏品分片：%d 个\n' % len(files))

    for path, kind in files:
        try:
            doc = json.load(io.open(path, encoding='utf-8'))
        except Exception as e:
            print('  跳过 %s：%s' % (os.path.relpath(path, ROOT), e))
            continue
        hits = []
        for obj, key in rows_of(doc, kind):
            for r in obj[key]:
                if not isinstance(r, dict):
                    continue
                fixed = fix_arr(r.get('状态'))
                if fixed is None:
                    continue
                hits.append((r, fixed))
        if not hits:
            continue
        rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
        print('%s  （%d 条）' % (rel, len(hits)))
        for r, fixed in hits[:40]:
            print('   %-22s %-22s → %s'
                  % (str(r.get('名称'))[:22], str(st_arr(r.get('状态'))), fixed))
        if len(hits) > 40:
            print('   …还有 %d 条' % (len(hits) - 40))
        print('')
        total += len(hits)
        touched.append((path, len(hits)))
        if apply:
            shutil.copy2(path, path + '.' + LABEL)
            for r, fixed in hits:
                r['状态'] = fixed
                r['_upd'] = now
                r['_rev'] = (int(r.get('_rev') or 0)) + 1
            io.open(path, 'w', encoding='utf-8').write(
                json.dumps(doc, ensure_ascii=False, indent=2))

    print('=' * 72)
    if not total:
        print('没有需要修复的记录（状态都已经合法）。')
        return 0
    if apply:
        print('已修复 %d 条，涉及 %d 个文件（原文件备份为 *.%s）' % (total, len(touched), LABEL))
        print('这些记录的 _upd 已打新 → 重开页面点一次「☁ 上传」即可同步到云端。')
    else:
        print('发现 %d 条待修复，涉及 %d 个文件。加 --apply 才会真正写盘。' % (total, len(touched)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
