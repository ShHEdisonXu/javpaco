/* =============================================================================
 * mdc-ng 规则引擎
 *
 * 规则来源：mdc-ng v1.36.0 官方发布二进制（mdc_ng_app_linux_arm64）内嵌的
 * provider 规则文件（raw-deflate 压缩的 YAML），已原样解出并保存到
 * rules/mdc-ng/*.yaml —— 未做任何改写，升级只需替换这些文件。
 *
 * 支持的规则语法（与 mdc-ng 一致）：
 *   name / base_url / enabled
 *   settings:
 *     cookies, encoding, cookie_session, errors[{pattern,message}]
 *     jav_number_format: { with_dash, case, uppercase, only_number, fc2_with_ppv }
 *   search:
 *     url（字符串或数组，按序尝试） / body（POST 表单） / detail_xpath（字符串或数组）
 *     matcher（详情页 URL 必须匹配的正则）
 *   detail:
 *     url_match（URL 含此串才算详情页）
 *     rules[]:
 *       field / xpath（字符串或数组）/ value（模板数组）/ is_array / is_url
 *       add_to_context / min_size / in_search_page
 *       processes[]: string{replace{from,to},case} | regex{replace{pattern,to}|extract{pattern,group}}
 *                    | date{format} | number{divide} | duration_to_minutes
 *
 * 模板变量：{number} {serial_name} {serial_number} {serial_number_trim_0}
 *           {number_00} {dmm_cid} {base_url} + 上下文里 add_to_context 抓到的字段
 * ========================================================================== */
'use strict'
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { JSDOM } = require('jsdom')
const xpathLib = require('xpath')

const RULE_DIR = path.join(__dirname, 'rules', 'mdc-ng')

/* ---------------- 站点改版适配层 ----------------
 * 规则文件保持 mdc-ng 原文（升级时整目录替换即可），这里只在「加载后、内存里」做
 * 最小改动，用来吸收站点改版造成的 xpath 失配。每条都要写清为什么，官方规则更新后逐一复核。
 * 原则：只做「等值 class 匹配 → 包含匹配」这类最保守的放宽，不做结构性重写。 */
const SITE_PATCHES = [
  {
    rule: 'DMM',
    why: '搜索结果项容器已从 class="flex-1" 变成 class="flex-1 px-3"，等值匹配 @class=\'flex-1\' 全空',
    from: "//div[@class='flex-1']",
    to: "//div[contains(@class,'flex-1')]"
  }
]
function patchByRule(name) {
  return SITE_PATCHES.filter(p => p.rule === name)
}
function patchXpathText(name, xp) {
  let s = String(xp || '')
  for (const p of patchByRule(name)) if (s.includes(p.from)) s = s.split(p.from).join(p.to)
  return s
}
/* 把改版适配打进规则对象（search.detail_xpath 与 detail.rules[].xpath 都覆盖） */
function applySitePatches(doc) {
  let n = 0
  const fix = v => { const out = patchXpathText(doc.name, v); if (out !== v) n++; return out }
  const s = doc.search
  if (s && s.detail_xpath != null) {
    s.detail_xpath = Array.isArray(s.detail_xpath) ? s.detail_xpath.map(fix) : fix(s.detail_xpath)
  }
  for (const r of ((doc.detail || {}).rules || [])) {
    if (r && r.xpath != null) r.xpath = Array.isArray(r.xpath) ? r.xpath.map(fix) : fix(r.xpath)
  }
  if (n) console.log('[mdcng] ' + doc.name + '：已应用 ' + n + ' 处站点改版适配（见 SITE_PATCHES）')
  return doc
}

