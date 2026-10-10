# -*- coding: utf-8 -*-
"""
把「历史遗留」的展示图统一成现在的规范形态。

背景（为什么要做）：
  图片入库有两条路。表单里上传图片（ingestImageToLib）一直是规范的三份：
      原始字节 → data/orig/<封面目录>/<stem>.<ext>      （原图存档，无损）
      转成 WebP → data/images/<封面目录>/<stem>.webp    （展示图，记录里指向它）
      400px 缩略图 → data/thumbs/<封面目录>/<stem>.webp （上云 / 手机端读的那份）
  但「外链落盘 / 批量下载封面」（externalizeImages）在 v118 之前是**直接**把原图
  jpg/png 写进 data/images —— 既不存 orig、也不转 WebP。结果：
      · data/orig 比 data/images 少若干份原图存档
      · data/images 里混着一批 jpg/png
  v118 起代码已统一（两条路都走上面那三份），本脚本负责把**存量**补齐。

这个脚本做什么（幂等，可反复跑）：
  ① 原图（原始字节，不做任何转码）复制一份到 data/orig/<同路径>/<stem>.<ext>
  ② 用 Pillow 转成 WebP 写到 data/images/<同路径>/<stem>.webp（quality 92，不缩放）
  ③ 相关记录/文件里的 imageUrl 从 data/images/…<旧扩展名> 改成 data/images/…webp
  ④ 旧的 data/images/…<旧扩展名> 移到 data/_replaced_images_<日期>/（**只搬不删**）
  ⑤ 同步维护 data/images/_index.json（图片去重索引）—— 必须做！
     否则索引里还留着"旧 .jpg 路径"，以后重复导入同一张图时 imgIndexHit 会返回
     那个已经被搬走的路径，记录就指向一个不存在的文件。索引项的 key/value 一并改到新 webp。
  缩略图不用动：thumbOf() 折出来的路径是 data/thumbs/<同 stem>.webp，本来就对得上。
  另外：data/images 里「没被任何记录引用」的非 webp 老图（比如被换掉的前一版封面），
  不转码，直接搬进同一个备份目录，并把索引里的对应项删掉。

用法：
    python tools/normalize_legacy_images.py           # 干跑，只报告（默认）
    python tools/normalize_legacy_images.py --apply   # 真正执行
"""
import glob
import io
import json
import os
import shutil
import sys
import time

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_FIELDS = ['封面', '照片', 'IP图像', '系列封面', '图片']
WEBP_QUALITY = 92          # 与 app.js 的 makeWebpThumb(bytes, 999999, 0.92) 对齐
IMG_EXT = ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp')


def log(*a):
    print(*a, flush=True)


def record_files():
    """所有可能存着图片引用的 JSON（排除索引、备份、台账）。"""
    out = []
    for p in sorted(glob.glob(os.path.join(ROOT, 'data', '*-data.json'))):
        out.append(p)
    for p in sorted(glob.glob(os.path.join(ROOT, 'data', '*', '*.json'))):
        out.append(p)
    keep = []
    for p in out:
        b = os.path.basename(p)
        if b.startswith('lifedesk') or '.bak' in b or b.startswith('.'):
            continue
        if os.path.basename(os.path.dirname(p)) in ('images', 'orig', 'thumbs'):
            continue
        keep.append(p)
    return keep


