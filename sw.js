/* JAVPACO Service Worker：只管静态壳，媒体与 API 一律直连（不缓存视频/封面/数据接口） */
const CACHE = 'javpaco-shell-v1'
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
  /* 其它（页面壳 / 图标 / manifest）：网络优先，失败回缓存 */
  e.respondWith(
    fetch(e.request).then(r => {
      if (r && r.ok && p.startsWith('/icon')) {
        const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {})
      }
      return r
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
  )
})
