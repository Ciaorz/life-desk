# -*- coding: utf-8 -*-
"""
fill_item_covers.py —— 把一个文件夹里的图片，按「编号」批量填成藏品封面

场景：你用 取图工具.html（或 fetch_images.py）从淘宝下了一整套图，
      文件名形如 `0001-xxx.jpg`、`0012-xxx.webp`，数字就是图鉴号 →
      想一次性把它们设成「全图鉴金属徽章 / 30周年冰箱贴」等系列里对应条目的封面。

用法
----
    # 1) 先干跑：只打印对照表，一个字都不写
    python tools/fill_item_covers.py --dir "E:\\...\\alicdn-20261004" --series "全图鉴金属徽章"

    # 2) 看着没问题再写
    python tools/fill_item_covers.py --dir "E:\\...\\alicdn-20261004" --series "全图鉴金属徽章" --apply

常见参数
----
    --series  <名>     目标系列（必填）。只在这个系列里找条目。
    --shift   N        编号 = 文件名里的数字 + N。**采集来的图常带偏移**：
                       比如页面杂图占掉了前 42 个号，那么 0064 其实对应图鉴 0022，
                       就跑 `--shift -42`。
    --only    A-B      只处理文件名数字在这个区间里的（留空＝全部）。用来把
                       「前面的页面横幅 / 店铺 logo」排除掉。
    --ver     冰箱贴|贴纸  只给「30周年冰箱贴」的某个版本填；不填＝两版都填（各一套，图片共用）
    --cat     小类      不填＝按记录自己的小类分目录（多数是 徽章 / 冰箱贴 / 贴纸）
    --start   N        文件名里没有数字时，从第 N 号开始按顺序对号
    --max-width 800    展示图的最长边（默认 800；0=不缩放）
    --with-orig        顺带把原图也放进 data/orig（默认不存，省磁盘）
    --force            已有封面的条目也覆盖（默认跳过，只在报告里列出）

会改动什么
----
    ① data/images/series/<小类>-封面-NN/<小类>-<名称>-<编号>.webp   ← 记录里存的展示图
    ② data/thumbs/series/<小类>-封面-NN/<同名>.webp                ← 手机端读的缩略图（要推 R2）
    ③ 数据分片 / lifedesk.json 里对应条目的 `封面` 字段（打新 _upd、_rev+1）
    ④ 源文件夹里写一份 _covers_manifest.json 台账
    每个被改的数据文件都先备份成 `<文件>.bak-cv-<时间戳>`。

⚠️ 跑之前先让用户 **完全关闭** 电脑端页面（那页面每 20 秒把内存快照全量回写，会盖掉脚本改动）。
⚠️ 跑完还要做两件事手机端才看得到：① 点「上传封面」把 thumbs 推到 R2；② 点 ☁上传把记录推到 D1。
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

try:
    from PIL import Image
except ImportError:
    print('[!] 需要 Pillow：C:\\Users\\biode\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\pip install pillow')
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif')
PER_DIR = 100                      # 每个封面夹最多 100 张（跟 app.js 的 pickCoverFolder 一致）
FOLDER_ROW_CAP = 1000              # 单目录超过 1000 会被 GitHub 截断，所以必须分夹

TS = time.strftime('%Y%m%d-%H%M%S')
_touched = set()


def log(*a):
    print(*a, flush=True)


def safe_name(s):
    """跟 app.js 的 safeFileName 一致"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', str(s or '')).strip()
    return s[:60] or '未命名'


def pad4(n):
    return str(n).rjust(4, '0')


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
    bak = p + '.bak-cv-' + TS
    shutil.copy2(p, bak)
    log('  已备份 → %s' % os.path.relpath(bak, ROOT))


# ---------------------------------------------------------------- 收集数据
def collect_files():
    """返回 [(路径, 容器对象, 容器里的行数组), …]；容器对象改了要写回"""
    out = []
    idx_path = os.path.join(DATA, 'lifedesk.json')
    idx = load(idx_path)
    main = idx.get('__main') or {}
    for mk, arr in main.items():
        if isinstance(arr, list):
            out.append((idx_path, ('__main', idx, mk), arr))
    for p in sorted(glob.glob(os.path.join(DATA, '**', '*-data.json'), recursive=True)):
        if '_bak' in p:
            continue
        try:
            d = load(p)
        except Exception as e:
            log('[!] 读不了 %s：%s' % (p, e))
            continue
        rows = d.get('rows') if isinstance(d, dict) else d
        if isinstance(rows, list):
            out.append((p, ('shard', d), rows))
    return out


