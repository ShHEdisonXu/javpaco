#!/usr/bin/env node
/*
 * minnano-sync.js — minnano-av.com 全量数据同步（查漏补缺 / 头像 / 标签 / 相关女优 / 排行榜）
 *
 * 模式（可叠加，--all = 全部）：
 *   --index     抓 minnano 全站女优列表（~830 页 × 30 人）：id/名字/假名/出道/作品数/标签/头像路径
 *               → 缓存 TMP/javpaco-scrape/minnano-index.json（约 5-8 分钟，conc=8）
 *   --sync      用 index 匹配本地 actresses.json（查漏补缺）：写 mnid/msrc/mimg/tags，
 *               index 匹配不上的再走搜索接口兜底
 *   --import-all 把 index 里 minnano 全站名册（24k）里本地没有的女优整个建档并入
 *               （名字/mnid/头像路径/作品数/标签/假名/出道年月），已并入 --all
 *   --avatars   头像全部换成 minnano：缺的补、已有的也用 minnano 版覆盖（跟踪缓存跳过未变化的）
 *   --profiles  逐个抓资料页刷新档案字段 + 「をチェックした人が見ている女優」相关女优（rel）+
 *               资料页タグ（优先于 index 标签）；20 小时内抓过的跳过（每日刷新友好）
 *   --rankings  抓日榜/周榜/月榜前100 → rankings.json；榜上不在本地库的女优自动建档入库
 *   --cups      抓 minnano 罩杯名单（actress_list.php?cup=A..L，约 16.6k 条）→ 给本地缺罩杯的人补上，
 *               并统计与资料页解析值的冲突（同源交叉校验）
 *   --wiki      对仍缺罩杯者走 ja.wikipedia API 批量兜底（一次 50 个标题，含 AV女優 身份校验）
 *
 * ⚠ 关于「サイズ」栏：`T160 / B86 / W59 / H88 / S24.5` 里 B=バスト(胸圍)、W=ウエスト、H=ヒップ、
 *   S=靴，第 2 项的「B」不是罩杯。罩杯只在站点已知时才以括号形式附在胸圍后：`B86(Dカップ)`。
 *   所以绝不能把 B86 的 B 当罩杯用（实测 300 页样本：无罩杯条目 41/41、有罩杯条目 189/189 前缀都是 B）。
 *
 * 用法：
 *   node tools/minnano-sync.js --all --conc=8 --delay=250     # 每日定时任务
 *   node tools/minnano-sync.js --index                        # 首次：全站索引
 *   node tools/minnano-sync.js --sync --avatars               # 匹配 + 换头像
 *   node tools/minnano-sync.js --rankings                     # 只刷三榜
 *   node tools/minnano-sync.js --cups --wiki                  # 罩杯补全（名单页 + 维基兜底）
 *   REDO=1 跳过一切缓存；--redo 同义
 */
const fs = require('fs')
const path = require('path')

const UI = path.resolve(__dirname, '..')
const OUT = path.join(UI, 'actresses.json')
const RANK_OUT = path.join(UI, 'rankings.json')
const AVA_DIR = path.join(UI, 'actresses')
const TMP = path.join(process.env.TMPDIR || '/tmp', 'javpaco-scrape')
const C_INDEX = path.join(TMP, 'minnano-index.json')
const C_PROF = path.join(TMP, 'minnano-prof.json')
const C_AVA = path.join(TMP, 'minnano-ava.json')
const C_CUP = path.join(TMP, 'minnano-cup.json')

const ARGS = process.argv.slice(2)
const arg = (k, d) => { const x = ARGS.find(a => a.startsWith('--' + k + '=')); return x ? x.slice(k.length + 3) : d }
const CONC = Math.max(1, parseInt(arg('conc', '8'), 10))
const DELAY = parseInt(arg('delay', '250'), 10)
const REDO = ARGS.includes('--redo') || process.env.REDO === '1'
const DO = {
  index: ARGS.includes('--index') || ARGS.includes('--all'),
  sync: ARGS.includes('--sync') || ARGS.includes('--all'),
  importAll: ARGS.includes('--import-all') || ARGS.includes('--all'),
  avatars: ARGS.includes('--avatars') || ARGS.includes('--all'),
  profiles: ARGS.includes('--profiles') || ARGS.includes('--all'),
  rankings: ARGS.includes('--rankings') || ARGS.includes('--all'),
  cups: ARGS.includes('--cups') || ARGS.includes('--all'),
  wiki: ARGS.includes('--wiki') || ARGS.includes('--all')
}
const PROF_TTL = 20 * 3600 * 1000   // 资料页缓存 20h（每日跑一次 = 全量刷新）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://www.minnano-av.com/'

