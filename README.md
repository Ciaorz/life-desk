# 日常集 · 生活工作台

一个纯前端的个人生活管理 PWA。收藏、旅行、影音、书房、美食、灵感六个场景，
数据全部存在**你自己的文件**里，不依赖任何后端服务器。

> 仓库：`Ciaorz/life-desk`　·　线上：GitHub Pages 静态托管

---

## 一、它是什么

| 模块 | 说明 |
| --- | --- |
| 总览 | 各模块数据汇总 |
| 藏品馆 | 手办 / 周边 / 杯盏 / 毛绒 / 卡牌 / 着物，透视展厅 |
| 旅行 | 想去 / 去过的地方，3D 地球上插旗、种草 |
| 影音厅 | 电影 / 留声机，歌剧院展厅 |
| 书房 | 书籍 / 杂志，书架 |
| 美食记录 | 美食地图 + 菜谱册 |
| 灵感捕捉 | 星空背景，记录想法 |

另有 4 张辅助表（不单独进导航，在藏品里管理）：`ip` / `series` / `loc` / `candidate`。

---

## 二、技术栈

- **纯前端，零构建、零依赖安装**：改完文件直接推，刷新即生效
- **three.js r149**：3D 地球（真实贴图 + 高程位移 + 国界 + 城市点）
- **File System Access API**：浏览器直接读写本机真实文件（Chrome / Edge 等 Chromium 内核）
- **Service Worker**：离线缓存（策略：HTML 网络优先，静态资源缓存优先）
- **PWA**：可安装到桌面 / 手机主屏

---

## 三、目录结构

```
life-desk/
├── index.html              页面骨架（含右下角工具、SW 注册）
├── app.js                  ★ 全部业务逻辑（约 4000 行，单文件）
├── style.css               全部样式（含小屏适配媒体查询）
├── sw.js                   Service Worker（改代码要升 CACHE 版本号）
├── manifest.webmanifest    PWA 配置
├── three.min.js            3D 库
│
├── earth_color_16k.js      地球彩色贴图（桌面，16K，base64 内嵌）
├── earth_color_8k.js       地球彩色贴图（移动端，8K）
├── earth_height_4k.js      高程图（用于地形起伏）
├── earth_16k.webp          贴图缺失时的回退文件
├── borders0.js / borders1.js / borders_cn_prov.js   国界、省界数据
├── cities.js               城市点数据
│
├── images/                 ★ 应用自身的图标与背景资源（不是用户数据）
│   ├── pin-visited.png        旅行标记：去过（小红旗）
│   ├── sprout-wish.png        旅行标记：想去（小草苗）
│   ├── museum-bg.png / opera-bg.png / study-bg.png / foodtwo.png / idea-sky.png
│   │                          各模块背景
│   ├── cat_*.png / figure-cover.png / film-cover.png / gramophone-cover.png
│   │                          各分类封面
│   └── icon-180/192/512.png   PWA 图标
│
├── data/                   ★ 用户数据目录（应用运行时选择的那个文件夹）
│   ├── lifedesk.json          主索引（类目清单 + 下一个封面编号）
│   ├── {类目}-data.json       每个类目一个数据文件
│   ├── images/                用户封面图片（images/{类目}-封面/{类目}-0001.jpg）
│   └── README.md              数据目录说明（自动生成）
│
├── .gitignore              已排除 token.txt 等敏感文件
└── README.md               本文件
```

> ⚠️ **`images/` 和 `data/images/` 不是一回事**：
> 前者是应用自带的界面资源，后者才是你录入的封面图片。

---

## 四、存储架构

### 4.1 四种模式（自动选择，优先级从高到低）

| 模式 | 触发条件 | 数据存哪里 |
| --- | --- | --- |
| `db` | 在 WorkBuddy 资料库里打开 | 私有资料库云端表 |
| `localfile` | 浏览器支持 FSA 且已选目录 | **本机真实文件**（推荐） |
| `gh` | 填了 GitHub 仓库配置 | GitHub 仓库 json |
| `local` | 以上都不满足 | 浏览器 localStorage（5MB 上限） |

**`localfile` 是主力模式**：右下角「📂 选择数据目录」挑一次文件夹，
句柄存进 IndexedDB，之后刷新自动重连，数据直接写盘。

### 4.2 数据分片格式（schema 2）

主索引 `data/lifedesk.json`：

```json
{
  "schema": 2,
  "shards": {
    "去过的地方": { "file": "去过的地方-data.json", "module": "travel", "coverDir": "去过的地方-封面" }
  },
  "__main": { "travel": [], "collection": [] },
  "imgSeq": 2
}
```

- `shards` — 类目 → 数据文件的映射
- `__main` — 还没建专属文件的记录（新类目在用户确认前暂存这里）
- `imgSeq` — 下一个封面编号，保证编号**全局唯一**

分片文件 `{类目}-data.json`：

```json
{ "schema": 2, "cat": "去过的地方", "module": "travel", "rows": [ ... ] }
```

### 4.3 类目怎么划分

| 模块 | 分片字段 | 例子 |
| --- | --- | --- |
| 旅行 | `状态` | 去过→「去过的地方」、想去→「想去的地方」 |
| 藏品 | `小类` | 唱片、宝可梦… |
| 书房 | `领域` | 语言、技能… |
| 美食 | `类型` | 餐厅、自炊… |
| 灵感 | `分类` | 想法、金句… |

规则定义在 `SHARD_FIELD` / `TRAVEL_CAT`（app.js）。字段为空的记录留在主文件。

### 4.4 封面图片

- 路径：`data/images/{类目}-封面/{类目}-0001.jpg`
- 命名：全局递增编号，4 位补零，**跨类目不重复**
- 保存时自动处理两种来源：
  - 上传的本地图片 → 压到长边 800px（上限约 160KB）后落盘
  - 粘贴的外链 → 尝试下载存本地；下载失败则保留原链接（不阻断保存）
