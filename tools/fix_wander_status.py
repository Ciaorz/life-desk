# -*- coding: utf-8 -*-
"""
fix_wander_status.py —— 给「系列里还没入手的条目」补上「云游」状态

背景
----
系列（尤其图鉴那种成百上千个的，如 30周年冰箱贴 / 全图鉴金属徽章）通常是
**先把「要收的清单」建起来，再逐个把已经到手的勾成「在库」**。
中途那些还没勾的条目状态是空的 —— 它们既不出现在「在库」里（对），
也不出现在「云游」里（不对），等于在筛选里「消失」了，看着像漏录。

规则（只做这一件事，不碰别的字段）
--------------------------------
     属于某个系列（「系列」非空） 且 状态完全为空 的藏品  →  状态 = ["云游"]

- 已经有「在库」的不动。
- 已经有「想收 / 已预订」等其它状态、但没有「云游」的**也不动** ——
  免得把「想要」和「云游」两个概念搅在一起（当前数据里有系列的这类记录为 0 条）。
- 没有「系列」的散件不动（书籍 / 杂志 / 随手记的手办等）。
- 幂等：跑第二遍不会有任何改动。

配套的 app.js（v137）保证**以后新录入**的系列条目默认就是「云游」，
所以这个脚本只需要把存量数据抹平一次。

用法
----
    cd E:\\自制软件\\生活后台\\clean
    python tools/fix_wander_status.py            # 干跑：只报告
    python tools/fix_wander_status.py --apply    # 写盘（逐文件备份）

⚠️ 写盘前**先完全关闭**连了本地目录的电脑端页面（它每 20 秒会把内存快照全量写回磁盘，
   会把这里的改动整个盖掉）。写完观察 40 秒 mtime 不再变，再重开页面并点 ☁上传。
"""

import glob
import io
import json
import os
import shutil
import sys
import time
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'data', 'lifedesk.json')
APPLY = '--apply' in sys.argv
WANDER = '云游'


def st_list(v):
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [s.strip() for s in str(v or '').split(',') if s.strip()]


def load(p):
    with io.open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def dump(p, obj):
    tmp = p + '.tmp'
    with io.open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2).replace('\n', '\r\n'))
    os.replace(tmp, p)


def need_fix(r):
    """属于系列 + 状态完全为空 → 该补「云游」"""
    if not isinstance(r, dict):
        return False
    if not str(r.get('系列') or '').strip():
        return False
    if not str(r.get('名称') or '').strip():
        return False          # 不是藏品记录（防御）
    return not st_list(r.get('状态'))


def touch(r, now):
    r['状态'] = [WANDER]
    r['_upd'] = now
    r['_rev'] = (int(r.get('_rev') or 0) or 0) + 1


def main():
    now = int(time.time() * 1000)
    bak_ts = time.strftime('%Y%m%d-%H%M%S')

    # ---- 1) 主索引：__main 是「模块名 → 行数组」----
    idx = load(INDEX)
    main_hits = []
    for mk, arr in (idx.get('__main') or {}).items():
        if not isinstance(arr, list):
            continue
        for r in arr:
            if need_fix(r):
                main_hits.append((mk, r))

    # ---- 2) 各分片：只认 module=collection ----
    shard_docs = []          # (路径, 文档, 命中行)
    for p in sorted(glob.glob(os.path.join(ROOT, 'data', '**', '*-data.json'), recursive=True)):
        if '_bak' in p or 'lifedesk.backup' in p:
            continue
        try:
            d = load(p)
        except Exception as e:
            print('[!] 读不了 %s：%s' % (os.path.relpath(p, ROOT), e))
            continue
        if not isinstance(d, dict) or str(d.get('module') or '') != 'collection':
            continue
        hit = [r for r in (d.get('rows') or []) if need_fix(r)]
        if hit:
            shard_docs.append((p, d, hit))

    total = len(main_hits) + sum(len(h) for _, _, h in shard_docs)
    by_series = Counter()
    for _, r in main_hits:
        by_series[str(r.get('系列'))] += 1
    for _, _, h in shard_docs:
        for r in h:
            by_series[str(r.get('系列'))] += 1

    print('=' * 68)
    print('需要补「%s」的系列条目：%d 条' % (WANDER, total))
    print('-' * 68)
    for k, v in by_series.most_common():
        print('  %-28s %d' % (k, v))
    print('-' * 68)
    print('  主索引 __main：%d 条（%d 个模块）'
          % (len(main_hits), len(set(mk for mk, _ in main_hits))))
    for p, _, h in shard_docs:
        print('  %-34s %d 条' % (os.path.relpath(p, ROOT), len(h)))
    print('=' * 68)

    if not total:
        print('没有需要改的记录（幂等：已经全部处理过了）。')
        return 0
    if not APPLY:
        print('\n[干跑] 未写盘。加上 --apply 真正写入（会逐文件备份）。')
        return 0

    # ---- 3) 写盘 ----
    if main_hits:
        bak = INDEX + '.bak-wander-' + bak_ts
        shutil.copy2(INDEX, bak)
        print('已备份 → %s' % os.path.relpath(bak, ROOT))
        for _, r in main_hits:
            touch(r, now)
        dump(INDEX, idx)

    for p, d, hit in shard_docs:
        bak = p + '.bak-wander-' + bak_ts
        shutil.copy2(p, bak)
        print('已备份 → %s' % os.path.relpath(bak, ROOT))
        for r in hit:
            touch(r, now)
        dump(p, d)

    print('\n完成：共改了 %d 条（主索引 %d + 分片 %d）。'
          % (total, len(main_hits), sum(len(h) for _, _, h in shard_docs)))
    print('请观察 40 秒确认文件没被外部覆盖，然后重开页面、点 ☁上传 推到 D1。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
