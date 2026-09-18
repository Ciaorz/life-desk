# tools/legacy —— 归档，别用

这里的东西**不是当前方案**，只是留个底，免得以后想知道「当时为什么那样写」。

| 文件 | 什么时候的 | 为什么不用了 |
|---|---|---|
| `pages-api-functions/functions/api/[[path]].js` | 2026-09-18 上午 | Cloudflare Pages 的 **functions 目录**写法。看着更规整，但**控制台拖拽上传不支持编译 functions 目录**，必须装 wrangler 用命令行传。用户全程只用网页拖拽，所以改用 `_worker.js`（高级模式）。新方案见 `cloud/pages-upload/`。 |
| `sync_pages_api.py` | 同上 | 上面那个文件的生成器。已被 `tools/sync_pages_worker.py` 取代（那个生成 `_worker.js`）。 |
| `_migrate_ip_series.cjs` | 2026-09-08 前后 | IP / 系列实体文件的一次性迁移脚本，迁移已完成。 |
| `git_upload.sh` | 更早 | 用 `git push` 推 GitHub 的老办法。现在用 `tools/push_to_github.py`（Git Data API，能把新增+改动+删除合成一个提交）。 |

> 如果哪天真的改用 wrangler 命令行部署，`pages-api-functions/` 那套是可以捡回来用的 ——
> 它的好处是文件路由更清晰，坏处是必须用命令行。