const MAP = JSON.parse(fs.readFileSync(path.join(UI, 'name-map.json'), 'utf8'))
const sleep = ms => new Promise(s => setTimeout(s, ms))
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (_) { return d } }
const saveAtomic = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f) }
/* 名册落盘：丢掉空字段（''/null/[]），24k 条能省掉近一半体积 */
const dropEmpty = (k, v) => (v === '' || v === null || (Array.isArray(v) && v.length === 0) ? undefined : v)
const saveRoster = list => { const t = OUT + '.tmp'; fs.writeFileSync(t, JSON.stringify(list, dropEmpty)); fs.renameSync(t, OUT) }
const dec = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
const strip = s => dec(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/* ---------- 名字归一化（与前端 acNorm 同一套） ---------- */
function acNorm(s) {
  if (!s) return ''
  let x = String(s)
  x = x.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  x = x.replace(/[\u30A1-\u30F6\u31F0-\u31FF]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  x = x.split('').map(c => MAP[c] || c).join('')
  x = x.replace(/[^\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBFa-z0-9]/gi, '')
  return x.toLowerCase()
}

/* ---------- 网络 ---------- */
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, referer: BASE, accept: 'text/html,application/xhtml+xml,image/jpeg,*/*' },
        signal: AbortSignal.timeout(25000)
      })
      if (r.status === 200) {
        const text = await r.text()
        return { status: 200, url: r.url, text }
      }
      if (r.status >= 500) { await sleep(1500 * (i + 1)); continue }
      return { status: r.status, url: r.url, text: '' }
    } catch (_) { await sleep(1500 * (i + 1)) }
  }
  return null
}
async function getBin(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, referer: BASE }, signal: AbortSignal.timeout(20000) })
      if (r.status !== 200) throw new Error('http ' + r.status)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 500) throw new Error('small')
      return buf
    } catch (_) { await sleep(1000 * (i + 1)) }
  }
  return null
}

/* ---------- 并发 runner：tasks 为 () => Promise 工厂 ---------- */
async function runPool(n, tasks, every) {
  let cursor = 0, done = 0
  const total = tasks.length
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= total) return
      const t0 = Date.now()
      try { await tasks[i]() } catch (e) { console.log('  task ERR: ' + String(e && e.message || e).slice(0, 80)) }
      done++
      if (every && (done % every === 0 || done === total)) every(done, total)
      if (DELAY) await sleep(Math.max(0, DELAY - (Date.now() - t0)))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, total)) }, worker))
}

/* ================================================================
 * --index：全站女优列表
 * ================================================================ */
