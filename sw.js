/* ============================================================
 * sw.js  v14  — 生活工作台
 *
 * 设计原则（沿用 v13 的安全底线，v14 提速）：
 *   1. 导航（HTML）走【网络优先】，永远不返回旧的/坏的缓存，绝不白屏。
 *   2. 子资源（.js / .css / .png / .webp / .json）走【stale-while-revalidate】：
 *      —— 命中缓存立即返回（重复访问秒开，不再每次都回源拉 600KB 的 app.min.js）；
 *      —— 同时后台静默 fetch 最新版写回缓存，下次访问就是新的。
 *   3. 关键资源（app.min.js / style.css）后台拿到新版且 ETag 变化时，发消息让页面
 *      静默刷新一次，保证部署后仍能自动拿到新版（呼应 v59「部署即刷新」的诉求），
 *      SW 生命周期内至多触发一次，页面侧再加时间闸门，杜绝死循环。
 *   4. 跨域请求默认不拦截（避免污染浏览器其它行为）；
 *      ⚠️ 2026-09-24 起有【一个例外】：Cloudflare R2 上的封面 /api/img/**，
 *      因为封面搬到 R2 后成了跨域，不拦就完全没离线缓存（见下方 CLOUD_IMG_RE）。
 *   5. activate 时只清理本 SW 自己的旧缓存，不动其他 SW 的。
 *   6. 任何 fetch 出错就静默放行（return undefined → 默认 fetch 行为），
 *      绝不让一个资源 404 把整个页面卡死。
 * ============================================================ */

/* v96m：每次部署请 bump 这个版本号 —— 浏览器只有发现 sw.js 字节变了才会安装新 SW，
   版本号不变 → 手机上永远拿不到新的 app.js / style.css（这就是"PWA 不更新"的根因）。 */
/* v101（2026-09-18）：加了云同步上传 + 服务端查书，离线能力不受影响（逐条对照过）。
/* v103（2026-09-18）：这次改的仍是 app.js —— 加了「云同步下载 + 字段级合并」
   （☁ 面板里的「下载 / 全量下载」按钮），以及根治「手机录完刷新即丢」的
   mergeLoadData 并集逻辑（刷新加载第②步从「整份覆盖」改成「字段并集」）。
   ⚠️ 离线能力依旧不受影响，逐条对照过：
     - app.js / style.css 仍在 PRECACHE_URLS 里 → 断网照样能打开、能改数据
     - 图片仍在独立的 IMG_CACHE（cacheFirst，绝不回源）→ 离线封面不失效
     - /api/* 跨域调用被「只处理同源」放行 → SW 不掺和，断网静默降级
   所以 bump 版本号只是让新 app.js 尽快落地，不会牺牲离线。
   ⚠️ 这条改动最关键的一点：手机端必须拿到新版 app.js 才能修好「刷新即丢」，
   所以这次 push **务必** bump 版本号（否则手机永远跑旧逻辑）。 */
/* v106（2026-09-24）：封面搬到 Cloudflare R2 + 手机端改读 Cloudflare。
   ⚠️ 这一版**真的动了 SW 的缓存行为**（v103 那版只是让 app.js 尽快落地）：
     - fetch 处理器原来对跨域一律放行 → R2 上的封面（pages.dev/api/img/**）
       会被整个跳过、完全不缓存 → 出门没网封面全白。现在单独放行这一个路径走 cacheFirst。
     - cacheFirst 原来只存 resp.type === 'basic'，跨域带 CORS 的响应 type 是 'cors'
       会被丢掉；现在两者都存（'opaque' 仍然不存）。
   ⚠️ 线上 sw.js 曾被手工上传成 v104，所以这次直接跳到 v106 —— bump 前先查线上版本号，
      撞版本号 = 手机沿用旧缓存、先跑一遍旧 app.js。 */
/* v107（2026-09-24）：app.js 修了 topbar ⟳「重新拉取」按钮 —— 清掉 _ghCache 后才会真正
   从 Cloudflare 重新全量拉数据（之前被内存缓存短路，点 ⟳ 只是重渲染旧快照）。
   ⚠️ 只动了 app.js，SW 自身缓存行为没变；bump 纯粹是为了让手机端装上新 app.js。 */
/* v108（2026-09-24）：app.js + style.css 改了藏品详情页布局 —— .dtop 由 grid 改 flex
   （封面固定宽、文字列 min-width:0 防重叠），buygrid 统一两列（购入信息一排放两个）。
   ⚠️ 同理，SW 缓存行为没变，bump 只为让手机端装上新 css/js。 */
