#!/usr/bin/env node
/*
 * fill-profile-minnano.js — 用 minnano-av.com 补全女優档案
 *
 * 数据源：https://www.minnano-av.com/search_result.php?search_scope=actress&search_word=<名字>
 *   · 精确命中会 302 直接跳到 /actress<id>.html 资料页
 *   · 资料页 <td><span>键</span><p>值</p></td> 结构，字段：
 *       生年月日 / サイズ(T身高 B胸圍(罩杯) W腰圍 H臀圍 S鞋碼) / 血型 / 出身地
 *       趣味・特技 / AV出演期間 / デビュー作品 / 所属事務所 / 別名(多条) / ブログ
 *   · 实测 0.55s 间隔无任何限流（对比 netflav 的 Forbidden2）
 *
 * 用法：
 *   node tools/fill-profile-minnano.js --scope=lib --lib=/tmp/data.json   # 只补媒体库命中的女優
 *   node tools/fill-profile-minnano.js --conc=8 --delay=250               # 全量 5566（约 1 小时）
 *   node tools/fill-profile-minnano.js --limit=200 --delay=800            # 限数量/调速率
 *   node tools/fill-profile-minnano.js --scope=lib --avatars              # 顺带补缺头像
 *
 * 断点续跑：缓存 $TMPDIR/javpaco-scrape/minnano.json，重跑会自动跳过已成功的。
 * 名字校验：只有资料页的规范名/别名与我们查的名字对得上才写入，避免张冠李戴。
 */
const fs = require('fs')
const path = require('path')

const UI = path.resolve(__dirname, '..')
const OUT = path.join(UI, 'actresses.json')
const AVA_DIR = path.join(UI, 'actresses')
const TMP = path.join(process.env.TMPDIR || '/tmp', 'javpaco-scrape')
const CACHE = path.join(TMP, 'minnano.json')

const ARGS = process.argv.slice(2)
const arg = (k, d) => { const x = ARGS.find(a => a.startsWith('--' + k + '=')); return x ? x.slice(k.length + 3) : d }
const LIMIT = parseInt(arg('limit', '0'), 10)
const DELAY = parseInt(arg('delay', '900'), 10)
const LIB_FILE = arg('lib', '')
const SCOPE = arg('scope', 'all')            // all | lib
const CONC = parseInt(arg('conc', '1'), 10)  // 并发数（实测 8 稳定，12 开始出错）
const DO_AVATAR = ARGS.includes('--avatars')
const REDO = ARGS.includes('--redo')         // 忽略缓存重抓

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://www.minnano-av.com/'

const MAP = JSON.parse(fs.readFileSync(path.join(UI, 'name-map.json'), 'utf8'))
const ALIAS = JSON.parse(fs.readFileSync(path.join(UI, 'name-alias.json'), 'utf8'))

const sleep = ms => new Promise(s => setTimeout(s, ms))

/* ---------- 名字归一化（与前端 acNorm 一致：全角→半角、片假名→平假名、剔符号） ---------- */
function acNorm(s) {
  if (!s) return ''
  let x = String(s)
  x = x.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  x = x.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  x = x.split('').map(c => MAP[c] || c).join('')
  x = x.replace(/[^\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBFa-z0-9]/gi, '')
  return x.toLowerCase()
}

/* ---------- 网络（返回 {status,url,text}；body 读取失败也走重试，绝不向外抛异常） ---------- */
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, referer: BASE, accept: 'text/html,application/xhtml+xml' },
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

