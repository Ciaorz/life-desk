# -*- coding: utf-8 -*-
"""
migrate_vp_box_units.py —— v170 一次性数据迁移：封面「位移」的旧单位 → 新单位

背景（app.js 里 vpNorm/vpIsBox 那段注释也有）：
  · 老：位移 x/y = `background-position:(50-x)% (50-y)%`，单位是「背景**溢出**的百分比」；
  · 新：位移 x/y = 取景层的 `transform:translate(x%, y%)`，单位是「**框**的百分比」。
  两者换算关系（保持**卡片上**的观感不变）：
      tx = -(1 - s) · x
      ty = -(1 - s·B/A) · y
  其中 B = 卡片封面框的宽高比 = 3/4.2（=0.7142857），A = 那张图的长宽比（宽/高）。
  ⚠️ 派生：s=1 时 tx 恒为 0（老写法里横向溢出为 0，x 本来就没起作用）。

为什么必须迁：不迁的话，老值会被当成新单位用（比如 y=97 会变成「往下推 97% 的框高」＝飞出框外）。
app.js 里做了兜底：**没打 v:2 标记的视口一律忽略位移**（居中显示，不会乱飞），
所以就算暂时不迁，界面也不会坏，只是那几条的位移「暂时看不到」。

用法：
    python tools/migrate_vp_box_units.py            # 干跑（默认，只报告）
    python tools/migrate_vp_box_units.py --apply    # 真写（会先备份 + 打 v:2 标记）
    python tools/migrate_vp_box_units.py --apply --force   # 连「只有缩放、没动位移」的也补 v:2 标记

⚠️ 跑之前请**完全关闭电脑端页面**（它会每 20 秒把内存快照写回磁盘，直接盖掉这里的改动）。
"""
import io, os, sys, json, shutil, datetime, struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
MAIN = os.path.join(DATA, 'lifedesk.json')
B = 3.0 / 4.2                       # 卡片封面框宽高比（参考基准）
COVER_FIELDS = ('封面', '照片', 'IP图像', '系列封面', '图片')
STAMP = 'v170'

APPLY = '--apply' in sys.argv
FORCE = '--force' in sys.argv


def img_aspect(rel):
    """尽力算出一张图的长宽比（宽/高）。算不出来返回 (1.0, '兜底')"""
    p = str(rel or '')
    if not p:
        return 1.0, '空路径'
    if p.startswith('data:'):
        import base64, re
        m = re.match(r'^data:image/[a-z0-9.+-]+;base64,(.*)$', p, re.S)
        if not m:
            return 1.0, 'dataURL 非 base64'
        raw = base64.b64decode(m.group(1))
        return _aspect_from_bytes(raw)
    if p.startswith('http') or p.startswith('//'):
        return 1.0, '外链（没下载）'
    fp = os.path.join(ROOT, p.replace('/', os.sep))
    if not os.path.isfile(fp):
        return 1.0, '本地文件不存在'
    try:
        from PIL import Image
        with Image.open(fp) as im:
            w, h = im.size
        if not h:
            return 1.0, '尺寸异常'
        return w / float(h), 'ok'
    except Exception as e:
        return 1.0, '读图失败(%s)' % type(e).__name__


def _aspect_from_bytes(raw):
    """不依赖 PIL 的兜底：认 png / jpeg / webp(VP8X/VP8/VP8L) / gif 的头"""
    try:
        if raw[:8] == b'\x89PNG\r\n\x1a\n':
            w, h = struct.unpack('>II', raw[16:24])
            return (w / float(h), 'ok') if h else (1.0, '尺寸异常')
        if raw[:3] == b'GIF':
            w, h = struct.unpack('<HH', raw[6:10])
            return (w / float(h), 'ok') if h else (1.0, '尺寸异常')
        if raw[:2] == b'\xff\xd8':
            i = 2
            while i < len(raw) - 9:
                if raw[i] != 0xFF:
                    i += 1
                    continue
                mk = raw[i + 1]
                if mk in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack('>HH', raw[i + 5:i + 9])
                    return (w / float(h), 'ok') if h else (1.0, '尺寸异常')
                if mk in (0xD8, 0xD9) or 0xD0 <= mk <= 0xD7:
                    i += 2
                    continue
                seg = struct.unpack('>H', raw[i + 2:i + 4])[0]
                i += 2 + seg
            return 1.0, 'jpeg 没找到 SOF'
        if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
            fourcc = raw[12:16]
            if fourcc == b'VP8X':
                w = 1 + int.from_bytes(raw[24:27], 'little')
                h = 1 + int.from_bytes(raw[27:30], 'little')
                return w / float(h), 'ok'
            if fourcc == b'VP8 ':
                # 关键帧头：起始码 9d 01 2a 后跟 2 字节宽 / 2 字节高（低 14 位）
                w = struct.unpack('<H', raw[26:28])[0] & 0x3FFF
                h = struct.unpack('<H', raw[28:30])[0] & 0x3FFF
                return (w / float(h), 'ok') if h else (1.0, '尺寸异常')
            if fourcc == b'VP8L':
                b0, b1, b2, b3 = raw[21], raw[22], raw[23], raw[24]
                w = 1 + (((b1 & 0x3F) << 8) | b0)
                h = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
                return w / float(h), 'ok'
        return 1.0, '不认识的图片格式'
    except Exception as e:
        return 1.0, '解析异常(%s)' % type(e).__name__