def series_rows(files, series, ver):
    """找出目标系列的所有记录，返回 [(行, 所属文件路径, 容器)]"""
    hits = []
    for p, container, rows in files:
        for r in rows:
            if not isinstance(r, dict):
                continue
            if str(r.get('系列') or '').strip() != series:
                continue
            if ver and str(r.get('版本') or '').strip() != ver:
                continue
            hits.append((r, p, container))
    return hits


# ---------------------------------------------------------------- 图片文件
def scan_images(folder, start):
    files = []
    for name in sorted(os.listdir(folder)):
        if name.startswith('_'):
            continue
        if os.path.splitext(name)[1].lower() not in EXTS:
            continue
        full = os.path.join(folder, name)
        if os.path.isfile(full):
            files.append((name, full))
    numbered = []
    plain = []
    for name, full in files:
        m = re.match(r'^(\d{1,4})(?=[-_. ]|$)', name)
        if m:
            numbered.append((int(m.group(1)), name, full))
        else:
            plain.append((name, full))
    # 没有数字的文件，按排序从 start 往后顺延编号
    seq = start
    for name, full in plain:
        while any(n == seq for n, _, _ in numbered):
            seq += 1
        numbered.append((seq, name, full))
        seq += 1
    numbered.sort(key=lambda x: x[0])
    return numbered