/* v109（2026-09-25）：① 残留「博物馆」字眼改「藏品馆」；② 详情页 X 按钮居中 + 弹层垂直居中；
   ③ 概览头部删 hint、总投入→充电量、手机端按钮与年份框同行居右且同高、collstat 更扁；
   ④ 系列详情「返回系列列表」按钮移到筛选 seg 行居右；⑤ 30周年冰箱贴收集进度改按「在库数」计；
   ⑥ 新数据架构：gh 模式编辑不再推 GitHub（断网不再报同步失败），改标「待上传 N 条」角标并防抖静默上传 Cloudflare。
   ⚠️ 仅动了 app.js/style.css/index.html，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v110（2026-09-25）：① 详情卡「购入时间」点开编辑时默认带出今天（本地时区），不点则仍为空；
   ② 系列详情支持按「物品类型（小类）」筛选 —— 从按类别进入只显示该类别的物品，
      系列内有多种类型时出下拉框，单一类型不显示也不过滤（避免漏填记录被排除、影响 1025 进度）；
   ③ 系列详情 acts 行加「+ 添物品」，自动带好 IP / 系列 / 大类 / 小类；
   ④ pkbar 属性图标去掉边框与白底，直接浮在 pkbar 上（选中态改极淡底色 + 细描边）。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v111（2026-09-25）：① 「返回系列列表」桌面端紧跟 seg 框、仅手机端居右（.sback）；
   ② 详情页 × 改用 CSS 画两条斜线（U+00D7 字形本身偏上，flex 居中修不掉），任意字体下精确居中；
   ③ 修「待上传 N 条」虚高：墓碑判定改成 t.at > 水位线，与 cloudCollect 完全一致
      （老墓碑永不清理，之前直接数 ts.length，导致角标说 N 条、点进去却「没有需要上传的改动」）；
   ④ 新增「子系列」：item 字段 + 系列详情下拉筛选（Road trip → 徽章/冰箱贴/行李牌）+ 「+ 添物品」带出；
   ⑤ 工作台头像文字放开英文单词（如 life），按字数自动缩放字号，最长 6 字。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v112（2026-09-25）：① 系列 acts 行「+ 添物品」缩成方形「+」块；
   ② 概览「充电量」按钮与年份框手机端严格同高（30px）、金额框按概览框同档缩小
      （年份框样式从内联挪到 .yearsel，内联样式没法被媒体查询覆盖）；
   ③ 手机端藏品详情隐藏「购入信息」小标题；
   ④ 手机端「按类别/按 IP/按系列」与「藏品」标题同行、居右（grid + .phtxt{display:contents}）；
   ⑤ 手机端小类整行加背景条 + 当前大类做「凸起」，做成文件夹标签的从属感；小类按钮小一号；
   ⑥ 手机端「按系列/按物品」与「隐藏款」压到 34px（和 IP 下拉同高）、左右收窄；
   ⑦ 修「韩国 快闪」这类**空系列**进详情后没有「← 返回系列列表」——空态早退原本写在
      segline 之前，把工具行一起跳过了，已把早退移到 segline 之后。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v113（2026-09-25）：子系列重构 —— 由「写在 item 上的自由文本」改成「在编辑系列里显式登记」。
   ① 系列表单：第一排 系列名称；第二排 所属IP + 系列总数量 + 「＋ 添加子系列」；
      点按钮后第三排出现 子系列名称 + 数量 + 确认（另有取消）。已建的以药丸列出、可单个删。
   ② 子系列定义存在**系列记录自己的「子系列」字段**（[{名称,数量}]）——不另建记录、不另开目录，
      它的封面与它名下 items 的封面都留在该系列目录下（items 本来就按父系列名归档）。
   ③ 录入/编辑物品时，只有**登记过子系列**的系列才出现「子系列」下拉框；没登记过的整个字段不出现。
   ④ 出现子系列时，IP / 系列 / 子系列 三个并成一行（表单切 12 栏栅格，各占 4 栏）；
      不出现时表单仍是原来的 4 栏，布局与以前一模一样。
      新增 .fgrid.fg12 与 .f 的 --w 变量（占几栏内联下发），手机端已做单列复位。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v114（2026-09-25）：修「电脑端新加的封面在手机上裂图、点上传却说没有需要上传的改动」。
   ① externalizeImages（外链落盘 / 批量下载封面 / 同系列一次性落盘）写盘后**漏了 writeThumbFor** ——
      于是这些原图没有 data/thumbs 缩略图；手机端 USE_THUMBS 恒为 true，只读 thumbs → 一片裂图。
      命中已有图片（去重分支）时同样补一张，兼容老数据。
   ② moveImageFolder（IP / 系列改名时搬封面目录）只搬了 data/images，**没搬 data/thumbs** ——
      改名后手机端这一整套封面会全裂。现在缩略图目录一起挪。
   ③ ☁ 云同步面板加一行醒目提示：记录走「上传」（D1），封面是另一条线（R2，要跑
      tools/push_images_to_r2.py）。这行缺了很久，是「反复点上传永远是没改动」的困惑来源。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v115（2026-09-25）：① 修「子系列下拉是空的」——dynOptions 里 v111 的旧 child 分支（按 item 现扫）
      写在 v113 新写的登记表分支前面、直接 return，把登记表版本变成了**死代码**；
      而当时没有任何 item 写过「子系列」，于是永远返回空。现已删掉旧分支，只留登记表版本（含老数据并集）。
   ② 系列下拉按 IP 过滤 —— 先选 IP（如宝可梦），系列下拉只列「所属IP = 该 IP」的系列；
      IP 选「（不属于任何 IP）」时才列全部。换 IP 时若原系列不属于新 IP，连子系列一起清掉。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v116（2026-09-25）：「下载封面」改成**增量**，并在云同步段加了新按钮。
   ① 以前是一次性把 1400+ 张全下一遍（慢、白耗流量）。现在先查本机 Cache Storage
      （桶名 lifedesk-imgs-v1，与 sw.js 的 IMG_CACHE 同名，页面直接读写），
      **只下缺的那些**；已下过的直接跳过。分批 60 个查一次，避免一次并发上千个 match。
   ② 云同步面板新增「下载封面」（增量）+「全部重下」两个按钮，并显示
      「本地已有封面 N / 总数」；打开面板时自动重算。
   ③ GitHub 设置段那个老「下载封面」保留（以后走 git 也能用），一样改成增量。
   ④ 下载时用 fetch(..., {cache:'no-store'}) —— 避免浏览器 HTTP 缓存里存过某张图的 404
      导致新上传的封面怎么都拉不下来。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。
      （IMG_CACHE 桶名没变，所以升级这个版本不会动已离线好的封面。） */
/* v117（2026-09-25）：① 云同步面板新增「上传封面」——**一键把本地封面传到 R2**，
      不用再开命令行跑 push_images_to_r2.py。扫 data/thumbs → 对比台账 → 只传没传过的，
      分批 POST /api/img-batch。台账 data/.r2_uploaded.json 与 py 脚本共用（老位置自动迁移）。
   ② 面板里的说明文字收进可折叠的「说明」块，默认收起（原来一大段把面板撑得很长）；
      常驻的两行只显示状态：「本地 N 张封面都已在云端」/「还剩 M 张没上云」。
   ③ 封面那组按钮独立成区（上传封面 / 下载封面 / 全部重下），与记录的上传下载分开。
   ⚠️ 仅动 app.js（+ tools/push_images_to_r2.py 的台账路径），SW 行为未变。 */
/* v118（2026-09-25）：把「图片入库」的三条目录理顺，两条入库路径统一。
   ① externalizeImages（外链落盘 / 批量下载封面）以前【直接把原图 jpg/png 写进 data/images】——
      既不存 data/orig 存档、也不转 WebP，和「表单上传图片」那条路（ingestImageToLib）不一致。
      实测后果：data/orig 1437 张 vs data/images 1457 张（少 20 份原图存档），
      且 images 里混着 20 个 jpg/png。现在两条路统一为：
        原图（原始字节+原始扩展名）→ data/orig；展示图转 WebP（不缩放 q=0.92）→ data/images。
   ② writeThumbFor 以前只认 data/images 下的图 —— 现在 data/orig 也认，
      这样「WebP 转换失败退回 orig」时也能生成缩略图。
   ③ thumbOf / normalizeImgPath 同样认 data/orig（否则退回 orig 的记录在手机端会 404，
      因为 R2 上只放了 thumbs）。
   ⚠️ 只动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v119（2026-09-25）：藏品馆（按类别页）工具栏与标题整理。
   ① 删掉「点开任意一件，看它的购入信息和存放位置」这行介绍
      （.coll-cat-head 随之从 grid 简化为 flex + .phtxt{display:contents}）。
   ② 「按系列 / 按物品」两个按钮 → 只留**一个「按物品」切换按钮**（与「隐藏款」同一个套路）：
      默认未选中 = 按系列；点一下 = 按物品；再点 = 取消回按系列（data-v 置空即回落到系列）。
   ③ 「按物品」与「隐藏款」压到与 IP 下拉框同高（34px），并把字号提到 12.5px ——
      框压扁后上下留白显多，放大字号正好抵掉「字小看不清」的问题。
   ④ 删掉「← 返回展厅」按钮（回展厅的路：手机端左缘右滑；任意端点侧栏「藏品馆」）。
   ⑤ 小类背景条在「凸起贴边」那一侧抹平上圆角：选中第一个大类（手办）→ 抹左上；
      选中最后一个（着物）→ 抹右上。否则两个圆角在同一位置会露出一道缝。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v120（2026-09-25）：
   ① 修「手机端什么都没改，却突然显示待上传 N 条」——
      旧判定是「记录 _upd > 本机上传水位线」。水位线**只有本机自己上传**才推进，
      于是电脑端改过并早已上云的记录，在手机端会被算成待上传（点上传真的会重传一遍）。
      新增「本机见过的云端版本」台账 lifedesk_cloud_seen：从云端加载/下载、以及本机上传成功
      的记录都记进去；只有 _upd 比台账还新的才算真待上传。cloudCollect 与 cloudPendingCount
      共用同一个判定函数 cloudRecordPending，角标和真上传再也不会互相矛盾。
   ② 购入日期（年/月/日 三段）点年份下拉时，若整段为空则一次带出今天；已有值不动。
   ③ 搜索栏里 × 排在「搜索」按钮**左边**（输入框 → × → 搜索）。
   ⚠️ 同样只动 app.js，SW 缓存行为未变，bump 只为让手机端装上新版本。 */
