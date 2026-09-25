#!/usr/bin/env node
/**
 * 抓取 netflav5 女优资料（一次性工具，可重复运行 / 断点续传）
 *
 *   阶段 1  LIST    : /actress?page=N  → 全部女优列表（name / uid / icon / videoCount）
 *   阶段 2  PROFILE : /all?actress=NAME → 女优档案（birthday/height/cup/breast/waist/hip/name_en/name_zh）
 *   阶段 3  AVATAR  : 下载头像 → actresses/<uid>.jpg（缩到 160×160 省体积）
 *
 * 输出：
 *   actresses.json        —— 合并后的女优资料数组（前端 + 服务端读取）
 *   actresses/<uid>.jpg   —— 本地头像
 *
 * 用法：node tools/scrape-actresses.js [--list-only] [--no-avatar] [--limit=N]
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const puppeteer = require('/Users/fff/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core')

const ROOT = path.resolve(__dirname, '..')
const OUT_JSON = path.join(ROOT, 'actresses.json')
const AVA_DIR = path.join(ROOT, 'actresses')
const TMP = path.join(os.tmpdir(), 'javpaco-scrape')
const LIST_CACHE = path.join(TMP, 'list.json')
const PROFILE_CACHE = path.join(TMP, 'profiles.json')

const ARGS = process.argv.slice(2)
const LIST_ONLY = ARGS.includes('--list-only')
const AVATARS_ONLY = ARGS.includes('--avatars-only')
const LIB_ONLY = ARGS.includes('--lib-only')
const NO_AVATAR = ARGS.includes('--no-avatar')
const LIMIT = (() => {
  const a = ARGS.find(x => x.startsWith('--limit='))
  return a ? parseInt(a.split('=')[1], 10) : 0
})()
const CONC = (() => {
  const a = ARGS.find(x => x.startsWith('--conc='))
  return a ? parseInt(a.split('=')[1], 10) : 6
})()

const BASE = 'https://netflav5.com'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(AVA_DIR, { recursive: true })

/* ---------- 纯异步并发池（下载用） ---------- */
async function poolAsync(items, conc, worker) {
  let i = 0
  const total = items.length
  await Promise.all(Array.from({ length: Math.min(conc, total) }, async () => {
    while (i < total) {
      const idx = i++
      try { await worker(items[idx], idx) } catch (_) {}
    }
  }))
  return total
}

/* ---------- 页面复用式并发池：开 conc 个页面，轮流取任务 ---------- */
async function runPages(browser, items, conc, worker) {
  let i = 0
  let done = 0
  const total = items.length
  const pages = []
  for (let k = 0; k < Math.min(conc, total); k++) pages.push(await newCtx(browser))
  await Promise.all(pages.map(async pg => {
    while (i < total) {
      const idx = i++
      try { await worker(items[idx], idx, pg) } catch (e) { console.error('[worker]', String(items[idx]).slice(0, 40), e.message) }
      done++
      if (done % 100 === 0) console.log(`  进度 ${done}/${total}`)
    }
  }))
  await Promise.all(pages.map(pg => pg.close().catch(() => {})))
  return done
}

/* ---------- 浏览器：拦截图片等，只要 HTML ---------- */
async function newCtx(browser) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', r => {
    const t = r.resourceType()
    if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') return r.abort()
    r.continue()
  })
  return page
}

async function readNextData(page) {
  return page.evaluate(function () {
    const el = document.getElementById('__NEXT_DATA__')
    if (!el) return null
    try { return JSON.parse(el.textContent) } catch (e) { return null }
  })
}

