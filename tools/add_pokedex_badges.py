# -*- coding: utf-8 -*-
"""
add_pokedex_badges.py —— 给「全图鉴金属徽章」补齐 0001~1025 的条目

背景（2026-10-03）：
  用户想把「全图鉴金属徽章」系列按「30周年冰箱贴」的号码-名字对照表录入，
  每个号码只录一个**平名**（不要特殊形态名，如「皮卡丘（超极巨化）」「超级喷漆龙Ｘ」）。
  另外原来按 3 位数（001）录的旧条目，要一并改成 4 位数（0001）。

做法：
  1. 从 `data/冰箱贴-data.json`（源）算出 `4位号码 → 平名` 对照表；
     平名 = 原名去掉尾部括号（…）、去掉「的样子」、去掉 超级/原始/究极/暗黑/焰白/
     加热/清洗/切割/结冰/旋转/惩戒/解放 等变体前缀、去掉尾部 ＸＹＺ。
  2. 读 `data/徽章-data.json`（目标，按小类分片；里面就是该系列的条目）：
     - 已有条目的 `编号` 补零成 4 位（保留状态、封面、购入信息等一切字段）；
     - 若某条的「名字」在对照表里属于**另一个号码**（如 019 烈雀，实际是 021），
       自动改到正确的号码上（仅当该号码在目标里空着）。
  3. 对照表里目标还没建的号码 → 新建条目（只填名字/号码，状态留空 = 未入手）。
  4. 顺带把源系列每个号码的 `属性 / 副属性 / 世代组` 拷过来（用户要求；见下面 FIELD_COPY）。
     ⚠️ 注意：app 里「属性 / 特殊形态 / 世代组」筛选栏与卡片属性图标目前**写死只对
     「30周年冰箱贴」系列生效**（`pkIsPkmSeries` / `pkIsPkm` 里比对系列名），
     所以这些字段现在不会在这套徽章里显现出来，纯粹是先把数据备好。
  5. 备份原文件，然后 --apply 才写盘。可反复运行（幂等）。

用法：
    python tools/add_pokedex_badges.py            # 干跑：只报告会做什么
    python tools/add_pokedex_badges.py --apply    # 真正写盘（自动备份 .bak-badges-<日期>）
"""

import io
import json
import os
import random
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', '冰箱贴-data.json')
TGT = os.path.join(ROOT, 'data', '徽章-data.json')

SERIES = '全图鉴金属徽章'
N_MAX = 1025
CAT_BIG, CAT_SMALL, IP = '周边', '徽章', '宝可梦'

# 从源系列按号码拷过来的字段（v130 起补齐筛选栏需要的全部形态字段）
FIELD_COPY = ['属性', '副属性', '特殊形态', '图鉴组', '地区', '世代组']

# 同号「变体」：号码 → [(formCode, 名称后缀), ...]
# 未知图腾（全国图鉴 0201）有 A~Z 共 26 个字母形态，和冰箱贴里的变体同规矩：
# 同号共存、formCode 两位零填（01..26）、特殊形态沿用「常规图鉴」（洛托姆那 5 个形态也是这么标的）。
EXTRA_FORMS = {
    '0201': [('%02d' % i, chr(64 + i)) for i in range(1, 27)],   # 01/A … 26/Z
}

# 变体前缀（去前缀后剩下的才是物种平名）
VARIANT_PREFIX = ['超级', '原始', '究极', '暗黑', '焰白',
                  '加热', '清洗', '切割', '结冰', '旋转', '惩戒', '解放']


def log(*a):
    print(*a)


def rd(p):
    with io.open(p, encoding='utf-8') as f:
        return json.load(f)


def wr(p, obj):
    with io.open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def plain_name(n):
    """把变体名折成物种平名。"""
    x = str(n or '').strip()
    x = re.sub(r'[（(][^）)]*[）)]\s*$', '', x).strip()   # 去尾部括号（超极巨化 / 阿罗拉的样子 …）
    x = re.sub(r'的样子$', '', x).strip()
    for p in VARIANT_PREFIX:
        if x.startswith(p) and len(x) > len(p):
            x = x[len(p):].strip()
    x = re.sub(r'[ＸＹＺ]$', '', x).strip()               # 超级喷火龙Ｘ → 喷火龙
    return x or str(n or '').strip()


def num4(v):
    """编号 → 4 位字符串；不是纯数字返回 None。"""
    s = str(v or '').strip().lstrip('#').strip()
    if not s.isdigit():
        return None
    return '%04d' % int(s)


