/* ============================================================================
 * taobao_grab_urls.js —— 把当前商品页上所有图片地址收集成一份清单
 * ----------------------------------------------------------------------------
 * 用法（推荐，正好配合你现在打开的 DevTools）：
 *   1. Chrome 里打开商品页 → F12 → 「源代码/来源」面板 → 左侧「代码段 Snippets」
 *   2. 新建一个代码段，把本文件全部内容粘进去 → Ctrl+Enter 运行
 *   3. 控制台会打印统计，并把清单**复制到剪贴板**（也可以从 window.__IMG_URLS 里取）
 *   4. 把清单粘到一个文本文件里（如 urls.txt），再跑：
 *        python tools/fetch_images.py urls.txt
 *
 * 它收集什么：
 *   · performance 里记录的所有资源（页面加载过的图片，含不在 DOM 里的）
 *   · <img src/srcset>、<source srcset>、<link rel=preload as=image>
 *   · 内联样式里的 background-image
 *   只保留图片类地址（alicdn / alibaba / taobao / tmall 等域名 + 常见图片后缀）。
 *
 * 顺序说明：采集结果是**按图片在页面上的出现顺序**（不排序）——
 *   商品详情图往往就是按顺序排的（如整套徽章图按图鉴号），
 *   配合 `python tools/fetch_images.py urls.txt --numbers` 会存成 0001-、0002-… 便于按号码对应。
 *
 * 可调项（改这两行即可）：
 *   ONLY_HOST —— 只收这些域名（留空数组 = 不限）
 *   DROP_DUP_WEBP —— true 时，同一张图的 `x.jpg` 与 `x.jpg_webp` 只留 WebP 版
 * ==========================================================================*/
(function () {
  var ONLY_HOST = ['alicdn.com', 'alibaba.com', 'taobao.com', 'tmall.com'];
  var DROP_DUP_WEBP = true;

  var IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)(_[a-z0-9]+)?(\.(jpe?g|png|webp))?$/i;
  var seen = Object.create(null);
  var out = [];

  function hostOk(u) {
    if (!ONLY_HOST.length) return true;
    var m = /^https?:\/\/([^\/]+)/i.exec(u);
    if (!m) return false;
    var h = m[1].toLowerCase();
    return ONLY_HOST.some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
  }
  function isImg(u) {
    if (!/^https?:\/\//i.test(u)) return false;
    if (/\.svgz?($|\?)/i.test(u)) return false;          // SVG 一般是图标，不要
    if (/\.(js|css|json|woff2?|ttf|mp4)($|\?)/i.test(u)) return false;
    return IMG_EXT.test(u.split('?')[0]) || /_(webp|\d+x\d+)(\.|$)/i.test(u);
  }
  function add(u) {
    if (!u) return;
    u = String(u).trim().replace(/&amp;/g, '&');
    if (u.slice(0, 2) === '//') u = location.protocol + u;
    u = u.split('#')[0];
    if (!isImg(u) || !hostOk(u)) return;
    var key = u.split('?')[0];                            // 去查询串去重（尺寸类查询串不影响内容）
    if (seen[key]) return;
    seen[key] = 1;
    out.push(u);
  }

  /* ① 先按「页面上出现的顺序」收 DOM 里的图 —— 顺序是有意义的：
        商品详情图通常就是按顺序排的（例如整套徽章图按图鉴号），
        保留下这个顺序，下载时加 --numbers 就能变成 0001-、0002-… 直接对上号码 */
  try {
    document.querySelectorAll('img').forEach(function (im) {
      add(im.currentSrc); add(im.src); add(im.getAttribute('data-src')); add(im.getAttribute('data-ks-lazyload'));
      (im.getAttribute('srcset') || '').split(',').forEach(function (p) { add(p.trim().split(/\s+/)[0]); });
    });
    document.querySelectorAll('source').forEach(function (s) {
      (s.getAttribute('srcset') || '').split(',').forEach(function (p) { add(p.trim().split(/\s+/)[0]); });
    });
    document.querySelectorAll('link[rel="preload"][as="image"],link[rel="prefetch"]').forEach(function (l) {
      add(l.getAttribute('href'));
    });
  } catch (e) {}

  /* ② 内联样式里的 background-image */
  try {
    document.querySelectorAll('[style*="url("]').forEach(function (el) {
      var m = /url\((['"]?)(.*?)\1\)/gi, r;
      while ((r = m.exec(el.getAttribute('style') || ''))) add(r[2]);
    });
  } catch (e) {}

  /* ③ 最后补上「页面加载过、但不在 DOM 里」的图（懒加载已经取过来、或已滚出视口的） */
  try {
    performance.getEntriesByType('resource').forEach(function (e) { add(e.name); });
  } catch (e) {}

  /* ④ 同一张图既有 .jpg 又有 .jpg_webp 时，只留 WebP（体积更小、清晰度一样） */
  if (DROP_DUP_WEBP) {
    var hasWebp = Object.create(null);
    out.forEach(function (u) { if (/_webp$/i.test(u)) hasWebp[u.replace(/_webp$/i, '')] = 1; });
    out = out.filter(function (u) { return !(!/_webp$/i.test(u) && hasWebp[u]); });
  }

  /* 刻意不排序：保留页面上的出现顺序（详情图通常是按顺序排的） */
  var dirs = Object.create(null);
  out.forEach(function (u) {
    var d = u.replace(/^https?:\/\/[^\/]+\//, '').split('/').slice(0, -1).join('/');
    dirs[d] = (dirs[d] || 0) + 1;
  });

  console.log('%c共收集到 ' + out.length + ' 张图片', 'font-size:14px;font-weight:700;color:#1a7f37');
  Object.keys(dirs).sort(function (a, b) { return dirs[b] - dirs[a]; }).slice(0, 10).forEach(function (d) {
    console.log('   ' + String(dirs[d]).padStart(4) + ' 张  ' + d);
  });
  try { copy(out.join('\n')); console.log('%c已复制到剪贴板 ✓  直接粘到 urls.txt 即可',
        'color:#1a7f37;font-weight:700'); }
  catch (e) { console.log('剪贴板复制不可用，请从下面的 JSON 里取：'); }
  console.log('\n---- 清单（JSON，可直接整段复制保存成 urls.json）----\n' + JSON.stringify(out));
  window.__IMG_URLS = out;
  return out.length;
})();