/* ---------- 阶段 1：列表 ---------- */
async function fetchList() {
  if (fs.existsSync(LIST_CACHE)) {
    const c = JSON.parse(fs.readFileSync(LIST_CACHE, 'utf8'))
    console.log(`[1/3] LIST 命中缓存：${c.length} 位女优`)
    return c
  }
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const probe = await newCtx(browser)
  await probe.goto(BASE + '/actress', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  const nd = await readNextData(probe)
  const totalPages = (nd && nd.props.initialState.actress.pages) || 1
  const total = (nd && nd.props.initialState.actress.total) || 0
  console.log(`[1/3] LIST 共 ${total} 位女优 / ${totalPages} 页`)
  await probe.close()

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1)
  const all = []
  let cursor = 0
  await runPages(browser, pages, CONC, async (p, idx, pg) => {
    const my = cursor++
    await pg.goto(`${BASE}/actress?page=${p}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const j = await readNextData(pg)
    all[my] = (j && j.props.initialState.actress.docs) || []
  })
  const flat = all.filter(Boolean).flat()
  console.log(`[1/3] LIST 抓取完成：${flat.length} 条`)
  fs.writeFileSync(LIST_CACHE, JSON.stringify(flat))
  await browser.close()
  return flat
}

/* ---------- 阶段 2：档案（浏览器内 fetch + 限速多轮重试）
   netflav 的 /all?actress= 详情接口按突发限流：请求密集后整段 500，静默 ~1 分钟即恢复。
   所以采用：单线程慢速 + 库内演员优先 + 连续失败就长歇，循环跑到抓完为止。 ---------- */
const LIB_NAMES_FILES = (() => {
  const a = ARGS.find(x => x.startsWith('--lib='))
  return a ? a.slice('--lib='.length).split(',').map(s => s.trim()).filter(Boolean) : []
})()

async function libNames() {
  if (!LIB_NAMES_FILES.length) return []
  const all = []
  for (const f of LIB_NAMES_FILES) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      all.push(...(d.items || []).flatMap(x => x.actors || []))
    } catch (e) { console.error(`  [warn] 读不到媒体库 ${f}: ${e.message}`) }
  }
  return [...new Set(all.map(s => String(s || '').trim()).filter(Boolean))]
}

/* 名字归一化：全角→半角、片假名→平假名、繁日异体字→简体，再去掉符号空格。
   与前端的 acNorm 保持一致，配合 name-alias.json（中文译名→netflav 原名）做匹配。 */
let _NAME_MAP = null, _ALIAS = null
function loadMaps() {
  if (!_NAME_MAP) { try { _NAME_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'name-map.json'), 'utf8')) } catch (_) { _NAME_MAP = {} } }
  if (!_ALIAS) { try { _ALIAS = JSON.parse(fs.readFileSync(path.join(ROOT, 'name-alias.json'), 'utf8')) } catch (_) { _ALIAS = {} } }
  return { map: _NAME_MAP, alias: _ALIAS }
}
function acNorm(s) {
  if (!s) return ''
  const { map } = loadMaps()
  let x = String(s)
  x = x.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  x = x.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  x = x.split('').map(c => map[c] || c).join('')
  x = x.replace(/[^\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBFa-z0-9]/gi, '')
  return x.toLowerCase()
}
/* 把媒体库里的演员名（多为中文译名）展开成一组归一化键：原名 + 别名目标 */
async function libKeys() {
  const { alias } = loadMaps()
  const raw = await libNames()
  const keys = new Set()
  for (const n of raw) {
    keys.add(acNorm(n))
    const t = alias[n] || alias[n.trim()]
    if (t) { keys.add(acNorm(t)); String(t).split(/[\/、,]/).forEach(p => keys.add(acNorm(p))) }
  }
  keys.delete('')
  return keys
}

async function fetchProfiles(list, onUpdate) {
  const cache = fs.existsSync(PROFILE_CACHE) ? JSON.parse(fs.readFileSync(PROFILE_CACHE, 'utf8')) : {}
  const lib = await libKeys()
  const isLib = a => [a.name, a.name_ja, a.name_zh, a.name_en].some(x => x && lib.has(acNorm(x)))
  const rank = a => (isLib(a) ? 0 : 1) * 1e9 - (a.videoCount || 0)   // 库内最优先，其余按作品数
  const priority = list.slice().sort((a, b) => rank(a) - rank(b))
  console.log(`[2/3] PROFILE 库内优先：库名 ${lib.size} 个归一化键，命中 ${list.filter(isLib).length} 位`)

  let need = priority.filter(a => !cache[a.name] || cache[a.name]._error)
  if (!need.length) { console.log('[2/3] PROFILE 全部已缓存'); return cache }

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(BASE + '/actress', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(2000)

  const INNER_FN = async function (names, delay) {
    const out = {}
    for (const n of names) {
      try {
        const r = await fetch('/all?actress=' + encodeURIComponent(n), { credentials: 'include' })
        const st = r.status
        const t = await r.text()
        if (st !== 200) { out[n] = { name: n, _error: 'HTTP ' + st } } else {
          const m = t.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
          if (!m) out[n] = { name: n, _error: 'no-next-data' }
          else {
            const j = JSON.parse(m[1])
            const a = j.props && j.props.initialState && j.props.initialState.all && j.props.initialState.all.actress
            out[n] = a && a.uid ? a : { name: n, _missing: true }
          }
        }
      } catch (e) { out[n] = { name: n, _error: String(e.message).slice(0, 60) } }
      await new Promise(s => setTimeout(s, delay))
    }
    return out
  }

  const BATCH = 12
  const DELAY = 2800            // 单线程 2.8s/个 ≈ 21/分钟
  const t0 = Date.now()
  let added = 0
  while (true) {
    let targets = priority.filter(a => !cache[a.name] || cache[a.name]._error)
    if (!targets.length) break
    if (LIB_ONLY) {
      targets = targets.filter(isLib)
      if (!targets.length) { console.log('  [lib-only] 库内演员已全部抓完，收工'); break }
    }
    const slice = targets.slice(0, BATCH)
    let got = {}
    try { got = await page.evaluate(INNER_FN, slice.map(x => x.name), DELAY) } catch (e) {
      console.error('  evaluate 失败，歇 30 秒：', e.message.slice(0, 70))
      await sleep(30000)
      continue
    }
    Object.assign(cache, got)
    fs.writeFileSync(PROFILE_CACHE, JSON.stringify(cache))
    if (onUpdate) { try { onUpdate(cache) } catch (_) {} }
    const ok = Object.values(got).filter(v => v && v.uid).length
    const err = Object.values(got).filter(v => v && v._error).length
    added += ok
    const done = Object.keys(cache).filter(k => cache[k].uid).length
    console.log(`  +${ok} / 批${BATCH}（失败 ${err}）累计有效 ${done}，剩余 ${targets.length - BATCH}，耗时 ${Math.round((Date.now() - t0) / 60000)} 分钟`)
    if (ok === 0 && err >= BATCH - 1) {
      console.log('  连续被限流，歇 75 秒…')
      await sleep(75000)
    }
  }
  await browser.close()
  fs.writeFileSync(PROFILE_CACHE, JSON.stringify(cache))
  return cache
}

/* ---------- 阶段 3：头像 ---------- */
function resize(src, dst) {
  return new Promise(res => {
    execFile('sips', ['-Z', '160', src, '--out', dst, '-s', 'format', 'jpeg', '-s', 'formatOptions', '72'],
      err => res(!err))
  })
}

/* 头像来源多为第三方图床。部分域在本机代理下不可达 / 返回的是网页而非图片，这里做等价改写与过滤：
   - pics.r18.com 被代理拦截(TLS 失败) → 换同路径的 pics.dmm.co.jp（已验证可用）
   - www.javbus.com /en/star/xxx 是「年龄验证」网页不是图片 → 直接放弃，交给前端占位图 */
function iconCandidates(u) {
  if (!u || !/^https?:\/\//.test(u)) return []
  if (/javbus\.com\/[a-z]{2}\/star\//.test(u)) return []            // 网页，非图片
  if (/javbus\.com\/actress\/[^/]+$/.test(u) || /pics\.javbus\.com/.test(u)) return []
  const out = [u]
  if (u.includes('pics.r18.com')) out.push(u.replace('pics.r18.com', 'pics.dmm.co.jp'))
  return out
}

async function fetchAvatars(profiles) {
  const need = profiles.filter(p => p.lid && iconCandidates(p.iconRemote).length)
  const skip = profiles.filter(p => p.lid && p.iconRemote && !iconCandidates(p.iconRemote).length)
  skip.forEach(p => { if (!fs.existsSync(path.join(AVA_DIR, p.lid + '.jpg'))) p.icon = '' })   // 本地已有文件就别置空
  console.log(`[3/3] AVATAR 共 ${need.length} 张待下载（另有 ${skip.length} 个来源是网页/不可达，已置空）`)
  const tmpDir = path.join(TMP, 'img')
  fs.mkdirSync(tmpDir, { recursive: true })
  let ok = 0, fail = 0
  const fails = []
  await poolAsync(need, 12, async p => {
    const dst = path.join(AVA_DIR, p.lid + '.jpg')
    if (fs.existsSync(dst) && fs.statSync(dst).size > 500) { ok++; return }
    const raw = path.join(tmpDir, p.lid + '.raw')
    try {
      let buf = null, lastErr = null
      for (const u of iconCandidates(p.iconRemote)) {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: BASE + '/' }, signal: AbortSignal.timeout(20000) })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          const b = Buffer.from(await r.arrayBuffer())
          if (b.length < 300) throw new Error('too small')
          if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('not an image')
          buf = b; break
        } catch (e) { lastErr = e }
      }
      if (!buf) throw lastErr || new Error('no candidate')
      fs.writeFileSync(raw, buf)
      const good = await resize(raw, dst)
      if (!good) fs.copyFileSync(raw, dst)
      ok++
    } catch (e) { fail++; p.icon = ''; fails.push(p.name) } finally { try { fs.unlinkSync(raw) } catch (_) {} }
  })
  console.log(`[3/3] AVATAR 完成：成功 ${ok}，失败 ${fail}`)
  if (fails.length) console.log('  失败示例：' + fails.slice(0, 8).join(' / '))
  return { ok, fail }
}

/* ---------- 合并输出 ---------- */
function buildOutput(list, cache) {
  const norm = s => (s || '').replace(/\s+/g, '').toLowerCase()
  const out = []
  for (const item of list) {
    const p = cache[item.name] || {}
    const lid = item._id || item.uid || ''
    const rec = {
      uid: p.uid || item.uid || '',
      lid,
      name: item.name,
      name_ja: p.name_ja || (item.type === 'censored' ? item.name : ''),
      name_zh: p.name_zh || '',
      name_en: p.name_en || item.name_en || '',
      type: item.type || p.type || '',
      icon: lid ? `/actresses/${lid}.jpg` : '',
      iconRemote: item.icon || p.icon || '',
      birthday: p.birthday || '',
      height: p.height || '',
      cup: p.cup || '',
      breast: p.breast || '',
      waist: p.waist || '',
      hip: p.hip || '',
      hobby: p.hobby || '',
      videoCount: item.videoCount != null ? item.videoCount : (p.videoCount || 0)
    }
    rec.keys = [...new Set([rec.name, rec.name_ja, rec.name_zh, rec.name_en].filter(Boolean).map(norm))]
    out.push(rec)
  }
  return out
}

;(async () => {
  const list = await fetchList()
  if (LIST_ONLY) return console.log('仅列表模式，结束')
  const slice = LIMIT ? list.slice(0, LIMIT) : list
  const writeOut = cache => {
    const out = buildOutput(slice, cache)
    if (!NO_AVATAR) out.forEach(p => { if (!fs.existsSync(path.join(AVA_DIR, p.lid + '.jpg'))) p.icon = '' })
    fs.writeFileSync(OUT_JSON, JSON.stringify(out))
    return out
  }
  let lastN = -1
  const cache = AVATARS_ONLY
    ? (fs.existsSync(PROFILE_CACHE) ? JSON.parse(fs.readFileSync(PROFILE_CACHE, 'utf8')) : {})
    : await fetchProfiles(slice, c2 => {
        const n = writeOut(c2).filter(x => x.birthday || x.height || x.cup).length
        if (n !== lastN) { lastN = n; console.log(`  [写出] 有档案 ${n}`) }
      })
  const out = writeOut(cache)
  if (!NO_AVATAR) await fetchAvatars(out)
  writeOut(cache)
  const withProfile = out.filter(x => x.birthday || x.height || x.cup).length
  const withAva = out.filter(x => x.icon && fs.existsSync(path.join(AVA_DIR, x.lid + '.jpg'))).length
  console.log(`已写出 ${OUT_JSON}：${out.length} 位女优（有档案 ${withProfile}，有头像 ${withAva}），${(fs.statSync(OUT_JSON).size / 1048576).toFixed(1)} MB`)
  console.log('全部完成')
})().catch(e => { console.error('FATAL', e); process.exit(1) })