def build_mapping():
    """从源系列算出 4 位号码 → 平名，以及号码 → {属性/副属性/世代组}。"""
    rows = rd(SRC).get('rows') or []
    byno = {}
    for r in rows:
        k = num4(r.get('编号'))
        if not k:
            continue
        byno.setdefault(k, []).append(r)

    mapping, need_review = {}, []
    for k, rs in byno.items():
        names = set(str(r.get('名称') or '') for r in rs)
        exact = sorted(n for n in names if n == plain_name(n))     # 本来就是平名
        if exact:
            mapping[k] = min(exact, key=lambda s: (len(s), s))
        else:
            ps = sorted(set(plain_name(n) for n in names))
            mapping[k] = ps[0]
            if len(ps) > 1:
                need_review.append((k, sorted(names), ps))

    # 字段来源：优先取「名称 == 平名」的那条（基础形态），否则取该号码第一条
    fieldmap = {}
    for k, rs in byno.items():
        base = next((r for r in rs if str(r.get('名称') or '') == mapping[k]), rs[0])
        fieldmap[k] = {f: base.get(f) for f in FIELD_COPY}

    missing = [k for k in ('%04d' % i for i in range(1, N_MAX + 1)) if k not in mapping]
    return mapping, fieldmap, need_review, missing


def new_id(used):
    while True:
        rid = 'l_' + ''.join(random.choice('abcdefghijklmnopqrstuvwxyz0123456789')
                             for _ in range(13))
        if rid not in used:
            used.add(rid)
            return rid


