# -*- coding: utf-8 -*-
"""
add_series_items.py —— 按名单批量给某个系列新增条目（编号自动顺延）

场景：你有一个系列（如「30周年纪念皮卡丘挂件」），手里有一份款式名单，
      想一次性建出 0001、0002… 这些条目，而不是在页面上一张张点「＋ 添加物品」。

用法
----
    # 1) 先干跑：只打印将要新建的清单，一个字都不写
    python tools/add_series_items.py --series "30周年纪念皮卡丘挂件" --names-file "下载图/皮卡丘毛绒30款/款式名单.txt"

    # 2) 确认后写入
    python tools/add_series_items.py --series "30周年纪念皮卡丘挂件" --names-file "..." --apply

参数
----
    --series  <名>   目标系列（必填，必须已存在）
    --names-file <f> 名单文件，一行一个名字；也支持 `0001,名字` / `0001 名字` 这种带编号的行
    --names   "a,b,c"  直接在命令行给名字（与 --names-file 二选一）
    --start   N      第一个编号（默认 1），往后顺延
    --ip      宝可梦   IP 字段（默认取系列登记里的「所属IP」）
    --cat     周边    大类（默认 周边）
    --sub     挂件    小类（**决定分片**，必须已存在对应分片）
    --brand   宝上海   品牌（不填则不写）
    --status  云游    初始状态（默认 云游；给「无」则留空）
    --upd-now        用当前时间做 _upd（默认用固定值，便于幂等比对）

会改动什么
----
    往该系列对应的小类分片（`idx.shards[小类].file`，如 `data/挂件-data.json`）里追加记录，
    每行都是新 _id，并按 app 的字段格式给全套默认字段（存储地点/购入价格/…=null）。
    写入前把该文件备份成 `<文件>.bak-add-<时间戳>`。

⚠️ 跑之前先让用户 **完全关闭** 电脑端页面（那页面每 20 秒把内存快照全量回写，会盖掉脚本改动）。
⚠️ 跑完点 ☁上传把记录推到 D1，手机端才会看到。
"""

import argparse
import glob
import io
import json
import os
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
TS = time.strftime('%Y%m%d-%H%M%S')
_touched = set()


def log(*a):
    print(*a, flush=True)


def load(p):
    return json.load(io.open(p, encoding='utf-8'))


def dump(p, obj):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2).replace('\n', '\r\n'))


def backup(p):
    ap = os.path.abspath(p)
    if ap in _touched or not os.path.exists(p):
        return
    _touched.add(ap)
    bak = p + '.bak-add-' + TS
    shutil.copy2(p, bak)
    log('  已备份 → %s' % os.path.relpath(bak, ROOT))


def pad4(n):
    return str(n).rjust(4, '0')


