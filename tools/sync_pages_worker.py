#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_pages_worker.py —— 从 cloud/sync-worker.js 生成 Pages 版的 _worker.js
========================================================================

背景（这段很重要，别删）
------------------------------------------------------------------------
Cloudflare Pages 有两种「带后端」的写法：

  A) functions/api/[[path]].js   —— 文件路由写法，看起来更规整
  B) _worker.js                  —— 「高级模式」，一个文件接管全部请求

**关键区别在于能不能用网页拖拽部署：**

  官方文档（pages/get-started/direct-upload → Functions 一节）明确写了：

    "Drag and drop deployments made from the Cloudflare dashboard do not
     currently support compiling a `functions` folder of Pages Functions.
     To deploy a `functions` folder, you must use Wrangler."
    "However, note that a `_worker.js` file is supported by both Wrangler
     and drag and drop deployments made from the dashboard."

  翻译：控制台拖拽 **不支持** functions 目录，但 **_worker.js 支持**。
  用户全程只用网页拖拽（命令行是入门阶段），所以必须走 B。

也就是说：**别把 _worker.js 改回 functions/ 目录写法**，那样用户就传不上去了。

这个脚本做什么
------------------------------------------------------------------------
把 sync-worker.js 做两处「外科手术式」替换，生成自包含的单文件 _worker.js：

  1. 把 `export default { async fetch(request, env) {` 换成
     `async function handleApi(request, env) {`
     （即：原来的 Worker 入口降级成一个普通函数）

  2. 把结尾的 `  },` + `};` 换成 `}` + 一个新的 Pages 入口
     （新入口负责：/api/* 走 handleApi，其余交给静态资源）

**为什么不直接手写 _worker.js？** 因为 API 逻辑有 300 行，两份拷贝一定会漂移。
这里以 sync-worker.js 为唯一真源，Pages 版每次重新生成。

用法
------------------------------------------------------------------------
    python tools/sync_pages_worker.py            # 干跑：只报告，不写文件
    python tools/sync_pages_worker.py --apply    # 真正生成
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SRC = os.path.join(ROOT, 'cloud', 'sync-worker.js')
OUT = os.path.join(ROOT, 'cloud', 'pages-upload', '_worker.js')

# ---- 手术锚点 1：把 Worker 入口降级成普通函数 ----
HEAD_OLD = (
    "export default {\n"
    "  async fetch(request, env) {\n"
    "    const url = new URL(request.url);\n"
    "    const p = url.pathname;"
)
HEAD_NEW = (
    "async function handleApi(request, env) {\n"
    "  const url = new URL(request.url);\n"
    "  const p = url.pathname;"
)

# ---- 手术锚点 2：原来的 export 收尾，换成函数收尾 + 新的 Pages 入口 ----
TAIL_OLD = "  },\n};\n"

ENTRY = '''
/* ============================================================
 * Pages 入口（_worker.js 高级模式）
 * ------------------------------------------------------------
 * 在高级模式下，_worker.js 会「接管全部请求」，所以必须自己把
 * 非 API 的请求转发给静态资源 —— 不转发的话站点会 404。
 * 这是 Cloudflare 官方文档强调的一点。
 *
 *   /api/*   → handleApi（上面那坨，就是从 sync-worker.js 搬过来的）
 *   其它路径 → env.ASSETS（同目录的 index.html 自检页）
 *
 * 注意：这里的代码刻意不用模板字符串（反引号），
 *       因为本文件由 python 脚本生成，反引号在某些 shell 里会被吃掉。
 * ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      // 极端情况下没有 ASSETS 绑定（比如项目里一个静态文件都没有），
      // 也别返回 500，给一句人话方便排查。
      return new Response('life-desk-sync API is running. Try /api/ping', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return handleApi(request, env, ctx);
  },
};
'''

BANNER = '''/* ============================================================
 * _worker.js —— 日常集 · 云同步 API（Cloudflare Pages · 高级模式）
 * ------------------------------------------------------------
 * ⚠️ 自动生成的文件，**不要手改**。
 *    真源是 cloud/sync-worker.js，改完那边之后跑：
 *
 *        python tools/sync_pages_worker.py --apply
 *
 * 为什么用 _worker.js 而不是 functions/ 目录？
 *    Cloudflare 官方文档写明：控制台「拖拽上传」不支持编译 functions
 *    目录，但 _worker.js 拖拽和 wrangler 都支持。本项目全程只用网页
 *    拖拽部署，所以必须用 _worker.js。
 *    见 developers.cloudflare.com/pages/get-started/direct-upload/ 的 Functions 一节
 *
 * 部署方法：把 cloud/pages-upload 这个文件夹整个拖进 Cloudflare Pages
 *           （部署步骤见根目录《云同步部署手册.md》第九节）
 * ============================================================ */

'''


def dedent2(text):
    """把整段代码左边缩进减 2 格。

    原来这些代码嵌在 `export default { fetch() { ... } }` 里，
    所以整体缩进 4 格；现在它们直接是顶层函数的函数体，改成 2 格更自然。
    """
    out = []
    for ln in text.split('\n'):
        out.append(ln[2:] if ln.startswith('  ') else ln)
    return '\n'.join(out)


def generate(src):
    """返回 (生成结果, 错误信息或 None)。"""
    if src.count(HEAD_OLD) != 1:
        return None, (
            '在 sync-worker.js 里找不到唯一的 Worker 入口（找到 %d 处）。\n'
            '期望的开头是：\n%s\n'
            '如果你重构过 sync-worker.js，请同步更新本脚本的 HEAD_OLD。'
            % (src.count(HEAD_OLD), HEAD_OLD)
        )
    if src.count(TAIL_OLD) != 1:
        return None, (
            '在 sync-worker.js 里找不到唯一的 export 收尾（找到 %d 处）。\n'
            '期望的收尾是 %r。' % (src.count(TAIL_OLD), TAIL_OLD)
        )

    i = src.index(HEAD_OLD)
    j = src.index(TAIL_OLD, i)

    head = src[:i] + HEAD_NEW
    mid = dedent2(src[i + len(HEAD_OLD):j])
    tail = src[j + len(TAIL_OLD):]

    out = BANNER + head + mid + '}\n' + ENTRY + tail
    return out, None


def main():
    apply = '--apply' in sys.argv[1:]

    if not os.path.exists(SRC):
        print('!! 找不到源文件：%s' % SRC)
        return 1

    with open(SRC, 'r', encoding='utf-8') as f:
        src = f.read()

    out, err = generate(src)
    if err:
        print('!! ' + err)
        return 1

    print('源文件 : %s  (%d 字节)' % (os.path.relpath(SRC, ROOT), len(src.encode('utf-8'))))
    print('目标   : %s  (%d 字节)' % (os.path.relpath(OUT, ROOT), len(out.encode('utf-8'))))

    # 粗校验：花括号必须配平，否则生成出来的东西一定是坏的
    if out.count('{') != out.count('}'):
        print('!! 花括号不配平：{ %d 个，} %d 个 —— 生成结果有问题，已中止'
              % (out.count('{'), out.count('}')))
        return 1
    print('校验   : 花括号配平 %d 对 ✅' % out.count('{'))

    if not apply:
        print('\n【干跑】没有写任何文件。确认无误后加 --apply 真正生成。')
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)
    print('\n已生成 ✅  %s' % os.path.relpath(OUT, ROOT))
    print('提醒：cloud/pages-upload/ 这个文件夹就是要拖进 Cloudflare 的东西。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