/* v121（2026-09-25）：藏品馆工具栏手机端压成一行 ——
   「按物品 / IP 下拉 / 隐藏款 / 卡片大小滑杆」强制不换行；两个切换按钮收窄内边距；
   滑杆从「自己占一行的一半宽」改成 96px 基准（放不下还能再缩到 52px）。
   做法：藏品馆那条 .segline 加 collbar 类，规则只用 .segline.collbar 作用域，
   不碰系列详情那条（它里面还有两个下拉 + 返回按钮）。⚠️ 仅动 app.js/style.css。 */
/* v122（2026-09-25）：上条基础上，滑杆 `margin-left:auto` 顶到该行最右端
   （左边「按物品 / IP / 隐藏款」靠左，滑杆单独靠右）。⚠️ 仅动 style.css。 */
/* v123（2026-09-25）：「按物品 / 隐藏款」与 IP 下拉框严格同高 —— 两边都显式写
   `height/min-height/max-height:30px + box-sizing:border-box`（原来 chip 写死 34px、
   select 只有 min-height，iOS 上 select 的实际高度由浏览器算，两者对不齐）。
   高度同时从 34px 收到 30px，比原来更扁。⚠️ 仅动 style.css。 */
/* v124（2026-09-26）：**修「改了没反应 / 反而更高」的真根因** —— 用真实浏览器（headless
   Chrome + CDP）实测发现：那套高度规则全写在 `@media (max-width:560px)` 里，布局宽度
   一旦不是 ≤560（平板、横屏手机、部分 PWA/WebView 会到 600-980px）就一条都不生效，
   浏览器算出来是「隐藏款按钮 30.4px / IP 下拉框 34px」，数值怎么调都没用。
   现在把「锁高」拆成两条**全局、且不依赖新增类名**的规则：
     `.chip.chipflat{height:min:max-height:var(--ch)}` + `#ipFilterSel{同上 + appearance:none
     + 内联 SVG 箭头}`（--ch=28px 定义在 :root，想调扁只改这一处）。
   ⇒ 即使设备上跑的是旧 app.js（没有 collbar 类），高度照样锁得住；实测摘掉该类名仍为 28/28。
   `.segline.collbar` 只保留「不换行 + 滑杆靠最右」这类版式；≤560 里只留手机专属微调。
   ⚠️ 仅动 style.css，SW 行为未变。 */
/* v125（2026-09-28）：修「隐藏款筛选残留导致列表空白」——
   `ui.collection.hidden` 是全局状态，而筛选按钮只在**当前范围真有隐藏款**时才渲染。
   于是在有隐藏款的系列/类目里打开它、切到没有隐藏款的系列后：按钮不显示、筛选却仍生效，
   列表被滤成空白，用户连关都关不掉。现在新增守卫 `hiddenFilterScope(scopeRows)`：
   按「当前范围」（大类/小类/IP，或当前系列）判定是否存在隐藏款，**同时**决定按钮是否渲染、
   并清掉失效的筛选状态；`renderCatMode` 与 `renderSeriesDetail` 共用它。
   顺带把类目里按钮的判定范围从「全部藏品」收窄成「当前大类/小类/IP 范围」。
   ⚠️ 仅动 app.js，SW 行为未变。 */
/* v126（2026-09-29）：宝可梦 IP 的「在库 / 收服」快速按钮改用精灵球图标
   （闭球 ball-closed = 已收服/在库；开球 ball-open = 还没收服）。
   两个图标在 data/images/types/ 下（128×128 透明底 WebP，四角已透明、只留球体），
   缩略图已推 R2；app 侧把它们加进 pkIconProbeRows 以便 FSA 模式解析。
   CSS `.pkq.pkq-ball` 去掉边框与白底 → 和属性图标一样「没有衬底」直接浮在卡上。
   ⚠️ 动的是 app.js/style.css，SW 行为未变。 */
/* v127（2026-09-29）：修「点一下再点回来也报待上传 1 条」——
   两层改动：
   ① 写库前先比内容（`patchIsNoop` / `cloudRowSig`）：`localUpsert`、`patchRow`、
      `patchRowFields` 三处，值没变就**整条跳过** —— 不动 _upd/_rev、不落盘。
      以前无脑把 _upd 刷成 now，于是角标虚报、上传白推、云端 _rev 白加。
   ② 待上传判定新增「内容指纹」：`lifedesk_cloud_hash = {id: 云端内容指纹}`，
      在「从云加载 / ☁下载 / 上传成功」三处记录。判定改成
      **内容和云端版本不一致才算待上传**（指纹忽略 _upd/_rev/_file，键序与
      「状态」这类字符串数组的顺序都不影响）→ 光时间戳变了不再算改动。
      没有云端指纹的记录（本机新录、云端从没见过）退回原来的时间戳判定。
   ⚠️ 仅动 app.js，SW 行为未变。 */
/* v128（2026-09-30）：修「点『在库』后『想收』没自动解除」——
   状态里只要出现「在库」，就自动清掉「想收」和「云游」（原来只清了云游）。
   把 `clearWanderWhenOwned` 扩成 `clearOwnedConflicts`（旧名保留为别名），
   三个写入路径全部改用它：快速按钮 `toggleRowStatus`、表单保存 `doSave`、批量编辑。
   另外 `toggleRowStatus` 的「脏数据兜底」分支也把「想收」算进去：
   已是在库却还挂着想收/云游时，点一下只清掉多余的、保留在库
   （否则会出现「点『在库』反而把它取消、想收还留着」的反直觉结果）。
   ⚠️ 仅动 app.js；另有一次性数据修复工具 tools/fix_owned_wish.py。 */
/* v129（2026-09-30）：修「手机端精灵球撑满整张展示卡」。
   根因是**上次部署漏推了 style.css**：线上 app.js 已是新版（会生成精灵球），
   而线上 style.css 还停在 v124（没有 v126 新增的 .pkq-ball 规则）。
   于是 <img> 没有任何 CSS 约束 → 按**原图 128px** 渲染，而手机端卡片只有 112~114px
   → 图片直接撑满整张卡。
   已实测复现：用线上那份 v124 CSS 渲染旧版按钮 = 138.6×136.7px（卡片 114px，溢出）；
   新版 = 17.5px 正常。
   修复：把尺寸与「无衬底」**写进 app.js 生成的内联样式**（随 app.js 走，
   以后即使 style.css 又落后一版也不会爆）；style.css 里的同款规则保留。
   ⚠️ 本次 app.js + style.css 都要推（style.css 含 v126 的 .pkq-ball 规则）。
   另加了 tools/check_deploy.py 用于核对线上与本地是否一致。 */
/* v130（2026-10-04）：把「宝可梦图鉴系列」的判定从**写死只认「30周年冰箱贴」**放宽成
   `pkLikeSeries(se)` = IP 是宝可梦 且 该系列确实带图鉴字段（属性/特殊形态/世代组/formCode）。
   于是「全图鉴金属徽章」这类同样按图鉴号建的系列，也能用上：
     · 系列内的「属性 / 特殊形态 / 图鉴组 / 世代组」筛选栏（原来这套系列完全看不到）
     · 卡片右下角的属性图标（`pkTypeIconsHTML` 的判定同步放宽为「IP=宝可梦 + 有属性字段」）
     · 按「图鉴号 + 形态序」排序、收集进度只数基础形态（formCode 为空）
   数据侧：`tools/add_pokedex_badges.py` 一并补齐 特殊形态/图鉴组/地区 字段，
   并加入未知图腾 0201 的 26 个字母变体（formCode 01..26，同号共存）。
   ⚠️ 仅动 app.js（style.css / index.html 未变），bump 只为让手机端装上新 app.js。 */
