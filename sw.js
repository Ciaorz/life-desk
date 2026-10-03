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
const CACHE = 'lifedesk-v137-2026-10-04';

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