def read_names(args):
    raw = []
    if args.names_file:
        txt = io.open(args.names_file, encoding='utf-8-sig').read()
        for line in txt.replace('\r', '').split('\n'):
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            raw.append(s)
    else:
        raw = [x.strip() for x in str(args.names or '').split(',') if x.strip()]
    out = []
    for s in raw:
        m = re.match(r'^\s*(\d{1,4})\s*[,，、\t|:：\s]\s*(.+?)\s*$', s)
        if m:
            out.append((int(m.group(1)), m.group(2)))
        else:
            out.append((None, s))
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--series', required=True)
    ap.add_argument('--names-file', default='')
    ap.add_argument('--names', default='')
    ap.add_argument('--start', type=int, default=1)
    ap.add_argument('--ip', default='')
    ap.add_argument('--cat', default='周边')
    ap.add_argument('--sub', default='挂件')
    ap.add_argument('--brand', default='')
    ap.add_argument('--status', default='云游')
    ap.add_argument('--upd-now', action='store_true')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    items = read_names(args)
    if not items:
        log('[!] 没读到任何名字（用 --names-file 或 --names）')
        return 2

    idx_path = os.path.join(DATA, 'lifedesk.json')
    idx = load(idx_path)

    # 系列必须存在（顺便取它的 IP）
    se = None
    for p in sorted(glob.glob(os.path.join(DATA, '**', '*-data.json'), recursive=True)):
        if '_bak' in p:
            continue
        try:
            d = load(p)
        except Exception:
            continue
        for r in (d.get('rows') or []):
            if isinstance(r, dict) and str(r.get('系列名称') or '').strip() == args.series:
                se = r
    if not se:
        log('[!] 找不到系列「%s」—— 请先在页面上建好这个系列。' % args.series)
        return 2
    ip = args.ip or str(se.get('所属IP') or '')

    # 小类 → 分片文件
    sh = (idx.get('shards') or {}).get(args.sub)
    if not sh or sh.get('dirShard') or not sh.get('file'):
        log('[!] 小类「%s」还没有对应分片。请先在页面上录一条属于该小类的记录，' % args.sub)
        log('    或让 app 建好分片，再跑本脚本（避免把上千条塞进主索引）。')
        return 2
    shard_path = os.path.join(DATA, sh['file'].replace('/', os.sep))
    if not os.path.exists(shard_path):
        log('[!] 分片文件不存在：%s' % shard_path)
        return 2
    sd = load(shard_path)
    rows = sd.get('rows') or []

    # 已存在：同系列 + 同编号
    have = {}
    for r in rows:
        if isinstance(r, dict) and str(r.get('系列') or '').strip() == args.series:
            have[str(r.get('编号') or '').strip()] = r

    # 组装
    plan = []
    seq = args.start
    for no, nm in items:
        n = no if no is not None else seq
        seq = n + 1
        key = pad4(n)
        old = have.get(key)
        if old:
            plan.append(('skip', n, nm, str(old.get('名称') or '')))
        else:
            plan.append(('new', n, nm, ''))
    # 自动编号模式下，序号要连续
    if any(no is None for no, _ in items):
        seq = args.start
        fixed = []
        for no, nm in items:
            if no is None:
                while pad4(seq) in have or any(x[1] == seq and x[0] == 'new' for x in fixed):
                    seq += 1
                fixed.append(('new', seq, nm, ''))
                seq += 1
            else:
                fixed.append(('new', no, nm, ''))
        plan = fixed if not have else [
            ('skip', n, nm, str(have.get(pad4(n), {}).get('名称') or '')) if pad4(n) in have else ('new', n, nm, '')
            for _, n, nm, _ in fixed]

    log('=' * 74)
    log('系列：%s    IP：%s    大类：%s    小类：%s（分片 %s）' % (
        args.series, ip or '-', args.cat, args.sub, sh['file']))
    log('名单：%d 条；已有同号跳过 %d 条；本次新建 %d 条' % (
        len(plan), sum(1 for x in plan if x[0] == 'skip'), sum(1 for x in plan if x[0] == 'new')))
    log('=' * 74)
    log('')
    for st, n, nm, old in plan:
        if st == 'skip':
            log('  %s  %-28s （已有：%s）' % (pad4(n), nm, old))
        else:
            log('  %s  %s' % (pad4(n), nm))

    if not args.apply:
        log('')
        log('（干跑，什么都没写。确认后加 --apply）')
        return 0

    new_n = sum(1 for x in plan if x[0] == 'new')
    if not new_n:
        log('')
        log('没有需要新建的，收工。')
        return 0

    now = int(time.time() * 1000) if args.upd_now else 1791000000000
    for st, n, nm, old in plan:
        if st == 'skip':
            continue
        r = {
            '_id': 'it_%s_%s' % (now, pad4(n)),
            '名称': nm,
            '大类': args.cat,
            '小类': args.sub,
            'IP': ip or None,
            '系列': args.series,
            '编号': pad4(n),
            'formCode': '',
            '状态': ([] if str(args.status) in ('无', '', 'none') else [args.status]),
            '存储地点': None, '购入日期': None, '购入价格': None, '购入渠道': None,
            '封面': None, '短评': None,
            '端盒': False, '隐藏款': False,
            '_upd': now, '_rev': 1,
        }
        if args.brand:
            r['品牌'] = args.brand
        rows.append(r)

    backup(shard_path)
    sd['rows'] = rows
    dump(shard_path, sd)
    log('')
    log('写盘完成：新建 %d 条 → %s（现共 %d 条）' % (new_n, os.path.relpath(shard_path, ROOT), len(rows)))
    log('')
    log('=' * 74)
    log('下一步：重开页面 → ① 需要的话用 fill_item_covers.py 填封面 → ② 点 ☁上传推 D1')
    log('=' * 74)
    return 0


if __name__ == '__main__':
    sys.exit(main())
