# -*- coding: utf-8 -*-
"""
split_fridge_versions.py —— 给「30周年冰箱贴」拆出「贴纸版」

背景
----
30 周年冰箱贴有一模一样的「贴纸版」。两者**名字 / 编号 / 封面 / 属性全共用**，
但「在库 / 想收」要各记各的。

做法（数据侧）
--------------
把该系列的每一条记录**复制一份**，只改这几个字段：
    版本   : 原记录 '冰箱贴' / 副本 '贴纸'
    _id    : 副本重新生成（不与任何已有 id 冲突）
    状态   : 副本清空（[]）
    购入价格 / 购入渠道 / 购入日期 / 存储地点 / 持有 : 副本清空（是另一笔购买）
    _upd / _rev : 副本新戳、_rev=1
其它字段（名称 / 编号 / formCode / 封面 / 属性 / 副属性 / 特殊形态 / 图鉴组 /
地区 / 世代组 / 短评 / 端盒 / 隐藏款 …）原样保留 —— 所以图片路径是同一个文件，
**不占额外存储、推 R2 也不重复**。

配套的 app.js（v132）：
    · 没有 `版本` 字段的记录 = 冰箱贴版（默认）
    · `版本:'贴纸'` 的记录在卡片上带「贴纸」角标
    · 系列详情页顶部多一个「冰箱贴 / 贴纸」切换按钮，进度与筛选只统计当前版本

用法
----
    cd E:\\自制软件\\生活后台\\clean
    python tools/split_fridge_versions.py            # 干跑：只报告，不写盘
    python tools/split_fridge_versions.py --apply    # 真正写盘（自动备份）

⚠️ 写盘前**必须先完全关闭**连了本地目录的电脑端页面：
   那个页面每 20 秒会把内存快照全量写回磁盘，会把这里的改动整个盖掉。
   写完请观察 40 秒，mtime 不再变化才算安全，然后重新打开页面。
"""

import io
import json
import os
import random
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARD = os.path.join(ROOT, 'data', '冰箱贴-data.json')
INDEX = os.path.join(ROOT, 'data', 'lifedesk.json')

SERIES = '30周年冰箱贴'
VER_BASE = '冰箱贴'
VER_NEW = '贴纸'

# 副本要清空的字段（存在才置 null，不存在就不加）
CLEAR_FIELDS = ['状态', '持有', '购入价格', '购入渠道', '购入日期', '存储地点']

APPLY = '--apply' in sys.argv


def load(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def new_id(used):
    """与 app.js 里的临时 id 同风格：l_ + base36，且保证不重复。"""
    while True:
        rid = 'l_' + _b36(int(time.time() * 1000)) + _b36(random.getrandbits(28))
        if rid not in used:
            used.add(rid)
            return rid


def _b36(n):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def key_of(row):
    """副本去重用的身份键 —— 号码 + 副编号（+ 名称兜底，防同号同形态的重名记录）。"""
    return (str(row.get('编号') or ''), str(row.get('formCode') or ''),
            str(row.get('名称') or ''))


def main():
    if not os.path.exists(SHARD):
        print('[x] 找不到分片文件：%s' % SHARD)
        return 2

    doc = load(SHARD)
    rows = doc.get('rows') or []
    print('分片：%s' % os.path.relpath(SHARD, ROOT))
    print('总记录 %d 条' % len(rows))

    targets = [r for r in rows if r.get('系列') == SERIES]
    print('其中「%s」%d 条' % (SERIES, len(targets)))
    if not targets:
        print('[!] 没有找到目标记录，什么也没做。')
        return 1

    # 已经存在的「贴纸版」身份键（幂等：重复跑不会翻倍）
    existing_new = set()
    for r in rows:
        if r.get('系列') == SERIES and r.get('版本') == VER_NEW:
            existing_new.add(key_of(r))
    if existing_new:
        print('已有「%s版」%d 条（这些会跳过，不重复复制）' % (VER_NEW, len(existing_new)))

    base_no_ver = 0
    for r in targets:
        if not r.get('版本'):
            base_no_ver += 1

    dup_check = {}
    for r in targets:
        k = key_of(r)
        dup_check[k] = dup_check.get(k, 0) + 1
    dup_keys = [k for k, n in dup_check.items() if n > 1]

    todo = [r for r in targets if key_of(r) not in existing_new]
    print('本次要新增「%s版」%d 条' % (VER_NEW, len(todo)))
    print('要给 %d 条原记录补上 `版本:"%s"`（其余已带）' % (base_no_ver, VER_BASE))
    if dup_keys:
        print('[!] 有 %d 组身份键重复（号码+副编号+名称完全一样）：' % len(dup_keys))
        for k in dup_keys[:5]:
            print('      ', k)
        print('    → 这些记录只会复制一份副本，重复的那几条请人工确认。')

    used = set(str(r.get('_id')) for r in rows)
    now = int(time.time() * 1000)
    copies = []
    seen_once = set()
    for r in todo:
        k = key_of(r)
        if k in seen_once:
            continue
        seen_once.add(k)
        c = dict(r)
        c['_id'] = new_id(used)
        c['版本'] = VER_NEW
        for f in CLEAR_FIELDS:
            if f in c:
                c[f] = [] if f == '状态' else None
        c.pop('_file', None)
        c['_upd'] = now
        c['_rev'] = 1
        copies.append(c)

    if not APPLY:
        print('\n[干跑] 未写盘。样例（第 1 条副本）：')
        if copies:
            print(json.dumps(copies[0], ensure_ascii=False, indent=2))
        print('\n确认无误后加 --apply 真正写入。')
        return 0

    # 备份
    ts = time.strftime('%Y%m%d-%H%M%S')
    if os.path.exists(SHARD):
        bak = SHARD + '.bak-ver-' + ts
        shutil.copy2(SHARD, bak)
        print('已备份 → %s' % os.path.relpath(bak, ROOT))

    for r in rows:
        if r.get('系列') == SERIES and not r.get('版本'):
            r['版本'] = VER_BASE
            if '_upd' in r:
                r['_upd'] = now          # 内容变了，让同步能认出这次改动
    rows.extend(copies)
    doc['rows'] = rows

    tmp = SHARD + '.tmp'
    with io.open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2).replace('\n', '\r\n'))
    os.replace(tmp, SHARD)
    print('已写入 → %s（%d 条 → %d 条）' %
          (os.path.relpath(SHARD, ROOT), len(rows) - len(copies), len(rows)))

    # 顺带看一眼索引里的 __main 有没有这个系列的残留
    if os.path.exists(INDEX):
        try:
            idx = load(INDEX)
            m = idx.get('__main')
            mrows = m.get('rows') if isinstance(m, dict) else (m if isinstance(m, list) else [])
            hit = [r for r in (mrows or []) if isinstance(r, dict) and r.get('系列') == SERIES]
            if hit:
                print('[!] data/lifedesk.json 的 __main 里还有 %d 条本系列记录，'
                      '页面加载时会与分片合并，可能需要一并处理。' % len(hit))
            else:
                print('data/lifedesk.json 的 __main 里没有本系列记录（无需处理）。')
        except Exception as e:
            print('[!] 读 lifedesk.json 失败：%s' % e)

    print('\n完成。请观察 40 秒确认文件没被外部覆盖，然后重开页面、点 ☁上传 推到 D1。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