const strip = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/* ---------- 资料页解析 ---------- */
function parseProfile(html) {
  const kv = {}
  const alias = []
  for (const m of html.matchAll(/<td[^>]*>\s*<span>([^<]+)<\/span>([\s\S]*?)<\/td>/g)) {
    const k = strip(m[1]), v = strip(m[2])
    if (!k || !v) continue
    if (k === '別名') { alias.push(v.split('（')[0].split('(')[0].trim()); continue }
    if (!kv[k]) kv[k] = v
  }
  const size = kv['サイズ'] || ''
  const birthday = (kv['生年月日'] || '').replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, (_, y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`).split(/[\s（(]/)[0]
  // 规范名：og:title 形如 "篠田ゆう（しのだゆう）AV女優プロフィール - みんなのAV.com"
  let canon = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || ''
  canon = canon.split(/(（|\(|AV女優|のAV)/)[0].trim()
  const img = (html.match(/"image"\s*:\s*"([^"]+)"/) || [])[1] || ''
  return {
    canon, img,
    birthday,
    height: (size.match(/T(\d+)/) || [])[1] || '',
    bust: (size.match(/B(\d+)/) || [])[1] || '',
    cup: (size.match(/([A-Z])カップ/) || [])[1] || '',
    waist: (size.match(/W(\d+)/) || [])[1] || '',
    hip: (size.match(/H(\d+)/) || [])[1] || '',
    shoe: (size.match(/S([\d.]+)/) || [])[1] || '',
    blood: kv['血液型'] || '',
    place: kv['出身地'] || '',
    hobby: kv['趣味・特技'] || '',
    period: kv['AV出演期間'] || '',
    debut: kv['デビュー作品'] || '',
    agency: kv['所属事務所'] || '',
    alias: alias.filter(Boolean)
  }
}

/* ---------- 查一个人 ---------- */
async function lookup(name) {
  const url = BASE + 'search_result.php?search_scope=actress&search_word=' + encodeURIComponent(name)
  const r = await get(url)
  if (!r || r.status !== 200 || !r.text) return { ok: false, reason: r ? 'http_' + r.status : 'network' }
  const html = r.text
  const isProfile = /\/actress\d+\.html/.test(r.url)
  if (isProfile) {
    const p = parseProfile(html)
    // 搜索直达资料页 = minnano 认定是我们查的名字（含别名/改名前旧名），可信
    return { ok: true, url: r.url, direct: true, ...p }
  }
  // 未重定向 → 结果列表，按名字精确挑一条
  const want = acNorm(name)
  const cands = [...html.matchAll(/href="(actress\d+\.html)"[^>]*>([\s\S]{0,80}?)<\/a>/g)]
    .map(m => ({ href: m[1], text: strip(m[2]) }))
    .filter(c => c.text)
  const exact = cands.find(c => acNorm(c.text) === want)
  if (!exact) return { ok: false, reason: 'ambiguous', cands: cands.slice(0, 5).map(c => c.text) }
  const r2 = await get(BASE + exact.href)
  if (!r2 || r2.status !== 200 || !r2.text) return { ok: false, reason: 'network' }
  const p = parseProfile(r2.text)
  if (acNorm(p.canon) !== want) return { ok: false, reason: 'name_mismatch', got: p.canon }
  return { ok: true, url: r2.url, ...p }
}

/* ---------- 主流程 ---------- */
async function main() {
  const list = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  fs.mkdirSync(TMP, { recursive: true })
  let cache = {}
  if (!REDO && fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch (_) {} }

  // 库内名字（含别名展开）
  const libKeys = new Set()
  if (LIB_FILE) {
    try {
      const d = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'))
      const names = new Set()
      ;(d.items || []).forEach(it => (it.actors || []).forEach(a => names.add(String(a).trim())))
      for (const n of names) {
        libKeys.add(acNorm(n))
        const t = ALIAS[n] || ALIAS[n.trim()]
        if (t) String(t).split(/[/、,]/).forEach(x => libKeys.add(acNorm(x)))
      }
      libKeys.delete('')
      console.log(`媒体库演员：${names.size} 个名字 → ${libKeys.size} 个归一化键`)
    } catch (e) { console.log('读取 --lib 失败：' + e.message) }
  }

  // 索引：把 netflav 的所有名字形态映射到记录
  const byKey = new Map()
  const put = (k, a) => { if (k && !byKey.has(k)) byKey.set(k, a) }
  list.forEach(a => {
    put(acNorm(a.name), a); put(acNorm(a.name_ja), a); put(acNorm(a.name_zh), a)
  })
  const inLib = a => libKeys.has(acNorm(a.name)) || libKeys.has(acNorm(a.name_ja)) || libKeys.has(acNorm(a.name_zh))

  // 排序：库内优先 → 已有档案的其次 → 其余按作品数
  const rank = a => (inLib(a) ? 0 : 1) * 1e12 + ((a.birthday || a.height) ? 0 : 1) * 1e11 - (a.videoCount || 0)
  let targets = list.slice().sort((x, y) => rank(x) - rank(y))
  if (SCOPE === 'lib') targets = targets.filter(inLib)
  targets = targets.filter(a => REDO || !(cache[a.name] && cache[a.name].ok))
  if (LIMIT) targets = targets.slice(0, LIMIT)

  console.log(`待补：${targets.length} 人（scope=${SCOPE}${LIMIT ? '，limit=' + LIMIT : ''}，间隔 ${DELAY}ms）`)
  if (DO_AVATAR) targets = []   // --avatars = 仅补头像，跳过档案阶段
  if (!targets.length) console.log('（跳过档案阶段）')

  let ok = 0, miss = 0, filled = 0, dirty = false
  const fails = []
  const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache))
  // 原子写入：先写临时文件再 rename，避免构建/前端读到半截 JSON
  const saveOut = () => {
    const tmp = OUT + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list))
    fs.renameSync(tmp, OUT)
  }

  const t0 = Date.now()
  const total = targets.length
  let done = 0, cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= total) return
      const a = targets[i]
      const t = Date.now()
      let res
      try { res = await lookup(a.name) } catch (e) { res = { ok: false, reason: 'ERR:' + String(e && e.message || e).slice(0, 40) } }
      cache[a.name] = res
      if (res.ok) {
        // 名字复核：直达资料页(=精确匹配)直接采纳；列表页挑出来的才严格比对
        const nk = acNorm(res.canon)
        const ac = acNorm(a.name), ja = acNorm(a.name_ja), zh = acNorm(a.name_zh)
        const nameOk = res.direct || nk === ac || nk === ja || nk === zh ||
          [a.name, a.name_ja, a.name_zh].filter(Boolean).some(n =>
            res.alias.some(x => acNorm(x) === acNorm(n))) ||
          res.alias.some(x => acNorm(x) === ac)
        if (!nameOk) {
          res.ok = false; res.reason = 'name_mismatch'; res.got = res.canon
          miss++; if (fails.length < 40) fails.push(`${a.name}(${res.canon})`)
        } else {
          ok++
          if (res.birthday) a.birthday = res.birthday
          // 与 netflav 现有数据保持同格式：长度类带 cm 后缀
          const cmv = v => (v ? String(v).replace(/cm$/i, '') + 'cm' : '')
          if (res.height) a.height = cmv(res.height)
          if (res.bust) a.breast = cmv(res.bust)
          if (res.cup) a.cup = res.cup
          if (res.waist) a.waist = cmv(res.waist)
          if (res.hip) a.hip = cmv(res.hip)
          a.msrc = res.url
          if (res.canon && acNorm(res.canon) !== acNorm(a.name)) a.mcanon = res.canon   // 站内规范名（改过名/别名时便于核对）
          if (res.blood) a.blood = res.blood
          if (res.place) a.place = res.place
          if (res.hobby) a.hobby = res.hobby
          if (res.period) a.period = res.period
          if (res.agency) a.agency = res.agency
          if (res.alias.length) a.alias = res.alias
          if (res.img) a.mimg = res.img
          if (res.birthday || res.height || res.cup) filled++
          dirty = true
        }
      } else {
        miss++
        if (fails.length < 40) fails.push(`${a.name}:${res.reason}${res.got ? '(' + res.got + ')' : ''}`)
      }
      done++
      if (done % 20 === 0 || done === total) {
        if (dirty) { saveOut(); dirty = false }
        saveCache()
        const el = (Date.now() - t0) / 1000
        const eta = Math.round(el / done * (total - done))
        console.log(`  [${done}/${total}] 命中 ${ok} / 未命中 ${miss} / 已写入 ${filled}  | ${Math.round(el)}s，剩余约 ${Math.floor(eta / 60)}m${eta % 60}s`)
      }
      if (DELAY) await sleep(Math.max(0, DELAY - (Date.now() - t)))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONC) }, worker))
  saveOut(); saveCache()
  if (DO_AVATAR) {
    const have = new Set(fs.existsSync(AVA_DIR) ? fs.readdirSync(AVA_DIR) : [])
    const need = list.filter(a => !a.icon && a.mimg && a.lid && !have.has(a.lid + '.jpg'))
    console.log(`\n[头像] 需补 ${need.length} 张`)
    let aok = 0, afail = 0
    for (const a of need) {
      try {
        let b = null
        for (let k = 0; k < 3 && !b; k++) {
          try {
            const rr = await fetch(a.mimg, { headers: { 'user-agent': UA, referer: BASE }, signal: AbortSignal.timeout(20000) })
            if (rr.status !== 200) throw new Error('http ' + rr.status)
            const buf = Buffer.from(await rr.arrayBuffer())
            if (buf.length < 500) throw new Error('small')
            b = buf
          } catch (_) { await sleep(1000 * (k + 1)) }
        }
        if (!b) throw new Error('dl')
        fs.writeFileSync(path.join(AVA_DIR, a.lid + '.jpg'), b)
        a.icon = '/actresses/' + a.lid + '.jpg'
        aok++
      } catch (_) { afail++ }
      await sleep(Math.max(0, 300))
    }
    saveOut()
    console.log(`[头像] 成功 ${aok}，失败 ${afail}`)
  }

  console.log(`\n完成：命中 ${ok}，未命中 ${miss}，写入档案 ${filled}，耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
  if (fails.length) console.log('未命中示例：\n  ' + fails.slice(0, 20).join('\n  '))
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
