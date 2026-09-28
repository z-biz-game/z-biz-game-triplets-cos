#!/usr/bin/env node
// 零依赖静态服务器。刻意用 CommonJS：package.json 里是 "type": "module"，
// 这样 `node --check` 会把 js/ 下的浏览器源码当 ES 模块解析，而本文件仍然能被
// Electron（如果第三阶段接上）和 tools/verify.sh require。
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(root = __dirname) {
  const serve = (file, res) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // 不缓存：harness 会在两个 scenario 之间重载页面，一次 304 就能把刚改的字节
        // 伪装成「没发出去」；玩家手改本地 css/ 时看到的也是同一份假象。
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  };
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    // URL 路径**直接映射**到 root，不替「/z-biz-game-triplets-cos/...」这种前缀兜底：
    // GitHub Pages 就是把部署目录挂在 /<仓库名>/ 下面，页面里但凡有一个写死的
    // href="/css/game.css"，线上就 404。本地要是顺手把前缀吃掉，tools/verify.sh 那段前缀
    // 冒烟就会永远绿着——那等于门禁在给自己替被测对象打的补丁做见证。
    const wanted = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
    const file = path.join(root, path.normalize(wanted).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    serve(file, res);
  });
}

// 5278：本仓在 z-biz-game 端口表里占的那一号（HTTP 5278 / CDP 9378 是一对，
// 5276 是 masyu、5277 是 slither）。挑一个每仓专属的固定号，是为了不让一个忘关的
// 别的仓的服务器被当成本仓的盘面来测。这个数在本文件里只写一次（DEFAULT_PORT），
// package.json 的 dev 脚本和 tools/verify.sh 的默认值必须是同一个数——三处任何一个漂移，
// 门禁就会在别人家的 DOM 上变绿。
const DEFAULT_PORT = 5278;

function startServer({ port = DEFAULT_PORT, root = __dirname } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer, DEFAULT_PORT };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || DEFAULT_PORT;
  // 第二个参数是根目录：tools/verify.sh 用它跑一次「带 /z-biz-game-triplets-cos/ 前缀」的
  // Pages 形状冒烟测试，而不用另开一个端口号。
  const root = process.argv[3] ? path.resolve(process.argv[3]) : __dirname;
  startServer({ port, root })
    .then((server) => {
      console.log(`同或异 Triplets served at http://127.0.0.1:${port}/  root=${root}  (ctrl+c to stop)`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