/* v131（2026-10-04）：图鉴系列的收集进度改成**按号码统计**（原来按「行」）。
   原因：用户删掉了未知图腾 0201 的基础条（他手上只有 A~Z 字母版，没有"不带后缀"的那种），
   而旧逻辑只认 formCode 为空的那一条 → 整个 0201 被判成缺号、显示「待录入」且删不掉，
   在库统计也漏掉这个号码。
   现在：新增 `pkSlotStats()` 把条目按号码归并 ——
     · 号码下还有任意一条 → 不算缺号
     · 号码下任意一条是「在库」→ 这个号码就算收到（未知图腾收了几个字母也算 0201 收到）
   实测：金属徽章系列「还缺」列表清空、在库 87（含 0201）。
   ⚠️ 仅动 app.js，bump 只为让手机端装上新 app.js。 */
/* v132（2026-10-04）：app.js + style.css —— 「30周年冰箱贴」拆成「冰箱贴版 / 贴纸版」。
   同一个系列、同一套图鉴（名字 / 编号 / 封面 / 属性共用），但 在库 / 想收 各自独立：
   数据上是两份记录（副本只有 版本/状态/_id/_upd 不同），系列详情页顶部多一个切换按钮；
   贴纸版的卡片/列表带「贴纸」角标，免得在平铺列表里分不出谁是谁。
   数据侧另跑 `python tools/split_fridge_versions.py --apply`（幂等，带备份）。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v133（2026-10-04）：app.js + style.css —— ①藏品表单加「品牌」字段（下拉 + ＋新增，
   品牌清单存主索引 lifedesk.json.brands，另在 localStorage 留一份兜底）；
   ②端盒 / 隐藏款 合并成一格上下叠放（stack:'boxpair'），省下的 25% 给品牌；
   ③修「从系列详情点＋添加物品，表单里却是别的系列」—— 草稿覆盖了入口预填的
     系列 / IP / 小类 / 子系列，现在预填优先级最高，读完草稿再盖回去。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v134（2026-10-04）：app.js + style.css —— ①「30周年冰箱贴」是特殊项目：展示卡左上角
   改成显示版本名（冰箱贴版→「冰箱贴」、贴纸版→「贴纸」），不再写「周边」；
   原来那个额外的「贴纸」角标（.vertag）连同 CSS 一起删掉。
   ②从系列里添加物品的上下文抽成 `seriesAddPrefill()`，顶栏「+藏品」在系列详情里也带上下文；
   在「贴纸」视图里新增的条目自动带 `版本:'贴纸'`（localUpsert 里显式写回）。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v135（2026-10-04）：修「端盒/隐藏款 和 品牌 被拆到两行」——
   根因是 v133 给叠放格加了 rowstart（强制另起一行），其实是多余的：
   实测 4 栏与 12 栏两种表单里「状态」都自己占一行开头，
   叠放格 + 品牌跟在它后面正好凑满一行；加了 rowstart 反而把这一组推到下一行。
   现在去掉 rowstart；另外「状态」的四个选项改成**两行、一行两个**（两列网格）。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v136（2026-10-04）：下拉的「新增」入口统一 —— 都放进下拉列表里，不再有额外的加号按钮。
   ①「小类」原来的自定义是原地露出一个文本框，点了常常像没反应；现在下拉里那项叫
     「＋ 新增小类…」，选中它弹输入框，确认后走 addUserSub 正式登记（写主索引 userSubs）。
   ②「品牌」右边那个 ＋ 按钮删掉，改成下拉里的「＋ 新增品牌…」，跟小类同一套路。
   ③ 那个 '__custom__' 只是操作项、不是值：通用 [data-f] 处理器里加了守卫，
     免得用户点了又取消、把 '__custom__' 当成真值存进记录。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v137（2026-10-04）：系列里的条目「没有在库就算云游」——
   ① 新录入：`seriesAddPrefill` 把 状态=['云游']、持有=0 一并预填，
      所以在系列里（含顶栏「+藏品」）拖进去的新条目默认是云游而不是在库；
      勾「在库」时老规矩仍会自动清掉云游。
      ⚠️ 持有必须写进预填：openForm 里那条「持有默认」只在持有为空时生效，
         一条残留草稿里的「持有:1」会把整条跳过（实测），云游条目就会显示成持有 1。
   ② 存量数据：`localUpsert` 里兜一道 —— 属于系列且状态全空的藏品一律补成云游
      （批量添加、手动选系列、用户把状态全取消 这几条路径都覆盖）。
   ③ 一次性把已有的 2238 条补上：`python tools/fix_wander_status.py --apply`（幂等，带备份）。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v138（2026-10-04）：手机端「世代组」筛选的 chip 只显示「第一 / 第二 …」，
   不再每个都带「世代」二字 —— 十个「第N世代」各配一个计数徽章太宽，会折成 4 行。
   `chipsHTML(f, list, labelOf)` 新增可选的第 3 个参数做「值 → 显示文字」映射，
   `data-v` 仍是全名，筛选 / 计数 / 会话记忆全不受影响；桌面端照旧显示全名。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v139（2026-10-04）：搜索栏后面新增「筛选」按钮 + 筛选卡。
   卡片把藏品每个字段都列出来、每个字段都可多选（带条数），点「应用」后墙上只留
   同时满足所有字段条件的物品（字段之间 AND、字段内部 OR；`状态` 是数组，按有交集算）。
   应用时自动切「按物品」平铺，清空时自动收回「按系列」。
   实现：`ADV_FIELDS` / `advOptions` / `advMatchRow` / `applyCollectionAdv` / `openAdvFilterCard`，
   条件存在 `ui.collection.adv = {字段:[值…]}`，在 `filtered('collection')` 里叠加。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v140（2026-10-04）：筛选卡从「弹层」改成**内嵌在 panel 里的卡片**，就挂在搜索栏下面；
   再点一次「筛选」收起。字段收窄到大类 / 小类 / IP / 状态 / 品牌 五个（其余不要）。
   编辑中的选择进 `ui.collection.advDraft`，点「应用」才写进 `adv` 生效（收起 = 放弃本次改动）；
   点条件只重画卡片本身（`advRepaint`），不整页 render —— 墙上上千张卡时重绘会明显卡。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v141（2026-10-04）：筛选卡排版紧凑化 ——
   ① 去掉「筛选」标题行和「还没选条件…」总览行（收起改回只靠「筛选」按钮开关，× 也去掉了）；
   ② 字段标题与选项**同一行**：「大类：周边 手办」这样；圆片也缩小了一档；
   ③ **小类跟着大类走** —— 小类归属于特定大类，选了「大类」后小类候选只列这些大类下面的
      （`advSubCountMap` 挂在字段的 `countOf` 上）；换大类时自动丢掉已经不属于的小类。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v142（2026-10-04）：明确「**某个字段没选标签 = 这个字段不参与筛选（等于全部）**」
   —— 只有选了具体标签才按选中的筛。同时把工具栏那几个跟卡片同名的快速筛选
   （大类 chip / 小类 chip / IP 下拉）并进卡片显示，并在应用后清掉它们：
   这五个字段的唯一筛选源就是卡片本身，所见即所筛。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v143（2026-10-04）：
   ① 详情卡「持有」两侧加了 **− / ＋** 按钮（`bumpHold`）—— 一次点击就加减 1，
      不必再「点数字 → 打字 → 点别处」。基准取 effHold（在库没填过=1、云游=0），最低 0；
      减到 0 后减号自动禁用；数字本身仍可点（原地编辑，方便一次跳到 10 这种大数）。
   ② 批量编辑新增 **大类 / 小类**（下拉，`batchCatRows`）—— 小类候选跟着所选大类联动；
      选「（不修改）」= 不写这一项。⚠️ 小类同时是分片键，改成新小类后 app 会问要不要建新数据文件。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v145（2026-10-04）：修「删掉某分类的最后一条记录后，它自己又冒出来」。
   根因：storageSaveV2 写分片时是 `for (var cat in buckets)` —— 只遍历【有行的】分片，
   某个分类被删空后那个 data.json 压根不会被重写，盘上旧内容还在，
   下次加载又读回来。用户那本「中国古代文化常识辞典」在两个分片里各有一份（2026-09-18 分片迁移
   留下的重复），删任一份都会删空一个分片 ⇒ 复活的循环，怎么删都删不掉。
   现在补一遍：注册过但没有行的分片，只要盘上还有内容就写成 rows:[]（不新建文件，不留空文件）。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v146（2026-10-04）：封面调整自由度放宽 —— 缩放 50%–150% → **30%–180%**，位移 ±80 → **±200**。
   顺带把尺寸/位置换算收拢成 `vpSizeCss()` / `vpPosCss()`（原来三处各写一份，都拿 Math.max(50,…)
   兜底：卡片样式、表单里的初始内联样式、拖拽时的实时更新 —— 改范围时容易漏一处，
   漏了就出现「表单里能拉到 30%、卡片上还是 50%」这种半吊子状态）；
   常量 VP_ZMIN/VP_ZMAX/VP_PAN 上移到文件靠前处（卡片渲染在页面加载时就要读它们）。
   拖拽 / 方向键原来硬编码 ±80，现在统一走 VP_PAN。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v147（2026-10-04）：修「录入时点『在库』，其他状态不自动取消」。
   录入表单里的状态联动**只写了「勾在库 → 取消云游」**，漏了「想收 / 已预订」——
   保存时 `doSave` 有兜底（数据是对的），但界面上的勾不掉，看着就像没生效。
   现在：勾「在库」→ 清掉云游/想收/已预订 + 持有填 1；勾「云游」→ 去在库 + 清持有；
   勾「想收/已预订」→ 去在库（不动持有）；只响应「勾上」，取消勾选不反向动别的。
   `toggleRowStatus`（展示卡快捷按钮）同样补上**双向**清理（原来只在加「在库」时清）。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v148（2026-10-04）：IP 支持**两级** —— 顶级大 IP（迪士尼）→ 子 IP（米老鼠 / 星际宝贝 / 小熊维尼）。
   做法：IP 记录新增「上级IP」字段（下拉只列顶级 IP 且不含自己 ⇒ 只能挂两层、不会成环）。
   ⚠️ **藏品记录里的 IP 一个字都不改**：东西仍挂在自己名下（如「星际宝贝」），
   父级只在展示 / 筛选 / 统计时聚合（`ipScopeNames`）—— 以后不想用层级了，数据侧不用回滚。
   改动面：IP 库分两级（父卡片 + 通栏「旗下 IP」区块）、IP 详情聚合旗下全部并列出子 IP 卡片、
   工具栏 IP 下拉与筛选卡的 IP 条件都认层级（选父级＝含旗下）、IP 表单加「上级IP」。
   兜底：`上级IP` 空 / 指向不存在的名字 / 指向自己 → 一律当顶级 IP（不会让 IP 从库里消失）。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v149（2026-10-04）：IP 库的层级改成「**平铺 + 折叠**」（用户明确要求）。
   ⚠️ 只是**改展示**，数据一个字没动：`上级IP` 字段、`ipTree`/`ipScopeNames` 聚合口径全不变，
      筛选 / 统计 / IP 详情页仍按「选父级＝含旗下」工作。
   改法：所有 IP（迪士尼自己、它旗下的、跟谁都不沾边的）都排进**同一张网格**，
   子 IP 的卡紧跟在父卡后面（普通大小，只多一个「↳」前缀 + 淡底色表示从属）；
   父卡右上角一个极小的圆形折叠开关（▸/▾，约 18px），点一下把旗下子 IP 一起收起 / 展开。
   § 上一版是「父卡下面挂一条通栏的内嵌小网格（`.ipkids`）」，等于把网格劈成两半、
     子卡还被缩到 128px —— `.ipkids` 已删；`.ipgrid-sub` 保留给 IP 详情页用。
   折叠状态**只是界面偏好**：存 `localStorage['lifedesk_ipfold']`（键=IP 名字），
   不进数据文件、不参与云同步、不进 `cloudStableStr` 指纹；默认展开。
   ⚠️ 仅动 app.js/style.css，SW 行为未变，bump 只为让手机端装上新版本。 */
