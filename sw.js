// 离线壳。这份 SW 的**唯一**缓存策略是「代码永远先问网络」，位图才许 cache-first。
//
// 为什么不是常见的 cache-first 壳：手工版本号 + cache-first 会把 js/ 与 css/ 钉死在
// 装机那一次的版本上——发一版新 HTML 配旧 JS，玩家看到的是「界面是新的、逻辑是旧的」
// 这种最难查的鬼状态（本组合其它仓踩过）。产品是零构建的一堆 ES 模块，没有内容哈希
// 文件名可用，所以正确做法只有一条：**同源子资源网络优先，失败才退缓存**。
// 位图（icons/ 与 assets/img/）例外：它们由 assets/gen/make_art.py 从色板派生，
// 重画一次字节就变，而变了的字节要靠下面的 VERSION 换名来清——那是缓存的有效期，
// 不是代码的锁。
//
// VERSION 只在「位图集合变了」的时候才需要动。js/css 改了不用动它：网络优先，
// 拿到什么算什么，拿不到（离线）才用旧的那份继续玩。
const VERSION = 'kenken-v1.0.0-1';
const BITMAP_CACHE = VERSION + '-bitmaps';
const CODE_CACHE = VERSION + '-code';

// 装机的位图清单和 index.html 引用的路径必须逐字相同——写错一条就是装完离线打开时少张图。
const BITMAPS = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/favicon-16.png',
  'icons/og.png',
  'assets/img/grain.png',
  'assets/img/cage-motif.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(BITMAP_CACHE)
      .then((cache) => cache.addAll(BITMAPS))
      .catch(() => {}) // 断网装机不是失败：离线可用面小一点，等第一次联网再补
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // 旧 VERSION 的缓存整串删掉：留着就是磁盘上永远清不掉的上一版图。
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => url.origin === self.location.origin;
const isBitmap = (p) => /\.(png|jpg|jpeg|webp|svg|ico)$/.test(p);
const isCode = (p) => /\.(js|mjs|cjs|css|html|webmanifest|json)$/.test(p);

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const stale = await cache.match(req);
    if (stale) return stale;
    // 导航请求离线且没缓存过这一页：给壳，别让地址栏变成一张错误页。
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./')) || (await cache.match('index.html'));
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!sameOrigin(url)) return; // 本仓零第三方资源；跨源的请求一律不管
  const path = url.pathname;
  if (isBitmap(path)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && res.ok) caches.open(BITMAP_CACHE).then((c) => c.put(req, res.clone()));
            return res;
          })
      )
    );
    return;
  }
  if (isCode(path) || req.mode === 'navigate') {
    event.respondWith(networkFirst(req, CODE_CACHE));
  }
});
