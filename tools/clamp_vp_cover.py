# -*- coding: utf-8 -*-
"""
clamp_vp_cover.py —— v173 一次性数据迁移：把「图比框大时会露白边」的位移夹回合法范围

背景
----
位移是取景层的 `transform:translate(框的百分比)`，理论上能一路拖到图跑出框外
（左侧 / 上方露一条框底色 = 白边）。用户就是碰到这个：
「放大图片到超出可视范围后，再向右移动图片，左侧被一条白条截断」。

v173 起**写入路径**会夹住（app.js 的 `cvClampCover`），但存量数据里已经存了超范围的位移，
卡片 / 详情页仍然会显示白边。本脚本按**同一套公式**把存量值夹回去：

    横向可动半幅 = 50·(s − 1)              （s 是**比例**：1.5 = 150%）
    纵向可动半幅 = 50·(s · F / A − 1)      （F = 封面框宽高比 6/7，A = 图片长宽比 宽/高）

只有「图比框大」（半幅 > 0）的那根轴才夹；图比框小的那根轴**不夹** ——
那种空白是图本身填不满，用户想挪就让他挪。图片长宽比取不到时**原样不动**（与 app.js 一致）。

用法
----
    python tools/clamp_vp_cover.py            # 干跑（默认，只报告）
    python tools/clamp_vp_cover.py --apply    # 真写（逐文件备份）

⚠️ 跑之前请**完全关闭电脑端页面**（它每 20 秒把内存快照写回磁盘，会直接盖掉这里的改动）。
"""
import io, os, sys, json, shutil, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
MAIN = os.path.join(DATA, 'lifedesk.json')
sys.path.insert(0, HERE)
from migrate_vp_box_units import img_aspect, round1, COVER_FIELDS  # noqa: E402

F = 6.0 / 7.0          # 封面框宽高比（v172 全项目统一）
STAMP = 'v173'
APPLY = '--apply' in sys.argv


def clamp_vp(vp, name, report):
    """返回 (新对象, 是否改动)。夹取是幂等的，所以重复跑不会来回改。"""
    if not isinstance(vp, dict):
        return vp, False
    s = float(vp.get('s') or 1)
    x = float(vp.get('x') or 0)
    y = float(vp.get('y') or 0)
    if abs(x) < 0.05 and abs(y) < 0.05:
        return vp, False                     # 没位移，不用管
    a, how = img_aspect(vp.get('_img') or '')
    if how != 'ok':
        report['warn'].append('%s：图片长宽比取不到（%s）→ 不夹（与 app.js 一致）' % (name, how))
        return vp, False
    half_x = 50.0 * (s - 1)
    half_y = 50.0 * (s * F / a - 1)
    nx, ny = x, y
    if half_x > 0:
        nx = max(-half_x, min(half_x, x))
    if half_y > 0:
        ny = max(-half_y, min(half_y, y))
    if round1(nx) == round1(x) and round1(ny) == round1(y):
        return vp, False
    o = dict(vp)
    o.pop('_img', None)
    o['x'] = round1(nx)
    o['y'] = round1(ny)
    report['rows'].append((name, s, round(a, 3), round1(x), round1(y), o['x'], o['y'],
                           round(half_x, 1), round(half_y, 1)))
    return o, True


def main():
    if not os.path.isfile(MAIN):
        print('找不到 ' + MAIN)
        return 1
    main_json = json.load(io.open(MAIN, encoding='utf-8'))
    shards = main_json.get('shards') or {}

    targets = [(MAIN, '__main__')]
    for k, info in shards.items():
        fn = (info or {}).get('file')
        if not fn:
            continue
        fp = os.path.join(DATA, fn)
        if os.path.isfile(fp):
            targets.append((fp, info.get('module') or k))

    report = {'rows': [], 'warn': [], 'scanned': 0, 'changed': 0}
    writes = []

    for fp, mod in targets:
        try:
            j = json.load(io.open(fp, encoding='utf-8'))
        except Exception as e:
            report['warn'].append('%s 读不了：%s' % (os.path.basename(fp), e))
            continue
        dirty = [False]

        def walk(rows):
            for r in (rows or []):
                if not isinstance(r, dict):
                    continue
                report['scanned'] += 1
                nm = r.get('名称') or r.get('IP名称') or r.get('系列名称') or r.get('_id') or '?'
                for f in COVER_FIELDS:
                    imgs = r.get(f)
                    if isinstance(imgs, list) and imgs and isinstance(imgs[0], dict) \
                            and isinstance(imgs[0].get('viewport'), dict):
                        vp = dict(imgs[0]['viewport'])
                        vp['_img'] = imgs[0].get('imageUrl')
                        nv, ch = clamp_vp(vp, '%s[%s]' % (nm, f), report)
                        if ch:
                            nv.pop('_img', None)
                            imgs[0]['viewport'] = nv
                            dirty[0] = True
                            report['changed'] += 1
                        break
                for i, a in enumerate(r.get('附件') or []):
                    if isinstance(a, dict) and isinstance(a.get('封面视口'), dict):
                        vp = dict(a['封面视口'])
                        vp['_img'] = a.get('封面')
                        nv, ch = clamp_vp(vp, '%s·附件%d' % (nm, i + 1), report)
                        if ch:
                            nv.pop('_img', None)
                            a['封面视口'] = nv
                            dirty[0] = True
                            report['changed'] += 1

        if mod == '__main__':
            for k, rows in (j.get('__main') or {}).items():
                walk(rows)
        else:
            walk(j.get('rows'))
        if dirty[0]:
            writes.append((fp, j))

    print('=' * 70)
    print('扫描 %d 行，需要夹回位移的 %d 条' % (report['scanned'], report['changed']))
    for w in report['warn'][:10]:
        print('  ⚠️ ' + w)
    if len(report['warn']) > 10:
        print('  …还有 %d 条类似提示' % (len(report['warn']) - 10))
    if report['rows']:
        print('\n明细（名称 · s · 图长宽比 · 老 x/y → 新 x/y · 允许的半幅）：')
        for nm, s, a, ox, oy, nx, ny, hx, hy in report['rows']:
            print('  %-24s s=%-5s A=%-6s  x %6s→%-7s y %6s→%-7s  (限 ±%s / ±%s)'
                  % (nm[:24], s, a, ox, nx, oy, ny, hx, hy))
    if not writes:
        print('\n（没有要写的文件 —— 数据已经都是合法的了）')
        return 0

    if not APPLY:
        print('\n以上为**干跑**。确认无误后加 --apply 真写。')
        print('⚠️ 跑之前务必完全关闭电脑端页面（它每 20 秒会把内存快照写回磁盘）。')
        return 0

    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    for fp, j in writes:
        shutil.copy2(fp, fp + '.bak-' + STAMP + '-' + ts)
        io.open(fp, 'w', encoding='utf-8').write(json.dumps(j, ensure_ascii=False, indent=2))
        print('已写 + 备份：%s' % os.path.basename(fp))
    print('\n完成。请重新打开电脑端页面确认，然后点「☁ 上传」把记录推到 D1。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
