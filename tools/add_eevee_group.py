#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v157 数据补充：给「30周年冰箱贴」里的**伊布一家**打上图鉴组 `伊布`。

背景（用户要求）：
    「图鉴组增加伊布，因为伊布的不同形态跨度太大了，有了这个图鉴组，将会方便很多。
      一共九种伊布都属于筛选范围。」
    九种伊布横跨六个世代 ——
        第一世代 133 伊布 / 134 水伊布 / 135 雷伊布 / 136 火伊布
        第二世代 196 太阳伊布 / 197 月亮伊布
        第四世代 470 叶伊布 / 471 冰伊布
        第六世代 700 仙子伊布
    按世代筛会散得到处都是，单独成组才看得全。

做的事：把 `系列 == '30周年冰箱贴'` 且全国图鉴编号属于上面 9 个号的行，
        写上 `图鉴组 = '伊布'`（**同一编号的各个形态一起收**，比如「伊布（超极巨化）」；
        冰箱贴版 / 贴纸版是两份记录，也都会被打上 —— 跟「初始的伙伴」那个组的做法一致）。

⚠️ 只碰 `30周年冰箱贴` 的行：编号在别的系列里会重复出现，不能按编号全局匹配。
⚠️ 如果某行**已经有别的图鉴组值**（传说/幻之/究极异兽/初始的伙伴），脚本会**报出来但不覆盖** ——
   那种情况属于数据异常，得先看清楚再决定，不能静默改。

改写后把该记录的 _upd 打新、_rev +1：本地比云端新，下次点一次「☁ 上传」就能同步到 Cloudflare。

默认**干跑**（只报告），确认无误后加 --apply 才真正写盘。
改前会把每个涉及的 JSON 备份成 <原名>.bak-eevee-<日期>。
幂等：重复运行第二次会报「没有需要补充的记录」。

⚠️ 跑之前先让用户在电脑端**完全关闭**页面（刷新不够）—— 那个页面每 20 秒会把内存快照
   全量写回磁盘，会把脚本的改动直接盖掉。写完观察 40 秒 mtime 不变才算安全。
"""
import json
import io
import os
import re
import sys
import time
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = time.strftime('%Y%m%d')
LABEL = 'bak-eevee-' + TODAY
SERIES = '30周年冰箱贴'
GROUP = '伊布'
# 九种伊布（全国图鉴编号）
EEVEE_DEX = {133, 134, 135, 136, 196, 197, 470, 471, 700}
OTHER_GROUPS = ('传说宝可梦', '幻之宝可梦', '究极异兽', '初始的伙伴')


def dex_of(v):
    s = re.sub(r'^[#＃]', '', str(v or '').strip())
    return int(s) if s.isdigit() else None


def is_eevee(r):
    return r.get('系列') == SERIES and dex_of(r.get('编号')) in EEVEE_DEX


def collection_files():
    idx_path = os.path.join(ROOT, 'data', 'lifedesk.json')
    out = []
    idx = None
    try:
        idx = json.load(io.open(idx_path, encoding='utf-8'))
    except Exception as e:
        print('  ! 读不了主索引：%s' % e)
        return out
    out.append((idx_path, 'index'))
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
    conflicts = []
    touched = []
    print('=' * 72)
    print('给「%s」的九种伊布打图鉴组「%s」' % (SERIES, GROUP)
          + ('  ** 真正写盘 **' if apply else '  （干跑，不写盘）'))
    print('=' * 72)

    for path, kind in collection_files():
        try:
            doc = json.load(io.open(path, encoding='utf-8'))
        except Exception as e:
            print('  跳过 %s：%s' % (os.path.relpath(path, ROOT), e))
            continue
        hits = []
        for obj, key in rows_of(doc, kind):
            for r in obj[key]:
                if not isinstance(r, dict) or not is_eevee(r):
                    continue
                cur = str(r.get('图鉴组') or '').strip()
                if cur == GROUP:
                    continue                      # 已经打好了（幂等）
                if cur and cur in OTHER_GROUPS:
                    conflicts.append((path, r, cur))
                    continue                      # 有别的组 → 报出来，不静默覆盖
                hits.append(r)
        if not hits:
            continue
        rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
        print('%s  （%d 条）' % (rel, len(hits)))
        seen = {}
        for r in hits:
            nm = str(r.get('名称'))
            seen[nm] = seen.get(nm, 0) + 1
        for nm in sorted(seen):
            print('   %-16s ×%d  → 图鉴组 = %s' % (nm, seen[nm], GROUP))
        print('')
        total += len(hits)
        touched.append((path, len(hits)))
        if apply:
            shutil.copy2(path, path + '.' + LABEL)
            for r in hits:
                r['图鉴组'] = GROUP
                r['_upd'] = now
                r['_rev'] = (int(r.get('_rev') or 0)) + 1
            io.open(path, 'w', encoding='utf-8').write(
                json.dumps(doc, ensure_ascii=False, indent=2))

    if conflicts:
        print('⚠️ 下面这些伊布**已有别的图鉴组**，没有动它们（请人工确认）：')
        for path, r, cur in conflicts:
            print('   %s  %s  现在是「%s」' % (os.path.relpath(path, ROOT), r.get('名称'), cur))
        print('')

    print('=' * 72)
    if not total:
        print('没有需要补充的记录（九种伊布都已经在图鉴组「%s」里）。' % GROUP)
        return 0
    if apply:
        print('已写入 %d 条，涉及 %d 个文件（原文件备份为 *.%s）' % (total, len(touched), LABEL))
        print('这些记录的 _upd 已打新 → 重开页面点一次「☁ 上传」即可同步到云端。')
    else:
        print('待补充 %d 条，涉及 %d 个文件。加 --apply 才会真正写盘。' % (total, len(touched)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