def main():
    apply = '--apply' in sys.argv
    now = int(time.time() * 1000)

    mapping, fieldmap, need_review, missing = build_mapping()
    log('源（30周年冰箱贴）解析：%d 个号码，缺号 %d 个' % (len(mapping), len(missing)))
    if missing:
        log('  ⚠️ 缺号：%s' % missing[:20])
    if need_review:
        log('  需人工确认：%s' % need_review[:5])

    doc = rd(TGT)
    rows = doc.get('rows') or []
    log('\n目标（%s）当前 %d 条' % (SERIES, len(rows)))

    byno, used_ids = {}, set()
    for r in rows:
        used_ids.add(str(r.get('_id')))
    # 记录每条最终号码
    plan_renum, unresolved, occupied = [], [], {}
    for r in rows:
        nm = str(r.get('名称') or '')
        k = num4(r.get('编号'))
        want = None
        if k and mapping.get(k) == nm:
            want = k                                   # 编号已正确
        else:
            # 名字在对照表里属于哪个号码？（唯一命中才自动改号）
            cands = [kk for kk, vv in mapping.items() if vv == nm]
            cands = [c for c in cands if c not in occupied]
            if len(cands) == 1:
                want = cands[0]
                plan_renum.append((r, k, want, nm))
            else:
                unresolved.append((r, k, nm, cands))
        if want:
            occupied[want] = r
    log('\n  ▸ 编号/名字正确、无需改动：%d 条' % (len(rows) - len(plan_renum) - len(unresolved)))
    log('  ▸ 需要改号（名字对应另一个号码）：%d 条' % len(plan_renum))
    for r, old, new, nm in plan_renum:
        log('      %-6s → %-6s  %s' % (old or '(空)', new, nm))
    if unresolved:
        log('  ▸ ⚠️ 无法自动定位（名字不在对照表里 / 多个候选）：%d 条' % len(unresolved))
        for r, k, nm, c in unresolved:
            log('      %-6s  %s  候选=%s' % (k, nm, c))

    todo_new = [k for k in ('%04d' % i for i in range(1, N_MAX + 1))
                if k not in occupied and k in mapping]
    log('  ▸ 需要新建：%d 条（%s … %s）' % (len(todo_new), todo_new[0] if todo_new else '-',
                                        todo_new[-1] if todo_new else '-'))

    # 组装结果
    out_rows = []
    for r in rows:
        nr = dict(r)
        touched = False
        if nr.get('formCode') is None:          # 基础形态统一写 ''（与冰箱贴规范一致）
            nr['formCode'] = ''
            touched = True
        k = num4(r.get('编号'))
        nm = str(r.get('名称') or '')
        want = k if (k and mapping.get(k) == nm) else None
        if want is None:
            cands = [c for c in mapping if mapping[c] == nm and c in occupied and occupied[c] is r]
            want = cands[0] if cands else k
        if want and want != str(r.get('编号')):
            nr['编号'] = want
            touched = True
        if touched:
            nr['_upd'] = now
            nr['_rev'] = (int(r.get('_rev') or 0)) + 1
        out_rows.append(nr)

    for k in todo_new:
        fm = fieldmap.get(k) or {}
        nr = {
            '_id': new_id(used_ids),
            '名称': mapping[k],
            '大类': CAT_BIG,
            '小类': CAT_SMALL,
            'IP': IP,
            '系列': SERIES,
            '编号': k,
            'formCode': '',
        }
        for f in FIELD_COPY:                      # 属性 / 副属性 / 形态字段
            nr[f] = fm.get(f)
        nr.update({
            '状态': [],
            '存储地点': None,
            '购入日期': None,
            '购入价格': 0,
            '购入渠道': None,
            '封面': [],
            '短评': None,
            '持有': None,
            '端盒': False,
            '隐藏款': False,
            '_upd': now,
            '_rev': 1,
        })
        out_rows.append(nr)

    # 同号变体（未知图腾 A~Z）：与冰箱贴同规矩 —— 同号共存、formCode 两位零填、名称带后缀
    made_variants = 0
    for k, forms in EXTRA_FORMS.items():
        base = mapping.get(k)
        if not base:
            continue
        fm = fieldmap.get(k) or {}
        have = set(str(r.get('formCode') or '') for r in out_rows if num4(r.get('编号')) == k)
        for code, suffix in forms:
            if code in have:
                continue
            nr = {
                '_id': new_id(used_ids),
                '名称': '%s（%s）' % (base, suffix),
                '大类': CAT_BIG,
                '小类': CAT_SMALL,
                'IP': IP,
                '系列': SERIES,
                '编号': k,
                'formCode': code,
            }
            for f in FIELD_COPY:
                nr[f] = fm.get(f)
            nr.update({
                '状态': [],
                '存储地点': None,
                '购入日期': None,
                '购入价格': 0,
                '购入渠道': None,
                '封面': [],
                '短评': None,
                '持有': None,
                '端盒': False,
                '隐藏款': False,
                '_upd': now,
                '_rev': 1,
            })
            out_rows.append(nr)
            made_variants += 1
    if EXTRA_FORMS:
        log('  ▸ 同号变体（如未知图腾 A~Z）：新建 %d 条' % made_variants)

    # 统一补/校正 属性 / 副属性 / 形态字段（新建的 + 你原有的 19 条都补，保证整套一致）
    filled = 0
    for r in out_rows:
        k = num4(r.get('编号'))
        fm = fieldmap.get(k)
        if not fm:
            continue
        changed = False
        for f in FIELD_COPY:
            cur, want = r.get(f, None), fm.get(f)
            if cur is None and want is None:
                continue
            if cur != want:
                r[f] = want
                changed = True
        if changed:
            r['_upd'] = now
            r['_rev'] = (int(r.get('_rev') or 0)) + 1
            filled += 1
    log('  ▸ 补齐 属性/副属性/形态字段：%d 条' % filled)

    # 排序：先按图鉴号，再按形态序（formCode 空 = 基础形态在最前）
    out_rows.sort(key=lambda r: (str(r.get('编号') or ''), str(r.get('formCode') or '')))
    log('\n结果：共 %d 条（原 %d + 新建 %d）' % (len(out_rows), len(rows), len(todo_new)))

    # 自检（注意：同号变体是刻意共号的，按「编号+formCode」判重）
    keys = [(str(r.get('编号')), str(r.get('formCode') or '')) for r in out_rows]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    base_nums = set(str(r.get('编号')) for r in out_rows if not str(r.get('formCode') or ''))
    gap = [k for k in ('%04d' % i for i in range(1, N_MAX + 1)) if k not in base_nums]
    allowed = dict((k, set([mapping[k]] + ['%s（%s）' % (mapping[k], s) for _, s in forms]))
                   for k, forms in EXTRA_FORMS.items() if k in mapping)
    badname = [(r.get('编号'), r.get('名称')) for r in out_rows
               if str(r.get('名称')) not in allowed.get(str(r.get('编号')), set([mapping.get(str(r.get('编号')))]))]
    log('自检：重复（编号+形态）%d 个 %s ｜ 缺号 %d 个 %s ｜ 名字与对照表不符 %d 条 %s'
        % (len(dup), dup[:5], len(gap), gap[:5], len(badname), badname[:5]))

    if not apply:
        log('\n【干跑】没有写盘。确认无误后加 --apply。')
        return 0

    bak = TGT + '.bak-badges-' + time.strftime('%Y%m%d')
    if not os.path.exists(bak):
        shutil.copy2(TGT, bak)
        log('\n已备份 → %s' % os.path.relpath(bak, ROOT).replace(os.sep, '/'))
    doc['rows'] = out_rows
    wr(TGT, doc)
    log('已写入 %s（%d 条）' % (os.path.relpath(TGT, ROOT).replace(os.sep, '/'), len(out_rows)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
