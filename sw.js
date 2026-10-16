/* JAVPACO Service Worker：只管静态壳，媒体与 API 一律直连（不缓存视频/封面/数据接口）
 * ⚠ 2026-10-16 v2：修「App 升级后页面一直是旧版」——
 *   v1 的缓存里那份 '/' 是**安装当天**的 index.html，且成功加载时从不回写（只有图标回写），
 *   网络优先只在「取新失败」时回退 —— 一旦服务端没就绪（App 刚启动那几秒），用户拿到的就是
 *   几周前的老页面，而且 sw.js 字节不变就永远不会重装，老缓存永远清不掉。
 *   v2 的修法：① 缓存名升到 v2（激活时自动删 v1）；② '/' 等壳资源**每次成功加载都回写缓存**，
 *   这样回退副本最多只旧一次加载，不可能再出现「永远停在老页面」。 */
const CACHE = 'javpaco-shell-v2'
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
]
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  const p = url.pathname
  /* 视频 / 封面 / 数据接口 / 字幕 → 永不拦截（进度条拖动与数据新鲜度优先） */
  if (p.startsWith('/media/') || p.startsWith('/covers/') || p.startsWith('/actresses/') ||
      p.startsWith('/cache/') || p.startsWith('/api/') || p === '/data.json' || p === '/actresses.json') return
  /* 页面壳 / 图标 / manifest：网络优先，**成功即回写缓存**（v1 只回写图标，导致回退副本永久陈旧），
   * 失败才回缓存 —— 回退副本最多旧一次加载 */
  e.respondWith(
    fetch(e.request).then(r => {
      if (r && r.ok) {
        const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {})
      }
      return r
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
  )
})
