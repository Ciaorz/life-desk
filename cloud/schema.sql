-- ============================================================
-- 日常集 · 云同步 D1 表结构
-- ------------------------------------------------------------
-- 在 Cloudflare 控制台 → D1 → 你的库 → Console 里整段粘贴执行；
-- 或者用命令行：  npx wrangler d1 execute life-desk --remote --file=cloud/schema.sql
-- ============================================================

-- 一条记录一行，业务字段全放在 data 这个 JSON 里。
-- 为什么不拆成业务列：App 有自定义字段系统（fieldLayout / customFields / 用户自建大类），
-- 拆成关系型列以后每加一个字段都要改表结构，会把项目绑死。
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,            -- 直接复用 App 里的 _id
  module     TEXT NOT NULL,               -- collection / av / travel / study / food / idea / recipe ...
  cat        TEXT,                        -- 分片名，如 冰箱贴 / 徽章；未分片为 NULL
  data       TEXT NOT NULL,               -- 整条记录的 JSON
  rev        INTEGER NOT NULL DEFAULT 1,  -- 每次改动 +1，用于乐观锁与排查
  updated_at INTEGER NOT NULL,            -- 毫秒时间戳，增量同步全靠它
  deleted    INTEGER NOT NULL DEFAULT 0,  -- 软删除：别的设备要知道「这条没了」
  device     TEXT                         -- 最后改它的设备，如 desktop / iphone
);

-- 增量拉取的主查询：WHERE updated_at > ?
CREATE INDEX IF NOT EXISTS idx_records_sync   ON records(updated_at);
-- 按模块/分类筛选用
CREATE INDEX IF NOT EXISTS idx_records_module ON records(module, cat);
-- 只统计未删除的
CREATE INDEX IF NOT EXISTS idx_records_live   ON records(deleted, module);

-- 配置类数据（字段布局、自定义字段、存储地点选项、用户自建大类…）
CREATE TABLE IF NOT EXISTS meta (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,               -- JSON 字符串
  updated_at INTEGER NOT NULL
);

-- 可选：图片变更日志。如果你想让桌面端知道「云端有哪些图还没拉下来」，
-- 桌面端上传时往这里写一条，手机端按 updated_at 增量拉清单。
CREATE TABLE IF NOT EXISTS images (
  key        TEXT PRIMARY KEY,            -- 如 thumbs/series/冰箱贴-封面-01/0001-xxx.webp
  size       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_sync ON images(updated_at);