/* v150 + v151（2026-10-06）：「在库 ⇒ 持有至少 1」—— 任何界面点一下「在库」，持有自动补成 1。
   用户要的行为：点「在库」持有变 1；本来就有 2 件以上**一个字不改**（自己点 ＋ 加）。
   为什么不能只靠 `effHold` 的**显示**兜底：那只是「显示成 1」，数据里还是空的 ——
   一打开编辑表单看到空、一导出 JSON 也是空，换个入口就露馅。
   所以补的是**数据**，且只补「还没记」的（空 / 0 / 负数 / 非法值）；填过 ≥1 的绝不覆盖（那是数据损失）。
   四个写状态的入口全部接上 `holdPatchForStatus`：
     ① 卡片快速按钮 `toggleRowStatus`   ② 表单里勾「在库」的 change
     ③ 表单保存 `doSave`                ④ 批量编辑 `applyBatchPatch`（逐行补，不能塞进统一 patch）
   ⚠️ v151 补的那条（用户第二轮反馈的痛点）：**状态已经是在库、但持有还空着**的老数据，
     点一下本来是想「补齐」，老逻辑却走「再点一次 = 取消在库」→ 看起来就是「点了在库，持有还是没变 1」。
     现在：只要「持有还没记」，点一下就是补齐，不再误取消；持有已 ≥1 才是真的切换取消。
   ⚠️ **v150 那轮只改了 app.js、忘了 bump 这里的 CACHE** → 浏览器/SW 一律返回旧 app.js，
     用户测来测去都是老行为（「还是没有变 1」就是这么来的）。这次把版本号推上去。
   回归测试：`node tools/test_owned_hold.mjs`（54 条）+ `node tools/e2e_owned_hold_cdp.mjs`
   （真实浏览器点击，5 条）。 */
/* v152（2026-10-06）：新增「预定物管理」—— 总览页原来「最近留下的」那个板块整块换掉。
   用户要的：预定（状态含「已预订」）的东西单独管 —— 填预定日期 / 预定出货日期、
   有出货日历提醒什么时候出货；出货日期**允许模糊**（只有月份、日子空着；也可以直接选季度）。
   · 两个新字段：「预定日期」（年月日三段，月日可空）、「预定出货日期」（新类型 `fuzzydate`）。
     存储是**一个字符串**，四种粒度：`2026-11-15` / `2026-11` / `2026-Q4` / `2026`。
     解析只有 `fuzzyDateInfo` 一个入口，落格 / 排序 / 倒计时全从它派生 —— 避免两处解释不一致。
   · ⚠️ 「最早」与「最晚」是两个口径：日历落格 + 排序用 `fuzzyDateKey`（**月初**），
     **逾期判定与倒计时用 `fuzzyDateEndKey`（月末）** —— 否则 `2026-11` 一到 11 月 1 号
     就被报成「已逾期」，那是错的（11 月还没过完）。季度与闰年 2 月都按真实月末算。
   · 总览页：提醒条（逾期红 / 未来 7 天黄 / 没填出货日期灰）+ 月历 + 预定物卡片列表。
     日历里**模糊日期带虚线圈**，不假装它很确定；卡片上「到货了」按钮直接走
     `toggleRowStatus('collection', id, '在库')` —— 复用互斥清理 + 持有补 1，口径与别处完全一致。
   · 翻月只看 `ui.poCal`（内存里的界面状态，不落盘、不进数据、不参与云同步）。
   ⚠️ 这次动了 app.js **和 style.css**，所以**两个都要推**；SW 行为未变，bump 只为让手机端装新版。
   回归：`node tools/test_preorder.mjs`（71 条）+ `node tools/e2e_preorder_cdp.mjs`（21 条）。 */