def round1(v):
    return round(float(v) * 10) / 10.0


def migrate_vp(vp, name, report):
    """返回 (新对象, 是否改动)。已经打过 v:2 的原样返回。"""
    if not isinstance(vp, dict):
        return vp, False
    if int(vp.get('v') or 0) >= 2:
        return vp, False
    s = float(vp.get('s') or 1)
    x = float(vp.get('x') or 0)
    y = float(vp.get('y') or 0)
    if abs(x) < 0.05 and abs(y) < 0.05:
        # 只有缩放：位移本来就是 0，补个标记即可（不动任何数值）
        if FORCE or APPLY:
            o = dict(vp)
            o['v'] = 2
            return o, True
        return vp, False
    a, how = img_aspect(vp.get('_img') or '')
    if how != 'ok':
        report['warn'].append('%s：图片长宽比取不到（%s）→ 按正方形 1:1 估算' % (name, how))
    nx = -(1 - s) * x
    ny = -(1 - s * B / a) * y
    o = dict(vp)
    o.pop('_img', None)
    o['x'] = round1(max(-100, min(100, nx)))
    o['y'] = round1(max(-100, min(100, ny)))
    o['v'] = 2
    report['rows'].append((name, s, round1(x), round1(y), o['x'], o['y'], round(a, 3)))
    return o, True


def main():
    if not os.path.isfile(MAIN):
        print('找不到 ' + MAIN)
        return 1
    main_json = json.load(io.open(MAIN, encoding='utf-8'))
    shards = main_json.get('shards') or {}

    targets = []                      # [(文件路径, 模块名)]，先存 __main__，再存各分片
    targets.append((MAIN, '__main__'))
    for k, info in shards.items():
        fn = (info or {}).get('file')
        if not fn:
            continue
        fp = os.path.join(DATA, fn)
        if os.path.isfile(fp):
            targets.append((fp, info.get('module') or k))

    report = {'rows': [], 'warn': [], 'scanned': 0, 'changed': 0, 'stamped': 0}
    writes = []                       # [(文件路径, 新内容)]

    for fp, mod in targets:
        try:
            j = json.load(io.open(fp, encoding='utf-8'))
        except Exception as e:
            report['warn'].append('%s 读不了：%s' % (os.path.basename(fp), e))
            continue
        dirty = False

        def walk(rows):
            nonlocal dirty
            for r in (rows or []):
                if not isinstance(r, dict):
                    continue
                report['scanned'] += 1
                nm = r.get('名称') or r.get('IP名称') or r.get('系列名称') or r.get('_id') or '?'
                # 主封面
                for f in COVER_FIELDS:
                    imgs = r.get(f)
                    if isinstance(imgs, list) and imgs and isinstance(imgs[0], dict) and isinstance(imgs[0].get('viewport'), dict):
                        vp = dict(imgs[0]['viewport'])
                        vp['_img'] = imgs[0].get('imageUrl')
                        nv, ch = migrate_vp(vp, '%s[%s]' % (nm, f), report)
                        if ch:
                            nv.pop('_img', None)
                            imgs[0]['viewport'] = nv
                            dirty = True
                            if vp.get('x') or vp.get('y'):
                                report['changed'] += 1
                            else:
                                report['stamped'] += 1
                        break
                # 附件封面（挂在附件对象上）
                for i, a in enumerate(r.get('附件') or []):
                    if isinstance(a, dict) and isinstance(a.get('封面视口'), dict):
                        vp = dict(a['封面视口'])
                        vp['_img'] = a.get('封面')
                        nv, ch = migrate_vp(vp, '%s·附件%d' % (nm, i + 1), report)
                        if ch:
                            nv.pop('_img', None)
                            a['封面视口'] = nv
                            dirty = True
                            if vp.get('x') or vp.get('y'):
                                report['changed'] += 1
                            else:
                                report['stamped'] += 1

        if mod == '__main__':
            for k, rows in (j.get('__main') or {}).items():
                walk(rows)
        else:
            walk(j.get('rows'))
        if dirty:
            writes.append((fp, j))

    print('=' * 68)
    print('扫描 %d 行，需要换算位移的 %d 条，只需补 v:2 标记的 %d 条'
          % (report['scanned'], report['changed'], report['stamped']))
    for w in report['warn']:
        print('  ⚠️ ' + w)
    if report['rows']:
        print('\n换算明细（老 x/y → 新 x/y）：')
        for nm, s, ox, oy, nx, ny, a in report['rows']:
            print('  %-26s s=%-5s A=%-6s  x %6s→%-7s  y %7s→%-7s' % (nm[:26], s, a, ox, nx, oy, ny))
    if not writes:
        print('\n（没有要写的文件）')
        return 0

    if not APPLY:
        print('\n以上为**干跑**。确认无误后加 --apply 真写。')
        print('⚠️ 跑之前务必完全关闭电脑端页面（它每 20 秒会把内存快照写回磁盘）。')
        return 0

    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    for fp, j in writes:
        shutil.copy2(fp, fp + '.bak-' + STAMP + '-' + ts)
        io.open(fp, 'w', encoding='utf-8').write(json.dumps(j, ensure_ascii=False, indent=2))
        print('已写 + 备份：%s  →  %s.bak-%s-%s' % (os.path.basename(fp), os.path.basename(fp), STAMP, ts))
    print('\n完成。请重新打开电脑端页面确认，然后点「☁ 上传」把记录推到 D1。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