def walk_refs(path):
    """产出 (row_index, field, img_index_or_None, imageUrl)，只读不改。"""
    try:
        with io.open(path, encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return []
    rows = d.get('rows') if isinstance(d, dict) else None
    if not isinstance(rows, list):
        return []
    out = []
    for ri, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        for fld in IMG_FIELDS:
            v = r.get(fld)
            if isinstance(v, list):
                for ii, it in enumerate(v):
                    if isinstance(it, dict) and it.get('imageUrl'):
                        out.append((ri, fld, ii, it['imageUrl'], d, r, it, rows))
            elif isinstance(v, str) and v.startswith('data/'):
                out.append((ri, fld, None, v, d, r, None, rows))
    return out


def non_webp_in_images():
    """data/images 下所有非 webp 的图片（相对仓库根的路径）。"""
    out = []
    base = os.path.join(ROOT, 'data', 'images')
    for dp, _dn, fs in os.walk(base):
        for f in fs:
            if os.path.splitext(f)[1].lower() not in IMG_EXT:
                continue
            if f.lower().endswith('.webp'):
                continue
            out.append(os.path.relpath(os.path.join(dp, f), ROOT).replace(os.sep, '/'))
    return out


def fix_index(mapping, dropped):
    """维护 data/images/_index.json。
    mapping: {旧rel: 新rel}  —— 转码成功的，把索引项改指到新 webp
    dropped: set(rel)       —— 搬走的（未引用/老的），删掉索引项
    返回 (是否改动, 说明)"""
    p = os.path.join(ROOT, 'data', 'images', '_index.json')
    if not os.path.exists(p):
        return False, '没有 _index.json，跳过'
    try:
        with io.open(p, encoding='utf-8') as f:
            ix = json.load(f)
    except Exception as e:
        return False, '读不出来：%s' % e
    if not isinstance(ix, dict):
        return False, '结构不认识，跳过'
    files = ix.get('files') or {}
    changed = 0
    # ① 转码成功的：files 键搬家，bySrc/byHash 的值跟着改
    for old, new in mapping.items():
        if old in files:
            rec = files.pop(old)
            if isinstance(rec, dict):
                rec['ext'] = 'webp'
            files[new] = rec
            changed += 1
    # ② 搬走的：删掉索引项
    for rel in dropped:
        if rel in files:
            files.pop(rel, None)
            changed += 1
    if not changed:
        return False, '索引里没有相关条目'
    gone = set(mapping.keys()) | set(dropped)
    newset = set(mapping.values())
    for key in ('bySrc', 'byHash'):
        m = ix.get(key)
        if not isinstance(m, dict):
            continue
        for k, v in list(m.items()):
            if v in mapping:
                m[k] = mapping[v]
            elif v in gone and v not in newset:
                del m[k]
    ix['files'] = files
    with io.open(p, 'w', encoding='utf-8') as f:
        json.dump(ix, f, ensure_ascii=False)
    return True, '改了 %d 处' % changed


def to_webp(abs_src, abs_dst):
    """转 WebP（不缩放，quality 92）。带透明的 PNG 保留 alpha。"""
    try:
        im = Image.open(abs_src)
        im.load()
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
        else:
            im = im.convert('RGB')
        os.makedirs(os.path.dirname(abs_dst), exist_ok=True)
        im.save(abs_dst, 'WEBP', quality=WEBP_QUALITY, method=6)
        return True, None
    except Exception as e:
        return False, str(e)


def main():
    apply = '--apply' in sys.argv
    stamp = time.strftime('%Y%m%d')
    backup_dir = os.path.join(ROOT, 'data', '_replaced_images_' + stamp)

    # ---- 1. 找出所有「记录指向 data/images 下的非 webp 图」 ----
    plan = {}          # old_rel -> {'referrers': [(file, ri, fld, ii)], 'ext': ...}
    all_refs = {}
    for p in record_files():
        for (ri, fld, ii, u, d, r, it, rows) in walk_refs(p):
            all_refs.setdefault(p, []).append((ri, fld, ii, u))
            if not u.startswith('data/images/'):
                continue
            if u.lower().endswith('.webp'):
                continue
            if os.path.splitext(u)[1].lower() not in IMG_EXT:
                continue
            plan.setdefault(u, {'referrers': [], 'ext': os.path.splitext(u)[1].lower()})
            plan[u]['referrers'].append((p, ri, fld, ii))

    log('=' * 70)
    log('模式：%s' % ('【真做】会改动文件' if apply else '【干跑】只报告'))
    log('=' * 70)
    if not plan:
        log('没有需要整理的图片：记录里的展示图已经全是 WebP。')
        return 0

    referenced = set(plan.keys())
    orphans = [x for x in non_webp_in_images() if x not in referenced]

    log('发现 %d 张被记录引用的非 WebP 展示图：\n' % len(plan))
    todo = []
    for old_rel, info in sorted(plan.items()):
        abs_old = os.path.join(ROOT, *old_rel.split('/'))
        rel_tail = old_rel[len('data/images/'):]
        stem, ext = os.path.splitext(rel_tail)
        webp_rel = 'data/images/' + stem + '.webp'
        orig_rel = 'data/orig/' + stem + ext
        abs_webp = os.path.join(ROOT, *webp_rel.split('/'))
        abs_orig = os.path.join(ROOT, *orig_rel.split('/'))
        state = []
        if not os.path.exists(abs_old):
            state.append('✗ 源文件不存在')
        if os.path.exists(abs_webp):
            state.append('webp已存在')
        if os.path.exists(abs_orig):
            state.append('orig已存在')
        n_ref = len(info['referrers'])
        log('  %-68s 被引用 %d 处 %s' % (old_rel, n_ref, ('｜' + '、'.join(state)) if state else ''))
        todo.append((old_rel, abs_old, webp_rel, abs_webp, orig_rel, abs_orig))

    if orphans:
        log('\n另有 %d 张「没被任何记录引用」的非 WebP 老图（例如被换掉的前一版封面）：' % len(orphans))
        for o in sorted(orphans):
            log('  %s' % o)
        log('  → 这些不转码，直接搬进同一个备份目录，并删掉去重索引里的对应项。')

    if not apply:
        log('\n（干跑）确认无误后执行：python tools/normalize_legacy_images.py --apply')
        return 0

    # ---- 2. 先备份所有会被改写的 JSON（含图片去重索引） ----
    touched = sorted(set(p for old_rel in plan for (p, *_rest) in plan[old_rel]['referrers']))
    idx_path = os.path.join(ROOT, 'data', 'images', '_index.json')
    if os.path.exists(idx_path):
        touched_idx = touched + [idx_path]
    else:
        touched_idx = touched
    for p in touched_idx:
        shutil.copy2(p, p + '.bak-v119')
    log('\n已备份 %d 个数据文件（后缀 .bak-v119）' % len(touched_idx))

    # ---- 3. 搬旧文件 + 转 webp + 补 orig ----
    os.makedirs(backup_dir, exist_ok=True)
    ok = fail = 0
    new_url = {}
    dropped = set()
    for (old_rel, abs_old, webp_rel, abs_webp, orig_rel, abs_orig) in todo:
        if not os.path.exists(abs_old):
            fail += 1
            continue
        # ① orig：原始字节直接复制（无损存档）
        if not os.path.exists(abs_orig):
            os.makedirs(os.path.dirname(abs_orig), exist_ok=True)
            shutil.copy2(abs_old, abs_orig)
        # ② webp：转码
        if not os.path.exists(abs_webp):
            good, err = to_webp(abs_old, abs_webp)
            if not good:
                log('  ✗ 转 WebP 失败 %s：%s' % (old_rel, err))
                fail += 1
                continue
        # ③ 旧文件搬走（只搬不删）
        dst = os.path.join(backup_dir, *old_rel[len('data/'):].split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(abs_old, dst)
        new_url[old_rel] = webp_rel
        ok += 1
        log('  ✓ %s → %s' % (old_rel.split('/')[-1], webp_rel.split('/')[-1]))

    # 未引用的老图：不转码，直接搬走
    moved_orphan = 0
    for rel in orphans:
        abs_old = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(abs_old):
            continue
        dst = os.path.join(backup_dir, *rel[len('data/'):].split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(abs_old, dst)
        dropped.add(rel)
        moved_orphan += 1
        log('  → 搬走未引用的老图 %s' % rel.split('/')[-1])

    log('\n转换完成：成功 %d，失败 %d；另搬走未引用老图 %d 张' % (ok, fail, moved_orphan))
    log('旧文件已搬到：%s（只搬不删，确认没问题后可自行删除）'
        % os.path.relpath(backup_dir, ROOT).replace(os.sep, '/'))

    # ---- 3.5 同步维护图片去重索引 ----
    idx_changed, idx_msg = fix_index(new_url, dropped)
    log('去重索引 _index.json：%s' % ('已更新（%s）' % idx_msg if idx_changed else ('未改动（%s）' % idx_msg)))

    # ---- 4. 改写记录里的 imageUrl ----
    changed = 0
    for p in touched:
        with io.open(p, encoding='utf-8') as f:
            txt = f.read()
        raw = json.loads(txt)
        rows = raw.get('rows') if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            continue
        file_changed = 0
        for r in rows:
            if not isinstance(r, dict):
                continue
            for fld in IMG_FIELDS:
                v = r.get(fld)
                if isinstance(v, list):
                    for it in v:
                        if isinstance(it, dict) and it.get('imageUrl') in new_url:
                            it['imageUrl'] = new_url[it['imageUrl']]
                            file_changed += 1
                elif isinstance(v, str) and v in new_url:
                    r[fld] = new_url[v]
                    file_changed += 1
        if file_changed:
            with io.open(p, 'w', encoding='utf-8') as f:
                json.dump(raw, f, ensure_ascii=False, indent=2)
            changed += file_changed
            log('  ✓ %s：改写 %d 处引用' % (os.path.relpath(p, ROOT).replace(os.sep, '/'), file_changed))

    log('\n共改写 %d 处引用。' % changed)

    # ---- 5. 收尾自检 ----
    log('\n' + '=' * 70)
    log('自检：')
    left = non_webp_in_images()
    log('  data/images 里剩余非 WebP 图片：%d %s' % (len(left), ('（应为 0）' if not left else '← 还有：' + str(left[:5]))))
    n_orig = sum(len(fs) for _dp, _dn, fs in os.walk(os.path.join(ROOT, 'data', 'orig')))
    n_img = sum(len(fs) for _dp, _dn, fs in os.walk(os.path.join(ROOT, 'data', 'images')))
    n_thm = sum(len(fs) for _dp, _dn, fs in os.walk(os.path.join(ROOT, 'data', 'thumbs')))
    log('  文件数：orig=%d　images=%d（含 _index.json）　thumbs=%d' % (n_orig, n_img, n_thm))
    # 记录里是否还有指向不存在文件的图
    broken = []
    for p in record_files():
        for (ri, fld, ii, u, d, r, it, rows) in walk_refs(p):
            if u.startswith('data/') and not os.path.exists(os.path.join(ROOT, *u.split('/'))):
                broken.append((os.path.basename(p), u))
    if broken:
        log('  ⚠️ 有 %d 处引用指向不存在的文件（可能是原本就缺的）：' % len(broken))
        for b in broken[:8]:
            log('      %s → %s' % b)
    else:
        log('  ✓ 记录里的图片引用全部能落到真实文件。')
    log('=' * 70)
    log('完成。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
