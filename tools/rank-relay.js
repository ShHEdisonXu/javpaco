#!/usr/bin/env node
/* minnano 云端中转（GitHub Actions 内运行，机房直连无墙）：
 * 1. 抓日/周/月女优榜 → relay/rankings.json（原始行 rank/id/name/works）
 * 2. 抓榜上女优资料页头像 → relay/avatars/<mnid>.jpg（已存在则跳过）
 * 服务端（server.js）在 minnano 直连失败时改从 raw.githubusercontent.com 读这两样。
 * 无第三方依赖，Node 18+ 自带 fetch。 */
const fs = require('fs')
const path = require('path')

const MN_BASE = 'https://www.minnano-av.com/'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const RELAY_DIR = path.join(__dirname, '..', 'relay')
const AVA_DIR = path.join(RELAY_DIR, 'avatars')
const AVA_LIMIT = 160            // 榜上去重后最多抓多少个头像
const TIMEOUT = 20000

function mnStrip(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").trim()
}
function parseRankRows(html) {
  const rows = []
  for (const chunk of String(html || '').split('<tr>')) {
    if (!/class="rnkno"/.test(chunk)) continue
    const rank = +((chunk.match(/rnkcnt">(\d+)/) || [])[1] || 0)
    const id = (chunk.match(/actress(\d+)\.html/) || [])[1]
    const name = mnStrip((chunk.match(/<h2 class="ttl"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
    const works = +((chunk.match(/<td>\s*(\d{1,6})\s*<\/td>/) || [])[1] || 0)
    if (rank && id && name) rows.push({ rank, id, name, works })
  }
  return rows
}
async function get(url, binary) {
  const rs = await fetch(url, {
    headers: { 'user-agent': UA, referer: MN_BASE, accept: binary ? 'image/jpeg,image/png,*/*' : 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!rs.ok) throw new Error('HTTP ' + rs.status + ' ' + url)
  return binary ? Buffer.from(await rs.arrayBuffer()) : await rs.text()
}
const isImg = b => !!(b && b.length > 2048 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)))
const pool = async (items, n, fn) => {   // 简易并发池
  const out = []; let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k) } catch (_) { out[k] = null } }
  }))
  return out
}

;(async () => {
  fs.mkdirSync(AVA_DIR, { recursive: true })
  const modes = [['day', 'ranking_actress.php?daily'], ['week', 'ranking_actress.php'], ['month', 'ranking_actress.php?monthly']]
  const out = { fetchedAt: Date.now() }
  const ids = new Set()
  for (const [key, q] of modes) {
    const html = await get(MN_BASE + q)
    const rows = parseRankRows(html)
    if (!rows.length) throw new Error('榜单解析为空：' + q)
    out[key] = rows
    for (const r of rows) ids.add(r.id)
    console.log(key + ' 榜：' + rows.length + ' 条')
  }
  const list = [...ids].slice(0, AVA_LIMIT)
  let ok = 0, skip = 0
  await pool(list, 4, async id => {
    const f = path.join(AVA_DIR, id + '.jpg')
    if (fs.existsSync(f) && fs.statSync(f).size > 2048) { skip++; return }
    const html = await get(MN_BASE + 'actress' + id + '.html')
    const img = (html.match(/property="og:image" content="([^"]+)"/) || html.match(/<img[^>]+class="[^"]*actress[^"]*"[^>]+src="([^"]+)"/) || [])[1]
    if (!img) return
    const b = await get(img.startsWith('http') ? img : MN_BASE.replace(/\/$/, '') + img, true).catch(() => null)
    if (isImg(b)) { fs.writeFileSync(f, b); ok++ }
  })
  console.log('头像：新抓 ' + ok + '，已存在 ' + skip + '，共 ' + list.length + ' 个')
  const tmp = path.join(RELAY_DIR, 'rankings.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(out))
  fs.renameSync(tmp, path.join(RELAY_DIR, 'rankings.json'))
  console.log('relay/rankings.json 已生成')
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
