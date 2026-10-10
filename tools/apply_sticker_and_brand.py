# -*- coding: utf-8 -*-
"""
apply_sticker_and_brand.py —— 两件事一起做

  ① 把「30周年冰箱贴 · 贴纸版」的 小类 改成「贴纸」
     ⚠️ 藏品是按**小类**分片的（`SHARD_FIELD.collection = '小类'`），
        所以改「小类」等于换文件：这些记录必须从 `data/冰箱贴-data.json`
        搬到 `data/贴纸-data.json`，并在主索引 `shards` 里登记 `贴纸` 分片。
        不搬、不登记的话，App 下次保存会把它们塞进 `lifedesk.json` 的 `__main`
        （没有专属分片的记录都落那儿），主索引会被 1300 多条撑爆。

  ② 给所有「IP = 宝可梦」的藏品加上 品牌 = 宝上海
     （同时在主索引的 `brands` 里登记「宝上海」，下拉那张牌一起有）

干跑默认，`--apply` 才写盘；逐文件备份 `*.bak-sb-<时间戳>`；幂等（跑第二遍报 0 条）。

用法
----
    cd E:\\自制软件\\生活后台\\clean
    python tools/apply_sticker_and_brand.py
    python tools/apply_sticker_and_brand.py --apply

⚠️ 写盘前先**完全关闭**连了本地目录的电脑端页面（它每 20 秒会把内存快照全量写回磁盘）。
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
DATA = os.path.join(ROOT, 'data')
INDEX = os.path.join(DATA, 'lifedesk.json')

APPLY = '--apply' in sys.argv
SERIES = '30周年冰箱贴'
VER_NEW = '贴纸'
SUB_NEW = '贴纸'
PK_IP = '宝可梦'
BRAND_NEW = '宝上海'


def load(p):
    with io.open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def dump(p, obj):
    tmp = p + '.tmp'
    with io.open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2).replace('\n', '\r\n'))
    os.replace(tmp, p)


def touch(r, now):
    r['_upd'] = now
    r['_rev'] = (int(r.get('_rev') or 0) or 0) + 1


def main():
    now = int(time.time() * 1000)
    ts = time.strftime('%Y%m%d-%H%M%S')

    idx = load(INDEX)
    shards = idx.setdefault('shards', {})
    main_mods = idx.get('__main') or {}

    # ---------- 收集所有 collection 分片文件 ----------
    files = []
    for p in sorted(glob.glob(os.path.join(DATA, '**', '*-data.json'), recursive=True)):
        if '_bak' in p or 'lifedesk.backup' in p:
            continue
        try:
            d = load(p)
        except Exception as e:
            print('[!] 读不了 %s：%s' % (os.path.relpath(p, ROOT), e))
            continue
        if isinstance(d, dict) and str(d.get('module') or '') == 'collection':
            files.append((p, d))

    sp_path = os.path.join(DATA, SUB_NEW + '-data.json')
    sp_abs = os.path.abspath(sp_path)
    existing_sp = []
    if os.path.exists(sp_path):
        try:
            existing_sp = load(sp_path).get('rows') or []
        except Exception as e:
            print('[!] %s 读不了：%s' % (os.path.relpath(sp_path, ROOT), e))

    # ============ 计算：① 要改小类的、要搬家的 ============
    def eff_sub(r):
        """改完小类之后这条记录属于哪个小类"""
        if r.get('系列') == SERIES and r.get('版本') == VER_NEW:
            return SUB_NEW
        return str(r.get('小类') or '')

    sub_fixed = []          # 小类 需要改写的行
    moves = []              # (源文件, 行) 需要搬进 贴纸-data.json
    for p, d in files:
        for r in (d.get('rows') or []):
            if not isinstance(r, dict):
                continue
            if r.get('系列') == SERIES and r.get('版本') == VER_NEW and str(r.get('小类') or '') != SUB_NEW:
                sub_fixed.append(r)
            if os.path.abspath(p) != sp_abs and eff_sub(r) == SUB_NEW:
                moves.append((p, r))

    have_sp_ids = set(str(r.get('_id')) for r in existing_sp if isinstance(r, dict))
    moves = [(p, r) for p, r in moves if str(r.get('_id')) not in have_sp_ids]
    need_shard = str((shards.get(SUB_NEW) or {}).get('file') or '') != (SUB_NEW + '-data.json')
    sp_total = len(existing_sp) + len(moves)

    # ============ 计算：② 要写品牌的 ============
    brand_files = []
    brand_total = 0
    for p, d in files:
        hit = [r for r in (d.get('rows') or [])
               if isinstance(r, dict) and str(r.get('IP') or '').strip() == PK_IP
               and r.get('名称') and str(r.get('品牌') or '') != BRAND_NEW]
        if hit:
            brand_files.append((p, d, hit))
            brand_total += len(hit)
    main_hit = [r for r in (main_mods.get('collection') or [])
                if isinstance(r, dict) and str(r.get('IP') or '').strip() == PK_IP
                and r.get('名称') and str(r.get('品牌') or '') != BRAND_NEW]
    brand_total += len(main_hit)

    cur_brands = idx.get('brands')
    if not isinstance(cur_brands, list):
        cur_brands = []
    need_brand_reg = BRAND_NEW not in cur_brands

    # ---------- 报告 ----------
    print('=' * 70)
    print('① 贴纸版 → 小类「%s」' % SUB_NEW)
    print('   要改「小类」的记录：%d 条' % len(sub_fixed))
    print('   要搬进 data/%s-data.json：%d 条（目标文件已有 %d 条 → 处理后 %d 条）'
          % (SUB_NEW, len(moves), len(existing_sp), sp_total))
    print('   shards 里登记「%s」分片：%s' % (SUB_NEW, '需要' if need_shard else '已有'))
    if sub_fixed:
        print('   （改之前的小类分布：%s）' % dict(Counter(str(r.get('小类')) for r in sub_fixed)))
    print('-' * 70)
    print('② IP = %s → 品牌「%s」' % (PK_IP, BRAND_NEW))
    print('   要写品牌的记录：%d 条' % brand_total)
    for p, d, hit in brand_files:
        print('      %-34s %d 条' % (os.path.relpath(p, ROOT), len(hit)))
    if main_hit:
        print('      %-34s %d 条' % ('lifedesk.json 的 __main', len(main_hit)))
    print('   品牌登记表登记「%s」：%s（现有 %s）'
          % (BRAND_NEW, '需要' if need_brand_reg else '已有', json.dumps(cur_brands, ensure_ascii=False)))
    print('=' * 70)

    if not (sub_fixed or moves or need_shard or brand_total or need_brand_reg):
        print('没有需要改的东西（幂等：都处理过了）。')
        return 0
    if not APPLY:
        print('\n[干跑] 未写盘。加上 --apply 真正写入（逐文件备份）。')
        return 0

    # ================= 1) 先在内存里改完，再统一落盘 =================
    #  （必须先改完再写：搬家那批记录同时也要加品牌，若先写 贴纸-data.json 再加品牌，
    #    写出去的就是没品牌的那一版。）
    for r in sub_fixed:
        r['小类'] = SUB_NEW
        touch(r, now)
    for p, d, hit in brand_files:
        for r in hit:
            r['品牌'] = BRAND_NEW
            touch(r, now)
    for r in main_hit:
        r['品牌'] = BRAND_NEW
        touch(r, now)
    if need_brand_reg:
        cur_brands.append(BRAND_NEW)
        idx['brands'] = cur_brands
    if need_shard:
        shards[SUB_NEW] = {"file": SUB_NEW + '-data.json', "module": "collection",
                           "coverDir": SUB_NEW + '-封面'}

    # 2) 从各分片里摘掉要搬走的行；记下哪些文件脏了
    dirty = set()
    removed = {}
    for p, r in moves:
        removed.setdefault(os.path.abspath(p), set()).add(str(r.get('_id')))
    for p, d in files:
        ids = removed.get(os.path.abspath(p))
        if ids:
            rows = d.get('rows') or []
            d['rows'] = [r for r in rows if str(r.get('_id')) not in ids]
            dirty.add(os.path.abspath(p))
    for p, d, hit in brand_files:
        dirty.add(os.path.abspath(p))

    # 3) 落盘
    touched = set()

    def backup(p):
        ap = os.path.abspath(p)
        if ap in touched:
            return
        touched.add(ap)
        if not os.path.exists(p):
            return          # 新文件（如第一次生成的 贴纸-data.json）没有可备份的旧版本
        bak = p + '.bak-sb-' + ts
        shutil.copy2(p, bak)
        print('已备份 → %s' % os.path.relpath(bak, ROOT))

    if moves or need_shard:
        backup(sp_path)
        dump(sp_path, {"schema": 2, "cat": SUB_NEW, "module": "collection",
                       "rows": existing_sp + [r for _, r in moves]})
        print('已写入 → %s（%d 条）' % (os.path.relpath(sp_path, ROOT), sp_total))
        try:
            os.makedirs(os.path.join(DATA, 'images', SUB_NEW + '-封面'), exist_ok=True)
        except Exception as e:
            print('[!] 建封面目录失败：%s' % e)

    for p, d in files:
        if os.path.abspath(p) not in dirty:
            continue
        backup(p)
        dump(p, d)
        print('已写入 → %s（%d 条）' % (os.path.relpath(p, ROOT), len(d.get('rows') or [])))

    if INDEX in touched or need_shard or need_brand_reg or main_hit:
        backup(INDEX)
        dump(INDEX, idx)
        print('已写入 → %s（shards / brands / __main）' % os.path.relpath(INDEX, ROOT))

    print('\n完成：改小类 %d 条、搬家 %d 条、登记分片 %s、写品牌 %d 条。'
          % (len(sub_fixed), len(moves), '是' if need_shard else '否', brand_total))
    print('请观察 40 秒确认文件没被覆盖，然后重开页面、点 ☁上传 推到 D1。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