/* ---------------- 规则加载 ---------------- */
let _rules = null
function listRules() {
  if (_rules) return _rules
  _rules = {}
  let files = []
  try { files = fs.readdirSync(RULE_DIR) } catch (_) { return _rules }
  for (const f of files.sort()) {
    if (!/\.ya?ml$/i.test(f)) continue
    try {
      const doc = yaml.load(fs.readFileSync(path.join(RULE_DIR, f), 'utf8'))
      if (doc && doc.name) {
        doc.__file = f
        // provider id（server-config 里的 id）→ 规则名 的大小写/下划线都不敏感
        _rules[String(doc.name)] = applySitePatches(doc)
      }
    } catch (e) { console.error('[mdcng] 规则解析失败', f, e.message) }
  }
  return _rules
}
const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
/* server-config 里的 provider id → mdc-ng 规则名（两边拼写/缩写不一致的显式登记在这里）
 * 规则名本身见 rules/mdc-ng/*.yaml 的 name 字段，改规则不动这里，改 id 才动 */
const RULE_ALIAS = {
  airav_io: 'Ariav_io',          // 源 id 是 airav_io，mdc-ng 里叫 Ariav_io（拼写差一个字母，模糊匹配匹配不上）
  xiao_huang_shu: 'xiaohuangshu',
  fc2_hub: 'FC2Hub',
  Fc2: 'FC2PPVDB',               // FC2 专用库（/articles/{number}，only_number），比 javten 镜像字段全
  miss_av: 'MissAV',
  hbox_jp: 'HBOX.JP'
}
/* 按 provider id 找规则：'airav_io' → 'Ariav_io'；'fc2_hub' → 'FC2Hub' */
function ruleFor(id) {
  const all = listRules()
  const alias = RULE_ALIAS[id] || RULE_ALIAS[String(id || '').toLowerCase()]
  if (alias && all[alias]) return all[alias]
  const want = normKey(id)
  for (const [name, doc] of Object.entries(all)) if (normKey(name) === want) return doc
  return null
}

/* ---------------- 番号解析（对齐 mdc-ng NamingTestMetadata 语义） ---------------- */
const pad5 = n => String(n || '').padStart(5, '0')
function splitNumber(code) {
  let raw = String(code || '').trim().toUpperCase().replace(/\s+/g, '')
  raw = raw.replace(/^FC2[-_]?PPV[-_]?/i, 'FC2-PPV-')
  let m = raw.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)?)-(\d+)$/)
  if (!m) m = raw.match(/^([A-Z]+)[-_]?(\d+)$/)
  if (!m) m = raw.match(/^([A-Z0-9]+?)-?(\d+)$/)
  const serial_name = m ? m[1] : raw.replace(/\d+$/, '')
  const serial_number = m ? m[2] : (raw.match(/(\d+)$/) || [, ''])[1]
  return { raw, serial_name, serial_number, serial_number_trim_0: String(serial_number).replace(/^0+/, '') || String(serial_number) }
}
/* jav_number_format：mdc-ng 对「搜索用的番号」做的规范化 */
function fmtNumber(code, fmt) {
  fmt = fmt || {}
  const { serial_name, serial_number } = splitNumber(code)
  let out
  if (fmt.only_number) out = String(serial_number)
  else if (fmt.fc2_with_ppv && /FC2/i.test(serial_name)) out = 'FC2-PPV-' + serial_number
  else out = serial_name + '-' + serial_number
  if (fmt.with_dash === false) out = out.replace(/-/g, '')
  if (fmt.case === 'lower' || fmt.case === 'lowercase') out = out.toLowerCase()
  else if (fmt.case === 'upper' || fmt.uppercase) out = out.toUpperCase()
  return out
}
/* 模板上下文 */
function baseContext(rule, code) {
  const s = splitNumber(code)
  const dmmcid = s.serial_name.toLowerCase().replace(/[^a-z0-9]/g, '') + pad5(s.serial_number)
  const sfmt = (rule && rule.settings) || {}
  return Object.assign({
    number: fmtNumber(code, sfmt.jav_number_format),
    number_raw: s.raw,
    serial_name: s.serial_name,
    serial_number: s.serial_number,
    serial_number_trim_0: s.serial_number_trim_0,
    number_00: s.serial_name + '-' + pad5(s.serial_number),
    dmm_cid: dmmcid,
    base_url: (rule && rule.base_url) || ''
  }, sfmt.extra_context || {})
}
const strfmt = (tpl, ctx) => String(tpl == null ? '' : tpl).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => (ctx[k] == null ? m : String(ctx[k])))

