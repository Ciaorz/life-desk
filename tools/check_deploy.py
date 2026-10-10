# -*- coding: utf-8 -*-
"""
核对「线上 GitHub Pages」和「本地」是否一致 —— 防止再出现"只推了一部分文件"。

背景（2026-09-30 踩的坑）：
  上一次部署只推了 app.js + sw.js，漏了 style.css。
  结果手机端 app.js 是新的（会生成精灵球图标）、style.css 是旧的（没有 .pkq-ball 规则），
  <img> 没有约束就按原图 128px 渲染 → 精灵球撑满整张展示卡。

用法：
  python tools/check_deploy.py             # 只报告
  python tools/check_deploy.py -v          # 顺便列出每份文件的行数/大小

退出码：0 = 全部一致；1 = 有漂移（该重推了）。
"""
import hashlib
import io
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://ciaorz.github.io/life-desk'
# 需要保持同步的文件（网页架构这几个；数据/图片走 Cloudflare，不在核对范围）
FILES = ['index.html', 'style.css', 'app.js', 'sw.js']
UA = 'life-desk-deploy-check/1.0'


def sha(data):
    return hashlib.sha256(data).hexdigest()[:12]


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def local_version(text):
    m = re.search(r"const\s+CACHE\s*=\s*'([^']+)'", text)
    return m.group(1) if m else '(读不到)'


def main():
    verbose = '-v' in sys.argv
    print('=' * 72)
    print('线上 = %s' % BASE)
    print('=' * 72)
    drift, missing = [], []
    for name in FILES:
        lp = os.path.join(ROOT, name)
        if not os.path.isfile(lp):
            print('  %-12s ✗ 本地不存在' % name)
            missing.append(name)
            continue
        lb = io.open(lp, 'rb').read()
        try:
            rb = fetch(BASE + '/' + name)
        except Exception as e:
            print('  %-12s ? 线上取不到：%s' % (name, e))
            drift.append(name)
            continue
        same = sha(lb) == sha(rb)
        mark = '✓ 一致' if same else '✗ **不一致（要重推）**'
        line = '  %-12s %s   本地 %s / 线上 %s' % (name, mark, sha(lb), sha(rb))
        print(line)
        if verbose:
            print('               本地 %d 字节 · 线上 %d 字节' % (len(lb), len(rb)))
        if not same:
            drift.append(name)

    # SW 版本号：本地必须比线上新（忘了 bump 等于手机端永远装不到新版）
    ls = os.path.join(ROOT, 'sw.js')
    if os.path.isfile(ls):
        local_ver = local_version(io.open(ls, encoding='utf-8').read())
        try:
            live_ver = local_version(fetch(BASE + '/sw.js').decode('utf-8', 'replace'))
        except Exception:
            live_ver = '(取不到)'
        print('\n  SW 版本：本地 %s  ｜  线上 %s' % (local_ver, live_ver))
        if local_ver == live_ver:
            print('  ⚠️ 两边版本号相同 —— 若这次改了 app.js/style.css，手机端**不会**装新版本，')
            print('     请先把 sw.js 的 CACHE 后面那串改一下（如 v129 → v130）再推。')
        elif drift and local_ver != live_ver:
            print('  ↑ 本地版本已推进，推上去即可让手机端装新版。')

    print()
    if drift or missing:
        print('结论：**有 %d 个文件需要重推** → %s' % (len(set(drift + missing)), ', '.join(sorted(set(drift + missing)))))
        print('（只推了其中一部分，就会出现「app.js 新的 / css 旧的」这种半新半旧状态，')
        print('  手机端表现往往很奇怪：功能在、样式没跟上，或反过来。）')
        return 1
    print('结论：线上与本地完全一致 ✓')
    return 0


if __name__ == '__main__':
    sys.exit(main())