# ---------------------------------------------------------------- 图片处理
def to_webp(src, max_width, quality):
    im = Image.open(src)
    if im.mode in ('P', 'LA', 'RGBA'):
        im = im.convert('RGBA')
    else:
        im = im.convert('RGB')
    if max_width and max(im.size) > max_width:
        r = max_width / float(max(im.size))
        im = im.resize((max(1, int(im.size[0] * r)), max(1, int(im.size[1] * r))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=quality, method=6)
    return buf.getvalue()


def plan_folders(cat, count):
    """分配目标文件夹：优先把最后一个没满 100 的填满，再开新夹（跟 pickCoverFolder 同规则）"""
    base = os.path.join(DATA, 'images', 'series')
    prefix = safe_name(cat) + '-封面'
    dirs = []
    if os.path.isdir(base):
        for d in os.listdir(base):
            p = os.path.join(base, d)
            if os.path.isdir(p) and re.match('^' + re.escape(prefix) + r'-\d+$', d):
                dirs.append(d)
    dirs.sort(key=lambda d: int(d.rsplit('-', 1)[1]))
    plan = []
    left = count
    if dirs:
        last = dirs[-1]
        used = len([f for f in os.listdir(os.path.join(base, last)) if not f.startswith('_')])
        room = max(0, PER_DIR - used)
        if room:
            take = min(room, left)
            plan.append((last, take))
            left -= take
        nn = int(last.rsplit('-', 1)[1])
    else:
        nn = 0
    while left > 0:
        nn += 1
        take = min(PER_DIR, left)
        plan.append(('%s-%02d' % (prefix, nn), take))
        left -= take
    return plan


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--dir', required=True, help='装着图片的文件夹')
    ap.add_argument('--series', required=True, help='目标系列名')
    ap.add_argument('--shift', type=int, default=0,
                    help='编号 = 文件名数字 + shift（采集图常带偏移，如 -42）')
    ap.add_argument('--only', default='', help='只处理文件名数字在 A-B 之间的，如 64-193')
    ap.add_argument('--ver', default='', help='只填某个版本（如 贴纸）')
    ap.add_argument('--cat', default='', help='强制指定小类（决定封面目录）')
    ap.add_argument('--start', type=int, default=1, help='文件名无数字时的起始编号')
    ap.add_argument('--max-width', type=int, default=800)
    ap.add_argument('--with-orig', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    folder = os.path.abspath(args.dir)
    if not os.path.isdir(folder):
        log('[!] 文件夹不存在：%s' % folder)
        return 2

    imgs = scan_images(folder, args.start)

    # --only A-B：只处理文件名数字在这个区间的（把前面的页面横幅 / 店铺 logo 排除掉）
    if args.only:
        m = re.match(r'^(\d+)\s*-\s*(\d+)$', args.only.strip())
        if not m:
            log('[!] --only 要写成 A-B，比如 64-193')
            return 2
        lo, hi = int(m.group(1)), int(m.group(2))
        before = len(imgs)
        imgs = [x for x in imgs if lo <= x[0] <= hi]
        log('按 --only %d-%d 过滤：%d → %d 张' % (lo, hi, before, len(imgs)))

    log('=' * 74)
    log('源文件夹：%s' % folder)
    log('图片：%d 张（文件名 %s … %s）' % (
        len(imgs), imgs[0][0] if imgs else '-', imgs[-1][0] if imgs else '-'))
    if args.shift:
        log('编号偏移：文件名数字 %+d ＝ 条目编号（%s → %s）' % (
            args.shift, imgs[0][0] if imgs else '-', (imgs[0][0] + args.shift) if imgs else '-'))
    log('目标系列：%s%s%s' % (args.series, ('（版本=%s）' % args.ver) if args.ver else '',
                            ('（小类=%s）' % args.cat) if args.cat else ''))
    log('=' * 74)
    if not imgs:
        log('这个文件夹里没找到图片。')
        return 1

    files = collect_files()
    rows = series_rows(files, args.series, args.ver)
    log('系列里找到 %d 条记录' % len(rows))
    if not rows:
        log('[!] 没找到这个系列的记录，检查一下 --series 的写法（要和数据里的「系列」字段完全一致）')
        return 1

    # 编号 → 记录。同一个编号可能有多条（未知图腾 26 变体、冰箱贴/贴纸两版）
    by_no = {}
    for r, p, c in rows:
        no = str(r.get('编号') or '').strip()
        if not no:
            continue
        try:
            n = int(re.sub(r'^[#＃]', '', no))
        except ValueError:
            continue
        by_no.setdefault(n, []).append((r, p, c))

    # 编号 → 图片（同一个号也可能有好几张，比如未知图腾 A…Z 各一张）
    # 注意：这里用「条目编号」＝文件名数字 + shift
    pics_by_no = {}
    for n, name, full in imgs:
        pics_by_no.setdefault(n + args.shift, []).append((name, full))

    def fileno_of(name):
        m = re.match(r'^(\d{1,4})', str(name))
        return m.group(1) if m else '----'

    pairs, missing, already, dup, extra = [], [], [], [], []
    for n in sorted(pics_by_no):
        pics = pics_by_no[n]
        recs = by_no.get(n) or []
        if not recs:
            for name, full in pics:
                missing.append((n, name))
            continue
        if len(recs) == len(pics):
            # 一一对应 —— 未知图腾那种「同号 N 张图 / 同号 N 条变体」就靠这个
            if len(recs) > 1:
                dup.append((n, len(recs)))
            use = list(zip(pics, [x[0] for x in recs], [x[1] for x in recs], [x[2] for x in recs]))
        elif len(pics) == 1:
            # 一张图给同号的多条（冰箱贴 / 贴纸 两版共用同一张图）
            use = [(pics[0], x[0], x[1], x[2]) for x in recs]
            if len(recs) > 1:
                dup.append((n, len(recs)))
        else:
            use = list(zip(pics, [x[0] for x in recs], [x[1] for x in recs], [x[2] for x in recs]))
            for name, full in pics[len(recs):]:
                extra.append((n, name))
        for (name, full), r, p, c in use:
            if r.get('封面') and not args.force:
                already.append((n, r.get('名称'), r.get('版本') or ''))
                continue
            pairs.append((n, name, full, r, p, c))

    log('')
    log('对照表（前 25 条）：')
    for n, name, full, r, p, c in pairs[:25]:
        log('  文件 %s → 编号 %s  %-16s %s' % (
            fileno_of(name), pad4(n), (r.get('名称') or '?')[:16], name[:34]))
    if len(pairs) > 25:
        log('  … 还有 %d 条' % (len(pairs) - 25))
    log('')
    log('小结：可配对 %d 张 ｜ 记录里已有封面(跳过) %d ｜ 系列里没有这个号 %d ｜ 同号多条 %d'
        % (len(pairs), len(already), len(missing), len(set(n for n, _ in dup))))
    if missing:
        log('  系列里没有的号：%s' % ', '.join(
            '%s(文件%s)' % (pad4(n), fileno_of(nm)) for n, nm in missing[:30]))
    if dup:
        log('  同号多条（按顺序一一对应；图不够时会把最后一张重复用）：%s'
            % ', '.join('%s×%d' % (pad4(n), k) for n, k in sorted(set(dup))))
    if extra:
        log('  ⚠ 图比记录多的号（多出来的没处放，已忽略）：%s'
            % ', '.join('%s(%s)' % (pad4(n), nm[:20]) for n, nm in extra[:10]))

    if not args.apply:
        log('')
        log('这是【干跑】—— 什么都没写。确认无误后加 --apply 再跑一次。')
        return 0

    if not pairs:
        log('没有需要写的，收工。')
        return 0

    # —— 真写 ——
    log('')
    log('开始写盘…')

    def cat_of(item):
        return safe_name(args.cat or str(item[3].get('小类') or '').strip() or 'collection')

    # ① 先定文件名。同一个「小类 + 编号」出现多条时（未知图腾 26 变体、冰箱贴/贴纸两版）
    #    必须补一个尾巴，否则后面那张会盖掉前面那张。
    seen = {}
    for it in pairs:
        k = (cat_of(it), it[0])
        seen[k] = seen.get(k, 0) + 1
    fname_of = {}
    for it in pairs:
        n, name, full, r, p, c = it
        cat = cat_of(it)
        extra = ''
        if seen[(cat, n)] > 1:
            fc = str(r.get('formCode') or '').strip()
            extra = '-' + (safe_name(fc) if fc else str(r.get('_id') or '')[-4:])
        fname_of[id(r)] = '%s-%s-%s%s.webp' % (cat, safe_name(r.get('名称') or 'x'), pad4(n), extra)

    # ② 每 100 张一个夹
    layout = {}
    for cat in sorted({cat_of(it) for it in pairs}):
        items = [it for it in pairs if cat_of(it) == cat]
        i = 0
        for sub, take in plan_folders(cat, len(items)):
            for _ in range(take):
                it = items[i]
                layout[id(it[3])] = sub
                i += 1
        log('  %s：%d 张 → %s' % (
            cat, len(items), ', '.join(sorted({layout[id(it[3])] for it in items}))))

    ok = fail = 0
    done_rows = set()
    for n, name, full, r, p, c in pairs:
        sub = layout[id(r)]
        fname = fname_of[id(r)]
        rel_dir = os.path.join('series', sub)
        try:
            img_bytes = to_webp(full, args.max_width, 90)
            th_bytes = to_webp(full, 400, 82)
        except Exception as e:
            log('  [!] 转码失败 %s：%s' % (name, e))
            fail += 1
            continue
        dst_dir = os.path.join(DATA, 'images', rel_dir)
        th_dir = os.path.join(DATA, 'thumbs', rel_dir)
        for d in (dst_dir, th_dir):
            if not os.path.isdir(d):
                os.makedirs(d)
        with open(os.path.join(dst_dir, fname), 'wb') as f:
            f.write(img_bytes)
        with open(os.path.join(th_dir, fname), 'wb') as f:
            f.write(th_bytes)
        if args.with_orig:
            od = os.path.join(DATA, 'orig', rel_dir)
            if not os.path.isdir(od):
                os.makedirs(od)
            shutil.copy2(full, os.path.join(od, os.path.splitext(fname)[0] + os.path.splitext(full)[1]))
        # ③ 改记录
        rel = 'data/images/' + rel_dir.replace('\\', '/') + '/' + fname
        r['封面'] = [{'imageUrl': rel}]
        r['_upd'] = int(time.time() * 1000)
        r['_rev'] = int(r.get('_rev') or 0) + 1
        done_rows.add(id(r))
        ok += 1

    # ④ 落盘（只写真的改过行的文件）
    written = []
    for p, container, rows_ in files:
        if not any(id(r) in done_rows for r in rows_):
            continue
        backup(p)
        dump(p, container[1])
        written.append(os.path.relpath(p, ROOT))
    log('  写盘完成：%d 张，失败 %d；改了 %d 个数据文件' % (ok, fail, len(written)))
    for w in written:
        log('    · %s' % w)

    # ⑤ 台账
    man = {
        'tool': 'fill_item_covers.py', 'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'dir': folder, 'series': args.series, 'ver': args.ver,
        'rows': [{'no': n, 'src': name,
                  'file': 'series/' + layout[id(r)] + '/' + fname_of[id(r)],
                  'item': r.get('名称'), 'id': r.get('_id')}
                 for n, name, full, r, p, c in pairs],
    }
    dump(os.path.join(folder, '_covers_manifest.json'), man)

    log('')
    log('=' * 74)
    log('还差两步，手机端才看得到：')
    log('  ① 打开页面 → 云同步面板 → 点「上传封面」（把 data/thumbs 推到 R2）')
    log('  ② 再点 ☁上传（把记录推到 D1）')
    log('=' * 74)
    return 0


if __name__ == '__main__':
    sys.exit(main())
