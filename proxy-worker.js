/*
 * life-desk 书籍查源代理（Cloudflare Workers）
 * ───────────────────────────────────────────────
 * 用途：让 life-desk 的「书籍录入」能从 豆瓣 / 京东 拿到元数据 + 封面。
 *
 * 为什么需要它？
 *   豆瓣 / 京东 都不发 CORS 头，浏览器 JS 直接 fetch 读不到；而且 r.jina.ai 这类
 *   纯文本代理会把封面图剥掉、京东还是 JS 渲染的反爬墙。这个 Worker 原样把网页
 *   返回（带 CORS 头），life-desk 就能用已有的解析器拿到书名/作者/出版社/封面。
 *
 * 两种模式：
 *   ① 默认（免费，无需额外绑定）：直接 fetch 目标页返回 HTML。
 *      → 豆瓣 ISBN 页是服务端渲染的，封面图(#mainpic img)直接拿到。
 *   ② ?js=1（需要 Cloudflare Browser Rendering 绑定，付费 add-on）：
 *      用无头浏览器把页面跑出来再返回，能破京东的 JS 验证墙 → 京东封面/元数据可用。
 *      未配置 browser 绑定时自动回退到模式①。
 *
 * 部署：
 *   1) 在 Cloudflare 建一个 Worker，把本文件粘进去并部署，拿到 https://xxx.workers.dev
 *   2) life-desk 里 「⚙ 同步设置 → 书籍代理」填：
 *        https://xxx.workers.dev/?url=
 *      （结尾的 ?url= 一定要带，app.js 会把目标网址拼在后面）
 *   3) 想要京东封面时，在 Worker 设置里加一个 Browser Rendering 绑定（命名 MYBROWSER），
 *      并把代理改成 https://xxx.workers.dev/?url=&js=1
 *
 * 安全：只做透明转发，不缓存、不落盘；建议给 Worker 加个自定义域名 + 访问控制，
 *      避免被当成公共代理滥用（可选）。
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let target = url.searchParams.get('url');
    if (!target) {
      // 路径模式：https://worker.dev/https://book.douban.com/...
      const p = decodeURIComponent(url.pathname.slice(1));
      if (/^https?:\/\//.test(p)) target = p;
    }
    if (!target || !/^https?:\/\//.test(target)) {
      return new Response('missing ?url= target', { status: 400 });
    }

    const useJS = url.searchParams.get('js') === '1' && env.MYBROWSER;

    try {
      let body, contentType = 'text/html; charset=utf-8';
      if (useJS) {
        const browser = await env.MYBROWSER.launch();
        const page = await browser.newPage();
        await page.goto(target, { waitUntil: 'networkidle', timeout: 20000 });
        body = await page.content();
        await browser.close();
      } else {
        const r = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          redirect: 'follow'
        });
        contentType = r.headers.get('content-type') || contentType;
        body = await r.text();
      }

      const headers = new Headers();
      headers.set('content-type', contentType);
      headers.set('access-control-allow-origin', '*');
      headers.set('cache-control', 'no-store');
      // 去掉可能拦截前端解析/嵌入的响应头
      return new Response(body, { status: 200, headers });
    } catch (e) {
      return new Response('proxy error: ' + (e && e.message ? e.message : e), { status: 502 });
    }
  }
};