/* ---------------- HTML / XPath ---------------- */
function parseHtml(html, url) {
  try { return new JSDOM(html, { url: url || 'http://localhost/' }).window.document } catch (_) { return null }
}
/* 一个节点 → 文本值（属性节点取 value；其余取 textContent），并归一化空白 */
function nodeToText(n) {
  let v = ''
  if (typeof n === 'string') v = n
  else if (!n) v = ''
  else if (n.nodeType === 2) v = n.value                        // 属性节点
  else v = (n.textContent == null ? '' : n.textContent)
  return String(v).replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim()
}
/* XPathResult → 字符串数组（空串会被丢掉，与 mdc-ng 的取值语义一致） */
function xpathResultToArray(r) {
  const t = r.resultType
  const one = v => { const s = (v == null ? '' : String(v)).trim(); return s ? [s] : [] }
  if (t === 2) return one(r.stringValue)                        // STRING_TYPE
  if (t === 3) return r.booleanValue ? ['true'] : []            // BOOLEAN_TYPE
  if (t === 1) return one(r.numberValue)                        // NUMBER_TYPE
  if (t === 8 || t === 9) return one(nodeToText(r.singleNodeValue))   // ANY/FIRST_ORDERED_NODE
  const out = []
  if (t === 6 || t === 7) {                                     // *_NODE_SNAPSHOT
    for (let i = 0; i < r.snapshotLength; i++) { const v = nodeToText(r.snapshotItem(i)); if (v) out.push(v) }
    return out
  }
  let n                                                         // *_NODE_ITERATOR
  while ((n = r.iterateNext())) { const v = nodeToText(n); if (v) out.push(v) }
  return out
}
/* 求值一条 xpath：string()/number()/boolean() 返回单值；其余返回节点值数组
 *
 * 注意：默认走 jsdom 自带的 document.evaluate。npm 的 xpath@0.0.34 在 jsdom 上
 * 按标签名求值一律选不中（它拿 element.nodeName，jsdom 给的是大写 "A"，而 XPath
 * 的名字测试区分大小写，于是 //a、//div 全返回空，只有 //* 能选中）—— 规则里
 * 绝大多数 xpath 都是按标签名写的，所以必须用原生实现，npm 库只作兜底。 */
