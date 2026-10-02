// 离线壳。口径只有一条：**同源 GET 一律网络优先，网络不行才退缓存**。
//
// 为什么不用 cache-first + 手工 VERSION 号：那会把 js/css 永久钉死在第一次装上的那一版，
// 发新 HTML 配旧 JS 的鬼状态就是这么来的（本组合别的仓踩过）。VERSION 在这里只当
// **缓存名的标签**用（改了核心清单能一眼看出该清哪一份），不是失效策略。
//
// 路径全部经 new URL(path, self.location) 换算：本文件既要在仓库根 /sw.js 下跑，也要在
// GitHub Pages 的 /z-biz-game-triplets-cos/sw.js 前缀下跑，写死 "/" 在第二种形状下必 404。
//
// 注册方在 index.html 的内联 <script> 里，且只在安全上下文注册（https 或 localhost）；
// file:// 下整段跳过且不抛未捕获异常。
const VERSION = 'v0.2.0-1';
const CORE = 'triplets-core-' + VERSION;
const RUNTIME = 'triplets-runtime-' + VERSION;

const CORE_ASSETS = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/sfx.js',
  './js/fx.js',
  './js/ui/game.js',
  './js/render/board.js',
  './js/engine/rng.js',
  './js/engine/grid.js',
  './js/engine/pencil.js',
  './js/engine/generate.js',
  './js/engine/partition.js',
  './js/engine/counter.js',
  './manifest.webmanifest',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/icon-96.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './assets/textures/grain-256.png',
  './assets/img/triad-sprite.png',
];

const urlOf = (p) => new URL(p, self.location).href;
const sameOriginGet = (req) => {
  if (req.method !== 'GET') return false;
  try {
    return new URL(req.url).origin === self.location.origin;
  } catch {
    return false;
  }
};

self.addEventListener('install', (ev) => {
  // 预缓存失败不许把安装拖红（离线壳是增益，不是开局前置条件）
  ev.waitUntil(
    caches.open(CORE)
      .then((c) => Promise.allSettled(CORE_ASSETS.map((p) => c.add(urlOf(p)))))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (!sameOriginGet(req)) return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  ev.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(req, { cache: 'reload' });
    if (fresh && fresh.ok && fresh.type !== 'opaque') cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // 导航请求离线时退回缓存里那份 index.html：装过的壳断网也能开新的一局
    if (req.mode === 'navigate') {
      const shell = await cache.match(urlOf('./')) || (await caches.match(urlOf('./')));
      if (shell) return shell;
    }
    throw err;
  }
}
