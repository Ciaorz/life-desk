#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性数据修复：清掉「在库 + 想收」并存的自相矛盾状态。

背景：v128 之前，把物品标记为「在库」时不会自动解除「想收」（只清了「云游」），
于是库里留下一批「已经买到手、却还挂着想收」的记录 —— 它们会同时出现在
「在库」和「想收」两个筛选里，收集进度/统计也跟着脏。

规则：状态里只要有「在库」，就删掉「想收」（顺带保证「云游」也不在）。
      只删这两个，其它状态（已预订/已出…）原样保留；顺序保持剩余项的相对次序。

扫描范围：data/lifedesk.json 的 __main（内嵌主分片）+ 各 *-data.json 的 rows。
          ⚠️ 只扫 *-data.json 会漏掉 __main —— 记录可能同时存在于两处，两处都要修。

改写记录后会把该记录的 _upd 打新、_rev +1：这样本地比云端新，
下次「上传」就能把这处修正同步到 Cloudflare（下回「下载」也不会被旧版本盖回来）。

默认**干跑**（只报告），确认无误后加 --apply 才真正写盘。
改前会把每个涉及的 JSON 备份成 <原名>.bak-ownedwish-<日期>。
幂等：重复运行第二次会报「没有需要修复的记录」。
"""
import json
import io
import os
import sys
import time
import glob
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = time.strftime('%Y%m%d')
LABEL = 'bak-ownedwish-' + TODAY


def st_arr(v):
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [s.strip() for s in str(v or '').split(',') if s.strip()]


def fix_arr(v):
    """返回修好的数组；没变化返回 None。"""
    a = st_arr(v)
    if '在库' not in a:
        return None
    out = [s for s in a if s not in ('想收', '云游')]
    if out == a:
        return None
    return out


def walk_files():
    """(路径, 取行/写行 的访问器) 列表。"""
    out = []
    idx = os.path.join(ROOT, 'data', 'lifedesk.json')
    if os.path.isfile(idx):
        out.append((idx, 'index'))
    for p in sorted(glob.glob(os.path.join(ROOT, 'data', '**', '*-data.json'), recursive=True)):
        b = os.path.basename(p)
        if b.startswith('lifedesk') or '.bak' in b or '_replaced' in p:
            continue
        out.append((p, 'rows'))
    return out


def rows_of(doc, kind):
    if kind == 'index':
        m = doc.get('__main') or {}
        return [(m, k) for k in m.keys() if isinstance(m.get(k), list)]
    rs = doc.get('rows') if isinstance(doc, dict) else None
    return [(doc, 'rows')] if isinstance(rs, list) else []


def main():
    apply = '--apply' in sys.argv
    now = int(time.time() * 1000)
    total = 0
    touched = []
    print('=' * 72)
    print('清掉「在库 + 想收」并存的状态' + ('（** 真正写盘 **）' if apply else '（干跑，不写盘）'))
    print('=' * 72)

    for path, kind in walk_files():
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
        print('\n%s' % rel)
        for r, fixed in hits:
            print('   %-18s %s → %s' % (str(r.get('名称'))[:18], st_arr(r.get('状态')), fixed))
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

    print('\n' + '=' * 72)
    if not total:
        print('没有需要修复的记录（已经是干净的）。')
        return 0
    if apply:
        print('已修复 %d 条，涉及 %d 个文件（原文件备份为 *.%s）' % (total, len(touched), LABEL))
        print('这些记录的 _upd 已打新 → 打开 app 点一次「上传」即可同步到云端。')
    else:
        print('发现 %d 条待修复，涉及 %d 个文件。加 --apply 才会真正写盘。' % (total, len(touched)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