function evalXPath(doc, expr) {
  const e = String(expr || '').trim()
  if (!e) return []
  if (doc && typeof doc.evaluate === 'function') {
    try { return xpathResultToArray(doc.evaluate(e, doc, null, 0 /* ANY_TYPE */, null)) } catch (_) {}
  }
  try {
    if (/^(string|number|boolean)\s*\(/.test(e)) {
      const v = xpathLib.select1(e, doc)
      return (v == null || String(v) === '') ? [] : [String(v)]
    }
    const nodes = xpathLib.select(e, doc)
    const arr = Array.isArray(nodes) ? nodes : (nodes ? [nodes] : [])
    const out = []
    for (const n of arr) { const v = nodeToText(n); if (v) out.push(v) }
    return out
  } catch (e2) { return [] }
}
/* 依次试多条 xpath，取第一条有结果的 */
function evalAny(doc, exprs, ctx) {
  const list = Array.isArray(exprs) ? exprs : (exprs ? [exprs] : [])
  for (const raw of list) {
    const got = evalXPath(doc, strfmt(raw, ctx))
    if (got.length) return got
  }
  return []
}

/* ---------------- processes ---------------- */
function applyProcesses(vals, processes, ctx) {
  let arr = Array.isArray(vals) ? vals.slice() : (vals == null || vals === '' ? [] : [vals])
  for (const p of (processes || [])) {
    if (!p || typeof p !== 'object') continue
    const t = String(p.type || '').toLowerCase()
    if (t === 'string') {
      const r = p.replace
      if (r) {
        const froms = Array.isArray(r.from) ? r.from : [r.from]
        const to = r.to == null ? '' : String(r.to)
        arr = arr.map(v => {
          let s = String(v)
          for (const f of froms) if (f != null && String(f) !== '') s = s.split(String(f)).join(to)
          return s.trim()
        }).filter(Boolean)
      }
      if (p.case === 'upper') arr = arr.map(v => String(v).toUpperCase())
      else if (p.case === 'lower') arr = arr.map(v => String(v).toLowerCase())
    } else if (t === 'regex') {
      if (p.extract) {
        const pat = strfmt(p.extract.pattern, ctx)
        const grp = p.extract.group == null ? 1 : Number(p.extract.group)
        arr = arr.map(v => {
          let re
          try { re = new RegExp(pat) } catch (_) { return '' }
          const m = String(v).match(re)
          return m ? (m[grp] == null ? '' : String(m[grp]).trim()) : ''
        }).filter(Boolean)
      }
      if (p.replace) {
        const pat = strfmt(p.replace.pattern, ctx)
        const to = String(p.replace.to == null ? '' : p.replace.to).replace(/\$\{?(\d+)\}?/g, '$$$1')
        let re
        try { re = new RegExp(pat, 'g') } catch (_) { re = null }
        if (re) arr = arr.map(v => String(v).replace(re, to)).filter(Boolean)
      }
    } else if (t === 'date') {
      arr = arr.map(v => parseDateFmt(String(v), p.format)).filter(Boolean)
    } else if (t === 'number') {
      arr = arr.map(v => {
        let n = parseFloat(String(v).replace(/[^\d.\-]/g, ''))
        if (!isFinite(n)) return ''
        if (p.divide) n = n / Number(p.divide)
        return String(Math.round(n * 100) / 100)
      }).filter(Boolean)
    } else if (t === 'duration_to_minutes') {
      arr = arr.map(v => {
        const s = String(v)
        let mm = s.match(/(\d+)\s*(?:時間|小时|小時|h)/i)
        let mn = s.match(/(\d+)\s*(?:分|分钟|分鐘|m)/i)
        let sec = s.match(/(\d+)\s*(?:秒|s)/i)
        if (!mm && !mn) { const d = s.match(/(\d+)/); return d ? String(d[1]) : '' }
        return String((mm ? +mm[1] * 60 : 0) + (mn ? +mn[1] : 0) + (sec && +sec[1] >= 30 ? 1 : 0))
      }).filter(Boolean)
    }
  }
  return arr
}
/* strftime 风格 → 正则解析出 YYYY-MM-DD */
function parseDateFmt(s, fmt) {
  s = String(s).trim()
  if (!s) return ''
  const f = String(fmt || '%Y-%m-%d')
  const order = []
  let re = '^\\s*'
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const part of esc.split(/(%[YymdHMS])/)) {
    if (!part) continue
    const m = part.match(/^%([YymdHMS])$/)
    if (m) {
      order.push(m[1])
      re += m[1] === 'Y' ? '(\\d{4})' : '(\\d{1,2})'
    } else re += part
  }
  re += '\\s*$'
  let mm
  try { mm = s.match(new RegExp(re)) } catch (_) { mm = null }
  if (!mm) {
    const g = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/)
    return g ? `${g[1]}-${String(g[2]).padStart(2, '0')}-${String(g[3]).padStart(2, '0')}` : ''
  }
  const o = { Y: '', m: '', d: '' }
  order.forEach((k, i) => { o[k === '%' ? k : k] = mm[i + 1] })
  if (!o.Y) return ''
  return `${o.Y}-${String(o.m || 1).padStart(2, '0')}-${String(o.d || 1).padStart(2, '0')}`
}

/* ---------------- 抓取 ---------------- */
async function fetchWith(fetchHtml, url, opts) {
  return fetchHtml(url, opts || {})
}
/* cookie_session：先访问一次首页把 Set-Cookie 存下来（arzon 这类站点） */
async function warmSession(fetchHtml, rule, log) {
  try {
    const r = await fetchHtml(rule.base_url, { raw: true })
    const sc = (r && r.headers && r.headers['set-cookie']) || []
    const ck = (Array.isArray(sc) ? sc : [sc]).map(x => String(x).split(';')[0]).filter(Boolean)
    if (ck.length) { log && log('会话 cookie：' + ck.join('; ')); return ck.join('; ') }
  } catch (e) { log && log('建立会话失败：' + e.message) }
  return ''
}