/* v153（2026-10-06）：没有系列归属的物品 —— 不再叫「未归类」，改按「大类 · 小类」展示。
   用户原话：「不要叫未归类，而是按照 大类·小类 进行展示管理。例如一家鼠抬蘑菇，这个不属于
   任何系列，但它是手办·景品，那么就以这个名字来统御。别写未归类，这个名字没有人情味，
   而且搞得它们没有系列归属的好像是孤儿。」
   改法：一次性换掉三处冷措辞，统一走 `catSubLabel` / `groupByCatSub` / `catSubBlocks`：
     · 系列视图（原「未归类」）      · IP 详情（原「手办（未归类）」）
     · 系列库页面（原「未归入系列」）· IP 库（原「未绑定 IP」）
   名字规则：`大类 · 小类`；没有小类就只用大类；都没有才兜底「藏品」。
   ⚠️ 分组后每组通常只有几条，所以**不接分页**（分页的 page/pageSize 是全局状态，
      几组共用一个页码会互相串）；只有某组超过 200 条才交回 `renderPagedWall`。
   顺手把两处删除确认文案也改了（「会回到按『大类 · 小类』归置」）。
   ⚠️ 只动 app.js（样式沿用现有的 .grp/.wall），SW 行为未变，bump 只为让手机端装新版。
   回归：`node tools/test_noseries_group.mjs`（28 条）+ `node tools/e2e_noseries_cdp.mjs`（8 条）。 */
/* v154（2026-10-07）：预定物管理四件改进（用户一次提了四条）。
   ① **购入渠道「可选可输」**：新字段类型 `t:'pick'` = 原生 `<input list>` + `<datalist>`，
      点一下从常用渠道里选，也能直接打字（清单外的照样收）。
      预设 `CHANNEL_PRESETS` = 淘宝 / 京东 / 小红书 / 抖音 / 古月鸟 / 千树模玩 / 闲鱼，
      再并上数据里真正用过的值（老写法不丢）。⚠️ 常量必须定义在 `MODS` **之前** ——
      MODS 字面量在那时就求值了，放后面会拿到 undefined，预设会静默失效（踩过）。
   ② **出货日历一排三个月**（原来是单月拉满整行，太宽）：窗口 = [基准月-1, 基准月, 基准月+1]，
      「本月」正好在中间；翻月按钮整体滑一个月。**手机端只显示中间那个**（CSS 隐藏首尾，
      不写第二套 JS 分支），因为窄屏放不下三列。
   ③ **预定物卡片上的日期可以点着就地改**（不弹窗）：点日期标签 → 卡上展开三个下拉 → 选完立刻写盘。
      点下拉不会误开详情页 —— 编辑区那层 `data-act="poeditnoop"` 把点击吃掉（`closest` 取的是它）。
   ④ **「预定日期 / 预定出货日期」从编辑表单里拿掉了**（用户嫌占地方）：
      这两个只由总览页的预定物卡片就地编辑。删字段定义不影响数据 ——
      `applyFieldVal` 以旧记录为底合并，表单里没有的字段一动不动、照样跟行同步。
   ⚠️ 动了 app.js **和 style.css**，两个都要推。SW 行为未变，bump 只为让手机端装新版。
   回归：`node tools/test_preorder.mjs`（105 条）+ `node tools/e2e_preorder_cdp.mjs`（27 条）。 */
/* v155（2026-10-10）：**收藏的状态模型定稿** —— 用户报「取消在库后状态丢了」之后一起梳理的。
   模型（用户拍板）：
     · **基础状态「在库 / 云游」二选一，必须有一个亮着** —— 不存在"没有状态"的藏品；
     · **「想收 / 已预订」是挂在「云游」上的附加态**（东西还没到手，但想要 / 已经订了）。
   合法形态只有三种：`['在库']` ／ `['云游']` ／ `['云游','想收'(,'已预订')]`。
   🐞 用户报的 bug：在「30周年冰箱贴」里误标某件为在库 → 取消 → **状态变空** →
      那条东西从「在库 / 云游 / 想收」三个筛选里同时消失，看着就像"丢了"。
      现在**取消在库直接落回「云游」**，表单里也会看到云游被自动点亮。
   · 实现：新增 `normalizeOwnStatus(arr)` 作为**唯一的形态入口**，四处写状态的地方全走它
     （快速按钮 `toggleRowStatus` / 表单 change / `doSave` / 批量 `applyBatchPatch`），
     不再各写一份互斥逻辑。⚠️ 它返回**新数组**、不是原地改，调用处要 `arr = normalizeOwnStatus(arr)`。
   · 表单 `rebuildStatus` 会把归一结果**反写回勾选框** —— 否则用户取消在库后框全空、
     数据却已是云游，界面与数据不一致。（程序改 `.checked` 不触发 change，不会递归。）
   · 表单里「取消勾选云游」= 东西到手了 → 自动落回「在库」（与上面反向对称，同样不留空）。
   · `clearOwnedConflicts` 保留为别名（老调用点多），但语义已变 —— 只调不接返回值会失效。
   · 数据侧：`tools/fix_own_status.py` 已把存量脏形态收敛（**11 条 / 8 个文件**，
     含用户点名的「克雷色利亚」「未知图腾」→ 云游、「超梦」→ 云游+想收、「一家鼠抬蘑菇」→ 云游+已预订）。
     那些记录的 `_upd` 已打新 → 重开页面点一次「☁ 上传」即可同步到云端。
   ⚠️ 只动 app.js（样式没变），SW 行为未变，bump 只为让手机端装新版。
   回归：`node tools/test_owned_hold.mjs`（72 条）+ `node tools/e2e_owned_hold_cdp.mjs`（6 条）。 */
/* v156（2026-10-10）：总览页的金额面板**去掉「累计投入」那一格**。
   用户指出它和「充电量」是同一个数（年份选「全部」时两者恒等），重复显示没必要。
   藏品馆的 `collStats` 早就只留一格了，两处口径现在一致；
   顺带删掉没人再用的 `allCost` 变量（免得留个死变量）。
   ⚠️ 只动 app.js，SW 行为未变，bump 只为让手机端装新版。 */
/* v157（2026-10-10）：30周年冰箱贴的两处筛选调整（用户要求）。
   ① **特殊形态去掉「无极巨化」**：`PK_FORMS` 里删掉这一项。
      ⚠️ **数据没动** —— 库里还有 2 张「无极汰那（无极巨化）」（编号 0890，图鉴组=传说宝可梦），
         它们在「全部」和「传说宝可梦」里照样看得到，只是不再有一个专门的形态筛选项。
         （剑盾里 Eternamax 是独立形态、官方中文就叫「无极巨化」，并进「超极巨化」等于改错数据。）
   ② **图鉴组新增「伊布」**：`PK_GROUPS` 末尾加一项。九种伊布横跨六个世代 ——
      133/134/135/136（第一）·196/197（第二）·470/471（第四）·700（第六），
      按世代筛散得到处都是，单独成组才看得全。含「伊布（超极巨化）」这个形态。
      数据侧由 `tools/add_eevee_group.py` 给这 9 个编号的所有行打上 `图鉴组 = '伊布'`
      （**20 条 / 2 个分片**：冰箱贴版 + 贴纸版两份记录都打）。
   ⚠️ 这个系列的「筛选项」最容易出的毛病是**选项和数据脱节**（加了选项没打标 → 点下去一片空白；
      或数据有值没选项 → 永远筛不出来）。所以新增回归测试
      `node tools/test_pk_groups.mjs`（28 条）**专测两边一致性**：
      每个选项都得有对应的行、数据里的值都得在选项里、九个编号一个不少、幂等。
   ⚠️ 只动 app.js（样式没变），SW 行为未变，bump 只为让手机端装新版。 */
