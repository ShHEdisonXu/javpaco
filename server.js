#!/usr/bin/env node
/**
 * JAVPACO 迷你媒体服务（零依赖，Emby 同款模式的极简版）
 *
 * 用法：node server.js <媒体文件夹路径> [端口]
 *   例：node server.js ~/Movies 8090
 *
 * 做的事：
 *   1. 扫描媒体文件夹里的视频（递归），按目录匹配封面图（fanart/thumb/poster/cover
 *      关键词 → 没有则按图片横竖比例自动分配）和 Kodi 格式 NFO 元数据
 *   2. 生成 data.json 供前端读取
 *   3. 提供静态服务：本 UI、视频（支持 Range 拖动进度条）、封面图
 *
 * 浏览器打开 http://localhost:8090 即可。
 */
const http = require('http')
const https = require('https')
const tls = require('tls')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')
const { execFile } = require('child_process')
/* mdc-ng 规则引擎：规则逐字取自已解包的 mdc-ng v1.36.0 内嵌 provider YAML（rules/mdc-ng/）*/
const MDCNG = require('./mdcng')

/* 解析媒体目录：命令行参数 > media-path.txt > ~/Movies > ./media */
function readMediaPathFile() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'media-path.txt'), 'utf8').split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (line && !line.startsWith('#')) return path.resolve(line.replace(/^~/, os.homedir()))
    }
  } catch (_) {}
  return null
}
function resolveMediaRoot() {
  if (process.argv[2]) return path.resolve(process.argv[2])
  const fromFile = readMediaPathFile()
  if (fromFile) return fromFile
  const homeMovies = path.join(os.homedir(), 'Movies')
  if (fs.existsSync(homeMovies)) return homeMovies
  return path.join(__dirname, 'media')
}
const MEDIA_ROOT = resolveMediaRoot()
const PORT = parseInt(process.argv[3] || process.env.PORT || '8090', 10)
const UI_ROOT = __dirname

/* 容器里实际挂进来的目录（读 /proc/self/mountinfo）。容器是隔离的：只看得见挂载进来的目录，
 * 本机路径（如 /Users/xxx/...）在容器内根本不存在。用于「导入视频整理」的报错提示与前端展示。 */
function containerMounts() {
  const out = []
  try {
    for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const mp = (line.split(' ')[4] || '').trim()
      if (!mp || mp === '/' || mp === UI_ROOT) continue
      if (/^\/(proc|sys|dev|etc)(\/|$)/.test(mp)) continue
      if (!out.includes(mp)) out.push(mp)
    }
  } catch (_) {}
  return out.length ? out : [MEDIA_ROOT]
}
const mountTip = () => '只能整理已挂载进容器的目录（当前可见：' + containerMounts().join('、') +
  '）内的文件夹。容器看不见本机路径，要整理别处的文件夹，请在 docker-compose.yml 里加一行映射到 ' +
  MEDIA_ROOT + '/子目录（如 ' + MEDIA_ROOT + '/测试），然后重建容器'

/* ---------- 全局配置（server-config.json：代理 + 媒体库列表，Emby 式管理） ----------
 * 挂载点只是访问权限，与 Emby 一样：不添加媒体文件夹就不扫描、没有媒体库。
 * 列表完全由设置页添加/移除驱动，落盘 libraries 字段（可为空数组）。 */
const CFG_FILE = path.join(UI_ROOT, 'server-config.json')
let CFG = (() => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch (_) { return {} } })()
let LIBS = Array.isArray(CFG.libraries) ? CFG.libraries.map(s => path.resolve(String(s))) : []
function writeCfg() {
  const out = Object.assign({}, CFG, { libraries: LIBS })
  const t = CFG_FILE + '.tmp'
  fs.writeFileSync(t, JSON.stringify(out, null, 2))
  fs.renameSync(t, CFG_FILE)
}
/* 线上刮削缓存根目录（设置页可改）：cache/movies/<番号>/meta.json · cache/actors/*.jpg */
/* 缓存根目录定位：
 * 1) CFG.cacheDir（设置里手动指定）优先；
 * 2) 镜像里通过 JP_CACHE 指定「离线数据文件夹」挂载点 → 缓存自动建在其下 cache/ 子目录
 *    （用户挂载任意文件夹到 /app/cache，无需自己先建 cache 文件夹，应用自动创建）；
 * 3) 兜底：程序目录下 ./cache（本地源码运行）。 */
function cacheDir() {
  return path.resolve(CFG.cacheDir
    || (process.env.JP_CACHE ? path.join(process.env.JP_CACHE, 'cache') : '')
    || path.join(UI_ROOT, 'cache'))
}

/* ---------- 线上数据源：JavDB 直连（国内线路，不依赖任何中间服务 / 不出海） ----------
 * 上游 = JavDB 移动端 API，鉴权只有一个「应用级签名」，与账号无关：
 *   jdsignature = {unix秒}.{part2}.{md5(秒 + part1)}
 * part1 / part2 是 App 内固定常量，所以本机可以自己签名、直连；线路本身部署在国内，
 * 纯国内网络（不需要代理、不需要出海）即可访问：
 *   线路1 https://apidd.spthgb.com      移动
 *   线路2 https://apidd.czssdgz.com     移动
 *   线路3 https://jdforrepam.com        Cloudflare
 *   图片  https://tp.spfcas.com         腾讯云 CDN
 * 订阅单 / 收藏仍然只存在我们自己的 server-config.json 里。 */
const JDB_P1 = '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa'
const JDB_P2 = 'lpw6vgqzsp'
const JDB_LINES_DEFAULT = ['https://apidd.spthgb.com', 'https://apidd.czssdgz.com', 'https://jdforrepam.com']
const JDB_IMG_DEFAULT = 'https://tp.spfcas.com'
const onlineCfg = () => {
  const o = (CFG.online && typeof CFG.online === 'object') ? CFG.online : {}
  const list = (Array.isArray(o.lines) && o.lines.length ? o.lines : JDB_LINES_DEFAULT)
    .map(s => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean)
  return { enabled: o.enabled !== false, lines: list.length ? list : JDB_LINES_DEFAULT.slice(), img: String(o.img || JDB_IMG_DEFAULT).replace(/\/+$/, '') }
}
/* 应用级签名（与账号无关的固定常量） */
function jdbSign() {
  const ts = Math.floor(Date.now() / 1000)
  return ts + '.' + JDB_P2 + '.' + crypto.createHash('md5').update(String(ts) + JDB_P1).digest('hex')
}
/* 允许本机代理的线上路径前缀（只读白名单，避免被当成开放代理） */
const ONLINE_OK = ['v1', 'v2', 'latest', 'search']
function onlineAllowedPath(rel) {
  let s = String(rel || '').replace(/^\/+/, '')
  if (s.startsWith('api/')) s = s.slice(4)          // 线上返回的 cover_url 形如 /api/image?url=…，这里统一去掉 api/ 前缀
  if (!s || s.includes('..') || s.includes('//')) return ''
  return ONLINE_OK.includes(s.split(/[/?#]/)[0]) ? s : ''
}
let JDB_LINE_OK = ''                                // 上次成功的线路优先复用
async function onlineGet(rel, { timeout = 20000, raw = false, tries = 3 } = {}) {
  const c = onlineCfg()
  if (!c.enabled) throw new Error('线上数据源未启用（设置 → 订阅 里开启）')
  const order = (JDB_LINE_OK && c.lines.includes(JDB_LINE_OK))
    ? [JDB_LINE_OK].concat(c.lines.filter(x => x !== JDB_LINE_OK)) : c.lines.slice()
  let lastErr = null
  for (const base of order.slice(0, Math.max(1, Math.min(tries, order.length)))) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const r = await fetch(base + '/api/' + String(rel).replace(/^\/+/, ''), {
        signal: ac.signal,
        headers: {
          jdsignature: jdbSign(),
          'User-Agent': 'Dart/3.5 (dart:io)',
          'Accept-Language': 'zh-TW',
          Accept: raw ? '*/*' : 'application/json'
        }
      })
      if (!r.ok) throw new Error('线路 ' + (base.split('//')[1] || base) + ' 返回 ' + r.status)
      if (raw) { const buf = Buffer.from(await r.arrayBuffer()); JDB_LINE_OK = base; return { buf, type: r.headers.get('content-type') || 'application/octet-stream' } }
      const j = await r.json()
      if (j && j.success === 0) throw new Error(j.message || '线上源返回失败')
      JDB_LINE_OK = base
      return j
    } catch (e) { lastErr = e } finally { clearTimeout(timer) }
  }
  throw lastErr || new Error('线上线路均不可用')
}
/* 线上图片直取：接口返回的 cover_url 本身就是 tp.spfcas.com 的完整地址，不需要中间服务 */
const IMG_HOST_OK = /(^|\.)(spfcas\.com|jdbstatic\.com|javdb\d*\.com|dmm\.co\.jp|dmm\.com)$/i
/* 线上图片是加密的：首字节 = 异或密钥，其余每字节 ⊕ 密钥（db_online 的 image_mode: decrypt 同款）。
 * 解开后应为 JPEG/PNG/WebP/GIF，若头部仍是魔法数就原样返回（已解过 / 本就没加密）。 */
function imgMaybeDecrypt(buf) {
  if (!buf || buf.length < 2) return buf
  const magic = buf.length > 12 ? buf.subarray(0, 12) : buf
  const head4 = magic.subarray(0, 4).toString('binary')
  const known = (magic[0] === 0xFF && magic[1] === 0xD8) || head4 === 'RIFF' || head4 === 'GIF8'
    || magic.subarray(0, 8).toString('binary') === '\x89PNG\r\n\x1a\n' || head4 === '\x00\x00\x01\x00' || head4 === 'ftyp'
  if (known) return buf
  const key = buf[0]
  const out = Buffer.allocUnsafe(buf.length - 1)
  for (let i = 1; i < buf.length; i++) out[i - 1] = buf[i] ^ key
  return out
}
async function onlineImageGet(u, { timeout = 20000 } = {}) {
  let raw = String(u || '').trim()
  if (raw.startsWith('/api/image?') || raw.startsWith('api/image?')) {   // 兼容 /api/image?url=xxx 旧格式
    const qs = raw.slice(raw.indexOf('?') + 1)
    try { raw = new URLSearchParams(qs).get('url') || '' } catch (_) { raw = '' }
  }
  let url
  try { url = new URL(decodeURIComponent(raw)) } catch (_) { throw new Error('图片地址不合法') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('不允许的图片协议')
  if (!IMG_HOST_OK.test(url.hostname)) throw new Error('不允许的图片来源')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const r = await fetch(url.href, { signal: ac.signal, headers: { 'User-Agent': 'Dart/3.5 (dart:io)', Referer: url.origin + '/' } })
    if (!r.ok) throw new Error('图片源返回 ' + r.status)
    let buf = Buffer.from(await r.arrayBuffer())
    buf = imgMaybeDecrypt(buf)
    return { buf, type: r.headers.get('content-type') || 'image/jpeg' }
  } finally { clearTimeout(timer) }
}
/* 女优：按名字搜索（线上没有全量名册接口），名字归一化后精确比对，不行就取第一条 */
const onNorm = s => String(s || '').toLowerCase().replace(/[\s\u3000・·,，、/]+/g, '')
async function onlineActorFind(name) {
  const n = onNorm(name)
  if (!n) return null
  const j = await onlineGet('v2/search?q=' + encodeURIComponent(name) + '&type=actor&page=1')
  const list = ((j || {}).data || {}).actors || []
  for (const a of list) {
    const names = [a.name, a.name_zht, a.other_name].filter(Boolean).join(',')
    for (const x of String(names).split(',')) if (x && onNorm(x) === n) return a
  }
  return list[0] || null
}
/* JavDB 线上作为多源刮削的一个源（id = javdb）
 * 不走 HTML，直接用移动端 API（国内直连线路）：封面 / 剧照 / 元数据 / 评分齐全。
 * 很多 HTML 站没有的老番号（尤其 FC2、无码流出）它都有，所以拿它当所有字段的兜底源。 */
async function onlineScrapeSource(code) {
  const q = String(code || '').trim()
  if (!q || !onlineCfg().enabled) return null
  let id = ''
  const terms = [q]
  const fc2 = q.match(/^FC2[-_ ]?(.+)$/i)
  if (fc2) terms.push(fc2[1])                    // FC2 番号线上搜索常要剥掉前缀
  for (const term of terms) {
    const j = await onlineGet('v2/search?q=' + encodeURIComponent(term) + '&type=movie&page=1').catch(() => null)
    const list = ((j || {}).data || {}).movies || []
    const hit = list.find(m => bare(m.number || m.code) === bare(q)) || (list.length === 1 ? list[0] : null)
    if (hit && hit.id) { id = hit.id; break }
  }
  if (!id) return null
  const d = await onlineGet('v2/movies/' + id).catch(() => null)
  const mv = ((d || {}).data || {}).movie || {}
  if (!mv.title) return null
  return {
    sourceId: 'javdb', usedUrl: 'v2/movies/' + id, onlineId: id,
    title: mv.title || '',
    plot: mv.plot || mv.origin_title || '',      // API 不给简介，留空比编造好
    studio: mv.maker_name || '', publisher: mv.publisher_name || '', series: mv.series_name || '',
    director: mv.director_name || '',
    date: mv.release_date || '', runtime: Number(mv.duration) || 0,
    actors: (mv.actors || []).map(a => a.name).filter(Boolean),
    genres: (mv.tags || []).map(t => t.name).filter(Boolean),
    samples: (mv.preview_images || []).map(x => x.large_url || x.thumb_url).filter(Boolean),
    posterCands: [mv.thumb_url, mv.cover_url].filter(Boolean),   // thumb 是竖版（小），cover 是横版大图
    fanartCands: [mv.cover_url].filter(Boolean),
    score: mv.score || '', reviewsCount: Number(mv.reviews_count) || 0,
    wantWatch: Number(mv.want_watch_count) || 0, watched: Number(mv.watched_count) || 0
  }
}
/* 线上影片 → 我们前端的统一形状 */
function onlineMovie(o) {
  const num = String((o && (o.number || o.code)) || '')
  return {
    id: (o && (o.id || o.video_id)) || '',
    code: num,
    title: (o && (o.title || o.origin_title)) || '',
    date: (o && (o.release_date || o.date)) || '',
    cover: (o && (o.cover_url || o.thumb_url)) || '',
    thumb: (o && (o.thumb_url || o.cover_url)) || '',
    magnets: Number((o && (o.magnets_count != null ? o.magnets_count : o.magnet_count)) || 0) || 0,
    newMagnets: !!(o && o.new_magnets),
    sub: !!(o && (o.has_cnsub || o.has_subtitle)),
    duration: Number((o && o.duration) || 0) || 0,
    maker: (o && o.maker) || '',
    inLibrary: !!(o && o.library && o.library.in_library)
  }
}

/* ---------- 线上榜单（最近更新 / 官方排行榜） ----------
 * 「最近更新」= v1/movies/latest。两个坑：
 *   ① type 只认整数 —— 0=有码 1=无码 2=欧美 3=FC2（不传等于 0）。以前传 type=censored 这种
 *      字符串会被上游忽略、四个 tab 全都回落成有码，看起来「显示的不对」。
 *   ② sort_by 只认 release（按发行日期）。publish / score / review / want_watch 实测返回的是
 *      同一份「按更新时间」列表（md5 完全一致），所以只保留两种排序，不再给假选项。
 * 「排行榜」= v1/rankings?type=&period= —— 站方自己的官方榜，四类 × 日/周/月/年，每张 60 部。
 *   站方并没有 TOP250 这个榜（v1/top250、v1/rankings/top 全是 404），之前的「TOP250」是本机把
 *   16 张榜聚合出来的伪榜，已去掉，改为直出官方榜。 */
const BOARD_TYPES = [[0, '有码'], [1, '无码'], [2, '欧美'], [3, 'FC2']]
/* 站方 v1/rankings 只支持 daily / weekly / monthly；传 yearly 或未知值会被静默当作 daily
 * （实测返回完全相同的 60 部），所以不提供「年榜」。 */
const BOARD_PERIODS = [['daily', '日榜'], ['weekly', '周榜'], ['monthly', '月榜']]
const BOARD_SORTS = { update: '最近更新', release: '最新发行' }
/* 类型名（旧前端的 censored/uncensored/western/fc2）或整数 → 0~3 */
const boardTypeCode = t => {
  const s = String(t == null ? '' : t).trim().toLowerCase()
  const byName = { censored: 0, uncensored: 1, western: 2, fc2: 3, '有码': 0, '无码': 1, '欧美': 2 }
  if (s in byName) return byName[s]
  const n = parseInt(s, 10)
  return (n >= 0 && n <= 3) ? n : 0
}
async function boardLatest(sortBy, page, type) {
  const sb = BOARD_SORTS[sortBy] ? sortBy : 'update'
  const tp = boardTypeCode(type)
  const pg = Math.max(1, page || 1)
  const j = await onlineGet('v1/movies/latest?limit=24&page=' + pg + '&sort_by=' + sb + '&type=' + tp)
  const ms = (((j || {}).data || {}).movies) || []
  return { sort: sb, type: tp, page: pg, movies: ms.map(onlineMovie) }
}
async function boardRanking(type, period) {
  const tp = boardTypeCode(type)
  const pd = BOARD_PERIODS.some(x => x[0] === period) ? String(period) : 'daily'
  const j = await onlineGet('v1/rankings?type=' + tp + '&period=' + pd)
  const ms = (((j || {}).data || {}).movies) || []
  return {
    type: tp, period: pd, at: Date.now(),
    movies: ms.map((m, k) => Object.assign(onlineMovie(m), { rank: k + 1 }))
  }
}
/* 榜单下拉用：类型 / 周期 / 排序的可选项（前端直接渲染，避免两边口径漂移） */
const BOARD_META = {
  types: BOARD_TYPES.map(t => ({ v: t[0], label: t[1] })),
  periods: BOARD_PERIODS.map(x => ({ v: x[0], label: x[1] })),
  sorts: Object.keys(BOARD_SORTS).map(k => ({ v: k, label: BOARD_SORTS[k] }))
}

/* ---------- 播放进度 / 观看历史（watch.json） ----------
 * key = 媒体库内的相对路径（如 无码流出/ABC-123/ABC-123.mp4），与 docker 挂载路径无关，换机也认。
 * 记录 { p: 已看秒数, d: 总时长, t: 最后观看时间戳, n: 播放次数, done: 是否手动标记已看 }。
 * 落盘在项目根目录 → 随项目一起备份，容器重启不丢。 */
const WATCH_FILE = path.join(UI_ROOT, 'watch.json')
const WATCH_MAX = 2000          // 条目上限，超出按最近观看时间裁掉老的
let WATCH = (() => {
  try { const w = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); return w && typeof w === 'object' && !Array.isArray(w) ? w : {} } catch (_) { return {} }
})()
let watchTimer = null
function watchSaveSoon() {      // 前端每 5 秒回报一次，攒 2 秒再落盘，避免频繁写
  if (watchTimer) return
  watchTimer = setTimeout(() => {
    watchTimer = null
    const t = WATCH_FILE + '.tmp'
    try { fs.writeFileSync(t, JSON.stringify(WATCH)); fs.renameSync(t, WATCH_FILE) }
    catch (e) { console.error('[watch] 写入失败', e.message) }
  }, 2000)
}
function watchTrim() {
  const keys = Object.keys(WATCH)
  if (keys.length <= WATCH_MAX) return
  keys.sort((a, b) => (WATCH[b] && WATCH[b].t || 0) - (WATCH[a] && WATCH[a].t || 0))
  keys.slice(WATCH_MAX).forEach(k => delete WATCH[k])
}
const watchKeyOf = k => String(k || '').replace(/^\/?media\//, '').replace(/^\/+/, '').trim().slice(0, 500)
function watchRatio(r) { return r && r.d > 0 ? Math.min(1, (r.done ? r.d : r.p) / r.d) : 0 }

/* ---------- 访问口令（可选，设置 → 网络里开启）----------
 * 开启后局域网访问要先输口令（本机 localhost 始终放行，避免把自己锁在外面）。
 * 万一口令忘了：编辑 server-config.json 删掉 "accessCode" 那一行再重启即可。 */
const ACCESS_CODE = () => String(CFG.accessCode || '').trim()
const accessToken = () => crypto.createHash('sha256').update('javpaco:' + ACCESS_CODE()).digest('hex').slice(0, 32)
function hasAccess(req, p) {
  if (!ACCESS_CODE()) return true
  if (p === '/login' || p === '/api/login' || p === '/favicon.ico') return true
  if (p === '/' || p === '/index.html') { /* 主页也要口令，登录页单独走 /login */ }
  const m = /(?:^|;\s*)jpkey=([a-f0-9]{32})/.exec(req.headers.cookie || '')
  return !!m && m[1] === accessToken()
}
const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JAVPACO · 访问验证</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#eee;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
.c{width:min(360px,calc(100vw - 40px));background:#16161c;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:30px 26px;text-align:center}
h1{font-size:22px;letter-spacing:2px;margin:0 0 6px;color:#e50914}
p{margin:0 0 20px;font-size:12.5px;color:#8a8a96}
input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;font-size:14px;text-align:center;letter-spacing:2px}
button{width:100%;margin-top:12px;padding:11px;border-radius:999px;border:0;background:#e50914;color:#fff;font-size:14px;cursor:pointer}
.e{margin-top:12px;font-size:12px;color:#ff8a8a;min-height:16px}
</style></head><body><div class="c"><h1>JAVPACO</h1><p>这台媒体库开启了访问口令</p>
<form onsubmit="return go()"><input id="k" type="password" placeholder="输入访问口令" autocomplete="current-password"><button>进入</button></form>
<div class="e" id="e"></div></div>
<script>function go(){fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('k').value})}).then(r=>r.json()).then(d=>{if(d.ok){location.replace('/')}else{document.getElementById('e').textContent=d.error||'口令不对'}}).catch(()=>{document.getElementById('e').textContent='网络错误'});return false}</script>
</body></html>`

/* ---------- 个人数据（评分 / 备注 / 自定义标签）：userdata.json，key=归一化番号 ----------
 * 与刮削数据分离：换刮削源、重扫都不会丢；随项目一起备份。 */
const UD_FILE = path.join(UI_ROOT, 'userdata.json')
let UD = (() => { try { const u = JSON.parse(fs.readFileSync(UD_FILE, 'utf8')); return u && typeof u === 'object' && !Array.isArray(u) ? u : {} } catch (_) { return {} } })()
let udTimer = null
function udSaveSoon() {
  if (udTimer) return
  udTimer = setTimeout(() => {
    udTimer = null
    const t = UD_FILE + '.tmp'
    try { fs.writeFileSync(t, JSON.stringify(UD, null, 1)); fs.renameSync(t, UD_FILE) }
    catch (e) { console.error('[userdata] 写入失败', e.message) }
  }, 800)
}

/* 字幕统一转 WebVTT：浏览器 <track> 只认 vtt。srt 换时间戳分隔符即可，ass/ssa 抽 Dialogue 行重排。 */
function subToVtt(raw, ext) {
  let s = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (ext === '.ass' || ext === '.ssa') {
    const fmt = t => {
      const m = /(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})/.exec(String(t || '').trim())
      return m ? `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')}.${(m[4] + '00').slice(0, 3)}` : ''
    }
    const out = []
    for (const line of s.split('\n')) {
      if (!/^\s*Dialogue\s*:/i.test(line)) continue
      const p = line.replace(/^\s*Dialogue\s*:\s*/i, '').split(',')
      if (p.length < 10) continue
      const a = fmt(p[1]), b = fmt(p[2])
      const txt = p.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').trim()
      if (a && b && txt) out.push(`${a} --> ${b}\n${txt}`)
    }
    s = out.join('\n\n')
  } else {
    s = s.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
  }
  return 'WEBVTT\n\n' + s.replace(/^WEBVTT[^\n]*\n/i, '').trim() + '\n'
}

/* ---------- 默认数据源（1:1 对齐 NAS 上 MDC-NG v1.36 数据源管理页的 21 个站点） ----------
 * 每个站点字段与 MDC-NG provider 配置一致：enabled/base_url/cookies/user_agent/cooldown_seconds/
 * retry_times/retry_times_override/proxy/api_key/disable_hash_match；另保留我们自用的
 * search（番号搜索模板，{code} 占位）/test（测试链接）/layout 供详情页外链与连通性测试。 */
const MDC_FIELDS = ['enabled', 'base_url', 'cookies', 'user_agent', 'cooldown_seconds', 'retry_times', 'retry_times_override', 'proxy', 'api_key', 'disable_hash_match']
function prov(id, name, base_url, opts) {
  return Object.assign({
    id, name, base_url,
    enabled: true, cookies: '', user_agent: '',
    cooldown_seconds: 0, retry_times: 0, retry_times_override: false,
    proxy: '', api_key: '', disable_hash_match: true,
    search: '', test: base_url, layout: id.toLowerCase()
  }, opts || {})
}
const DEFAULT_SOURCES = [
  prov('airav_io',   'Airav_io',      'https://airav.io/cn'),
  prov('avbase',     'Avbase',        'https://www.avbase.net'),
  prov('avmoo',      'Avmoo',         'https://avmoo.website',            { search: 'https://avmoo.website/cn/search/{code}' }),
  prov('avsox',      'Avsox',         'https://avsox.click',              { search: 'https://avsox.click/cn/search/{code}' }),
  prov('Carib',      'Carib',         'https://www.caribbeancom.com'),
  prov('dmm',        'Dmm',           'https://www.dmm.co.jp',            { search: 'https://www.dmm.co.jp/search/=/searchstr={code}/', cookies: 'age_check_done=1' }),
  prov('Fc2',        'Fc2',           'https://adult.contents.fc2.com',   { search: 'https://adult.contents.fc2.com/article/{code}/' }),
  prov('fc2_hub',    'Fc2_hub',       'https://javten.com'),
  prov('freejavbt',  'Freejavbt',     'https://freejavbt.com'),
  prov('hbox_jp',    'Hbox_jp',       'https://hbox.jp'),
  prov('jav321',     'Jav321',        'https://www.jav321.com',           { search: 'https://www.jav321.com/search/{code}' }),
  prov('Javbus',     'Javbus',        'https://www.javbus.com',           { search: 'https://www.javbus.com/{code}' }),
  prov('Javdb',      'Javdb',         'https://javdb.com',                { search: 'https://javdb.com/search?q={code}&f=all', cooldown_seconds: 10 }),
  prov('Javlibrary', 'Javlibrary',    'https://www.javlibrary.com/cn',    { search: 'https://www.javlibrary.com/cn/vl_searchbyid.php?keyword={code}', enabled: false }),
  prov('Madou',      'Madou',         'https://madou.club'),
  prov('Madouqu',    'Madouqu',       'https://madouqu.com'),
  prov('Mgstage',    'Mgstage',       'https://www.mgstage.com',          { search: 'https://www.mgstage.com/product/product_detail/{code}/' }),
  prov('miss_av',    'Miss_av',       'https://missav123.com',            { search: 'https://missav.ws/search/{code}' }),
  prov('Mmtv',       'Mmtv',          'https://7mmtv.sx/zh'),
  prov('ThePornDB',  'ThePornDB',     'https://api.theporndb.net'),
  prov('xiao_huang_shu', 'Xiao_huang_shu', 'https://xchina.co')
]

/* ---------- 优先级 / 识别词（默认值照抄 NAS MDC-NG） ----------
 * priorities：全局 = 番号类型→站点序列；by_fields = 字段→站点序列；ignore_fields = 屏蔽刮削源(字段)。
 * keywords：自定义识别词（番号 / 路径），按番号类型分组。 */
const MDC_TYPES = [
  { key: 'jav_censored',  name: '有码番号' },
  { key: 'jav_uncensored', name: '无码番号' },
  { key: 'jav_amateur',   name: '素人番号' },
  { key: 'jav_fc2',       name: 'FC2 番号' },
  { key: 'cn',            name: '国产番号' },
  { key: 'ea',            name: '欧美影片' }
]
const MDC_BY_FIELDS = [
  { key: 'Title',       name: '标题 (Title)' },
  { key: 'OriginalTitle', name: '原标题 (OriginalTitle)' },
  { key: 'Outline',     name: '简介 (Outline)' },
  { key: 'Cover',       name: '封面 (Cover)' },
  { key: 'Poster',      name: '海报 (Poster)' },
  { key: 'ExtraFanart', name: '剧照 (ExtraFanart)' },
  { key: 'Tags',        name: '标签 (Tags)' },
  { key: 'UserRating',  name: '用户评分 (UserRating)' }
]
const DEFAULT_PRIORITIES = {
  jav_censored:  ['dmm', 'Mgstage', 'Javlibrary', 'avbase', 'hbox_jp', 'Javdb', 'Javbus', 'jav321', 'avmoo', 'Mmtv', 'airav_io', 'freejavbt', 'miss_av'],
  jav_uncensored: ['Carib', 'avbase', 'Javbus', 'Javdb', 'avsox', 'Mmtv', 'airav_io', 'freejavbt', 'miss_av'],
  jav_amateur:   ['Mgstage', 'Carib', 'Javlibrary', 'avsox', 'avmoo', 'Javbus', 'Javdb', 'jav321', 'Mmtv', 'airav_io', 'freejavbt', 'miss_av'],
  jav_fc2:       ['Fc2', 'fc2_hub', 'Javdb', 'avsox', 'Mmtv', 'airav_io', 'freejavbt', 'miss_av'],
  cn:            ['Madouqu', 'Madou', 'xiao_huang_shu', 'Mmtv'],
  ea:            ['ThePornDB'],
  by_fields: {
    Title: ['airav_io'], OriginalTitle: ['dmm', 'Mgstage'], Outline: ['airav_io'],
    Cover: ['dmm', 'Mgstage'], Poster: ['dmm', 'Mgstage', 'hbox_jp'],
    ExtraFanart: ['Javbus', 'avbase', 'freejavbt'], Tags: ['Javbus', 'avbase', 'freejavbt'],
    UserRating: ['dmm', 'jav321']
  },
  ignore_fields: {}
}
const DEFAULT_KEYWORDS = { jav_censored: [], jav_uncensored: [], jav_amateur: [], cn: [], ea: [] }
function cleanPriorities(p) {
  const ids = v => (Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [])
  const out = {}
  for (const t of MDC_TYPES) out[t.key] = ids(p && p[t.key])
  out.by_fields = {}
  const bf = (p && p.by_fields) || {}
  for (const f of MDC_BY_FIELDS) if (Array.isArray(bf[f.key])) out.by_fields[f.key] = ids(bf[f.key])
  out.ignore_fields = {}
  const ig = (p && p.ignore_fields) || {}
  for (const f of MDC_BY_FIELDS) if (Array.isArray(ig[f.key])) out.ignore_fields[f.key] = ids(ig[f.key])
  return out
}
function cleanKeywords(k) {
  const words = v => (Array.isArray(v) ? v.map(x => String(x || '').trim().slice(0, 40)).filter(Boolean) : [])
  const out = {}
  for (const t of MDC_TYPES) out[t.key] = words(k && k[t.key])
  return out
}
function getSourcesData() {
  const saved = Array.isArray(CFG.sources) ? CFG.sources : null
  const fill = (o, d) => {   // 缺省字段用默认值补齐
    const m = Object.assign({}, d, o)
    for (const k of MDC_FIELDS) if (!(k in m)) m[k] = d[k]
    for (const k of ['name', 'search', 'test', 'layout', 'base_url']) if (!m[k]) m[k] = d[k]
    return m
  }
  let sources
  if (saved && saved.length >= DEFAULT_SOURCES.length) {
    // 已落盘的完整列表（保存修改后的状态）直接使用
    const byId = Object.fromEntries(DEFAULT_SOURCES.map(d => [d.id, d]))
    sources = saved.map(s => fill(s, byId[s.id] || { id: s.id, name: s.name || s.id, base_url: s.base_url || '', enabled: false }))
  } else {
    // 旧版 8 站数组 → 迁移到 MDC-NG 21 站：只搬搜索/测试模板，开关状态以 MDC-NG 默认为准
    const byId = Object.fromEntries((saved || []).map(s => [s.id, s]))
    sources = DEFAULT_SOURCES.map(d => {
      const o = byId[d.id] || {}
      const m = Object.assign({}, d)
      for (const k of ['search', 'test', 'layout']) if (!m[k] && (o[k] || o.base)) m[k] = o[k] || o.base
      return m
    })
  }
  return {
    sources,
    priorities: cleanPriorities(CFG.priorities || DEFAULT_PRIORITIES),
    keywords: { code: cleanKeywords((CFG.keywords || {}).code), path: cleanKeywords((CFG.keywords || {}).path) }
  }
}

if (!fs.existsSync(MEDIA_ROOT)) {
  console.error(`[错误] 媒体目录不存在: ${MEDIA_ROOT}`)
  console.error(`用法: node server.js <媒体文件夹路径> [端口]`)
  console.error(`或者把路径写进 nexdex-ui/media-path.txt（每行一个路径）后直接运行 node server.js`)
  process.exit(1)
}

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg']
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif']
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.nfo': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.ts': 'video/mp2t',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8', '.ssa': 'text/plain; charset=utf-8', '.sub': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/png',   /* 我们的 favicon.ico 实际是 PNG（现代浏览器都按内容嗅探） */
  '.map': 'application/json; charset=utf-8'
}

const norm = s => (s || '').toUpperCase().replace(/[\s_]+/g, '-')
const bare = s => norm(s).replace(/[^A-Z0-9]/g, '')
/* 离线数据文件夹（cache/movies/<番号>）的定位。
 * 传进来的「番号」形态很杂：前端批量管理用的是 uKey（VRKM625，短横线没了）、
 * 详情页用的是条目里的原始番号（VRKM-625）、刮削改过名的又是另一种写法 ——
 * 直接拿字符串拼目录名会拼出个不存在的路径（于是「有离线资料」的条目被当成没有而跳过）。
 * 所以：候选名逐个试 + 在目录里反查 bare 相同的文件夹兜底。 */
function offlineCodeDir(code, item) {
  const root = path.join(cacheDir(), 'movies')
  const cands = []
  const push = v => { const s = String(v == null ? '' : v).replace(/[^\w.-]/g, '_') || ''; if (s && s !== '.' && s !== '..' && !cands.includes(s)) cands.push(s) }
  push(code)
  push(item && item.code)
  try { const b = bare(code); for (const n of fs.readdirSync(root)) if (bare(n) === b) push(n) } catch (_) {}
  for (const n of cands) { const p = path.join(root, n); if (fs.existsSync(p)) return p }
  return cands.length ? path.join(root, cands[0]) : path.join(root, String(code).replace(/[^\w.-]/g, '_'))
}
const extOf = n => (path.extname(n).slice(1) || '').toLowerCase()
const baseOf = n => path.basename(n, path.extname(n))
/* 命名噪声：站点/广告域名、方括号标注、@ # 分隔符 —— 4k688.com@UZU-040 → UZU-040；
 * 169bbs.com@START-280_[4K] → START-280；madoubt.com 326388.xyz HEYZO-3901 → HEYZO-3901。
 * 只在常规模式全部匹配不上时才启用（原来这种情况会退化成「前 18 个字符」的垃圾番号）。 */
const NAME_NOISE = /[\w-]+\.(?:com|net|org|cn|cc|tv|me|xyz|top|vip|club|info|io|sx|ws|la|us|jp|co)\b/gi
/* 文件名垃圾信息：mdc-ng 默认 file_sanitize_list（2048论坛@fun2048.com,1080p,720p,22-sht.me,-HD,
 * bbs2048.org@,hhd800.com@,icao.me@,hhb_000,[456k.me],[ThZu.Cc],_U3C3,-hhb）再加上 MDCx 老配置里的
 * h_720。它和我们一样在解析番号前先剔除，避免「1080p-ABC-123」被当成番号、_U3C3 被误认成 -U 后缀。 */
const SANITIZE_WORDS = ['2048论坛@fun2048.com', 'fun2048.com', '2048论坛', '22-sht.me', 'bbs2048.org@',
  'hhd800.com@', 'icao.me@', 'hhb_000', '[456k.me]', '[ThZu.Cc]', '_U3C3', '-hhb', 'h_720', '1080p', '720p', '-HD']
const SANITIZE_RE = new RegExp(SANITIZE_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
/* 只去垃圾信息，保留点/下划线：类型识别用（mdc-ng 的破解/中字/无码厂正则都吃 . 和 _，如 010113_504、
 * x-art.25.01.01、ABC-123-C.chs）。 */
const stripNameJunk = s => String(s || '')
  .replace(NAME_NOISE, ' ')
  .replace(SANITIZE_RE, ' ')
  .replace(/[[【(（][^\]】)）]*[\]】)）]/g, ' ')
  .replace(/[@#]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
/* 解析番号用：再把点/下划线摊平成空格，好让 ABC.123 / ABC_123 这类也能解析 */
const stripNameNoise = s => stripNameJunk(s).replace(/[\s._]+/g, ' ').trim()
/* 日期式无码番号（carib / 1pondo / muramura / pacopacomama 这类无码厂）：
 * mdc-ng 的 standard_parser 把它们的番号解析成 {number1}-{number2}（Caribbean，如 092126-001）
 * 或 {number1}_{number2}（1Pondo，如 082926_001），而无码厂前缀正则 ^[\d-]{4,}
 * 会把整个番号判成「无码」。这类番号必须在「. _ 摊平成空格」之前匹配 ——
 * 否则 082926_001 会被拆成两个数字段，解析不出番号（旧版就退化成垃圾 code）。
 * 分隔符统一成 -（norm() 本来也会把 _ 归一成 -），番号保持 092126-001 形态。 */
const RE_DATE_CODE = /(?:^|[^0-9A-Za-z])(\d{6})[-_](\d{2,4})(?![0-9])/
/* 无码厂站名（mdc-ng 原文：(?i)carib、(?i)1pon|mura|paco、(?i)heydouga、(?i)heyzo、(?i)(tokyo.*hot)…）
 * 出现在文件名尾段时既是站点标识，也是「无码」的依据（如 ABC-123-CARIB）。 */
const RE_UNC_SITE = /(?:^|[-_. ])(?:carib|1pon|mura|paco|10mu|muramura|pacopacomama|tokyo-?hot|heydouga|heyzo|xxx-av)(?=$|[-_. ])/i
/* 三种常规番号写法；匹配不上返回 null（交给调用方决定怎么兜底） */
const parseCodeFrom = base => {
  let m = base.match(/^([\dA-Za-z]{2,10})-(\d{2,7})(?:[ -].*)?$/)   // STARS-238 / 300MIUM-1415 / 092126-001-CARIB（后缀丢弃）
  if (m) return { code: (m[1] + '-' + m[2]).toUpperCase(), title: base }
  m = base.match(/^([A-Za-z]{2,6})(\d{2,7})(?:\s.*)?$/)           // STARS238 无横杠写法
  if (m) return { code: (m[1] + '-' + m[2]).toUpperCase(), title: base }
  m = base.match(/^([A-Za-z]{2,6}-?\d{2,5})(?:\s+(.*))?$/)
  if (m) return { code: m[1].toUpperCase(), title: (m[2] || '').trim() || m[1] }
  return null
}
const parseName = name => {
  const raw = baseOf(name)
  const base = raw.replace(/[._]+/g, ' ').trim()
  /* ① 日期式无码番号优先：先去广告串（4k688.com@092126-001-CARIB → 092126-001-CARIB）再匹配，
   * 必须在摊平 . _ 之前做，否则 082926_001-1PON 的下划线会被吃掉、番号解析失败。 */
  const junked = stripNameJunk(raw)
  const jd = junked.match(RE_DATE_CODE)
  if (jd) return { code: jd[1] + '-' + jd[2], title: junked.replace(/\s+/g, ' ') }
  /* ② 常规番号：先去噪声再解析，否则「hhd800.com@HEYZO-3902」里的域名数字会被当成番号（HHD-800）。
   * 没有噪声时 clean 与 base 相同，行为与原逻辑一致。 */
  const clean = stripNameNoise(raw).replace(/[._]+/g, ' ').trim()
  if (clean && clean !== base) {
    const hit0 = parseCodeFrom(clean)
    if (hit0) return hit0
  }
  const hit = parseCodeFrom(base)
  if (hit) return hit
  if (clean && clean !== base) return { code: clean.slice(0, 18), title: clean }
  return { code: base.slice(0, 18), title: base }
}

/* ---------- NFO 解析（Kodi 格式，正则版） ---------- */
function parseNfoText(t) {
  const pick = tag => {
    const m = t.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
  }
  return {
    title: pick('title'),
    plot: pick('plot'),
    year: pick('year') || pick('premiered').slice(0, 4),
    studio: pick('studio'),
    genres: [...t.matchAll(/<genre[^>]*>([\s\S]*?)<\/genre>/gi)].map(m => m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()).filter(Boolean),
    actors: [...t.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim()),
    /* 详情页「刮削内容 → 使用本地数据」还要这些；老调用方不读它们，加字段无害 */
    release: pick('releasedate') || pick('premiered') || pick('year'),
    runtime: (parseFloat(pick('runtime')) || 0),
    series: pick('series') || pick('set'),
    director: pick('director'),
    publisher: pick('label') || pick('maker')
  }
}

/* ---------- 图片尺寸（JPG/PNG/GIF，无依赖） ---------- */
function imgBufSize(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50)   // PNG
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49)   // GIF
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) {  // JPEG
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue }
      const mk = b[i + 1]
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC)
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}
function imgSize(fp) {
  try {
    const fd = fs.openSync(fp, 'r')
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    return imgBufSize(buf.subarray(0, n))
  } catch (_) {}
  return null
}
/* 异步版：115 云盘休眠时 open/read 会卡好几秒，扫描必须走线程池（同步版会把事件循环整个冻住，全站无响应——踩过） */
async function imgSizeAsync(fp) {
  let fh = null
  try {
    fh = await fsp.open(fp, 'r')
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return imgBufSize(buf.subarray(0, bytesRead))
  } catch (_) {}
  finally { if (fh) { try { await fh.close() } catch (_) {} } }
  return null
}

/* ---------- 老缓存图片角色修复：poster 必须竖版、fanart 必须横版 ----------
 * 早期刮削按 URL 规则分角色，会出现「poster=横版包装图 / fanart=小缩略图」的分反（如 MIGD-425）。
 * 启动时按下载后真实宽高校验并纠正（手动指定过的不动）：分反互换、更大的横图当 fanart、
 * 竖图误存 fanart 的转正为 poster。meta 图片文件名不变，加 imgFix 时间戳让前端 URL 失效缓存。 */
function repairImageRoles() {
  const mdir = path.join(cacheDir(), 'movies')
  let es = []
  try { es = fs.readdirSync(mdir, { withFileTypes: true }) } catch (_) { return }
  const PORTRAIT = s => s && s.h > s.w * 1.06
  const area = s => s.w * s.h
  let n = 0
  for (const e of es) {
    if (!e.isDirectory()) continue
    const dir = path.join(mdir, e.name), imgDir = path.join(dir, 'images')
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch (_) { continue }
    if (!meta || !meta.images || meta.images.posterManual || meta.images.fanartManual) continue
    const pf = path.join(imgDir, 'poster.jpg'), ff = path.join(imgDir, 'fanart.jpg')
    const sz = f => { try { return imgSize(f) } catch (_) { return null } }
    const ps = sz(pf), fsz = sz(ff)
    let changed = false
    /* meta 里记着的图片文件已被删（上次修复清掉了错位 poster）→ 清空引用，让前端回落到 fanart；尺寸 meta 一并清，否则升级逻辑会误判「海报已够清」 */
    if (meta.images.poster && !fs.existsSync(pf)) { meta.images.poster = ''; meta.images.posterMeta = null; meta.images.posterSrc = ''; changed = true }
    if (meta.images.fanart && !fs.existsSync(ff)) { meta.images.fanart = ''; meta.images.fanartMeta = null; meta.images.fanartSrc = ''; changed = true }
    if (!ps && !fsz) { if (changed) { meta.imgFix = Date.now(); try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)) } catch (_) {} } continue }
    if (ps && !PORTRAIT(ps)) {                       // poster 不是竖版 → 角色错乱
      if (fsz && PORTRAIT(fsz)) {                    // 竖图存成了 fanart → 互换
        const t = ff + '.rptmp'; fs.renameSync(ff, t); fs.renameSync(pf, ff); fs.renameSync(t, pf)
      } else if (fsz && area(fsz) >= area(ps)) {     // 两张都横、fanart 更大 → poster 多余，删掉
        fs.unlinkSync(pf)
      } else {                                       // fanart 缺失或是更小的横图/缩略图 → poster 转正当 fanart
        try { fs.unlinkSync(ff) } catch (_) {}
        fs.renameSync(pf, ff)
      }
      changed = true
    } else if (!ps && fsz && PORTRAIT(fsz)) {        // poster 缺失、竖图误存成 fanart → 转正
      fs.renameSync(ff, pf)
      changed = true
    }
    if (changed) {
      meta.imgFix = Date.now()
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)) } catch (_) {}
      n++
    }
  }
  if (n) console.log('[img-fix] 修复图片角色错乱 ' + n + ' 部')
}

/* ---------- 合拼封面自动拆分 ----------
 * fanart 是「左反面、右正面」的双封面合拼横图（宽高比 1.35–1.62，Javbus cover 惯例）且没有竖版海报时，
 * 裁出正封面那半边当 poster，竖版海报墙就不再拿横图硬凑。
 * 正封面在哪半边：优先拿源候选里的竖版缩略图与两半边降采样做像素对比，取更相似的一侧；
 * 没有可用候选按日版扫描惯例取右半。幂等：拆完后 poster 已是竖图，下次自动跳过。 */
function graySample(d, W, H, x0, hw, gw, gh) {
  const out = new Float64Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx = x0 + Math.min(hw - 1, Math.floor(x * hw / gw)), sy = Math.min(H - 1, Math.floor(y * H / gh))
    const i = (sy * W + sx) * 4
    out[y * gw + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  }
  return out
}
async function splitCoverPoster(im, imgDir, thumbUrls, log) {
  try {
    if (im.poster || im.posterManual) return false
    const fp = path.join(imgDir, 'fanart.jpg')
    if (!fs.existsSync(fp)) return false
    const sz0 = (im.fanartMeta && im.fanartMeta.w ? im.fanartMeta : null) || imgSize(fp)
    if (!sz0) return false
    const ar = sz0.w / sz0.h
    if (ar < 1.35 || ar > 1.62 || sz0.w < 600) return false
    const jpeg = require('jpeg-js')
    const raw = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 2048 })
    const W = raw.width, H = raw.height
    /* 全图灰度（列差/侧别判断共用） */
    const G = new Float64Array(W * H)
    for (let i = 0; i < W * H; i++) G[i] = 0.299 * raw.data[i * 4] + 0.587 * raw.data[i * 4 + 1] + 0.114 * raw.data[i * 4 + 2]
    const half = Math.floor(W / 2)
    const GW = 24, GH = 32
    const gL = graySample(raw.data, W, H, 0, half, GW, GH)
    const gR = graySample(raw.data, W, H, half, W - half, GW, GH)
    let side = 1   // 0=左（反面） 1=右（正面）
    for (const u of (thumbUrls || []).slice(0, 3)) {
      try {
        const b = await scFetch(u, { bin: true, hdrs: { referer: u } })
        if (!b || b.length < 1500) throw new Error('小')
        const tp = path.join(imgDir, '.thumb' + (Math.random() * 1e9 | 0) + '.jpg')
        fs.writeFileSync(tp, b)
        let t = null
        try {
          const tsz = imgSize(tp)
          if (tsz && tsz.h > tsz.w) t = jpeg.decode(fs.readFileSync(tp), { useTArray: true, maxMemoryUsageInMB: 512 })
        } catch (_) {}
        try { fs.unlinkSync(tp) } catch (_) {}
        if (!t) throw new Error('不是竖图')
        const gT = graySample(t.data, t.width, t.height, 0, t.width, GW, GH)
        const mse = g => { let s = 0; for (let i = 0; i < g.length; i++) { const d = g[i] - gT[i]; s += d * d } return s / g.length }
        side = mse(gR) <= mse(gL) ? 1 : 0
        break
      } catch (_) {}
    }
    /* 缝隙检测：相邻列平均灰度差取平滑后，在中间区域找局部峰；
     * 正反面分割线未必在中点（背面比正面宽/窄都常见），用 DVD 封面标准比例 0.707 做先验挑真缝，
     * 挑不出像封面比例的峰时保守退回中点。 */
    const diff = new Float64Array(W)
    for (let x = 0; x < W - 1; x++) {
      let s = 0
      for (let y = 0; y < H; y++) s += Math.abs(G[y * W + x + 1] - G[y * W + x])
      diff[x] = s / H
    }
    const sm = new Float64Array(W)
    for (let x = 1; x < W - 1; x++) sm[x] = (diff[x - 1] + diff[x] + diff[x + 1]) / 3
    const lo = Math.floor(W * 0.25), hi = Math.floor(W * 0.75)
    let maxS = 0
    for (let x = lo; x < hi; x++) if (sm[x] > maxS) maxS = sm[x]
    let seam = -1, bestPen = 1e9
    for (let x = lo; x < hi; x++) {
      if (sm[x] < maxS * 0.4) continue
      let peak = true
      for (let k = Math.max(lo, x - 6); k <= Math.min(hi - 1, x + 6); k++) if (sm[k] > sm[x]) { peak = false; break }
      if (!peak) continue
      const ratio = (side ? W - x : x + 1) / H   // 该峰作为分割线时，正封面那半的宽高比
      const pen = Math.abs(ratio - 0.7073)
      if (pen < bestPen) { bestPen = pen; seam = x + 1 }
    }
    if (seam < 0 || bestPen > 0.14) seam = half
    const x0 = side ? seam : 0
    const pw = side ? W - seam : seam, ph = H
    const data = Buffer.alloc(pw * ph * 4)
    for (let y = 0; y < ph; y++) {
      const src = (y * raw.width + x0) * 4
      data.set(raw.data.subarray(src, src + pw * 4), y * pw * 4)
    }
    const enc = jpeg.encode({ data, width: pw, height: ph }, 92)
    fs.writeFileSync(path.join(imgDir, 'poster.jpg'), enc.data)
    im.poster = '/cache/movies/' + path.basename(path.dirname(imgDir)) + '/images/poster.jpg'
    im.posterMeta = { w: pw, h: ph, bytes: enc.data.length, src: 'split-cover' }
    im.posterSrc = '自动拆分合拼封面'
    if (log) log('↻ 合拼封面已自动拆出竖版海报：' + pw + '×' + ph + '（取' + (side ? '右' : '左') + '半）')
    return true
  } catch (e) { if (log) log('拆分合拼封面失败：' + e.message); return false }
}
/* 启动自修：所有「无竖版海报 + fanart 像合拼封面」的缓存逐个拆分（异步，不阻塞启动） */
async function repairSplitCovers() {
  const mdir = path.join(cacheDir(), 'movies')
  let es = []
  try { es = fs.readdirSync(mdir, { withFileTypes: true }) } catch (_) { return }
  for (const e of es) {
    if (!e.isDirectory()) continue
    const dir = path.join(mdir, e.name), imgDir = path.join(dir, 'images')
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch (_) { continue }
    const im = meta && meta.images
    if (!im || im.posterManual || im.poster) continue
    const thumbs = []
    for (const s of Object.values(meta.sourceData || {})) for (const u of (s.posterCands || [])) thumbs.push(u)
    if (await splitCoverPoster(im, imgDir, thumbs, null)) {
      meta.imgFix = Date.now()
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)) } catch (_) {}
      mirrorMeta(e.name)
      console.log('[img-fix] 合拼封面拆分：' + e.name)
    }
    await new Promise(r => setImmediate(r))
  }
}

/* ---------- 扫描 ---------- */
function walk(dir, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_trash') continue   // _trash = 回收站，不进媒体库
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) walk(fp, out)
    else if (VIDEO_EXT.includes(extOf(e.name))) out.push(fp)
  }
  return out
}
/* 异步版（扫描专用）：网盘挂载上 readdir 也可能卡数秒，主线程不能停 */
async function walkAsync(dir, out = []) {
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_trash') continue
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) await walkAsync(fp, out)
    else if (VIDEO_EXT.includes(extOf(e.name))) out.push(fp)
  }
  return out
}

/* ---------- 扫描（后台异步 + 进度上报，前端轮询 /api/scan 显示进度条） ---------- */
const SCAN = { running: false, phase: '', videos: 0, scanned: 0, matched: 0, okCount: 0, failCount: 0, startedAt: 0, finishedAt: 0, ms: 0, error: '', pending: false }

async function scanAsync() {
  const t0 = Date.now()
  SCAN.running = true; SCAN.error = ''
  SCAN.phase = 'walk'; SCAN.videos = 0; SCAN.scanned = 0; SCAN.matched = 0; SCAN.okCount = 0; SCAN.failCount = 0; SCAN.autoQueued = 0
  SCAN.startedAt = t0; SCAN.finishedAt = 0
  const yieldLoop = () => new Promise(r => setImmediate(r))
  try {
    // 遍历所有媒体库（库之间去重，防止嵌套重复收录）；rel 仍相对挂载根，/media/ 直出不变
    const seen = new Set()
    const videos = []
    for (const lib of LIBS) for (const v of await walkAsync(lib)) if (!seen.has(v)) { seen.add(v); videos.push(v) }
    SCAN.videos = videos.length
    SCAN.phase = 'index'
    await yieldLoop()
    const items = []
    const dataRoot = readMediaPathFile() || MEDIA_ROOT   // 渐进落盘用的 root（与扫描结束时的最终值一致）
    // 目录 → 图片索引（异步：网盘上 readdir 不能阻塞主线程）
    const dirImgs = {}
    async function indexImgs(dir) {
      let entries = []
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) await indexImgs(fp)
        else if (IMG_EXT.includes(extOf(e.name))) (dirImgs[dir] = dirImgs[dir] || []).push(fp)
      }
    }
    for (const lib of LIBS) { await indexImgs(lib); await yieldLoop() }

    SCAN.phase = 'match'
    PROBE_TASKS.clear(); VPROBE_OFF = false; PROBE_SLOW = 0   // 每次扫描重试熔断（网盘可能已恢复）
    const MANUAL_CODES = loadManualCodes()   // 手动指定的番号覆盖（relVideo → code），重扫后仍生效
    let i = 0
    for (const vp of videos) {
      const dir = path.dirname(vp)
      const p = parseName(vp)
      const relVideo = path.relative(MEDIA_ROOT, vp).split(path.sep).join('/')
      const manualCode = MANUAL_CODES[relVideo]
      const code = norm(manualCode || p.code), ccode = bare(code)
      const dn = bare(path.basename(dir))
      const codeIn = fp => bare(baseOf(fp)).includes(ccode) || dn.includes(ccode)
      const imgs = (dirImgs[dir] || []).slice().sort((a, b) => codeIn(b) - codeIn(a))
      if (!imgs.length)
        Object.values(dirImgs).forEach(list => list.forEach(x => { if (codeIn(x) && !imgs.includes(x)) imgs.push(x) }))
      let fan = imgs.find(x => { const n = norm(path.basename(x)); return n.includes('FANART') || n.includes('THUMB') })
      let post = imgs.find(x => { const n = norm(path.basename(x)); return n.includes('POSTER') || n.includes('COVER') })
      if (!fan && !post) {
        for (const im of imgs) { const s = await imgSizeAsync(im); if (s && s.w > s.h) { fan = im; break } }
        if (!fan) for (const im of imgs) { const s = await imgSizeAsync(im); if (s && s.w <= s.h) { post = im; break } }
      }
      const nfos = (await fsp.readdir(dir).catch(() => [])).filter(x => extOf(x) === 'nfo').map(x => path.join(dir, x))
      const nfoFile = nfos.find(x => bare(baseOf(x)).includes(ccode)) || (nfos.length === 1 ? nfos[0] : null)
      let meta = {}
      if (nfoFile) { try { meta = parseNfoText(await fsp.readFile(nfoFile, 'utf8')) } catch (_) {} }
      // 类别（NFO genre）：滤掉清晰度/番号/演员名/厂商这类噪音，保留真正的影片类别
      const G_JUNK = /^(1080P?|720P?|2160P?|4K|2K|60FPS|HD|高清|高畫質|中字|中文字幕|字幕|内嵌字幕|內嵌字幕|無碼|无码|無碼流出|无码流出|有碼|有码|流出|破解|首发|首發|漢化|汉化|H26[45]|HEVC|AVC\d*|HVC\d*|MP4|MKV|AVI|WMV)$/i
      const seenG = new Set()
      const genres = (meta.genres || []).filter(g => {
        g = String(g).trim()
        if (!g || g.length > 14 || seenG.has(g)) return false
        if (G_JUNK.test(g)) return false
        if (/^(片商|發行|发行|系列|廠商|厂商)[:：]/.test(g)) return false
        const gb = bare(g)
        if (gb === dn || (gb && (ccode.includes(gb) || gb.includes(ccode)))) return false
        if ((meta.actors || []).some(a => a && (a === g || a.includes(g) || g.includes(a)))) return false
        if (meta.studio && (g === meta.studio || g.includes(meta.studio))) return false
        seenG.add(g); return true
      }).slice(0, 12)
      // 剧照：目录内 extrafanart（javbus 刮削惯例）
      let samples = []
      try {
        samples = (await fsp.readdir(path.join(dir, 'extrafanart')).catch(() => []))
          .filter(x => IMG_EXT.includes(extOf(x)))
          .map(x => path.join(dir, 'extrafanart', x))
      } catch (_) {}
      const rel = fp => path.relative(MEDIA_ROOT, fp).split(path.sep).join('/')
      let st = {}; try { st = await fsp.stat(vp) } catch (_) {}
      const it = {
        code, title: meta.title || p.title,
        plot: meta.plot || '', year: meta.year || '', studio: meta.studio || '',
        actors: meta.actors || [], genres,
        relVideo,
        relFanart: fan ? rel(fan) : null,
        relPoster: post ? rel(post) : null,
        relSamples: samples.map(rel),
        size: st.size || 0, mtime: st.mtimeMs || 0
      }
      if (it.relFanart || it.relPoster) SCAN.matched++
      const pv = await probeKick(it.relVideo)
      it.tags = videoTagsOf(baseOf(vp) + ' ' + (meta.title || '') + ' ' + (meta.genres || []).join(' '), pv ? pv.w : 0, pv ? pv.h : 0)
      enrichFromCache(it)   // 缓存里的刮削元数据回填（补空字段 + scraped 标记）
      // 识别失败待处理：没有 nfo 标题、缓存里也没刮到元数据的视频（标题只是文件名解析结果）
      it.pending = !it.scraped && !it.scrapeTitle && !(meta.title || '').trim()
      if (it.pending) SCAN.failCount++; else SCAN.okCount++   // 成功 = 识别出番号且刮到过元数据；失败 = 落进「识别失败待处理」
      items.push(it)
      SCAN.scanned = ++i
      /* 渐进落盘：每 16 部把已扫到的条目挂进 DATA → /data.json 立即可见，
       * 前端边扫边把海报墙铺出来，不用等整个目录走完（网盘挂载的 walk 可能要几十分钟）。 */
      if ((i & 15) === 0) DATA = { root: dataRoot, generated: Date.now(), items }
      if ((i & 15) === 0) await yieldLoop()   // 让出事件循环，/api/scan 才能实时响应
    }
    items.sort((a, b) => b.mtime - a.mtime)
    console.log(`[scan] ${items.length} 个影片，封面匹配 ${items.filter(x => x.relFanart || x.relPoster).length}，耗时 ${Date.now() - t0}ms`)
    /* 离线缓存兜底展示：还没配置媒体库（或扫到 0 部）时，用离线缓存里的条目做纯在线展示
     * （首次部署没挂媒体也能看到示例影片/已刮削条目，详情页在线播放、演员、系列都可用）。
     * 配上自己的媒体库并扫出内容后，这些条目自动让位。 */
    if (!items.length) {
      const mroot = path.join(cacheDir(), 'movies')
      let ces = []
      try { ces = fs.readdirSync(mroot, { withFileTypes: true }).filter(x => x.isDirectory()) } catch (_) {}
      for (const e of ces) {
        const m = readMovieCache(e.name)
        if (!m || (!m.title && !m.scraped)) continue
        const mt = Date.parse(m.scrapedAt || m.fetchedAt || '') || 0
        items.push(enrichFromCache({ code: m.code || e.name, title: m.title || e.name, plot: m.plot || '',
          year: m.year || '', studio: m.studio || '', publisher: m.publisher || '', series: m.series || '',
          actors: m.actors || [], genres: m.genres || [], relVideo: null, relFanart: null, relPoster: null,
          relSamples: [], size: 0, mtime: mt, cachedOnly: true }))
      }
      items.sort((a, b) => b.mtime - a.mtime)
      if (items.length) console.log('[scan] 未配置媒体库/扫到 0 部 → 展示离线缓存条目 ' + items.length + ' 部（示例与已刮削数据，纯在线浏览）')
    }
    /* 扫描完成 → 自动刮削新番号（设置页可关，默认开）：本轮「识别失败待处理」且能解析出番号的，
     * 复用订阅自动入库的队列逐部刮（用户手动刮削优先）；一次最多 200 部防刷站。
     * 缓存里已有离线数据的（之前刮过）不算新番号，直接跳过。 */
    if (CFG.autoScrapeNew !== false) {
      const codeOk = c => /^\d{6}-\d{2,4}$/.test(c) || (/[A-Z]/.test(c) && /\d/.test(c))
      const fresh = []
      for (const it of items) {
        if (!it.pending || !it.code) continue
        const code = String(it.code).toUpperCase()
        if (!codeOk(code) || fresh.includes(code)) continue
        try { const m = readMovieCache(code); if (m && m.scraped) continue } catch (_) {}
        fresh.push(code)
        if (fresh.length >= 200) break
      }
      if (fresh.length) {
        SCAN.autoQueued = fresh.length
        autoIngestQueue(fresh)
        console.log('[scan] 自动刮削：' + fresh.length + ' 个新番号已排队（设置 → 自动化 可关）')
      }
    }
    // root 显示用户配置的真实路径：容器里 MEDIA_ROOT 是挂载点（如 /media），
    // 对用户没意义，优先读 media-path.txt 里写的宿主机完整路径
    DATA = { root: readMediaPathFile() || MEDIA_ROOT, generated: Date.now(), items }
    vprobeFlush()   // 分辨率探测结果落盘，重扫不重复解析
  } catch (e) {
    SCAN.error = e.message
    console.log('[scan] error:', e.message)
  }
  SCAN.ms = Date.now() - t0
  SCAN.phase = 'done'
  SCAN.finishedAt = Date.now()
  SCAN.running = false
  /* 扫描中又有人添加/删除了媒体库 → 立刻按新列表再扫一遍（否则改动要等下次手动重扫） */
  if (SCAN.pending) { SCAN.pending = false; setTimeout(() => { if (!SCAN.running) scanAsync() }, 250) }
}

/* ---------- HTTP ---------- */
let DATA = null

/* ---------- 进度条缩略图预览：ffmpeg 按需抽帧，缓存 cache/previews/<md5>/ ----------
 * 悬停进度条时前端按百分比取第 i 帧；首次悬停触发生成（全局单任务队列，不打架）。
 * ~45 秒一帧、10~48 帧，168px 宽；缓存目录超 80 部 LRU 清理。 */
const PREVIEW = { map: new Map(), active: false, queue: [] }
const previewKeyOf = rel => crypto.createHash('md5').update(String(rel)).digest('hex').slice(0, 16)
const previewDirOf = key => path.join(cacheDir(), 'previews', key)
const previewFramesOf = dur => Math.max(10, Math.min(48, Math.round(dur / 45)))
function previewStart(rel) {
  const key = previewKeyOf(rel)
  if (PREVIEW.map.has(key)) return PREVIEW.map.get(key)
  const st = { rel, key, status: 'queued', count: 0, total: 0, dur: 0 }
  /* 磁盘上已有完整缓存（meta.json + 帧齐）→ 直接标记 done，不再 ffprobe/抽帧 */
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(previewDirOf(key), 'meta.json'), 'utf8'))
    let frames = 0
    for (let i = 0; i < meta.total; i++) { try { if (fs.statSync(path.join(previewDirOf(key), i + '.jpg')).size > 500) frames++ } catch (_) {} }
    if (meta.total > 0 && frames >= Math.ceil(meta.total * 0.8)) {
      st.status = 'done'; st.total = meta.total; st.count = frames; st.dur = meta.dur
      PREVIEW.map.set(key, st)
      return st
    }
  } catch (_) {}
  PREVIEW.map.set(key, st)
  PREVIEW.queue.push(st)
  previewPump()
  return st
}
async function previewPump() {
  if (PREVIEW.active) return
  const st = PREVIEW.queue.shift()
  if (!st) return
  PREVIEW.active = true
  try {
    const fp = safeMediaPath(st.rel)
    if (!fp) { st.status = 'error'; return }
    st.dur = await new Promise(resolve => {
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', fp], { timeout: 30000 }, (e, so) => {
        try { resolve(parseFloat(JSON.parse(so).format.duration) || 0) } catch (_) { resolve(0) }
      })
    })
    if (!st.dur) { st.status = 'error'; return }
    st.total = previewFramesOf(st.dur)
    const dir = previewDirOf(st.key)
    fs.mkdirSync(dir, { recursive: true })
    st.status = 'running'
    for (let i = 0; i < st.total; i++) {
      const out = path.join(dir, i + '.jpg')
      st.count = i
      if (fs.existsSync(out) && fs.statSync(out).size > 500) continue
      const at = (i + 0.5) / st.total * st.dur
      await new Promise(resolve => {
        execFile('ffmpeg', ['-ss', at.toFixed(1), '-i', fp, '-frames:v', '1', '-vf', 'scale=168:-2', '-q:v', '7', '-y', out],
          { timeout: 45000 }, e => { if (e) { try { fs.unlinkSync(out) } catch (_) {} } resolve() })
      })
    }
    st.count = st.total; st.status = 'done'
    try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ rel: st.rel, dur: st.dur, total: st.total, ts: Date.now() })) } catch (_) {}
    previewPrune()
  } catch (e) { st.status = 'error'; st.error = e.message }
  finally { PREVIEW.active = false; previewPump() }
}
function previewPrune() {   // 缓存上限 80 部，超出删最旧
  try {
    const root = path.join(cacheDir(), 'previews')
    const dirs = fs.readdirSync(root).map(d => { const fp = path.join(root, d); return { fp, m: fs.statSync(fp).mtimeMs } }).sort((a, b) => a.m - b.m)
    while (dirs.length > 80) { const d = dirs.shift(); fs.rmSync(d.fp, { recursive: true, force: true }) }
  } catch (_) {}
}

function rescan() {
  if (SCAN.running) { SCAN.pending = true; return }   // 已在扫描中 → 记一笔，扫完自动再扫
  scanAsync()
}
/* 每个媒体库的运行统计：收录了多少视频、识别成功多少、失败多少、有封面多少（设置页逐库显示） */
function libStats() {
  const items = (DATA && DATA.items) || []
  const hostRoot = readMediaPathFile() || ''
  return LIBS.map(p => {
    const rel = path.relative(MEDIA_ROOT, p).split(path.sep).join('/')
    const pref = rel ? rel + '/' : ''
    let videos = 0, ok = 0, fail = 0, cover = 0
    for (const it of items) {
      const rv = it.relVideo || ''
      if (!rv) continue
      if (rel && !(rv === rel || rv.startsWith(pref))) continue
      videos++
      if (it.pending) fail++; else ok++
      if (it.relPoster || it.relFanart) cover++
    }
    const hostPath = rel ? path.join(hostRoot || MEDIA_ROOT, rel) : (hostRoot || MEDIA_ROOT)
    return {
      path: p, rel, root: rel === '', hostPath,
      /* 名字优先用宿主机上的真实文件夹名（/media 在容器里没意义） */
      name: path.basename(hostPath) || path.basename(p) || p,
      videos, ok, fail, cover
    }
  })
}
/* 示例数据播种：镜像内置 sample-cache/（118 部 meta+竖版海报）。
 * 离线缓存目录还是空的（首次部署）→ 整包拷进去，页面立刻有内容可看；
 * 缓存里已有数据（老用户/已扫描过）则跳过，绝不覆盖。 */
function seedSamples() {
  try {
    const src = path.join(UI_ROOT, 'sample-cache', 'movies')
    if (!fs.existsSync(src)) return
    const dst = path.join(cacheDir(), 'movies')
    let cur = []
    try { cur = fs.readdirSync(dst).filter(n => !n.startsWith('.')) } catch (_) {}
    if (cur.length) return
    fs.mkdirSync(dst, { recursive: true })
    let n = 0
    for (const d of fs.readdirSync(src)) {
      if (d.startsWith('.')) continue
      try { fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true }); n++ } catch (_) {}
    }
    if (n) console.log('[seed] 首次运行：已载入 ' + n + ' 部示例影片到离线缓存（配置媒体库后自动让位）')
  } catch (e) { console.log('[seed] 示例数据载入失败：' + e.message) }
}
seedSamples()
rescan()                              // 后台启动扫描，服务先监听，进度走 /api/scan

function safeMediaPath(rel) {
  const fp = path.resolve(MEDIA_ROOT, rel)
  return fp.startsWith(MEDIA_ROOT + path.sep) ? fp : null
}

/* 文本资源 gzip 缓存（按文件 mtime 失效，最多留 8 份）：女优名册、index.html、CSS/JS 共用。
 * 图片与音视频不走这里 —— 它们必须原样直传，否则 Range 拖动进度条会失效。 */
const gzCache = new Map()
function gzFile(fp, mtimeMs) {
  const c = gzCache.get(fp)
  if (c && c.mtime === mtimeMs) return c.buf
  try {
    const buf = zlib.gzipSync(fs.readFileSync(fp), { level: 6 })
    if (gzCache.size > 8) gzCache.clear()
    gzCache.set(fp, { mtime: mtimeMs, buf })
    return buf
  } catch (_) { return null }
}

/* 哪些类型可以压缩回传：HTML / CSS / JS / JSON / SVG 等文本，图片与音视频一律原样 */
function compressibleType(type) {
  if (/^(video|audio)\//.test(type)) return false
  if (/^image\//.test(type) && !/svg/.test(type)) return false
  return /text|json|javascript|svg|xml/.test(type)
}

function sendFile(req, res, fp) {
  let st; try { st = fs.statSync(fp) } catch (_) { res.writeHead(404); return res.end('Not Found') }
  if (!st.isFile()) { res.writeHead(404); return res.end('Not Found') }
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'
  /* 协商缓存：ETag = 大小 + mtime，内容没变直接回 304
   * （index.html 有 600KB，原来 no-store 每次刷新都整包重下，现在第二次访问 0 字节）
   * 图片给 1 小时强缓存；文本用 no-cache —— 仍会来问一次，但拿 304 就用本地副本，
   * 既省流量又不会像强缓存那样在改完代码后看到旧页面。 */
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`
  const lastMod = new Date(st.mtimeMs).toUTCString()
  const isImg = /^image\//.test(type) && !/svg/.test(type)
  /* 缓存策略分三类：
   *   图片   → 1 小时强缓存（封面/剧照反复出现，省掉重复读盘）
   *   音视频 → no-store（动辄几个 G，不能让浏览器往磁盘缓存里塞；播放靠 Range 按需取）
   *   文本   → no-cache（每次都来问一次，内容没变回 304，改完代码不会看到旧页面） */
  const cache = isImg ? 'public, max-age=3600'
    : /^(video|audio)\//.test(type) ? 'no-store'
      : 'no-cache'
  const range = req.headers.range
  const inm = req.headers['if-none-match']
  if (!range && inm && String(inm).split(',').map(s => s.trim()).includes(etag)) {
    res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache, 'Vary': 'Accept-Encoding' })
    return res.end()
  }
  /* 文本预压缩回传：名册 10MB+、index.html 600KB 都能省下 70~90% 传输 */
  if (!range && compressibleType(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const buf = gzFile(fp, st.mtimeMs)
    if (buf) {
      res.writeHead(200, {
        'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': buf.length,
        'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache, 'Vary': 'Accept-Encoding'
      })
      return res.end(buf)
    }
  }
  if (range && /bytes=/.test(range)) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m[1] ? parseInt(m[1], 10) : 0
    let end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end()
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1,
      'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache
    })
    streamWith(res, fs.createReadStream(fp, { start, end }))
  } else {
    res.writeHead(200, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size,
      'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache
    })
    streamWith(res, fs.createReadStream(fp))
  }
}

/* 云盘挂载（115/CloudDrive）里未缓存的占位文件读取会抛 ENXIO，
 * 流上不挂 error 监听的话未捕获异常会直接打挂整个进程 —— 统一经这里 pipe */
function streamWith(res, rs) {
  rs.on('error', err => {
    console.error(`[stream] 读取失败: ${err.code || ''} ${err.message}`)
    try { if (!res.headersSent) res.writeHead(500) } catch (_) {}
    try { res.destroy() } catch (_) {}
  })
  rs.pipe(res)
}

/* ---------- 女优刮削/编辑 API（详情页「刮削」按钮用） ----------
 * POST /api/actor/scrape  {idx,name,mnid}  → 抓 minnano 资料页，返回最新元数据 + 下载新头像到本地
 * POST /api/actor/save    {idx,name,fields,iconPath,iconData,tags} → 写回 actresses.json / 头像文件
 * 依赖 docker-compose 里项目目录以读写方式挂载（之前是 :ro，编辑功能需要落盘）。
 */
const ROSTER = path.join(UI_ROOT, 'actresses.json')
const AVA_DIR = path.join(UI_ROOT, 'actresses')
const MN_BASE = 'https://www.minnano-av.com/'
/* minnano 云端中转：家里宽带对该站是 SNI 阻断（TCP 即 RST），但 api.github.com 直连可达。
 * GitHub Actions 每日抓榜单+头像提交到仓库 relay/ 目录，这里经 Contents API 兜底读取。
 * 私有仓库需在 设置→网络 配 githubToken（PAT）；未配 token 时仅公共仓库可用（退回 raw）。 */
const RELAY_API = 'https://api.github.com/repos/ShHEdisonXu/javpaco/contents/relay/'
const RELAY_BASE = 'https://raw.githubusercontent.com/ShHEdisonXu/javpaco/main/relay/'
const relayCache = new Map()   // p → {ts, buf|null}（10 分钟，避开 GitHub API 限频）
async function relayBuf(p, ms) {
  const c = relayCache.get(p)
  if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.buf
  const b = await relayBufFetch(p, ms)
  relayCache.set(p, { ts: Date.now(), buf: b })
  return b
}
async function relayBufFetch(p, ms) {
  const hd = { accept: 'application/vnd.github.raw' }
  const tk = String(CFG.githubToken || '').trim()
  if (tk) hd.authorization = 'Bearer ' + tk
  try {
    const r = await fetch(RELAY_API + p, { headers: hd, signal: AbortSignal.timeout(ms || 15000) })
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 2) return b }
  } catch (_) {}
  if (!tk) {   // 没配 token：退回 raw（仅公共仓库有效）
    try {
      const r = await fetch(RELAY_BASE + p, { signal: AbortSignal.timeout(ms || 15000) })
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 2) return b }
    } catch (_) {}
  }
  return null
}
async function relayJson(p, ms) {
  const b = await relayBuf(p, ms)
  if (!b) return null
  try { return JSON.parse(b.toString('utf8')) } catch (_) { return null }
}
const MN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const dropEmpty = (k, v) => (v === '' || v === null || (Array.isArray(v) && v.length === 0) ? undefined : v)
const mnDec = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
const mnStrip = s => mnDec(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

function json(res, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
  res.end(b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/* minnano 资料页解析（与 tools/minnano-sync.js parseProfilePage 同一套口径） */
function parseMinnanoProfile(html) {
  const kv = {}
  const alias = []
  for (const m of html.matchAll(/<td[^>]*>\s*<span>([^<]+)<\/span>([\s\S]*?)<\/td>/g)) {
    const k = mnStrip(m[1]), v = mnStrip(m[2])
    if (!k || !v) continue
    if (k === '別名' || k === '别名') { alias.push(v.split('（')[0].split('(')[0].trim()); continue }
    if (!kv[k]) kv[k] = v
  }
  const size = kv['サイズ'] || ''
  const cupRaw = (size.match(/([A-ZＡ-Ｚ])\s*カップ/) || [])[1] || ''
  const cup = cupRaw.replace(/[Ａ-Ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  const birthday = (kv['生年月日'] || '').replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, (_, y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`).split(/[\s（(]/)[0]
  const canon = mnStrip((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').split(/（|\(|AV女优/)[0].trim()
  const tags = []
  const tagBlock = (html.match(/<span>タグ<\/span>[\s\S]*?<div class="tagarea">([\s\S]*?)<\/td>/) || [])[1] || ''
  for (const m of tagBlock.matchAll(/tag_a_id=(\d+)[^>]*>([\s\S]*?)<\/a>/g)) {
    const n = mnDec(m[2])
    if (n) tags.push([m[1], n])
  }
  const img = (html.match(/src="(?:\/)?(p_actress[^"]+?\.jpg)/) || [])[1] || ''
  return {
    canon, birthday,
    height: (size.match(/T(\d+)/) || [])[1] || '',
    bust: (size.match(/B(\d+)/) || [])[1] || '',
    cup,
    waist: (size.match(/W(\d+)/) || [])[1] || '',
    hip: (size.match(/H(\d+)/) || [])[1] || '',
    shoe: (size.match(/S([\d.]+)/) || [])[1] || '',
    blood: kv['血液型'] || '', place: kv['出身地'] || '', hobby: kv['趣味・特技'] || '',
    period: kv['AV出演期间'] || '', debut: kv['デビュー作品'] || '',
    agency: kv['所属事务所'] || '', blog: kv['ブログ'] || '',
    avatarUrl: img ? MN_BASE + img : '',
    alias: alias.filter(Boolean), tags
  }
}

/* ---------- 代理配置（读取 server-config.json 的 proxy 字段，改完即时生效） ----------
 * proxyEnabled 是总开关：关掉后整个项目所有出网请求（刮削 / 图片 / 磁力 / minnano）都直连。 */
function proxyUrl() {
  if (CFG.proxyEnabled === false) return ''
  const v = String(CFG.proxy || '').trim()
  // 配置文件没写时回落到容器环境变量（docker-compose 里种的初始值）
  return v || String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
}

/* http CONNECT 隧道 agent：让 https 请求走 http 代理（零依赖，替代 fetch+env 方案，改代理无需重启） */
const proxyAgents = new Map()
/* 国内直连白名单：这些源实测无墙（订阅国内线路 / MissAV 镜像 / GitHub 中转 / 115 / 必应）。
 * 分情况走代理——即使用户配了代理，这些源也坚决直连（代理不稳定时它们照常工作）。 */
const DIRECT_HOSTS = [
  'apidd.spthgb.com', 'apidd.czssdgz.com', 'jdforrepam.com', 'tp.spfcas.com',          // 订阅（JavDB 国内线路+图床）
  'x99dh.cc', 'x99dh.vip', 'x99dh.my', 'x99dh.pro',                                    // MissAV 线路发现
  'missav.ws', 'missav123.com', 'njavtv.my', 'thisav.my', 'missav888.cc', 'njav01.net', 'missav.watch',
  'raw.githubusercontent.com', 'api.github.com', 'github.com', 'codeload.github.com',  // 云端中转
  'cn.bing.com', 'www.bing.com',                                                       // 图片兜底
  '115.com', 'webapi.115.com', 'clouddownload.115.com'                                 // 115 网盘
]
function isDirectHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return DIRECT_HOSTS.some(d => h === d || h.endsWith('.' + d))
}
function agentMaybe(u, pUrl) {
  if (!pUrl) return null
  try { if (isDirectHost(u.hostname)) return null } catch (_) {}
  try { return tunnelAgent(pUrl) } catch (_) { return null }
}
function tunnelAgent(pUrl) {
  if (proxyAgents.has(pUrl)) return proxyAgents.get(pUrl)
  const u = new URL(pUrl)
  const agent = new https.Agent({
    keepAlive: true,
    createConnection(opts, cb) {
      const host = opts.host, port = opts.port || 443
      const rq = http.request({
        host: u.hostname, port: u.port || 80, method: 'CONNECT',
        path: host + ':' + port, headers: { Host: host + ':' + port }
      })
      rq.once('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); cb(new Error('代理 CONNECT 失败 ' + res.statusCode)); return }
        cb(null, tls.connect({ socket, servername: host }))
      })
      rq.once('error', cb)
      rq.end()
    }
  })
  proxyAgents.set(pUrl, agent)
  return agent
}

async function mnFetch(url, bin, pOverride, referer) {
  const pUrl = pOverride !== undefined ? String(pOverride || '').trim() : proxyUrl()
  const once = () => new Promise((resolve, reject) => {
    const u = new URL(url)
    const opts = {
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': MN_UA, referer: referer || MN_BASE, accept: bin ? 'image/jpeg,*/*' : 'text/html,application/xhtml+xml' }
    }
    if (pUrl) { const ag = agentMaybe(u, pUrl); if (ag) opts.agent = ag }
    const rq = https.request(opts, rs => {
      const chunks = []
      rs.on('data', c => chunks.push(c))
      rs.on('end', () => {
        clearTimeout(deadline)
        const buf = Buffer.concat(chunks)
        if (rs.statusCode !== 200) return reject(new Error('http ' + rs.statusCode))
        resolve(bin ? buf : buf.toString('utf8'))
      })
    })
    // 硬性总时限：空闲超时挡不住慢速细流响应（会永久挂起）
    const deadline = setTimeout(() => rq.destroy(new Error('timeout')), 45000)
    rq.on('error', e => { clearTimeout(deadline); reject(e) })
    rq.setTimeout(20000, () => rq.destroy(new Error('timeout')))
    rq.end()
  })
  for (let i = 0; i < 3; i++) {
    try { return await once() } catch (e) { mnFetch.lastErr = e && e.message; await new Promise(s => setTimeout(s, 1200 * (i + 1))) }
  }
  return null
}

/* 头像文件名：沿用已有 icon 的基名（与每日同步脚本的 key 方案一致） */
function avaKey(a, mnid) {
  if (a.icon) {
    const b = path.basename(a.icon).replace(/\.(png|webp|jpe?g)$/i, '')
    if (/^[\w.-]+$/.test(b) && b !== 'favicon') return b
  }
  if (a.lid) return String(a.lid).replace(/[^\w-]/g, '')
  if (mnid) return 'mn' + mnid
  return 'nm-' + Buffer.from(String(a.name)).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)
}
/* ---------- 头像在线兜底（精简镜像）：本地 actresses/ 缺失时按名册在线抓取 ----------
 * 精简版镜像不再内置 957MB 头像库。/actresses/<key>.jpg 本地没有时：
 *   ① cache/actors/<key>.jpg（cache 卷，之前抓过、重建容器也不丢）→ ② 名册 mimg（minnano
 * 缩略图源，覆盖 ~94%，与本地文件同源同尺寸）→ ③ iconRemote（imgur/javbus/r18/dmm）。
 * 抓到落盘 cache/actors/ 并直接回源；失败做 10 分钟负缓存，避免墙面上几十张占位图
 * 同时打爆图源；并发请求合并到同一个 Promise。前端完全无感知（URL 不变）。 */
const AVA_ONLINE_FAIL = new Map()    // key → 失败时间戳
const AVA_ONLINE_JOB = new Map()     // key → Promise<Buffer|null>（去重并发）
let AVA_ONLINE_INDEX = null          // key → 名册条目（惰性构建，16MB JSON 一次性解析）
function avaOnlineIndex() {
  if (AVA_ONLINE_INDEX) return AVA_ONLINE_INDEX
  const idx = new Map()
  const put = a => {   // 主名册按 lid、榜上补充名册按 mnid 两种键都可能被请求到，全注册
    if (!a) return
    const k = avaKey(a)
    if (k && !idx.has(k)) idx.set(k, a)
    if (a.mnid) { const k2 = String(a.mnid); if (!idx.has(k2)) idx.set(k2, a); const k3 = 'mn' + a.mnid; if (!idx.has(k3)) idx.set(k3, a) }
  }
  try { for (const a of JSON.parse(fs.readFileSync(ROSTER, 'utf8'))) put(a) } catch (_) {}
  try { for (const a of readExtraRoster()) put(a) } catch (_) {}
  AVA_ONLINE_INDEX = idx
  return idx
}
const isImgBuf = b => !!(b && b.length > 2048 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)))
async function avatarOnline(key) {
  const a = avaOnlineIndex().get(key)
  const urls = []
  if (a && a.mimg) urls.push(String(a.mimg))
  if (a && a.iconRemote) urls.push(String(a.iconRemote))
  if (!urls.length) return null
  if (AVA_ONLINE_FAIL.get(key) > Date.now() - 10 * 60 * 1000) return null
  if (AVA_ONLINE_JOB.has(key)) return AVA_ONLINE_JOB.get(key)
  const job = (async () => {
    if (a && a.mnid) {   // ① GitHub 云端中转（Actions 每日抓的榜上女优头像，api.github.com 国内直连可达）
      const rb = await relayBuf('avatars/' + a.mnid + '.jpg')
      if (isImgBuf(rb)) {
        try { fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'actors', key + '.jpg'), rb) } catch (_) {}
        return rb
      }
    }
    for (const u of urls) {
      try {
        // Referer 跟着图源域名走（javbus 校验自家 Referer；minnano 用默认 MN_BASE）
        const ref = (() => { try { const o = new URL(u).origin + '/'; return o === MN_BASE ? undefined : o } catch (_) { return undefined } })()
        const b = await mnFetch(u, true, undefined, ref)
        if (isImgBuf(b)) {
          try { fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'actors', key + '.jpg'), b) } catch (_) {}
          return b
        }
      } catch (_) {}
    }
    AVA_ONLINE_FAIL.set(key, Date.now())
    return null
  })()
  AVA_ONLINE_JOB.set(key, job)
  const r = await job
  AVA_ONLINE_JOB.delete(key)
  return r
}

/* 女优头像回退来源：minnano 没编号/没头像时 → 必应图片 → 谷歌图片（按名字搜图） */
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
function webImgBuf(url, referer) {
  return new Promise(resolve => {
    let u; try { u = new URL(url) } catch (_) { return resolve(null) }
    const opts = {
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': WEB_UA, accept: 'image/jpeg,image/png,image/webp,*/*' }
    }
    if (referer) opts.headers.referer = referer
    const pv = proxyUrl(); if (pv) { const ag = agentMaybe(u, pv); if (ag) opts.agent = ag }
    const rq = https.request(opts, rs => {
      if (rs.statusCode !== 200) { rs.resume(); return resolve(null) }
      const chunks = []; rs.on('data', c => chunks.push(c))
      rs.on('end', () => resolve(Buffer.concat(chunks)))
    })
    rq.on('error', () => resolve(null))
    rq.setTimeout(12000, () => { try { rq.destroy() } catch (_) {} resolve(null) })
    rq.end()
  })
}
async function actorIconWeb(name, idx, mnid) {
  if (!name) return null
  const q = encodeURIComponent(name + ' 女優')
  const isImg = b => !!(b && b.length > 8192 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)))
  const save = b => {
    try {
      const list = JSON.parse(fs.readFileSync(ROSTER, 'utf8'))
      const key = avaKey(list[idx] || { name }, mnid)
      fs.mkdirSync(AVA_DIR, { recursive: true })
      fs.writeFileSync(path.join(AVA_DIR, key + '.jpg'), b)
      try { fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'actors', key + '.jpg'), b) } catch (_) {}
      return '/actresses/' + key + '.jpg'
    } catch (_) { return '' }
  }
  const grab = async url => { const b = await webImgBuf(url); return b ? b.toString('utf8') : '' }
  /* 1) 必应图片：murl 是原图直链，对爬虫最宽容（注意 HTML 里引号被转义成 &quot;） */
  try {
    const html = (await grab('https://www.bing.com/images/search?q=' + q + '&form=HDRSC2')).replace(/&quot;/g, '"')
    let urls = [...html.matchAll(/"murl":"(https?:\/\/[^"]+?\.(?:jpg|jpeg|png))"/gi)].map(m => m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&')).slice(0, 8)
    if (!urls.length) urls = [...html.matchAll(/"murl":"(https?:\/\/[^"]+)"/gi)].map(m => m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&')).slice(0, 6)
    for (const u of urls) {
      const b = await webImgBuf(u)
      if (isImg(b)) { const icon = save(b); if (icon) return { icon, via: 'bing' } }
    }
  } catch (_) {}
  /* 2) 谷歌图片：取 encrypted-tbn 缩略图（约 400px，做头像足够） */
  try {
    const html = await grab('https://www.google.com/search?q=' + q + '&tbm=isch&hl=ja')
    const urls = [...html.matchAll(/\["(https?:\/\/encrypted-tbn0\.gstatic\.com\/images\?[^"]+?)"/g)].map(m => m[1]).slice(0, 8)
    for (const u of urls) {
      const b = await webImgBuf(u)
      if (isImg(b)) { const icon = save(b); if (icon) return { icon, via: 'google' } }
    }
  } catch (_) {}
  return null
}

/* ---------- 名册外的女优：本地附加名册 actresses-extra.json ----------
 * 内置 actresses.json 是 minnano 全量同步来的（2.5 万条），但仍有查不到的（如只在无码厂出现的名字）。
 * 这些记录单独存一份，读取 /actresses.json 时合并到末尾 —— 前端拿到的 idx = 名册长度 + 附加序号，
 * 保存时按 idx 是否越界即可判断该写哪一份。 */
const EXTRA_ROSTER = path.join(UI_ROOT, 'actresses-extra.json')
function readExtraRoster() {
  try {
    const v = JSON.parse(fs.readFileSync(EXTRA_ROSTER, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch (_) { return [] }
}
function writeExtraRoster(list) {
  const t = EXTRA_ROSTER + '.tmp'
  fs.writeFileSync(t, JSON.stringify(list, dropEmpty, 1))
  fs.renameSync(t, EXTRA_ROSTER)
}
/* 保存时共用的字段写回逻辑（内置名册 / 附加名册都走这里） */
function applyActorFields(a, body) {
  const F = body.fields || {}
  const strs = ['name', 'furi', 'birthday', 'height', 'breast', 'waist', 'hip', 'cup',
    'blood', 'place', 'period', 'debutDate', 'debut', 'agency', 'hobby', 'shoe', 'blog']
  for (const k of strs) if (typeof F[k] === 'string') a[k] = F[k].trim()
  if (F.works !== undefined) { const w = parseInt(F.works, 10); if (w > 0) a.videoCount = w }
  if (typeof F.alias === 'string') a.alias = F.alias.split(/[，,、]/).map(x => x.trim()).filter(Boolean)
  if (Array.isArray(body.tags) && body.tags.length) a.tags = body.tags
  if (typeof body.mnid === 'string' && /^\d+$/.test(body.mnid)) a.mnid = body.mnid
  // 头像：上传 / 选定的 dataURL 优先，其次刮削时已落盘的路径
  if (typeof body.iconData === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(body.iconData)) {
    const ext = /image\/png/.test(body.iconData) ? 'png' : /image\/webp/.test(body.iconData) ? 'webp' : 'jpg'
    const key = avaKey(a, a.mnid)
    fs.mkdirSync(AVA_DIR, { recursive: true })
    fs.writeFileSync(path.join(AVA_DIR, key + '.' + ext), Buffer.from(body.iconData.split(',')[1], 'base64'))
    try { fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'actors', key + '.' + ext), Buffer.from(body.iconData.split(',')[1], 'base64')) } catch (_) {}
    a.icon = '/actresses/' + key + '.' + ext
  } else if (typeof body.iconPath === 'string' && /^\/(actresses|cache)\/[\w./-]+\.(png|jpe?g|webp)$/.test(body.iconPath)) {
    a.icon = body.iconPath
  }
  return a.name || ''
}

/* ---------- 聚合刮削（女优头像 / 资料多源候选） ----------
 * 头像候选：minnano 资料页头像 + 必应图片原图 + 谷歌图片缩略图；资料候选：minnano 按名搜索命中的多位女优。
 * 全程只读探测；选定后经 pick-avatar 落到 cache/actor-cand/，点「保存」才写进 actresses/。
 * （旧实现在点「刮削」时就覆盖了头像文件，没保存也已经变了。） */

/* 带 302 跟随的取页：mnFetch 不跟随重定向，而 minnano 搜索会 302 跳到唯一命中页 */
function mnGetOnce(url, bin, pUrl) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url) } catch (_) { return reject(new Error('bad url')) }
    const opts = {
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': MN_UA, referer: MN_BASE, accept: bin ? 'image/*,*/*' : 'text/html,application/xhtml+xml' }
    }
    if (pUrl) { const ag = agentMaybe(u, pUrl); if (ag) opts.agent = ag }
    const rq = https.request(opts, rs => {
      const chunks = []
      rs.on('data', c => chunks.push(c))
      rs.on('end', () => {
        clearTimeout(deadline)
        const buf = Buffer.concat(chunks)
        resolve({ status: rs.statusCode, headers: rs.headers, body: bin ? buf : buf.toString('utf8') })
      })
    })
    const deadline = setTimeout(() => rq.destroy(new Error('timeout')), 40000)
    rq.on('error', e => { clearTimeout(deadline); reject(e) })
    rq.setTimeout(18000, () => rq.destroy(new Error('timeout')))
    rq.end()
  })
}
/* 代理优先、直连兜底：两种链路都试一遍，任一通即可 */
async function mnGetFollow(url, bin, pOverride) {
  const cands = []
  const pv = pOverride !== undefined ? String(pOverride || '').trim() : proxyUrl()
  if (pv) cands.push(pv)
  cands.push('')
  for (const pUrl of cands) {
    let cur = url
    for (let hop = 0; hop < 6; hop++) {
      let r = null
      for (let i = 0; i < 2 && !r; i++) {
        try { r = await mnGetOnce(cur, bin, pUrl) } catch (_) { await new Promise(s => setTimeout(s, 600)) }
      }
      if (!r) break
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
        try { cur = new URL(r.headers.location, cur).href } catch (_) { r = null; break }
        continue
      }
      if (r.status === 200 && (bin ? r.body.length : r.body.length)) return { url: cur, status: r.status, body: r.body }
      break
    }
  }
  return null
}

/* minnano 按名搜索女优：唯一命中会 302 直达资料页（花咲まどか → 蜜香），否则返回候选列表 */
async function mnSearchActress(name) {
  const q = String(name || '').trim()
  if (!q) return { exact: '', list: [] }
  const r = await mnGetFollow(MN_BASE + 'search_result.php?search_scope=actress&search_word=' + encodeURIComponent(q) + '&search=+Go+', false)
  if (!r) return { exact: '', list: [], error: '搜索请求失败' }
  const hit = String(r.url).match(/\/actress(\d+)\.html/)
  if (hit) return { exact: hit[1], list: [] }
  const list = []
  const seen = new Set()
  for (const row of String(r.body).split(/<tr[^>]*>/i)) {
    const id = (row.match(/actress(\d+)\.html/) || [])[1]
    if (!id || seen.has(id)) continue
    const img = row.match(/<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"/i) || []
    const nm = mnStrip((row.match(/<h2[^>]*>\s*<a[^>]*>([^<]*)<\/a>/i) || [])[1] || img[2] || '')
    if (!nm) continue
    seen.add(id)
    list.push({
      mnid: id, name: nm,
      furi: mnStrip((row.match(/class="furi"[^>]*>([^<]*)</i) || [])[1] || ''),
      debutInfo: mnStrip((row.match(/class="debut-info"[^>]*>([\s\S]*?)</i) || [])[1] || ''),
      works: parseInt((row.match(/<td[^>]*>\s*(\d+)\s*<\/td>/i) || [])[1] || '', 10) || 0,
      avatarUrl: img[1] ? MN_BASE + String(img[1]).replace(/^\//, '') : ''
    })
  }
  return { exact: '', list }
}

/* 图库搜图候选（必应原图 / 谷歌缩略图）：只取 URL 不下载 */
function bingImageUrls(q, limit) {
  return mnGetFollow('https://www.bing.com/images/search?q=' + encodeURIComponent(q) + '&form=HDRSC2', false).then(r => {
    if (!r) return []
    const html = String(r.body).replace(/&quot;/g, '"')
    let urls = [...html.matchAll(/"murl":"(https?:\/\/[^"]+?\.(?:jpg|jpeg|png|webp))"/gi)].map(m => m[1])
    if (!urls.length) urls = [...html.matchAll(/"murl":"(https?:\/\/[^"]+)"/gi)].map(m => m[1])
    return [...new Set(urls.map(u => u.replace(/\\u0026/g, '&').replace(/&amp;/g, '&')))].slice(0, limit || 10)
  }).catch(() => [])
}
function googleImageUrls(q, limit) {
  return mnGetFollow('https://www.google.com/search?q=' + encodeURIComponent(q) + '&tbm=isch&hl=ja', false).then(r => {
    if (!r) return []
    const urls = [...String(r.body).matchAll(/\["(https?:\/\/encrypted-tbn0\.gstatic\.com\/images\?[^"]+?)"/g)].map(m => m[1])
    return [...new Set(urls)].slice(0, limit || 8)
  }).catch(() => [])
}

/* 图片字节校验：JPEG / PNG / WebP 魔数 */
const imgExtOf = b => {
  if (!b || b.length < 3000) return ''
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'png'
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return ''
}
/* 下载图片：先按 minnano 口径（带站内 referer），失败再按图床口径（带来源页 referer） */
async function fetchImageBuf(url) {
  const r = await mnGetFollow(url, true)
  if (r && imgExtOf(r.body)) return r.body
  let ref = ''
  try { ref = new URL(url).origin + '/' } catch (_) {}
  const b = await webImgBuf(url, ref)
  return imgExtOf(b) ? b : null
}

/* 头像候选缩略图代理：外部图床多半防盗链，由服务端代取再转出（<img src> 直接用）。
 * SSRF 防护：只允许公网 http/https 主机。 */
async function actorThumb(res, url) {
  if (!/^https?:\/\//i.test(url)) { res.writeHead(400); return res.end('bad url') }
  let h = ''
  try { h = new URL(url).hostname.toLowerCase() } catch (_) {}
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
      /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === '::1' || h.startsWith('[')) {
    res.writeHead(403); return res.end('forbidden')
  }
  const buf = await fetchImageBuf(url)
  if (!buf) { res.writeHead(404); return res.end('not found') }
  const ext = imgExtOf(buf) || 'jpg'
  res.writeHead(200, { 'Content-Type': MIME['.' + ext] || 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=600' })
  res.end(buf)
}

/* 内置名册 + 本地附加名册合并（带 mtime 缓存，名册 10MB+ 不适合每次重算） */
let ROSTER_MERGE = { key: '', buf: null, gzKey: '', gz: null }
function mergedRosterJson() {
  try {
    const st = fs.statSync(ROSTER)
    let ex = []
    try { ex = readExtraRoster() } catch (_) {}
    let exM = ''
    try { exM = String(fs.statSync(EXTRA_ROSTER).mtimeMs) } catch (_) {}
    const key = st.mtimeMs + ':' + st.size + ':' + exM + ':' + ex.length
    if (ROSTER_MERGE.key === key && ROSTER_MERGE.buf) return ROSTER_MERGE.buf
    const buf = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(ROSTER, 'utf8')).concat(ex)))
    ROSTER_MERGE = { key, buf }
    return buf
  } catch (_) { return null }
}

/* 合并名册的 gzip 结果同样按 key 复用：16MB 名册压一次要几百毫秒，
 * 每个请求现压会明显拖慢女优页首屏（那里正是靠它）。 */
function mergedRosterGz() {
  const buf = mergedRosterJson()
  if (!buf) return null
  if (ROSTER_MERGE.gz && ROSTER_MERGE.gzKey === ROSTER_MERGE.key) return ROSTER_MERGE.gz
  try {
    const g = zlib.gzipSync(buf, { level: 6 })
    ROSTER_MERGE = { key: ROSTER_MERGE.key, buf, gzKey: ROSTER_MERGE.key, gz: g }
    return g
  } catch (_) { return null }
}

/* 读名册 → 定位记录 → 修改 → 原子写回（与每日同步脚本同款 tmp+rename） */
function rosterUpdate(idx, name, apply) {
  const list = JSON.parse(fs.readFileSync(ROSTER, 'utf8'))
  const rec = list[idx]
  if (!rec || (name && rec.name !== name)) throw new Error('名册已更新，请刷新页面后重试')
  apply(rec)
  const t = ROSTER + '.tmp'
  fs.writeFileSync(t, JSON.stringify(list, dropEmpty))
  fs.renameSync(t, ROSTER)
  return rec
}

/* ---------- 影片详情：磁力从 sukebei.nyaa 抓取，落盘缓存（缓存优先，可离线读取） ---------- */
const SB_BASE = 'https://sukebei.nyaa.si/'
const SB_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce'
]
function sbMagnet(hash, title) {
  return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(title) +
    SB_TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('')
}
function movieCacheFile(code) {
  const safe = String(code).replace(/[^\w.-]/g, '_')
  return path.join(cacheDir(), 'movies', safe, 'meta.json')
}
function readMovieCache(code) {
  try { return JSON.parse(fs.readFileSync(movieCacheFile(code), 'utf8')) } catch (_) { return null }
}
/* 刮削产物外发（CFG.metaMode）：inline=跟视频放一起（番号文件夹内 poster/fanart 平铺，Kodi/Emby/Infuse 直读）。
 * 不开启则仅存缓存——缓存目录本身可在设置里改到任意路径（含媒体盘），结构与镜像等价，无需单独镜像。每次刮削/手动修改后自动同步。 */
function mirrorMeta(code) {
  if (CFG.metaMode !== 'inline') return
  const safe = String(code).replace(/[^\w.-]/g, '_')
  const src = path.join(cacheDir(), 'movies', safe)
  const it = ((DATA && DATA.items) || []).find(x => bare(x.code) === bare(code) && x.relVideo)
  if (!it) return   // 该番号没有对应视频文件（纯虚拟条目）→ 无处可放，仅存缓存
  const dst = path.dirname(path.join(MEDIA_ROOT, it.relVideo))
  if (!dst.startsWith(MEDIA_ROOT + path.sep)) return
  try {
    if (!fs.statSync(path.join(src, 'meta.json')).isFile()) return
    fs.mkdirSync(dst, { recursive: true })
    for (const f of ['meta.json', 'movie.nfo']) {
      try { if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dst, f)) } catch (_) {}
    }
    // Kodi 结构：poster.jpg / fanart.jpg / sampleNN.jpg 平铺在番号文件夹内（与视频同层）
    for (const f of fs.readdirSync(path.join(src, 'images'))) {
      try { if (/\.jpe?g$/i.test(f) && fs.statSync(path.join(src, 'images', f)).isFile()) fs.copyFileSync(path.join(src, 'images', f), path.join(dst, f)) } catch (_) {}
    }
  } catch (e) { console.log('[mirror]', code, e.message) }
}
/* 识别失败待处理：手动指定番号的持久化（relVideo → code），重扫后仍生效 */
function manualCodesFile() { return path.join(cacheDir(), 'manual-codes.json') }
function loadManualCodes() {
  try { return JSON.parse(fs.readFileSync(manualCodesFile(), 'utf8')) || {} } catch (_) { return {} }
}
function saveManualCode(relVideo, code) {
  const m = loadManualCodes()
  if (code) m[relVideo] = code; else delete m[relVideo]
  try {
    fs.mkdirSync(path.dirname(manualCodesFile()), { recursive: true })
    fs.writeFileSync(manualCodesFile(), JSON.stringify(m, null, 2))
  } catch (_) {}
}
/* 影片库隐藏列表（设置页可恢复）：刮削不到数据、又不想在影片库里看到的条目。
 * 按番号持久化在 server-config.json 的 hidden 字段，重扫后依然生效。 */
const hiddenSet = () => new Set((Array.isArray(CFG.hidden) ? CFG.hidden : []).map(x => bare(x)))
function setHidden(code, on) {
  const list = Array.isArray(CFG.hidden) ? CFG.hidden.slice() : []
  const b = bare(code)
  const i = list.findIndex(x => bare(x) === b)
  if (on) { if (i < 0) list.push(String(code)) }
  else if (i >= 0) list.splice(i, 1)
  CFG.hidden = list
  writeCfg()
  return list
}
/* 缓存图片 URL 附版本参数：换源覆盖同一文件名（poster.jpg）后浏览器不会继续用旧图 */
function withVer(u, meta) {
  if (!u) return u
  const t = Math.max(Date.parse((meta && (meta.scrapedAt || meta.fetchedAt)) || '') || 0, (meta && meta.imgFix) || 0)
  return t ? u + (u.includes('?') ? '&' : '?') + 'v=' + t : u
}
/* ================= 视频标签：分辨率探测（纯 JS 解析 MP4 moov/tkhd，不依赖 ffmpeg）+ 有码/无码/破解/流出/中字识别 =================
 * 媒体目录可能挂的是 CloudDrive 网盘（读字节走网络），所以探测必须：全异步、带超时、限并发、
 * 只读头/尾各 64KB，连续超时自动熔断（回落文件名标注的分辨率）。结果按 mtime+size 缓存，重扫零开销。 */
let VPROBE = null, VPROBE_DIRTY = false, VPROBE_OFF = false
function vprobeCache() {
  if (!VPROBE) { try { VPROBE = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'video-meta.json'), 'utf8')) } catch (_) { VPROBE = {} } }
  return VPROBE
}
function vprobeFlush() {
  if (!VPROBE_DIRTY || !VPROBE) return
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'video-meta.json'), JSON.stringify(VPROBE)) } catch (_) {}
  VPROBE_DIRTY = false
}
const fsp = fs.promises
/* 带超时的区间读取：超时 resolve null（句柄后台关闭，绝不让主线程卡住） */
const readRange = (vp, start, end, ms) => new Promise(resolve => {
  let fh = null, settled = false, timer = null
  const fin = v => {
    if (settled) return; settled = true; clearTimeout(timer)
    if (fh) { const f = fh; fh = null; try { f.close().catch(() => {}) } catch (_) {} }
    resolve(v)
  }
  timer = setTimeout(() => fin(null), ms)
  ;(async () => {
    fh = await fsp.open(vp, 'r')
    if (settled) return
    const len = end - start + 1
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got)
      if (settled) return
      if (bytesRead <= 0) break
      got += bytesRead
    }
    fin(got > 0 ? buf.subarray(0, got) : null)
  })().catch(() => fin(null))
})
/* 在 buffer 里从 moff（moov payload 起点）往下走 trak→tkhd；tkhd 末 8 字节恒为 width/height（v0/v1 皆然），取面积最大的视频轨 */
function dimsFromMoov(buf, moff) {
  let q = moff, w = 0, h = 0
  const n = buf.length
  while (q + 8 <= n) {
    let size = buf.readUInt32BE(q), hdr = 8
    if (size === 1) { if (q + 16 > n) break; size = Number(buf.readBigUInt64BE(q + 8)); hdr = 16 }
    if (size < 8) break
    const type = buf.toString('latin1', q + 4, q + 8)
    if (type === 'trak') {
      let r = q + hdr
      const re = Math.min(q + size, n)
      while (r + 8 <= re) {
        let ts = buf.readUInt32BE(r), th = 8
        if (ts === 1) { if (r + 16 > re) break; ts = Number(buf.readBigUInt64BE(r + 8)); th = 16 }
        if (ts < 8) break
        if (buf.toString('latin1', r + 4, r + 8) === 'tkhd') {
          const e = Math.min(r + ts, n)
          if (e - r >= 8) {
            const tw = buf.readUInt32BE(e - 8) >>> 16, thh = buf.readUInt32BE(e - 4) >>> 16
            if (tw * thh > w * h) { w = tw; h = thh }
          }
          break
        }
        r += ts
      }
    }
    q += size   // moov 被截断时自动停，能拿到几个 trak 算几个
  }
  return { w, h }
}
/* 头部 64KB：faststart 的 moov 在文件开头 */
function dimsFromHead(buf) {
  let p = 0
  const n = buf.length
  while (p + 8 <= n) {
    let size = buf.readUInt32BE(p), hdr = 8
    if (size === 1) { if (p + 16 > n) return null; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16 }
    else if (size === 0) return null
    if (size < 8) return null
    if (buf.toString('latin1', p + 4, p + 8) === 'moov') return dimsFromMoov(buf, p + hdr)
    p += size
  }
  return null
}
/* 尾部 64KB：非 faststart 的 moov 通常在文件尾；moov 本体超出尾部窗口时按 size 定点补读它的开头 */
async function dimsFromTail(vp, fsize) {
  const TAIL = 65536
  const start = Math.max(0, fsize - TAIL)
  const buf = await readRange(vp, start, fsize - 1, 12000)
  if (!buf) return null
  let idx = buf.length - 4
  for (;;) {
    idx = buf.lastIndexOf('moov', idx - 1)
    if (idx < 4) return null
    const msize = buf.readUInt32BE(idx - 4)
    if (msize < 8 || msize > fsize + 1024) continue
    const moovStart = start + idx - 4
    if (moovStart >= start) {
      const r = dimsFromMoov(buf, idx)
      if (r.w) return r
    } else {
      const hbuf = await readRange(vp, moovStart, moovStart + 65535, 12000)
      if (!hbuf) return null
      let hdr = 8
      const hs = hbuf.readUInt32BE(0)
      if (hs === 1) hdr = 16
      const r = dimsFromMoov(hbuf, hdr)
      if (r.w) return r
    }
  }
}
let PROBE_ACT = 0, PROBE_SLOW = 0
const PROBE_WAIT = []
async function probeSlot(fn) {
  if (PROBE_ACT >= 4) await new Promise(r => PROBE_WAIT.push(r))
  PROBE_ACT++
  try { return await fn() } finally { PROBE_ACT--; const r = PROBE_WAIT.shift(); if (r) r() }
}
async function probeVideoAsync(rel) {
  const vp = path.join(MEDIA_ROOT, rel)
  let st; try { st = await fsp.stat(vp) } catch (_) { return null }
  const cache = vprobeCache()
  const hit = cache[rel]
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit
  if (VPROBE_OFF) return { w: 0, h: 0, slow: false }
  return probeSlot(async () => {
    let slow = false, w = 0, h = 0
    const head = await readRange(vp, 0, 65535, 12000)
    if (!head) { slow = true } else {
      const r = dimsFromHead(head)
      if (r) { w = r.w; h = r.h }
      else {
        const t = await dimsFromTail(vp, st.size)
        if (t) { w = t.w; h = t.h } else if (head.length >= 65536) slow = true   // 头尾都没找到 moov 且文件确实读全了 → 可能不是 MP4，不算慢
      }
    }
    if (slow) { PROBE_SLOW++; if (PROBE_SLOW >= 3 && !VPROBE_OFF) { VPROBE_OFF = true; scLog('视频分辨率探测连续超时（网盘读取受限），本次扫描改用文件名标注') } }
    else PROBE_SLOW = 0
    if (slow) return { w: 0, h: 0, slow: true }   // 超时不缓存，下次扫描重试
    const e = { w, h, m: st.mtimeMs, s: st.size }
    cache[rel] = e
    VPROBE_DIRTY = true
    return e
  })
}
/* 扫描循环里按 rel 预 kick 探测任务（并发 4），走到该文件时 await——探测和遍历流水线并行 */
const PROBE_TASKS = new Map()
function probeKick(rel) {
  if (!PROBE_TASKS.has(rel)) PROBE_TASKS.set(rel, probeVideoAsync(rel).catch(() => null))
  return PROBE_TASKS.get(rel)
}
/* 分辨率档位：按较小边算（1080P=1920×1080、4K=3840×2160） */
function resTagOf(w, h) {
  if (!w || !h) return ''
  const v = Math.min(w, h)
  if (v >= 2160) return '4K'
  if (v >= 1440) return '2K'
  if (v >= 1080) return '1080P'
  if (v >= 720) return '720P'
  return '480P'
}
/* 有码/无码/破解/流出/中字：从文件名 + nfo 标题 + nfo 原始类别里识别；分辨率探测不到时回落文件名标注 */
/* ---------- 影片类型识别（规则照抄 mdc-ng，见 pkg/core/src/parser/mod.rs 与前端 naming 配置） ----------
 * mdc-ng 的解析正则原文（用 python 从官方 mdc_ng_app 二进制里取出的字符串）：
 *   无码厂番号： (?i)^[\d-]{4,}|^\d{6}_\d{2,3}|^(cz|gedo|k|n|red-|se)\d{2,4}|^heyzo.+|^xxx-av-.+|^heydouga-.+|^x-art\.\d{2}\.\d{2}\.\d{2}
 *   中文字幕：   (?i)[-_]U?C($|-|\.|\s)|[^a-zA-Z]ch($|-|\.)|字幕|中字
 *   破解：       (?i)-uncensored(?:$|[.\-_\s])|-u(?:$|[.\-_\s])|-uc(?:$|[.\-_\s])|UMR(?:$|[.\-_\s])|破解|克破
 *   流出：       (?i)流出|leaked        无码： (?i)uncensored|无码|無碼|無修正        有码： (?i)有码|有碼
 * 关键点：-U / -UC / -uncensored / UMR 都是「破解」（不是无码）；而 mosaic 字段里
 * 破解是无码的子类（无码 / 无码破解 / 无码流出），所以破解、流出同时算无码。
 * 注意 -UC = 破解 + 中文字幕（中字规则里的 [-_]U?C 也匹配 -uc）。
 * 判断范围只用「文件名尾段 + 完整路径」；文本里的标题/类别不该被当后缀（firstSeg 只取第一段）。 */
const UNRE_CODE_PREFIX = /^(?:[\d-]{4,}|\d{6}_\d{2,3}|(?:cz|gedo|k|n|red-|se)\d{2,4}|heyzo.*|xxx-av-.*|heydouga-.*|x-art\.\d{2}\.\d{2}\.\d{2})/i
const RE_HACK = /(?:^|[.\-_\s])uncensored(?:$|[.\-_\s])|(?:^|[.\-_])u(?:$|[.\-_\s])|(?:^|[.\-_])uc(?:$|[.\-_\s])|umr(?:$|[.\-_\s])|破解|克破/i
const RE_CNSUB = /[-_]U?C(?:$|[-.\s])|[^a-zA-Z]ch(?:$|-|\.)|字幕|中字|中文/i
const RE_LEAK = /流出|leaked/i
const RE_UNC = /uncensored|无码|無碼|無修正/i
/* text  = 文件名 / 相对路径（后缀类规则只认它）
 * extra = 标题、类别等附加文本（只参与「关键词」类判断，不参与后缀判断）
 * 后缀类规则（-U/-C/UMR/ch）必须只看文件名，否则标题里的普通词会被当后缀。 */
function videoTagsOf(text, w, h, extra) {
  const t = String(text || '')
  const x = String(extra || '')
  const all = x ? t + ' ' + x : t          // 关键词判断的完整文本
  /* 文件名尾段（去扩展名）：取「整条路径的尾段」，不能取「第一个空格前的词」——
   * 文件名里可能带空格，例：madoubt.com 326388.xyz HEYZO-3901.mp4，
   * 取第一段只会拿到 madoubt.com，番号整个丢掉 → HEYZO-3901 被判成有码。
   * 也不能用 baseOf（path.extname）——文本里可能已经没有扩展名，而文件名自带点
   * （4k688.com@MVSH-006-U）会被从第一个点截断，所以显式只去视频扩展名。 */
  const segAll = (t.trim().split(/[/\\]/).pop() || '')
  const segName = segAll.replace(/\.(mp4|mkv|avi|wmv|mov|webm|m4v|ts|m2ts|mpg|mpeg|flv)$/i, '')
  /* 先过一遍垃圾信息过滤（mdc-ng 的顺序）：否则广告域名里的数字会被当成无码厂番号，
   * 例：489155.com@START-633 的 489155 会命中 ^[\d-]{4,} → 误判无码。
   * 同理「madoubt.com 326388.xyz HEYZO-3901」去噪后正好剩下番号本身。 */
  const segClean = stripNameJunk(segName) || segName
  const hack = RE_HACK.test(segClean) || /破解|克破/.test(all)
  const leak = RE_LEAK.test(segClean) || /流出/.test(all)
  const unc = RE_UNC.test(all) || UNRE_CODE_PREFIX.test(segClean) || RE_UNC_SITE.test(segClean) || hack || leak
  const tags = []
  tags.push(unc ? '无码' : '有码')
  if (hack) tags.push('破解')
  if (leak) tags.push('流出')
  if (RE_CNSUB.test(segClean) || /中字|中文字幕|字幕|简体|簡體|繁體|繁体/.test(all)) tags.push('中字')
  const res = resTagOf(w, h)
  if (res) tags.push(res)
  else if (/4K|2160[Pp]/.test(all)) tags.push('4K')
  else if (/1080[Pp]/.test(all)) tags.push('1080P')
  else if (/720[Pp]/.test(all)) tags.push('720P')
  return tags
}

/* 本地媒体库条目 ← 缓存里的刮削元数据：文本字段以缓存为准（刮削/换源/手动编辑的结果必须能显示，
 * 否则本地 NFO 的旧值会一直压住新数据），缓存没有的字段回落本地 NFO 值；海报/主图仍本地优先。 */
function enrichFromCache(it) {
  const m = readMovieCache(it.code)
  if (!m) return it
  const filled = (a, b) => (a !== undefined && a !== null && String(a).trim() !== '') ? a : (b || '')
  if (m.scraped) {
    it.scraped = true
    if (it.pending) it.pending = false   // 刮到元数据 → 移出「识别失败待处理」
    it.plot = filled(m.plot, it.plot)
    it.year = filled(m.year, it.year)
    it.studio = filled(m.studio, it.studio)
    it.publisher = filled(m.publisher, it.publisher)
    it.series = filled(m.series, it.series)
    it.director = filled(m.director, it.director)
    it.release = filled(m.release, it.release)
    if (m.runtime) it.runtime = m.runtime
    if ((m.actors || []).length) it.actors = m.actors
    if ((m.genres || []).length) it.genres = m.genres
    // 刮削/手动标题恒更新（不与本地标题比较——手动改回与文件名相同的文字时旧值会残留）
    if (m.title) it.scrapeTitle = m.title
    if (m.source) it.scrapeSource = m.source
    it.scrapedAt = m.scrapedAt || m.fetchedAt || ''
    if (m.fields || m.scraped) it.scrapeFields = true   // 刮削过（或有多源数据）→ 详情页显示「刮削内容」入口（面板兼容空数据，可逐源补抓）
  } else if (m.fetchedAt) it.fetchedAt = m.fetchedAt
  else if (m.title && it.pending) it.pending = false   // 手动改过标题（缓存有 meta 但未在线刮削）→ 同样移出
  if (!m.scraped && m.title) it.scrapeTitle = m.title   // 只有手动标题的缓存 meta（未在线刮削）→ 标题也要生效
  const im = m.images || {}
  /* 缓存里有图就一定给 web* 字段：媒体目录可能挂网盘（CloudDrive/115），
   * relPoster 走 /media/ 是网络盘逐张读，海报墙会很慢；web* 指向本地 cache/ 盘上文件，秒开。
   * 前端展示优先 web*，没有缓存图才回退 rel*（详情页「本地数据」面板仍用 rel* 原始路径）。 */
  if (im.poster) it.webPoster = withVer(im.poster, m)
  if (im.fanart) it.webFanart = withVer(im.fanart, m)
  if ((im.samples || []).length) it.webSamples = im.samples.map(u => withVer(u, m))
  return it
}
/* 刮削完成后把结果并回内存里的条目，免整库重扫 */
function patchDataItem(code) {
  if (!DATA || !DATA.items) return
  const it = DATA.items.find(x => bare(x.code) === bare(code))
  if (it) enrichFromCache(it)
}
async function movieDetail(code, refresh) {
  const item = allItems().find(it => bare(it.code) === bare(code))
  let meta = refresh ? null : readMovieCache(code)
  if (!meta) {
    const rss = await mnFetch(SB_BASE + '?page=rss&q=' + encodeURIComponent(code))
    if (rss) {
      const magnets = []
      for (const m of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const blk = m[1]
        const pick = tag => { const r = blk.match(new RegExp('<(?:nyaa:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:nyaa:)?' + tag + '>', 'i')); return r ? r[1].trim() : '' }
        const title = mnDec(pick('title'))
        const hash = pick('infoHash').toLowerCase()
        if (!hash || !title) continue
        if (!bare(title).includes(bare(code))) continue   // 只留标题含本番号的种子
        let date = pick('pubDate')
        try { date = date ? new Date(date).toISOString().slice(0, 10) : '' } catch (_) { date = '' }
        magnets.push({
          title, hash, size: pick('size'), date,
          seeders: parseInt(pick('seeders'), 10) || 0,
          leechers: parseInt(pick('leechers'), 10) || 0,
          magnet: sbMagnet(hash, title)
        })
      }
      magnets.sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      // 与已有缓存合并（旧缓存里可能有刮削元数据 fields/images，不能被纯磁力结果覆盖掉）
      const oldCache = readMovieCache(code) || {}
      meta = Object.assign({}, oldCache, {
        code, fetchedAt: new Date().toISOString(),
        source: oldCache.scraped ? oldCache.source : 'sukebei.nyaa',
        magnets: magnets.length ? magnets : (oldCache.magnets || [])
      })
      try {
        fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true })
        fs.writeFileSync(movieCacheFile(code), JSON.stringify(meta, null, 2))
      } catch (_) {}
    } else {
      meta = readMovieCache(code)   // 抓取失败 → 回落缓存（离线读取）
      if (!meta) return { ok: false, error: '无法访问 sukebei.nyaa（检查网络或设置页代理），且该影片没有离线数据' }
    }
  }
  return { ok: true, cached: !!readMovieCache(code) && !refresh, item, meta }
}
/* 缓存目录统计（设置页「读取」用） */
function cacheStats() {
  const root = cacheDir()
  /* groups = 离线数据（刮削成果，可迁移可导回）；runtime = 运行缓存（服务运行中产生，可随时清掉自动重建） */
  const out = { ok: true, dir: root, groups: [], total: 0, runtime: { groups: [], total: 0 } }
  const walk = (d, acc) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) { acc.folders++; walk(fp, acc) }
      else { let st = {}; try { st = fs.statSync(fp) } catch (_) {} ; acc.files++; acc.size += st.size || 0 }
    }
  }
  for (const g of ['movies', 'actors', 'meta']) {
    const acc = { name: g, folders: 0, files: 0, size: 0 }
    walk(path.join(root, g), acc)
    if (acc.folders || acc.files) { out.groups.push(acc); out.total += acc.size }
  }
  /* 运行缓存 ①：播放进度条缩略图 previews/（ffmpeg 抽帧，清掉后播放时按需重建） */
  const pv = { name: 'previews', folders: 0, files: 0, size: 0 }
  walk(path.join(root, 'previews'), pv)
  if (pv.folders || pv.files) { out.runtime.groups.push(pv); out.runtime.total += pv.size }
  /* 运行缓存 ②：图片升级/候选探测中断残留的临时文件（movies 各目录下的隐藏文件） */
  const tmp = { name: 'tmp', folders: 0, files: 0, size: 0 }
  const tmpWalk = d => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) tmpWalk(fp)
      else if (e.name.startsWith('.')) { let st = {}; try { st = fs.statSync(fp) } catch (_) {}; tmp.files++; tmp.size += st.size || 0 }
    }
  }
  tmpWalk(path.join(root, 'movies'))
  if (tmp.files) { out.runtime.groups.push(tmp); out.runtime.total += tmp.size }
  out.runtime.totalAll = out.runtime.groups.reduce((s, g) => s + g.size, 0)
  return out
}

/* 清理运行缓存：previews 缩略图 + 临时残留文件。离线数据（movies/actors）绝不动。 */
function cacheClean() {
  const root = cacheDir()
  let freed = 0, files = 0
  const rm = fp => {
    try {
      const st = fs.statSync(fp)
      let sz = 0
      const szWalk = d => {
        let es = []
        try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
        for (const e of es) {
          const p2 = path.join(d, e.name)
          if (e.isDirectory()) szWalk(p2)
          else { let s2 = {}; try { s2 = fs.statSync(p2) } catch (_) {}; sz += s2.size || 0; files++ }
        }
      }
      if (st.isDirectory()) { szWalk(fp); files++ } else { sz = st.size; files++ }
      fs.rmSync(fp, { recursive: true, force: true })
      freed += sz
    } catch (_) {}
  }
  try {
    for (const e of fs.readdirSync(path.join(root, 'previews'), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      rm(path.join(root, 'previews', e.name))
    }
  } catch (_) {}
  const tmpWalk = d => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) tmpWalk(fp)
      else if (e.name.startsWith('.')) rm(fp)
    }
  }
  tmpWalk(path.join(root, 'movies'))
  return { freed, files, stats: cacheStats() }
}

/* ---------- 离线数据导入：扫描一个目录，找「每个子文件夹 = 一个番号的缓存」 ----------
 * 缓存的存储单元就是 cache/movies/<番号>/（meta.json + images/ + movie.nfo），
 * 整个文件夹移走媒体库里对应的影片就会消失；放回（或从别处导入）即恢复。 */
/* 递归拷贝（不用 fs.cpSync：在 virtiofs 挂载上会写出 --w------- 之类错乱权限） */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(a, b)
    else fs.writeFileSync(b, fs.readFileSync(a))
  }
}
function offlineScan(dir) {
  const root = String(dir || '').trim().replace(/\/+$/, '')
  if (!root || !path.isAbsolute(root)) throw new Error('请填写容器内的绝对路径（如 /media/nexdex-offline）')
  if (!(root === '/app' || root.startsWith('/app/') || root === '/media' || root.startsWith('/media/')))
    throw new Error('只能读取挂载进容器的目录（/app 或 /media 下的路径）')
  let es = []
  try { es = fs.readdirSync(root, { withFileTypes: true }) } catch (e) { throw new Error('目录不可读：' + e.message) }
  const out = []
  for (const e of es) {
    if (!e.isDirectory()) continue
    const src = path.join(root, e.name)
    if (!fs.existsSync(path.join(src, 'meta.json'))) continue
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8')) } catch (_) {}
    let bytes = 0
    try { bytes = fs.statSync(path.join(src, 'meta.json')).size } catch (_) {}
    try { for (const f of fs.readdirSync(path.join(src, 'images'))) { try { bytes += fs.statSync(path.join(src, 'images', f)).size } catch (_) {} } } catch (_) {}
    out.push({
      src, dir: e.name, code: (meta && meta.code) || e.name, title: (meta && meta.title) || '',
      scraped: !!(meta && meta.scraped), bytes,
      exists: fs.existsSync(path.join(cacheDir(), 'movies', e.name, 'meta.json'))
    })
  }
  return out
}

/* ================================================================
 * 在线刮削（导航 ＋ 号 · 添加本地库没有的影片）
 * 流程：番号/NFO/详情页网址 → 按数据源优先级（或指定网址）抓取
 * 元数据 + 竖版封面 + 横版主图 + 剧照 → 图片下载进缓存目录
 * meta.json 落盘 cache/movies/<番号>/（磁力与已有缓存合并保留）
 * ================================================================ */
const SCRAPE = { running: false, code: '', title: '', phase: '', pct: 0, log: [], error: '', finishedAt: 0 }
function scLog(s) {
  SCRAPE.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`)
  if (SCRAPE.log.length > 200) SCRAPE.log.shift()
  console.log('[scrape]', s)
}
/* 低层抓取：暴露状态码与响应头（mnFetch 不暴露），支持代理 + 重定向跟随 + POST + 原始响应 */
function scOnce(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const body = opts.body ? Buffer.from(String(opts.body)) : null
    const o = {
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({
        'user-agent': MN_UA,
        accept: opts.bin ? 'image/jpeg,image/png,image/webp,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'ja,zh-CN;q=0.9,en;q=0.6'
      }, body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) } : {}, opts.hdrs || {})
    }
    const pUrl = proxyUrl()
    if (pUrl) { const ag = agentMaybe(u, pUrl); if (ag) o.agent = ag }
    const rq = https.request(o, rs => {
      const chunks = []
      rs.on('data', c => chunks.push(c))
      rs.on('end', () => { clearTimeout(deadline); resolve({ status: rs.statusCode, headers: rs.headers, buf: Buffer.concat(chunks) }) })
    })
    // 硬性总时限：25s 的 setTimeout 是"空闲超时"，响应慢速细流会不断重置它导致永久挂起
    // （airav/missav 经代理时出现过单请求挂 10+ 分钟），所以再加一个不看重活动的墙钟上限
    const deadline = setTimeout(() => rq.destroy(new Error('timeout')), opts.deadline || 45000)
    rq.on('error', e => { clearTimeout(deadline); reject(e) })
    rq.setTimeout(25000, () => rq.destroy(new Error('timeout')))
    if (body) rq.write(body)
    rq.end()
  })
}
async function scFetch(url, opts = {}) {
  let cur = String(url)
  const post = opts.method === 'POST' && opts.body
  for (let hop = 0; hop < 5; hop++) {
    let rs = null
    for (let i = 0; i < 2; i++) {
      try { rs = await scOnce(cur, hop === 0 ? opts : Object.assign({}, opts, { method: 'GET', body: '' })); break } catch (e) { mnFetch.lastErr = e.message; await new Promise(s => setTimeout(s, 900 * (i + 1))) }
    }
    if (!rs) throw new Error('网络请求失败' + (mnFetch.lastErr ? '：' + mnFetch.lastErr : ''))
    if ([301, 302, 303, 307, 308].includes(rs.status) && rs.headers.location) {
      const loc = new URL(rs.headers.location, cur).href
      // 年龄门站点（javbus 等）会把真实详情页放在 302 的响应体里，只让浏览器跳去验证页：
      // 响应体已是完整内容页时直接用，不再跟去 age_check / driver-verify
      const gate = /(age[_-]?check|driver-verify|age[_-]?verif|over\-?18|adult[_-]?check|rurl=)/i.test(loc)
      const body = rs.buf.toString('utf8')
      if (!opts.bin && gate && body.length > 5000 && /<\/(?:html|body)>/i.test(body)) return opts.raw ? { buf: rs.buf, headers: rs.headers, status: rs.status, url: cur } : body
      cur = loc
      continue
    }
    if (rs.status !== 200) throw new Error('http ' + rs.status)
    // url = 跟完跳转后的最终地址（搜索页 301 到详情页时要用，见 mdcng.findDetailUrl）
    if (opts.raw) return { buf: rs.buf, headers: rs.headers, status: rs.status, url: cur }
    if (opts.bin) {
      /* JavDB 图片 CDN（tp.spfcas.com 等）返回的是加密字节流，需要解一次；
       * 其它站点不受影响 —— imgMaybeDecrypt 见到正常图片魔法数会原样放行 */
      let host = ''
      try { host = new URL(cur).hostname } catch (_) {}
      return IMG_HOST_OK.test(host) ? imgMaybeDecrypt(rs.buf) : rs.buf
    }
    return rs.buf.toString('utf8')
  }
  throw new Error('重定向次数过多')
}
/* ---------- HTML 工具 ---------- */
function scText(s) {
  return String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x?([0-9a-fA-F]+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, /^[0-9]+$/.test(d) ? 10 : 16)) } catch (_) { return m } })
    .replace(/\s+/g, ' ').trim()
}
function scMetaTag(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i')) ||
            html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + prop + '"', 'i'))
  return m ? scText(m[1]) : ''
}
/* 信息表行收集：<th>标签：</th><td>值</td>（mgstage 等）与 <span class="header">标签</span> 值（javbus 系） */
function scRows(html) {
  const rows = []
  let m
  const re1 = /<(?:th|dt)[^>]*>([\s\S]*?)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>([\s\S]*?)<\/(?:td|dd)>/gi
  while ((m = re1.exec(html))) rows.push([scText(m[1]).replace(/[：:]\s*$/, ''), scText(String(m[2]).replace(/<\/(?:a|li)>/gi, '、'))])
  const re2 = /<span[^>]*class="[^"]*header[^"]*"[^>]*>([\s\S]*?)<\/span>([\s\S]*?)(?=<\/p|$)/gi
  while ((m = re2.exec(html))) rows.push([scText(m[1]).replace(/[：:]\s*$/, ''), scText(m[2])])
  return rows
}
function scPick(rows, labels) {
  for (const [th, td] of rows) {
    const t = th.toLowerCase()
    if (labels.some(l => t === l.toLowerCase() || t.startsWith(l.toLowerCase()))) return td
  }
  return ''
}
function scSplitList(s) {
  return (s || '').split(/[/,，、・|]+/).map(x => x.trim()).filter(x => x && x.length <= 24)
}
/* javbus 系：演员与类别都包在 <span class="genre"> 里，靠链接路径 /star/ 与 /genre/ 区分 */
function scJavbusLists(html) {
  const out = { stars: [], genres: [] }
  const re = /<span[^>]*class="[^"]*genre[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
  let m
  while ((m = re.exec(html))) {
    const a = m[1].match(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/i)
    if (!a) continue
    const name = scText(a[2])
    if (!name || name.length > 24) continue
    if (/\/star\//i.test(a[1])) { if (!out.stars.includes(name)) out.stars.push(name) }
    else if (/\/genre\//i.test(a[1])) { if (!out.genres.includes(name)) out.genres.push(name) }
  }
  return out
}
/* 竖版 / 横版主图候选（规则对齐 MDC-NG）：
   · mgstage：pf_* 家族=竖版海报（pf_e_ 422×600 > pf_o1_ 166×236 > pf_t1_），pb_* 家族=横版包装图（pb_e_ 840×566），cap_e_N_=剧照
   · javbus ：/pics/cover/{h}_b.jpg = 横版包装大图（800×536），/pics/thumb/{h}.jpg = 竖版小海报（147×200）
   · 通用   ：og:image / enlarge_image 兜底
   最终以「下载后的真实宽高」定归属（竖版 h>w，横版 w>h），站点把横竖放错也能纠正 */
function scImageRoles(html, baseUrl, ogImage) {
  const abs = u => { try { return new URL(String(u || '').trim(), baseUrl).href } catch (_) { return '' } }
  const okImg = u => /\.(jpe?g|png|webp)(\?|$)/i.test(u || '')
  const P = [], F = []
  const pset = new Set(), fset = new Set()
  const addP = u => { u = abs(u); if (okImg(u) && !pset.has(u)) { pset.add(u); P.push(u) } }
  const addF = u => { u = abs(u); if (okImg(u) && !fset.has(u)) { fset.add(u); F.push(u) } }
  const og = ogImage || scMetaTag(html, 'og:image') || ''

  // —— mgstage：竖版 pf_e_（由页面里的 pf_o1_/pf_t1_ 或 og:image 的 pb_ 同族推导）
  const mg = /mgstage\.com/i.test(baseUrl) || /image\.mgstage\.com/i.test(og)
  const dmm = /dmm\.co\.jp/i.test(baseUrl) || /pics\.dmm\.co\.jp/i.test(og)
  if (mg) {
    const pfAny = (html.match(/https?:\/\/image\.mgstage\.com\/[^"'\s<>]*?\/pf_(?:e|o1|o2|t1)_[^"'\s<>]*?\.jpe?g/gi) || [])[0]
      || (/\/pf_/.test(og) ? og : '')
    const pbAny = (html.match(/https?:\/\/image\.mgstage\.com\/[^"'\s<>]*?\/pb_(?:e|o1|t1)_[^"'\s<>]*?\.jpe?g/gi) || [])[0]
      || (/\/pb_/.test(og) ? og : '')
    if (pfAny) { addP(pfAny.replace(/\/pf_(?:o1|o2|t1)_/, '/pf_e_')); addP(pfAny) }
    else if (pbAny) addP(pbAny.replace(/\/pb_/, '/pf_e_'))
    if (pbAny) addF(pbAny)
    for (const m of html.matchAll(/<img[^>]+class="[^"]*enlarge_image[^"]*"[^>]*>/gi)) { const s = m[0].match(/src="([^"]+)"/i); if (s) addP(s[1]) }
  }

  // —— javbus：bigImage = 横版大图；同 hash 的 /pics/thumb/ = 竖版
  const bigM = html.match(/class="bigImage"[^>]*href="([^"]+)"/i)
    || html.match(/<a[^>]+class="bigImage"[^>]*href="([^"]+)"/i)
    || html.match(/href="([^"]+)"[^>]*class="bigImage"/i)
  if (bigM) {
    const u = abs(bigM[1]); addF(u)
    const t = u.replace(/\/pics\/cover\//, '/pics/thumb/').replace(/_b(\.\w+)$/i, '$1')
    if (t !== u) addP(t)
  }
  for (const m of html.matchAll(/https?:\/\/[^"'\s<>]*\/pics\/thumb\/[^"'\s<>]*?\.(?:jpe?g|png|webp)/gi)) addP(m[0])
  for (const m of html.matchAll(/https?:\/\/[^"'\s<>]*\/pics\/cover\/[^"'\s<>]*?\.(?:jpe?g|png|webp)/gi)) addF(m[0])

  // —— DMM/FANZA：og:image 是 DVD 包装（竖版），只当竖版海报用；竖转横会很难看，横版主图留给别的源
  if (dmm) {
    if (og) addP(og)
    for (const m of html.matchAll(/https?:\/\/pics\.dmm\.co\.jp\/[^"'\s<>]*?\/[^"'\s<>]*?p[sl]\.jpe?g/gi)) addP(m[0])
  }

  // —— 通用兜底：og:image / EnlargeImage
  if (og && !dmm) { addP(og); addF(og) }
  for (const m of html.matchAll(/<a[^>]+id="EnlargeImage"[^>]*>/gi)) { const h = m[0].match(/href="([^"]+)"/i); if (h) addF(h[1]) }
  return { P, F }
}
/* DMM/FANZA 的商品信息写成 <tr><td class="nw">键：</td><td>值</td></tr>，通用行提取（scRows）抓不到 —— 单独归一化后并进 rows */
function scDmmRows(html) {
  const out = []
  for (const m of html.matchAll(/<tr[^>]*>\s*<td[^>]*class="[^"]*\bnw\b[^"]*"[^>]*>([\s\S]{1,90}?)<\/td>\s*<td[^>]*>([\s\S]{1,900}?)<\/td>/gi)) {
    const k = scText(m[1]).replace(/[：:]\s*$/, '').trim()
    const links = [...m[2].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(x => scText(x[1])).filter(Boolean)
    let v = (links.length > 1 ? links.join('、') : scText(m[2])).replace(/\s+/g, ' ').trim()   // ジャンル/出演 是多链接，按「、」拆开
    if (/^[-—–ー\s]*$/.test(v)) v = ''          // DMM 空值写「----」
    if (k && v) out.push([k, v])               // 与 scRows 同构：[标签, 值]
  }
  return out
}
/* 详情页解析：og 标签打底 + 信息表字段（日/中/英标签），页面须包含番号才算命中 */
function scParsePage(html, baseUrl, code) {
  const cb = bare(code).toLowerCase()
  const pageText = scText(html).slice(0, 30000).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!pageText.includes(cb)) return null
  const rows = scRows(html).concat(scDmmRows(html))
  // 番号强校验：识别码行（javbus 系）或标题必须含该番号——防站点偶发返回同系列其它影片的页面
  const ncode = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')
  const idRow = scPick(rows, ['識別碼', '识别码', '識別', '识别', '品番', '番号'])
  const titlePre = scMetaTag(html, 'og:title') || (html.match(/<h[13][^>]*>([\s\S]{5,300}?)<\/h[13]>/i) || [, ''])[1] || ''
  const normCode = t => scText(t).toUpperCase().replace(/[^A-Z0-9]/g, '')
  const urlClean = !/searchstr=|\/search\b|\/search\//i.test(baseUrl)   // 搜索页的网址里也带番号，不算证据
  if (idRow) { if (!normCode(idRow).includes(ncode)) return null }
  else if (!normCode(titlePre).includes(ncode) && !(urlClean && normCode(decodeURIComponent(baseUrl)).includes(ncode))) return null
  const abs = u => { try { return new URL(u, baseUrl).href } catch (_) { return '' } }
  let title = scMetaTag(html, 'og:title')
  if (!title) { const m = html.match(/<h[13][^>]*>([\s\S]{5,300}?)<\/h[13]>/i); if (m) title = scText(m[1]) }
  title = (title || '').replace(/[：:｜｜\-—－]\s*[^：:｜|]*?(MGS動画|MGS|エロ動画|アダルト動画|アダルトビデオ|JavBus|AV_base|みんなのAV|免費.*影片|免费.*影片|JAV\d*|online|movies?).*$/i, '').trim()
  title = title.replace(/^「/, '').replace(/」$/, '').trim()   // 去掉外层书名号
  let cover = scMetaTag(html, 'og:image')
  const big = html.match(/class="bigImage"[^>]*href="([^"]+)"/i) || html.match(/<a[^>]+class="bigImage"[^>]*href="([^"]+)"/i) ||
              html.match(/href="([^"]+)"[^>]*class="bigImage"/i)
  if (!cover && big) cover = abs(big[1])
  const samples = []
  const pushS = u => { if (u && !samples.includes(u) && /\.(jpe?g|png|webp)(\?|$)/i.test(u)) samples.push(u) }
  for (const m of html.matchAll(/class="sample_image"[^>]*href="([^"]+)"/gi)) pushS(abs(m[1]))
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class="sample_image"/gi)) pushS(abs(m[1]))
  const swi = html.search(/sample-waterfall/i)
  if (swi > 0) for (const m of html.slice(swi, swi + 20000).matchAll(/<img[^>]+src="([^"]+)"/gi)) pushS(abs(m[1]))
  if (!samples.length) for (const m of html.matchAll(/https?:\/\/[^\s"'<>]*jacket_sample[^\s"'<>]*\.jpg/gi)) pushS(m[0])
  if (!samples.length) for (const m of html.matchAll(/https?:\/\/pics\.dmm\.co\.jp\/[^\s"'<>]*\/[a-z0-9_]+-\d{1,2}\.jpe?g/gi)) pushS(m[0])   // FANZA 数字版样图 xxx-1.jpg…
  const dateRaw = scPick(rows, ['商品発売日', '発売日', '配信開始日', '發行日期', '发行日期', 'release date', 'released'])
  const date = (dateRaw.match(/\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}/) || [''])[0].replace(/[年月]/g, '-').replace(/\/|\./g, '-').replace(/-+$/, '')
  const runtime = parseInt(scPick(rows, ['収録時間', '时长', '時長', '長度', 'runtime', 'length']), 10) || 0
  const jb = scJavbusLists(html)
  const actors = jb.stars.length ? jb.stars.slice(0, 12)
    : scSplitList(scPick(rows, ['出演', '女優', '演员', '演員', 'actor', 'starring', 'cast'])).slice(0, 12)
  const genres = (jb.genres.length ? jb.genres
    : scSplitList(scPick(rows, ['ジャンル', '类别', '類別', 'genre', '标签', '標籤', 'tag']))).filter(g => g.length <= 14).slice(0, 12)
  const roles = scImageRoles(html, baseUrl, cover)
  return {
    title, cover: cover && /\.(jpe?g|png|webp)(\?|$)/i.test(cover) ? cover : '',
    plot: scMetaTag(html, 'og:description'),
    actors,
    studio: scPick(rows, ['メーカー', '片商', '厂商', '廠商', '製作商', '製作', 'studio', 'manufacturer', 'maker']).slice(0, 60),
    publisher: scPick(rows, ['レーベル', '发行商', '發行商', 'label', 'publisher']).slice(0, 60),
    series: scPick(rows, ['シリーズ', '系列', 'series']).slice(0, 60),
    director: scPick(rows, ['監督', '导演', '導演', 'director']).slice(0, 40),
    date, runtime, genres,
    samples: samples.slice(0, 12),
    posterCands: roles.P, fanartCands: roles.F
  }
}
/* ================= mdc-ng 规则引擎接入 =================
 * 站点规则逐字取自已解包的 mdc-ng v1.36.0 内嵌 provider YAML（rules/mdc-ng/*.yaml），
 * 由 mdcng.js 执行（XPath + processes），这里只做「请求适配」与「字段映射」。 */

/* 番号分类：对齐 mdc-ng parser（jp_censored / jp_uncensored / jp_amateur / jp_fc2 / cn / ea）
 * 分类决定用哪条优先级链，与 mdc-ng 的 priorities 一一对应 */
const MDC_AMATEUR_KEYWORDS = ['SIRO', 'SHN', 'GANA', 'LUXU', 'ARA', 'DCV', 'EWDX', 'MAAN', 'MIUM', 'NTK', 'KJO', 'KNB',
  'NTR', 'JAC', 'INST', 'SRYAM', 'FC', 'HHH', 'TEN', 'MLA', 'GCB', 'SEI', 'STC', 'VISAVIS', 'SP',
  'CUTE', 'KIRAY', 'NAMA', 'SIMM', 'KIW', 'VRSUKE', 'MY', '200GANA', '259LUXU', '300MIUM', 'MAAN']
const MDC_UNCENSORED_PREFIX = ['CARIB', 'CARIBBEAN', '1PONDO', '10MUSUME', 'HEYZO', 'TOKYOHOT', 'TOKYO-HOT', 'PACOPACOMAMA',
  'GACHI', 'MURAMURA', 'XXX-AV', 'SAMURAI', 'CATWALK', 'CYCLONE', 'LUCKY', 'REDHOT', 'SKYHIGH', 'ORIENTAL', 'CLIMAX',
  'CATCHEYE', 'FIVESTAR', 'ASIANEYES', 'GORILLA', 'LAPHORE', 'MIKADO', 'MUGEN', 'TSUBAKI', 'TRTR', 'MERCURY', 'KAMIKAZE',
  'QUEEN8', 'SASUKE', 'FANTADREAM', 'MATSU', 'PINKPUNCHER', 'ONEPIECE', 'GOLDENDRAGON', 'ARA']
const MDC_CN_PREFIX = ['MD', 'MAD', 'MADOU', '麻豆', '果冻', '天美', '蜜桃', 'SWAG', 'TWAV', '91CM', '91PORN', 'XN', 'FALENO-CH']
function mdcCategoryOf(code) {
  const raw = String(code || '').toUpperCase().trim()
  const s = MDCNG.splitNumber(raw)
  const name = String(s.serial_name || '').toUpperCase()
  const bareN = raw.replace(/[^A-Z0-9]/g, '')
  if (/^FC2/i.test(name) || /^FC2/.test(bareN)) return 'jav_fc2'
  if (/^\d{6}[_-]\d{1,3}$/.test(raw)) return 'jav_uncensored'          // 100323_01 这类无码编号
  if (MDC_UNCENSORED_PREFIX.some(p => name.startsWith(p.replace(/[^A-Z0-9]/g, '')))) return 'jav_uncensored'
  if (MDC_CN_PREFIX.some(p => name.startsWith(p))) return 'cn'
  if (/^[A-Z]+\.\d{2}\.\d{2}$/.test(raw) || /^(EP|S)\d+$/i.test(name)) return 'ea'
  const sn = String(s.serial_number || '')
  for (const k of MDC_AMATEUR_KEYWORDS) {
    const kk = k.replace(/-/g, '')
    if (name === kk || name.startsWith(kk) || (kk && name.includes(kk) && kk.length > 2 && /^\d{6}$/.test(sn))) return 'jav_amateur'
  }
  return 'jav_censored'
}
/* mdc-ng 规则里的字段名 → 我们的字段 */
function scMdcToParsed(f, usedUrl) {
  const arr = v => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : [])
  const first = v => arr(v)[0] || ''
  const poster = arr(f.Poster).concat(arr(f.Cover))
  const fanart = arr(f.Cover).concat(arr(f.Poster))
  return {
    title: first(f.Title) || first(f.OriginalTitle),
    plot: first(f.Outline),
    actors: (arr(f.Actors).length ? arr(f.Actors) : arr(f.OriginalActors)).slice(0, 12),
    genres: arr(f.Tags).filter(g => g.length <= 30).slice(0, 12),
    studio: first(f.Studio), publisher: first(f.Publisher), series: first(f.Series), director: first(f.Director),
    date: first(f.Release), runtime: parseInt(first(f.Runtime), 10) || 0,
    posterCands: poster.slice(0, 8), fanartCands: fanart.slice(0, 8),
    samples: arr(f.ExtraFanart).slice(0, 12),
    cover: first(f.Cover),
    score: first(f.UserRating),
    mdcNumber: first(f.Number) || first(f.PublishNumber) || first(f.PublishNumberDVD) || '',
    usedUrl, via: 'mdc-ng'
  }
}
/* 按某数据源的 mdc-ng 规则抓一次 */
async function scMdcCandidate(code, c, rule) {
  const enc = String(((rule.settings || {}).encoding) || '').toLowerCase()
  const decode = b => enc.includes('8859-1') || enc.includes('latin') ? b.toString('latin1') : b.toString('utf8')
  let logN = 0
  const log = s => { if (logN++ < 12) scLog('  · ' + c.id + '：' + s) }
  const res = await Promise.race([
    MDCNG.scrape(c.id, code, async (url, o = {}) => {
      const hdrs = {}
      if (o.cookie) hdrs.cookie = o.cookie
      else if (c.cookies) hdrs.cookie = c.cookies
      if (c.ua) hdrs['user-agent'] = c.ua
      if (o.post && o.body) {
        const r = await scFetch(url, { hdrs, method: 'POST', body: o.body, raw: true })
        return o.wantUrl ? { body: decode(r.buf), url: r.url || url } : decode(r.buf)
      }
      const r = await scFetch(url, { hdrs, raw: true })
      if (o.raw) return { headers: r.headers, body: decode(r.buf) }
      if (o.wantUrl) return { body: decode(r.buf), url: r.url || url }   // 让规则知道跟完跳转的落点
      return decode(r.buf)
    }, log),
    // 单源整体兜底：规则可能带多个搜索地址/预热请求，逐请求限时之外再封个总顶，
    // 超时记为"未命中"继续下一个源，不让整个刮削队列卡死
    new Promise(s => setTimeout(() => s({ ok: false, reason: '抓取超时（90s）' }), 90000))
  ])
  if (!res || !res.ok) return { parsed: null, reason: (res && res.reason) || '规则执行失败', rule }
  const parsed = scMdcToParsed(res.fields, res.usedUrl)
  if (!parsed.title && !parsed.cover && !parsed.samples.length) return { parsed: null, reason: '规则解析出的内容为空', rule }
  // 番号校验（对齐 mdc-ng 的 hash match）：除非该源配了 disable_hash_match
  if (!c.dhm) {
    const hit = [parsed.mdcNumber, parsed.title, parsed.usedUrl].some(t => t && bare(t).includes(bare(code)))
    if (!hit) return { parsed: null, reason: '页面内容与番号不符（未通过番号校验）', rule }
  }
  return { parsed, rule }
}

/* 造一个候选对象。有 mdc-ng 规则的源不依赖配置里的 search 模板（搜索地址由规则自带），
 * 所以 airav_io / avbase / fc2_hub / freejavbt / hbox_jp / xiao_huang_shu 这些空模板源也能进候选 */
function scMakeCand(s, code) {
  const rule = MDCNG.ruleFor(s.id)
  const tpl = (s.search && s.search.includes('{code}')) ? s.search : ''
  if (!tpl && !rule) return null
  const probe = tpl || s.homepage || (rule && rule.base_url) || ''
  let cookies = s.cookies || ''
  if (!cookies && /mgstage\.com/i.test(probe)) cookies = 'adc=1'              // MGS 年龄门
  if (!cookies && /dmm\.co\.jp/i.test(probe)) cookies = 'age_check_done=1'    // FANZA 年龄门
  if (!cookies && rule && rule.settings && rule.settings.cookies) cookies = rule.settings.cookies
  const url = tpl
    ? tpl.replace('{code}', encodeURIComponent(code))
    : (MDCNG.searchUrls(rule, code)[0] || String(rule.base_url || '').replace(/\/+$/, '') + '/' + encodeURIComponent(code))
  // ruleOnly：配置里没有搜索模板、只能靠规则的源。规则未命中时通用解析没有可靠落点，不必再抓一次
  return { id: s.id, url, cookies, dhm: !!s.disable_hash_match, ua: s.user_agent || '', ruleOnly: !tpl }
}
/* 按数据源优先级取候选（或指定单个站点）；mgstage / dmm 需要年龄验证 cookie */
function scCandidates(code, sourceId) {
  const sd = getSourcesData()
  const cat = mdcCategoryOf(code)
  const order = sourceId ? [sourceId] : (sd.priorities[cat] || sd.priorities.jav_censored || [])
  const out = []
  for (const id of order) {
    const s = sd.sources.find(x => x.id === id)
    if (!s || !s.enabled) continue
    const c = scMakeCand(s, code)
    if (c) out.push(c)
  }
  return out
}
/* ---------- 多源聚合（MDC-NG 语义）：每个字段按「字段优先级 → 全局优先级」选值，并记录来源 ----------
 * 字段 → MDC by_fields 键映射；actors/studio/publisher/series/director/release/runtime 无字段级配置，走全局序 */
const SC_FIELD_MAP = { title: 'Title', plot: 'Outline', genres: 'Tags', poster: 'Poster', fanart: 'Cover', samples: 'ExtraFanart' }
const SC_TEXT_FIELDS = ['title', 'plot', 'studio', 'publisher', 'series', 'director', 'release', 'runtime']
function scFieldOrder(field, pri) {
  const seq = []
  const bf = SC_FIELD_MAP[field]
  if (bf && pri.by_fields && Array.isArray(pri.by_fields[bf])) {
    for (const id of pri.by_fields[bf]) {
      if ((pri.ignore_fields && pri.ignore_fields[bf] || []).includes(id)) continue
      seq.push(id)
    }
  }
  for (const id of (pri.jav_censored || [])) if (!seq.includes(id)) seq.push(id)
  /* JavDB 线上源永远排在最末：只补别的源缺的字段（很多 FC2 / 无码片只有它有封面），
   * 不抢已配置站点的优先级。字段值 / 图片缺它一个就能补齐。 */
  if (!seq.includes('javdb')) seq.push('javdb')
  return seq
}
/* 从多源结果里为某字段挑值：按优先级取第一个有值的源 */
function scPickField(results, field, pri) {
  for (const id of scFieldOrder(field, pri)) {
    const r = results[id]
    if (!r) continue
    if (field === 'poster' || field === 'fanart') {
      const cands = field === 'poster' ? (r.posterCands || []) : (r.fanartCands || [])
      if (cands.length) return { cands, src: id }
    } else if (field === 'samples') {
      if ((r.samples || []).length) return { cands: r.samples, src: id }
    } else {
      const v = field === 'release' ? (r.date || r.release) : r[field]   // 解析结果里日期键叫 date
      if (field === 'actors' || field === 'genres') { if (Array.isArray(v) && v.length) return { v, src: id } }
      else if (field === 'runtime') { if (v > 0) return { v, src: id } }
      else if (v) return { v, src: id }
    }
  }
  return null
}
/* 多源候选序列：①各字段优先级里配置的站点先试 ②再按全局优先级补齐；去重 */
function scCandidatesMulti(code) {
  const sd = getSourcesData()
  const pri = sd.priorities || {}
  const cat = mdcCategoryOf(code)
  const seen = new Set(), out = []
  const add = id => {
    if (seen.has(id)) return
    const s = sd.sources.find(x => x.id === id)
    if (!s || !s.enabled) return
    const c = scMakeCand(s, code)
    if (!c) return
    seen.add(id)
    out.push(c)
  }
  for (const bf of Object.values(SC_FIELD_MAP)) for (const id of ((pri.by_fields || {})[bf] || [])) add(id)
  for (const id of (pri[cat] || pri.jav_censored || [])) add(id)
  return out
}

/* 该番号的「数据源一览」：候选源 + 状态（hit 命中 / miss 未收录·抓取失败 / untried 未尝试）
 * 有尝试记录（新刮削）用记录；老缓存没记录就按当前优先级推导，保证详情页能列出全部源并按需补抓 */
function scrapeSourcesOverview(code, m) {
  const cands = scCandidatesMulti(code)
  const triedMap = new Map((((m && m.scrapeTried) || {}).tried || []).map(t => [t.id, t]))
  const hit = new Set(Object.keys((m && m.sourceData) || {}))
  const out = []
  for (const c of cands) {
    const t = triedMap.get(c.id)
    out.push(c.id && hit.has(c.id)
      ? { id: c.id, status: 'hit', reason: '' }
      : { id: c.id, status: t && !t.ok ? 'miss' : 'untried', reason: t && !t.ok ? (t.reason || '该站没有这个番号的信息') : '' })
  }
  for (const id of hit)   // 已命中的源不在当前候选里（站点被停用 / 模板改过）也列出来，别让来源凭空消失
    if (!out.some(x => x.id === id)) out.push({ id, status: 'hit', reason: '该源当前未启用或没有番号搜索模板' })
  return out
}

/* ---------- DMM 图床直链（mdc-ng DMM 规则的 URL 模板，不访问站点） ----------
 * mdc-ng 的 DMM 规则里 Cover/Poster 本来就有这些 URL 模板（{dmm_cid} = 番号前缀小写 + 5 位补零，
 * VRKM-625 → vrkm00625），但只有 DMM 站点抓取成功才会用到 —— DMM 站点有地域限制，
 * 抓取失败时模板整列作废。而图床 awsimgsrc.dmm.co.jp 本身不限地域（实测直连 200）。
 * 这里不访问站点、纯本地构造候选 URL，交给图片下载循环按序试到能用为止：
 *   pl = package large（大封面，横版） / ps = package small（小封面） / jp-N = 剧照 */
function scDmmCdnCands(code) {
  const s = MDCNG.splitNumber(code)
  if (!s.serial_name || !/^\d+$/.test(s.serial_number || '')) return { poster: [], fanart: [], samples: [] }
  const cid = s.serial_name.toLowerCase().replace(/[^a-z0-9]/g, '') + String(s.serial_number).padStart(5, '0')
  const hosts = [
    c => 'https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/' + cid + '/' + cid + c,   // 数字版（VRKM 等在售）
    c => 'https://awsimgsrc.dmm.com/dig/mono/movie/' + cid + '/' + cid + c,             // 素人/月额 mono
    c => 'https://pics.dmm.co.jp/mono/movie/' + cid + '/' + cid + c                     // 旧图床
  ]
  /* ps = 竖版（数字版实测 1605×2184，正好当海报）；pl = 横版主图（2184×1365）；
   * 图床直连不要 cookie、不受地域封锁（DMM 站点本身的内容是 JS 渲染，抓不到）。 */
  const poster = [], fanart = []
  for (const h of hosts) { poster.push(h('ps.jpg')); fanart.push(h('pl.jpg')) }
  const samples = []
  for (let i = 1; i <= 10; i++) samples.push(hosts[0]('jp-' + i + '.jpg'))
  return { poster, fanart, samples }
}
/* 从详情页网址里抠番号（「输入番号详细网址」用）：
 *   dmm:    https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=vrkm00625/  → VRKM-625
 *           https://video.dmm.co.jp/av/content/?id=vrkm00625                → VRKM-625
 *   javbus: https://www.javbus.com/VRKM-625                                  → VRKM-625
 *   jav321: https://www.jav321.com/video/vrkm00625                           → VRKM-625
 * DMM 系 cid 是「前缀 + 5 位补零」，还原时去掉前导零（不足 3 位补到 3 位：abp00025 → ABP-025）。
 * 无分隔符的末段（vrkm00625）只在那串数字带前导零时才认 —— 避免把 javdb 的 /v/abc123 哈希当成番号。 */
function scCodeFromUrl(raw) {
  const s = String(raw || '').trim()
  if (!/^https?:\/\//i.test(s)) return ''
  const fixNum = d => {
    const n = String(d).replace(/^0+/, '') || '0'
    return /^0\d+$/.test(d) && n.length < 3 ? n.padStart(3, '0') : n
  }
  const fromUrl = m => m[1].toUpperCase() + '-' + fixNum(m[2])
  const qs = (s.match(/[?&#/]cid=([A-Za-z0-9_-]+)/i) || s.match(/[?&#]id=([A-Za-z0-9_-]+)/i) || [])[1] || ''
  if (qs) {
    const m = qs.match(/^([A-Za-z]{2,8})[-_]?(\d{2,7})$/)
    if (m) return fromUrl(m)
  }
  const last = decodeURIComponent((s.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '')).replace(/\.(html?|php)$/i, '')
  let m = last.match(/^([A-Za-z]{2,8})[-_](\d{2,7})$/)            // 带分隔符：VRKM-625
  if (m) return m[1].toUpperCase() + '-' + m[2].replace(/^0+(?=\d{3,})/, '')
  m = last.match(/^([A-Za-z]{2,8})(0\d{1,6})$/)                    // 无分隔符且带前导零：vrkm00625
  if (m) return fromUrl(m)
  return ''
}

/* 尝试单个候选：有 mdc-ng 规则的站点走规则引擎，其余走通用解析（搜索页找不到就跳详情页） */
async function scTryCandidate(code, c) {
  const rule = MDCNG.ruleFor(c.id)
  if (rule) {
    try {
      const r = await scMdcCandidate(code, c, rule)
      if (r.parsed && r.parsed.title) { scLog('✓ ' + c.id + ' 命中（mdc-ng 规则 ' + rule.__file + '）'); return r.parsed }
      scLog(c.id + '：mdc-ng 规则未命中（' + (r.reason || '无内容') + '）' + (c.ruleOnly ? '，该源只由规则驱动，跳过通用解析' : '，改用通用解析兜底'))
    } catch (e) {
      scLog(c.id + '：mdc-ng 规则执行出错（' + e.message + '）' + (c.ruleOnly ? '，跳过通用解析' : '，改用通用解析兜底'))
    }
    if (c.ruleOnly) return null
  }
  const hdrs = c.cookies ? { cookie: c.cookies } : {}
  let html = await scFetch(c.url, { hdrs })
  let usedUrl = c.url
  const cb = bare(code).toLowerCase()
  const hasCode = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(cb)
  const usable = p => !!p && !!p.title && (!!p.cover || (p.samples || []).length > 0)
  let parsed = hasCode(scText(html).slice(0, 25000)) ? scParsePage(html, usedUrl, code) : null
  if (!usable(parsed)) {
    /* 页面里没有番号（搜索页要往里跳），或「有番号但解析不出」（页面本身是搜索/列表页，只有标题撞上了番号）
     * → 找含番号的详情页链接再进一层，例如 FANZA 搜索页里的 /detail/=/cid=xxx/ */
    let detail = null
    for (const m of html.matchAll(/href="([^"]+)"/gi)) {
      let l = m[1]
      try { l = new URL(l, c.url).href } catch (_) { continue }
      if (!hasCode(decodeURIComponent(l))) continue
      if (/searchstr=|\/search\b|\/search\//i.test(l)) continue                   // 别再跳回搜索页
      if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(l)) continue                       // 也别跳图片
      detail = l; break
    }
    if (detail) {
      const h2 = await scFetch(detail, { hdrs })
      const p2 = scParsePage(h2, detail, code)
      if (usable(p2) || !usable(parsed)) { html = h2; usedUrl = detail; parsed = p2 }
    }
  }
  if (!parsed || !parsed.title || (!parsed.cover && !parsed.samples.length)) return null
  parsed.usedUrl = usedUrl
  return parsed
}
/* 图片落盘（MDC-NG 规则：不看文件名，按下载后的真实宽高定角色）
   poster.jpg 竖版海报（h>w） / fanart.jpg 横版主图（w>h） / sampleNN.jpg 剧照（不与主图重复） */
async function scSaveImages(dir, parsed) {
  const imgDir = path.join(dir, 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const web = f => '/cache/movies/' + path.basename(dir) + '/images/' + f
  const out = { poster: '', fanart: '', samples: [] }
  const used = new Set()          // 已作为主图的来源 URL（剧照里剔除）
  const PORTRAIT = (sz, b) => sz.h > sz.w * (b || 1.06)
  const LANDSCAPE = (sz, b) => sz.w > sz.h * (b || 1.06)
  const dl = async url => {
    const b = await scFetch(url, { bin: true, hdrs: { referer: url } })
    if (b.length < 2500) throw new Error('图片太小')
    const fp = path.join(imgDir, '.tmp' + (Math.random() * 1e9 | 0) + '.jpg')
    fs.writeFileSync(fp, b)
    const sz = imgSize(fp)
    if (!sz) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('不是有效图片') }
    return { fp, sz }
  }
  const put = (fp, name) => { fs.renameSync(fp, path.join(imgDir, name)); return web(name) }
  // —— 本地基线：缓存里已有的成品图也参与择优（整部重刮时，线上候选没有它大就保留原文件，绝不降级）
  const localSz = name => { try { const s = imgSize(path.join(imgDir, name)); return s && s.w ? s : null } catch (_) { return null } }
  const locP = localSz('poster.jpg'), locF = localSz('fanart.jpg')
  // —— 候选择优：同一张图站点常给多个尺寸变体（含缩略图/占位图），靠前的不一定最清晰，
  //    所以试前几个候选取面积最大的那张，而不是碰到第一张符合朝向的就收工；
  //    local 传入本地现有图的尺寸作为初始基线，与其比面积
  const pick = async (cands, want, good, maxTry, onOther, local) => {
    let best = local ? { fp: null, sz: local, u: null, local: true } : null, attempt = 0
    let loose = null   // 朝向不符但接近正方形的兜底：JavDB 的 FC2 封面常是 1:1，竖/横判定都过不了，
                       // 严格按朝向筛会把唯一能用的图丢掉 → 宁可用方图也比没图强（详情页可再手动裁竖版）
    for (const u of cands) {
      if (best && !best.local && good(best.sz)) break
      if (attempt >= maxTry) break
      attempt++
      let got = null
      try { got = await dl(u) } catch (_) { continue }
      const { fp, sz } = got
      if (want(sz)) {
        if (!best || sz.w * sz.h > best.sz.w * best.sz.h) {
          if (best) { try { fs.unlinkSync(best.fp) } catch (_) {} }
          best = { fp, sz, u }
        } else { try { fs.unlinkSync(fp) } catch (_) {} }
      } else if (!(onOther && onOther({ fp, sz, u }))) {
        const ratio = sz.w / sz.h
        if (ratio >= 0.85 && ratio <= 1.18 && (!loose || sz.w * sz.h > loose.sz.w * loose.sz.h)) {
          if (loose) { try { fs.unlinkSync(loose.fp) } catch (_) {} }
          loose = { fp, sz, u }
        } else { try { fs.unlinkSync(fp) } catch (_) {} }
      }
    }
    return best || loose
  }
  // —— 竖版海报：候选里取面积最大的竖版；横版候选也不浪费（转投横版池）
  const landPool = (parsed.fanartCands || []).slice()
  const bp = await pick(parsed.posterCands || [], PORTRAIT, sz => sz.w >= 500, 5, ({ sz, u }) => {
    if (LANDSCAPE(sz) && !landPool.includes(u)) landPool.unshift(u)
    return false
  }, locP)
  if (bp) {
    if (bp.local) { out.poster = web('poster.jpg'); scLog('竖版海报：保留本地 ' + bp.sz.w + '×' + bp.sz.h + '（线上候选没有更大的）') }
    else { out.poster = put(bp.fp, 'poster.jpg'); used.add(bp.u); scLog('竖版海报：' + bp.sz.w + '×' + bp.sz.h + ' ← ' + bp.u.split('/').pop()) }
    if (!bp.local && /dmm/i.test(bp.u)) out.posterFromDmm = true   // 来源标注跟着实际命中的图床走
  }
  // —— 横版主图：同样取面积最大的横版；顺手留一张竖版备用
  let posterAlt = null
  const bf = await pick(landPool.filter(u => !used.has(u)), LANDSCAPE, sz => sz.w >= 1600, 5, ({ fp, sz, u }) => {
    if (PORTRAIT(sz) && !out.poster && !posterAlt) { posterAlt = { fp, sz, u }; return true }
    return false
  }, locF)
  if (bf) {
    if (bf.local) { out.fanart = web('fanart.jpg'); scLog('横版主图：保留本地 ' + bf.sz.w + '×' + bf.sz.h + '（线上候选没有更大的）') }
    else { out.fanart = put(bf.fp, 'fanart.jpg'); used.add(bf.u); scLog('横版主图：' + bf.sz.w + '×' + bf.sz.h + ' ← ' + bf.u.split('/').pop()) }
    if (!bf.local && /dmm/i.test(bf.u)) out.fanartFromDmm = true
  }
  if (!out.poster && posterAlt) { out.poster = put(posterAlt.fp, 'poster.jpg'); used.add(posterAlt.u) }
  // —— 剧照（跳过已用作主图的 URL；顺手记下第一张横版剧照作兜底）
  let i = 1, firstLand = null, firstPort = null
  for (const s of (parsed.samples || [])) {
    if (used.has(s)) continue
    try {
      const { fp, sz } = await dl(s)
      const name = 'sample' + String(i).padStart(2, '0') + '.jpg'
      if (!firstLand && LANDSCAPE(sz)) firstLand = name
      if (!firstPort && PORTRAIT(sz)) firstPort = name
      fs.renameSync(fp, path.join(imgDir, name))
      out.samples.push(web(name)); used.add(s)
      if (++i > 12) break
    } catch (_) {}
  }
  // —— 兜底：竖版缺 → 用竖版剧照；横版缺 → 用横版剧照 → 退回竖版海报
  if (!out.poster && firstPort) { try { fs.copyFileSync(path.join(imgDir, firstPort), path.join(imgDir, 'poster.jpg')); out.poster = web('poster.jpg') } catch (_) {} }
  if (!out.fanart && firstLand) { try { fs.copyFileSync(path.join(imgDir, firstLand), path.join(imgDir, 'fanart.jpg')); out.fanart = web('fanart.jpg') } catch (_) {} }
  if (!out.fanart && out.poster) out.fanart = out.poster
  // 记录成品图的像素尺寸与文件大小（面板下方展示用）
  const fileMeta = name => {
    try {
      const fp = path.join(imgDir, name)
      const st = fs.statSync(fp)
      const sz = imgSize(fp)
      return { w: sz ? sz.w : 0, h: sz ? sz.h : 0, bytes: st.size }
    } catch (_) { return null }
  }
  out.posterMeta = out.poster ? fileMeta('poster.jpg') : null
  out.fanartMeta = out.fanart ? fileMeta('fanart.jpg') : null
  // 清理临时文件
  try { for (const f of fs.readdirSync(imgDir)) if (/^\.tmp/.test(f)) fs.unlinkSync(path.join(imgDir, f)) } catch (_) {}
  return out
}
/* 核心字段是否已集齐：标题/日期/演员/类别/竖图/横图都有值，且字段优先级里配置的站点都已试过 */
function scCoreComplete(results, pri, candIds, tried) {
  for (const f of ['title', 'release', 'actors', 'genres', 'poster', 'fanart']) {
    if (!scPickField(results, f, pri)) return false
  }
  for (const id of (pri.by_fields ? Object.values(pri.by_fields).flat() : [])) {
    if (candIds.has(id) && !tried.has(id)) return false
  }
  return true
}
/* 单图换源下载：从指定来源的候选里找第一张符合角色的图，覆盖 poster.jpg / fanart.jpg */
async function scSaveOne(dir, cands, role) {
  const imgDir = path.join(dir, 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const web = f => '/cache/movies/' + path.basename(dir) + '/images/' + f
  const PORTRAIT = sz => sz.h > sz.w * 1.06
  const LANDSCAPE = sz => sz.w > sz.h * 1.06
  const want = role === 'poster' ? PORTRAIT : LANDSCAPE
  const label = role === 'poster' ? '竖版海报' : '横版主图'
  // 够大就不再往后试（海报 ≥500 宽、主图 ≥1600 宽，与批量抓取同一套标准）
  const good = role === 'poster' ? (sz => sz.w >= 500) : (sz => sz.w >= 1600)
  // 规则给的候选里，靠前的不一定是清晰的那张（DMM 同一片有多种尺寸变体），
  // 所以试前几个、留面积最大的，而不是取第一个能用的
  const MAX_TRY = 5
  let best = null, attempt = 0, loose = null   // loose：接近正方形的兜底（JavDB 的 FC2 封面常是 1:1）
  for (const u of cands) {
    if (attempt >= MAX_TRY) break
    attempt++
    try {
      const b = await scFetch(u, { bin: true, hdrs: { referer: u } })
      if (b.length < 2500) throw new Error('图片太小')
      const fp = path.join(imgDir, '.tmp' + (Math.random() * 1e9 | 0) + '.jpg')
      fs.writeFileSync(fp, b)
      const sz = imgSize(fp)
      if (!sz) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('不是有效图片') }
      if (want(sz) && (!best || sz.w * sz.h > best.sz.w * best.sz.h)) {
        if (best) { try { fs.unlinkSync(best.fp) } catch (_) {} }
        best = { fp, sz, u }
        if (good(sz)) break
      } else {
        const ratio = sz.w / sz.h
        if (!want(sz) && ratio >= 0.85 && ratio <= 1.18 && (!loose || sz.w * sz.h > loose.sz.w * loose.sz.h)) {
          if (loose) { try { fs.unlinkSync(loose.fp) } catch (_) {} }
          loose = { fp, sz, u }
        } else { try { fs.unlinkSync(fp) } catch (_) {} }
      }
    } catch (_) {}
  }
  if (!best) best = loose
  if (!best) throw new Error('该来源没有可用的' + label)
  const dst = path.join(imgDir, role + '.jpg')
  fs.renameSync(best.fp, dst)
  let bytes = 0
  try { bytes = fs.statSync(dst).size } catch (_) {}
  scLog(label + '换源：' + best.sz.w + '×' + best.sz.h + ' ← ' + best.u.split('/').pop())
  return { url: web(role + '.jpg'), w: best.sz.w, h: best.sz.h, bytes }
}

/* ================= 批量图片升级：给缓存里低清的封面/主图换上更高清的候选 =================
 * 标准（与抓取链路的 pick 一致）：竖版封面宽 <500、横版主图宽 <1600 视为"待升级"；
 * 候选取 meta.sourceData 里各源已存的 posterCands / fanartCands（不必重新访问站点），
 * 下载候选择优（面积最大），只有真的比现状大才落盘，绝不降级。 */
const IMG_GOOD_W = { poster: 500, fanart: 1600 }
const IMGUP = { running: false, total: 0, done: 0, current: '', log: [], error: '', finishedAt: 0 }

/* 扫描缓存：返回待升级列表（低清且有候选且没试过白跑）、无候选需重刮、试过无更大的数量 */
function imgUpList() {
  const mdir = path.join(cacheDir(), 'movies')
  let dirs = []
  try { dirs = fs.readdirSync(mdir) } catch (_) {}
  const items = []
  let noCands = 0, noBetter = 0
  for (const d of dirs) {
    const m = readMovieCache(d)
    if (!m || !m.images) continue
    const pm = m.images.posterMeta && m.images.posterMeta.w ? m.images.posterMeta : null
    const fm = m.images.fanartMeta && m.images.fanartMeta.w ? m.images.fanartMeta : null
    /* 手动裁剪过的海报（posterManual）是用户亲自定的构图，不参与批量升级、也不算待升级 */
    /* poster 字段为空但 posterMeta 有残留（角色修复清图时留下的尺寸）→ 同样算待升级 */
    const pNeed = !m.images.posterManual && (!m.images.poster || !pm || pm.w < IMG_GOOD_W.poster)
    const fNeed = !fm || fm.w < IMG_GOOD_W.fanart
    if (!pNeed && !fNeed) continue
    const sd = m.sourceData || {}
    let np = 0, nf = 0
    const srcs = []
    for (const [id, s] of Object.entries(sd)) {
      const a = (s.posterCands || []).length, b = (s.fanartCands || []).length
      if (a || b) srcs.push(id)
      np += a; nf += b
    }
    const pUp = pNeed && np > 0 && !m.images.posterUpTried
    const fUp = fNeed && nf > 0 && !m.images.fanartUpTried
    if (!pUp && !fUp) {
      if (!np && !nf) noCands++      // 低清但没存任何候选 → 只能重刮
      else noBetter++                // 试过了，现有图已是候选里最大的
      continue
    }
    items.push({
      code: d, title: m.title || '',
      poster: pm ? pm.w + '×' + pm.h : '无', posterNeed: pNeed,
      fanart: fm ? fm.w + '×' + fm.h : '无', fanartNeed: fNeed,
      cands: (pUp ? np : 0) + (fUp ? nf : 0), srcs: srcs.slice(0, 3).join(', ')
    })
  }
  items.sort((a, b) => a.code.localeCompare(b.code))
  return { items, noCands, noBetter }
}

/* 单张升级：从候选里挑最大的符合朝向的图，仅当面积大于现状才覆盖；返回 {url,w,h,bytes} 或 null */
async function imgUpOne(dir, role, cands, curSz, log) {
  const imgDir = path.join(dir, 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const web = f => '/cache/movies/' + path.basename(dir) + '/images/' + f
  const PORTRAIT = sz => sz.h > sz.w * 1.06
  const LANDSCAPE = sz => sz.w > sz.h * 1.06
  const want = role === 'poster' ? PORTRAIT : LANDSCAPE
  const label = role === 'poster' ? '封面' : '主图'
  const goodW = IMG_GOOD_W[role]
  const area = sz => sz.w * sz.h
  let best = null, attempt = 0
  for (const u of cands) {
    if (best) {
      if (best.sz.w >= goodW) break                                   // 已达标准，不再抓
      if (curSz && area(best.sz) > area(curSz) && attempt >= 4) break // 已优于现状且试了 4 个，够了
    }
    if (attempt >= 6) break
    attempt++
    try {
      const b = await scFetch(u, { bin: true, hdrs: { referer: u } })
      if (b.length < 2500) throw new Error('图片太小')
      const fp = path.join(imgDir, '.up' + (Math.random() * 1e9 | 0) + '.jpg')
      fs.writeFileSync(fp, b)
      const sz = imgSize(fp)
      if (!sz) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('不是有效图片') }
      if (want(sz) && (!best || area(sz) > area(best.sz))) {
        if (best) { try { fs.unlinkSync(best.fp) } catch (_) {} }
        best = { fp, sz, u }
      } else { try { fs.unlinkSync(fp) } catch (_) {} }
    } catch (_) {}
  }
  if (!best) { log(label + '：候选里没有可用的图'); return { noBetter: true } }
  if (curSz && area(best.sz) <= area(curSz)) {
    try { fs.unlinkSync(best.fp) } catch (_) {}
    log(label + '：现有 ' + curSz.w + '×' + curSz.h + ' 已是候选里最大的，不动')
    return { noBetter: true }
  }
  const dst = path.join(imgDir, role + '.jpg')
  fs.renameSync(best.fp, dst)
  let bytes = 0
  try { bytes = fs.statSync(dst).size } catch (_) {}
  log(label + '：' + (curSz ? curSz.w + '×' + curSz.h + ' → ' : '') + best.sz.w + '×' + best.sz.h + ' ← ' + best.u.split('/').pop())
  return { url: web(role + '.jpg'), w: best.sz.w, h: best.sz.h, bytes }
}

/* 批量升级任务：逐番号 → 逐字段（封面/主图），日志走 scLog（把 SCRAPE.log 指到本任务） */
async function imgUpAsync(codes) {
  IMGUP.running = true; IMGUP.total = codes.length; IMGUP.done = 0; IMGUP.current = ''
  IMGUP.log = []; IMGUP.error = ''; IMGUP.finishedAt = 0
  const oldLog = SCRAPE.log
  SCRAPE.log = IMGUP.log   // scLog 直接写进本任务日志（与刮削任务互斥，见 start 入口守卫）
  const t0 = Date.now()
  try {
    for (const code of codes) {
      IMGUP.current = code
      const m = readMovieCache(code)
      if (!m) { scLog(code + '：离线数据里没有元数据，跳过'); IMGUP.done++; continue }
      const dir = path.join(cacheDir(), 'movies', code.replace(/[^\w.-]/g, '_'))
      const sd = m.sourceData || {}
      const pc = [], fc = [], seenP = new Set(), seenF = new Set()
      for (const s of Object.values(sd)) {
        for (const u of (s.posterCands || [])) if (!seenP.has(u)) { seenP.add(u); pc.push(u) }
        for (const u of (s.fanartCands || [])) if (!seenF.has(u)) { seenF.add(u); fc.push(u) }
      }
      /* DMM 图床直链也进候选池（站点抓不到，但图床直连可用）：老片子能借它把 100 多像素的小封面换成高清 */
      const dmmU = scDmmCdnCands(code)
      for (const u of dmmU.poster) if (!seenP.has(u)) { seenP.add(u); pc.push(u) }
      for (const u of dmmU.fanart) if (!seenF.has(u)) { seenF.add(u); fc.push(u) }
      if (!pc.length && !fc.length) { scLog(code + '：没有图片候选（需重新刮削才有），跳过'); IMGUP.done++; continue }
      scLog('—— ' + code + ' ——')
      const im = m.images = m.images || {}
      const curP = im.posterMeta && im.posterMeta.w ? im.posterMeta : null
      const curF = im.fanartMeta && im.fanartMeta.w ? im.fanartMeta : null
      let changed = false, marked = false
      const mark = role => { im[role + 'UpTried'] = new Date().toISOString(); marked = true }   // 已试过且候选里没有更大的
      try {
        if (!im.posterManual && (!im.poster || !curP || curP.w < IMG_GOOD_W.poster) && pc.length) {
          const r = await imgUpOne(dir, 'poster', pc, curP, scLog)
          if (r && r.noBetter) mark('poster')
          else if (r) { im.poster = r.url; im.posterMeta = { w: r.w, h: r.h, bytes: r.bytes }; im.posterSrc = '图片升级'; changed = true }
        }
        if (!im.poster && !im.posterManual) {   // 候选里也没有竖图 → 尝试从合拼封面拆出正封面当竖版海报
          if (await splitCoverPoster(im, path.join(dir, 'images'), pc, scLog)) { changed = true; delete im.posterUpTried }
        }
        if ((!curF || curF.w < IMG_GOOD_W.fanart) && fc.length) {
          const r = await imgUpOne(dir, 'fanart', fc, curF, scLog)
          if (r && r.noBetter) mark('fanart')
          else if (r) {
            im.fanart = r.url; im.fanartMeta = { w: r.w, h: r.h, bytes: r.bytes }; im.fanartSrc = '图片升级'; changed = true
            const rr = recropPosterWith(im, path.join(dir, 'images'), scLog)
            if (rr && !rr.ok) scLog(code + ' 海报重裁跳过：' + rr.reason)
          }
        }
      } catch (e) { scLog(code + ' 升级出错：' + e.message) }
      if (changed) {
        m.scrapedAt = new Date().toISOString()   // 改版本号，详情页/影片墙的图立即刷新
        delete im.posterUpTried; delete im.fanartUpTried
      }
      if (changed || marked) {
        try { fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true }); fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (_) {}
        mirrorMeta(code)
        if (changed) patchDataItem(code)
        if (changed) scLog('✓ ' + code + ' 完成')
      }
      IMGUP.done++
    }
    scLog('全部完成：' + codes.length + ' 个番号，用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
  } catch (e) {
    IMGUP.error = e.message
    scLog('失败：' + e.message)
  } finally {
    SCRAPE.log = oldLog
    IMGUP.running = false
    IMGUP.finishedAt = Date.now()
    console.log('[imgup]', codes.length, '个，', Date.now() - t0 + 'ms')
  }
}

/* ================= 按网站对比扫描：逐站在线拉候选图，与本地封面/主图对比尺寸·大小 =================
 * 只扫「该源留过候选」的番号；本地低于标准（封面宽<500 / 主图宽<1600）的角色才参与对比；
 * 每角色最多试 5 个候选（下载后量真实宽高），线上同朝向面积大于本地才算「可升级」并列出。
 * 结果只是清单，用户点「升级」才真正落盘（src-apply，绝不自动改图）。 */
const SRCSCAN = { running: false, sourceId: '', total: 0, done: 0, current: '', found: 0, results: [], log: [], error: '', finishedAt: 0 }

async function srcProbeImg(url) {   // → { w, h, bytes } 或 null（下载到内存量尺寸，不落盘）
  try {
    const b = await scFetch(url, { bin: true, hdrs: { referer: url } })
    if (!b || b.length < 2500) return null
    const fp = path.join(cacheDir(), 'movies', '.probe' + (Math.random() * 1e9 | 0) + '.jpg')
    try {
      fs.writeFileSync(fp, b)
      const sz = imgSize(fp)
      return sz ? { w: sz.w, h: sz.h, bytes: b.length } : null
    } finally { try { fs.unlinkSync(fp) } catch (_) {} }
  } catch (_) { return null }
}

async function srcScanAsync(sourceId) {
  SRCSCAN.running = true; SRCSCAN.sourceId = sourceId
  SRCSCAN.total = 0; SRCSCAN.done = 0; SRCSCAN.current = ''; SRCSCAN.found = 0
  SRCSCAN.results = []; SRCSCAN.log = []; SRCSCAN.error = ''; SRCSCAN.finishedAt = 0
  const oldLog = SCRAPE.log
  SCRAPE.log = SRCSCAN.log
  const t0 = Date.now()
  try {
    const mdir = path.join(cacheDir(), 'movies')
    let dirs = []
    try { dirs = fs.readdirSync(mdir) } catch (_) {}
    const jobs = []
    for (const d of dirs) {
      const m = readMovieCache(d)
      const s = m && m.sourceData && m.sourceData[sourceId]
      if (!s) continue
      if (!((s.posterCands || []).length || (s.fanartCands || []).length)) continue
      jobs.push({ code: d, m, s })
    }
    SRCSCAN.total = jobs.length
    scLog('按「' + sourceId + '」扫描：' + jobs.length + ' 个番号留有该源候选')
    for (const job of jobs) {
      if (!SRCSCAN.running) { scLog('已手动停止'); break }
      SRCSCAN.current = job.code
      const im = job.m.images || {}
      const curP = im.posterMeta && im.posterMeta.w ? im.posterMeta : null
      const curF = im.fanartMeta && im.fanartMeta.w ? im.fanartMeta : null
      const needP = !im.posterManual && (!curP || curP.w < IMG_GOOD_W.poster) && (job.s.posterCands || []).length
      const needF = (!curF || curF.w < IMG_GOOD_W.fanart) && (job.s.fanartCands || []).length
      if (!needP && !needF) { SRCSCAN.done++; continue }
      const imgDir = path.join(cacheDir(), 'movies', job.code.replace(/[^\w.-]/g, '_'), 'images')
      const localBytes = role => { try { return fs.statSync(path.join(imgDir, role + '.jpg')).size } catch (_) { return 0 } }
      for (const [role, need, cands, cur] of [['poster', needP, job.s.posterCands || [], curP], ['fanart', needF, job.s.fanartCands || [], curF]]) {
        if (!need) continue
        let best = null
        let tried = 0
        for (const u of cands) {
          if (tried >= 5) break
          tried++
          const sz = await srcProbeImg(u)
          if (!sz) continue
          const portrait = sz.h > sz.w * 1.06, landscape = sz.w > sz.h * 1.06
          if (role === 'poster' ? !portrait : !landscape) continue
          if (cur && sz.w * sz.h <= cur.w * cur.h) continue   // 不比本地大 → 不算可升级
          if (!best || sz.w * sz.h > best.w * best.h) best = Object.assign({ url: u }, sz)
          if (best.w >= IMG_GOOD_W[role]) break
        }
        if (best) {
          SRCSCAN.found++
          SRCSCAN.results.push({
            code: job.code, title: job.m.title || '', role, sourceId,
            local: { w: cur ? cur.w : 0, h: cur ? cur.h : 0, bytes: localBytes(role), url: im[role] || '' },
            online: best,
            /* 海报是按横版主图手动裁剪的 → 提示用户升级后会自动重裁 */
            recrop: role === 'fanart' && !!im.posterManual && !!(im.posterCrop && im.posterCrop.src === 'fanart')
          })
          scLog('△ ' + job.code + ' ' + (role === 'poster' ? '封面' : '主图') + '：本地 ' + (cur ? cur.w + '×' + cur.h : '无') + ' → 线上 ' + best.w + '×' + best.h)
        }
      }
      SRCSCAN.done++
    }
    scLog('扫描完成：' + SRCSCAN.done + '/' + SRCSCAN.total + ' 个番号，发现 ' + SRCSCAN.found + ' 张可升级，用时 ' + Math.round((Date.now() - t0) / 1000) + 's')
  } catch (e) {
    SRCSCAN.error = e.message
    scLog('失败：' + e.message)
  } finally {
    SCRAPE.log = oldLog
    SRCSCAN.running = false
    SRCSCAN.finishedAt = Date.now()
    console.log('[src-scan]', sourceId, SRCSCAN.found + ' 张，', Date.now() - t0 + 'ms')
  }
}

/* 手动裁剪海报的构图重放：横版主图升级成更高清后，用新图按存储的归一化裁剪框（posterCrop）自动重裁竖版海报。
 * 只处理底图是「横版主图」的裁剪（posterCrop.src==='fanart'）；失败静默返回原因，不影响主图升级本身。 */
function recropPosterWith(im, imgDir, log) {
  try {
    const c = im.posterCrop
    if (!im.posterManual || !c || c.src !== 'fanart') return null
    const fp = path.join(imgDir, 'fanart.jpg')
    if (!fs.existsSync(fp)) return { ok: false, reason: '本地没有横版主图文件' }
    const jpeg = require('jpeg-js')
    const raw = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 2048 })
    const px = Math.max(0, Math.min(raw.width - 8, Math.round((c.x || 0) * raw.width)))
    const py = Math.max(0, Math.min(raw.height - 8, Math.round((c.y || 0) * raw.height)))
    const pw = Math.max(16, Math.min(raw.width - px, Math.round((c.w || 0.66) * raw.width)))
    const ph = Math.max(16, Math.min(raw.height - py, Math.round((c.h || 1) * raw.height)))
    const data = Buffer.alloc(pw * ph * 4)
    for (let y = 0; y < ph; y++) {
      const src = ((py + y) * raw.width + px) * 4
      data.set(raw.data.subarray(src, src + pw * 4), y * pw * 4)   // jpeg-js 返回 Uint8Array，用 set 拷贝
    }
    const enc = jpeg.encode({ data, width: pw, height: ph }, 92)
    fs.writeFileSync(path.join(imgDir, 'poster.jpg'), enc.data)
    im.poster = '/cache/movies/' + path.basename(path.dirname(imgDir)) + '/images/poster.jpg'
    im.posterMeta = { w: pw, h: ph, bytes: enc.data.length, src: 'auto-recrop' }
    im.posterSrc = '自动重裁（横版主图升级后按原构图）'
    if (log) log('↻ 海报已按原构图自动重裁：' + pw + '×' + ph)
    return { ok: true, w: pw, h: ph, bytes: enc.data.length }
  } catch (e) { return { ok: false, reason: e.message } }
}

/* 扫描结果里点「升级」：下载该张线上图并落盘（仅当仍比本地大；手动裁剪的海报不允许覆盖） */
async function srcApplyOne(code, role, url) {
  if (!['poster', 'fanart'].includes(role)) throw new Error('角色不合法')
  const m = readMovieCache(code)
  if (!m) throw new Error('缓存里没有这部影片的元数据')
  const im = m.images = m.images || {}
  if (role === 'poster' && im.posterManual) throw new Error('该海报是手动裁剪的，不能自动覆盖')
  const b = await scFetch(url, { bin: true, hdrs: { referer: url } })
  if (!b || b.length < 2500) throw new Error('线上图片下载失败')
  const safe = code.replace(/[^\w.-]/g, '_')
  const imgDir = path.join(cacheDir(), 'movies', safe, 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const tmp = path.join(imgDir, '.sa' + (Math.random() * 1e9 | 0) + '.jpg')
  fs.writeFileSync(tmp, b)
  const sz = imgSize(tmp)
  if (!sz) { try { fs.unlinkSync(tmp) } catch (_) {} ; throw new Error('不是有效图片') }
  const PORTRAIT = s => s.h > s.w * 1.06, LANDSCAPE = s => s.w > s.h * 1.06
  if (role === 'poster' ? !PORTRAIT(sz) : !LANDSCAPE(sz)) { try { fs.unlinkSync(tmp) } catch (_) {} ; throw new Error('图片朝向与「' + (role === 'poster' ? '封面' : '主图') + '」不符') }
  const cur = im[role + 'Meta'] && im[role + 'Meta'].w ? im[role + 'Meta'] : null
  if (cur && sz.w * sz.h <= cur.w * cur.h) { try { fs.unlinkSync(tmp) } catch (_) {} ; throw new Error('本地已是更大版本，无需升级') }
  const dst = path.join(imgDir, role + '.jpg')
  fs.renameSync(tmp, dst)
  im[role] = '/cache/movies/' + safe + '/images/' + role + '.jpg'
  im[role + 'Meta'] = { w: sz.w, h: sz.h, bytes: b.length }
  im[role + 'Src'] = '按网站升级'
  m.scrapedAt = new Date().toISOString()
  /* 主图升级成功且海报是按主图手动裁剪的 → 用新主图按原构图自动重裁海报 */
  let recrop = null
  if (role === 'fanart') recrop = recropPosterWith(im, imgDir, null)
  try { fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true }); fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (_) {}
  mirrorMeta(code)
  patchDataItem(code)
  return Object.assign({ w: sz.w, h: sz.h, bytes: b.length }, recrop ? { recrop } : {})
}

/* ================= 候选图信息探测（下拉里显示「尺寸 · 大小」并与本地对比） =================
 * 各数据源在 meta.sourceData 里只留了候选图 URL，没留尺寸。这里把每个源每个角色的候选
 * （最多 CAND_MAX 张）下载后量真实宽高与字节数，结果缓存进 meta.imgCands 复用（重复开面板不再重下）。
 * 纯只读探测：只写 meta 的 imgCands 字段，不动任何图片文件。 */
const CANDINFO = { running: false, code: '', total: 0, done: 0, error: '', startedAt: 0, finishedAt: 0 }
const CANDCACHE = new Map()   // code|role → {at, data}，新老对比卡片的内存缓存（10 分钟）
const CAND_MAX = 2
function candJobsOf(m) {
  const out = []
  for (const [id, s] of Object.entries((m && m.sourceData) || {})) {
    for (const role of ['poster', 'fanart']) {
      const list = (role === 'poster' ? (s.posterCands || []) : (s.fanartCands || [])).slice(0, CAND_MAX)
      list.forEach((url, i) => out.push({ id, role, url, i }))
    }
  }
  return out
}
async function candProbeAsync(code, force) {
  const m = readMovieCache(code)
  if (!m) return
  CANDINFO.running = true; CANDINFO.code = code; CANDINFO.error = ''
  CANDINFO.total = 0; CANDINFO.done = 0; CANDINFO.startedAt = Date.now(); CANDINFO.finishedAt = 0
  try {
    const jobs = candJobsOf(m)
    CANDINFO.total = jobs.length
    const cache = m.imgCands = m.imgCands || {}
    for (const job of jobs) {
      const slot = (cache[job.id] = cache[job.id] || {})
      if (!force && slot[job.role]) { CANDINFO.done++; continue }   // 第一候选已量过
      const info = await srcProbeImg(job.url)
      if (info) {
        const key = job.i === 0 ? job.role : job.role + 'Alt'
        slot[key] = Object.assign({ url: job.url }, info)
        delete slot[job.role + 'Err']
      } else if (job.i === 0) {
        slot[job.role + 'Err'] = '下载失败或站点拒绝'
      }
      CANDINFO.done++
    }
    m.imgCandsAt = Date.now()
    try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (_) {}
  } catch (e) { CANDINFO.error = e.message }
  CANDINFO.running = false; CANDINFO.finishedAt = Date.now()
}
/* 本地图信息：优先 meta 里记的，缺了按磁盘文件实测（老缓存） */
function localImgInfo(m, role) {
  const im = (m && m.images) || {}
  const mt = im[role + 'Meta']
  let w = mt && mt.w ? mt.w : 0, h = mt && mt.h ? mt.h : 0, bytes = (mt && mt.bytes) || 0
  if (!w) {
    const u = im[role] || ''
    const mm = /^\/cache\/movies\/([^/?#]+)\/images\/([^/?#]+)/.exec(u)
    if (mm) {
      try {
        const fp = path.join(cacheDir(), 'movies', mm[1], 'images', mm[2])
        const sz = imgSize(fp)
        if (sz) { w = sz.w; h = sz.h; bytes = fs.statSync(fp).size }
      } catch (_) {}
    }
  }
  return w ? { url: im[role] || '', w, h, bytes } : null
}
function candInfoOut(code) {
  const m = readMovieCache(code) || {}
  return {
    local: { poster: localImgInfo(m, 'poster'), fanart: localImgInfo(m, 'fanart') },
    cands: m.imgCands || {}, at: m.imgCandsAt || 0,
    posterManual: !!(m.images && m.images.posterManual)
  }
}
/* 待升级行 / 下拉里的「新老对比」：对某番号现下候选（不走 meta 缓存）算最优候选，供行内卡片即时预览 */
async function bestCandOf(m, role) {
  const list = []
  for (const [id, s] of Object.entries(m.sourceData || {})) {
    const arr = (role === 'poster' ? (s.posterCands || []) : (s.fanartCands || [])).slice(0, CAND_MAX)
    const cached = ((m.imgCands || {})[id] || {})[role]
    if (cached) list.push(Object.assign({ id }, cached))
    else {
      const info = await srcProbeImg(arr[0])
      if (info) list.push(Object.assign({ id, url: arr[0] }, info))
    }
  }
  if (!list.length) return null
  const cur = localImgInfo(m, role)
  list.sort((a, b) => b.w * b.h - a.w * a.h)
  const best = list[0]
  return {
    best, all: list,
    better: !!(cur && best.w * best.h > cur.w * cur.h) || !cur
  }
}
async function scrapeAsync(job) {
  const t0 = Date.now()
  SCRAPE.running = true; SCRAPE.code = job.code; SCRAPE.phase = '准备'; SCRAPE.pct = 2
  SCRAPE.error = ''; SCRAPE.log = []; SCRAPE.finishedAt = 0; SCRAPE.title = ''
  const dir = path.join(cacheDir(), 'movies', job.code.replace(/[^\w.-]/g, '_'))
  const scTried = []      // 本次实际抓过的源：[{id, ok, reason}]，写进 meta 供详情页显示「数据源一览」
  let scSkipped = []      // 提前收工没来得及试的源 id
  try {
    if (job.nfo) {
      scLog('收到 NFO（' + job.nfo.length + ' 字节），落盘备查')
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'movie.nfo'), job.nfo) } catch (_) {}
    }
    let candidates
    if (job.url) {
      candidates = [{ id: 'custom', url: job.url, cookies: /mgstage\.com/i.test(job.url) ? 'adc=1' : '' }]
      scLog('指定网址模式，所有数据只从该网址抓取：' + job.url)
    } else {
      candidates = scCandidates(job.code, job.sourceId)
      scLog(`按数据源优先级排列 ${candidates.length} 个候选站点` + (job.sourceId ? '（指定：' + job.sourceId + '）' : ''))
    }
    if (!candidates.length) throw new Error('没有可用站点：请到 设置 → 数据源 启用带番号搜索模板的站点，或直接填该番号的详情页网址')
    let results = {}          // 每站解析结果（多源聚合，字段级择优）
    let got = null            // 第一个命中的源（source 字段展示用）
    let single = !!(job.url || job.sourceId)
    if (single) {
      // 单源模式：指定网址 / 指定站点，所有字段只从这一处取
      const r = await scTryCandidate(job.code, candidates[0])
      if (r && (r.title || '').trim()) {
        r.sourceId = job.url ? '指定网址' : job.sourceId
        /* 键用真实源 id（指定站点模式）——下面字段合并 scPickField 按 results[源id] 取值，
         * 之前误存成 custom 导致指定站点刮到的字段全部对不上号，落盘成「有记录没内容」的空壳 */
        results = { [job.url ? 'custom' : job.sourceId]: r }; got = r
        scTried.push({ id: job.url ? 'custom' : job.sourceId, ok: true })
        scLog(`✓ ${r.sourceId} 命中：《${got.title}》`)
      } else {
        /* 指定来源抓不到内容（典型：DMM 站点是 JS 渲染 + 地域封锁）——不直接报错，
         * 改按番号走多源刮削；DMM 的封面/主图仍由图床直链兜底补上 */
        scLog((job.url ? '指定网址' : job.sourceId) + '：这个页面抓不到可用信息（JS 渲染 / 反爬），改按番号「' + job.code + '」多源刮削')
        scTried.push({ id: job.url ? 'custom' : job.sourceId, ok: false, reason: '该页面抓不到可用信息（JS 渲染 / 反爬）' })
        job.url = ''; job.sourceId = ''; single = false
      }
    }
    if (!single) {
      // 多源聚合（MDC-NG 语义）：字段优先级站点先试，再按全局优先级补齐；核心字段齐了就提前收工
      const pri = getSourcesData().priorities
      const preferred = new Set()
      for (const bf of Object.values(SC_FIELD_MAP)) for (const id of ((pri.by_fields || {})[bf] || [])) preferred.add(id)
      const candIds = new Set(candidates.map(c => c.id))
      const triedSet = new Set()
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        triedSet.add(c.id)
        SCRAPE.phase = '抓取 ' + c.id; SCRAPE.pct = 6 + Math.round(54 * i / candidates.length)
        try {
          const r = await scTryCandidate(job.code, c)
          if (r) { results[c.id] = r; if (!got) { got = r; got.sourceId = c.id }; scLog(`✓ ${c.id} 命中：《${r.title}》`); scTried.push({ id: c.id, ok: true }) }
          else {
            /* DMM 特殊：站点内容由 JS 渲染 + 地域封锁，抓不到文字，但图床直链能用 ——
             * 这里说明清楚，别让用户以为整个刮削失败（封面/主图会在下载阶段从 dmm 图床补） */
            const dm = scDmmCdnCands(job.code)
            const dmOk = dm.poster.length || dm.fanart.length
            scLog(c.id + (dmOk && c.id === 'dmm' ? '：站点需 JS 渲染（抓不到文字），已改用图床直链补封面/主图' : '：页面不含该番号或没有可用信息'))
            scTried.push({ id: c.id, ok: false, reason: dmOk && c.id === 'dmm'
              ? '站点是 JS 渲染 + 地域封锁，抓不到文字信息；封面/主图已走 DMM 图床直链'
              : '该站页面里没有这个番号的信息（未收录 / 被反爬挡了）' })
          }
        } catch (e) { scLog(c.id + ' 失败：' + e.message); scTried.push({ id: c.id, ok: false, reason: e.message }) }
        if (got && !job.full && scCoreComplete(results, pri, candIds, triedSet)) {
          scLog('核心字段已齐，提前收工（已聚合 ' + Object.keys(results).length + ' 个源）')
          scSkipped = candidates.slice(i + 1).map(x => x.id)   // 没试的源：详情页「刮削内容」里可以按需补抓
          break
        }
      }
    }
    /* JavDB 线上源：HTML 站就算已命中也照跑一遍 —— 它常有独家封面/剧照（FC2、无码流出），
     * 而且元数据更全（评分、想看人数）。指定网址模式除外（用户明确只信那一个页面）。 */
    if (!job.url && !job.sourceId) {
      SCRAPE.phase = '抓取 javdb'
      try {
        const r = await onlineScrapeSource(job.code)
        if (r) { results.javdb = r; if (!got) { got = r; got.sourceId = 'javdb' }; scTried.push({ id: 'javdb', ok: true }); scLog('✓ javdb 命中：《' + r.title + '》（线上 ' + (r.reviewsCount || 0) + ' 条评价）') }
        else { scTried.push({ id: 'javdb', ok: false, reason: '线上搜不到这个番号' }); scLog('javdb：线上搜不到该番号') }
      } catch (e) { scTried.push({ id: 'javdb', ok: false, reason: e.message }); scLog('javdb 失败：' + e.message) }
    }
    if (!got) throw new Error('所有站点都未能获取到「' + job.code + '」的元数据（可能被站点反爬或番号不存在）。可尝试直接粘贴该番号的详情页网址。')
    SCRAPE.phase = '合并字段'; SCRAPE.pct = 60
    const pri = getSourcesData().priorities
    const pk = {}
    for (const f of SC_TEXT_FIELDS.concat(['actors', 'genres', 'poster', 'fanart', 'samples'])) pk[f] = scPickField(results, f, pri)
    /* 兜底：聚合择优没取到、但首个命中源里其实有 → 直接用它的（防止再出现「scraped:true 却全空」的空壳条目） */
    const fv = f => {
      if (pk[f]) return pk[f].v
      if (got) {
        const v = f === 'release' ? (got.date || got.release) : got[f]
        if (f === 'actors' || f === 'genres') return Array.isArray(v) && v.length ? v : []
        if (f === 'runtime') return v > 0 ? v : 0
        return v || ''
      }
      return f === 'actors' || f === 'genres' ? [] : f === 'runtime' ? 0 : ''
    }
    const fsr = f => pk[f] ? pk[f].src : ''
    SCRAPE.title = fv('title')   // 供「添加影片」批量进度逐条回显标题
    SCRAPE.phase = '下载图片'; SCRAPE.pct = 62
    /* 剧照：把所有源按优先级串起来（某源的图全挂了就顺延到下一个源），去重后交给下载循环 */
    const samplesAll = []
    for (const id of scFieldOrder('samples', pri)) {
      const r = results[id] || {}
      for (const s of (r.samples || [])) if (samplesAll.indexOf(s) < 0) samplesAll.push(s)
    }
    /* DMM 图床直链候选排在所有源之后：前面的源都拿不到图（或图全挂了）才轮到它，
     * 下载循环按序试，404/无效图自动跳过 —— 不给已有图的片子多下载无用的候选 */
    const dmmC = scDmmCdnCands(job.code)
    const imgs = await scSaveImages(dir, {
      posterCands: (pk.poster ? pk.poster.cands : []).concat(dmmC.poster),
      fanartCands: ((pk.fanart ? pk.fanart.cands : [])).concat(dmmC.fanart),
      samples: samplesAll.length ? samplesAll : (pk.samples ? pk.samples.cands : []).concat(dmmC.samples)
    })
    imgs.posterSrc = imgs.posterFromDmm ? 'dmm 图床' : fsr('poster'); imgs.fanartSrc = imgs.fanartFromDmm ? 'dmm 图床' : fsr('fanart'); imgs.samplesSrc = fsr('samples')
    delete imgs.posterFromDmm; delete imgs.fanartFromDmm
    SCRAPE.phase = '抓取磁力'; SCRAPE.pct = 86
    let magnets = []
    const old = readMovieCache(job.code)
    if (old && Array.isArray(old.magnets) && old.magnets.length) magnets = old.magnets
    else {
      try {
        const r = await movieDetail(job.code, true)
        if (r.ok && r.meta && Array.isArray(r.meta.magnets)) magnets = r.meta.magnets
      } catch (_) {}
    }
    const meta = {
      code: job.code, fetchedAt: new Date().toISOString(), scrapedAt: new Date().toISOString(),
      scraped: true,
      source: got.sourceId + (got.usedUrl ? ' · ' + got.usedUrl : ''),
      /* 本次数据源尝试记录：详情页「刮削内容」列出全部源及其状态，未试过的可按需补抓 */
      scrapeTried: { tried: scTried, skipped: scSkipped },
      title: fv('title'), plot: fv('plot'), year: (fv('release') || '').slice(0, 4),
      studio: fv('studio'), publisher: fv('publisher'), series: fv('series'), director: fv('director'),
      release: fv('release'), runtime: fv('runtime'), actors: fv('actors'), genres: fv('genres'),
      magnets, images: imgs,
      /* 逐字段来源标注（MDC-NG 多源聚合）：每项 { v: 值, src: 来源站点 id }，详情页可单独换源 */
      fields: {
        title: { v: fv('title'), src: fsr('title') },
        plot: { v: fv('plot'), src: fsr('plot') },
        release: { v: fv('release'), src: fsr('release') },
        runtime: { v: fv('runtime'), src: fsr('runtime') },
        studio: { v: fv('studio'), src: fsr('studio') },
        publisher: { v: fv('publisher'), src: fsr('publisher') },
        series: { v: fv('series'), src: fsr('series') },
        director: { v: fv('director'), src: fsr('director') },
        actors: { v: fv('actors'), src: fsr('actors') },
        genres: { v: fv('genres'), src: fsr('genres') },
        year: { v: (fv('release') || '').slice(0, 4), src: fsr('release') }
      },
      sourceData: {}
    }
    for (const [id, r] of Object.entries(results)) {
      meta.sourceData[id] = {
        usedUrl: r.usedUrl || '', title: r.title || '', plot: r.plot || '',
        studio: r.studio || '', publisher: r.publisher || '', series: r.series || '', director: r.director || '',
        release: r.date || r.release || '', runtime: r.runtime || 0,
        actors: r.actors || [], genres: r.genres || [],
        samples: (r.samples || []).slice(0, 6),
        posterCands: (r.posterCands || []).slice(0, 6),
        fanartCands: (r.fanartCands || []).slice(0, 6)
      }
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    mirrorMeta(job.code)   // 设置了封面/元数据目录 → 镜像一份（视频与封面分离）
    patchDataItem(job.code)   // 并回内存条目：本地影片详情/系列页立刻见新数据
    /* 设置里开了「刮削后自动整理」→ 顺手把这个番号的视频原地整理成 <番号>/<番号>-标签.ext */
    if (CFG.autoOrganize === true) {
      const og = autoOrganizeCode(job.code)
      if (og.moved.length) { scLog('已自动整理 ' + og.moved.length + ' 个文件：' + og.moved.map(m => m.to).join('、')); rescan() }
      else if (og.failed.length) scLog('自动整理跳过：' + og.failed.map(f => f.file + '（' + f.msg + '）').join('、'))
    }
    SCRAPE.pct = 100; SCRAPE.phase = '完成'
    scLog(`完成：《${got.title}》 竖版封面${imgs.poster ? '✓' : '✕'} 横版主图${imgs.fanart ? '✓' : '✕'} 剧照 ${imgs.samples.length} 张 磁力 ${magnets.length} 条`)
  } catch (e) {
    SCRAPE.error = e.message
    scLog('失败：' + e.message)
  } finally {
    SCRAPE.running = false; SCRAPE.finishedAt = Date.now()
    console.log('[scrape]', job.code, SCRAPE.error ? '失败: ' + SCRAPE.error : 'OK', Date.now() - t0 + 'ms')
  }
}
/* 已刮削影片（无本地文件的虚拟条目，混进 data.json / 详情查找） */
function scrapedVirtualItems() {
  const mdir = path.join(cacheDir(), 'movies')
  let es = []
  try { es = fs.readdirSync(mdir, { withFileTypes: true }) } catch (_) { return [] }
  const out = []
  for (const e of es) {
    if (!e.isDirectory()) continue
    const meta = readMovieCache(e.name)
    if (!meta || !meta.scraped || !meta.title) continue
    const imgs = meta.images || {}
    out.push({
      code: meta.code || e.name, title: meta.title, plot: meta.plot || '',
      year: meta.year || (meta.release || '').slice(0, 4),
      studio: meta.studio || '', publisher: meta.publisher || '', series: meta.series || '', director: meta.director || '',
      actors: meta.actors || [], genres: meta.genres || [],
      relVideo: '', relFanart: null, relPoster: null, relSamples: [],
      tags: videoTagsOf('', 0, 0, (meta.title || '') + ' ' + (meta.genres || []).join(' ')),
      webPoster: withVer(imgs.poster, meta), webFanart: withVer(imgs.fanart, meta), webSamples: (imgs.samples || []).map(u => withVer(u, meta)),
      release: meta.release || '', runtime: meta.runtime || 0,
      size: 0, mtime: Date.parse(meta.scrapedAt || '') || 0, virtual: true,
      scraped: true, scrapedAt: meta.scrapedAt || meta.fetchedAt || '',
      scrapeFields: !!(meta.fields || meta.scraped)   // 刮削过 → 详情页显示「刮削内容」入口（可逐源补抓，不必整部重刮）
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
function allItems() { return ((DATA && DATA.items) || []).concat(scrapedVirtualItems()) }

/* 同番号多版本合并：破解/中字/无码等同一番号的多个视频文件归为一条（files 数组带每个文件的路径/大小/独立标签）。
 * 其余字段取代表条目（已刮削的优先）；徽章取各文件并集（保序去重）；size 求和、mtime 取最大、pending/hidden/scraped 任一为真即为真。 */
const fileOf = it => ({ relVideo: it.relVideo, size: it.size || 0, mtime: it.mtime || 0, tags: it.tags || [] })
function mergeCodeGroup(list) {
  if (list.length === 1) return Object.assign({}, list[0], { files: [fileOf(list[0])] })
  /* 主文件 = 已刮削的里面体积最大的（原版通常最大，-U/-C 转制版较小）；全未刮削则取最大 */
  const pool = list.filter(x => x.scraped)
  const g = Object.assign({}, (pool.length ? pool : list).slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0] || list[0])
  for (const k of ['relFanart', 'relPoster', 'webPoster', 'webFanart']) {
    if (!g[k]) { const v = list.find(x => x[k]); if (v) g[k] = v[k] }
  }
  if (!(g.relSamples || []).length) { const v = list.find(x => (x.relSamples || []).length); if (v) g.relSamples = v.relSamples }
  if (!(g.webSamples || []).length) { const v = list.find(x => (x.webSamples || []).length); if (v) g.webSamples = v.webSamples }
  const seen = new Set(); const tags = []
  for (const x of list) for (const t of (x.tags || [])) if (!seen.has(t)) { seen.add(t); tags.push(t) }
  g.tags = tags
  g.size = list.reduce((s, x) => s + (x.size || 0), 0)
  g.mtime = Math.max.apply(null, list.map(x => x.mtime || 0))
  for (const k of ['hidden', 'pending', 'scraped', 'scrapeFields']) g[k] = list.some(x => x[k])
  g.scrapedAt = list.map(x => x.scrapedAt || '').sort().pop() || ''
  g.files = list.map(fileOf)
  return g
}
function groupByCode(items) {
  const groups = new Map(); const ordered = []
  for (const it of items) {
    const k = bare(it.code) || '\x00' + (it.relVideo || it.code)   // 解析不出番号的条目各自独立
    let a = groups.get(k)
    if (!a) { a = []; groups.set(k, a); ordered.push(a) }
    a.push(it)
  }
  return ordered.map(mergeCodeGroup)
}

/* ---------- 订阅：本地订阅单 + 线上新作聚合 ----------
 * 订阅对象三种（早期借鉴 db_online 的 subscription_videos.source_type）：
 *   actor  女优 —— 线上按名字找到该女优，拉她的作品
 *   series 系列 —— 番号前缀（P:MIDE）或系列名（S:真性中出し），线上按关键词查
 *   code   番号 —— 盯单个番号（看有没有新磁力 / 新版本）
 * 结果与本地媒体库对比，只留「线上有、本机没有」的 → 就是待入库的新作。 */
let SUB_FEED = { at: 0, data: null }
const SUB_FEED_TTL = 300000
/* ---------- 订阅「自动入库」：开了开关的订阅，检查到线上新作后自动刮进离线数据 ----------
 * 默认关闭 —— 订阅只负责「发现」，要不要入媒体库由用户逐条决定；开关在订阅列表里改。 */
const AUTO_INGEST = { running: false, queue: [], done: 0, total: 0, current: '', ok: 0, fail: 0 }
async function autoIngestRun() {
  if (AUTO_INGEST.running) return
  AUTO_INGEST.running = true
  try {
    while (AUTO_INGEST.queue.length) {
      const code = AUTO_INGEST.queue.shift()
      AUTO_INGEST.current = code
      if (SCRAPE.running) { await new Promise(s => setTimeout(s, 3000)); AUTO_INGEST.queue.unshift(code); continue }   // 用户手动刮削优先
      let already = false
      try { const m = readMovieCache(code); already = !!(m && m.scraped) } catch (_) {}
      if (already) { AUTO_INGEST.done++; AUTO_INGEST.ok++; continue }   // 已有离线数据就不重复刮
      try { await scrapeAsync({ code }) } catch (_) {}
      if (SCRAPE.error) AUTO_INGEST.fail++; else AUTO_INGEST.ok++
      AUTO_INGEST.done++
    }
  } finally { AUTO_INGEST.running = false; AUTO_INGEST.current = '' }
}
function autoIngestQueue(codes) {
  const q = AUTO_INGEST.queue
  for (const c of codes) if (c && !q.includes(c)) q.push(c)
  if (!q.length) return
  AUTO_INGEST.total = q.length + AUTO_INGEST.done
  autoIngestRun().catch(() => {})
}

async function subsFeed(force) {
  if (!force && SUB_FEED.data && Date.now() - SUB_FEED.at < SUB_FEED_TTL) return SUB_FEED.data
  const subs = Array.isArray(CFG.subscriptions) ? CFG.subscriptions : []
  const local = new Set()
  for (const it of ((DATA && DATA.items) || [])) if (it.code) local.add(bare(it.code))
  for (const it of scrapedVirtualItems()) if (it.code) local.add(bare(it.code))
  const all = [], subOut = []
  let firstErr = ''
  for (const s of subs) {
    const rec = { id: s.id, kind: s.kind, name: s.name, query: s.query || s.name, active: s.active !== false, matched: 0, fresh: 0, onlineId: '', note: '' }
    if (!rec.active) { subOut.push(rec); continue }
    let movies = []
    try {
      if (s.kind === 'actor') {
        /* 线上没有「按女优取作品」的接口，用搜索（搜索会匹配女优名）拉前两页 */
        const a = await onlineActorFind(s.name).catch(() => null)
        if (a) rec.onlineId = a.id
        const acc = []
        for (const pg of [1, 2]) {
          const j = await onlineGet('v2/search?q=' + encodeURIComponent(s.name) + '&type=movie&page=' + pg)
          const list = ((j || {}).data || {}).movies || []
          acc.push.apply(acc, list)
          if (list.length < 10) break
        }
        if (!a && !acc.length) rec.note = '线上搜不到这位女优'
        movies = acc.map(onlineMovie)
      } else {
        const j = await onlineGet('v2/search?q=' + encodeURIComponent(rec.query) + '&type=movie&page=1')
        movies = (((j || {}).data || {}).movies || []).map(onlineMovie)
      }
    } catch (e) {
      rec.note = e.message; firstErr = firstErr || e.message
      subOut.push(rec); continue
    }
    rec.matched = movies.length
    const seen = new Set()
    for (const m of movies) {
      const b = bare(m.code)
      if (!b || seen.has(b)) continue
      seen.add(b)
      if (local.has(b) || m.inLibrary) continue
      rec.fresh++
      all.push(Object.assign({}, m, { subId: s.id, subKind: s.kind, subName: s.name }))
    }
    s.lastCheckedAt = new Date().toISOString()
    subOut.push(rec)
  }
  const uniq = new Map()
  for (const x of all) {
    const k = bare(x.code)
    if (!uniq.has(k)) uniq.set(k, x)
    else if (!uniq.get(k).subName.includes(x.subName)) uniq.get(k).subName += ' / ' + x.subName
  }
  const items = [...uniq.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  /* 自动入库：开了开关的订阅 → 把这批新作的番号排进后台刮削队列（默认一条都不会自动入） */
  const autoCodes = []
  for (const s of subs) {
    if (s.autoIngest !== true || s.active === false) continue
    for (const x of items) if (x.subId === s.id && x.code) autoCodes.push(x.code)
  }
  if (autoCodes.length) autoIngestQueue(autoCodes)
  const oc = onlineCfg()
  const data = {
    ok: true, at: Date.now(), items, subs: subOut, error: firstErr,
    online: { enabled: oc.enabled, lines: oc.lines, active: JDB_LINE_OK },
    stats: { subs: subs.length, active: subs.filter(x => x.active !== false).length, fresh: items.length, local: local.size },
    autoIngest: { running: AUTO_INGEST.running, pending: AUTO_INGEST.queue.length, done: AUTO_INGEST.done, total: AUTO_INGEST.total, current: AUTO_INGEST.current, ok: AUTO_INGEST.ok, fail: AUTO_INGEST.fail }
  }
  SUB_FEED = { at: Date.now(), data }
  try { writeCfg() } catch (_) {}
  return data
}

async function handleActorApi(req, res, p) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  if (p === '/api/config') {
    if (req.method === 'GET') return json(res, {
      proxy: CFG.proxy || '', proxyEnabled: CFG.proxyEnabled !== false,
      cacheDir: CFG.cacheDir || '', metaMode: CFG.metaMode === 'inline' ? 'inline' : '',
      autoOrganize: CFG.autoOrganize === true, rankAuto: CFG.rankAuto !== false,
      rankHour: rankHour(), rankUpdatedAt: rankUpdatedAt(), rankRunning: RANKUP.running,
      autoScrapeNew: CFG.autoScrapeNew !== false,
      autoRescan: CFG.autoRescan === true, autoRescanHour: autoRescanHour(), autoRescanLast: autoRescanLast(),
      accessOn: !!ACCESS_CODE(),
      mounts: containerMounts(), mediaRoot: MEDIA_ROOT
    })
    // 各字段独立保存：body 里带哪个就更新哪个，互不覆盖
    if ('autoOrganize' in body) CFG.autoOrganize = !!body.autoOrganize
    if ('autoScrapeNew' in body) CFG.autoScrapeNew = !!body.autoScrapeNew
    if ('autoRescan' in body) CFG.autoRescan = !!body.autoRescan
    if ('autoRescanHour' in body) CFG.autoRescanHour = Math.max(0, Math.min(23, parseInt(body.autoRescanHour, 10) || 0))
    if ('rankAuto' in body) CFG.rankAuto = !!body.rankAuto
    if ('rankHour' in body) CFG.rankHour = Math.max(0, Math.min(23, parseInt(body.rankHour, 10) || 0))
    if ('proxy' in body) {
      const pv = String(body.proxy || '').trim()
      if (pv && !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(pv)) return json(res, { ok: false, error: '代理格式应为 http://host:port，留空表示直连' })
      CFG.proxy = pv
      proxyAgents.clear()   // 让下一次请求立即使用新代理
    }
    if ('proxyEnabled' in body) {
      CFG.proxyEnabled = !!body.proxyEnabled
      proxyAgents.clear()
    }
    if ('githubToken' in body) {   // GitHub PAT：私有仓库的 relay/ 中转数据经 Contents API 读取
      CFG.githubToken = String(body.githubToken || '').trim()
      relayCache.clear()
    }
    if ('cacheDir' in body) {
      const cd = String(body.cacheDir || '').trim()
      if (cd && !cd.startsWith('/')) return json(res, { ok: false, error: '请填写容器内的绝对路径（如 /media/cache 或 /app/cache），留空用默认 cache/' })
      CFG.cacheDir = cd
      try { fs.mkdirSync(path.join(cacheDir(), 'movies'), { recursive: true }); fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }) } catch (_) {}
    }
    if ('metaMode' in body) {
      CFG.metaMode = body.metaMode === 'inline' ? 'inline' : ''   // 旧版 dir 模式已并入缓存（缓存目录本身可改）
    }
    if ('accessCode' in body) {
      const ac = String(body.accessCode || '').trim()
      if (ac && ac.length < 4) return json(res, { ok: false, error: '口令至少 4 位（留空 = 关闭口令）' })
      CFG.accessCode = ac        // 留空即关闭
    }
    try { writeCfg() } catch (e) { return json(res, { ok: false, error: '写入配置失败：' + e.message }) }
    return json(res, {
      ok: true, proxy: CFG.proxy || '', proxyEnabled: CFG.proxyEnabled !== false,
      cacheDir: CFG.cacheDir || '', metaMode: CFG.metaMode === 'inline' ? 'inline' : '',
      autoOrganize: CFG.autoOrganize === true, autoScrapeNew: CFG.autoScrapeNew !== false,
      autoRescan: CFG.autoRescan === true, autoRescanHour: autoRescanHour(), autoRescanLast: autoRescanLast(),
      rankAuto: CFG.rankAuto !== false, rankHour: rankHour(),
      rankUpdatedAt: rankUpdatedAt(), rankRunning: RANKUP.running
    })
  }
  /* ---------- UI 偏好（项目内置配置）：存 server-config.json 的 uiPrefs ----------
   * 女优页等页面的视图/排序/筛选/每页数量与可视化编辑参数都落在这里，
   * 随项目一起备份、换容器也在；前端仍用 localStorage 做即时缓存。 */
  if (p === '/api/prefs') {
    if (req.method === 'GET') return json(res, { ok: true, prefs: CFG.uiPrefs && typeof CFG.uiPrefs === 'object' ? CFG.uiPrefs : {}, updatedAt: CFG.uiPrefsAt || 0 })
    const inp = body.prefs && typeof body.prefs === 'object' ? body.prefs : null
    if (!inp) return json(res, { ok: false, error: '缺少 prefs' })
    const cur = CFG.uiPrefs && typeof CFG.uiPrefs === 'object' ? CFG.uiPrefs : {}
    let n = 0
    for (const [k, v] of Object.entries(inp)) {
      const key = String(k).slice(0, 60)
      if (!key) continue
      if (v === null || v === undefined) { delete cur[key]; n++; continue }
      const sv = typeof v === 'string' ? v.slice(0, 4000) : JSON.stringify(v).slice(0, 4000)
      if (cur[key] === sv) continue
      cur[key] = sv; n++
    }
    CFG.uiPrefs = cur
    CFG.uiPrefsAt = Date.now()
    try { writeCfg() } catch (e) { return json(res, { ok: false, error: '写入配置失败：' + e.message }) }
    return json(res, { ok: true, saved: n, prefs: cur, updatedAt: CFG.uiPrefsAt })
  }
  /* ---------- 播放进度 / 观看历史 ----------
   * GET  /api/watch          → 全量历史（前端启动时拉一次，主页「继续观看」/ 卡片进度条都用它）
   * POST /api/watch          → 回报进度 { key, pos, dur }
   * POST /api/watch/del      → 删一条 { key } 或清空 { all:true }
   * POST /api/watch/done     → 手动标记已看/未看 { key, done }
   */
  if (p === '/api/watch') {
    if (req.method === 'GET') return json(res, { ok: true, watch: WATCH })
    const key = watchKeyOf(body.key)
    if (!key || key.includes('..')) return json(res, { ok: false, error: '缺少 key' })
    /* 只设片头结束点（不带 pos）：不动进度和时间戳 */
    if (body.pos === undefined && body.intro !== undefined) {
      const old = WATCH[key] || { p: 0, d: 0, t: Date.now(), n: 1 }
      const intro = Math.max(0, Math.min(900, Number(body.intro) || 0))
      if (intro > 0) old.intro = Math.round(intro * 10) / 10; else delete old.intro
      WATCH[key] = old; watchSaveSoon()
      return json(res, { ok: true, rec: old })
    }
    const pos = Math.max(0, Number(body.pos) || 0)
    const dur = Math.max(0, Number(body.dur) || 0)
    const old = WATCH[key]
    const rec = { p: Math.round(pos * 10) / 10, d: Math.round(dur * 10) / 10, t: Date.now(), n: old && old.n ? old.n : 1 }
    if (old && old.done) rec.done = 1
    if (old && old.intro) rec.intro = old.intro
    // 从头开始（进度 < 5 秒）且是旧记录 → 算新的一次播放
    if (old && pos < 5) rec.n = (old.n || 0) + 1
    /* 真实观看时长：wt = 距上次回报实际播放的秒数；按日累积进 days（统计页用）。
     * 不带 wt 的回报（比如别处只同步进度）也要把老记录的累计带上，否则会被抹掉。 */
    rec.wt = (old && old.wt) || 0
    rec.days = (old && old.days) || {}
    const wt = Math.max(0, Math.min(600, Number(body.wt) || 0))
    if (wt > 0) {
      rec.wt = Math.round((rec.wt + wt) * 10) / 10
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || '')) ? body.day : new Date().toISOString().slice(0, 10)
      rec.days[day] = Math.round((((rec.days[day] || 0)) + wt) * 10) / 10
    }
    if (!(rec.wt > 0)) delete rec.wt
    if (!Object.keys(rec.days).length) delete rec.days
    WATCH[key] = rec
    watchTrim(); watchSaveSoon()
    return json(res, { ok: true, rec })
  }
  if (p === '/api/watch/del') {
    if (body.all) { WATCH = {}; watchSaveSoon(); return json(res, { ok: true }) }
    const key = watchKeyOf(body.key)
    if (!key) return json(res, { ok: false, error: '缺少 key' })
    delete WATCH[key]; watchSaveSoon()
    return json(res, { ok: true })
  }
  if (p === '/api/watch/done') {
    const key = watchKeyOf(body.key)
    if (!key) return json(res, { ok: false, error: '缺少 key' })
    const old = WATCH[key] || { p: 0, d: 0, t: Date.now(), n: 1 }
    if (body.done === false) { delete old.done } else { old.done = 1; if (old.d) old.p = old.d }
    old.t = Date.now()
    WATCH[key] = old; watchTrim(); watchSaveSoon()
    return json(res, { ok: true, rec: old })
  }
  /* ---------- 我的收藏（影片 / 女优 / 系列，落 server-config.json，换机同步） ---------- */
  if (p === '/api/favorites') {
    const F = () => {
      const f = (CFG.favorites && typeof CFG.favorites === 'object') ? CFG.favorites : {}
      return {
        movies: Array.isArray(f.movies) ? f.movies : [],
        actresses: Array.isArray(f.actresses) ? f.actresses : [],
        series: Array.isArray(f.series) ? f.series : []
      }
    }
    if (req.method === 'GET') return json(res, { ok: true, favorites: F() })
    if (body.favorites && typeof body.favorites === 'object') {    // 全量替换（浏览器本地收藏一次性迁移上来）
      const cur = F()
      const clean = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 5000)
      CFG.favorites = { movies: clean((body.favorites.movies || []).concat(cur.movies)), actresses: clean((body.favorites.actresses || []).concat(cur.actresses)), series: clean((body.favorites.series || []).concat(cur.series)) }
      writeCfg()
      return json(res, { ok: true, favorites: CFG.favorites, merged: true })
    }
    const kind = ['movies', 'actresses', 'series'].includes(body.kind) ? body.kind : ''
    const id = String(body.id || '').trim()
    if (!kind || !id) return json(res, { ok: false, error: '缺少 kind / id' })
    const f = F(), set = new Set(f[kind])
    const on = body.on === undefined ? !set.has(id) : !!body.on
    on ? set.add(id) : set.delete(id)
    f[kind] = [...set]
    CFG.favorites = f
    writeCfg()
    return json(res, { ok: true, kind, id, on, favorites: f })
  }
  /* ---------- 订阅单（本地增删改；线上数据只读，不动 NAS） ---------- */
  if (p === '/api/subscriptions') {
    const subs = () => Array.isArray(CFG.subscriptions) ? CFG.subscriptions : []
    if (req.method === 'GET') { const oc = onlineCfg(); return json(res, { ok: true, subs: subs(), online: { enabled: oc.enabled, lines: oc.lines, active: JDB_LINE_OK } }) }
    const action = String(body.action || '')
    const list = subs().slice()
    if (action === 'add') {
      const kind = ['actor', 'series', 'code'].includes(body.kind) ? body.kind : 'actor'
      const name = String(body.name || '').trim()
      const query = String(body.query || name).trim()
      if (!name) return json(res, { ok: false, error: '请填写订阅对象' })
      if (list.some(x => x.kind === kind && String(x.name) === name)) return json(res, { ok: true, subs: list, dup: true })
      const rec = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind, name, query,
        quality: String(body.quality || ''), requireSub: !!body.requireSub, requireUncensored: !!body.requireUncensored,
        minSizeMb: Number(body.minSizeMb) || 0, maxSizeMb: Number(body.maxSizeMb) || 0,
        autoIngest: !!body.autoIngest,      // 自动入库：默认关。开了才会把该订阅的线上新作自动刮进离线数据
        note: String(body.note || '').slice(0, 300),
        active: true, createdAt: new Date().toISOString(), lastCheckedAt: ''
      }
      list.push(rec); CFG.subscriptions = list; writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: list, added: rec })
    }
    if (action === 'remove') {
      const id = String(body.id || '')
      CFG.subscriptions = list.filter(x => x.id !== id)
      writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: CFG.subscriptions })
    }
    if (action === 'toggle') {
      const id = String(body.id || '')
      CFG.subscriptions = list.map(x => x.id === id ? Object.assign({}, x, { active: !(x.active !== false) }) : x)
      writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: CFG.subscriptions })
    }
    if (action === 'update') {
      const id = String(body.id || '')
      const patch = {}
      if (body.kind !== undefined && ['actor', 'series', 'code'].includes(body.kind)) patch.kind = body.kind
      ;['name', 'query', 'quality', 'note'].forEach(k => { if (body[k] !== undefined) patch[k] = String(body[k]) })
      ;['requireSub', 'requireUncensored', 'autoIngest'].forEach(k => { if (body[k] !== undefined) patch[k] = !!body[k] })
      ;['minSizeMb', 'maxSizeMb'].forEach(k => { if (body[k] !== undefined) patch[k] = Number(body[k]) || 0 })
      CFG.subscriptions = list.map(x => x.id === id ? Object.assign({}, x, patch) : x)
      writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: CFG.subscriptions })
    }
    if (action === 'feed-reset') { SUB_FEED = { at: 0, data: null }; return json(res, { ok: true }) }
    return json(res, { ok: false, error: '未知操作：' + action })
  }
  /* 订阅 → 线上新作（线上有、本机没有的） */
  if (p === '/api/subscriptions/feed') {
    const force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'
    try { return json(res, await subsFeed(force)) }
    catch (e) { return json(res, { ok: false, error: e.message, items: [], subs: [], stats: { subs: 0, active: 0, fresh: 0, local: 0 } }) }
  }
  /* ---------- 线上数据源（JavDB 国内直连）只读代理 ---------- */
  if (p === '/api/online/status') {
    const c = onlineCfg()
    const out = { ok: true, enabled: c.enabled, lines: c.lines, img: c.img, active: JDB_LINE_OK }
    if (!c.enabled) return json(res, out)
    out.probe = []
    for (const base of c.lines) {
      const t0 = Date.now()
      try {
        const r = await fetch(base + '/api/v1/movies/latest?filter_by=magnets&limit=1&page=1&sort_by=update&type=all', {
          signal: AbortSignal.timeout(8000),
          headers: { jdsignature: jdbSign(), 'User-Agent': 'Dart/3.5 (dart:io)', 'Accept-Language': 'zh-TW', Accept: 'application/json' }
        })
        const j = await r.json().catch(() => null)
        out.probe.push({ base, ok: r.ok && !!(j && j.success), status: r.status, ms: Date.now() - t0 })
        if (r.ok && j && j.success) JDB_LINE_OK = base
      } catch (e) { out.probe.push({ base, ok: false, error: e.message, ms: Date.now() - t0 }) }
    }
    out.reachable = out.probe.some(x => x.ok)
    if (out.reachable) { try { out.stats = (((await onlineGet('v1/movies/latest?filter_by=magnets&limit=24&page=1&sort_by=update&type=all')) || {}).data || {}).pagination || null } catch (_) {} }
    out.error = out.reachable ? '' : ((out.probe[0] && (out.probe[0].error || ('HTTP ' + out.probe[0].status))) || '线路均不可用')
    return json(res, out)
  }
  /* 前端用的路径词汇 → JavDB 端点：
   *   path=latest            → /api/v1/movies/latest（最新入库）
   *   path=search&q=q=xxx    → /api/v2/search（按关键词）
   *   path=v1/… / v2/…       → 原样透传 */
  function mapOnlinePath(rel, extra) {
    const [head, ...rest] = rel.split('?')
    const tail = rest.join('?')
    const join = (a, b) => a + (b ? (a.includes('?') ? '&' : '?') + b : '')
    if (head === 'latest') {
      const qs = new URLSearchParams({ filter_by: 'magnets', limit: '24', page: '1', sort_by: 'update', type: 'all' })
      new URLSearchParams(String(extra || tail || '').replace(/^\?/, '')).forEach((v, k) => { if (k) qs.set(k, v) })
      return 'v1/movies/latest?' + qs.toString()
    }
    if (head === 'search') {
      const ex = extra || tail
      const qs = new URLSearchParams(String(ex).replace(/^\?/, ''))
      const q = qs.get('q') || ''
      const page = qs.get('page') || '1'
      const type = qs.get('type') || 'movie'
      return 'v2/search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type) + '&page=' + encodeURIComponent(page)
    }
    return join(rel, extra)
  }
  if (p === '/api/online/proxy') {
    const q = new URL(req.url, 'http://x')
    const rel = onlineAllowedPath(q.searchParams.get('path') || 'latest')
    if (!rel) return json(res, { ok: false, error: '不允许的线上路径' })
    const full = mapOnlinePath(rel, q.searchParams.get('q') || '')
    try {
      const j = await onlineGet(full)
      return json(res, { ok: true, data: (j && j.data !== undefined) ? j.data : j })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* 线上详情 / 评论：给「订阅里点进来的线上影片」与详情页评论区用（像客户端一样看影评）。
   * 评论 = JavDB v1/movies/{id}/reviews，按番号先搜一次拿到线上 id。
   * 注意：这个端点是「最热影评预览」，一次固定只回 6 条 —— page / limit / per_page / offset /
   * last_id / p / current 等分页参数全试过，翻页一律拿不到更多（page≥2 返回空数组）。所以
   * total 用详情里的 reviews_count（真实总条数），前端如实标成「最热 6 条 · 共 N 条」。 */
  if (p === '/api/online/detail' || p === '/api/online/reviews') {
    const q = new URL(req.url, 'http://x')
    const code = String(q.searchParams.get('code') || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    try {
      const s = await onlineScrapeSource(code)
      if (!s) return json(res, { ok: false, error: '线上搜不到「' + code + '」' })
      if (p === '/api/online/detail') return json(res, { ok: true, code, onlineId: s.onlineId, movie: s })
      const pg = Math.max(1, parseInt(q.searchParams.get('page') || '1', 10) || 1)
      const j = await onlineGet('v1/movies/' + s.onlineId + '/reviews?page=' + pg)
      const list = (((j || {}).data || {}).reviews || []).map(x => ({
        id: x.id, user: x.username || '', watched: Number(x.watched_count) || 0,
        status: x.status_title || '', score: Number(x.score) || 0,
        content: x.content || '', likes: Number(x.likes_count) || 0, at: x.created_at || ''
      }))
      return json(res, { ok: true, code, page: pg, reviews: list, total: s.reviewsCount || 0, score: s.score || '', onlineId: s.onlineId })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* 线上榜单：kind=latest（最近更新，可换排序/类型/翻页）
   *           kind=ranking（官方排行榜，type=0~3 × period=daily/weekly/monthly/yearly） */
  if (p === '/api/online/board') {
    const q = new URL(req.url, 'http://x')
    const kind = String(q.searchParams.get('kind') || 'latest')
    try {
      if (kind === 'ranking' || kind === 'top250') {
        const r = await boardRanking(q.searchParams.get('type'), q.searchParams.get('period'))
        if (!r.movies.length) return json(res, { ok: false, error: '官方榜单拉取失败：线上线路不可用或返回为空' })
        return json(res, Object.assign({ ok: true, kind: 'ranking', total: r.movies.length, meta: BOARD_META }, r))
      }
      const r = await boardLatest(q.searchParams.get('sort'), parseInt(q.searchParams.get('page') || '1', 10) || 1, q.searchParams.get('type'))
      return json(res, Object.assign({ ok: true, kind: 'latest', sorts: BOARD_SORTS, meta: BOARD_META }, r))
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/online/config') {
    const view = c => ({ ok: true, enabled: c.enabled, lines: c.lines, img: c.img, active: JDB_LINE_OK })
    if (req.method === 'GET') return json(res, view(onlineCfg()))
    const o = Object.assign({}, (CFG.online && typeof CFG.online === 'object') ? CFG.online : {})
    if ('enabled' in body) o.enabled = !!body.enabled
    if ('lines' in body) {
      const arr = String(Array.isArray(body.lines) ? body.lines.join('\n') : (body.lines || ''))
        .split(/[\s,]+/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
      for (const b of arr) if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(b)) return json(res, { ok: false, error: '线路地址格式应为 https://host' })
      o.lines = arr
      JDB_LINE_OK = ''
    }
    if ('img' in body) {
      const b = String(body.img || '').trim().replace(/\/+$/, '')
      if (b && !/^https?:\/\/[\w.-]+(:\d+)?$/.test(b)) return json(res, { ok: false, error: '图片源地址格式应为 https://host' })
      o.img = b
    }
    delete o.base; delete o.key                      // 旧版 db_online 配置残留，清掉
    CFG.online = o; writeCfg(); SUB_FEED = { at: 0, data: null }
    return json(res, view(onlineCfg()))
  }
  /* ---------- JavDB 线上搜索（独立搜索模块用）：v2/search 逐页代理 ---------- */
  if (p === '/api/online/search') {
    const uq = new URL(req.url, 'http://x')
    const qs = String((body && body.q) || uq.searchParams.get('q') || '').trim()
    const pg = Math.max(1, parseInt((body && body.page) || uq.searchParams.get('page') || '1', 10) || 1)
    if (!qs) return json(res, { ok: false, error: '请输入搜索关键词（番号 / 片名 / 女优）' })
    try {
      const j = await onlineGet('v2/search?q=' + encodeURIComponent(qs) + '&type=movie&page=' + pg)
      const d = (j || {}).data || {}
      const movies = (d.movies || []).map(m => ({
        id: m.id || '', code: m.number || m.code || '', title: m.title || m.origin_title || '',
        thumb: m.thumb_url || '', cover: m.cover_url || '',
        date: m.release_date || '', duration: Number(m.duration) || 0,
        score: m.score || '', magnets: Number(m.magnets_count || m.magnet_count) || 0,
        hasSub: !!(m.has_cnsub || m.has_subtitle), maker: m.maker_name || ''
      })).filter(x => x.code || x.title)
      return json(res, { ok: true, q: qs, page: pg, movies, total: (d.pagination && (d.pagination.total != null ? d.pagination.total : d.pagination.count)) || movies.length })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* ---------- 115 离线推送 ----------
   * 配置 = cookie + savepath/cid/cidName（推送目标文件夹）+ timeout。
   * 协议走 115 网页版接口：
   *   1. GET  https://115.com/web/lixian/?ct=lixian&ac=get_id            → userkey（签名密钥，新版可能不给）
   *   2. sign = sha1(uid + sha1(userkey + sha1('115' + time)))           → 115 官方签名算法
   *   3. POST https://115.com/web/lixian/?ct=lixian&ac=add_task_url      → {url, savepath, sign, time, uid}
   *   目录列表 https://webapi.115.com/files?cid=&show_dir=1              → 目标文件夹下拉
   *   任务列表 https://clouddownload.115.com/web/?ac=task_lists          → 推送结果查验
   * 推到 115 指定文件夹后，本地挂载这个文件夹，重扫媒体库即可入库。 */
  function pan115Cfg() {
    const o = (CFG.pan115 && typeof CFG.pan115 === 'object') ? CFG.pan115 : {}
    return { cookie: String(o.cookie || '').trim(), savepath: String(o.savepath || '').trim(), cid: String(o.cid || '').trim(), cidName: String(o.cidName || '').trim(), timeout: Number(o.timeout) || 20 }
  }
  function pan115Request(url, { method = 'GET', form = null, timeout } = {}) {
    return new Promise((resolve, reject) => {
      const c = pan115Cfg()
      const to = (timeout || c.timeout || 20) * 1000
      let u
      try { u = new URL(url) } catch (e) { return reject(new Error('URL 无效')) }
      const mod = u.protocol === 'http:' ? http : https
      const payload = form ? Object.entries(form).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : null
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method,
        headers: Object.assign({
          'Cookie': c.cookie,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Referer': 'https://115.com/web/lixian/',
          'Accept': 'application/json, text/plain, */*'
        }, payload ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Length': Buffer.byteLength(payload) } : {})
      }, rsp => {
        const chunks = []
        rsp.on('data', d => chunks.push(d))
        rsp.on('end', () => {
          const buf = Buffer.concat(chunks)
          let j = null
          try { j = JSON.parse(buf.toString('utf8')) } catch (_) {}
          resolve({ status: rsp.statusCode, json: j, text: buf.toString('utf8').slice(0, 500) })
        })
      })
      req.setTimeout(to, () => { req.destroy(new Error('请求超时（' + (to / 1000) + 's）—— 115 没有响应，检查 cookie 是否失效')) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  const sha1hex = s => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex')
  /* 115 签名：sign = sha1(uid + sha1(userkey + sha1('115' + time)))；uid 取 cookie 的 UID 段或 get_id 返回 */
  function pan115Sign(userkey, time, uid) {
    const u = uid || (pan115Cfg().cookie.match(/UID=(\d+)/i) || [])[1] || ''
    return { uid: u, sign: sha1hex(u + sha1hex(userkey + sha1hex('115' + time))) }
  }
  async function pan115GetId() {
    const r = await pan115Request('https://115.com/web/lixian/?ct=lixian&ac=get_id')
    const j = r.json
    if (!j || !j.userkey) {
      /* 115 改版（2026-09 实测）：get_id 现在只返回 {cid, dest_cid}，不再下发 userkey ——
       * 而实测 add_task_url 不带 sign 也能成功提交（cookie 对就行），所以缺 userkey 不再算失败，
       * 只有请求本身出错（非 200 / JSON 解析失败）才报 cookie 问题 */
      const uid = (pan115Cfg().cookie.match(/UID=(\d+)/i) || [])[1] || ''
      if (r.status === 200 && j) return { userkey: '', uid, destCid: String(j.dest_cid || '') }
      const reason = (j && (j.error || j.errorMsg)) || (r.status !== 200 ? 'HTTP ' + r.status : '返回里没有 userkey')
      throw new Error('验证 115 失败（' + reason + '）—— 大概率 cookie 失效，去 115 网页版重新复制')
    }
    return { userkey: String(j.userkey), uid: String(j.user_id != null ? j.user_id : ((pan115Cfg().cookie.match(/UID=(\d+)/i) || [])[1] || '')), destCid: String(j.dest_cid || '') }
  }
  async function pan115AddOne(magnet) {
    /* 目标目录用 wp_path_id（目录 cid，与网页版行为一致：落在所选目录 + 按任务建子文件夹）。
     * 不要用 savepath 字符串——它相对 115 默认离线目录（dest_cid，如「云下载」）解析，
     * 且会平铺文件不建任务文件夹（2026-09 实测踩坑）。 */
    const cid = pan115Cfg().cid
    let id = null
    try { id = await pan115GetId() } catch (e) { id = { err: e.message } }
    const time = Math.floor(Date.now() / 1000)
    const form = { url: magnet, time: String(time) }
    if (cid) form.wp_path_id = cid
    const uid = (id && id.uid) || (pan115Cfg().cookie.match(/UID=(\d+)/i) || [])[1] || ''
    if (uid) form.uid = uid
    if (id && id.userkey) form.sign = pan115Sign(id.userkey, time, uid).sign
    const r = await pan115Request('https://115.com/web/lixian/?ct=lixian&ac=add_task_url', { method: 'POST', form })
    const j = r.json
    if (j && j.state === true) return { ok: true, name: (j.info && (j.info.name || j.info.url)) || '' }
    const msg = (j && (j.error || j.errorMsg || j.error_msg)) || r.text || ('HTTP ' + r.status)
    // 签名相关失败自动降级：不带 sign 再试一次（部分端点仍接受无签名提交）
    if (/sign|签名|验证/i.test(String(msg))) {
      const form2 = { url: magnet, time: String(time) }
      if (cid) form2.wp_path_id = cid
      if (uid) form2.uid = uid
      const r2 = await pan115Request('https://115.com/web/lixian/?ct=lixian&ac=add_task_url', { method: 'POST', form: form2 })
      const j2 = r2.json
      if (j2 && j2.state === true) return { ok: true, name: (j2.info && (j2.info.name || j2.info.url)) || '' }
      return { ok: false, error: String((j2 && (j2.error || j2.errorMsg)) || r2.text || '签名提交失败').slice(0, 200) }
    }
    return { ok: false, error: String(msg).slice(0, 200) }
  }
  if (p === '/api/115/config') {
    if (req.method === 'GET') {
      const c = pan115Cfg()
      return json(res, { ok: true, hasCookie: !!c.cookie, savepath: c.savepath, cid: c.cid, cidName: c.cidName, timeout: c.timeout })
    }
    const o = Object.assign({}, (CFG.pan115 && typeof CFG.pan115 === 'object') ? CFG.pan115 : {})
    if ('cookie' in body) o.cookie = String(body.cookie || '').trim()
    if ('savepath' in body) o.savepath = String(body.savepath || '').trim()
    if ('cid' in body) o.cid = String(body.cid || '').trim()
    if ('cidName' in body) o.cidName = String(body.cidName || '').trim()
    if ('timeout' in body) o.timeout = Math.max(5, Math.min(120, parseInt(body.timeout, 10) || 20))
    CFG.pan115 = o; writeCfg()
    const c = pan115Cfg()
    return json(res, { ok: true, hasCookie: !!c.cookie, savepath: c.savepath, cid: c.cid, cidName: c.cidName, timeout: c.timeout })
  }
  if (p === '/api/115/dirs') {   // 目标文件夹下拉：列出 cid 下的子目录 + 面包屑路径
    const q = new URL(req.url, 'http://x')
    const cid = (q.searchParams.get('cid') || '0').replace(/[^\d]/g, '') || '0'
    if (!pan115Cfg().cookie) return json(res, { ok: false, error: '还没有填写 115 cookie' })
    try {
      const r = await pan115Request('https://webapi.115.com/files?cid=' + cid + '&show_dir=1&limit=1000&o=user_ptime&asc=0&format=json')
      const j = r.json
      if (!j || j.state !== true) {
        const msg = (j && (j.error || j.errorMsg || j.errNo)) || ('HTTP ' + r.status)
        return json(res, { ok: false, error: '读取目录失败（' + msg + '）' })
      }
      const dirs = (j.data || []).filter(x => x && x.pid !== undefined && x.cid !== undefined && x.n)
        .map(x => ({ cid: String(x.cid), name: x.n, cnt: Number(x.m) || 0 }))
      const path = (j.path || []).map(p2 => ({ cid: String(p2.cid), name: p2.name || '' }))
      return json(res, { ok: true, cid, dirs, path })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/115/test') {   // 验证 cookie：主验证走任务列表（cookie 有效必返回 state:true + 配额），get_id 只作补充
    const c = pan115Cfg()
    if (!c.cookie) return json(res, { ok: false, error: '还没有填写 115 cookie' })
    try {
      const tr = await pan115Request('https://clouddownload.115.com/web/?ac=task_lists&page=1&page_size=1&stat=1')
      const tj = tr.json
      if (!tj || tj.state !== true) {
        const msg = (tj && (tj.error || tj.errorMsg || tj.errtype)) || ('HTTP ' + tr.status + (tr.text ? ' ' + tr.text.slice(0, 80) : ''))
        return json(res, { ok: false, error: 'cookie 无效或已过期（' + msg + '）—— 去 115 网页版重新复制（要含 UID/CID/SEID）' })
      }
      let id = null
      try { id = await pan115GetId() } catch (_) {}
      const uid = (id && id.uid) || (c.cookie.match(/UID=(\d+)/i) || [])[1] || ''
      /* 任务列表自带离线配额：quota=已用，total=总量（2026-09 实测 {"quota":1421,"total":1500}） */
      const quota = tj.total ? { total: tj.total, used: tj.quota } : null
      return json(res, { ok: true, uid, signed: !!(id && id.userkey), destCid: (id && id.destCid) || '', savepath: c.savepath, cid: c.cid, cidName: c.cidName, quota })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/115/push') {   // 推送磁力：body { code, magnets: [..] }
    const c = pan115Cfg()
    if (!c.cookie) return json(res, { ok: false, error: '还没有配置 115 推送（设置 → 115 离线推送）' })
    const magnets = (Array.isArray(body.magnets) ? body.magnets : [body.magnet]).map(s => String(s || '').trim()).filter(Boolean)
    if (!magnets.length) return json(res, { ok: false, error: '没有可推送的磁力链接' })
    const results = []
    for (const m of magnets) { try { results.push(Object.assign({ magnet: m }, await pan115AddOne(m))) } catch (e) { results.push({ magnet: m, ok: false, error: e.message }) } }
    const okN = results.filter(r => r.ok).length
    return json(res, { ok: okN > 0, code: String(body.code || ''), pushed: okN, total: magnets.length, results, savepath: c.savepath })
  }
  if (p === '/api/115/tasks') {   // 离线任务列表（设置页查验推送结果）
    const c = pan115Cfg()
    if (!c.cookie) return json(res, { ok: false, error: '还没有填写 115 cookie' })
    try {
      const r = await pan115Request('https://clouddownload.115.com/web/?ac=task_lists&page=1&page_size=20&stat=1')
      const j = r.json
      if (!j || j.state === false) return json(res, { ok: false, error: (j && (j.error || j.errorMsg)) || '115 返回异常' })
      const tasks = (j.tasks || []).map(t => ({ name: t.name || '', status: t.status, percent: t.percent || 0, addtime: t.addtime || '' }))
      return json(res, { ok: true, tasks, count: (j.count != null ? j.count : tasks.length) })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/online/image') {   // 线上封面/剧照直取（封面本身就在国内 CDN 上）
    const q = new URL(req.url, 'http://x')
    const u = q.searchParams.get('u') || ''
    if (!u) { res.writeHead(400); return res.end('bad image path') }
    try {
      const r = await onlineImageGet(u)
      const ct = /^image\//i.test(r.type || '') ? r.type : 'image/jpeg'   // 线上源有时不给 image/*，统一兜底
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': r.buf.length, 'Cache-Control': 'public, max-age=86400' })
      return res.end(r.buf)
    } catch (_) { res.writeHead(404); return res.end('Not Found') }
  }
  /* ---------- 外挂字幕：找同目录同名字幕，srt/ass 现场转成 WebVTT 再喂给 <track>（浏览器只认 vtt） ---------- */
  if (p === '/api/subs') {
    const rel = String(body.rel || '')
    const fp = safeMediaPath(rel)
    const out = []
    if (fp) {
      const dir = path.dirname(fp)
      const base = path.basename(fp, path.extname(fp))
      const SUB_EXT = ['.vtt', '.srt', '.ass', '.ssa', '.sub']
      let names = []
      try { names = fs.readdirSync(dir) } catch (_) { names = [] }
      const vids = names.filter(n => VIDEO_EXT.includes(extOf(n)))
      for (const n of names) {
        const e = path.extname(n).toLowerCase()
        if (!SUB_EXT.includes(e)) continue
        const sb = path.basename(n, e)
        if (!(sb === base || sb.startsWith(base) || base.startsWith(sb))) continue
        // 同目录还有别的影片、且这条字幕明确属于别的影片名 → 跳过
        if (vids.some(v => v !== path.basename(fp) && path.basename(v, path.extname(v)) === sb)) continue
        out.push({ name: n, ext: e.slice(1), url: '/api/subs/get?rel=' + encodeURIComponent(path.posix.join(path.dirname(rel), n)) })
      }
      out.sort((a, b) => (a.ext === 'vtt' ? -1 : 1) - (b.ext === 'vtt' ? -1 : 1))
    }
    return json(res, { ok: true, subs: out })
  }
  if (p === '/api/subs/get') {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('rel') || '')
    const fp = safeMediaPath(rel)
    let raw = ''
    try { raw = fp ? fs.readFileSync(fp, 'utf8') : '' } catch (_) { raw = '' }
    if (!raw) { res.writeHead(404); return res.end('Not Found') }
    const txt = subToVtt(raw, path.extname(fp).toLowerCase())
    const b = Buffer.from(txt)
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
    return res.end(b)
  }
  /* ---------- 回收站：删除 = 影片文件夹移进所在库的 _trash/（扫描会跳过），可还原或彻底删除 ----------
   * 注意 /media/测试 这类独立挂载和 /media 不是同一块设备，rename 会 EXDEV —— 所以回收站
   * 跟着影片所在的顶层库走：/media/_trash、/media/测试/_trash，保证同盘移动。
   * GET               → 回收站列表 { name, size, videos, mtime, base }
   * POST {codes}      → 删除（WATCH key 前缀跟着迁移）
   * POST {restore}    → 还原到所在库根目录
   * POST {purge}      → 彻底删除（不可恢复） */
  if (p === '/api/trash') {
    const trashRoots = () => {
      const roots = [path.join(MEDIA_ROOT, '_trash')]
      try {
        for (const lib of (LIBS || [])) { const t = path.join(lib, '_trash'); if (!roots.includes(t)) roots.push(t) }
        /* DATA 里可能还有别的顶层目录（手动加过的库） */
        ;(DATA && DATA.items || []).forEach(it => {
          const rel = it.relVideo || (it.files && it.files[0] && it.files[0].relVideo) || ''
          const top = rel.split('/')[0]
          if (top && !top.startsWith('_trash')) { const t = path.join(MEDIA_ROOT, top, '_trash'); if (!roots.includes(t)) roots.push(t) }
        })
      } catch (_) {}
      return roots.filter(r => { try { return fs.statSync(path.dirname(r)).isDirectory() } catch (_) { return false } })
    }
    if (req.method === 'GET') {
      let out = []
      for (const root of trashRoots()) {
        let names = []
        try { names = fs.readdirSync(root).filter(n => n !== '_trash' && !n.startsWith('.')) } catch (_) { continue }
        for (const n of names) {
          const fp = path.join(root, n)
          let size = 0, m = 0, vids = 0
          try { m = fs.statSync(fp).mtimeMs } catch (_) {}
          try {
            const walkT = d => fs.readdirSync(d).forEach(x => {
              const xp = path.join(d, x)
              let s; try { s = fs.statSync(xp) } catch (_) { return }
              if (s.isDirectory()) return walkT(xp)
              size += s.size
              if (VIDEO_EXT.includes(extOf(x))) vids++
            })
            walkT(fp)
          } catch (_) {}
          out.push({ name: n, size, videos: vids, mtime: m, base: root })
        }
      }
      out.sort((a, b) => b.mtime - a.mtime)
      return json(res, { ok: true, items: out })
    }
    if (body.restore) {
      const name = String(body.restore).replace(/[/\\]/g, '')
      let src = null
      for (const root of trashRoots()) { const c = path.join(root, name); if (fs.existsSync(c)) { src = c; break } }
      if (!name || !src) return json(res, { ok: false, error: '回收站里没有：' + name })
      const dst = path.join(path.dirname(path.dirname(src)), name)   // 库的 _trash → 该库根目录
      if (fs.existsSync(dst)) return json(res, { ok: false, error: '目标已有同名文件夹：' + name })
      try {
        fs.renameSync(src, dst)
        const oldPrefix = path.relative(MEDIA_ROOT, src).split(path.sep).join('/')
        const newPrefix = path.relative(MEDIA_ROOT, dst).split(path.sep).join('/')
        /* 内存里的 DATA 指向也要跟着改，否则重扫完成前再删一次会找不到 */
        const remapD = r => typeof r === 'string' && (r === oldPrefix || r.startsWith(oldPrefix + '/')) ? newPrefix + r.slice(oldPrefix.length) : r
        ;(DATA && DATA.items || []).forEach(x => {
          const rv = x.relVideo || (x.files && x.files[0] && x.files[0].relVideo) || ''
          if (!rv || !(rv === oldPrefix || rv.startsWith(oldPrefix + '/'))) return
          x.relVideo = remapD(x.relVideo)
          if (Array.isArray(x.files)) x.files.forEach(f => { f.relVideo = remapD(f.relVideo) })
          if (Array.isArray(x.relSamples)) x.relSamples = x.relSamples.map(remapD)
          x.trashed = false
        })
        Object.keys(WATCH).forEach(k => { if (k === oldPrefix || k.startsWith(oldPrefix + '/')) { WATCH[newPrefix + k.slice(oldPrefix.length)] = WATCH[k]; delete WATCH[k] } })
        watchSaveSoon()
        try { rescan() } catch (_) {}
        return json(res, { ok: true, restored: name, to: newPrefix })
      } catch (e) { return json(res, { ok: false, error: '还原失败：' + e.message }) }
    }
    if (body.purge) {
      const name = String(body.purge).replace(/[/\\]/g, '')
      let src = null
      for (const root of trashRoots()) { const c = path.join(root, name); if (fs.existsSync(c)) { src = c; break } }
      if (!name || !src) return json(res, { ok: false, error: '回收站里没有：' + name })
      try { fs.rmSync(src, { recursive: true, force: true }) } catch (e) { return json(res, { ok: false, error: '删除失败：' + e.message }) }
      const pref = path.relative(MEDIA_ROOT, src).split(path.sep).join('/') + '/'
      Object.keys(WATCH).forEach(k => { if (k.startsWith(pref)) delete WATCH[k] })
      watchSaveSoon()
      /* 彻底删除时元数据/图片的离线番号文件夹也一并清掉 */
      const offSafe = String(name).replace(/[^\w.-]/g, '_')
      try { fs.rmSync(path.join(cacheDir(), 'movies', offSafe), { recursive: true, force: true }) } catch (_) {}
      return json(res, { ok: true, purged: name })
    }
    const codes = (Array.isArray(body.codes) ? body.codes : []).map(x => String(x || '').trim()).filter(Boolean)
    if (!codes.length) return json(res, { ok: false, error: '没有要删除的影片' })
    const trashed = [], skipped = [], offline = []
    const sameDev = (a, b) => { try { return fs.statSync(a).dev === fs.statSync(b).dev } catch (_) { return false } }
    for (const c of codes) {
      const it = (DATA && Array.isArray(DATA.items) ? DATA.items : []).find(x => bare(x.code) === bare(c))
      const offDir = offlineCodeDir(c, it)   // 传进来的可能是 uKey 形态，按候选名/反查定位真实文件夹
      const rel = it && (it.relVideo || (it.files && it.files[0] && it.files[0].relVideo))
      const fp = rel && safeMediaPath(rel)
      const dir = fp && path.dirname(fp)
      /* 线上条目（库里没有视频文件）：不碰视频，只清掉离线数据文件夹（meta.json / 图片 / 磁力缓存）。
       * 该条目就是由这个文件夹派生出来的，删掉文件夹它自然从影片库消失。 */
      if (!dir || dir === MEDIA_ROOT) {
        let had = false
        try { if (fs.existsSync(offDir)) { fs.rmSync(offDir, { recursive: true, force: true }); had = true } }
        catch (e) { skipped.push({ code: c, reason: '离线数据删除失败：' + e.message }); continue }
        if (DATA && Array.isArray(DATA.items)) DATA.items = DATA.items.filter(x => bare(x.code) !== bare(c))
        if (had) offline.push({ code: c })
        else skipped.push({ code: c, reason: '既没有视频文件夹，也没有离线数据' })
        continue
      }
      if (!dir.startsWith(MEDIA_ROOT + path.sep) || /(^|\/)_trash(\/|$)/.test(path.relative(MEDIA_ROOT, dir))) { skipped.push({ code: c, reason: '路径异常' }); continue }
      const name = path.basename(dir)
      /* 找一块和影片同盘的回收站：顶层库根 / 所属库根 */
      let trashDir = null
      const cands = []
      const topSeg = path.relative(MEDIA_ROOT, dir).split(path.sep)[0]
      cands.push(path.join(MEDIA_ROOT, topSeg, '_trash'))
      for (const lib of (LIBS || [])) if (dir.startsWith(lib + path.sep) || dir === lib) cands.push(path.join(lib, '_trash'))
      cands.push(path.join(MEDIA_ROOT, '_trash'))
      for (const t of cands) {
        try { fs.mkdirSync(t, { recursive: true }) } catch (_) { continue }
        if (sameDev(dir, t)) { trashDir = t; break }
      }
      if (!trashDir) { skipped.push({ code: c, reason: '找不到同盘的回收站目录（挂载只读？）' }); continue }
      const dst = path.join(trashDir, name)
      if (fs.existsSync(dst)) { skipped.push({ code: c, reason: '回收站已有同名文件夹：' + name }); continue }
      /* 同文件夹里还有别的影片 → 不整体搬，让用户先单独整理 */
      const siblings = (DATA.items || []).filter(x => bare(x.code) !== bare(c)).some(x => {
        const r2 = x.relVideo || (x.files && x.files[0] && x.files[0].relVideo)
        return r2 && path.dirname(safeMediaPath(r2) || '') === dir
      })
      if (siblings) { skipped.push({ code: c, reason: '文件夹「' + name + '」里还有别的影片' }); continue }
      try {
        fs.renameSync(dir, dst)
        const oldPrefix = path.relative(MEDIA_ROOT, dir).split(path.sep).join('/')
        const newPrefix = path.relative(MEDIA_ROOT, dst).split(path.sep).join('/')
        const remap = r => typeof r === 'string' && (r === oldPrefix || r.startsWith(oldPrefix + '/')) ? newPrefix + r.slice(oldPrefix.length) : r
        ;(DATA.items || []).forEach(x => {
          if (bare(x.code) !== bare(c)) return
          x.relVideo = remap(x.relVideo)
          if (Array.isArray(x.files)) x.files.forEach(f => { f.relVideo = remap(f.relVideo) })
          if (Array.isArray(x.relSamples)) x.relSamples = x.relSamples.map(remap)
          x.trashed = true
        })
        Object.keys(WATCH).forEach(k => { const nk = remap(k); if (nk !== k) { WATCH[nk] = WATCH[k]; delete WATCH[k] } })
        watchSaveSoon()
        trashed.push({ code: c, name })
        /* 移进回收站的同时，把元数据/图片的离线番号文件夹一并删掉（还原后重新刮一次即可） */
        try { fs.rmSync(offDir, { recursive: true, force: true }) } catch (_) {}
      } catch (e) { skipped.push({ code: c, reason: e.message }) }
    }
    try { rescan() } catch (_) {}
    return json(res, { ok: true, trashed, skipped, offline })
  }
  /* ---------- NFO 回写：详情页编辑的标题/简介/年份/厂商/导演/评分/类别写回 Kodi 格式 NFO ---------- */
  if (p === '/api/nfo/write') {
    const rel = String(body.rel || '')
    const fp = safeMediaPath(rel)
    if (!fp) return json(res, { ok: false, error: '路径越界' })
    const dir = path.dirname(fp), base = path.basename(fp, path.extname(fp))
    let nfo = null
    const cands = [path.join(dir, base + '.nfo'), path.join(dir, path.basename(dir) + '.nfo')]
    try { const first = fs.readdirSync(dir).find(n => extOf(n) === 'nfo'); if (first) cands.push(path.join(dir, first)) } catch (_) {}
    for (const c of cands) { try { if (c && extOf(c) === 'nfo' && fs.statSync(c).isFile()) { nfo = c; break } } catch (_) {} }
    if (!nfo) return json(res, { ok: false, error: '影片目录里没有 NFO 文件' })
    let xml = fs.readFileSync(nfo, 'utf8')
    const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const setTag = (x, tag, val) => {
      const re = new RegExp('[ \\t]*<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>\\r?\\n?', 'g')
      const line = '  <' + tag + '>' + escXml(val) + '</' + tag + '>\n'
      if (re.test(x)) return x.replace(new RegExp(re.source, 'g'), line)
      return x.replace(/(<\/movie>\s*)$/, line + '$1')
    }
    const pa = body.patch && typeof body.patch === 'object' ? body.patch : {}
    if ('title' in pa) xml = setTag(xml, 'title', String(pa.title).slice(0, 300))
    if ('plot' in pa) xml = setTag(xml, 'plot', String(pa.plot).slice(0, 4000))
    if ('year' in pa) xml = setTag(xml, 'year', String(pa.year).slice(0, 12))
    if ('studio' in pa) xml = setTag(xml, 'studio', String(pa.studio).slice(0, 120))
    if ('director' in pa) xml = setTag(xml, 'director', String(pa.director).slice(0, 120))
    if ('rating' in pa && pa.rating !== '' && pa.rating != null) xml = setTag(xml, 'rating', String(Number(pa.rating) || 0))
    if (Array.isArray(pa.genres)) {
      xml = xml.replace(/[ \t]*<genre(?:\s[^>]*)?>[\s\S]*?<\/genre>\r?\n?/g, '')
      const lines = pa.genres.slice(0, 60).map(g => '  <genre>' + escXml(String(g).slice(0, 80)) + '</genre>').filter(l => l.length > 12).join('\n')
      xml = xml.replace(/(<\/movie>\s*)$/, lines + '\n$1')
    }
    try { fs.writeFileSync(nfo, xml) } catch (e) { return json(res, { ok: false, error: '写入 NFO 失败：' + e.message }) }
    try { rescan() } catch (_) {}
    return json(res, { ok: true, nfo: path.basename(nfo), tip: '已写回并重新扫描' })
  }
  /* ---------- 女优人气榜：手动更新 / 状态（每日自动更新由内置定时器负责） ---------- */
  if (p === '/api/rank/update') {
    if (RANKUP.running) return json(res, { ok: false, error: '排行榜正在更新中（' + (RANKUP.phase || '') + '）' })
    rankUpdateAsync().catch(() => {})
    return json(res, { ok: true, started: true })
  }
  if (p === '/api/rank/status') return json(res, { ok: true, running: RANKUP.running, phase: RANKUP.phase, error: RANKUP.error, added: RANKUP.added, count: RANKUP.count, finishedAt: RANKUP.finishedAt, updatedAt: rankUpdatedAt(), rankAuto: CFG.rankAuto !== false, rankHour: rankHour() })
  /* ---------- 数据源（刮削站点管理，规则抄 MDC/Movie_Data_Capture 的站点布局体系） ---------- */
  if (p === '/api/sources') {
    if (req.method === 'GET') {
      const d = getSourcesData()
      return json(res, { ok: true, ...d, types: MDC_TYPES, fields: MDC_BY_FIELDS })
    }
    let dirty = false
    if ('sources' in body) {
      const list = body.sources
      if (!Array.isArray(list)) return json(res, { ok: false, error: '数据源格式错误' })
      const clean = list.map(s => {
        const o = { id: String(s.id || '').trim().slice(0, 30) }
        if (!o.id) return null
        o.name = String(s.name || o.id).trim().slice(0, 30)
        o.base_url = String(s.base_url || s.base || '').trim().slice(0, 160)
        for (const k of ['search', 'test', 'layout', 'cookies', 'user_agent', 'proxy', 'api_key']) o[k] = String(s[k] || '').slice(0, 400)
        for (const k of ['enabled', 'retry_times_override', 'disable_hash_match']) o[k] = !!s[k]
        for (const k of ['cooldown_seconds', 'retry_times']) o[k] = Math.max(0, Math.min(600, parseInt(s[k], 10) || 0))
        return o
      }).filter(Boolean)
      CFG.sources = clean
      dirty = true
    }
    if ('priorities' in body) { CFG.priorities = cleanPriorities(body.priorities); dirty = true }
    if (body.resetPriorities) { CFG.priorities = DEFAULT_PRIORITIES; dirty = true }   // 重置优先级按钮
    if ('keywords' in body) {
      const k = body.keywords || {}
      CFG.keywords = { code: cleanKeywords(k.code), path: cleanKeywords(k.path) }
      dirty = true
    }
    if (!dirty) return json(res, { ok: false, error: '没有要保存的内容' })
    try { writeCfg() } catch (e) { return json(res, { ok: false, error: '保存失败：' + e.message }) }
    return json(res, { ok: true, ...getSourcesData() })
  }
  if (p === '/api/source/test') {
    let url = String(body.url || '').trim()
    if (!url) return json(res, { ok: false, error: '缺少测试链接' })
    if (!/^https?:\/\//.test(url)) url = 'https://' + url
    const t0 = Date.now()
    try {
      const html = await mnFetch(url, false)
      const ms = Date.now() - t0
      if (!html) {
        const err = mnFetch.lastErr || ''
        const why = /http 403/.test(err) ? '站点拒绝程序访问（403 反爬，浏览器可正常打开）'
          : /http 4/.test(err) ? '请求被拒绝（' + err + '）'
          : '无法访问（检查代理设置）'
        return json(res, { ok: false, ms, error: why })
      }
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      return json(res, { ok: true, ms, title: (m ? m[1].replace(/\s+/g, ' ').trim() : '').slice(0, 80) })
    } catch (e) { return json(res, { ok: false, ms: Date.now() - t0, error: e.message }) }
  }
  if (p === '/api/config/test') {
    const pv = body.proxy !== undefined ? String(body.proxy || '').trim() : proxyUrl()
    const t0 = Date.now()
    const html = await mnFetch(MN_BASE, false, pv)
    const ms = Date.now() - t0
    return json(res, html ? { ok: true, ms, via: pv || 'direct' } : { ok: false, ms, via: pv || 'direct', error: '访问 minnano 失败' })
  }
  if (p === '/api/actor/scrape') {
    const mnid = String(body.mnid || '').replace(/\D/g, '')
    let html = ''
    if (mnid) html = await mnFetch(MN_BASE + 'actress' + mnid + '.html')
    const prof = html ? parseMinnanoProfile(html) : null
    let icon = ''
    if (prof && prof.avatarUrl) {
      const buf = await mnFetch(prof.avatarUrl, true)
      if (buf && buf.length > 500) {
        try {
          const list = JSON.parse(fs.readFileSync(ROSTER, 'utf8'))
          const key = avaKey(list[body.idx | 0] || {}, mnid)
          /* 只暂存到候选目录（旧实现直接写 actresses/，没点保存也把头像换了） */
          const dir = path.join(cacheDir(), 'actor-cand')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, key + '.jpg'), buf)
          icon = '/cache/actor-cand/' + key + '.jpg'
        } catch (_) {}
      }
    }
    /* minnano 没编号 / 没取到头像 → 依次回退必应图片、谷歌图片（名字搜图） */
    if (!icon) {
      const nm = String(body.name || '').trim()
      const got = await actorIconWeb(nm, body.idx | 0, mnid)
      if (got) {
        icon = got.icon
        if (prof) prof.via = got.via
      }
    }
    return json(res, { ok: true, profile: prof || {}, icon })
  }
  if (p === '/api/actor/save') {
    try {
      const idx = body.idx | 0
      let rosterLen = -1
      try { rosterLen = JSON.parse(fs.readFileSync(ROSTER, 'utf8')).length } catch (_) {}
      /* idx 落在内置名册里 → 原逻辑；越界（媒体库里解析出的女优、名册里没有的）→ 本地附加名册 */
      if (rosterLen > 0 && idx >= 0 && idx < rosterLen) {
        let savedName = ''
        rosterUpdate(idx, body.name, a => { savedName = applyActorFields(a, body) })
        return json(res, { ok: true, name: savedName, local: false })
      }
      const ex = readExtraRoster()
      let rec = ex.find(r => r.name === body.name)
      const created = !rec
      if (!rec) {
        /* lid 用名字派生：头像文件名走它，避免与内置名册的 mn<id>.jpg 撞名（撞了就会覆盖别人的头像） */
        const lid = 'lo' + require('crypto').createHash('sha1').update(String(body.name || '')).digest('hex').slice(0, 12)
        rec = { uid: 'local', lid, name: String(body.name || '').trim(), icon: '', videoCount: 0 }
        ex.push(rec)
      }
      const savedName = applyActorFields(rec, body)
      writeExtraRoster(ex)
      return json(res, { ok: true, name: savedName, local: true, created })
    } catch (e) {
      return json(res, { ok: false, error: e.message })
    }
  }
  /* 聚合刮削：一次拿回「资料候选 + 头像候选」，前端列表选择后再保存（只读，不落盘） */
  if (p === '/api/actor/probe') {
    const name = String(body.name || '').trim()
    const givenMnid = String(body.mnid || '').replace(/\D/g, '')
    const profiles = []
    const images = []
    const pushImg = (url, src, label) => {
      if (url && !images.some(x => x.url === url)) images.push({ url, src, label })
    }
    const loadProf = async mnid => {
      const r = await mnGetFollow(MN_BASE + 'actress' + mnid + '.html', false)
      if (!r) return null
      return Object.assign({ src: 'minnano', mnid, url: MN_BASE + 'actress' + mnid + '.html' }, parseMinnanoProfile(r.body))
    }
    /* 1) 已知道 mnid（名册里的记录）→ 直接抓资料页 */
    if (givenMnid) {
      const p1 = await loadProf(givenMnid)
      if (p1) { p1.match = 'mnid'; profiles.push(p1) }
    }
    /* 2) 按名搜索：唯一命中会 302（花咲まどか → 蜜香），否则给出候选列表 */
    let search = { exact: '', list: [] }
    if (name) search = await mnSearchActress(name)
    const brief = []
    if (search.exact) {
      if (search.exact !== givenMnid) brief.push({ mnid: search.exact, name, match: 'exact' })
    } else {
      for (const x of search.list) brief.push(Object.assign({ match: 'name' }, x))
    }
    /* 前 3 位候选展开完整资料（可横向比字段），其余只给名字/头像，点开再抓 */
    const full = await Promise.all(brief.slice(0, 3).map(x => loadProf(x.mnid).then(pp => pp ? Object.assign(pp, x, { brief: false }) : null).catch(() => null)))
    for (const pp of full) if (pp) profiles.push(pp)
    for (const x of brief.slice(3)) profiles.push(Object.assign({ src: 'minnano', brief: true }, x))
    /* 同一 mnid 只留一条（「按 mnid 直抓」和「按名搜索命中」会撞上同一人），字段互补合并 */
    const byMnid = new Map()
    for (const pr of profiles) {
      const key = pr.mnid || ('n:' + String(pr.name || ''))
      const old = byMnid.get(key)
      if (!old) { byMnid.set(key, pr); continue }
      for (const kk of Object.keys(pr)) {
        const v = pr[kk]
        if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue
        if (old[kk] === undefined || old[kk] === '' || (Array.isArray(old[kk]) && !old[kk].length)) old[kk] = v
      }
      if (pr.match === 'mnid' || pr.match === 'exact') old.match = pr.match
      if (!pr.brief) old.brief = false
    }
    const profList = [...byMnid.values()]
    for (const pr of profList) if (pr.avatarUrl) pushImg(pr.avatarUrl, 'minnano', 'minnano' + (pr.name ? ' · ' + pr.name : ''))
    /* 3) 图库搜头像候选（必应原图 + 谷歌缩略图） */
    if (name) {
      const q = name + ' 女優'
      const [bing, goog] = await Promise.all([bingImageUrls(q, 10), googleImageUrls(q, 8)])
      bing.forEach((u, i) => pushImg(u, 'bing', '必应 #' + (i + 1)))
      goog.forEach((u, i) => pushImg(u, 'google', '谷歌 #' + (i + 1)))
    }
    return json(res, { ok: true, name, search, profiles: profList, images })
  }
  /* 选定的头像候选：下载并暂存到 cache/actor-cand/（不覆盖现有头像），返回 dataURL 供预览与保存 */
  if (p === '/api/actor/pick-avatar') {
    const url = String(body.url || '')
    if (!/^https?:\/\//i.test(url)) return json(res, { ok: false, error: '无效的图片地址' })
    const buf = await fetchImageBuf(url)
    const ext = buf ? imgExtOf(buf) : ''
    if (!ext) return json(res, { ok: false, error: '图片下载失败（可能被防盗链拦截），换一张试试' })
    if (buf.length > 4 * 1024 * 1024) return json(res, { ok: false, error: '图片过大（>4MB），换一张试试' })
    let sp = ''
    try {
      const dir = path.join(cacheDir(), 'actor-cand')
      fs.mkdirSync(dir, { recursive: true })
      const key = 'c' + require('crypto').createHash('sha1').update(url).digest('hex').slice(0, 16)
      fs.writeFileSync(path.join(dir, key + '.' + ext), buf)
      sp = '/cache/actor-cand/' + key + '.' + ext
    } catch (_) {}
    return json(res, {
      ok: true, ext, size: buf.length, path: sp,
      dataUrl: 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + buf.toString('base64')
    })
  }
  /* ---------- Emby 式媒体库管理：挂载点只作权限边界，媒体库 = 设置里选的子文件夹 ---------- */
  if (p === '/api/library') {
    return json(res, {
      ok: true, root: MEDIA_ROOT, hostPath: readMediaPathFile() || '',
      libraries: LIBS, libs: libStats(), scanning: SCAN.running,
      /* 「添加 → 导入视频整理」用过的目录：设置 → 媒体库里展示，可一键收进媒体库 */
      importDirs: Array.isArray(CFG.importDirs) ? CFG.importDirs : [],
      scan: { running: SCAN.running, phase: SCAN.phase, videos: SCAN.videos, scanned: SCAN.scanned, matched: SCAN.matched, ok: SCAN.okCount, fail: SCAN.failCount, error: SCAN.error, ms: SCAN.ms, finishedAt: SCAN.finishedAt }
    })
  }
  /* 重新扫描（等价「⟳ 重新扫描」）：扫描中调用会在本轮结束后自动再扫一遍 */
  if (p === '/api/library/rescan') { rescan(); return json(res, { ok: true, scanning: SCAN.running }) }
  if (p === '/api/library/add' || p === '/api/library/remove') {
    /* 移除「导入整理用过目录」的记录（body.importDir）：不动文件、不重扫 */
    if (p === '/api/library/remove' && body.importDir) {
      const ip = path.resolve(String(body.importDir))
      CFG.importDirs = (Array.isArray(CFG.importDirs) ? CFG.importDirs : []).filter(x => path.resolve(String(x)) !== ip)
      try { writeCfg() } catch (_) {}
      return json(res, { ok: true, importDirs: CFG.importDirs })
    }
    let raw = String(body.path || '').trim()
    if (!raw) return json(res, { ok: false, error: '请填写文件夹路径' })
    if (raw === '~' || raw.startsWith('~/')) raw = path.join(MEDIA_ROOT, raw.slice(1))
    const rp = path.resolve(raw)
    if (!(rp === MEDIA_ROOT || rp.startsWith(MEDIA_ROOT + path.sep)))
      return json(res, { ok: false, error: `只能添加挂载进来的目录（${MEDIA_ROOT}）里的文件夹。宿主机的路径在容器里不存在——要挂别的目录请先在 docker-compose.yml 里加一行映射，再重建容器` })
    if (p === '/api/library/add') {
      let st = null
      try { st = fs.statSync(rp) } catch (_) {}
      if (!st || !st.isDirectory())
        return json(res, { ok: false, error: `路径不存在或不可读：${rp}（检查容器是否已挂载该目录、云盘是否在线）` })
      if (!LIBS.includes(rp)) LIBS.push(rp)
      /* 转正成媒体库了 → 从「导入整理用过目录」记录里移除，避免两处重复展示 */
      if (Array.isArray(CFG.importDirs)) {
        CFG.importDirs = CFG.importDirs.filter(x => path.resolve(String(x)) !== rp)
      }
    } else {
      const i = LIBS.indexOf(rp)
      if (i < 0) return json(res, { ok: false, error: '该文件夹不在媒体库列表里' })
      LIBS.splice(i, 1)
    }
    try { writeCfg() } catch (e) { return json(res, { ok: false, error: '保存失败：' + e.message }) }
    rescan()
    return json(res, {
      ok: true, libraries: LIBS, libs: libStats(), scanning: SCAN.running,
      warn: rp === MEDIA_ROOT ? '加的是挂载根目录（整根扫描）。挂载点只是权限范围，通常建议改加它下面的子文件夹，例如 ' + MEDIA_ROOT + '/某个子目录' : ''
    })
  }
  /* ---------- 备份 / 恢复：配置 + 播放记录 + 个人数据打成一个 JSON ----------
   * 换机、清库、重装容器前先导出；恢复时只合并白名单字段，不会动影片文件。 */
  if (p === '/api/backup') {
    if (req.method === 'GET') {
      const bundle = {
        app: 'javpaco', version: 1, exportedAt: new Date().toISOString(),
        config: (() => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch (_) { return {} } })(),
        watch: WATCH, userdata: UD
      }
      const b = Buffer.from(JSON.stringify(bundle, null, 1))
      const stamp = new Date().toISOString().slice(0, 10)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length,
        'Content-Disposition': `attachment; filename="javpaco-backup-${stamp}.json"`, 'Cache-Control': 'no-store'
      })
      return res.end(b)
    }
    const inc = body.bundle && typeof body.bundle === 'object' ? body.bundle : body
    const applied = []
    try {
      if (inc.config && typeof inc.config === 'object') {
        const SAFE = ['proxy', 'proxyEnabled', 'cacheDir', 'metaMode', 'autoOrganize', 'autoScrapeNew', 'autoRescan', 'autoRescanHour', 'rankAuto', 'rankHour', 'hidden', 'uiPrefs', 'libraries', 'importDirs', 'sources', 'priority', 'priorities', 'keywords', 'accessCode', 'favorites', 'subscriptions', 'online', 'pan115']
        SAFE.forEach(k => { if (inc.config[k] !== undefined) CFG[k] = inc.config[k] })
        LIBS = Array.isArray(CFG.libraries) ? CFG.libraries.map(s => path.resolve(String(s))) : []
        writeCfg(); applied.push('配置')
      }
      if (inc.watch && typeof inc.watch === 'object' && Object.keys(inc.watch).length) {
        WATCH = inc.watch; watchSaveSoon(); applied.push('播放记录 ' + Object.keys(WATCH).length + ' 条')
      }
      if (inc.userdata && typeof inc.userdata === 'object' && Object.keys(inc.userdata).length) {
        UD = inc.userdata; udSaveSoon(); applied.push('个人数据 ' + Object.keys(UD).length + ' 条')
      }
    } catch (e) { return json(res, { ok: false, error: '恢复失败：' + e.message }) }
    if (!applied.length) return json(res, { ok: false, error: '备份文件里没有可恢复的数据（缺 config / watch / userdata）' })
    try { rescan() } catch (_) {}
    return json(res, { ok: true, applied, tip: '媒体库路径如有变化会自动重扫；页面即将刷新' })
  }
  /* ---------- 访问口令（可选）：设置里开启后，局域网里其他人要先输口令 ---------- */
  if (p === '/api/login') {
    const code = String(body.code || '')
    if (!ACCESS_CODE() || code !== ACCESS_CODE()) return json(res, { ok: false, error: '口令不对' })
    const token = accessToken()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `jpkey=${token}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax` })
    return res.end('{"ok":true}')
  }
  /* ---------- 个人数据：评分 / 备注 / 自定义标签（批量加标签也走这里） ---------- */
  if (p === '/api/userdata') {
    if (req.method === 'GET') return json(res, { ok: true, data: UD })
    const code = String(body.code || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    const k = bare(code)
    const cur = UD[k] || {}
    const pa = body.patch && typeof body.patch === 'object' ? body.patch : {}
    if ('rating' in pa) cur.rating = Math.max(0, Math.min(5, Number(pa.rating) || 0))
    if ('note' in pa) cur.note = String(pa.note || '').slice(0, 2000)
    if ('tags' in pa) cur.tags = Array.isArray(pa.tags) ? pa.tags.map(t => String(t).slice(0, 40)).filter(Boolean).slice(0, 30) : []
    if (!cur.rating && !cur.note && !(cur.tags || []).length) delete UD[k]; else UD[k] = cur
    udSaveSoon()
    return json(res, { ok: true, rec: UD[k] || null })
  }
  /* ---------- 批量把影片文件夹移进媒体库内的某个子文件夹（先在前端预览，这里执行） ---------- */
  if (p === '/api/bulk/move') {
    const codes = (Array.isArray(body.codes) ? body.codes : []).map(x => bare(x)).filter(Boolean)
    const target = String(body.target || '').trim().replace(/^\/+|\/+$/g, '')
    if (!codes.length) return json(res, { ok: false, error: '没有勾选影片' })
    if (!target || target.split('/').some(s => !s || s === '.' || s === '..')) return json(res, { ok: false, error: '目标文件夹名不合法' })
    const dstRoot = path.resolve(MEDIA_ROOT, target)
    if (!(dstRoot === MEDIA_ROOT || dstRoot.startsWith(MEDIA_ROOT + path.sep))) return json(res, { ok: false, error: '目标必须在媒体库目录内：' + MEDIA_ROOT })
    const moved = [], skipped = []
    try { fs.mkdirSync(dstRoot, { recursive: true }) } catch (e) { return json(res, { ok: false, error: '建目录失败：' + e.message }) }
    for (const b of codes) {
      const it = (DATA && Array.isArray(DATA.items) ? DATA.items : []).find(x => bare(x.code) === b)
      const rel = it && (it.relVideo || (it.files && it.files[0] && it.files[0].relVideo))
      if (!rel) { skipped.push({ code: b, reason: '找不到视频文件' }); continue }
      const src = safeMediaPath(rel)
      if (!src) { skipped.push({ code: b, reason: '路径越界' }); continue }
      const dir = path.dirname(src)
      if (dir === MEDIA_ROOT || dir === dstRoot) { skipped.push({ code: b, reason: '文件散在媒体库根目录，请先用「导入视频整理」归档' }); continue }
      const name = path.basename(dir)
      const dst = path.join(dstRoot, name)
      if (dir === dst) { skipped.push({ code: b, reason: '已在该文件夹里' }); continue }
      if (fs.existsSync(dst)) { skipped.push({ code: b, reason: '目标已存在同名文件夹：' + name }); continue }
      try {
        // 同文件夹里还有别的影片 → 只搬这一个影片自己的文件，不动别人的
        const siblings = (DATA.items || []).filter(x => bare(x.code) !== b).some(x => {
          const r2 = x.relVideo || (x.files && x.files[0] && x.files[0].relVideo)
          return r2 && path.dirname(safeMediaPath(r2) || '') === dir
        })
        if (siblings) { skipped.push({ code: b, reason: '文件夹「' + name + '」里还有别的影片，不整体搬移' }); continue }
        fs.renameSync(dir, dst)
        // 相对路径整体前缀替换：data.json 重扫前先把内存里的指向改掉，播放记录也跟着迁移
        const oldPrefix = path.relative(MEDIA_ROOT, dir), newPrefix = path.relative(MEDIA_ROOT, dst)
        const remap = r => typeof r === 'string' && (r === oldPrefix || r.startsWith(oldPrefix + '/')) ? newPrefix + r.slice(oldPrefix.length) : r
        ;(DATA.items || []).forEach(x => {
          if (bare(x.code) !== b) return
          x.relVideo = remap(x.relVideo)
          if (Array.isArray(x.files)) x.files.forEach(f => { f.relVideo = remap(f.relVideo) })
          if (Array.isArray(x.relSamples)) x.relSamples = x.relSamples.map(remap)
        })
        Object.keys(WATCH).forEach(k => { const nk = remap(k); if (nk !== k) { WATCH[nk] = WATCH[k]; delete WATCH[k] } })
        watchSaveSoon()
        moved.push({ code: b, from: oldPrefix, to: newPrefix })
      } catch (e) { skipped.push({ code: b, reason: e.message }) }
    }
    try { rescan() } catch (_) {}
    return json(res, { ok: true, moved, skipped })
  }
  /* ---------- 影片库隐藏 / 恢复：刮削不到数据的条目先藏起来，设置页勾「显示已隐藏」可看回 ---------- */
  if (p === '/api/lib/hide') {
    /* 支持单个 { code } 或批量 { codes: [...] }（批量操作台用） */
    const on = body.hidden !== false && body.hidden !== 0 && body.hidden !== '0'
    const codes = Array.isArray(body.codes) ? body.codes.map(x => String(x || '').trim()).filter(Boolean)
      : [String(body.code || '').trim()]
    if (!codes.length) return json(res, { ok: false, error: '缺少番号' })
    try { codes.forEach(c => setHidden(c, on)) } catch (e) { return json(res, { ok: false, error: '保存失败：' + e.message }) }
    /* 立即反映到已生成的数据上，前端不用重扫就能看到效果 */
    if (DATA && Array.isArray(DATA.items)) {
      const bs = new Set(codes.map(bare))
      DATA.items.forEach(it => { if (bs.has(bare(it.code))) it.hidden = on })
    }
    return json(res, { ok: true, code: codes[0], count: codes.length, hidden: on, hiddenCount: (CFG.hidden || []).length })
  }
  /* ---------- 手动裁剪竖版海报：前端用横版主图裁成竖版比例后传 dataURL，落盘覆盖 poster.jpg ----------
   * 场景：部分无码作品只有横版封面，刮不到竖版海报 → 在详情页「刮削内容」里点竖版海报框手动裁一张。 */
  if (p === '/api/images/save-poster') {
    const code = String(body.code || '').trim()
    const dataUrl = String(body.dataUrl || '')
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    const m = dataUrl.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([\s\S]+)$/i)
    if (!m) return json(res, { ok: false, error: '图片数据格式不正确（需 data:image/jpeg;base64,…）' })
    const buf = Buffer.from(m[1], 'base64')
    if (!buf.length) return json(res, { ok: false, error: '裁剪结果为空，请重试' })
    if (buf.length > 12 * 1024 * 1024) return json(res, { ok: false, error: '图片过大（超过 12MB），请缩小裁剪范围' })
    const safe = String(code).replace(/[^\w.-]/g, '_')
    const dir = path.join(cacheDir(), 'movies', safe, 'images')
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    const fp = path.join(dir, 'poster.jpg')
    try { fs.writeFileSync(fp, buf) } catch (e) { return json(res, { ok: false, error: '写入失败：' + e.message }) }
    /* 回写 meta.json：海报指向本地文件 + 记尺寸/来源/时间（前端据此显示分辨率与「手动裁剪」标记） */
    const meta = readMovieCache(code) || { code }
    meta.code = meta.code || code
    meta.images = Object.assign({}, meta.images || {})
    const sz = imgSize(fp) || {}
    meta.images.poster = '/cache/movies/' + safe + '/images/poster.jpg'
    meta.images.posterManual = true
    meta.images.posterSrc = 'manual-crop'
    meta.images.posterMeta = { w: sz.w || 0, h: sz.h || 0, bytes: buf.length, src: 'manual-crop' }
    /* 存下裁剪构图（归一化到原底图的 0~1 区间）：底图将来升级成更高清时，可按此构图自动重裁 */
    if (body.crop && typeof body.crop === 'object') {
      const cl = v => Math.max(0, Math.min(1, +v || 0))
      meta.images.posterCrop = {
        x: cl(body.crop.x), y: cl(body.crop.y),
        w: Math.max(0.01, Math.min(1, +body.crop.w || 0)), h: Math.max(0.01, Math.min(1, +body.crop.h || 0)),
        src: body.crop.src === 'poster' ? 'poster' : 'fanart'
      }
    } else delete meta.images.posterCrop
    try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(meta, null, 2)) } catch (e) { return json(res, { ok: false, error: '元数据写入失败：' + e.message }) }
    mirrorMeta(code)   // 选了「跟视频放一起」时同步平铺到番号文件夹
    console.log(`[poster] ${code} 手动裁剪海报 ${sz.w}×${sz.h} ${(buf.length / 1024).toFixed(0)}KB`)
    return json(res, { ok: true, code, poster: meta.images.poster, w: sz.w || 0, h: sz.h || 0, bytes: buf.length })
  }
  /* ---------- 影片磁力（sukebei.nyaa，缓存优先可离线） ---------- */
  if (p === '/api/movie') {
    const code = String(body.code || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    return json(res, await movieDetail(code, !!body.refresh))
  }
  /* ---------- 缓存目录统计 ---------- */
  if (p === '/api/cache') return json(res, cacheStats())
  if (p === '/api/cache/clean') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const r = cacheClean()
    return json(res, Object.assign({ ok: true }, r))
  }
  /* ---------- 在线刮削（添加本地库没有的影片） ---------- */
  if (p === '/api/scrape/start') {
    if (SCRAPE.running) return json(res, { ok: false, error: '正在刮削「' + SCRAPE.code + '」，请等它完成' })
    if (IMGUP.running) return json(res, { ok: false, error: '正在批量升级图片（' + IMGUP.current + '），请等它完成' })
    let code = String(body.code || '').trim().toUpperCase()
    const fromUrl = scCodeFromUrl(body.code) || scCodeFromUrl(body.url)   // 直接粘详情页网址也认
    if (fromUrl) code = fromUrl
    let nfo = body.nfo ? String(body.nfo).slice(0, 200000) : ''
    if (nfo && !code) {
      const num = (nfo.match(/<num[^>]*>([\s\S]*?)<\/num>/i) || [])[1]
      code = scText(num || '').toUpperCase()
      if (!code) {
        const tt = (nfo.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
        code = parseName(scText(tt) + '.mp4').code || ''
      }
    }
    code = code ? parseName(code + '.mp4').code : ''
    /* 日期式无码番号（082926-001 / 100323_01）是纯数字，不能按「必须含字母」拒掉 */
    if (!code || !(/^\d{6}-\d{2,4}$/.test(code) || (/[A-Z]/.test(code) && /\d/.test(code)))) return json(res, { ok: false, error: '无法识别番号：请填形如 STARS-238 或 092126-001 的番号、含 <num> 的 NFO，或详情页网址' })
    const job = { code, url: String(body.url || '').trim(), sourceId: String(body.sourceId || '').trim(), nfo, full: !!body.full }
    scrapeAsync(job).catch(() => {})
    return json(res, { ok: true, code })
  }
  if (p === '/api/scrape/status') return json(res, Object.assign({ ok: true }, SCRAPE))
  /* ---- 批量图片升级（设置 → 图片升级） ---- */
  if (p === '/api/images/upgrade-list') return json(res, Object.assign({ ok: true }, imgUpList()))
  if (p === '/api/images/upgrade-status') return json(res, Object.assign({ ok: true }, IMGUP))
  if (p === '/api/images/upgrade') {
    if (IMGUP.running) return json(res, { ok: false, error: '升级任务正在进行（' + IMGUP.done + '/' + IMGUP.total + '）' })
    if (SCRAPE.running) return json(res, { ok: false, error: '正在刮削「' + SCRAPE.code + '」，请等它完成' })
    const codes = (Array.isArray(body.codes) ? body.codes : []).map(x => String(x).trim()).filter(Boolean).slice(0, 500)
    if (!codes.length) return json(res, { ok: false, error: '没有指定番号' })
    imgUpAsync(codes).catch(() => {})
    return json(res, { ok: true, total: codes.length })
  }
  /* ---- 按网站对比扫描（设置 → 图片升级 → 按网站对比扫描） ---- */
  if (p === '/api/images/src-scan') {
    if (SRCSCAN.running) return json(res, { ok: false, error: '正在扫描「' + SRCSCAN.sourceId + '」（' + SRCSCAN.done + '/' + SRCSCAN.total + '），请等它完成' })
    if (IMGUP.running) return json(res, { ok: false, error: '正在批量升级图片（' + IMGUP.current + '），请等它完成' })
    if (SCRAPE.running) return json(res, { ok: false, error: '正在刮削「' + SCRAPE.code + '」，请等它完成' })
    const sourceId = String(body.sourceId || '').trim()
    if (!sourceId || !getSourcesData().sources.some(s => s.id === sourceId)) return json(res, { ok: false, error: '未知的数据源：' + sourceId })
    srcScanAsync(sourceId).catch(() => {})
    return json(res, { ok: true, sourceId })
  }
  if (p === '/api/images/src-scan-status') return json(res, Object.assign({ ok: true }, SRCSCAN))
  if (p === '/api/images/src-apply') {
    if (SRCSCAN.running) return json(res, { ok: false, error: '扫描进行中，请等它完成再升级' })
    try {
      const r = await srcApplyOne(String(body.code || '').trim(), String(body.role || '').trim(), String(body.url || '').trim())
      return json(res, Object.assign({ ok: true }, r))
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* 「待升级」行点开的新老对比卡片：本地图 vs 各源最优候选（含尺寸/大小/是否更高清），不落盘 */
  if (p === '/api/images/cand-preview') {
    const code = String(body.code || '').trim()
    const role = String(body.role || 'fanart').trim() === 'poster' ? 'poster' : 'fanart'
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    const m = readMovieCache(code)
    if (!m) return json(res, { ok: false, error: '离线数据里没有这部影片的元数据' })
    const key = code + '|' + role
    const hitc = CANDCACHE.get(key)
    if (hitc && !body.force && Date.now() - hitc.at < 10 * 60 * 1000) return json(res, hitc.data)
    const local = localImgInfo(m, role)
    const best = await bestCandOf(m, role)
    const data = Object.assign({ ok: true, code, role, local, posterManual: !!(m.images && m.images.posterManual) },
      best || { best: null, all: [], better: false })
    /* 线上候选不比本地大（一样大或更小）→ 记 UpTried，这个番号之后不再出现在「待升级」列表里；
       真有更高的图想要时仍可批量升级或按网站对比扫描手动升级 */
    if (data.best && data.local && !data.better) {
      try {
        const im = m.images = m.images || {}
        const mk = role + 'UpTried'
        if (!im[mk]) {
          im[mk] = new Date().toISOString()
          fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true })
          fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2))
          data.marked = true
        }
      } catch (_) {}
    }
    CANDCACHE.set(key, { at: Date.now(), data })
    if (CANDCACHE.size > 200) CANDCACHE.delete(CANDCACHE.keys().next().value)
    return json(res, data)
  }
  /* ---- 离线数据导入（添加影片页）：把按番号命名的缓存文件夹（meta.json + images/ + movie.nfo）拷回 cache/movies ---- */
  if (p === '/api/offline/scan') {
    try { return json(res, { ok: true, dir: String(body.dir || '').trim(), items: offlineScan(body.dir) }) }
    catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/offline/import') {
    try {
      const root = String(body.dir || '').trim()
      const only = Array.isArray(body.dirs) ? body.dirs.map(x => String(x)) : null
      const items = offlineScan(root).filter(it => !only || only.includes(it.dir))
      if (!items.length) return json(res, { ok: false, error: '该目录下没有找到含 meta.json 的番号文件夹' })
      const mvdir = path.join(cacheDir(), 'movies')
      const imported = [], skipped = [], errors = []
      for (const it of items) {
        const dst = path.join(mvdir, it.dir)
        if (fs.existsSync(path.join(dst, 'meta.json')) && !body.overwrite) { skipped.push(it.code); continue }
        try {
          fs.mkdirSync(dst, { recursive: true })
          copyTree(it.src, dst)
          imported.push(it.code)
        } catch (e) { errors.push(it.code + '：' + e.message) }
      }
      if (imported.length) rescan()
      return json(res, { ok: true, imported, skipped, errors })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* ---------- 导入视频整理（MDC-NG 式）：解析番号 → 原地规范命名 <番号>/<番号>.mp4 → 批量刮削 ----------
   * 目录与挂载边界：只能在 MEDIA_ROOT 内操作；rename 是元数据操作，不读视频字节（不会触发网盘细流挂死）。 */
  /* 番号合法性：字母+数字（STARS-238），或纯日期式（无码厂常见写法：092126-001 / 082926_001） */
  const impValidCode = c => !!c && ((/[A-Z]/.test(c) && /\d/.test(c)) || /^\d{6}[-_]\d{2,4}$/.test(c))
  /* 分集排序：主文件（=番号）最前，其次 cd/part 序号，其余按文件名 */
  const impPartRank = (rel, code) => {
    const b = baseOf(rel)
    if (bare(b) === bare(code)) return 0
    const m = /(?:cd|part|pt)[ ._-]?(\d+)$/i.exec(b)
    return m ? 1 + parseInt(m[1], 10) : 5000
  }
  /* 整理命名用的标签段：码别（有码/无码）+ 破解/流出/中字，识别范围＝导入的根文件夹名 + 相对路径（含各级文件夹名）+ 文件名；
   * 分辨率不写入文件名。例：ISIS-156.mp4（位于「破解」文件夹）→ ISIS-156/ISIS-156-有码-破解.mp4
   * 根目录名也要带上：否则导入「/media/无码流出」时该目录名不进 rel，重扫标签会丢、文件名来回抖。 */
  const impTagPart = (rootName, rel) => {
    const tags = videoTagsOf(String(rootName || '') + '/' + String(rel || ''), 0, 0)
      .filter(t => t !== '4K' && t !== '2K' && t !== '1080P' && t !== '720P' && t !== '480P')
    return tags.length ? '-' + tags.join('-') : ''
  }
  function importScan(dir) {
    const root = path.resolve(String(dir || '').trim())
    if (!(root === MEDIA_ROOT || root.startsWith(MEDIA_ROOT + path.sep))) throw new Error(mountTip())
    let st; try { st = fs.statSync(root) } catch (_) { throw new Error('目录不存在或不可读：' + root + '（检查是否已挂载、云盘是否在线）') }
    if (!st.isDirectory()) throw new Error('不是目录：' + root)
    const files = []
    let skippedDirs = 0
    /* 已整理完的番号文件夹：目录名是番号，且里面所有视频都已是「番号[-标签][-cdN].ext」→ 跳过不再往下扫。
     * 这样第二次扫描只盯散落的（未整理的）视频，新拷进来的文件会被立刻识别到。 */
    const isDoneFolder = d => {
      const code = norm(path.basename(d))
      if (!impValidCode(code)) return false
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return false }
      const vids = es.filter(e => e.isFile() && VIDEO_EXT.includes(extOf(e.name)))
      if (!vids.length) return false
      const p = code + '-'
      return vids.every(e => { const n = norm(baseOf(e.name)); return n === code || n.startsWith(p) })
    }
    ;(function walk(d, depth) {
      if (depth > 6) return
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
      for (const e of es) {
        if (e.name.startsWith('.')) continue
        const fp = path.join(d, e.name)
        if (e.isDirectory()) {
          if (isDoneFolder(fp)) { skippedDirs++; continue }
          walk(fp, depth + 1)
        }
        else if (VIDEO_EXT.includes(extOf(e.name))) {
          let size = 0; try { size = fs.statSync(fp).size } catch (_) {}
          files.push({ abs: fp, rel: path.relative(root, fp).split(path.sep).join('/'), size })
        }
      }
    })(root, 0)
    files.sort((a, b) => a.rel < b.rel ? -1 : 1)
    const codeSafe = c => String(c).replace(/[^\w.-]/g, '_')
    const rootName = path.basename(root)   // 根文件夹名也参与标签识别（如导入「无码流出」目录）
    const out = []
    for (const f of files) {
      const p = parseName(f.rel)
      const code = impValidCode(norm(p.code)) ? norm(p.code) : ''
      const parentRel = path.dirname(f.rel)
      /* 父目录已经是番号名（已整理过）→ 目标就是原地；否则在其旁边建 <番号>/ 文件夹 */
      const parentIsCode = !!code && bare(path.basename(parentRel)) === bare(code)
      const dirRel = parentIsCode ? parentRel : path.join(parentRel, codeSafe(code))
      const cdInName = /-cd(\d+)$/i.exec(baseOf(f.rel))
      const cdSuffix = cdInName ? '-cd' + cdInName[1] : ''
      const tagPart = impTagPart(rootName, f.rel)   // 标签来源含根目录名与各级文件夹名（如「破解」「无码流出」）
      const targetRel = code ? path.join(dirRel, codeSafe(code) + tagPart + cdSuffix + path.extname(f.rel)).split(path.sep).join('/') : ''
      const targetAbs = code ? path.resolve(root, targetRel) : ''
      out.push({
        file: f.rel, size: f.size, code,
        target: targetRel,
        status: !code ? 'unknown'
          : (f.abs === targetAbs ? 'ok'
            : (fs.existsSync(targetAbs) ? 'conflict' : 'ready'))
      })
    }
    /* 同番号多个视频（CD 分集）→ 统一归到第一个分集的目标目录，文件名追加 -cd1/-cd2 */
    const groups = new Map()
    for (const it of out) { if (it.code) { if (!groups.has(it.code)) groups.set(it.code, []); groups.get(it.code).push(it) } }
    for (const arr of groups.values()) {
      if (arr.length < 2) continue
      arr.sort((a, b) => impPartRank(a.file, a.code) - impPartRank(b.file, b.code) || (a.file < b.file ? -1 : 1))
      const baseDir = path.dirname(arr[0].target)
      arr.forEach((it, i) => {
        const ext = path.extname(it.file)
        it.target = path.join(baseDir, codeSafe(it.code) + impTagPart(rootName, it.file) + '-cd' + (i + 1) + ext).split(path.sep).join('/')
        it.status = (path.resolve(root, it.target) === path.resolve(root, it.file)) ? 'ok' : (fs.existsSync(path.resolve(root, it.target)) ? 'conflict' : 'ready')
      })
    }
    return { root, items: out, skipped: skippedDirs, metaMode: CFG.metaMode === 'inline' ? 'inline' : '' }
  }
  if (p === '/api/import/scan') {
    try { return json(res, { ok: true, ...importScan(body.dir) }) }
    catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/import/run') {
    try {
      const root = path.resolve(String(body.dir || '').trim())
      if (!(root === MEDIA_ROOT || root.startsWith(MEDIA_ROOT + path.sep))) return json(res, { ok: false, error: mountTip() })
      const rootName = path.basename(root)
      const list = Array.isArray(body.items) ? body.items.slice(0, 2000) : []
      if (!list.length) return json(res, { ok: false, error: '没有勾选任何文件' })
      /* 同番号分集排 -cd 序号：按客户端给的顺序分组成批 */
      const groups = new Map()
      for (const it of list) {
        const code = impValidCode(norm(it.code)) ? norm(it.code) : ''
        if (!code) continue
        if (!groups.has(code)) groups.set(code, [])
        groups.get(code).push(it)
      }
      for (const arr of groups.values()) arr.sort((a, b) => impPartRank(a.file, a.code) - impPartRank(b.file, b.code) || (a.file < b.file ? -1 : 1))
      const results = [], codes = []
      let moved = 0
      for (const it of list) {
        const rel = String(it.file || '')
        const src = path.resolve(root, rel)
        if (!src.startsWith(root + path.sep)) { results.push({ file: rel, ok: false, msg: '路径越界' }); continue }
        let st; try { st = fs.statSync(src) } catch (_) { results.push({ file: rel, ok: false, msg: '文件不存在（可能已整理过）' }); continue }
        if (!st.isFile()) { results.push({ file: rel, ok: false, msg: '不是文件' }); continue }
        const code = impValidCode(norm(it.code)) ? norm(it.code) : ''
        if (!code) { results.push({ file: rel, ok: false, msg: '无法识别番号（保持原样）' }); continue }
        const g = groups.get(code) || [it]
        const gi = Math.max(0, g.indexOf(it))
        let cd = g.length > 1 ? '-cd' + (gi + 1) : ''
        const cdInName = /-cd(\d+)$/i.exec(baseOf(rel))
        if (!cd && cdInName) cd = '-cd' + cdInName[1]   // 单独勾选某个分集 → 保留其分集号
        const dirName = code.replace(/[^\w.-]/g, '_')
        /* 父目录已是番号名 → 原地；分集统一归到第一个分集的目标目录（与扫描预览一致） */
        const leadFile = path.resolve(root, String((g[0] || it).file || rel))
        const leadParent = path.dirname(leadFile)
        const baseDir = bare(path.basename(leadParent)) === bare(code) ? leadParent
          : (g.length > 1 ? path.join(leadParent, dirName) : path.join(path.dirname(src), dirName))
        const target = path.resolve(baseDir, dirName + impTagPart(rootName, rel) + cd + path.extname(rel))
        if (!target.startsWith(root + path.sep)) { results.push({ file: rel, ok: false, msg: '目标路径越界' }); continue }
        try {
          if (src === target) { results.push({ file: rel, ok: true, msg: '已符合规范' }) }
          else {
            if (fs.existsSync(target)) { results.push({ file: rel, ok: false, msg: '目标已存在：' + path.basename(target) }); continue }
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.renameSync(src, target)
            results.push({ file: rel, ok: true, msg: '→ ' + path.relative(root, target).split(path.sep).join('/') })
            moved++
          }
          if (!codes.includes(code)) codes.push(code)
        } catch (e) { results.push({ file: rel, ok: false, msg: '写失败：' + e.message + '（/media 是否只读挂载？）' }) }
      }
      if (moved) rescan()   // 重扫后新路径进媒体库
      /* 记录用过的导入目录 → 设置 → 媒体库展示（可一键收进媒体库 / 移除记录）。
       * 只要点过「整理并刮削」才算用过；单纯扫描预览不记。最近用的排最后，最多留 20 条。 */
      if (codes.length) {
        try {
          const rec = Array.isArray(CFG.importDirs) ? CFG.importDirs : (CFG.importDirs = [])
          const i = rec.indexOf(root)
          if (i >= 0) rec.splice(i, 1)
          rec.push(root)
          while (rec.length > 20) rec.shift()
          writeCfg()
        } catch (_) {}
      }
      return json(res, { ok: true, moved, results, codes })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* 某影片的多源刮削数据：逐字段值+来源、主图+来源、各源可用字段（详情页「刮削内容」面板用） */
/* ---------- 「本地数据」：影片文件夹里自带的 NFO / 海报（刮削动作发生前的原始本地值） ----------
 * 详情页「刮削内容」面板可逐项切回本地值，避免线上刮削把用户手工整理的资料冲掉。 */
function localSourceForCode(code) {
  const b = bare(code)
  if (!b) return null
  const it = ((DATA && DATA.items) || []).find(x => bare(x.code) === b && x.relVideo) || null
  if (!it) return null                                     // 纯线上资料（无本地视频）没有「本地数据」可言
  const out = {
    relVideo: it.relVideo || '',
    videoPath: it.relVideo ? (safeMediaPath(it.relVideo) || '') : '',
    posterPath: it.relPoster ? (safeMediaPath(it.relPoster) || '') : '',
    fanartPath: it.relFanart ? (safeMediaPath(it.relFanart) || '') : '',
    nfoPath: ''
  }
  if (out.videoPath) {
    const dir = path.dirname(out.videoPath)
    try {
      const nfos = fs.readdirSync(dir).filter(x => extOf(x) === 'nfo').map(x => path.join(dir, x))
      const nf = nfos.find(x => bare(baseOf(x)).includes(b)) || (nfos.length === 1 ? nfos[0] : null)
      if (nf) { out.nfoPath = nf; out.nfo = parseNfoText(fs.readFileSync(nf, 'utf8')) }
    } catch (_) {}
  }
  const n = out.nfo || {}
  out.values = {
    title: n.title || '', plot: n.plot || '', release: n.release || '',
    year: n.year || String(n.release || '').slice(0, 4), runtime: Number(n.runtime) || 0,
    studio: n.studio || '', publisher: n.publisher || '', series: n.series || '', director: n.director || '',
    actors: Array.isArray(n.actors) ? n.actors : [], genres: Array.isArray(n.genres) ? n.genres : []
  }
  return out
}

  if (p === '/api/scrape/meta') {
    const code = String((new URL(req.url, 'http://x').searchParams.get('code')) || '').trim()
    const m = readMovieCache(code)
    /* 老版缓存（刮削过但没有逐字段 fields）也放行：面板里各字段显示为空，可按需逐源补抓 */
    if (!m || (!m.fields && !m.scraped)) return json(res, { ok: false, error: '该影片还没有刮削数据，请先刮削一次' })
    if (!m.fields) m.fields = {}
    const sources = {}
    for (const [id, r] of Object.entries(m.sourceData || {})) {
      const has = {}
      for (const f of SC_TEXT_FIELDS.concat(['actors', 'genres'])) {
        const v = r[f]
        has[f] = Array.isArray(v) ? v.length > 0 : (f === 'runtime' ? v > 0 : !!v)
      }
      has.year = !!(r.release || '').slice(0, 4)
      has.poster = (r.posterCands || []).length > 0
      has.fanart = (r.fanartCands || []).length > 0
      sources[id] = { usedUrl: r.usedUrl || '', has }
    }
    const imgs = Object.assign({}, m.images || {})
    /* 图片尺寸 / 文件大小：老缓存没存过就在读取时按实际文件补算 */
    const oneMeta = role => {
      if (imgs[role + 'Meta']) return true
      const u = imgs[role] || ''
      const mm = /^\/cache\/movies\/([^/?#]+)\/images\/([^/?#]+)/.exec(u)
      if (!mm) return false
      try {
        const fp = path.join(cacheDir(), 'movies', mm[1], 'images', mm[2])
        const st = fs.statSync(fp)
        const sz = imgSize(fp)
        imgs[role + 'Meta'] = { w: sz ? sz.w : 0, h: sz ? sz.h : 0, bytes: st.size }
        return true
      } catch (_) { return false }
    }
    oneMeta('poster'); oneMeta('fanart')
    /* 各来源的字段值：面板里换源可就地预览，点「确认」才写回详情页 */
    const srcVals = {}
    for (const [id, r] of Object.entries(m.sourceData || {})) {
      srcVals[id] = {
        title: r.title || '', plot: r.plot || '', release: r.release || '',
        year: (r.release || '').slice(0, 4), runtime: r.runtime || 0,
        studio: r.studio || '', publisher: r.publisher || '', series: r.series || '',
        director: r.director || '', actors: r.actors || [], genres: r.genres || []
      }
    }
    /* 本地数据（影片文件夹自带的 NFO / 海报）+ 各文件绝对路径（设置偏好里可开关显示） */
    const loc = localSourceForCode(code)
    const imgDirAbs = path.join(cacheDir(), 'movies', code.replace(/[^\w.-]/g, '_'), 'images')
    return json(res, {
      ok: true, code, fields: m.fields, images: imgs, sources, sourceData: srcVals,
      sourcesAll: scrapeSourcesOverview(code, m),
      local: loc ? { values: loc.values, hasPoster: !!loc.posterPath, hasFanart: !!loc.fanartPath } : null,
      paths: {
        video: loc ? loc.videoPath : '',
        nfo: loc ? loc.nfoPath : '',
        posterLocal: loc ? loc.posterPath : '',
        fanartLocal: loc ? loc.fanartPath : '',
        meta: movieCacheFile(code),
        posterCache: imgs.poster ? path.join(imgDirAbs, path.basename(imgs.poster)) : '',
        fanartCache: imgs.fanart ? path.join(imgDirAbs, path.basename(imgs.fanart)) : ''
      }
    })
  }
  /* 候选图信息：下拉里每个站点后面要显示「尺寸 · 大小」并与本地对比（尺寸靠下载量，结果缓存在 meta.imgCands） */
  if (p === '/api/scrape/cand-info') {
    const code = String(new URL(req.url, 'http://x').searchParams.get('code') || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    return json(res, Object.assign({ ok: true, code }, candInfoOut(code), {
      running: CANDINFO.running && CANDINFO.code === code, done: CANDINFO.done, total: CANDINFO.total
    }))
  }
  /* 触发放候探测（异步）：面板打开 / 点「量一量候选」时调，前端轮询 cand-info 收结果 */
  if (p === '/api/scrape/cand-probe') {
    const code = String(body.code || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    if (CANDINFO.running) return json(res, { ok: false, error: '正在量「' + CANDINFO.code + '」的候选图（' + CANDINFO.done + '/' + CANDINFO.total + '）' })
    if (!readMovieCache(code)) return json(res, { ok: false, error: '离线数据里没有这部影片的元数据' })
    candProbeAsync(code, !!body.force).catch(() => {})
    return json(res, { ok: true, code })
  }
  /* 粘贴站点影片详情页 → 只解析不落盘，结果并成「指定网址」源，供面板里逐字段选择性覆盖 */
  if (p === '/api/scrape/url-fetch') {
    const code = String(body.code || '').trim()
    const url = String(body.url || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    if (!/^https?:\/\//i.test(url)) return json(res, { ok: false, error: '请粘贴完整网址（以 http:// 或 https:// 开头）' })
    const m = readMovieCache(code)
    if (!m || !m.fields) return json(res, { ok: false, error: '该影片还没有多源刮削数据，请先刮削一次' })
    let r = null
    try {
      r = await scTryCandidate(code, { id: 'custom', url, cookies: /mgstage\.com/i.test(url) ? 'adc=1' : '' })
    } catch (e) { return json(res, { ok: false, error: '抓取失败：' + e.message }) }
    if (!r) return json(res, { ok: false, error: '该页面里没有找到「' + code + '」的信息（页面不含该番号 / 被反爬挡住）' })
    m.sourceData = m.sourceData || {}
    m.sourceData.custom = {
      usedUrl: r.usedUrl || url, title: r.title || '', plot: r.plot || '',
      studio: r.studio || '', publisher: r.publisher || '', series: r.series || '', director: r.director || '',
      release: r.date || r.release || '', runtime: r.runtime || 0,
      actors: r.actors || [], genres: r.genres || [],
      samples: (r.samples || []).slice(0, 6),
      posterCands: (r.posterCands || []).slice(0, 6), fanartCands: (r.fanartCands || []).slice(0, 6)
    }
    if (m.imgCands) delete m.imgCands.custom
    try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (_) {}
    const has = {}
    for (const f of SC_TEXT_FIELDS.concat(['actors', 'genres'])) {
      const v = f === 'release' ? (r.date || r.release) : r[f]
      has[f] = Array.isArray(v) ? v.length > 0 : (f === 'runtime' ? v > 0 : !!v)
    }
    has.year = !!String(r.date || r.release || '').slice(0, 4)
    has.poster = (r.posterCands || []).length > 0
    has.fanart = (r.fanartCands || []).length > 0
    return json(res, { ok: true, src: 'custom', title: r.title || '', has, sourcesAll: scrapeSourcesOverview(code, m) })
  }
  /* 按需补抓单个数据源：详情页「数据源」里对未尝试/未命中的站单独抓一次，命中后并入可换源列表 */
  if (p === '/api/scrape/source') {
    const code = String(body.code || '').trim()
    const src = String(body.src || '').trim()
    const m = readMovieCache(code)
    if (!m || !m.fields) return json(res, { ok: false, error: '没有多源刮削数据（请先刮削一次）' })
    if (!src || src === 'custom') return json(res, { ok: false, error: '缺少来源 id' })
    let r = null
    if (src === 'javdb') {
      /* JavDB 线上源不走站点候选，直接用移动端 API（国内直连） */
      try { r = await onlineScrapeSource(code) } catch (e) { return json(res, { ok: false, error: 'javdb 抓取失败：' + e.message, sourcesAll: scrapeSourcesOverview(code, m) }) }
    } else {
      const cand = scCandidatesMulti(code).find(c => c.id === src) || scCandidates(code, src).find(c => c.id === src)
      if (!cand) return json(res, { ok: false, error: src + '：该来源当前未启用或没有番号搜索模板' })
      try { r = await scTryCandidate(code, cand) } catch (e) { return json(res, { ok: false, error: src + ' 抓取失败：' + e.message }) }
    }
    m.scrapeTried = m.scrapeTried || { tried: [], skipped: [] }
    m.scrapeTried.skipped = (m.scrapeTried.skipped || []).filter(x => x !== src)
    const rec = m.scrapeTried.tried.find(x => x.id === src)
    const pick = (field, v) => { if (rec) { rec.ok = !!r; if (r) delete rec.reason; else rec.reason = v } else m.scrapeTried.tried.push({ id: src, ok: !!r, reason: r ? '' : v }) }
    if (!r) {
      const msg = src === 'javdb' ? '线上搜不到「' + code + '」（未收录或线路不通）' : '页面里没有「' + code + '」的信息（该站未收录或被反爬挡住）'
      pick(src, msg)
      try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (_) {}
      return json(res, { ok: false, error: src + '：' + msg, sourcesAll: scrapeSourcesOverview(code, m) })
    }
    r.sourceId = src
    m.sourceData = m.sourceData || {}
    m.sourceData[src] = {
      usedUrl: r.usedUrl || '', title: r.title || '', plot: r.plot || '',
      studio: r.studio || '', publisher: r.publisher || '', series: r.series || '', director: r.director || '',
      release: r.date || r.release || '', runtime: r.runtime || 0, actors: r.actors || [], genres: r.genres || [],
      posterCands: r.posterCands || [], fanartCands: r.fanartCands || [], samples: r.samples || []
    }
    if (m.images) { delete m.images.posterUpTried; delete m.images.fanartUpTried }   // 新候选到了，解除「已试无更大」标记
    pick(src, '')
    try {
      fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true })
      fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2))
    } catch (_) {}
    mirrorMeta(code)
    const has = {}
    for (const f of SC_TEXT_FIELDS.concat(['actors', 'genres'])) {
      const v = f === 'release' ? (r.date || r.release) : r[f]   // 解析结果里日期键叫 date
      has[f] = Array.isArray(v) ? v.length > 0 : (f === 'runtime' ? v > 0 : !!v)
    }
    has.year = !!String(r.date || r.release || '').slice(0, 4)
    has.poster = (r.posterCands || []).length > 0
    has.fanart = (r.fanartCands || []).length > 0
    return json(res, {
      ok: true, src, has, title: r.title || '',
      sourcesAll: scrapeSourcesOverview(code, m)
    })
  }
  /* mdc-ng 规则自测：/api/scrape/mdc-test?src=avbase&code=ABC-123
   * 直接跑该数据源的 mdc-ng 规则，回显解析到的每个字段（排查规则/站点改版用） */
  if (p === '/api/scrape/mdc-test') {
    const q = new URL(req.url, 'http://x').searchParams
    const code = String(q.get('code') || '').trim()
    const src = String(q.get('src') || '').trim()
    if (!code || !src) return json(res, { ok: false, error: '需要 src 与 code 参数' })
    const rule = MDCNG.ruleFor(src)
    if (!rule) return json(res, { ok: false, error: src + '：没有对应的 mdc-ng 规则（规则文件见 rules/mdc-ng/）', rules: Object.keys(MDCNG.listRules()) })
    const cand = scCandidates(code, src).find(x => x.id === src) || { id: src, cookies: (rule.settings || {}).cookies || '' }
    const oldLog = SCRAPE.log
    SCRAPE.log = []
    try {
      const r = await scMdcCandidate(code, cand, rule)
      return json(res, {
        ok: !!(r.parsed && r.parsed.title), src, code, category: mdcCategoryOf(code),
        ruleFile: rule.__file, baseUrl: rule.base_url,
        number: MDCNG.baseContext(rule, code),
        fields: r.parsed || null, reason: r.reason || '', logs: SCRAPE.log
      })
    } finally { SCRAPE.log = oldLog }
  }
  /* 单独换某字段的来源：文本字段直接取该源的值；主图字段从该源候选重新下载 */
  if (p === '/api/scrape/field') {
    const code = String(body.code || '').trim()
    const field = String(body.field || '').trim()
    const src = String(body.src || '').trim()
    const m = readMovieCache(code)
    if (!m || !m.fields) return json(res, { ok: false, error: '没有刮削数据（请先刮削一次）' })
    const manual = body.value !== undefined
    const isLocal = src === '__local'          // 「使用本地数据」：影片文件夹自带的 NFO / 海报
    const loc = isLocal ? localSourceForCode(code) : null
    if (isLocal && (!loc || !loc.values)) return json(res, { ok: false, error: '这部影片没有本地数据（媒体库里找不到对应的视频 / NFO）' })
    const r = (manual || isLocal) ? null : m.sourceData[src]
    if (!manual && !isLocal && !r) return json(res, { ok: false, error: m.sourceData ? ('来源不存在：' + src) : '没有多源刮削数据（请重新刮削一次）' })
    if (field === 'poster' || field === 'fanart') {
      if (isLocal) {
        /* 本地海报：把影片文件夹里那张图原样拷进离线数据（不联网、不重新下载） */
        const sp = field === 'poster' ? loc.posterPath : loc.fanartPath
        if (!sp) return json(res, { ok: false, error: '影片文件夹里没有' + (field === 'poster' ? '竖版海报' : '横版主图') })
        try {
          const dirAbs = path.join(cacheDir(), 'movies', code.replace(/[^\w.-]/g, '_'))
          const imgDir = path.join(dirAbs, 'images')
          fs.mkdirSync(imgDir, { recursive: true })
          const dst = path.join(imgDir, field + '.jpg')
          fs.copyFileSync(sp, dst)
          const sz = imgSize(dst)
          if (!sz) throw new Error('不是有效图片')
          let bytes = 0; try { bytes = fs.statSync(dst).size } catch (_) {}
          m.images[field] = '/cache/movies/' + path.basename(dirAbs) + '/images/' + field + '.jpg'
          m.images[field + 'Src'] = '本地数据'
          m.images[field + 'Meta'] = { w: sz.w, h: sz.h, bytes }
          m.scrapedAt = new Date().toISOString()   // 改版本号，详情页封面立即刷新
        } catch (e) { return json(res, { ok: false, error: '本地' + (field === 'poster' ? '竖版海报' : '横版主图') + '不可用：' + e.message }) }
      } else {
      const cands = field === 'poster' ? (r.posterCands || []) : (r.fanartCands || [])
      if (!cands.length) return json(res, { ok: false, error: '该来源没有' + (field === 'poster' ? '竖版海报' : '横版主图') + '候选' })
      try {
        const one = await scSaveOne(path.join(cacheDir(), 'movies', code.replace(/[^\w.-]/g, '_')), cands, field)
        m.images[field] = one.url
        m.images[field + 'Src'] = src
        m.images[field + 'Meta'] = { w: one.w, h: one.h, bytes: one.bytes }
        m.scrapedAt = new Date().toISOString()   // 换图后改版本号，详情页的封面立即刷新
      } catch (e) { return json(res, { ok: false, error: e.message }) }
      }
    } else if (field === 'year') {
      const v = isLocal ? String(loc.values.release || '').slice(0, 4) : String(r.release || '').slice(0, 4)
      if (!v) return json(res, { ok: false, error: isLocal ? '本地 NFO 里没有发行日期' : '该来源没有发行日期，无法取年份' })
      m.fields.year = { v, src: isLocal ? '本地数据' : src }
      m.fields.release = { v: isLocal ? loc.values.release : r.release, src: isLocal ? '本地数据' : src }
      m.year = v; m.release = isLocal ? loc.values.release : r.release
    } else if (SC_TEXT_FIELDS.includes(field) || field === 'actors' || field === 'genres') {
      if (body.value !== undefined) {
        // 手动编辑：body.value 存在时直接采用用户输入，来源标「手动」；重新刮削会被覆盖
        const raw = String(body.value).trim()
        const v = (field === 'actors' || field === 'genres')
          ? raw.split(/[、，,;；\n]+/).map(s => s.trim()).filter(Boolean)
          : (field === 'runtime' ? (Math.round(parseFloat(raw)) || 0) : raw)
        m.fields[field] = { v, src: '手动' }
        m[field] = v
        if (field === 'release') {   // 手动改发行日期，年份跟着走
          const y = String(v || '').slice(0, 4)
          m.year = y; m.fields.year = { v: y, src: '手动' }
        }
      } else if (isLocal) {
        const v = loc.values[field]
        const ok = Array.isArray(v) ? v.length > 0 : (field === 'runtime' ? v > 0 : !!v)
        if (!ok) return json(res, { ok: false, error: '本地 NFO 里没有「' + field + '」' })
        m.fields[field] = { v, src: '本地数据' }
        m[field] = v
        if (field === 'release') { const y = String(v || '').slice(0, 4); m.year = y; m.fields.year = { v: y, src: '本地数据' } }
      } else {
        const v = r[field]
        const ok = Array.isArray(v) ? v.length > 0 : (field === 'runtime' ? v > 0 : !!v)
        if (!ok) return json(res, { ok: false, error: '该来源没有「' + field + '」的数据' })
        m.fields[field] = { v, src }
        m[field] = v
        if (field === 'release') {   // 发行日期换了来源，年份跟着走，避免两者对不上
          const y = String(v || '').slice(0, 4)
          m.year = y; m.fields.year = { v: y, src }
        }
      }
    } else return json(res, { ok: false, error: '不支持的字段：' + field })
    try {
      fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true })
      fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2))
    } catch (_) {}
    mirrorMeta(code)
    patchDataItem(code)
    return json(res, { ok: true, fields: m.fields, images: m.images })
  }
  /* 抓取探针：走真正的刮削链路（scFetch + scRows）诊断某站点/某详情页是否可用 */
  if (p === '/api/scrape/probe') {
    const url = String(body.url || '').trim()
    if (!/^https?:\/\//.test(url)) return json(res, { ok: false, error: '缺少 url' })
    const t0 = Date.now()
    try {
      const html = await scFetch(url, { hdrs: body.cookie ? { cookie: String(body.cookie) } : {} })
      const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const code = norm(body.code)
      const out = {
        ok: true, ms: Date.now() - t0, len: html.length,
        title: (titleM ? scText(titleM[1]) : '').slice(0, 80),
        rows: scRows(html).length,
        hasCode: !!code && norm(scText(html).slice(0, 40000)).includes(code)
      }
      if (body.parse) {   // 诊断解析规则：把 scParsePage 的识别结果摘出来（配数据源排查用）
        const p = scParsePage(html, url, body.code || '')
        const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        out.parse = p ? {
          title: (p.title || '').slice(0, 90), studio: p.studio, publisher: p.publisher,
          series: p.series, director: p.director, date: p.date, runtime: p.runtime,
          actors: (p.actors || []).slice(0, 4), genres: (p.genres || []).slice(0, 6),
          cover: (p.cover || '').slice(0, 120), posterCands: (p.posterCands || []).length,
          fanartCands: (p.fanartCands || []).length, samples: (p.samples || []).length
        } : null
        out.codeInFirst30k = norm(scText(html).slice(0, 30000)).includes(norm(bare(body.code || '')))
        out.codeInFirst40k = norm(scText(html).slice(0, 40000)).includes(norm(bare(body.code || '')))
        out.codeAnywhere = norm(scText(html)).includes(norm(bare(body.code || '')))
        out.rows = scRows(html).length
        const rs = scRows(html)
        out.rowLabels = rs.map(r => scText(r).slice(0, 26)).slice(0, 24)   // 站点页面里的「键值行」都是什么
        out.idRow = scText(scPick(rs, ['識別碼', '识别码', '識別', '识别', '品番', '番号'])).slice(0, 60)
        out.titlePre = scText(scMetaTag(html, 'og:title') || (html.match(/<h[13][^>]*>([\s\S]{5,300}?)<\/h[13]>/i) || [, ''])[1]).slice(0, 80)
        out.ncode = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        out.urlHasCode = norm(url).includes(norm(bare(body.code || '')))
        out.ogImage = (scMetaTag(html, 'og:image') || '').slice(0, 130)
        out.cntSampleImage = (html.match(/class="sample_image"/gi) || []).length
        out.cntJacketSample = (html.match(/jacket_sample[^\s"'<>]*\.jpg/gi) || []).length
        out.cntSampleWaterfall = (html.match(/sample-waterfall/gi) || []).length
        out.cntDmmPics = (html.match(/https?:\/\/pics\.dmm\.co\.jp\/[^\s"'<>]+\.jpg/gi) || []).length
        out.dmmPics = [...new Set(html.match(/https?:\/\/pics\.dmm\.co\.jp\/[^\s"'<>]+\.jpg/gi) || [])].slice(0, 16)
        out.dmmRows = scDmmRows(html).map(r => r[0] + '＝' + r[1]).slice(0, 14)
      }
      if (body.around) {   // 诊断解析规则：返回关键字附近的 HTML 片段
        const i = html.indexOf(String(body.around))
        out.snippet = i < 0 ? '' : html.slice(Math.max(0, i - 250), i + 900)
      }
      return json(res, out)
    } catch (e) { return json(res, { ok: false, ms: Date.now() - t0, error: e.message }) }
  }
  /* 识别失败待处理：手动改番号/标题（无 nfo、无海报、刮不出元数据的视频）。改番号持久化到
   * manual-codes.json（重扫仍生效），改标题写入该番号的缓存 meta（scrapeTitle 通道，重扫仍生效）。 */
  if (p === '/api/scrape/pending-fix') {
    const relVideo = String(body.relVideo || '').trim()
    const it = ((DATA && DATA.items) || []).find(x => x.relVideo === relVideo)
    if (!it) return json(res, { ok: false, error: '条目不存在（可能已重新扫描，请刷新后重试）' })
    if (body.code !== undefined) {
      const nc = norm(String(body.code).trim())
      if (!nc) return json(res, { ok: false, error: '番号不能为空' })
      if (nc !== it.code) { saveManualCode(relVideo, nc); it.code = nc }
    }
    if (!it.code) return json(res, { ok: false, error: '请先填一个番号（如 STARS-238），否则无法保存标题或刮削' })
    if (body.title !== undefined && String(body.title).trim()) {
      const t = String(body.title).trim()
      const m = readMovieCache(it.code) || { code: it.code }
      m.title = t
      m.source = m.source || '手动'
      m.fields = m.fields || {}
      m.fields.title = { v: t, src: '手动' }
      m.scrapedAt = new Date().toISOString()
      try {
        fs.mkdirSync(path.dirname(movieCacheFile(it.code)), { recursive: true })
        fs.writeFileSync(movieCacheFile(it.code), JSON.stringify(m, null, 2))
        mirrorMeta(it.code)
      } catch (e) { return json(res, { ok: false, error: '写入离线数据失败：' + e.message }) }
    }
    enrichFromCache(it)
    if (it.scrapeTitle || it.scraped) it.pending = false
    return json(res, { ok: true, code: it.code, title: it.scrapeTitle || it.title, pending: !!it.pending })
  }
  if (p === '/api/scrape/list') return json(res, { ok: true, items: scrapedVirtualItems() })
  if (p === '/api/scrape/remove') {
    const code = String(body.code || '').trim()
    const root = path.join(cacheDir(), 'movies')
    const dir = path.join(root, code.replace(/[^\w.-]/g, '_'))
    if (!code || !dir.startsWith(root + path.sep)) return json(res, { ok: false, error: '非法番号' })
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { return json(res, { ok: false, error: e.message }) }
    return json(res, { ok: true })
  }
  /* ---------- 彻底删除影片（详情页「删除」按钮）----------
   * 语义（与回收站不同，这个是真删）：
   *   1. 库里有视频文件 → 每个版本的视频文件一并删除；
   *   2. 元数据/图片这类离线数据 → 整个番号文件夹（cache/movies/<番号>/）删除；
   *      inline 元数据模式外发到视频目录里的 meta.json/NFO/图片也顺手清掉（视频目录只剩空壳时连目录一起删）；
   *   3. 视频在网盘挂载路径上、因权限（只读/凭证过期）删不掉 → 不吞错，
   *      把 errno 翻译成人话 + 具体路径返回，前端明确提示去给权限。 */
  if (p === '/api/movie/delete') {
    const code = String(body.code || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    const items = (DATA && Array.isArray(DATA.items) ? DATA.items : []).filter(x => bare(x.code) === bare(code))
    /* 收集该番号全部视频文件（多版本合并的 files[] 也算） */
    const vids = []
    for (const it of items) {
      for (const r of [it.relVideo].concat((it.files || []).map(f => f.relVideo))) {
        if (r && !vids.includes(r)) vids.push(r)
      }
    }
    const permMsg = e => {
      const c = e && (e.code || e.errno)
      if (c === 'EACCES' || c === 'EPERM') return '权限不足（' + c + '）—— 网盘挂载可能是只读，或当前凭证没有删除权限，请在挂载端给写权限/重新登录'
      if (c === 'EROFS') return '文件系统只读（EROFS）—— 挂载以只读方式接入，需要在挂载配置里开读写'
      if (c === 'EIO') return 'I/O 错误（EIO）—— 网盘连接中断或挂载已失效，重新挂载后再试'
      if (c === 'EBUSY') return '文件被占用（EBUSY）—— 有播放器/下载工具正开着这个文件'
      if (c === 'ENOENT') return '文件不存在（可能已删除过）'
      return (e && e.message) || String(c || '未知错误')
    }
    const videos = [], videosFailed = []
    for (const rel of vids) {
      const fp = safeMediaPath(rel)
      if (!fp) { videosFailed.push({ path: rel, error: '路径越界，拒绝删除' }); continue }
      try { fs.rmSync(fp, { force: true }); videos.push(rel) }
      catch (e) { videosFailed.push({ path: rel, error: permMsg(e) }) }
    }
    /* inline 元数据：视频删掉后，同目录里外发的 meta.json / NFO / 图片也清掉 */
    const inlineDirs = new Set()
    if (CFG.metaMode === 'inline') {
      for (const rel of vids) {
        const fp = safeMediaPath(rel); if (!fp) continue
        const d = path.dirname(fp)
        if (!d.startsWith(MEDIA_ROOT + path.sep) || /(^|\/)_trash(\/|$)/.test(path.relative(MEDIA_ROOT, d))) continue
        /* 同目录还有别的番号的视频 → 不动外发文件，避免误删别人的元数据 */
        const other = ((DATA && DATA.items) || []).some(x => bare(x.code) !== bare(code) &&
          ((x.relVideo && path.dirname(safeMediaPath(x.relVideo) || '') === d) ||
           (x.files || []).some(f => f.relVideo && path.dirname(safeMediaPath(f.relVideo) || '') === d)))
        if (other) continue
        inlineDirs.add(d)
        for (const n of ['meta.json', 'movie.nfo']) { try { fs.rmSync(path.join(d, n), { force: true }) } catch (_) {} }
        try {
          for (const n of fs.readdirSync(d)) if (/^(poster|fanart|sample\d+)\.(jpe?g|png|webp)$/i.test(n)) { try { fs.rmSync(path.join(d, n), { force: true }) } catch (_) {} }
        } catch (_) {}
      }
    }
    /* 目录空了就连目录一起删（外发元数据不留空壳文件夹） */
    for (const d of inlineDirs) {
      try { if (!fs.readdirSync(d).length) fs.rmdirSync(d) } catch (_) {}
    }
    /* 离线数据：整个番号文件夹（meta.json + images + 磁力缓存） */
    const root = path.join(cacheDir(), 'movies')
    const offDir = offlineCodeDir(code, items[0])
    let offline = false, offlineErr = ''
    if (offDir.startsWith(root + path.sep) && fs.existsSync(offDir)) {
      try { fs.rmSync(offDir, { recursive: true, force: true }); offline = true }
      catch (e) { offlineErr = '离线数据文件夹删除失败：' + e.message }
    }
    /* 库条目与观看记录出清（视频没删成的条目保留，方便重试） */
    if (!videosFailed.length && DATA && Array.isArray(DATA.items)) {
      const prefixes = vids.map(r => (r.split('/').slice(0, -1).join('/')))
      DATA.items = DATA.items.filter(x => bare(x.code) !== bare(code))
      Object.keys(WATCH).forEach(k => {
        const rel = k.replace(/^\//, '')
        if (vids.some(v => rel === v || rel.startsWith(v + '/')) || prefixes.some(p => p && rel.startsWith(p + '/'))) delete WATCH[k]
      })
      watchSaveSoon()
    }
    try { rescan() } catch (_) {}
    if (videosFailed.length) {
      return json(res, {
        ok: false,
        error: '部分文件删除失败（权限问题）：\n' + videosFailed.map(f => '· ' + f.path + '\n  ' + f.error).join('\n'),
        videos, videosFailed, offline, offlineErr
      })
    }
    return json(res, { ok: true, code, videos, offline, offlineErr })
  }
  return json(res, { ok: false, error: 'unknown api' })
}

/* 文件夹浏览：逐级选择子文件夹（Emby 同款体验），只允许挂载点以内 */
function libraryBrowse(q) {
  let raw = String(q || '').trim()
  if (raw.startsWith('~/')) raw = path.join(MEDIA_ROOT, raw.slice(1))
  const dir = raw ? path.resolve(raw) : MEDIA_ROOT
  if (!(dir === MEDIA_ROOT || dir.startsWith(MEDIA_ROOT + path.sep)))
    return { ok: false, error: '只能浏览挂载目录以内' }
  let dirs = []
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .slice(0, 500)
  } catch (_) {}
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { ok: true, root: MEDIA_ROOT, hostPath: readMediaPathFile() || '', path: dir, parent: dir === MEDIA_ROOT ? null : path.dirname(dir), dirs }
}

/* ================= 项目内置动作 ①：刮削后自动原地整理 =================
 * 开关：设置 → 刮削（CFG.autoOrganize）。开启后每部影片刮削成功即把该番号的视频
 * 原地整理成 <番号>/<番号>-标签.ext —— 与「添加 → 导入视频整理」同一套命名规则，
 * 等于自动替你点了那次「整理」。rename 只动元数据，网盘挂载下也是秒完成。
 * 标签只按相对路径判定（与手动整理扫 /media 时的口径一致），不掺入挂载根目录名。 */
const orgValidCode = c => !!c && ((/[A-Z]/.test(c) && /\d/.test(c)) || /^\d{6}[-_]\d{2,4}$/.test(c))
function orgTagPart(rel) {
  const tags = videoTagsOf(String(rel || ''), 0, 0)
    .filter(t => !['4K', '2K', '1080P', '720P', '480P'].includes(t))
  return tags.length ? '-' + tags.join('-') : ''
}
function autoOrganizeCode(code) {
  const key = bare(code)
  const items = ((DATA && DATA.items) || []).filter(it => it.relVideo && bare(it.code) === key)
  if (!items.length) return { moved: [], failed: [] }
  /* 目标名用「规范番号」（norm 保留连字符：SSIS-001），不能拿 bare() 的结果当名字 ——
   * bare 会去掉连字符变成 SSIS001，和「添加 → 导入视频整理」的命名对不上。 */
  const canon = norm(items[0].code || code)
  if (!orgValidCode(canon)) return { moved: [], failed: [], skipped: '番号不合法' }
  const dirName = String(canon).replace(/[^\w.-]/g, '_')
  const moved = [], failed = []
  for (const it of items) {
    try {
      const rel = String(it.relVideo).split(path.sep).join('/')
      const src = safeMediaPath(rel)
      if (!src) { failed.push({ file: rel, msg: '路径越界' }); continue }
      let st; try { st = fs.statSync(src) } catch (_) { continue }
      if (!st.isFile()) continue
      const parentRel = path.dirname(rel)
      const parentBase = parentRel === '.' ? '' : path.basename(parentRel)
      const parentIsCode = !!parentBase && bare(parentBase) === key
      /* 父目录已经是番号 → 原地；父目录是番号的别名写法（SSIS001）→ 一并改成规范写法 */
      const dirRel = parentIsCode
        ? (parentBase === dirName ? parentRel : path.join(path.dirname(parentRel), dirName))
        : (parentRel === '.' ? dirName : path.join(parentRel, dirName))
      const cdInName = /-cd(\d+)$/i.exec(baseOf(rel))
      const targetRel = path.join(dirRel, dirName + orgTagPart(rel) + (cdInName ? '-cd' + cdInName[1] : '') + path.extname(rel)).split(path.sep).join('/')
      const dst = path.resolve(MEDIA_ROOT, targetRel)
      if (dst === src) continue                                   // 已符合规范
      if (!dst.startsWith(MEDIA_ROOT + path.sep)) { failed.push({ file: rel, msg: '目标越界' }); continue }
      if (fs.existsSync(dst)) { failed.push({ file: rel, msg: '目标已存在：' + path.basename(dst) }); continue }
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.renameSync(src, dst)
      moved.push({ from: rel, to: targetRel })
      // 旧番号文件夹（别名写法）空了就顺手删掉，别留一堆空目录
      if (parentIsCode && parentBase !== dirName) { try { fs.rmdirSync(path.dirname(src)) } catch (_) {} }
    } catch (e) { failed.push({ file: it.relVideo, msg: e.message }) }
  }
  return { moved, failed }
}

/* ================= 项目内置动作 ②：女优人气榜每日更新 =================
 * 不依赖任何外部定时任务：服务自己在每天 rankHour 点刷一遍 minnano 日/周/月榜，
 * 写回项目里的 rankings.json（缺资料的女优补进内置补充名册 actresses-extra.json）。
 * 启动 90 秒后先检查一次，之后每 10 分钟检查一次（当天已更新就跳过，失败隔一小时再试）。 */
const RANK_FILE = path.join(UI_ROOT, 'rankings.json')
const RANKUP = { running: false, phase: '', error: '', added: 0, count: 0, finishedAt: 0 }
function rankHour() { const h = parseInt(CFG.rankHour, 10); return isNaN(h) ? 4 : Math.max(0, Math.min(23, h)) }
function rankUpdatedAt() { try { return JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')).updatedAt || 0 } catch (_) { return 0 } }
const rankNorm = s => String(s || '').replace(/[\s\u3000・]/g, '').toLowerCase()
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
async function rankUpdateAsync() {
  if (RANKUP.running) return { ok: false, error: '更新中' }
  RANKUP.running = true; RANKUP.phase = '准备'; RANKUP.error = ''; RANKUP.added = 0; RANKUP.count = 0
  try {
    const main = (() => { try { const v = JSON.parse(fs.readFileSync(ROSTER, 'utf8')); return Array.isArray(v) ? v : [] } catch (_) { return [] } })()
    const extra = readExtraRoster()
    const byMnid = new Map(), byName = new Map()
    for (const a of main.concat(extra)) {
      if (a.mnid && !byMnid.has(String(a.mnid))) byMnid.set(String(a.mnid), a)
      const k = rankNorm(a.name); if (k && !byName.has(k)) byName.set(k, a)
    }
    const modes = [['day', 'ranking_actress.php?daily'], ['week', 'ranking_actress.php'], ['month', 'ranking_actress.php?monthly']]
    const out = {}, fresh = []
    let viaRelay = false, relayAt = 0
    for (const [key, q] of modes) {
      RANKUP.phase = '抓取 ' + key + ' 榜'
      let rows = []
      const html = await mnFetch(MN_BASE + q, false)
      if (html) rows = parseRankRows(html)
      if (!rows.length) {   // minnano 不可达（SNI 阻断）→ 走 GitHub Actions 云端中转
        const rel = await relayJson('rankings.json', 20000)
        rows = (rel && Array.isArray(rel[key]) ? rel[key] : []).filter(x => x && x.id && x.name)
        if (rows.length) { viaRelay = true; relayAt = Math.max(relayAt, +rel.fetchedAt || 0); RANKUP.phase = '中转 ' + key + ' 榜' }
      }
      if (!rows.length) throw new Error('无法访问 minnano-av.com' + (mnFetch.lastErr ? '（' + mnFetch.lastErr + '）' : '') + '，且云端中转暂无数据')
      RANKUP.phase = '整理 ' + key + ' 榜'
      out[key] = rows.map(x => {
        let a = byMnid.get(String(x.id)) || byName.get(rankNorm(x.name))
        if (!a) {   // 榜上但名册里没有 → 补进项目内置补充名册，点开才有资料页
          a = { name: x.name, name_ja: x.name, mnid: String(x.id), videoCount: x.works || 0, alias: [], tags: [], msrc: MN_BASE + 'actress' + x.id + '.html' }
          fresh.push(a); byMnid.set(String(x.id), a); byName.set(rankNorm(x.name), a)
        }
        const lk = String(a.lid || a.mnid || ('mn' + x.id))
        const fname = lk + '.jpg'
        return {
          rank: x.rank, name: x.name, mnid: String(x.id), works: x.works, lid: lk, name_zh: a.name_zh || '',
          avatar: '/actresses/' + fname   // 本地缺图时由头像在线兜底服务
        }
      })
      RANKUP.count += rows.length
    }
    if (fresh.length) { try { writeExtraRoster(extra.concat(fresh)); RANKUP.added = fresh.length; AVA_ONLINE_INDEX = null } catch (_) {} }
    const tmp = RANK_FILE + '.tmp'
    // 走中转时 updatedAt 记中转数据的时间：数据新鲜（当天）就不再重试，过期了每小时自动重试
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: viaRelay && relayAt ? relayAt : Date.now(), via: viaRelay ? 'relay' : 'direct', day: out.day, week: out.week, month: out.month }))
    fs.renameSync(tmp, RANK_FILE)   // /rankings.json 是静态直出，替换文件即生效，无需清缓存
    RANKUP.phase = '完成'
    console.log('[rank] 每日榜单已更新（' + (viaRelay ? '云端中转' : '直连') + '）：' + RANKUP.count + ' 条，新增女优 ' + RANKUP.added + ' 人')
    return { ok: true, count: RANKUP.count, added: RANKUP.added }
  } catch (e) {
    RANKUP.error = e.message; RANKUP.phase = '失败'
    console.log('[rank] 更新失败：' + e.message)
    return { ok: false, error: e.message }
  } finally { RANKUP.running = false; RANKUP.finishedAt = Date.now() }
}
let rankLastTry = 0
function rankAutoTick() {
  if (CFG.rankAuto === false) return           // 设置里关掉了
  if (RANKUP.running) return
  const now = new Date()
  if (now.getHours() < rankHour()) return      // 还没到今天的更新时刻
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rankHour()).getTime()
  if (rankUpdatedAt() >= todayAt) return       // 今天已经更新过
  if (Date.now() - rankLastTry < 55 * 60 * 1000) return   // 失败后至少隔一小时再试
  rankLastTry = Date.now()
  rankUpdateAsync().catch(() => {})
}
setInterval(rankAutoTick, 10 * 60 * 1000)
setTimeout(rankAutoTick, 90 * 1000)

/* ---------- 每日自动重扫（设置 → 自动化，默认每天 05:00） ----------
 * 不依赖 NAS 定时任务：服务自己每天到了 autoRescanHour 就把媒体库重扫一遍。
 * 当天扫过就跳过；正在手动扫描时本轮让路；扫描失败不记「今天已扫」，隔 1 小时重试。
 * 扫完后若「扫描后自动刮削」开着，新番号会一并排队刮好。 */
function autoRescanHour() { const h = parseInt(CFG.autoRescanHour, 10); return isNaN(h) ? 5 : Math.max(0, Math.min(23, h)) }
const AUTOSCAN_FILE = path.join(UI_ROOT, 'autoscan-state.json')
function autoRescanLast() { try { return JSON.parse(fs.readFileSync(AUTOSCAN_FILE, 'utf8')).last || 0 } catch (_) { return 0 } }
function autoRescanMark() { try { fs.writeFileSync(AUTOSCAN_FILE, JSON.stringify({ last: Date.now() })) } catch (_) {} }
let autoRescanTrying = 0
function autoRescanTick() {
  if (CFG.autoRescan !== true) return             // 设置里没开
  if (SCAN.running) return                        // 正在扫：本轮跳过，10 分钟后再看
  const now = new Date()
  if (now.getHours() < autoRescanHour()) return   // 还没到今天的扫描时刻
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), autoRescanHour()).getTime()
  if (autoRescanLast() >= todayAt) return         // 今天已经扫过
  if (Date.now() - autoRescanTrying < 55 * 60 * 1000) return   // 失败后至少隔一小时再试
  autoRescanTrying = Date.now()
  console.log('[autoscan] 每日自动重扫开始')
  scanAsync().then(() => {
    if (SCAN.error) { console.log('[autoscan] 自动重扫失败：' + SCAN.error + '（隔 1 小时再试）'); return }
    autoRescanMark()
    console.log('[autoscan] 每日自动重扫完成')
  })
}
setInterval(autoRescanTick, 10 * 60 * 1000)
setTimeout(autoRescanTick, 3 * 60 * 1000)   // 启动 3 分钟后先检查一次（补上停机期间错过的时点）
/* 内置补充名册：项目自带文件（首次运行自动建），随项目一起备份 */
try { if (!fs.existsSync(EXTRA_ROSTER)) fs.writeFileSync(EXTRA_ROSTER, '[]') } catch (_) {}

/* ================================================================
 * MissAV 在线播放（借鉴 happy-capy 的线路发现 + 镜像中转架构）
 *   线路发现：X99 导航站（x99dh.cc/vip/my/pro）首页 encodedData
 *             → base64+URI 解码 → name=MissAV 的 urls 数组（免翻镜像列表）
 *   视频解析：镜像详情页 /cn/<番号> → 解 Dean Edwards packer → surrit.com/<uuid>/playlist.m3u8
 *   播放中转：surrit 对大陆 IP 封锁 + jmpres 校验 Referer，浏览器无法直连，
 *             由本服务按 <镜像>/jmpres/surrit.com/<uuid>/… 取流并重写 m3u8；
 *             302 落地的 CDN 带 Access-Control-Allow-Origin:* ，hls.js 直接可用。
 *   镜像全部为国内可直连域名，不走代理（代理只给刮削等其他出网用）。
 * ================================================================ */
const MISSAV_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/604.1.14 (KHTML, like Gecko)'
const MISSAV_X99_HOSTS = ['x99dh.cc', 'x99dh.vip', 'x99dh.my', 'x99dh.pro']
const MISSAV_FALLBACK_ROUTES = ['https://www.njavtv.my', 'https://www.thisav.my', 'https://www.missav888.cc', 'https://www.njav01.net', 'https://www.missav.watch']
const MISSAV = { routes: [], routesTs: 0, health: new Map(), resolved: new Map() }   // resolved: code -> {uuid, site, ts}

function mvHealth(site) {
  if (!MISSAV.health.has(site)) MISSAV.health.set(site, { failures: 0, cooldownUntil: 0 })
  return MISSAV.health.get(site)
}
function mvNote(site, ok) {
  const h = mvHealth(site)
  if (ok) { h.failures = 0; h.cooldownUntil = 0 }
  else { h.failures++; h.cooldownUntil = Date.now() + Math.min(5, h.failures) * 60 * 1000 }
}

/* 直连抓取（不走代理；失败且配置了代理时兜底走一次代理），手动跟随重定向 */
function mvOnce(url, hdrs = {}, deadlineMs = 20000, useProxy = false) {
  return new Promise((resolve, reject) => {
    const uu = new URL(url)
    const o = {
      host: uu.hostname, port: uu.port || 443, path: uu.pathname + uu.search, method: 'GET',
      headers: Object.assign({ 'user-agent': MISSAV_UA, accept: 'text/html,*/*' }, hdrs)
    }
    const pUrl = useProxy ? proxyUrl() : ''
    if (pUrl) o.agent = tunnelAgent(pUrl)
    delete o.headers.__proxied
    const rq = https.request(o, rs => {
      const chunks = []
      rs.on('data', c => chunks.push(c))
      rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, buf: Buffer.concat(chunks) }))
    })
    const dl = setTimeout(() => rq.destroy(new Error('timeout')), deadlineMs)
    rq.on('error', e => { clearTimeout(dl); reject(e) })
    rq.end()
  })
}
async function mvFetch(url, hdrs = {}, deadlineMs = 20000) {
  let cur = url
  for (let hop = 0; hop <= 5; hop++) {
    let rs
    try { rs = await mvOnce(cur, hdrs, deadlineMs) }
    catch (e) {
      if (proxyUrl() && !hdrs.__proxied) {   // 直连挂了 → 兜底走代理再试一次
        try { rs = await mvOnce(cur, Object.assign({}, hdrs, { __proxied: 1 }), deadlineMs, true) }
        catch (e2) { throw e2 }
      } else throw e
    }
    if ([301, 302, 303, 307, 308].includes(rs.status) && rs.headers.location) {
      cur = new URL(rs.headers.location, cur).href
      continue
    }
    rs.finalUrl = cur
    return rs
  }
  throw new Error('重定向次数过多')
}

/* X99 导航站线路发现（1 小时缓存； healthy 优先排序在 resolve 时做） */
async function missavRoutes() {
  if (MISSAV.routes.length && Date.now() - MISSAV.routesTs < 3600e3) return MISSAV.routes
  for (const h of MISSAV_X99_HOSTS) {
    try {
      const rs = await mvFetch('https://' + h + '/', {}, 12000)   // X99 首页常回 500，但内容可用（happy-capy 同款处理）
      const m = String(rs.buf).match(/encodedData\s*=\s*(['"])([^'"]+)\1/)
      if (!m) continue
      let raw = Buffer.from(m[2], 'base64').toString('utf8')
      let sites = null
      for (const cand of [raw, decodeURIComponent(raw)]) {
        try { sites = JSON.parse(cand); break } catch (_) {}
      }
      const mv = Array.isArray(sites) && sites.find(s => s && s.name === 'MissAV' && Array.isArray(s.urls))
      if (mv && mv.urls.length) {
        MISSAV.routes = mv.urls.map(x => String(x.url || '').replace(/\/+$/, '').replace(/\/cn$/, '')).filter(Boolean)
        MISSAV.routesTs = Date.now()
        console.log('[missav] 线路发现成功：' + MISSAV.routes.length + ' 个镜像（' + h + '）')
        return MISSAV.routes
      }
    } catch (_) {}
  }
  MISSAV.routes = MISSAV_FALLBACK_ROUTES.slice()
  MISSAV.routesTs = Date.now()
  console.log('[missav] X99 发现失败，使用内置兜底镜像 ' + MISSAV.routes.length + ' 个')
  return MISSAV.routes
}

/* 解 Dean Edwards packer（eval(function(p,a,c,k,e,d)...)）→ 取 surrit m3u8 */
function missavUnpack(html) {
  const m = String(html || '').match(/eval\(function\(p,a,c,k,e,d\)[\s\S]{0,3000}?\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*\d+,\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/)
  if (!m) return {}
  const radix = Number(m[2]), words = m[3].split('|')
  if (!(radix >= 2 && radix <= 36) || words.length > 256) return {}
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  const expanded = payload.replace(/\b[0-9a-z]+\b/gi, tok => {
    const i = parseInt(tok, radix)
    return (Number.isInteger(i) && words[i]) ? words[i] : tok
  })
  const out = {}
  const sm = expanded.match(/\b(?:source1280|source842|source)\s*=\s*['"](https:\/\/surrit\.com\/[a-f0-9-]{36}\/[^'"\s]+\.m3u8)['"]/i)
  if (sm) out.source = sm[1]
  const um = expanded.match(/https:\/\/surrit\.com\/([a-f0-9-]{36})\//i) || null
  if (um) out.uuid = um[1]
  return out
}
function missavExtractUuid(html) {
  let m = String(html).match(/nineyu\.com\/([a-f0-9-]{36})\/seek\/_0\.jpg/i) || String(html).match(/nineyu\.com\/([a-f0-9-]{36})/i)
  if (m) return m[1]
  m = String(html).match(/https?:\/\/surrit\.com\/([a-f0-9-]{36})\//i)
  if (m) return m[1]
  const all = String(html).match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig)
  return all && all.length ? all[0] : ''
}

/* 番号 → {uuid, site}：按健康度排序镜像逐个试 /cn/<番号> */
async function missavResolve(code) {
  const key = String(code || '').trim().toLowerCase()
  const hit = MISSAV.resolved.get(key)
  if (hit && Date.now() - hit.ts < 12 * 3600e3) return hit
  const routes = await missavRoutes()
  const ordered = routes.slice().sort((a, b) => (mvHealth(a).failures - mvHealth(b).failures) || a.localeCompare(b))
  let notFound = false
  for (const site of ordered) {
    if (mvHealth(site).cooldownUntil > Date.now()) continue
    try {
      const rs = await mvFetch(site + '/cn/' + encodeURIComponent(key), {}, 20000)
      if (rs.status !== 200) { mvNote(site, false); continue }
      const html = rs.buf.toString('utf8')
      if (!/missav/i.test(html)) { mvNote(site, false); continue }
      if (/(?:已下架|影片不存在|video removed|video not found)/i.test(html)) { notFound = true; break }
      const unpacked = missavUnpack(html)
      const uuid = unpacked.uuid || missavExtractUuid(html)
      if (!uuid) { mvNote(site, false); continue }
      mvNote(site, true)
      const rec = { uuid, site, ts: Date.now() }
      MISSAV.resolved.set(key, rec)
      if (MISSAV.resolved.size > 500) MISSAV.resolved.delete(MISSAV.resolved.keys().next().value)
      console.log('[missav] ' + code + ' → uuid=' + uuid + ' @ ' + site)
      return rec
    } catch (_) { mvNote(site, false) }
  }
  return notFound ? { notfound: true } : null
}

async function handleMissavPlay(req, res, u) {
  const code = String(u.searchParams.get('code') || '').trim()
  if (!code) return json(res, { ok: false, error: '缺少番号' })
  try {
    const r = await missavResolve(code)
    if (!r) return json(res, { ok: false, error: '解析失败：所有镜像都不可用或影片未被收录' })
    if (r.notfound) return json(res, { ok: false, error: 'MissAV 已下架或未收录这部影片', notfound: true })
    return json(res, {
      ok: true, code, uuid: r.uuid, site: r.site,
      master: '/api/missav/hls/' + r.uuid + '/playlist.m3u8?m=' + encodeURIComponent(r.site)
    })
  } catch (e) { return json(res, { ok: false, error: '解析失败：' + e.message }) }
}

/* 相对路径解析（m3u8 变体/分片 → 站内中转路径） */
function mvJoinPath(baseDir, rel) {
  const parts = baseDir.split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else if (seg.includes('?') || seg.includes('#')) { parts.push(seg); break }
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}
function missavHlsReq(res, p, u) {
  const mm = p.match(/^\/api\/missav\/hls\/([a-f0-9-]{36})(\/.*)$/i)
  if (!mm) { res.writeHead(404); return res.end() }
  const uuid = mm[1], rest = mm[2]
  const isPlaylist = /\.m3u8$/i.test(rest)
  const mirror = u.searchParams.get('m') || ''
  const otherQ = new URLSearchParams(u.searchParams); otherQ.delete('m')
  const suffix = otherQ.toString() ? '?' + otherQ.toString() : ''
  const routes = MISSAV.routes.length ? MISSAV.routes : MISSAV_FALLBACK_ROUTES
  const ordered = [mirror, ...routes].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i)
  let idx = 0
  const tryRoute = () => {
    if (idx >= ordered.length || idx >= 4) { if (!res.headersSent) { res.writeHead(502) } return res.end('missav relay failed') }
    const site = ordered[idx++]
    const upstream = site + '/jmpres/surrit.com/' + uuid + rest + suffix
    mvStreamUpstream(upstream, site, isPlaylist, res, (err, buf) => {
      if (buf) {   // m3u8 内容拿到但需要重写
        mvNote(site, true)
        const baseDir = rest.replace(/[^/]*$/, '')
        const out = missavRewriteM3U8(Buffer.concat(buf).toString('utf8'), uuid, baseDir, site)
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
        return res.end(out)
      }
      mvNote(site, false)
      tryRoute()
    }, uuid)
  }
  tryRoute()
}
/* m3u8 重写：变体/分片 URI 全部指向本服务中转路径（保留上游原有 query，m 参数另拼） */
function missavRewriteM3U8(text, uuid, baseDir, site) {
  return String(text).split(/\r?\n/).map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    let pth, q = ''
    const qi = t.indexOf('?')
    if (qi >= 0) { q = t.slice(qi); t = t.slice(0, qi) }
    if (/^https?:\/\//i.test(t)) {
      let uu
      try { uu = new URL(t) } catch (_) { return line }
      if (!/surrit\.com$/i.test(uu.hostname)) return line
      pth = uu.pathname
      q = uu.search || q
    } else {
      pth = mvJoinPath(baseDir, t)
    }
    return '/api/missav/hls/' + uuid + pth + q + (q ? '&' : '?') + 'm=' + encodeURIComponent(site)
  }).join('\n')
}
/* 上游取流：m3u8 走 302 跟随后缓冲（交给回调重写），分片直接管道 */
function mvStreamUpstream(url, site, isPlaylist, res, onDone, uuid) {
  const hdrs = { 'user-agent': MISSAV_UA, referer: site + '/', accept: '*/*' }
  mvFollowGet(url, hdrs, (err, rs, finalUrl) => {
    if (err) return onDone(err, null)
    if (rs.statusCode !== 200) { rs.resume(); return onDone(new Error('HTTP ' + rs.statusCode), null) }
    if (!isPlaylist) {
      const hh = { 'Content-Type': rs.headers['content-type'] || 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
      if (rs.headers['content-length']) hh['Content-Length'] = rs.headers['content-length']
      if (rs.headers['accept-ranges']) hh['Accept-Ranges'] = rs.headers['accept-ranges']
      if (rs.headers['content-range']) hh['Content-Range'] = rs.headers['content-range']
      res.writeHead(rs.statusCode === 206 ? 206 : 200, hh)
      rs.pipe(res)
      return
    }
    const chunks = []
    rs.on('data', c => chunks.push(c))
    rs.on('error', e => onDone(e, null))
    rs.on('end', () => onDone(null, chunks))
  })
}
/* https.get + 手动跟随 302（jmpres → 国内 CDN） */
function mvFollowGet(url, hdrs, cb, hop = 0) {
  if (hop > 5) return cb(new Error('重定向次数过多'))
  const uu = new URL(url)
  const req = https.get(uu, { headers: hdrs, timeout: 25000 }, rs => {
    if ([301, 302, 303, 307, 308].includes(rs.statusCode) && rs.headers.location) {
      rs.resume()
      return mvFollowGet(new URL(rs.headers.location, uu).href, hdrs, cb, hop + 1)
    }
    cb(null, rs, url)
  })
  req.on('error', e => cb(e))
  req.on('timeout', () => req.destroy(new Error('timeout')))
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    const p = decodeURIComponent(u.pathname)
    /* 访问口令（可选）：开启后除登录页与本机 localhost 之外都要先验证 */
    if (ACCESS_CODE() && !/^(localhost|127\.0\.0\.1)$/.test(req.headers.host.split(':')[0] || '')) {
      if (p === '/login') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML) }
      if (!hasAccess(req, p)) {
        if (p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/cache/')) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end('{"ok":false,"error":"需要访问口令"}') }
        res.writeHead(302, { Location: '/login' }); return res.end()
      }
    }
    if (p === '/api/library/browse') return json(res, libraryBrowse(u.searchParams.get('path') || ''))
    /* ---------- 进度条缩略图：ffmpeg 按需抽帧（GET，无 body） ----------
     * /api/preview?rel=      → 状态（首次调用会排队后台生成，20~48 帧）
     * /api/preview/img?rel=&i= → 第 i 帧 JPEG（没生成好就 404，前端跳过） */
    if (p === '/api/preview') {
      const rel = u.searchParams.get('rel') || ''
      const fp = safeMediaPath(rel)
      if (!fp) return json(res, { ok: false, error: 'bad rel' })
      const st = PREVIEW.map.get(previewKeyOf(rel))
      if (!st) { const s = previewStart(rel); return json(res, { ok: true, status: s.status, count: s.count, total: s.total }) }
      return json(res, { ok: true, status: st.status, count: st.count, total: st.total, dur: st.dur })
    }
    if (p === '/api/preview/img') {
      const rel = u.searchParams.get('rel') || ''
      const i = parseInt(u.searchParams.get('i') || '0', 10)
      const fp = path.join(previewDirOf(previewKeyOf(rel)), Math.max(0, i) + '.jpg')
      try { if (fs.statSync(fp).isFile()) return sendFile(req, res, fp) } catch (_) {}
      res.writeHead(404); return res.end('Not Found')
    }
    /* 女优头像候选缩略图：外部图床多半防盗链，统一由服务端代取（GET，供 <img src> 直接用） */
    if (p === '/api/actor/thumb') return actorThumb(res, u.searchParams.get('u') || '')
    /* ---------- MissAV 在线播放：解析（GET）+ HLS 中转（GET） ---------- */
    if (p === '/api/missav/play') return handleMissavPlay(req, res, u)
    if (p.startsWith('/api/missav/hls/')) return missavHlsReq(res, p, u)
    if (p === '/api/config' || p === '/api/config/test' || p === '/api/prefs' || p === '/api/rank/update' || p === '/api/rank/status' ||
        p === '/api/actor/scrape' || p === '/api/actor/save' ||
        p === '/api/actor/probe' || p === '/api/actor/pick-avatar' ||
        p === '/api/library' || p === '/api/library/add' || p === '/api/library/remove' || p === '/api/library/rescan' || p === '/api/lib/hide' ||
        p === '/api/sources' || p === '/api/source/test' ||
        p === '/api/watch' || p === '/api/watch/del' || p === '/api/watch/done' ||
        p === '/api/userdata' || p === '/api/bulk/move' ||
        p === '/api/trash' || p === '/api/nfo/write' || p === '/api/movie/delete' ||
        p === '/api/backup' || p === '/api/login' ||
        p === '/api/favorites' || p === '/api/subscriptions' || p === '/api/subscriptions/feed' ||
        p === '/api/online/status' || p === '/api/online/proxy' || p === '/api/online/image' || p === '/api/online/config' ||
        p === '/api/online/detail' || p === '/api/online/reviews' || p === '/api/online/board' || p === '/api/online/search' ||
        p === '/api/115/config' || p === '/api/115/test' || p === '/api/115/push' || p === '/api/115/tasks' || p === '/api/115/dirs' ||
        p === '/api/subs' || p === '/api/subs/get') {
      if (req.method !== 'POST' &&
        !(p === '/api/config' && req.method === 'GET') && !(p === '/api/prefs' && req.method === 'GET') &&
        !(p === '/api/rank/status' && req.method === 'GET') &&
        !(p === '/api/watch' && req.method === 'GET') &&
        !(p === '/api/userdata' && req.method === 'GET') &&
        !(p === '/api/backup' && req.method === 'GET') &&
        !(p === '/api/favorites' && req.method === 'GET') &&
        !(p === '/api/subscriptions' && req.method === 'GET') &&
        !(p === '/api/subscriptions/feed' && req.method === 'GET') &&
        !(p.startsWith('/api/online/') && req.method === 'GET') &&
        !(p === '/api/115/config' && req.method === 'GET') &&
        !(p === '/api/115/dirs' && req.method === 'GET') &&
        !(p === '/api/subs/get' && req.method === 'GET') &&
        !(p === '/api/trash' && req.method === 'GET') &&
        !(p === '/api/library' && req.method === 'GET') && !(p === '/api/sources' && req.method === 'GET')) { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p.startsWith('/api/offline/') || p.startsWith('/api/import/')) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p.startsWith('/api/scrape/') || p.startsWith('/api/images/')) {
      const isGet = p === '/api/scrape/status' || p === '/api/scrape/list' || p === '/api/scrape/meta' || p === '/api/scrape/mdc-test' ||
        p === '/api/scrape/cand-info' ||
        p === '/api/images/upgrade-list' || p === '/api/images/upgrade-status' || p === '/api/images/src-scan-status'
      if (isGet ? req.method !== 'GET' : req.method !== 'POST') { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p === '/api/scan') {
      return json(res, Object.assign({ ok: true }, SCAN, { hasData: !!DATA }))
    }
    if (p === '/api/movie' || p === '/api/cache' || p === '/api/cache/clean') {
      const okM = (p === '/api/movie' && req.method === 'POST') ||
        (p === '/api/cache' && req.method === 'GET') ||
        (p === '/api/cache/clean' && req.method === 'POST')
      if (!okM) { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(UI_ROOT, 'index.html'))
    if (p === '/data.json') {
      if (u.searchParams.has('rescan')) rescan()
      // 扫描未完成时返回占位数据（scanning 标记），前端轮询 /api/scan 显示进度；合并在线刮削的虚拟条目
      let payload = DATA || { root: readMediaPathFile() || MEDIA_ROOT, generated: Date.now(), items: [], scanning: true }
      // 同番号多版本合并（破解/中字/无码归为一条，files 带全部文件）
      const merged = groupByCode(payload.items || [])
      // 在线刮削的虚拟条目：本地已有该番号时不再重复一条（数据已由 enrichFromCache 并进本地条目）
      const haveCode = new Set(merged.map(x => bare(x.code)))
      payload = Object.assign({}, payload, { items: merged.concat(scrapedVirtualItems().filter(v => !haveCode.has(bare(v.code)))) })
      /* 隐藏标记：影片库默认不显示这些条目（设置里勾「显示已隐藏」可看回并恢复） */
      const hs = hiddenSet()
      if (hs.size) payload.items.forEach(it => { if (hs.has(bare(it.code))) it.hidden = true })
      if (SCAN.running) payload.scanning = true
      const s = JSON.stringify(payload)
      /* 必须用异步 gzip：同步版每次请求要占住事件循环 ~90ms，
       * 正好和视频流式读盘抢主线程，边看边翻页会卡顿。 */
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        return zlib.gzip(Buffer.from(s), { level: 6 }, (err, b) => {
          if (err || !b) { res.writeHead(500); return res.end('gzip error') }
          res.writeHead(200, {
            'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip',
            'Content-Length': b.length, 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding'
          })
          res.end(b)
        })
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      return res.end(s)
    }
    /* 女优名册：把本地附加名册（名册外的女优）合并到末尾再回传；没有附加记录就落到下面的静态直出 */
    if (p === '/actresses.json') {
      const ex = readExtraRoster()
      if (ex.length) {
        const key = ROSTER_MERGE.key || String(Date.now())
        const etag = `W/"roster-${key.replace(/[^A-Za-z0-9.]/g, '-')}"`
        if (req.headers['if-none-match'] && String(req.headers['if-none-match']).includes(etag)) {
          res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' })
          return res.end()
        }
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          const g = mergedRosterGz()
          if (g) {
            res.writeHead(200, {
              'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Content-Length': g.length,
              'ETag': etag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding'
            })
            return res.end(g)
          }
        }
        const buf = mergedRosterJson()
        if (buf) {
          res.writeHead(200, {
            'Content-Type': MIME['.json'], 'Content-Length': buf.length,
            'ETag': etag, 'Cache-Control': 'no-cache'
          })
          return res.end(buf)
        }
      }
    }
    /* 女优头像：本地 actresses/ 没有（精简镜像）→ cache/actors/（在线抓过的落盘）→ 在线抓取 */
    if (/^\/actresses\/[\w.-]+\.(jpe?g|png|webp)$/i.test(p)) {
      const fname = path.basename(p)
      const local = path.join(UI_ROOT, 'actresses', fname)
      try { if (fs.statSync(local).isFile()) return sendFile(req, res, local) } catch (_) {}
      const cached = path.join(cacheDir(), 'actors', fname)
      try { if (fs.statSync(cached).isFile()) return sendFile(req, res, cached) } catch (_) {}
      avatarOnline(fname.replace(/\.(jpe?g|png|webp)$/i, '')).then(b => {
        if (!b) { res.writeHead(404); return res.end('Not Found') }
        const ct = /\.png$/i.test(p) ? 'image/png' : (/\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg')
        res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=86400' })
        res.end(b)
      }).catch(() => { try { res.writeHead(404); res.end('Not Found') } catch (_) {} })
      return
    }
    if (/^\/(covers\/|actresses\/|favicon\.ico|manifest\.webmanifest|sw\.js|hls\.light\.min\.js|icon-192\.png|icon-512\.png|apple-touch-icon\.png)/.test(p) ||
        ['/actresses.json', '/name-map.json', '/name-alias.json', '/rankings.json', '/tags-zh.json'].includes(p)) {
      /* 白名单只是前缀，还得挡住 ../ 目录穿越（/covers/../server-config.json 之类） */
      if (p.split('/').includes('..')) { res.writeHead(403); return res.end('Forbidden') }
      const fp = path.join(UI_ROOT, p)
      if (fp.startsWith(UI_ROOT + path.sep)) return sendFile(req, res, fp)
    }
    if (p.startsWith('/cache/')) {
      // 刮削缓存静态直出（poster/fanart/剧照等），只允许缓存目录以内
      const croot = path.resolve(cacheDir())
      const fp = path.resolve(croot, p.slice('/cache/'.length))
      if (fp.startsWith(croot + path.sep)) {
        try { if (fs.statSync(fp).isFile()) return sendFile(req, res, fp) } catch (_) {}
      }
      res.writeHead(404); return res.end('Not Found')
    }
    if (p.startsWith('/media/')) {
      const fp = safeMediaPath(p.slice('/media/'.length))
      if (fp) return sendFile(req, res, fp)
      res.writeHead(403); return res.end('Forbidden')
    }
    res.writeHead(404); res.end('Not Found')
  } catch (e) {
    res.writeHead(500); res.end('Error: ' + e.message)
  }
})

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用。换一个端口：node server.js <媒体路径> ${PORT + 1}`)
    process.exit(1)
  }
  throw e
})

/* 进程级兜底：云盘挂载偶发 ENXIO/EIO 等同步 IO 异常，记日志继续跑，别让服务挂掉 */
process.on('uncaughtException', err => console.error('[uncaught]', err.code || '', err.message))
process.on('unhandledRejection', err => console.error('[unhandledRejection]', (err && err.message) || err))

server.listen(PORT, '0.0.0.0', () => {
  try { repairImageRoles() } catch (e) { console.log('[img-fix] 执行出错：' + e.message) }   // 老缓存图片角色错乱一次性修复
  repairSplitCovers().catch(e => console.log('[img-fix] 合拼封面拆分出错：' + e.message))     // 无竖版海报 + 合拼封面 → 自动拆分
  console.log('┌─────────────────────────────────────────┐')
  console.log('│       JAVPACO 迷你媒体服务已启动        │')
  console.log('└─────────────────────────────────────────┘')
  console.log(`  媒体目录: ${MEDIA_ROOT}`)
  console.log(`  本机访问: http://localhost:${PORT}`)
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal)
        console.log(`  局域网:   http://${net.address}:${PORT}  （手机/电视同网段可访问）`)
    }
  }
  console.log(`  按 Ctrl+C 停止`)
})

process.on('SIGINT', () => { console.log('\n已停止'); process.exit(0) })