/* 搜索阶段：拿详情页 URL */
async function findDetailUrl(rule, code, ctx, fetchHtml, log) {
  const s = rule.search || {}
  const urls = Array.isArray(s.url) ? s.url : (s.url ? [s.url] : [])
  const errors = ((rule.settings || {}).errors) || []
  let cookies = (rule.settings || {}).cookies || ''
  if ((rule.settings || {}).cookie_session && !cookies) cookies = await warmSession(fetchHtml, rule, log)
  for (const u of urls) {
    const target = new URL(strfmt(u, ctx), rule.base_url).href
    let html = '', landed = target
    try {
      const resp = await fetchHtml(target, { cookie: cookies, body: s.body ? strfmt(s.body, ctx) : '', post: !!s.body, wantUrl: true })
      // fetchHtml 支持 wantUrl 时返回 { body, url }（url = 跟完 3xx 之后的最终地址）
      if (resp && typeof resp === 'object') { html = resp.body || ''; landed = resp.url || target }
      else html = String(resp == null ? '' : resp)
    } catch (e) { log && log('搜索失败 ' + target + '：' + e.message); continue }
    const err = errors.find(x => x.pattern && html.indexOf(strfmt(x.pattern, ctx)) >= 0)
    if (err) { log && log('站点提示：' + err.message); continue }
    /* 站点把搜索请求直接 301/302 到详情页（jav321 就是：POST /search → /video/xxx）。
     * 这时落点已经命中 detail.url_match，就是详情页本身；若还按 detail_xpath 去页面里
     * 找链接，会挑到「相关视频」里的第一个，抓到完全不相干的作品。 */
    const um = (rule.detail || {}).url_match
    if (um && landed !== target && landed.indexOf(strfmt(um, ctx)) >= 0) {
      log && log('搜索被跳转到详情页：' + landed)
      return { url: landed, html, cookies }
    }
    // 详情页就在搜索 URL 上（missav / fc2ppvdb 这类直接给详情）
    if (s.detail_xpath == null) {
      if (!um || target.indexOf(strfmt(um, ctx)) >= 0) return { url: target, html }
    }
    const doc = parseHtml(html, landed)
    if (!doc) continue
    let got = evalAny(doc, s.detail_xpath, ctx)
    if (!got.length) { log && log('搜索页无匹配：' + target); continue }
    for (const href of got) {
      const abs = absUrl(href, landed)
      if (!abs) continue
      if (s.matcher) {
        let re
        try { re = new RegExp(strfmt(s.matcher, ctx)) } catch (_) { re = null }
        if (re && !re.test(abs)) continue
      }
      return { url: abs, html: '', searchHtml: html, cookies }
    }
    log && log('搜索结果都不符合 matcher：' + target)
  }
  return null
}
const absUrl = (u, base) => {
  try { return new URL(String(u || '').trim(), base).href } catch (_) { return '' }
}

/* 详情阶段：跑 detail.rules */
function parseDetail(rule, code, html, url, ctx0, log) {
  const doc = parseHtml(html, url)
  if (!doc) return null
  const ctx = Object.assign({}, ctx0, { base_url: rule.base_url })
  const out = {}
  const imgFields = { Cover: 'cover', Poster: 'poster', ExtraFanart: 'extrafanart' }
  for (const r of ((rule.detail || {}).rules || [])) {
    const f = r.field
    if (!f) continue
    /* value 是「候选模板」而不是最终值：页面里取不到图时整列都当候选，取到了则页面优先、模板兜底。
     * 下载端按顺序试到第一个能用的为止（DMM 的 Cover/Poster 就靠这点在 {dmm_cid} 拼错时用
     * {PublishNumber} 兜住），所以这里必须把候选全留着，不能只保留第一条。 */
    const tpl = r.value == null ? [] : (Array.isArray(r.value) ? r.value : [r.value]).map(v => strfmt(v, ctx)).filter(Boolean)
    let vals = evalAny(doc, r.xpath, ctx)
    if (tpl.length) vals = vals.length ? (imgFields[f] ? vals.concat(tpl) : vals) : tpl
    vals = applyProcesses(vals, r.processes, ctx)
    const multi = !!r.is_array || !!imgFields[f]      // 图片字段天然是多候选
    if (multi) {
      const seen = []
      for (const v of vals) if (v && !seen.includes(v)) seen.push(v)
      vals = seen
    }
    out[f] = multi ? vals : (vals.length ? vals[0] : '')
    if (r.add_to_context) {
      const v = out[f]
      ctx[f] = Array.isArray(v) ? (v[0] || '') : v
    }
  }
  return { fields: out, ctx, doc }
}