/* v158（2026-10-10）：表单里切换「状态」时给一句明说的反馈。
   用户报：「在添加页面点『在库』，云游还是不会自动取消」。查证过程：
     · 互斥逻辑本身没问题 —— 本地 app.js、**线上那一份 app.js**、以及用
       `Input.dispatchMouseEvent` 发**真实鼠标事件**（不是 JS .click()）三种方式各验一遍，
       勾「在库」都会把云游清掉（`tools/e2e_form_status_cdp.mjs`，17 条全过）。
     · 真正的毛病是**界面没有任何反馈**：云游那颗药丸只是悄悄灭了，眼睛没跟上就会以为没生效。
   所以：勾一个状态时把「被它挤掉的那些」记下来，归一完给一句 toast ——
     「已切到「在库」，「云游」自动取消了」。反向（取消云游 → 落回在库）同样会提示。
   ⚠️ toast 的 z-index(90) 高于表单 backdrop(60)，在 sheet 打开时也看得见。
   ⚠️ 只动 app.js（样式没变），SW 行为未变，bump 只为让手机端装新版。 */
/* v159（2026-10-10）：两件新东西（用户一次提了两条）。
   ① **子系列聚拢**：系列详情里，同一「子系列」的物品连续显示、中间不插别的。
      用户原话：「系列里面如果有子系列，子系列的物品自动集中显示，中间不插入别的物品」。
      做法：`renderSeriesDetail` 里排完序（编号序 / 图鉴号序）之后，再过一道
      `groupByChildSeries(itemsAll, childNamesOf(name))` ——
      子系列之间的先后 = 系列里**登记的顺序**；没登记的按首次出现；
      没填子系列的排最后、组内保持原序。没有子系列的系列这一步是空操作。
      ⚠️ 只在系列详情里用；全库平铺（按物品）不该动顺序。
   ② **备注名（别名）**：给名字太长的东西挂个顺口的别名。
      · 表单：`名称` 输入框里放一个「＋ 备注」，点了才展开下面那行「备注名」（独立一行）。
        ⚠️ 展开只切 `.is-hidden` 这个 CSS 类，**不重绘表单** —— 字段列表在打开表单时就定死了，
           重绘会让用户填到一半的内容跳走（做「条件显示」时踩过这个坑）。
      · 展示：`nameHTML(row)` 统一输出「名称（黑）+ 备注名（灰、小一号，`.altname`）」，
        卡片墙 `collectionWall` 与列表 `collectionList` 都改用它（系列详情 / IP 详情 / 图鉴
        共用同一个 collectionWall，所以那几处自动生效）。
   ⚠️ 动了 app.js **和 style.css**（`.namewrap/.altadd/.altfield/.altname`），两个都要推。
   回归：`node tools/test_alias_child.mjs`（21 条）+ `node tools/e2e_alias_child_cdp.mjs`（13 条，
   真机含真实鼠标点击「＋ 备注」、卡片上备注名比名称小一号、系列详情卡片顺序连续）。 */
/* v160（2026-10-11）：预定物管理加「定金 / 尾款」，到货自动算价；手办加「比例」。
   ① **定金 / 尾款**：预定物卡片上两个**可点的金额标签**，点了就地出数字输入框
      （跟日期那套同一机制，`data-poseg="num"`）。
      · 两个里填了任意一个就显示「合计 ¥N」—— 提前看到到货会填多少钱。
      · ⚠️ **不写进 `MODS.collection.fields`**：只在预定物卡片上编辑，不占编辑表单
        （用户上次明确说过那两个日期字段"别占编辑页的地方"，金额同理）。
        数据仍挂在行上、跟着云同步走，只是没有表单入口。
   ② **到货算价**：点「到货了」时，`购入价格` 自动填成 定金 + 尾款（用户要的）。
      两个都没填就不动价格。原来已有不同价格时，**提示里把旧值一并报出来**，
      免得用户以为价格被悄悄改了查不到。
   ③ **手办「比例」**：新字段 `比例`（`t:'pick'` 可选可输，预设 1/4…1/144 + 无比例），
      带 `onlyCat:'手办'` —— **只有大类是手办才出现**。
      显隐靠切 `.is-hidden`（`wireFormControls` 里监听大类的 change 直接改类），
      **不重绘表单**：字段列表在打开表单时就定死了，重绘会把用户填一半的东西冲掉。
   ⚠️ 顺手修了 `pick` 类型的一个隐患：原来无条件调 `channelOptionsAll()`，
      加「比例」这种新 pick 字段时会给它灌一整套渠道名 —— 现在按字段区分。
   ⚠️ 动了 app.js **和 style.css**（`.po-num/.po-sum/.catfield`），两个都要推。
   回归：`node tools/test_preorder.mjs`（123 条，含定金/尾款 18 条）+
   `node tools/e2e_preorder_cdp.mjs`（35 条，含"点到货了 → 价格自动 = 定金+尾款"）+
   `node tools/e2e_form_status_cdp.mjs`（23 条，含手办比例的条件显示）。 */
const CACHE = 'lifedesk-v160-2026-10-11';

/* v144（2026-10-04）：修「手机端什么都没动却显示待上传 N 条」。两个独立根因：
   ① **批量编辑不动 `_upd`/`_rev`** —— 改动对增量同步是隐形的：上传时靠内容指纹能发现，
      所以云端更新了；但另一端拉取时看到时间戳一样就不覆盖 → 双端各留一份、永远报待上传，
      还会互相盖。现在 `applyBatchPatch` 只对**内容真的变了**的行打新时间戳（值没变的不打）。
   ② **日期没补零** —— `2026-10-2` 与 `2026-10-02` 是同一日期两个字符串，被当成两份数据。
      新增 `DATE_FIELDS` / `normDateStr` / `normDateFields`：加载、表单保存、内联编辑、批量编辑、
      云端行转本机（`cloudRowToLocal`，合并与指纹台账共用）全部统一成 `YYYY-MM-DD`。
   另外 `mergeLoadData` 的冲突裁决由「平手本机赢」改成 **平手云端赢** ——
   云端是共享真相，这样拉取后本机即与云端一致，「待上传」能自己归零。
   ⚠️ 仅动 app.js，SW 行为未变，bump 只为让手机端装上新版本。 */

/* v96m：图片单独放一个「不随版本清理」的缓存桶。
   以前图片和代码共用 CACHE，每次部署 bump 版本号，activate 会把图片一起删光，
   于是离线封面全部失效、出门没网又得重新下载一遍所有图。现在代码随便升级，图片缓存不受影响。 */
const IMG_CACHE = 'lifedesk-imgs-v1';

// 只缓存已知存在的、必须的子资源（白名单）。绝不强制 addAll 整个列表
// （之前 v5 因为引用了 4 个 404 文件导致整个 install 失败、SW 永远装不上）
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',                /* 直接缓存源文件（本地优先，编辑即生效） */
  /* v95：three.min.js 已从预缓存移除——它改由 ensureEarthAssets() 进入遐方坞时按需加载，
     这里若预缓存，装 SW 时会白下 593KB，抵消首屏瘦身的收益。首次按需加载时仍会被 fetch 处理器缓存。 */
  './marker-icons.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './images/pin-visited.png',
  './images/sprout-wish.png',
  // 3D 模型文件较大，由 fetch handler 按需懒缓存，不预下载
];

