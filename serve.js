#!/usr/bin/env node
/* serve.js — 生活后台「本地文件模式」服务器
 * 作用：
 *   1) 静态托管本目录（clean/）下的所有文件；
 *   2) GET  /__localfs            -> 返回 200，供前端探测「本地文件模式」是否可用；
 *   3) GET  /data/lifedesk.json  -> 读并返回（不存在则返回 {}）；
 *   4) POST /data/lifedesk.json  -> 把请求体覆盖写入该文件（数据全部存本地 data 文件夹）。
 *
 * 用法（在 clean 目录下）：
 *   node serve.js
 *   然后浏览器打开 http://localhost:8080
 *   停止：Ctrl + C
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(ROOT, 'data', 'lifedesk.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico':  'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf':  'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, body, type){
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(function(req, res){
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  /* 1) 本地文件模式探测 */
  if (req.method === 'GET' && pathname === '/__localfs'){ return send(res, 200, 'ok'); }

  /* 2) 读取 data/lifedesk.json */
  if (req.method === 'GET' && pathname === '/data/lifedesk.json'){
    fs.readFile(DATA_FILE, 'utf8', function(err, data){
      if (err){ return send(res, 200, '{}', MIME['.json']); }
      send(res, 200, data, MIME['.json']);
    });
    return;
  }

  /* 3) 写入 data/lifedesk.json（覆盖） */
  if (req.method === 'POST' && pathname === '/data/lifedesk.json'){
    let buf = '';
    req.on('data', function(c){ buf += c; if (buf.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', function(){
      fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, function(){
        fs.writeFile(DATA_FILE, buf, 'utf8', function(err){
          if (err) return send(res, 500, 'write error: ' + err.message);
          send(res, 200, 'ok');
        });
      });
    });
    return;
  }

  /* 4) 静态文件托管（防目录穿越） */
  const resolved = path.resolve(ROOT, '.' + pathname);
  if (resolved !== ROOT && path.relative(ROOT, resolved).startsWith('..')){
    return send(res, 403, 'Forbidden');
  }
  let filePath = resolved;
  if (pathname === '/' || pathname === '') filePath = path.join(ROOT, 'index.html');
  fs.stat(filePath, function(err, st){
    if (err || !st.isFile()){
      const idx = path.join(ROOT, 'index.html');
      if (fs.existsSync(idx)){
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return fs.createReadStream(idx).pipe(res);
      }
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, function(){
  console.log('生活后台本地服务器已启动： http://localhost:' + PORT);
  console.log('数据保存在： ' + DATA_FILE);
  console.log('按 Ctrl+C 停止。');
});
