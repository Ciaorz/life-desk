# 日常集 · 数据目录

> 这个 README 所在的位置，就是你在应用里选择的数据目录。所有数据文件都在这个文件夹里。

## 文件结构

```
（数据目录）/
├── README.md              ← 本文件
├── lifedesk.json          ← 主索引（类目清单 + 下一个封面编号）
├── 唱片-data.json          ← 每个类目一个数据文件
├── 去过的地方-data.json
├── lifedesk.backup.json   ← 拆分前的原始备份（确认无误后可删）
└── images/
    └── 唱片-封面/          ← 每个类目一个封面文件夹
        ├── 唱片-0001.jpg   ← 命名：类目-编号
        └── 唱片-0002.jpg
```

## 当前类目文件

| 类目 | 数据文件 | 封面目录 | 条目数 |
| --- | --- | --- | --- |
| ip | `` | `images/ip/` | 0 |
| series | `` | `images/系列/` | 0 |
| 赏戏 | `赏戏-data.json` | `images/赏戏-封面/` | 6 |
| 留音 | `留音-data.json` | `images/留音-封面/` | 2 |
| 书籍 | `书籍/书籍-data.json` | `images/书籍-封面/` | 1 |
| 杂志 | `杂志-data.json` | `images/杂志-封面/` | 2 |
| 美食 | `美食-data.json` | `images/美食-封面/` | 1 |
| 菜谱 | `菜谱-data.json` | `images/菜谱-封面/` | 1 |
| 学习计划 | `学习计划-data.json` | `images/学习计划-封面/` | 1 |
| 自然科技 | `书籍/自然科技-data.json` | `images/自然科技-封面/` | 0 |
| 工具语言 | `书籍/工具语言-data.json` | `images/工具语言-封面/` | 1 |
| 艺术视觉 | `书籍/艺术视觉-data.json` | `images/艺术视觉-封面/` | 0 |
| 人文历史 | `书籍/人文历史-data.json` | `images/人文历史-封面/` | 0 |
| 兴趣收藏 | `书籍/兴趣收藏-data.json` | `images/兴趣收藏-封面/` | 0 |
| 英语 | `书籍/英语-data.json` | `images/英语-封面/` | 1 |
| 德语 | `书籍/德语-data.json` | `images/德语-封面/` | 0 |
| 法语 | `书籍/法语-data.json` | `images/法语-封面/` | 0 |
| 语言学 | `书籍/语言学-data.json` | `images/语言学-封面/` | 0 |
| 哲学 | `书籍/哲学-data.json` | `images/哲学-封面/` | 0 |
| 文学 | `书籍/文学-data.json` | `images/文学-封面/` | 0 |
| 历史 | `书籍/历史-data.json` | `images/历史-封面/` | 0 |
| 汉语/古文 | `书籍/汉语_古文-data.json` | `images/汉语_古文-封面/` | 0 |
| 辞书辞典 | `书籍/辞书辞典-data.json` | `images/辞书辞典-封面/` | 0 |
| 观鸟 | `书籍/观鸟-data.json` | `images/观鸟-封面/` | 1 |
| 自然图鉴 | `书籍/自然图鉴-data.json` | `images/自然图鉴-封面/` | 0 |
| 植物 | `书籍/植物-data.json` | `images/植物-封面/` | 0 |
| 生物学 | `书籍/生物学-data.json` | `images/生物学-封面/` | 0 |
| 生物杂谈 | `书籍/生物杂谈-data.json` | `images/生物杂谈-封面/` | 0 |
| 物理天文 | `书籍/物理天文-data.json` | `images/物理天文-封面/` | 0 |
| 地理风景 | `书籍/地理风景-data.json` | `images/地理风景-封面/` | 0 |
| 徽章 | `徽章-data.json` | `images/徽章-封面/` | 19 |
| 冰箱贴 | `冰箱贴-data.json` | `images/冰箱贴-封面/` | 1324 |
| 去过的地方 | `去过的地方-data.json` | `images/去过的地方-封面/` | 2 |
| 想去的地方 | `想去的地方-data.json` | `images/想去的地方-封面/` | 1 |
| 想法 | `想法-data.json` | `images/想法-封面/` | 1 |

## 封面图片编号

当前已用到 **0000**。

命名规则：`{类目}-0001.jpg`，编号在每个 `images/{类目}-封面/` 文件夹内独立递增。

所以往 GitHub 补传时，只要看仓库里已经存在到几号，从下一个号开始传就行，
已经传过的不用重复传。

## 手动上传到 GitHub（不用 Token）

1. 打开你的仓库，进入要存放数据的目录（例如 `data/`）
2. 点右上角的 **Add file → Upload files**
3. 从**本文件夹**里把文件拖进去：
   - `lifedesk.json`（主索引，有变动就要传）
   - 各个 `{类目}-data.json`
   - `images/` 下的封面文件夹（只传新增编号的那些）
4. 点 **Commit changes**

> 也可以在本地把这个数据目录当成 git 仓库，用 `git add . && git commit && git push` 一次推完。

## 手机端查看

手机端打开站点后，会直接读取仓库里的静态文件（不需要 Token）。
如果看不到最新内容，确认一下 `lifedesk.json` 和对应类目文件都已经传上去了，然后刷新页面。