// 关键资源：后台更新且内容变化时，通知页面静默刷新一次
const CRITICAL = /\/(?:app\.min\.js|app\.js|style\.css)(?:[?#]|$)/;

// v95：图片一律走 cache-first（本地优先）。
// 原因：封面是不可变的，原来也走 SWR，导致每次访问都把看过的图整份重下一次
// （平均 102KB × 上千张），这正是"缓存了但还是慢"的根因。
const IMG_RE = /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i;

/* 2026-09-24：封面搬到 Cloudflare R2（https://<项目>.pages.dev/api/img/...）之后，
   图片请求变成【跨域】。以前 fetch 处理器对跨域一律 `return` 放行 → SW 完全不缓存
   → 出门没网时封面全白，「离线看封面」这个核心体验直接坏掉。
   所以跨域也要拦 —— 但【只拦封面这一个路径】，其余跨域请求
   （/api/sync、/api/isbn、高德地图瓦片…）照旧放行，SW 绝不掺和业务接口。 */
const CLOUD_IMG_RE = /^\/api\/img\//;

function cacheAdd(cache, u) {
  return cache.add(new Request(u, { cache: 'no-cache' })).catch(() => null);
}

self.addEventListener('install', (event) => {
  // 单文件失败不阻断 install（关键：之前 v5 的死循环就是被这一步卡死的）
  /* v96o：不再自动 skipWaiting —— 否则新 SW 一装好就抢走控制权，用户没机会「手动」决定何时更新。
     现在新 SW 装好后停在 waiting 状态，由同步设置里的「抓取最新版本」按钮发 SKIP_WAITING 才接管。
     注：首次安装（没有旧 SW 在控）仍会自动激活，因为 activate 里 self.clients.claim() 会立即认领页面。 */
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE_URLS.map((u) => cacheAdd(cache, u)))
    )
  );
});

self.addEventListener('activate', (event) => {
  // 只清自己版本的旧缓存，不动其他 SW 的数据
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          /* v96m：排除 IMG_CACHE —— 升级代码版本时保留离线图片 */
          .filter((k) => k.startsWith('lifedesk-') && k !== CACHE && k !== IMG_CACHE)
          .map((k) => caches.delete(k).catch(() => null))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只处理 GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* 跨域：只接管 Cloudflare R2 上的封面（见 CLOUD_IMG_RE 注释），其余一律放行。
     放行是刻意的 —— /api/sync 这些业务接口必须让浏览器直接跟服务端说话，
     SW 一旦缓存它们，就会出现「明明同步过了还是旧数据」这种最难查的问题。 */
  if (url.origin !== self.location.origin) {
    if (CLOUD_IMG_RE.test(url.pathname)) event.respondWith(cacheFirst(req));
    return;
  }

  // 导航请求（HTML）：网络优先 → 离线时给上次缓存的 index.html
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // v95：图片本地优先——命中缓存直接返回，完全不发网络请求（离线也能看）
  if (IMG_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 子资源：stale-while-revalidate（命中缓存立即返回，后台静默更新）
  event.respondWith(staleWhileRevalidate(req, url));
});

// v95：图片专用——有缓存就用缓存，绝不回源；没缓存才下载并写入缓存
async function cacheFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  /* v96m：兼容旧版——升级前图片存在主 CACHE 里，先回退查一次并顺手搬进 IMG_CACHE，
     避免用户升级后「离线封面全没了」又要重下一次。 */
  try {
    const old = await caches.match(req);
    if (old) { cache.put(req, old.clone()).catch(() => null); return old; }
  } catch (e) {}
  try {
    const resp = await fetch(req);
    /* v96m：同源图 resp.type 是 'basic'；R2 上的封面是跨域但带 CORS 头的，type 是 'cors'。
       两种都得能存，否则搬到 R2 之后离线封面就全没了。
       'opaque'（跨域且没有 CORS 头）状态码读不到、内容也没法校验，坚决不存。 */
    if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
      await cache.put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    // 离线且没缓存：给一个空响应，不让单个图片把页面卡死
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function networkFirstHTML(req) {
  try {
    const resp = await fetch(req, { cache: 'no-store' });
    if (resp && resp.status === 200) {
      const clone = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => null);
    }
    return resp;
  } catch (e) {
    // 离线/网络挂了：返回缓存里的 index.html（绝不是空白响应）
    const c = await caches.match('./index.html');
    return c || new Response('<h1>离线</h1><p>请重新联网打开</p>', { headers: { 'Content-Type': 'text/html' } });
  }
}

async function staleWhileRevalidate(req, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const isCritical = CRITICAL.test(url.pathname);

  // 缓存里的签名（ETag 优先，没有就用 Last-Modified 兜底）
  const cachedSig = cached
    ? (cached.headers.get('etag') || cached.headers.get('last-modified'))
    : null;

  /* v96m：后台更新改为「条件请求」——带上 If-None-Match / If-Modified-Since。
     服务器回 304 就表示文件没变，此时不下载任何响应体（只有几十字节的头部，几乎零流量），
     直接沿用缓存。改之前是无条件整份重下，几十个数据分片每次都白吃一遍流量，
     这正是"点一次最新就要重新下载所有旧数据"的原因。 */
  const cachedEtag = cached ? cached.headers.get('etag') : null;
  const cachedLM = cached ? cached.headers.get('last-modified') : null;
  const condHeaders = new Headers(req.headers);
  if (cachedEtag) condHeaders.set('If-None-Match', cachedEtag);
  else if (cachedLM) condHeaders.set('If-Modified-Since', cachedLM);

  const network = fetch(new Request(req, { headers: condHeaders }), { cache: 'no-store' })
    .then(async (resp) => {
      if (resp && resp.status === 304 && cached) return cached;   /* 未变化：零流量沿用缓存 */
      if (resp && resp.status === 200 && resp.type === 'basic') {
        await cache.put(req, resp.clone());
        if (isCritical) {
          const newSig = resp.headers.get('etag') || resp.headers.get('last-modified');
          if (cachedSig && newSig && cachedSig !== newSig) {
            notifyUpdate(url.pathname);
          }
        }
      }
      return resp;
    })
    .catch(() => cached);

  // 有缓存就立即返回缓存（秒开），没有才等网络
  return cached || network;
}

// 整个 SW 生命周期内至多通知一次，避免部署后反复重载
let _notified = false;
function notifyUpdate(path) {
  if (_notified) return;
  _notified = true;
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => c.postMessage({ type: 'SUBRES_UPDATED', url: path }));
  });
}

/* v60：页面端「获取最新数据」按钮发来的清空指令——把本 SW 名下的所有缓存删掉，
   确保下一次网络请求一定能拉到服务器上的最新文件（app.min.js / data/*.json 等）。 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PURGE_CACHES') {
    event.waitUntil(
      /* v96m：保留 IMG_CACHE —— 点「最新」只想刷代码和数据，不该把辛辛苦苦离线好的封面删掉 */
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== IMG_CACHE).map((k) => caches.delete(k).catch(() => null))
        )
      ).then(() => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true });
        }
      })
    );
  } else if (data.type === 'SKIP_WAITING') {
    /* v96o：手动更新按钮发来的「接管」指令 —— 让停在 waiting 的新 SW 立即激活，
       接管现有页面，随后页面侧会 reload 拉取新代码。 */
    event.waitUntil(
      self.skipWaiting().then(() => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'ACK' });
      })
    );
  }
});
