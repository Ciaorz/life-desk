#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
push_to_github.py —— 把本机改动一次性推到 GitHub（含清理线上旧文件）

为什么需要：
  网页拖拽上传有两个硬限制：① 单次最多 100 个文件；② 只能加，不能删。
  本机这次有 107 个文件要传、另有 1448 个旧文件要删，手工做非常痛苦。
  本脚本用 GitHub 的 Git Data API，把「新增 + 修改 + 删除」合成**一个提交**。

它做什么：
  1. 读出线上 main 分支当前的 commit / tree
  2. 逐文件比对 blob SHA，算出「新增 / 改动 / 线上多余」
  3. 把所有要改的文件打成 blob，生成一棵新 tree
     （--delete-orphans 时，把线上多余的文件以 sha=null 写进 tree，等于删除）
  4. 建一个 commit，把 main 指向它

用法（在项目根目录执行）：
    python tools/push_to_github.py                      # 干跑：只报告，不推送
    python tools/push_to_github.py --apply              # 只推文件，不删线上旧文件
    python tools/push_to_github.py --apply --delete-orphans   # 推文件 + 清理旧文件

令牌从 E:\\自制软件\\token.txt 读取（该文件已在 .gitignore 里，不会进仓库）。
"""

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = r'E:\自制软件\token.txt'
OWNER = 'ciaorz'
REPO = 'life-desk'
BRANCH = 'main'
API = 'https://api.github.com'

# 与 .gitignore 对齐
SKIP_DIRS = {'data/orig', 'images/_orig', '.workbuddy', '.workbuddy-ai',
             'data/_bak_optimize_20260918'}
SKIP_PREFIX = ('data/_bak_', 'data/_legacy_')
SKIP_FILES = {'debug.log', 'yun_probe.js', 'serve.js', 'data/lifedesk.backup.json',
              '推送清单.md', '云同步部署手册.md',
              # R2 上传台账：本机续传用的缓存（key→size），不是源码。
              # 换了机器/删了它，最多是重传一遍封面，内容完全一样。
              'tools/.r2_uploaded.json'}
SKIP_RE = [re.compile(r'\.bak'), re.compile(r'^_.*\.(js|mjs|cjs|html)$'), re.compile(r'\.log$')]

# 白名单：这些路径永不忽略（命中即跳过所有上面的排除规则）。
# cloud/pages-upload 里的 _worker.js 是 Cloudflare 规定的固定文件名，
# 会被 SKIP_RE 的 ^_.*\.(js|mjs|cjs|html)$ 误伤 —— 必须放行，否则线上部署会缺文件。
KEEP_PREFIX = ('cloud/pages-upload',)

DRY = True
DELETE_ORPHANS = False


def read_token():
    if not os.path.exists(TOKEN_FILE):
        print('!! 找不到令牌文件：%s' % TOKEN_FILE)
        sys.exit(1)
    t = open(TOKEN_FILE, 'r', encoding='utf-8', newline='').read().strip()
    if not t:
        print('!! 令牌文件是空的')
        sys.exit(1)
    return t


def api(method, path, token, body=None, ok=(200, 201), tries=5):
    """调 GitHub API。

    国内直连 api.github.com 偶尔会抽风（连接被重置 / 超时），
    而一次推送要发上百个请求，中途断一次整批就白做。
    所以这里对「网络层失败」和 5xx / 429 自动重试，指数退避。
    4xx（除了 429）是请求本身的问题，不重试，直接返回让上层报错。
    """
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    last = None
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', 'Bearer ' + token)
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('X-GitHub-Api-Version', '2022-11-28')
        req.add_header('User-Agent', 'life-desk-push')
        if data:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                j = json.loads(raw)
            except Exception:
                j = {'raw': raw[:400].decode('utf-8', 'replace')}
            if e.code in (429, 500, 502, 503, 504) and attempt < tries:
                last = (e.code, j)
                wait = min(2 ** attempt, 30)
                print('   … %s，%d 秒后重试（第 %d/%d 次）' % (e.code, wait, attempt, tries))
                time.sleep(wait)
                continue
            return e.code, j
        except Exception as e:                      # URLError / socket / timeout
            last = (0, {'error': str(e)})
            if attempt < tries:
                wait = min(2 ** attempt, 30)
                print('   … 网络异常（%s），%d 秒后重试（第 %d/%d 次）'
                      % (type(e).__name__, wait, attempt, tries))
                time.sleep(wait)
                continue
            return last
    return last or (0, {'error': 'unknown'})


def blob_sha(data):
    h = hashlib.sha1()
    h.update(b'blob ' + str(len(data)).encode() + b'\0')
    h.update(data)
    return h.hexdigest()


def ignored(rel):
    rel = rel.replace('\\', '/')

    # ---- 白名单：先于所有排除规则，命中就直接「不忽略」 ----
    # 背景：SKIP_RE 里那条 ^_.*\.(js|html)$ 是为了过滤本机的临时文件，
    # 但它会误伤 Cloudflare 规定的 _worker.js —— 那个文件名不能改，
    # 而且它是 Pages 部署的核心产物，必须进仓库。
    for k in KEEP_PREFIX:
        if rel == k or rel.startswith(k + '/'):
            return False

    if rel in SKIP_FILES:
        return True
    for d in SKIP_DIRS:
        if rel == d or rel.startswith(d + '/'):
            return True
    for p in SKIP_PREFIX:
        if rel.startswith(p):
            return True
    for r in SKIP_RE:
        if r.search(os.path.basename(rel)):
            return True
    return False


def local_files():
    out = {}
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [x for x in dns
                  if not ignored(os.path.relpath(os.path.join(dp, x), ROOT))]
        for fn in fns:
            ap = os.path.join(dp, fn)
            rel = os.path.relpath(ap, ROOT).replace('\\', '/')
            if ignored(rel):
                continue
            try:
                with open(ap, 'rb') as f:
                    out[rel] = f.read()
            except OSError:
                pass
    return out


def main():
    global DRY, DELETE_ORPHANS
    if '--apply' in sys.argv:
        DRY = False
    if '--delete-orphans' in sys.argv:
        DELETE_ORPHANS = True

    token = read_token()
    print('=' * 66)
    print('仓库 : %s/%s  分支 %s' % (OWNER, REPO, BRANCH))
    print('模式 : %s' % ('【干跑】只报告' if DRY else '【写入】会真的推送'))
    print('清理 : %s' % ('会删除线上多余文件' if DELETE_ORPHANS else '不动线上多余文件'))
    print('=' * 66)

    # 1) 线上当前状态
    st, ref = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH), token)
    if st != 200:
        print('!! 读分支失败 (%s): %s' % (st, ref))
        return 1
    head_sha = ref['object']['sha']
    st, commit = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, head_sha), token)
    if st != 200:
        print('!! 读 commit 失败 (%s): %s' % (st, commit))
        return 1
    base_tree = commit['tree']['sha']
    print('线上 HEAD : %s' % head_sha[:12])

    st, tree = api('GET', '/repos/%s/%s/git/trees/%s?recursive=1' % (OWNER, REPO, base_tree), token)
    if st != 200:
        print('!! 读 tree 失败 (%s): %s' % (st, tree))
        return 1
    remote = {x['path']: x for x in tree['tree'] if x['type'] == 'blob'}
    print('线上文件 : %d 个' % len(remote))

    # 2) 算差异
    loc = local_files()
    print('本机文件 : %d 个（已排除 .gitignore 项）' % len(loc))
    print()

    todo = []
    for rel, data in sorted(loc.items()):
        sha = blob_sha(data)
        r = remote.get(rel)
        if r is None:
            todo.append((rel, data, sha, '新增'))
        elif r['sha'] != sha:
            todo.append((rel, data, sha, '改动'))
    orphans = sorted(k for k in remote if k not in loc)

    nb = sum(len(d) for _, d, _, _ in todo)
    ob = sum(remote[k].get('size', 0) for k in orphans)
    print('要上传 : %d 个 / %.2f MB' % (len(todo), nb / 1048576))
    for rel, _, _, why in todo[:12]:
        print('   %-6s %s' % (why, rel))
    if len(todo) > 12:
        print('   …还有 %d 个' % (len(todo) - 12))
    print()
    print('线上多余 : %d 个 / %.1f MB' % (len(orphans), ob / 1048576))
    if orphans:
        print('   例: %s' % orphans[0])
    print()

    if DRY:
        print('干跑结束。确认无误后：')
        print('    python tools/push_to_github.py --apply                    # 只推文件')
        print('    python tools/push_to_github.py --apply --delete-orphans   # 推文件并清理')
        return 0

    if not todo and not (DELETE_ORPHANS and orphans):
        print('没有需要提交的改动。')
        return 0

    # 3) 建 blob
    print('正在上传 %d 个文件…' % len(todo))
    entries = []
    for i, (rel, data, sha, why) in enumerate(todo, 1):
        st, res = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO), token,
                      {'content': base64.b64encode(data).decode('ascii'),
                       'encoding': 'base64'})
        if st not in (200, 201):
            print('!! blob 失败 (%s) %s : %s' % (st, rel, res))
            return 1
        entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': res['sha']})
        if i % 20 == 0 or i == len(todo):
            print('   %d/%d' % (i, len(todo)))

    if DELETE_ORPHANS:
        for rel in orphans:
            entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': None})
        print('已标记删除 %d 个线上旧文件' % len(orphans))

    # 4) 建 tree
    st, newtree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO), token,
                      {'base_tree': base_tree, 'tree': entries})
    if st not in (200, 201):
        print('!! 建 tree 失败 (%s): %s' % (st, newtree))
        return 1

    # 5) 建 commit
    msg = '同步本机数据：新增/更新 %d 个文件' % len(todo)
    if DELETE_ORPHANS and orphans:
        msg += '，清理 %d 个旧文件' % len(orphans)
    st, newcommit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO), token,
                        {'message': msg, 'tree': newtree['sha'], 'parents': [head_sha]})
    if st not in (200, 201):
        print('!! 建 commit 失败 (%s): %s' % (st, newcommit))
        return 1

    # 6) 移动分支
    st, res = api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH), token,
                  {'sha': newcommit['sha']})
    if st != 200:
        print('!! 更新分支失败 (%s): %s' % (st, res))
        return 1

    print()
    print('=' * 66)
    print('推送完成 ✅')
    print('  commit : %s' % newcommit['sha'][:12])
    print('  提交   : %s' % msg)
    print('  文件   : 上传 %d 个' % len(todo))
    if DELETE_ORPHANS:
        print('  删除   : %d 个' % len(orphans))
    print('  GitHub Pages 大约 1 分钟后生效')
    print('=' * 66)
    return 0


if __name__ == '__main__':
    sys.exit(main())