- JSON 里**只存相对路径**，不存 base64，所以数据文件不会随图片变臃肿
- 显示时通过 `_imgUrlCache` 把相对路径换成 blob URL（本地）或静态 URL（线上）

---

## 五、部署到 GitHub Pages

1. 把本目录的文件推到仓库（**不要推 `token.txt`**，已在 .gitignore 里排除）
2. 仓库 Settings → Pages → Source 选分支（如 `main`）→ 根目录 `/`
3. 稍等片刻访问 `https://<用户名>.github.io/life-desk/`

纯静态，不需要构建。

---

## 六、日常使用流程

```
电脑端（Chrome / Edge）
  └─ 右下角「📂 选择数据目录」→ 选 data 文件夹
      └─ 录入数据（封面用「上传」选本地图片，别贴外链）
          └─ 新类目会弹窗问是否建专属文件 → 点「新建数据文件」
              └─ 数据直接写进 data/ 目录

手动同步
  └─ 打开 data/ 文件夹 → 把新增的 json 和 images 拖到 GitHub 网页上传
      └─ 看 README.md 里的「当前已用到 00XX」，只传比仓库里新的编号

手机端
  └─ 打开站点 → 直接读仓库静态文件（不需要 Token）
```

> 手机端读取走**静态直读**（fetch 站点里的 json），不经过 `api.github.com`，
> 所以不受国内访问 API 不稳定的影响，也不需要 Token。

---

## 七、维护与升级

### 改了代码之后

**务必同时升 `sw.js` 里的 CACHE 版本号**，否则用户浏览器还在用旧缓存：

```js
const CACHE = 'lifedesk-v23-2026-09-03';   // 改成 v24-日期
```

升版本后用户需要强刷一次（Ctrl+Shift+R）。

### 新增 / 改名分类

**一定要同时改 `LEGACY_CATS`**，否则老数据会变成「不属于任何分类」的孤儿：

```js
var CATS = ['手办','周边','杯盏','毛绒','卡牌','着物'];
var LEGACY_CATS = { '观影':'电影', '音乐':'留声机', '杯子':'杯盏', '服装':'着物' };
```

`normalizeRow()` 会在读取时用这张表把旧值换成新名。
同时 `MUSEUM_LAYOUT`（展厅摆位）的 key 也做了同名迁移。

配套要改的地方：`SUBS`（小类）、`CAT_ICON`（单字图标）、`CAT_BG` / `CAT_DECOR`（背景图）。

### 加新模块

1. `MODS` 里加定义（key / name / icon / fields）
2. `ORDER` 里加 key
3. `MOD_BG` 加背景图
4. `store` / `snapshotAll` / `loadAll` 走的是通用逻辑，无需改动

### 封面图片规范

- 上传后自动压到长边 800px、约 160KB 以内（`IMG_MAX_BYTES`）
- 单张上限不要调太大：数据最终要推到 GitHub，单文件有 100MB 限制
- 换图标直接替换 `images/pin-visited.png`、`images/sprout-wish.png`
  （代码会**自动检测图片底部尖端**作为锚点，让旗杆 / 草根对准标记点）

### 3D 地球相关

- 标记锚点：`spr.center.set(tipX, 1.0)`，`tipX` 由 `_detectTipX()` 自动算出
- 贴地形：`roff = terrainR(lat, lon) + 0.006`，与国界、城市点同一套
- 长按标记 2 秒可拖拽改位置（移动超过 6px 会取消，转为旋转地球）

---

## 八、安全提醒

> ### 🔴 `token.txt` 绝对不能推到仓库
>
> 里面是 GitHub Personal Access Token（`repo` 权限）。
> 一旦进公开仓库，任何人都能读写你的仓库。
>
> 建议：**删掉该文件，并到 GitHub 重新生成一个 Token**。
> 已在 `.gitignore` 里排除，但只有从未提交过才是安全的。

Token 只用于「应用内上传」这条路径；**手动拖文件上传不需要 Token**。

---

## 九、已知注意事项

| 事项 | 说明 |
| --- | --- |
| 浏览器支持 | FSA 只支持 Chromium 内核（Chrome / Edge）。Firefox / Safari / 手机浏览器会自动回落到 gh 或 local 模式 |
| 安全上下文 | FSA 需要 `https` 或 `localhost`，普通 `http` 下不可用 |
| 三维贴图体积 | `earth_color_16k.js` 有 5.5MB，首次加载较慢，之后被 SW 缓存 |
| 外链图片 | 粘贴的图片链接会尝试下载存本地，失败则保留原链接（外链有失效风险，建议直接上传本地图片） |
| localStorage 模式 | 只有 5MB，存几张图就满，仅作兜底 |
| `serve.js` | 早期「本地服务器」方案，已被 FSA 取代，可删（已在 .gitignore 中） |

---

## 十、快速索引

| 想改什么 | 去哪找 |
| --- | --- |
| 分类体系 | `CATS` / `SUBS` / `LEGACY_CATS`（app.js 1222 行附近） |
| 表单字段 | `MODS[key].fields` |
| 存储模式 | `MODE` / `snapshotAll()` / `fetchAll()` |
| 分片读写 | `storageSaveV2()` / `storageLoadV2()` |
| 图片外置 | `externalizeImages()` / `resolveImagesFor()` |
| 地球标记 | `rebuildMarkers()` / `_detectTipX()` / `terrainR()` |
| 小屏适配 | `style.css` 末尾 `@media (max-width: 600px)` |
| 离线缓存 | `sw.js` 的 `CACHE` 与 `PRECACHE_URLS` |
