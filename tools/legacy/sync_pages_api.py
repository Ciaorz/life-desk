#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sync_pages_api.py —— 由 cloud/sync-worker.js 生成 Pages Functions 版本

背景：`*.workers.dev` 在中国大陆被 DNS 污染（解析成 Facebook/Twitter 的 IP），
      连不上；`*.pages.dev` 解析正常。所以同一套 API 需要同时存在两个入口：

      cloud/sync-worker.js                     → Worker 版（给能访问 workers.dev 的网络用）
      cloud/pages-api/functions/api/[[path]].js → Pages Functions 版（国内可直连）

两边的业务逻辑必须一模一样，所以以 sync-worker.js 为**唯一源**，
本脚本负责把它转换成 Pages 版本。改完 Worker 后跑一次本脚本即可。

用法：
    python tools/sync_pages_api.py            # 干跑，只报告差异
    python tools/sync_pages_api.py --apply    # 写入
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'cloud', 'sync-worker.js')
DST = os.path.join(ROOT, 'cloud', 'pages-api', 'functions', 'api', '[[path]].js')

OLD_ENTRY = 'export default {\n  async fetch(request, env) {'
NEW_ENTRY = 'async function handleRequest(request, env) {'

OLD_TAIL = """    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};"""

NEW_TAIL = """    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
}"""

HEADER = """/* ============================================================
 * [[path]].js —— Cloudflare **Pages Functions** 版云同步后端
 * ------------------------------------------------------------
 * 本文件由 tools/sync_pages_api.py 从 cloud/sync-worker.js 自动生成，
 * **不要手改**；要改逻辑请改 sync-worker.js 再重新生成。
 *
 * 为什么要有这个版本（重要）：
 *   `*.workers.dev` 这个域名在中国大陆被 DNS 污染，解析出来的是
 *   Facebook / Twitter 的 IP（形如 2a03:2880:...:face:b00c:...），
 *   根本连不上。而 `*.pages.dev` 解析正常（104.18.x.x，真实 Cloudflare 边缘），
 *   可以直连。所以把同一套 API 放到 Pages Functions 上跑。
 *
 *   两者跑的是同一个 Workers 运行时，D1 / R2 也**共用同一个库和桶**，
 *   所以切过来以后原来的数据一点都不会丢，只是换了个入口域名。
 *
 * 部署（全程网页，不用命令行）：
 *   1. Cloudflare 控制台 → Workers & Pages → Create → Pages →
 *      Upload assets（直接上传，不接 Git）
 *   2. 项目名填 life-desk-api → 上传 cloud/pages-api 这个目录
 *   3. 项目 → Settings → Functions → D1 database bindings
 *        变量名 DB  → 选 life-desk
 *      Settings → Functions → R2 bucket bindings
 *        变量名 IMG → 选 life-desk-images
 *      Settings → Environment variables → 加 Secret
 *        SYNC_TOKEN → 填你的令牌
 *   4. 访问 https://life-desk-api.pages.dev/api/ping 应返回 {"ok":true,...}
 * ============================================================ */

"""

FOOTER = """

/* ---------- Pages Functions 入口 ----------
   Pages 会把 /api/xxx 路由到这个 catch-all 文件，
   request.url 里带着完整路径，所以上面那套路由判断可以原样复用。 */
export const onRequest = async (context) => {
  return handleRequest(context.request, context.env);
};
"""


def build():
    src = open(SRC, encoding='utf-8', newline='').read()
    if OLD_ENTRY not in src:
        raise SystemExit('!! 在 sync-worker.js 里找不到 Worker 入口，源码结构可能变了：\n   %r' % OLD_ENTRY)
    if OLD_TAIL not in src:
        raise SystemExit('!! 在 sync-worker.js 里找不到 Worker 结尾，源码结构可能变了。')
    out = src.replace(OLD_ENTRY, NEW_ENTRY, 1)
    out = out.replace(OLD_TAIL, NEW_TAIL, 1)
    return HEADER + out + FOOTER


def main():
    apply = '--apply' in sys.argv
    new = build()
    old = ''
    if os.path.exists(DST):
        old = open(DST, encoding='utf-8', newline='').read()

    if old == new:
        print('已是最新，无需改动。')
        return 0

    print('源   : %s (%d 字节)' % (os.path.relpath(SRC, ROOT), os.path.getsize(SRC)))
    print('目标 : %s' % os.path.relpath(DST, ROOT))
    print('变化 : %d 字节 → %d 字节' % (len(old.encode('utf-8')), len(new.encode('utf-8'))))

    if not apply:
        print()
        print('这是干跑。加 --apply 写入。')
        return 0

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, 'w', encoding='utf-8', newline='') as f:
        f.write(new)
    print()
    print('已写入 %s' % os.path.relpath(DST, ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