/* ---------------- 对外主入口 ----------------
 * fetchHtml(url, {cookie, post, body, raw}) → string | {body, headers}
 * 返回 { ok, reason, fields, ctx, usedUrl, searchUrl, tried }
 */
/* 规则自带的搜索地址（已代入模板变量、补成绝对 URL）。
 * 给 server 端「没有搜索模板的源」复用：通用解析兜底时也有正确的落点，不会去抓一个假 URL */
function searchUrls(rule, code) {
  const s = (rule && rule.search) || {}
  const urls = Array.isArray(s.url) ? s.url : (s.url ? [s.url] : [])
  const ctx = baseContext(rule, code)
  return urls.map(u => { try { return new URL(strfmt(u, ctx), rule.base_url).href } catch (_) { return '' } }).filter(Boolean)
}

async function scrape(providerId, code, fetchHtml, log) {
  const rule = ruleFor(providerId)
  if (!rule) return { ok: false, reason: '没有该数据源的 mdc-ng 规则', fields: {} }
  if (rule.enabled === false) return { ok: false, reason: '该数据源在 mdc-ng 规则里是默认关闭的（enabled: false）', fields: {} }
  const ctx = baseContext(rule, code)
  log && log('规则：' + rule.__file + '，番号规范化为 ' + ctx.number)
  let got = await findDetailUrl(rule, code, ctx, fetchHtml, log)
  if (!got) {
    // 详情页规则存在但没有 search（比如直接给 URL）：把 base_url+url_match 当详情页
    const s = rule.search || {}
    if (s.url == null && (rule.detail || {}).url_match) {
      const direct = rule.base_url
      try {
        const html = await fetchHtml(direct, { cookie: (rule.settings || {}).cookies || '' })
        const p = parseDetail(rule, code, html, direct, ctx, log)
        if (p && p.fields && p.fields.Title) return { ok: true, fields: p.fields, ctx: p.ctx, usedUrl: direct }
      } catch (_) {}
    }
    return { ok: false, reason: '搜索页里没找到这个番号的详情页', fields: {} }
  }
  let html = got.html
  if (!html) {
    try { html = await fetchHtml(got.url, { cookie: got.cookies || (rule.settings || {}).cookies || '', referer: got.searchHtml ? '' : '' }) }
    catch (e) { return { ok: false, reason: '详情页抓取失败：' + e.message, fields: {} } }
  }
  const p = parseDetail(rule, code, html, got.url, ctx, log)
  if (!p) return { ok: false, reason: '详情页解析失败（HTML 无法解析）', fields: {} }
  const f = p.fields || {}
  // 命中判定：与 mdc-ng 一样，标题或番号必须落在页面上
  const hit = !!(f.Title || f.Number || f.PublishNumber)
  if (!hit) return { ok: false, reason: '详情页里没有解析到标题/番号（站点改版或不是详情页）', fields: {}, usedUrl: got.url }
  return { ok: true, fields: f, ctx: p.ctx, usedUrl: got.url, searchUrl: null }
}

module.exports = {
  listRules, ruleFor, splitNumber, fmtNumber, baseContext, strfmt, searchUrls,
  parseHtml, evalXPath, evalAny, applyProcesses, parseDateFmt, scrape
}