function parseListRow(chunk) {
  const id = (chunk.match(/href="(?:\/)?actress(\d+)\.html/) || [])[1]
  if (!id) return null
  const name = strip((chunk.match(/<h2 class="ttl"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
  const furi = strip((chunk.match(/<p class="furi">([\s\S]*?)<\/p>/) || [])[1])
  const debut = strip((chunk.match(/<p class="debut-info">([\s\S]*?)<\/p>/) || [])[1])
  const img = (chunk.match(/src="(?:\/)?(p_actress[^"]+?\/(\d+)\.jpg)/) || [])
  const works = (chunk.match(/<td>\s*(\d{1,6})\s*<\/td>/) || [])[1] || ''
  const tags = []
  for (const m of chunk.matchAll(/tag_a_id=(\d+)&tag_name=[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const n = dec(m[2])
    if (n) tags.push([m[1], n])
  }
  return { id, name, furi, debut, works, img: img[1] || '', tags }
}

async function stageIndex() {
  fs.mkdirSync(TMP, { recursive: true })
  let idx = !REDO && loadJson(C_INDEX, null)
  if (idx && idx.recs && Object.keys(idx.recs).length > 20000) {
    console.log(`[index] 缓存已有 ${Object.keys(idx.recs).length} 条（${new Date(idx.updatedAt).toLocaleString()}），跳过（--redo 重抓）`)
    return idx
  }
  console.log('[index] 开始抓取 minnano 全站女优列表（五十音索引遍历）…')
  const recs = {}
  const seenIds = new Set()
  // 注意：默认列表分页在 ~166 页后内容循环（站方限制），必须按五十音索引分页才能拿全 24k
  const GOJUON = ['a','i','u','e','o','ka','ki','ku','ke','ko','sa','shi','su','se','so',
    'ta','chi','tsu','te','to','na','ni','nu','ne','no','ha','hi','hu','he','ho',
    'ma','mi','mu','me','mo','ya','yu','yo','ra','ri','ru','re','ro','wa','wo','n']
  const addRows = text => {
    let n = 0
    for (const chunk of text.split('<tr>')) {
      const rec = parseListRow(chunk)
      if (rec && rec.name && !seenIds.has(rec.id)) { seenIds.add(rec.id); recs[rec.id] = rec; n++ }
    }
    return n
  }
  const t0 = Date.now()
  let reqs = 0
  for (const key of GOJUON) {
    let page = 1
    while (true) {
      const batch = [0, 1, 2, 3].map(o => page + o)
      const rs = await Promise.all(batch.map(p => get(BASE + 'actress_list.php?gojuon=' + key + '&page=' + p)))
      reqs += rs.length
      let rowsThisBatch = 0, empty = 0
      rs.forEach((r, i) => {
        const n = r && r.text ? addRows(r.text) : 0
        rowsThisBatch += n
        if (n === 0) empty++
      })
      if (empty > 1 || rowsThisBatch === 0) break   // 该音抓完了（允许个别页偶发失败）
      page += 4
      const el = Math.round((Date.now() - t0) / 1000)
      console.log(`  [index] ${key} p${page - 4}+ 累计 ${Object.keys(recs).length} 人 / ${reqs} 请求 | ${el}s`)
    }
  }
  idx = { updatedAt: Date.now(), recs }
  saveAtomic(C_INDEX, idx)
  console.log(`[index] 完成：${Object.keys(recs).length} 人 → 缓存`)
  return idx
}

/* ================================================================
 * --sync：index ↔ actresses.json 匹配（查漏补缺）
 * ================================================================ */
async function searchOne(name) {
  // 搜索接口兜底（与 fill-profile-minnano 相同逻辑的精简版，只拿 mnid/规范名）
  const r = await get(BASE + 'search_result.php?search_scope=actress&search_word=' + encodeURIComponent(name))
  if (!r || r.status !== 200 || !r.text) return null
  const m = (r.url || '').match(/actress(\d+)\.html/)
  if (m) return { id: m[1], canon: strip((r.text.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').split(/（|\(|AV女優/)[0].trim() }
  const want = acNorm(name)
  for (const c of r.text.matchAll(/href="(?:\/)?actress(\d+)\.html"[^>]*>([\s\S]{0,80}?)<\/a>/g)) {
    const t = strip(c[2])
    if (t && acNorm(t) === want) return { id: c[1], canon: t }
  }
  return null
}

async function stageSync(idx) {
  const list = loadJson(OUT, [])
  if (!idx) { console.log('[sync] 无 index，跳过'); return }
  // key → rec
  const keymap = new Map()
  const putKey = (k, rec) => { if (k && !keymap.has(k)) keymap.set(k, rec) }
  for (const id in idx.recs) {
    const r = idx.recs[id]
    putKey(acNorm(r.name), r)
    // 名字里括号别名：森沢かな（飯岡かなこ）
    for (const m of String(r.name).matchAll(/[（(]([^）)]+)[）)]/g)) putKey(acNorm(m[1]), r)
    putKey(acNorm(String(r.name).replace(/[（(][^）)]*[）)]/g, '')), r)
    // 假名读音（ふりがな / romaji）
    const furi = String(r.furi || '').split('/')[0].trim()
    putKey(acNorm(furi), r)
  }
  let matched = 0, updated = 0, newTagged = 0
  const unmatched = []
  const msrcId = a => (String(a.msrc || '').match(/actress(\d+)\.html/) || [])[1]
  for (const a of list) {
    const directId = msrcId(a)
    let rec = directId ? idx.recs[directId] : null
    if (!rec) {
      const cands = [a.name, a.name_ja, a.name_zh, a.mcanon, ...(a.alias || [])]
      for (const n of cands) {
        if (!n) continue
        for (const v of [n, n.replace(/[（(][^）)]*[）)]/g, ''), ...[...String(n).matchAll(/[（(]([^）)]+)[）)]/g)].map(x => x[1])]) {
          rec = keymap.get(acNorm(v))
          if (rec) break
        }
        if (rec) break
      }
    }
    if (rec) {
      matched++
      const before = JSON.stringify([a.mnid, a.mimg, a.tags])
      a.mnid = rec.id
      a.msrc = BASE + 'actress' + rec.id + '.html'
      if (rec.img) a.mimg = BASE + rec.img
      if (rec.tags && rec.tags.length) { a.tags = rec.tags; newTagged++ }
      if (rec.furi && !a.furi) a.furi = rec.furi
      if (!a.period && rec.debut) a.period = rec.debut
      if (before !== JSON.stringify([a.mnid, a.mimg, a.tags])) updated++
    } else {
      unmatched.push(a)
    }
  }
  console.log(`[sync] index 命中 ${matched}/${list.length}（更新 ${updated}，打标签 ${newTagged}），待搜索兜底 ${unmatched.length}`)
  // 搜索兜底（并发）
  let fixed = 0
  const tasks = unmatched.map(a => async () => {
    const r = await searchOne(a.name_ja || a.name)
    if (r && r.id) {
      const rec = idx.recs[r.id]
      fixed++
      a.mnid = r.id
      a.msrc = BASE + 'actress' + r.id + '.html'
      if (rec) {
        if (rec.img) a.mimg = BASE + rec.img
        if (rec.tags && rec.tags.length) a.tags = rec.tags
        if (rec.furi && !a.furi) a.furi = rec.furi
      }
    }
  })
  await runPool(tasks.length, tasks, (d, t) => d % 50 === 0 && console.log(`  [sync] 搜索兜底 ${d}/${t}，成功 ${fixed}`))
  console.log(`[sync] 搜索兜底成功 ${fixed}，最终未匹配 ${unmatched.length - fixed}`)
  saveRoster(list)
  return list
}

/* ================================================================
 * --import-all：把 minnano 全站名册（24k）整个并进本地库
 *   已有的（按 mnid / 名字 / 别名 / 假名 / 括注别名归一化）不动；
 *   站点里有、本地没有的 → 建档（名字 / mnid / 头像路径 / 作品数 / 标签 / 假名 / 出道年月）
 * ================================================================ */
function nameVariants(n) {
  const s = String(n || '').trim()
  if (!s) return []
  const out = [s, s.replace(/[（(][^）)]*[）)]/g, '')]
  for (const m of s.matchAll(/[（(]([^）)]+)[）)]/g)) out.push(m[1])
  return out.map(x => x.trim()).filter(Boolean)
}
async function stageImportAll(idx, list) {
  if (!idx || !idx.recs) { console.log('[import] 无 index，跳过'); return list }
  const seen = new Set()
  for (const a of list) {
    if (a.mnid) seen.add('#' + a.mnid)
    for (const n of [a.name, a.name_ja, a.name_zh, a.mcanon, ...(a.alias || [])])
      for (const v of nameVariants(n)) { const k = acNorm(v); if (k) seen.add(k) }
  }
  const before = list.length
  let added = 0, skipped = 0, noImg = 0
  for (const id in idx.recs) {
    const r = idx.recs[id]
    if (!r || !r.name) continue
    if (seen.has('#' + id)) continue
    const keys = nameVariants(r.name).map(acNorm).filter(Boolean)
    if (keys.length && keys.every(k => seen.has(k))) { skipped++; continue }   // 同名已有 → 不重复建档
    const e = { name: r.name, mnid: String(id), msrc: BASE + 'actress' + id + '.html', src: 'minnano' }
    if (r.img) e.mimg = BASE + r.img; else noImg++
    const w = parseInt(r.works, 10)
    if (w > 0) e.videoCount = w
    if (r.tags && r.tags.length) e.tags = r.tags
    if (r.furi) e.furi = r.furi
    const dm = String(r.debut || '').match(/(\d{4})年\s*(\d{1,2})月/)
    if (dm) e.debutDate = dm[1] + '-' + String(dm[2]).padStart(2, '0')
    list.push(e)
    seen.add('#' + id)
    keys.forEach(k => seen.add(k))
    added++
  }
  // rel 迁移：旧格式 [{id,name}] → 只存 mnid 数组（前端按 mnid 解析，省 ~1MB 体积）
  let migrated = 0
  for (const a of list) {
    if (Array.isArray(a.rel) && a.rel.length && typeof a.rel[0] === 'object')
      { a.rel = a.rel.map(x => String((x && x.id) || '')).filter(Boolean); migrated++ }
  }
  console.log(`[import] 新增 ${added} 人（同名跳过 ${skipped}、无头像 ${noImg}），本地 ${before} → ${list.length}` + (migrated ? `；rel 迁移 ${migrated} 人` : ''))
  saveRoster(list)
  return list
}

/* ================================================================
 * --avatars：头像全部换成 minnano
 * ================================================================ */
async function stageAvatars(list) {
  const done = REDO ? {} : loadJson(C_AVA, {})
  const have = new Set(fs.existsSync(AVA_DIR) ? fs.readdirSync(AVA_DIR) : [])
  const targets = list.filter(a => a.mimg && (a.lid || a.mnid))
  const need = targets.filter(a => done[a.lid || a.mnid] !== a.mimg)
  console.log(`[avatars] minnano 头像 ${targets.length} 人，需下载/更新 ${need.length}`)
  let ok = 0, fail = 0
  const tasks = need.map(a => async () => {
    const key = a.lid || ('mn' + a.mnid)
    const buf = await getBin(a.mimg)
    if (buf) {
      fs.writeFileSync(path.join(AVA_DIR, key + '.jpg'), buf)
      a.icon = '/actresses/' + key + '.jpg'
      a.icon = '/actresses/' + key + '.jpg'
      done[key] = a.mimg
      ok++
    } else fail++
  })
  await runPool(tasks.length, tasks, (d, t) => d % 100 === 0 && console.log(`  [avatars] ${d}/${t} 成功 ${ok} 失败 ${fail}`))
  saveAtomic(C_AVA, done)
  // 没跑 --sync 时也要落盘 icon
  saveRoster(list)
  console.log(`[avatars] 完成：成功 ${ok}，失败 ${fail}`)
  return list
}

/* ================================================================
 * --profiles：资料页刷新（档案 + 相关女优 + 资料页标签）
 * ================================================================ */
function parseProfilePage(html) {
  const kv = {}
  const alias = []
  for (const m of html.matchAll(/<td[^>]*>\s*<span>([^<]+)<\/span>([\s\S]*?)<\/td>/g)) {
    const k = strip(m[1]), v = strip(m[2])
    if (!k || !v) continue
    if (k === '別名') { alias.push(v.split('（')[0].split('(')[0].trim()); continue }
    if (!kv[k]) kv[k] = v
  }
  const size = kv['サイズ'] || ''
  // 罩杯：只在站点已知时出现，形如 B86(Dカップ) / Ｂ86（Ｆカップ）；全角字母做半角归一
  const cupRaw = (size.match(/([A-ZＡ-Ｚ])\s*カップ/) || [])[1] || ''
  const cup = cupRaw.replace(/[Ａ-Ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  const birthday = (kv['生年月日'] || '').replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, (_, y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`).split(/[\s（(]/)[0]
  const canon = strip((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').split(/（|\(|AV女優/)[0].trim()
  // 资料页タグ
  const tags = []
  const tagBlock = (html.match(/<span>タグ<\/span>[\s\S]*?<div class="tagarea">([\s\S]*?)<\/td>/) || [])[1] || ''
  for (const m of tagBlock.matchAll(/tag_a_id=(\d+)[^>]*>([\s\S]*?)<\/a>/g)) {
    const n = dec(m[2])
    if (n) tags.push([m[1], n])
  }
  // 「○○をチェックした人が見ている女優」→ rel（10 人，按站点顺序；title 在 img 上）
  const rel = []
  const ri = html.indexOf('をチェックした人が見ている女優')
  if (ri > -1) {
    const seg = html.slice(ri, ri + 6000)
    for (const m of seg.matchAll(/href="(?:\/)?actress(\d+)\.html">\s*<img[^>]*title="([^"]*)"/g)) {
      const n = dec(m[2])
      if (n && !rel.some(x => x.id === m[1])) rel.push({ id: m[1], name: n })
      if (rel.length >= 10) break
    }
  }
  return {
    canon, birthday,
    height: (size.match(/T(\d+)/) || [])[1] || '',
    bust: (size.match(/B(\d+)/) || [])[1] || '',
    cup,
    waist: (size.match(/W(\d+)/) || [])[1] || '',
    hip: (size.match(/H(\d+)/) || [])[1] || '',
    shoe: (size.match(/S([\d.]+)/) || [])[1] || '',
    blood: kv['血液型'] || '', place: kv['出身地'] || '', hobby: kv['趣味・特技'] || '',
    period: kv['AV出演期間'] || '', debut: kv['デビュー作品'] || '',
    agency: kv['所属事務所'] || '', blog: kv['ブログ'] || '',
    alias: alias.filter(Boolean), tags, rel
  }
}

async function stageProfiles(list) {
  fs.mkdirSync(TMP, { recursive: true })
  const cache = REDO ? {} : loadJson(C_PROF, {})
  const targets = list.filter(a => a.mnid)
  /* ONLY=mnid1,mnid2 → 只刷新指定的人（无视 TTL，用于新人补档，不全量爬） */
  const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean)
  const stale = ONLY.length ? targets.filter(a => ONLY.includes(String(a.mnid)))
    : targets.filter(a => { const c = cache[a.mnid]; return !c || Date.now() - c.fetchedAt > PROF_TTL })
  console.log(`[profiles] 有 mnid ${targets.length} 人，需刷新 ${stale.length}${ONLY.length ? '（ONLY 指定模式）' : ''}`)
  let ok = 0, fail = 0
  const tasks = stale.map(a => async () => {
    const r = await get(BASE + 'actress' + a.mnid + '.html')
    if (!r || !r.text) { fail++; return }
    const p = parseProfilePage(r.text)
    cache[a.mnid] = { fetchedAt: Date.now(), p }
    ok++
  })
  await runPool(tasks.length, tasks, (d, t) => d % 100 === 0 && console.log(`  [profiles] ${d}/${t} 成功 ${ok} 失败 ${fail}`))
  saveAtomic(C_PROF, cache)
  // 写回
  let touched = 0
  for (const a of targets) {
    const c = cache[a.mnid]
    if (!c || !c.p) continue
    const p = c.p
    const cmv = v => (v ? String(v).replace(/cm$/i, '') + 'cm' : '')
    if (p.birthday) a.birthday = p.birthday
    if (p.height) a.height = cmv(p.height)
    if (p.bust) a.breast = cmv(p.bust)
    if (p.cup) a.cup = p.cup
    if (p.waist) a.waist = cmv(p.waist)
    if (p.hip) a.hip = cmv(p.hip)
    if (p.shoe) a.shoe = p.shoe
    if (p.blood) a.blood = p.blood
    if (p.place) a.place = p.place
    if (p.hobby) a.hobby = p.hobby
    if (p.period) a.period = p.period
    if (p.agency) a.agency = p.agency
    if (p.debut) a.debut = p.debut
    if (p.blog) a.blog = p.blog
    if (p.alias && p.alias.length) a.alias = p.alias
    if (p.tags && p.tags.length) a.tags = p.tags
    if (p.rel && p.rel.length) a.rel = p.rel.map(x => String((x && x.id) || '')).filter(Boolean)
    if (!a.msrc) a.msrc = BASE + 'actress' + a.mnid + '.html'
    if (p.canon && acNorm(p.canon) !== acNorm(a.name)) a.mcanon = p.canon
    touched++
  }
  saveRoster(list)
  console.log(`[profiles] 抓取成功 ${ok} 失败 ${fail}，写回 ${touched} 人`)
  return list
}

/* ================================================================
 * --cups：minnano 官方罩杯名单（actress_list.php?cup=A..L）→ 补全 + 交叉校验
 *   站点只在已知时才在サイズ里附 `(Xカップ)`，所以资料页解析不到的那批人，
 *   这里再从「罩杯名单页」取一遍权威值；顺带统计两处口径不一致的条目。
 * ================================================================ */
const CUP_LETTERS = 'ABCDEFGHIJKL'
const CUP_TTL = 20 * 3600 * 1000
async function stageCups(list) {
  fs.mkdirSync(TMP, { recursive: true })
  let cache = REDO ? null : loadJson(C_CUP, null)
  const map = (cache && cache.map) || {}
  if (!cache || REDO || Date.now() - (cache.updatedAt || 0) > CUP_TTL) {
    console.log('[cups] 抓取 minnano 罩杯名单页…')
    let seen = 0
    for (const c of CUP_LETTERS) {
      const first = await get(BASE + 'actress_list.php?cup=' + c)
      if (!first || !first.text) { console.log(`  [cups] ${c} 首页抓取失败，跳过`); continue }
      const total = parseInt(((first.text.match(/([\d,]+)\s*件/) || [])[1] || '0').replace(/,/g, ''), 10)
      const pages = Math.max(1, Math.ceil(total / 30))
      const harvest = h => {
        for (const m of h.matchAll(/<h2 class="ttl"><a href="actress(\d+)\.html">([^<]*)<\/a><\/h2>/g)) {
          if (!map[m[1]]) map[m[1]] = { cup: c, name: dec(m[2]) }
        }
      }
      const tasks = []
      for (let p = 1; p <= pages; p++) tasks.push(async () => {
        const h = p === 1 ? first.text : ((await get(BASE + `actress_list.php?cup=${c}&page=${p}`)) || {}).text
        if (h) harvest(h)
      })
      await runPool(tasks.length, tasks)
      seen += total
      console.log(`  [cups] ${c}: 名单 ${total} 件 / ${pages} 页，累计已映射 ${Object.keys(map).length}`)
    }
    if (Object.keys(map).length) { cache = { updatedAt: Date.now(), map }; saveAtomic(C_CUP, cache) }
    console.log(`[cups] 名单合计 ${seen} 条，去重映射 ${Object.keys(map).length} 人`)
  } else {
    console.log(`[cups] 使用缓存：${Object.keys(map).length} 人`)
  }
  let filled = 0
  const conflicts = []
  for (const a of list) {
    if (!a.mnid) continue
    const m = map[a.mnid]
    if (!m || !m.cup) continue
    if (!a.cup) { a.cup = m.cup; a.cupsrc = 'minnano-list'; filled++ }
    else if (a.cup !== m.cup) conflicts.push(`${a.name}(mnid=${a.mnid}) 资料页=${a.cup} / 名单=${m.cup}`)
  }
  if (filled) saveRoster(list)
  console.log(`[cups] 补全 ${filled} 人` + (conflicts.length ? `，口径冲突 ${conflicts.length} 例（保留资料页值）：\n  ` + conflicts.slice(0, 20).join('\n  ') : '，无冲突'))
  console.log(`[cups] 现在缺罩杯：${list.filter(a => !a.cup).length} / ${list.length}`)
  return list
}

/* ================================================================
 * --wiki：ja.wikipedia 批量兜底（一次 50 个标题，含 AV女優 身份校验）
 * ================================================================ */
const cleanName = s => String(s || '').replace(/[（(].*?[)）]/g, '').trim()
const WIKI_API = 'https://ja.wikipedia.org/w/api.php'
const C_WIKI = path.join(TMP, 'wiki-cup.json')
const WIKI_TTL = 30 * 24 * 3600 * 1000   // 维基数据变化慢，命中/未命中都缓存 30 天

/* 批量取条目 wikitext（一次 50 个标题），解析出罩杯/生年/胸圍/別名 并映射回查询名 */
async function wikiBatch(titles) {
  const url = WIKI_API + '?action=query&redirects=1&prop=revisions&rvslots=main&rvprop=content&format=json&formatversion=2&titles='
    + encodeURIComponent(titles.join('|'))
  let j = null
  for (let attempt = 0; attempt < 4 && !j; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'javpaco-metadata-sync/1.0 (local media library; low-volume batch)' } })
      const txt = await r.text()
      if (txt.startsWith('{')) { j = JSON.parse(txt); break }
      // 维基限流会返回 200 + 纯文本提示，必须退避重试
      const wait = 6000 * (attempt + 1)
      console.log(`  [wiki] 被限流，${wait / 1000}s 后重试（第 ${attempt + 1} 次）`)
      await sleep(wait)
    } catch (e) { console.log('  [wiki] 请求失败：' + e.message); await sleep(4000) }
  }
  const out = {}
  if (!j || !j.query || !j.query.pages) return out
  // 处理标题归一化 / 重定向：把返回的页面标题映射回我们查询用的名字
  const back = {}
  for (const n of (j.query.normalized || [])) back[n.to] = n.from
  for (const n of (j.query.redirects || [])) back[n.to] = back[n.from] || n.from
  for (const p of j.query.pages) {
    if (p.missing || !p.revisions) continue
    const wt = p.revisions[0].slots.main.content || ''
    // 身份校验：必须是 AV 女優 条目
    if (!/AV女優|アダルトビデオ女優|AV女优/.test(wt)) continue
    // 取罩杯：① 优先 infobox 的 |カップ=X ② 其次 スリーサイズ 行里的 (Xカップ)
    // 不要裸扫全文的「Xカップ」——那多半是作品标题（如「20歳のEカップ女子大生」），已实测踩坑
    let raw = (wt.match(/\|\s*カップ\s*=\s*([A-ZＡ-Ｚ])/) || [])[1] || ''
    if (!raw) raw = (wt.match(/スリーサイズ[^\n]{0,60}?[（(]([A-ZＡ-Ｚ])カップ/) || [])[1] || ''
    if (!raw) raw = (wt.match(/\|\s*バスト\s*=[^\n]*?[（(]([A-ZＡ-Ｚ])カップ/) || [])[1] || ''
    const cup = raw.replace(/[Ａ-Ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 生年：只认「生年月日」上下文，绝不裸扫全文（否则会抓到履历里的 2021/2025 等年份）
    const ym = wt.match(/\{\{\s*生年月日と年齢\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/)
      || wt.match(/\|\s*生年月日\s*=\s*(?:\[\[)?(\d{4})年[^\n]{0,10}?(\d{1,2})月/)
      || wt.match(/、\s*(?:\[\[)?(\d{4})年(?:\]\]\[\[)?(\d{1,2})月(?:\]\]\[\[)?(\d{1,2})日(?:\]\])?\s*[-–—]/)
    const year = ym ? ym[1] : ''
    const bust = ((wt.match(/\|\s*バスト\s*=\s*(\d{2,3})/) || [])[1]) || ''
    const aliasBlock = ((wt.match(/\|\s*別名\s*=\s*([^\n]{0,300})/) || [])[1]) || ''
    out[back[p.title] || p.title] = { cup, year, bust, title: p.title, redirect: !!back[p.title], alias: aliasBlock }
  }
  return out
}

async function stageWiki(list) {
  const targets = list.filter(a => !a.cup && cleanName(a.name))
  if (!targets.length) { console.log('[wiki] 无待补罩杯人员'); return list }
  const byClean = new Map()
  for (const a of targets) {
    const c = cleanName(a.name)
    if (!byClean.has(c)) byClean.set(c, [])
    byClean.get(c).push(a)
  }
  const allNames = [...byClean.keys()]
  // 别名候选：本名查不到时，用本人的别名再试一次
  const aliasOwner = new Map()
  for (const a of targets) {
    const own = cleanName(a.name)
    for (const al of (Array.isArray(a.alias) ? a.alias : [])) {
      const s = String(al).replace(/[（(].*?[)）]/g, '').trim()
      if (!s || s === own || s.length < 2 || s.length > 14) continue
      if (!aliasOwner.has(s)) aliasOwner.set(s, new Set())
      aliasOwner.get(s).add(own)
    }
  }
  let cache = REDO ? null : loadJson(C_WIKI, null)
  if (cache && Date.now() - (cache.updatedAt || 0) > WIKI_TTL) cache = null
  const hits = (cache && cache.hits) || {}
  const miss = new Set((cache && cache.miss) || [])
  const pendingNames = allNames.filter(n => !(n in hits) && !miss.has(n))
  const pendingAlias = [...aliasOwner.keys()].filter(n => !(n in hits) && !miss.has(n) && !pendingNames.includes(n))
  const todo = [...pendingNames, ...pendingAlias]
  console.log(`[wiki] ja.wikipedia 兜底：本名 ${allNames.length}（待查 ${pendingNames.length}）+ 别名 ${aliasOwner.size}（待查 ${pendingAlias.length}），覆盖 ${targets.length} 人`)
  const chunks = Math.ceil(todo.length / 50)
  for (let bi = 0; bi < chunks; bi++) {
    Object.assign(hits, await wikiBatch(todo.slice(bi * 50, bi * 50 + 50)))
    if (chunks > 1) console.log(`  [wiki] 批次 ${bi + 1}/${chunks}，累计命中条目 ${Object.keys(hits).length}（带罩杯 ${Object.values(hits).filter(x => x.cup).length}）`)
    if (bi + 1 < chunks) await sleep(2500)
  }
  for (const n of todo) if (!(n in hits)) miss.add(n)
  saveAtomic(C_WIKI, { updatedAt: Date.now(), hits, miss: [...miss] })

  let filled = 0, skipped = 0
  const applied = []
  // 第一轮：本名（含维基重定向）
  for (const [cname, arr] of byClean) {
    const h = hits[cname]
    if (!h || !h.cup) continue
    for (const a of arr) {
      // 有生日时交叉校验年份，避免同名误配
      if (a.birthday && h.year && !String(a.birthday).startsWith(h.year)) { skipped++; console.log(`  [wiki] 生日不符跳过：${a.name}（本地 ${a.birthday} vs 维基 ${h.year}，页面 ${h.title}）`); continue }
      // 身份置信：生日年相符 > 我们的名字出现在维基 別名 > 条目标题就是本名 > 仅靠重定向
      const conf = (a.birthday && h.year && String(a.birthday).startsWith(h.year)) ? '生日'
        : (h.alias && h.alias.indexOf(cname) > -1) ? '别名'
          : !h.redirect ? '标题' : '重定向'
      a.cup = h.cup; a.cupsrc = 'ja.wikipedia'; filled++
      applied.push(`${a.name}=${h.cup}${h.bust ? '(B' + h.bust + ')' : ''} 置信[${conf}]${h.redirect ? ' → ' + h.title : ''}`)
    }
  }
  // 第二轮：别名命中（必须双向确认：维基条目的別名里要有本人名字）
  for (const [alias, owners] of aliasOwner) {
    const h = hits[alias]
    if (!h || !h.cup || !h.alias) continue
    for (const own of owners) {
      if (h.alias.indexOf(own) < 0) continue
      for (const a of (byClean.get(own) || [])) {
        if (a.cup) continue
        if (a.birthday && h.year && !String(a.birthday).startsWith(h.year)) { skipped++; continue }
        a.cup = h.cup; a.cupsrc = 'ja.wikipedia'; filled++
        applied.push(`${a.name}=${h.cup}（经别名「${alias}」命中）置信[别名双向]`)
      }
    }
  }
  if (filled) saveRoster(list)
  console.log(`[wiki] 补全 ${filled} 人` + (skipped ? `，生日不符跳过 ${skipped} 人` : ''))
  if (applied.length) console.log('  ' + applied.join('\n  '))
  console.log(`[wiki] 现在缺罩杯：${list.filter(a => !a.cup).length} / ${list.length}`)
  return list
}

/* ================================================================
 * --rankings：日/周/月榜 Top100 → rankings.json（缺的女优自动建档）
 * ================================================================ */
function parseRankRows(html) {
  const rows = []
  for (const chunk of html.split('<tr>')) {
    if (!/class="rnkno"/.test(chunk)) continue
    const rank = +((chunk.match(/rnkcnt">(\d+)/) || [])[1] || 0)
    const id = (chunk.match(/actress(\d+)\.html/) || [])[1]
    const name = strip((chunk.match(/<h2 class="ttl"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
    const works = +((chunk.match(/<td>\s*(\d{1,6})\s*<\/td>/) || [])[1] || 0)
    const img = (chunk.match(/src="(?:\/)?(p_actress[^"]+?\.jpg)/) || [])[1] || ''
    if (rank && id && name) rows.push({ rank, id, name, works, img })
  }
  return rows
}

async function stageRankings(idx, list) {
  const modes = [['day', 'ranking_actress.php?daily'], ['week', 'ranking_actress.php'], ['month', 'ranking_actress.php?monthly']]
  const byMnid = new Map(list.filter(a => a.mnid).map(a => [a.mnid, a]))
  const byName = new Map()
  list.forEach(a => { const k = acNorm(a.name); if (k && !byName.has(k)) byName.set(k, a) })
  const rank = {}
  let added = 0, renamed = 0
  for (const [key, url] of modes) {
    const r = await get(BASE + url)
    const rows = r && r.text ? parseRankRows(r.text) : []
    console.log(`[rankings] ${key}: ${rows.length} 条`)
    rank[key] = rows.map(x => {
      let a = byMnid.get(x.id)
      if (a && x.name && x.name !== (a.name_ja || a.name)) {
        // 同 mnid 但站点现用名不同 → 改名了：更新名字，旧名收进别名（否则按新名查详情会扑空）
        const olds = [a.name_ja, a.name].filter(Boolean)
        a.alias = Array.from(new Set([].concat(a.alias || [], olds)))
        if (!a.name_zh || a.name === (a.name_ja || a.name)) a.name = x.name
        a.name_ja = x.name
        renamed++
        console.log(`  [rankings] 改名：${olds.join('/')} → ${x.name}（mnid=${x.id}）`)
      }
      if (!a) {
        // 榜上女优不在本地库 → 自动建档
        const rec = idx ? idx.recs[x.id] : null
        a = {
          uid: 'minnano', lid: 'mn' + x.id, name: x.name, name_ja: x.name, name_zh: x.name,
          type: 'censored', works: 0, mnid: x.id, msrc: BASE + 'actress' + x.id + '.html',
          birthday: '', height: '', cup: '', breast: '', waist: '', hip: '',
          alias: [], tags: rec ? rec.tags : [], furi: rec ? rec.furi : ''
        }
        if (rec && rec.img) a.mimg = BASE + rec.img
        if (rec && rec.debut && !a.period) a.period = rec.debut
        list.push(a)
        byMnid.set(x.id, a)
        added++
        console.log(`  [rankings] 新增女优：${x.name}（mnid=${x.id}）`)
      }
      // 头像：优先本地文件
      const fname = (a.lid || a.mnid) + '.jpg'
      const local = '/actresses/' + fname
      return {
        rank: x.rank, name: x.name, mnid: x.id, works: x.works,
        lid: a.lid || ('mn' + a.mnid), name_zh: a.name_zh || '',
        avatar: fs.existsSync(path.join(AVA_DIR, fname)) ? local : (a.mimg || (x.img ? BASE + x.img : ''))
      }
    })
  }
  if (added || renamed) saveRoster(list)
  saveAtomic(RANK_OUT, { updatedAt: Date.now(), day: rank.day, week: rank.week, month: rank.month })
  console.log(`[rankings] 写入 rankings.json（新入库 ${added} 人）`)
  return list
}

/* ================================================================ */
async function main() {
  const t0 = Date.now()
  if (!Object.values(DO).some(Boolean)) {
    console.log('无模式参数。可选：--index --sync --import-all --avatars --profiles --cups --wiki --rankings --all')
    process.exit(0)
  }
  let idx = null
  if (DO.index) idx = await stageIndex()
  if (DO.sync || DO.importAll || DO.avatars || DO.profiles || DO.rankings) idx = idx || loadJson(C_INDEX, null)
  let list = null
  if (DO.sync) list = await stageSync(idx)
  if (DO.importAll || DO.avatars || DO.profiles || DO.cups || DO.wiki || DO.rankings) list = list || loadJson(OUT, [])
  if (DO.importAll) list = await stageImportAll(idx, list)
  if (DO.avatars) list = await stageAvatars(list)
  if (DO.profiles) list = await stageProfiles(list)
  if (DO.cups) list = await stageCups(list)
  if (DO.wiki) list = await stageWiki(list)
  if (DO.rankings) list = await stageRankings(idx, list)
  console.log(`\n全部完成，耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
}
main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
