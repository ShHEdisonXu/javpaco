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
let MEDIA_ROOT = resolveMediaRoot()
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
/* 原生模式（Mac 版 / 将来的 Win 版）：跑在宿主机上、拥有完整文件系统权限，没有容器挂载边界。
 * 由启动器注入环境变量识别：Mac 版设 JP_MAC=1，Win 版设 JP_NATIVE=1；
 * 兜底：非 Linux 平台且没有 /proc/self/mountinfo 也按原生处理（NAS/Docker 是 Linux 且有 /proc，不会误判）。 */
const NATIVE = process.env.JP_MAC === '1' || process.env.JP_NATIVE === '1' ||
  (process.platform !== 'linux' && !fs.existsSync('/proc/self/mountinfo'))
/* 原生模式下媒体根 = 当前已配置媒体库的共同祖先（无容器根限制）；加跨分支目录时再扩张。
 * 这样已存在的单库用户升级后媒体根不变，已有 relVideo 不需重建。 */
function commonAncestor(paths) {
  const ps = (paths || []).map(p => path.resolve(String(p)).split(path.sep).filter(Boolean))
  if (!ps.length) return null
  let i = 0
  while (i < ps[0].length && ps.every(pp => pp[i] === ps[0][i])) i++
  if (i === 0) return process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + path.sep : path.sep
  const head = ps[0].slice(0, i).join(path.sep)
  /* ⚠ Windows 盘符（2026-10-13 修）：'C:\' resolve 后拆出来只有 ['C:']，join 回去是 'C:'，
   * 前面再无条件补 path.sep 就得到 '\C:' —— 丢了盘符、「当前盘」语义，而且这个路径根本不存在。
   * 危害不只是少一层：MEDIA_ROOT 一旦被污染，path.relative(MEDIA_ROOT, <库内文件>) 全错位，
   * 扫描出的 relVideo/relPoster 解不回来 → 本地媒体的封面和视频全部打不开。
   * 判据：首段形如 'X:' 说明盘符已经带冒号，不能再补前导分隔符；
   * 共同祖先正好停在盘符（i===1，如 C:\A 与 C:\B）时要补回尾部 path.sep，否则 'C:' 不是合法根。 */
  if (/^[A-Za-z]:$/.test(ps[0][0])) return i === 1 ? head + path.sep : head
  return path.sep + head
}
/* 媒体根「提示值」的形态校验 —— 只用于判断**存下来的**路径（scan-result.json 的 root）能不能采信，
 * 不用于校验用户输入（用户在设置页选的真目录由 fs 存在性负责）。
 * 起因（2026-10-13 用户报「启动失败」）：老版本 commonAncestor 的盘符 bug 曾产出 '\C:' 这种畸形值，
 * 它被写进缓存后又当基准反哺回来，在 D 盘工作目录下 resolve 成 'D:\C:' →
 * 启动存在性校验失败、又没有可回退的库 → process.exit(1) → 用户只看到「启动失败」一个弹窗，零线索。
 * 合法形态：Windows = 'X:\…' 或 'X:' 或 '\\server\share\…'；POSIX = '/…'。别的一律判否。 */
function saneRoot(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s || s.length > 400) return ''
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:([\\/]|$)/.test(s)) return /[:*?"<>|]/.test(s.slice(2)) ? '' : s
    if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(s)) return s
    return ''
  }
  return s.charAt(0) === '/' ? s : ''
}

/* 历史媒体根提示「能不能采信」的第二个条件：它必须真的**包住所有已配置库**。
 * 成立时说明它就是历史 relVideo 的基准（比库更浅一层），采信能让老条目不用重扫也能解析；
 * 不成立时必须丢掉 —— 反例（2026-10-13 实测推演）：0 个媒体库时 MEDIA_ROOT 是占位根 'C:\'，
 * 用户随后加了 D 盘的库，commonAncestor(['D:\AV','C:\']) 会跨盘回退到 'C:\'（SystemDrive），
 * 于是库内文件的 relVideo 变成跨盘绝对路径 'D:\AV\x.mp4'，被 `fp.startsWith(MEDIA_ROOT + sep)` 挡下
 * → 封面、视频、整理全部失效，且重启也修不好（缓存里存的还是 'C:\'）。丢了提示后
 * commonAncestor 退回只算真实库，MEDIA_ROOT = 库本身，路径立刻正常。
 * 0 个库时判真（空集 every 为真）—— 保留它才能让「删光库再重加同一层」不丢历史基准。 */
function hintFits(hint, libs) {
  if (!hint) return false
  /* 斜杠方向与大小写都要归一（Windows）：历史数据里 'D:/x' 与配置里的 'D:\x' 是同一个目录，
   * 不归一就会把合法基准误判成「不包含库」而丢掉（2026-10-13 测试实测踩中）。
   * ⚠ 内层函数别起名成 norm —— 回归测试按这个标识符当锚点切源码，切到这行会让片段残缺。 */
  const normKey = s => {
    const t = String(s).replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return process.platform === 'win32' ? t.toLowerCase() : t
  }
  const h = normKey(hint)
  if (!h) return false
  return (libs || []).every(l => { const s = normKey(l); return s === h || s.startsWith(h + '/') })
}

const mountTip = () => NATIVE
  ? '只能操作媒体库内的文件'
  : '只能整理已挂载进容器的目录（当前可见：' + containerMounts().join('、') +
  '）内的文件夹。容器看不见本机路径，要整理别处的文件夹，请在 docker-compose.yml 里加一行映射到 ' +
  MEDIA_ROOT + '/子目录（如 ' + MEDIA_ROOT + '/测试），然后重建容器'

/* ---------- 全局配置（server-config.json：代理 + 媒体库列表，Emby 式管理） ----------
 * 挂载点只是访问权限，与 Emby 一样：不添加媒体文件夹就不扫描、没有媒体库。
 * 列表完全由设置页添加/移除驱动，落盘 libraries 字段（可为空数组）。 */
const CFG_FILE = path.join(UI_ROOT, 'server-config.json')
/* 配置防丢：server-config.json 在容器层，重建容器就没了（token/媒体库/收藏全丢）。
 * 每次落盘时同步备份一份到持久化目录（JP_CACHE 挂载点 / cacheDir / ./cache），
 * 启动时若主配置读不到（新容器首次启动），自动从备份找回。 */
function cfgBackupFile() {
  const root = process.env.JP_CACHE || (typeof CFG === 'object' && CFG && CFG.cacheDir) || path.join(UI_ROOT, 'cache')
  return path.resolve(root, 'server-config.backup.json')
}
let CFG = (() => {
  let txt = ''
  try { txt = fs.readFileSync(CFG_FILE, 'utf8') } catch (_) {}
  if (!txt.trim()) {
    /* 主配置缺失/为空 → 尝试持久化备份（只认 JP_CACHE 与程序目录，此时 CFG 还没加载） */
    for (const root of [process.env.JP_CACHE, path.join(UI_ROOT, 'cache')].filter(Boolean)) {
      try {
        txt = fs.readFileSync(path.resolve(root, 'server-config.backup.json'), 'utf8')
        fs.writeFileSync(CFG_FILE, txt)
        console.log('[config] 主配置缺失，已从缓存目录备份找回 server-config.json')
        break
      } catch (_) { txt = '' }
    }
  }
  try { return JSON.parse(txt) } catch (_) { return {} }
})()
let LIBS = Array.isArray(CFG.libraries) ? CFG.libraries.map(s => path.resolve(String(s))) : []
/* 上次扫描结果里记的媒体根（已过形态校验，可能不存在）—— 仅用于启动/运行时的基准推导与回退候选 */
let HINT_ROOT = ''
/* 原生模式：媒体根改成已配置媒体库的共同祖先（无容器挂载边界）。Mac/Win 启动器都不设容器，
 * 这条路径在 NAS/Docker 上完全不走（NATIVE=false，MEDIA_ROOT 保持挂载根）。
 * ⚠ 必须把「上次扫描结果的 root」也纳入共同祖先计算（v0.3.10 修复）：
 * 只有一个深层库（如 …/刮削完毕/无码破解）时，仅对 LIBS 求共同祖先会得到该深层目录本身，
 * 但磁盘上历史 relVideo 的基准是上一次扫描时的 MEDIA_ROOT（更浅，如 …/刮削完毕）——
 * 于是 MEDIA_ROOT 错位一层：存在性校验直接失败导致启动退出，历史条目的封面/视频路径也全部打不开。
 * 把 saved.root 一并纳入后，共同祖先回到正确的上一级，校验通过、旧条目也能正确解析。
 * ⚠ 但「纳入」是有条件的：这个值必须先过 saneRoot + hintFits 两道闸（见下），
 *   否则一个脏值/跨盘占位根就能反过来绑架 MEDIA_ROOT，把 App 卡死在启动阶段。 */
if (NATIVE) {
  const roots = LIBS.slice()
  try {
    /* 读上次扫描结果里的真实媒体根（不引依赖，直接 fs 读）。
     * ⚠ 这个提示必须过**两道闸**：形态合法（saneRoot）+ 目录真实存在。
     * 只过一道都不行 —— 见 saneRoot 注释：脏值会绑架整个 MEDIA_ROOT，最终把 App 卡死在启动阶段。 */
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'scan-result.json'), 'utf8'))
    HINT_ROOT = saneRoot(saved && saved.root)
    if (HINT_ROOT && fs.existsSync(HINT_ROOT) && hintFits(HINT_ROOT, LIBS)) roots.push(HINT_ROOT)
    else if (saved && saved.root) console.log('[media] 忽略不可用的媒体根提示 ' + JSON.stringify(String(saved.root)) +
      (!HINT_ROOT ? '（路径形态非法）' : (!fs.existsSync(HINT_ROOT) ? '（目录当前不存在）' : '（不包含已配置的媒体库，会带偏媒体根）')))
  } catch (_) {}
  const ca = roots.length ? commonAncestor(roots)
    : (process.env.JP_MEDIA_ROOT || (process.platform === 'win32' ? 'C:\\' : '/'))
  if (ca) MEDIA_ROOT = ca
}
function writeCfg() {
  const out = Object.assign({}, CFG, { libraries: LIBS })
  const t = CFG_FILE + '.tmp'
  fs.writeFileSync(t, JSON.stringify(out, null, 2))
  fs.renameSync(t, CFG_FILE)
  /* 配置一变，来源卡片 / 统计的 60 秒缓存立刻作废（2026-10-15）。
     不这么做的话「刚新建的第二个账号」要等最多 1 分钟才出现在媒体源页，用户以为没加上。
     try 包住：本函数在模块加载期也可能被调用，而 SRC_CACHE 是后面才声明的 let（TDZ）。 */
  try { SRC_CACHE = { at: 0, data: null } } catch (_) {}
  /* 同步备份到持久化目录（失败不影响主流程） */
  try {
    const bk = cfgBackupFile()
    fs.mkdirSync(path.dirname(bk), { recursive: true })
    fs.writeFileSync(bk, JSON.stringify(out, null, 2))
  } catch (_) {}
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

/* ================= 海报悬停预览动图 =================
 * 两条来源，前端择优（2026-10-13 用户明确：只要视频切片，剧照轮播那路已删除）：
 *   ① 真实抽帧短片：实体影片（relVideo 本地文件）加入后，用 ffmpeg 抽 **6 段 × 各 1 秒**（合计 6s）
 *      的静音 480p mp4，6 段取自影片不同时间点，串成一条短片循环播放，存进 cache/movies/<番号>/pv7.mp4。
 *   ② 线上动图：JavDB 官方预览片（HLS 真视频），见下面的 previewOnlineClip() —— 115 网盘片源
 *      没有本地文件、① 走不通时靠它；一样是 6 个切片 × 各 1 秒。
 * 低负担原则：单 worker 串行、任务间留 2s 间隔、扫描进行中让路、macOS 下 ffmpeg 走 nice -n 15。
 * 纯在线条目（relVideo 以 web:// 开头、无本地文件）不生成。
 * ffmpeg 二进制定位见 ffBin()（Windows 上一般不在 PATH，可用 JP_FFMPEG 或程序目录下的 ffmpeg\）。
 * ⚠ 本块必须在模块顶层（不能放进 handleActorApi 等函数体内）——函数声明提升只在同作用域生效，
 *   放进函数里会导致启动时顶层调用 schedulePreviews 报 not defined。
 * ⚠ 文件名带版本（pv7 而非 preview）：抽帧参数一改就换名，旧文件自动失效、整批重生成，
 *   不需要写迁移逻辑。PREV_VER 同步 bump，previews.json 里版本不匹配时触发一次性清理+重排。 */
const PREV_FILE = 'pv7.mp4'
const PREV_VER = 3                    // v1=单段5s / v2=6段×2s / v3=6段×1s
const PREV_SEG = 1                    // 每段秒数（2026-10-13 由 2 改 1：用户要「每个切片1秒」）
const PREV_SEGS = 6                   // 段数：一个番号 6 个切片
/* 历史版本产物，升级时清掉（否则旧文件一直占地方、还会被 previewHas 误判成「已有预览」） */
const PREV_STALE_FILES = ['preview.mp4', 'pv6.mp4']
const PREV_TMP = '.pvseg'
let PREV_QUEUE = [], PREV_RUN = false
const PREV_SET = new Set()
/* ⚠ 这几个路径写成函数而不是常量：设置里的「离线数据迁移」会把 cacheDir 换掉，
 *   常量在模块加载时就固化了 —— 迁移后还往旧目录写（旧目录已被清空 → 数据凭空多出一份）。 */
const PREV_PATH = () => path.join(cacheDir(), 'previews.json')
function previewHas(code) { try { return fs.existsSync(path.join(cacheDir(), 'movies', code, PREV_FILE)) } catch (_) { return false } }
function previewLoad() {
  try {
    const v = JSON.parse(fs.readFileSync(PREV_PATH(), 'utf8'))
    if (v && v.v === PREV_VER && Array.isArray(v.codes)) { v.codes.forEach(c => PREV_SET.add(c)); return false }
  } catch (_) {}
  return true   // 版本不匹配 / 文件损坏 → 需要整批重做
}
function previewSave() { try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(PREV_PATH(), JSON.stringify({ v: PREV_VER, codes: [...PREV_SET] })) } catch (_) {} }
/* 版本升级的一次性清理：删掉历史版本的预览文件（preview.mp4 / pv6.mp4），让这些番号重新排队 */
function previewCleanupOld() {
  try {
    const root = path.join(cacheDir(), 'movies'); let n = 0
    for (const d of fs.readdirSync(root)) {
      for (const name of PREV_STALE_FILES) {
        const op = path.join(root, d, name)
        try { if (fs.existsSync(op)) { fs.unlinkSync(op); n++ } } catch (_) {}
      }
    }
    if (n) { console.log('[preview] 历史版本预览已清理 ' + n + ' 个，将按 6 段×1s 重新生成'); previewSave() }
  } catch (_) {}
}
function previewScanCodes() { const root = path.join(cacheDir(), 'movies'); const out = []; try { for (const d of fs.readdirSync(root)) { if (previewHas(d)) out.push(d) } } catch (_) {} return out }
/* ---------- 悬停预览的可用来源与「在库番号」清单 ----------
 * ⚠ 曾经这里有一条「剧照轮播」兜底（Windows 无 ffmpeg 时拿 cache/movies/<番号>/images/sampleNN.jpg
 *   轮播出 6 张 × 1 秒）—— 2026-10-13 用户明确要求**不要剧照预览**，那条路已整路删除，
 *   预览只认真视频切片：本地 ffmpeg 抽帧短片（装有 ffmpeg 时）或线上官方预览片。
 * previewScanCodes 只回「已有本地抽帧短片 pv7.mp4」的番号；
 * 线上那条路的地址清单见上面的预热器（PV_ONLINE / PVWARM）。
 * 只回「当前在库」的番号，避免几千条时把 /api/previews 响应撑大。 */
/* ---------- 悬停预览的「线上动图」来源：JavDB 官方预览片 ----------
 * 为什么需要它：用户库里可能全是 115 网盘片源（磁盘上没有文件），这时本地 ffmpeg 抽帧那条路
 *   一部都生不出来（genPreview 找不到本地文件就直接 return）。
 *   （2026-10-13 用户明确：预览只要视频切片、不要剧照轮播 —— 原「剧照兜底」已整路删除。）
 * 好在 JavDB 每部片都有官方预览片：v2/movies/<id>.preview_video_url，是 HLS + AES-128 加密，
 *   实测 m3u8 / TS 分片 / 密钥三者都带 `Access-Control-Allow-Origin: *` —— 浏览器端 hls.js
 *   可以直连拉流，**不需要服务端中转**（应用本来就内置 hls.light.min.js，含 AES 解密与 mpegts transmux）。
 * 服务端只做两件事：① 按番号解析出预览片地址（签名约 3 小时有效，缓存 15 分钟）；
 *                  ② 把 28 段 × 4 秒（整条 109 秒）的播放列表裁成「6 个切片」——
 *                     整条太长、太费流量，裁完约 24 秒，鼠标移开前端就 destroy，实际只下载播到的部分。 */
const PV_ONLINE = new Map()             // code(bare) -> { url, id, at, miss? }
const PV_ONLINE_TTL = 15 * 60 * 1000
/* 查不到的也缓存（15 分钟），否则每次鼠标划过同一张卡都要重新搜一次线上，纯浪费限频额度 */
const PV_ONLINE_MISS_TTL = 15 * 60 * 1000
const PV_ONLINE_ERR_TTL = 3 * 60 * 1000
const PV_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
function pvOnlineCached(code) {
  const key = bare(code)
  if (!key) return null
  const hit = PV_ONLINE.get(key)
  if (!hit) return null
  const ttl = hit.url ? PV_ONLINE_TTL : (hit.miss === 'err' ? PV_ONLINE_ERR_TTL : PV_ONLINE_MISS_TTL)
  return (Date.now() - hit.at < ttl) ? hit : null
}

/* ================= 悬停预览·线上地址「预热」 =================
 * 为什么必须有这一层（2026-10-13 实测定位）：
 *   服务端解析一个番号的预览片要走两步线上请求（v2/search 找 id → v2/movies 取 preview_video_url），
 *   且都过 onlineGetPaced 节流 —— 实测平均 **1.8s/个**（19 个抽样共 34s）。
 *   而用户 hover 一张海报只停一两秒：等 hover 才开始查，画面根本来不及出来，
 *   表现就是「库里有视频的番号悬停预览没生效」。缓存虽有 15 分钟 TTL，但用户不会去 hover 第二次。
 * 做法：后台把「有片源的番号」的预览地址一个个查好塞进 PV_ONLINE。用户真 hover 时
 *   /api/preview/online 命中缓存 → 毫秒级返回 → hls 立刻拉分片开播。
 * 只查地址（m3u8 头部），**不下载任何分片** —— 分片是浏览器发现场需要的那一个才拉。
 * 低负担：单任务串行、两task间 700ms、扫描进行中让路、开关关掉即停；结果落盘，重启后读回。
 * 纯在线资料（relVideo 为空 / web://）不进队列 —— 那类番号没有片子，本来就不该有预览。 */
const PV_ONLINE_WARM_FILE = () => path.join(cacheDir(), 'previews-online.json')
/* JavDB 直链带签名，实测约 3 小时有效；落盘只收 45 分钟内的（保守），读回后按「刚查的」算 TTL */
const PV_WARM_KEEP_MS = 45 * 60 * 1000
let PVWARM = { on: false, timer: null, queue: [], done: 0, miss: 0, fail: 0 }
function pvWarmSave() {
  try {
    const map = {}, now = Date.now()
    for (const [k, v] of PV_ONLINE) { if (v && v.url && now - v.at < PV_WARM_KEEP_MS) map[k] = { url: v.url, id: v.id || '' } }
    if (!Object.keys(map).length) return
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(PV_ONLINE_WARM_FILE(), JSON.stringify({ v: 1, at: now, map }))
  } catch (_) {}
}
function pvWarmLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(PV_ONLINE_WARM_FILE(), 'utf8'))
    if (!j || Date.now() - (j.at || 0) > PV_WARM_KEEP_MS) return 0
    let n = 0
    for (const k of Object.keys(j.map || {})) {
      const r = j.map[k]
      /* at 记成「现在」：对 pvOnlineCached 而言就是刚查回来的，15 分钟 TTL 正常生效 */
      if (r && r.url) { PV_ONLINE.set(k, { url: r.url, id: r.id || '', at: Date.now() }); n++ }
    }
    if (n) console.log('[preview] 线上预览地址缓存读回 ' + n + ' 条（上次预热的结果，省一轮线上查询）')
    return n
  } catch (_) { return 0 }
}
/* 待预热的番号：有片源 + 没有新鲜缓存。按入库时间倒序 —— 用户最近在看的片子先热 */
function pvWarmCodes() {
  const items = (DATA && DATA.items) || []
  const out = []
  for (const it of items) {
    if (!it || !it.code) continue
    if (it.virtual) continue
    if (!it.relVideo || /^web:\/\//i.test(it.relVideo)) continue
    const k = bare(it.code); if (!k) continue
    if (pvOnlineCached(k)) continue
    out.push({ k, code: it.code, mtime: it.mtime || 0 })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.map(x => x.code)
}
/* 启动/续跑预热。priorityCodes = 前端报来的「当前这一屏」，插到队首。 */
function pvWarmStart(priorityCodes) {
  if (!previewEnabled()) return
  const pri = (Array.isArray(priorityCodes) ? priorityCodes : []).map(c => String(c || '').trim()).filter(Boolean)
  if (PVWARM.on) {
    /* 已在跑：把优先番号插到队首，别重开一轮（重开会丢掉已排的进度） */
    if (pri.length) {
      const have = new Set(PVWARM.queue.map(c => bare(c)))
      const head = pri.filter(c => !have.has(bare(c)))
      if (head.length) PVWARM.queue = head.concat(PVWARM.queue)
    }
    return
  }
  const q = pvWarmCodes()
  if (pri.length) {
    const seen = new Set(q.map(c => bare(c)))
    PVWARM.queue = pri.filter(c => !seen.has(bare(c))).concat(q)
  } else PVWARM.queue = q
  if (!PVWARM.queue.length) return
  PVWARM.on = true; PVWARM.done = 0; PVWARM.miss = 0; PVWARM.fail = 0
  console.log('[preview] 线上预览地址预热开始：' + PVWARM.queue.length + ' 个番号（后台串行，不占用户操作）')
  pvWarmPump()
}
function pvWarmPump() {
  const step = () => {
    if (!previewEnabled()) { PVWARM.on = false; PVWARM.queue = []; pvWarmSave(); console.log('[preview] 预热停止（总开关已关）'); return }
    /* 扫描在跑就让路：扫描本身就要打线上接口刮削，两路一起打会被限频 */
    if (SCAN.running) { PVWARM.timer = setTimeout(step, 10000); return }
    const code = PVWARM.queue.shift()
    if (!code) {
      PVWARM.on = false; pvWarmSave()
      console.log('[preview] 线上预览地址预热完成：可用 ' + PVWARM.done + '，线上无预览片 ' + PVWARM.miss + '，失败 ' + PVWARM.fail)
      return
    }
    const k = bare(code)
    if (pvOnlineCached(k)) { PVWARM.timer = setTimeout(step, 50); return }
    previewOnlineClip(code).then(rec => {
      if (rec && rec.url) PVWARM.done++
      else PVWARM.miss++            // 线上确实没有这部片 / 没有预览片（已写进 PV_ONLINE 的 miss 缓存，不会再问）
    }).catch(() => { PVWARM.fail++ })
      .then(() => {
        const n = PVWARM.done + PVWARM.miss + PVWARM.fail
        /* 每 25 条落一次盘 + 每 50 条打一行进度：整库 1000+ 部要跑将近一小时，
         * 用户中途关程序是常态 —— 不落盘的话刚查好的几十条全白费。
         *（⚠ Windows 上 main.js 的 serverProc.kill() 走 TerminateProcess，进程收不到 SIGTERM，
         *  所以「退出时保存」这条路不可靠，只能靠这里的定期落盘。） */
        if (n % 25 === 0) pvWarmSave()
        if (n % 50 === 0) {
          console.log('[preview] 预热进度 ' + n + '/' + (n + PVWARM.queue.length) + '：可用 ' + PVWARM.done + '，线上无预览片 ' + PVWARM.miss + '，失败 ' + PVWARM.fail)
        }
        PVWARM.timer = setTimeout(step, 700)
      })
  }
  step()
}
async function previewOnlineClip(code) {
  const key = bare(code)
  if (!key) throw new Error('缺少番号')
  const hit = pvOnlineCached(key)
  if (hit) return hit
  /* 按番号搜一次拿线上 id：只认 number 完全同名的那条，宁可不给也不放错人的预览片 */
  const s = await onlineGetPaced('v2/search?q=' + encodeURIComponent(code) + '&type=movie&page=1')
  const list = (((s || {}).data || {}).movies) || []
  let id = ''
  for (const m of list) { if (bare(m.number || m.code) === key) { id = m.id || m.video_id || ''; break } }
  if (!id && list.length === 1) id = list[0].id || list[0].video_id || ''
  if (!id) { const rec = { url: '', id: '', at: Date.now(), miss: 'no-id' }; PV_ONLINE.set(key, rec); return rec }
  const d = await onlineGetPaced('v2/movies/' + id)
  const mv = (((d || {}).data || {}).movie) || {}
  const rec = { url: String(mv.preview_video_url || ''), id, at: Date.now(), hasImages: !!(mv.has_preview_images) }
  if (!rec.url) rec.miss = 'no-preview'
  PV_ONLINE.set(key, rec)
  return rec
}
/* 解析 m3u8 → 头部标签 + 分片表（每片带 EXTINF 时长、原始 media sequence）。
 * 返回里多带三样，裁剪时必须用：
 *   mediaSeq —— 原始 #EXT-X-MEDIA-SEQUENCE（实测上游给 1，不是 0）
 *   keyLine / keyHasIV —— 原始 #EXT-X-KEY 行、以及它有没有显式 IV 属性
 * #EXT-X-MEDIA-SEQUENCE / #EXT-X-ENDLIST / #EXT-X-DISCONTINUITY 按裁剪结果重写，先丢掉。 */
function previewParseM3U8(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const head = []
  const segs = []
  let inf = '', keyLine = '', keyHasIV = false, mediaSeq = 0, idx = -1
  for (const t of lines) {
    if (t.startsWith('#')) {
      if (/^#EXTINF:/i.test(t)) { inf = t; continue }
      if (/^#EXT-X-KEY:/i.test(t)) {
        keyLine = t; keyHasIV = /[,]\s*IV\s*=/i.test(t) || /^\s*#EXT-X-KEY:\s*IV\s*=/i.test(t)
        if (inf) continue
        head.push(t); continue
      }
      if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(t)) { mediaSeq = parseInt(t.split(':')[1], 10) || 0; continue }
      if (/^#EXT-X-(ENDLIST|DISCONTINUITY)/i.test(t)) continue
      if (inf) continue                       // 夹在段与段之间的标签
      head.push(t); continue
    }
    idx++
    const dur = parseFloat(((inf.match(/:([\d.]+)/) || [])[1]) || '') || 0
    segs.push({ inf: inf || '#EXTINF:4.000,', dur, uri: t, sn: mediaSeq + idx })
    inf = ''
  }
  return { head, segs, keyLine, keyHasIV, mediaSeq }
}
/* media sequence → 128 位大端十六进制（IV 的写法就是 0x + 32 个 hex） */
function hex128(n) {
  const h = (Math.max(0, Math.floor(Number(n) || 0)) % 4294967296).toString(16)
  return '00000000000000000000000000000000'.slice(0, 32 - h.length) + h
}
/* 裁剪 m3u8：保留头部标签，从全部切片里均匀挑 n 个，末尾补 ENDLIST。
 * 分片与密钥都是绝对地址、且带 `Access-Control-Allow-Origin: *`，浏览器端 hls.js 直连即可。
 *
 * ⚠⚠ 有个不能省的坑（2026-10-13 实测确认）：上游 #EXT-X-KEY **没写 IV 属性**，而分片是 AES-128
 *   加密的。按 RFC 8216，KEY 不带 IV 时播放器用「分片的 media sequence」当 IV —— 实测把 sn 当 IV
 *   解出来的首块是 `47 40 00 10 00 00 b0 0d … 00 00 01 ef`（标准 PAT 包头，program_number=1、
 *   PMT PID=0xEFFF），换成其它 IV 首块字节就变成逐片不同的乱码。
 *   而我的裁剪**必然**要重新编号（挑的是第 1/6/11/17/22/27 片，序号不再连续），
 *   一旦沿用「按新序号推 IV」的老规矩，每片都会解成乱码、hls.js 直接 fatal。
 *   → 所以这里给**每个切片**单独补一条带 `IV=0x<原始 sn>` 的 #EXT-X-KEY（重复 KEY 标签是合法的，
 *     按 RFC「生效到下一个 KEY 标签为止」）。这样无论怎么重编号都能正确解密。
 *   返回 { list, marks, total }：marks = 每个切片在**裁剪后**播放列表里的起始秒数。 */
function previewTrimM3U8(text, n) {
  const { head, segs, keyLine, keyHasIV } = previewParseM3U8(text)
  if (!segs.length) return { list: '', marks: [], total: 0 }
  /* 末尾常有「残段」：实测 28 段的最后一段 EXTINF 只有 1.035s、体积 384 字节（等于空片），
   * 挑到它就是一帧黑屏。按最长分片的一半为界剔除，池子太小时就不剔。 */
  const maxDur = Math.max.apply(null, segs.map(s => s.dur || 0)) || 0
  let pool = segs
  if (maxDur > 0) { const keep = segs.filter(s => (s.dur || 0) >= maxDur * 0.5); if (keep.length >= 2) pool = keep }
  let pick = pool
  if (n > 0 && n < pool.length) {
    pick = []
    /* n=1 要单独处理：(n-1) 做分母会算出 NaN，一片都挑不出来 */
    if (n === 1) pick = [pool[Math.floor((pool.length - 1) / 2)]]
    else {
      const seen = new Set()
      for (let i = 0; i < n; i++) {
        const s = pool[Math.round(i * (pool.length - 1) / (n - 1))]
        if (s && !seen.has(s.uri)) { seen.add(s.uri); pick.push(s) }
      }
    }
  }
  const marks = []
  let acc = 0
  for (const s of pick) { marks.push(Math.round(acc * 1000) / 1000); acc += (s.dur || 0) }
  /* AES-128 且原始 KEY 没写 IV → 头部那条裸 KEY 收起来，改成逐片带 IV 的版本（见上面注释） */
  const needPerSegIV = !!keyLine && !keyHasIV && /METHOD\s*=\s*AES-128/i.test(keyLine)
  const out = head.filter(x => !(needPerSegIV && x === keyLine))
  out.push('#EXT-X-MEDIA-SEQUENCE:0')
  for (const s of pick) {
    if (needPerSegIV) out.push(keyLine + ',IV=0x' + hex128(s.sn))
    out.push(s.inf)
    out.push(s.uri)
  }
  out.push('#EXT-X-ENDLIST')
  return { list: out.join('\n'), marks, total: Math.round(acc * 1000) / 1000 }
}
/* 裁剪结果缓存：播放列表里嵌的签名分片地址约 3 小时有效，这里只留 10 分钟，
 * 既避免每次悬停都去上游取一遍，也远在签名过期之前。 */
const PV_PL = new Map()                 // code|n -> { list, marks, total, at }
const PV_PL_TTL = 10 * 60 * 1000
async function previewOnlinePlaylist(code, n) {
  const key = bare(code)
  if (!key) throw new Error('缺少番号')
  const ck = key + '|' + n
  const hit = PV_PL.get(ck)
  if (hit && Date.now() - hit.at < PV_PL_TTL) return hit
  const clip = await previewOnlineClip(code)
  if (!clip || !clip.url) {
    const e = new Error(clip && clip.miss === 'no-id' ? '线上没有这部片（番号对不上，或线上还没收录）' : '这部片线上没有预览片')
    e.pvMiss = true
    throw e
  }
  let lastErr = null
  for (let i = 0; i < 2; i++) {
    try {
      const rs = await fetch(clip.url, { headers: { 'User-Agent': PV_UA, Accept: '*/*' } })
      if (!rs.ok) throw new Error('预览片播放列表取回 HTTP ' + rs.status)
      const t = previewTrimM3U8(await rs.text(), n)
      if (!t.list) throw new Error('预览片播放列表为空')
      const rec = { list: t.list, marks: t.marks, total: t.total, id: clip.id, at: Date.now() }
      PV_PL.set(ck, rec)
      return rec
    } catch (e) {
      lastErr = e
      /* 首次失败重试一次：boot 期头像回填会打满 socket，实测偶发 `fetch failed`（瞬时） */
      if (i === 0) await new Promise(r => setTimeout(r, 500))
    }
  }
  throw lastErr || new Error('取预览片失败')
}
/* 总开关：设置 → 偏好「生成海报悬停预览」（uiPrefs.hpreview，值是字符串 '0'/'1'）。没设置过 = 开。
 * 关掉后只是「不再生成新的」，已生成的 pv6.mp4 原地保留 —— 用户重新打开开关立刻恢复显示。 */
function previewEnabled() {
  try { const u = CFG && CFG.uiPrefs; if (!u) return true; const v = u.hpreview; return !(v === '0' || v === 0 || v === 'false') } catch (_) { return true }
}

/* ---------- 抽帧输入源：本地文件 / 115 网盘（2026-10-13 新增 115 那条） ----------
 * 115 为什么走**本机** /media/ 这一跳、而不是把 CDN 直链直接交给 ffmpeg：
 *   · 服务端这一跳已经带 Cookie 处理 302 转发、Range 透传、风控节流与罚则退避，
 *     直链逻辑只有这一处，不必在抽帧链路里再复刻一遍签名与过期处理；
 *   · ffmpeg 只 Range 读它真要的那几段（每段 1 秒），**6.8GB 的 4K 片也不用整部下载**
 *     （实测：ffprobe 取时长 2s、单段抽帧 3s、一部 6 段约 20s）；
 *   · CDN 直链带签名、几小时就过期，**绝不能存下来复用** —— 每部现取现用。
 * ⚠ 硬依赖 ffmpeg 的 --enable-network：resources\app\ffmpeg\ 放的是静态版（含 http/https）。
 *   若被换回旧的 --disable-network 构建，会直接报 "Protocol not found"。
 * ⚠ 115 抽帧**单独一个开关**（uiPrefs.pvNet，默认关）：它消耗 115 流量（每部约 20MB），
 *   不能跟着「悬停预览」总开关默认打开。 */
function encMediaRel(rel) {
  return encodeURI(String(rel)).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
function previewNetEnabled() {
  try {
    const u = CFG && CFG.uiPrefs
    if (!u) return false
    const v = u.pvNet
    return v === '1' || v === 1 || v === true || v === 'true'
  } catch (_) { return false }
}
function previewSource(it) {
  const rel = String((it && it.relVideo) || '')
  if (!rel || /^web:\/\//i.test(rel)) return null
  if (v115Rel(rel)) {
    if (!previewNetEnabled()) return null      // 耗 115 流量，必须用户显式开
    if (!v115PickOf(rel)) return null          // 没有 pickcode 就取不到直链
    return 'http://127.0.0.1:' + PORT + '/media/' + encMediaRel(rel)
  }
  /* WebDAV / 光鸭暂不放行：它们走 davServe 那套代理，行为还没在抽帧这条路上验证过。
   * ⚠ 判据用 davRel()：多账号前缀是 'dav@2:/' / 'gy@2:/'，老正则 /^(dav|gy):/ 会漏。 */
  if (davRel(rel)) return null
  /* 本地媒体库：必须磁盘上真实存在、读得到 */
  let fp = null
  try { fp = safeMediaPath(rel) } catch (_) { fp = null }
  return (fp && fs.existsSync(fp)) ? fp : null
}
/* 一次运行最多抽几部 115 片源：每部约读 20MB、且要过 115 风控，默认保守。
 * 跑满就停，下次启动/重扫再续 —— 别让它一口气把整库 1300+ 部撞一遍。
 * 可用 JP_PVNET_MAX 环境变量临时收放（调试时设 1 只跑一部验证用）。 */
const PV_NET_MAX_PER_RUN = Math.max(1, parseInt(process.env.JP_PVNET_MAX || '30', 10) || 30)

/* ---------- ffmpeg / ffprobe 二进制定位 ----------
 * macOS 上靠 Homebrew 装进 PATH；Windows 上一般没有 → 整条抽帧链路（悬停预览、进度条缩略图）
 * 静默失效，日志只有一行「未检测到 ffmpeg/ffprobe」。这里补上可配置的定位：
 *   ① 环境变量 JP_FFMPEG / JP_FFPROBE（目录或 exe 全路径都认）
 *   ② 设置里手填的 uiPrefs.ffmpegPath
 *   ③ 程序目录下的 ffmpeg\ —— 即 resources\app\ffmpeg\ffmpeg.exe（便携版放这里最省事）
 *   ④ 都找不到就交回裸名字走 PATH（找不到会 ENOENT，由 FFMPEG_OK 三态兜住，不会反复空转）
 * 结果按名字缓存，找到与否都只 stat 几次。 */
const FF_BIN_CACHE = {}
function ffBin(name) {
  if (FF_BIN_CACHE[name]) return FF_BIN_CACHE[name]
  const ext = process.platform === 'win32' ? '.exe' : ''
  const inDir = d => { try { const p = path.join(d, name + ext); return fs.existsSync(p) ? p : '' } catch (_) { return '' } }
  const probe = v => {
    const s = String(v || '').trim()
    if (!s) return ''
    let st = null
    try { st = fs.statSync(s) } catch (_) { return '' }
    if (st.isDirectory()) return inDir(s)
    /* 给的是文件：basename 同名就直接用，否则退到同目录里找 */
    return path.basename(s).replace(/\.[^.]*$/, '').toLowerCase() === name ? s : inDir(path.dirname(s))
  }
  let hit = probe(process.env['JP_' + name.toUpperCase()])
  /* 两个二进制永远同目录：用户只设了 JP_FFMPEG 时，ffprobe 也从那儿推导，
   * 否则 FFMPEG_OK = ff && fp 恒为 false，抽帧链路照样起不来（踩过）。 */
  if (!hit && name !== 'ffmpeg') hit = probe(process.env.JP_FFMPEG)
  if (!hit) hit = probe((CFG && CFG.uiPrefs || {}).ffmpegPath)
  if (!hit) { const p = path.join(path.dirname(UI_ROOT), 'ffmpeg', name + ext); if (fs.existsSync(p)) hit = p }
  FF_BIN_CACHE[name] = hit || name
  return FF_BIN_CACHE[name]
}
/* ⚠️ ffmpeg/ffprobe 可用性探测（2026-10-10 加，治「播放卡住」）。
 * 现象：本机没装 ffmpeg，genPreview 对每部片子 execFile('ffprobe') 立刻 ENOENT，
 *   但那 1279 次进程启动**每次都在抢 CloudDrive/FUSE 的 I/O 通道**，
 *   而每部失败后还要 setTimeout 2000 再排下一部 → 空转约 43 分钟，
 *   表现就是「看着视频却卡住不动」，还把日志刷成几百条「取时长失败」。
 * 现在：FFMPEG_OK 三态（null=还没探 / false=确认没有 / true=可用）。
 *   探到 false 就整条队列不启动，并打一行明确原因，不做任何无用的进程启动。*/
let FFMPEG_OK = null
let FFMPEG_PROBING = false
function probeFfmpeg() {
  if (FFMPEG_OK !== null) return FFMPEG_OK
  if (FFMPEG_PROBING) return null            // 已在探，别重复 fork
  FFMPEG_PROBING = true
  let ff = false, fp = false, pending = 2
  const done = () => {
    if (--pending > 0) return
    FFMPEG_OK = ff && fp
    FFMPEG_PROBING = false
    if (FFMPEG_OK) {
      console.log('[preview] ffmpeg/ffprobe 可用，开始生成预览')
      /* 探测是异步的：调用 schedulePreviews 的那一次已经 return 了，这里补一次，
       * 否则「启动瞬间探测还没回」就永远不再入队，预览永远不生成。*/
      try { schedulePreviews() } catch (_) {}
    } else {
      console.log('[preview] 未检测到 ffmpeg/ffprobe：跳过「本地抽帧短片」，悬停预览走「线上官方预览片」这条（真视频切片、按需才拉，不受影响）。')
      console.log('[preview] 想让本地片源也生成真实画面短片：把 ffmpeg.exe/ffprobe.exe 放进 resources\\app\\ffmpeg\\，或设 JP_FFMPEG 环境变量指向它，再重启程序。')
    }
  }
  execFile(ffBin('ffmpeg'), ['-version'], { timeout: 8000 }, err => { ff = !err; done() })
  execFile(ffBin('ffprobe'), ['-version'], { timeout: 8000 }, err => { fp = !err; done() })
  return null   // 还在探，本次调用方先跳过
}

function enqueuePreview(code) {
  if (!previewEnabled()) return
  code = bare(code); if (!code) return
  if (previewHas(code)) { PREV_SET.add(code); return }
  if (PREV_QUEUE.indexOf(code) >= 0) return
  PREV_QUEUE.push(code); if (!PREV_RUN) hprvPump()
}
function schedulePreviews() {
  if (!previewEnabled()) return
  /* ⚠ 线上预览地址预热必须放在下面的 FFMPEG 探测**之前**：两者互不相干 ——
   * Windows 上一般没有 ffmpeg（本地抽帧那条路整个停摆），但「线上官方预览片」这条路照样得走，
   * 而它才是 Windows 上唯一能出画面的悬停预览来源。放后面会被 FFMPEG_OK!==true 直接 return 挡掉。 */
  try { pvWarmStart() } catch (_) {}
  /* 缺 ffmpeg 就不排：一部下都别试，省得白抢 I/O 还刷日志 */
  if (FFMPEG_OK !== true) { probeFfmpeg(); return }
  const items = (DATA && DATA.items) || []
  /* 入队判据统一交给 previewSource()，它一次兜住三种情况：
   *   · 本地媒体库文件 → 磁盘上真存在才收；
   *   · 115 网盘条目   → 开关（uiPrefs.pvNet）开着 + 有 pickcode 才收，输入给的是本机代理 URL；
   *   · web:// / 光鸭 / WebDAV / 没片源 → 一律不收。
   * ⚠️ 这里和前端 hasLocalVideo / pvWarmCodes 的口径**故意不同**，别去「统一」：
   *   那两个判「能不能播」（115 也算有片源，该去拉线上预览片）；这里判「能不能抽到帧」。
   *   曾经这里只判 `!web://`，装了 ffmpeg 后会把整库 115 全排进去空转 44 分钟、产出为零。
   * ⚠️ 115 那条**每次运行限量**（PV_NET_MAX_PER_RUN）：每部约读 20MB 且要过 115 风控，
   *   一口气把整库 1300+ 部排进去既伤流量又容易触发风控。跑满就停，下次启动/重扫再续。 */
  let netQueued = 0
  for (const it of items) {
    if (!it || it.virtual) continue
    const code = bare(it.code)
    if (!code || previewHas(code) || PREV_SET.has(code)) continue   // 已经有片子了，不占配额
    const src = previewSource(it)
    if (!src) continue
    if (v115Rel(it.relVideo)) {
      if (netQueued >= PV_NET_MAX_PER_RUN) continue
      netQueued++
    }
    enqueuePreview(code)
  }
  if (netQueued) console.log('[preview] 本轮排入 115 云盘片源 ' + netQueued + ' 部（单次上限 ' + PV_NET_MAX_PER_RUN + '，每部约读 20MB）')
}
function hprvPump() {
  if (PREV_RUN) return
  PREV_RUN = true
  const step = () => {
    if (!PREV_QUEUE.length) { PREV_RUN = false; return }
    /* 开关关掉 → 丢掉未开始的队列（正在跑的那部让它跑完，避免留半成品文件） */
    if (!previewEnabled()) { PREV_QUEUE = []; PREV_RUN = false; console.log('[preview] 开关已关闭，停止排队生成'); return }
    /* ⚠️ 这里也要挡一道：schedulePreviews 探测未完成时已 return，但队列可能是在
       探测生效前入好的（或用户中途装的 ffmpeg）。确认缺二进制就别再空转了。 */
    if (FFMPEG_OK === false) { PREV_QUEUE = []; PREV_RUN = false; console.log('[preview] ffmpeg 不可用，已清空预览队列（不影响播放）'); return }
    if (FFMPEG_OK === null) { setTimeout(() => { if (FFMPEG_OK === true) step(); else { PREV_QUEUE = []; PREV_RUN = false } }, 3000); return }
    if (SCAN.running) { setTimeout(step, 15000); return }
    const code = PREV_QUEUE.shift()
    if (previewHas(code) || PREV_SET.has(code)) { setTimeout(step, 300); return }
    genPreview(code).then(() => setTimeout(step, 2000)).catch(() => setTimeout(step, 2000))
  }
  step()
}
/* 6 个采样起点：跳过片头（可能黑场/Logo），铺满整部影片，末尾也留余量避免抽到片尾字幕。
 * 片子太短放不下 6 段时按可容纳数量降段（至少 1 段）。 */
function hprvStarts(d) {
  const lo = Math.max(0.8, Math.min(d * 0.02, 30))
  const hi = Math.max(lo, d - PREV_SEG - Math.min(30, d * 0.02))
  const n = Math.max(1, Math.min(PREV_SEGS, Math.floor((hi - lo) / PREV_SEG)))
  if (n === 1) return [(lo + hi) / 2]
  const out = []
  for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * i / (n - 1))
  return out
}
/* 跑一条 ffmpeg，macOS 没有 nice 时自动回退裸 ffmpeg（args 必须原样传下去） */
function hprvRun(args, to, cb) {
  const attempt = useNice => {
    const cmd = useNice ? 'nice' : ffBin('ffmpeg')
    const a = useNice ? ['-n', '15', ffBin('ffmpeg')].concat(args) : args
    execFile(cmd, a, { timeout: to, killSignal: 'SIGKILL' }, err => {
      if (err && err.code === 'ENOENT' && useNice) return attempt(false)
      cb(err || null)
    })
  }
  attempt(true)
}
function genPreview(code) {
  return new Promise(res => {
    const it = (DATA && DATA.items || []).find(x => bare(x.code) === code && x.relVideo && !/^web:\/\//i.test(x.relVideo))
    if (!it) return res()
    /* previewSource 返回：本地磁盘路径 / 115 的本机代理 URL / null（抽不了就别白启动进程） */
    const video = previewSource(it)
    if (!video) return res()
    const viaNet = v115Rel(it.relVideo)
    /* ⚠️ starts 必须提到 done() 也能看见的外层（done 里要用 starts.length 打日志）。
     * 2026-10-13 之前它声明在 startBuild() 内部，于是**第一次真正生成成功时**
     * console.log 抛 ReferenceError → 紧跟其后的 res() 不执行 → Promise 永不 resolve
     * → hprvPump 的 then 不触发 → **抽帧队列永久卡死**。
     * 以前从没成功过（没 ffmpeg、也没有本地文件可抽）所以这个雷一直没响。 */
    let starts = []
    const dir = path.join(cacheDir(), 'movies', code)
    const out = path.join(dir, PREV_FILE)
    const tmp = path.join(dir, PREV_TMP)
    const done = ok => {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
      if (ok && fs.existsSync(out) && fs.statSync(out).size >= 8000) {
        PREV_SET.add(code); previewSave()
        console.log('[preview] ✓ ' + code + ' ' + starts.length + ' 段×' + PREV_SEG + 's 已生成 (' + fs.statSync(out).size + 'B)' + (viaNet ? ' [115 代理]' : ''))
      } else { try { fs.unlinkSync(out) } catch (_) {} }
      res()
    }
    execFile(ffBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', video], { timeout: 30000 }, (e, so) => {
      const dur = parseFloat(String(so || ''))
      if (!e && isFinite(dur) && dur > PREV_SEG) return startBuild(dur)
      console.log('[preview] ✗ ' + code + ' 取时长失败/过短，跳过')
      done(false)
    })

    function startBuild(dur) {
      starts = hprvStarts(dur)
      try { fs.mkdirSync(tmp, { recursive: true }) } catch (_) {}
      const segs = []
      const step = i => {
        if (i >= starts.length) return concatAll()
        const seg = path.join(tmp, 's' + i + '.mp4')
        /* -ss 放在 -i 前 = 输入端快速 seek（不必从 0 解码），长影片尤其关键 */
        const args = ['-y', '-ss', starts[i].toFixed(1), '-i', video, '-t', String(PREV_SEG),
          '-an', '-vf', 'scale=-2:480', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p', '-threads', '1', seg]
        hprvRun(args, 120000, err => {
          let bad = !!err
          try { bad = bad || !fs.existsSync(seg) || fs.statSync(seg).size < 1000 } catch (_) { bad = true }
          if (bad) { console.log('[preview] ✗ ' + code + ' 第 ' + (i + 1) + ' 段失败 @' + starts[i].toFixed(1) + 's'); return done(false) }
          segs.push(seg); step(i + 1)
        })
      }
      /* concat demuxer：6 段编码参数完全一致，可 stream copy 拼接，无需二次编码 */
      function concatAll() {
        const list = path.join(tmp, 'list.txt')
        try {
          fs.writeFileSync(list, segs.map(s => "file '" + s.split("'").join("'\\''") + "'").join('\n'))
        } catch (_) { return done(false) }
        execFile(ffBin('ffmpeg'), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out],
          { timeout: 120000, killSignal: 'SIGKILL' }, err => {
            if (err) { console.log('[preview] ✗ ' + code + ' 拼接失败: ' + String(err.message).slice(0, 120)) }
            done(!err)
          })
      }
      step(0)
    }
  })
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
/* ---------- 在线播放源（详情页「在线播放」区块的可配置站点列表） ----------
 * 旧版 playLinksOf 在前端写死 4 项；现抽到服务端，设置页可增删/排序/开关，加站不用改代码+部署。
 * 每条：{ n:名称, u:URL模板(含{CODE}/{lcode}占位，act 类留空), d:说明, act:可选(missav=应用内HLS中转), on:是否显示 } */
const PLAYLINES_DEFAULT = [
  { n: '在线播放', act: 'missav', u: '', d: '解析 MissAV 免翻线路，应用内直接播放（视频经 NAS 中转国内 CDN）' },
  { n: 'MissAV 搜索', u: 'https://missav.ai/ja/search/{CODE}', d: 'MissAV 站内搜索（新窗口打开）' },
  { n: 'Jable', u: 'https://jable.tv/videos/{lcode}/', d: 'Jable 播放页（通常为有码片）' },
  { n: 'SupJav', u: 'https://supjav.com/?s={CODE}', d: 'SupJav 聚合搜索' },
  { n: 'Xeden', u: 'https://xeden.net/search?q={CODE}', d: 'Xeden 搜索（URL 模板可改）' },
  { n: 'Omgjav', u: 'https://omgjav.com/search?q={CODE}', d: 'Omgjav 搜索' },
  { n: 'MythAV', u: 'https://mythav.org/?s={CODE}', d: 'MythAV 搜索（WordPress）' },
  { n: 'Manko', u: 'https://manko.fun/search?q={CODE}', d: 'Manko 搜索' },
  { n: 'JavSB', u: 'https://jav.sb/en/search?q={CODE}', d: 'JavSB 搜索（反爬，浏览器可开）' },
  { n: 'NJav', u: 'https://www.njav.com/en/search?q={CODE}', d: 'NJav 搜索' },
  { n: 'MissAV(t41)', u: 'https://missavt41.com/ja/search/{CODE}', d: 'MissAV 镜像 t41 搜索' }
]
function playLinesCfg() {
  const arr = (CFG.playlines && Array.isArray(CFG.playlines)) ? CFG.playlines : null
  const base = (arr && arr.length) ? arr : PLAYLINES_DEFAULT
  // 归一化：旧配置里 act=missav 且名为旧名的，统一改名为「在线播放」（无侵入，用户手动改名不受影响）
  return base.map(x => (x && x.act === 'missav' && x.n === 'MissAV 在线') ? Object.assign({}, x, { n: '在线播放' }) : x)
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
/* ---------- 线上请求节流 + 自适应限速（2026-10-03：名册 2.5 万人全量回填） ----------
 * 背景：给名册里 2.5 万个女优查代号，要对 JavDB 打十几万次请求。固定间隔不好使 ——
 *   打太快 → 被限流（表现为超时/假失败，且失败会污染成 miss）；打太慢 → 要跑一整天。
 * 所以做成**自适应**：连续成功 15 次就把间隔 ×0.85（下限 650ms）；任何失败立刻 ×2.2 并把窗口推后，
 * 之后慢慢爬回来。再叠加 ±25% 抖动，避免固定节奏被识别成机器流量。
 * 只在回填任务在跑时生效（RATE.on），平时看片/刮削的交互请求完全不受影响。 */
const RATE = { min: 650, max: 60000, gap: 1100, okStreak: 0, next: 0, on: false, queue: Promise.resolve(), backoffs: 0, reqs: 0 }
const rateWait = (ms) => new Promise(r => setTimeout(r, ms))
function rateSlot() {
  const S = RATE
  if (!S.on) return Promise.resolve()
  const run = S.queue.then(async () => {
    const wait = S.next - Date.now()
    if (wait > 0) await rateWait(wait + Math.floor((Math.random() - 0.5) * S.gap * 0.5))
    S.next = Date.now() + S.gap
  })
  S.queue = run.catch(() => {})
  return run
}
function rateOk() { const S = RATE; S.okStreak++; if (S.okStreak >= 15) { S.okStreak = 0; S.gap = Math.max(S.min, Math.round(S.gap * 0.85)) } }
function rateBad() { const S = RATE; S.okStreak = 0; S.gap = Math.min(S.max, Math.round(S.gap * 2.2) + 400); S.next = Date.now() + S.gap; S.backoffs++ }
/* 回填专用：排队 + 成功/失败反馈到限速器（不用ban的东西"线上未启用"不算被打） */
async function onlineGetPaced(rel, opt) {
  await rateSlot()
  try { const j = await onlineGet(rel, opt); rateOk(); RATE.reqs++; return j }
  catch (e) { if (!/线上数据源未启用/.test(String((e && e.message) || ''))) rateBad(); throw e }
}
let JDB_LINE_OK = ''                                // 上次成功的线路优先复用
/* 最近一次线路探测结果（三条线路各探一次，慢且限频，所以只探一次、缓存复用）。
 * 订阅页 GET /api/subscriptions 不发探测请求，但要能回答「到底通不通」——以前它只回
 * enabled/lines/active（没有 reachable/probe），前端 chip 就永远显示「不通」（假阴性）。 */
let JDB_PROBE = { at: 0, probe: [], reachable: false, error: '' }
async function onlineGet(rel, { timeout = 20000, raw = false, tries = 3 } = {}) {
  const c = onlineCfg()
  if (!c.enabled) throw new Error('线上数据源未启用（设置 → 订阅 里开启）')
  const order = (JDB_LINE_OK && c.lines.includes(JDB_LINE_OK))
    ? [JDB_LINE_OK].concat(c.lines.filter(x => x !== JDB_LINE_OK)) : c.lines.slice()
  let lastErr = null
  const errs = []                                    // 每条线路的失败原因都留下，报错不再只显示最后一条
  for (const base of order.slice(0, Math.max(1, Math.min(tries, order.length)))) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      /* JavDB 国内直连线路，固定直连不走代理（用户确认不经代理） */
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
    } catch (e) { lastErr = e; errs.push(e && e.message ? e.message : String(e)) } finally { clearTimeout(timer) }
  }
  throw (errs.length ? new Error(errs.join('；')) : (lastErr || new Error('线上线路均不可用')))
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
  /* JavDB 图床（tp.spfcas.com 等）国内直连即通，固定直连不走代理 */
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
/* 片假名→平假名（比对用）；「姓+名」拆分：新井リマ → ['新井','リマ']（名部必须全是假名）；
 * 姓提取：开头连续非假名段（新井莉麻 → 新井 / 兒玉七海 → 兒玉 / 坂道美琉 → 坂道） */
const onKana = s => String(s || '').replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
const onNmSplit = s => { const m = String(s || '').match(/^([^\u3040-\u30ff]+)([\u3040-\u30ff]+)$/); return m ? [m[1], m[2]] : null }
const onSurOf = s => { const m = String(s || '').match(/^([^\u3040-\u30ff]+)/); return m ? m[1] : '' }
async function onlineActorFind(name, { fallback = false } = {}) {
  const n = onNorm(name)
  if (!n) return null
  const j = await onlineGet('v2/search?q=' + encodeURIComponent(name) + '&type=actor&page=1')
  const list = ((j || {}).data || {}).actors || []
  for (const a of list) {
    const names = [a.name, a.name_zht, a.other_name].filter(Boolean).join(',')
    for (const x of String(names).split(',')) if (x && onNorm(x) === n) return a
  }
  /* ⚠ 2026-10-13：默认**不再**兜底取 list[0]。名册间隔采样 25 人里有 4 人搜不到精确同名
   * （占有效结果 21%），兜底会把「松井優子」变成「篠田優」（2310 部）、「七ツ森りり」变成
   * 「七森莉莉」（160 部）—— 界面于是把**另一个人的全部作品**当成她列出来。
   * 锁人一律用 onlineActorExact（同名 → 姓同+名部=别名 → 详情全量别名+异体字，三步）；
   * 确实需要「宁可错也别空手」的场景请显式传 { fallback: true }。 */
  return fallback ? (list[0] || null) : null
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
  /* 番号已是 mdc 式基础码（如 GOJU-317 / GL-014），无 -U / -cdN 后缀，无需再退回基础码。 */
  /* 后缀码（破解 -U / 碟片 -cdN）在原站可能只有基础码条目：先试全码，搜不到再退回基础码。
   * 例如 GOJU-317-U → 退回 GOJU-317；GL-014-cd2 → 退回 GL-014。避免正确识别的后缀码直接 404。 */
  const baseM = q.match(/^([A-Z0-9]{2,10})-(\d{2,7})(-U|-CD\d+)+$/i)
  if (baseM) terms.push(baseM[1] + '-' + baseM[2])
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
async function boardLatest(sortBy, page, type, filter) {
  const sb = BOARD_SORTS[sortBy] ? sortBy : 'update'
  const tp = boardTypeCode(type)
  /* JavDB app「影片」页的筛选 chips：/latest 实测只认 can_play（可播放）/ subtitle（含字幕），
   * magnets / single 传了会被静默忽略（返回与 all 相同），前端只出真正生效的选项 */
  const fl = ['can_play', 'subtitle'].includes(String(filter || '')) ? String(filter) : ''
  const pg = Math.max(1, page || 1)
  const j = await onlineGet('v1/movies/latest?limit=24&page=' + pg + '&sort_by=' + sb + '&type=' + tp + (fl ? '&filter_by=' + fl : ''))
  const ms = (((j || {}).data || {}).movies) || []
  return { sort: sb, type: tp, filter: fl, page: pg, movies: ms.map(onlineMovie) }
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
/* 这个请求是不是「从本机发出来的」。
 * ⚠ 绝对不能拿 Host 头来判断！Host 是客户端随便填的字符串 —— 局域网里任何人发一个
 *   `Host: localhost` 就能冒充本机，跳过访问口令，把 /api/* /media/* /cache/* /thumb/* 全部拿到手。
 * 只认 TCP 层的对端地址（remoteAddress），那是内核填的、伪造不了。 */
function isLocalReq(req) {
  try {
    const a = String((req.socket && (req.socket.remoteAddress || req.connection && req.connection.remoteAddress)) || '')
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  } catch (_) { return false }
}
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

/* ================= 网盘死链检测（2026-10-15） =================
 * 需求：库里躺着上千部网盘片，分享失效 / 文件被删后条目还在，点开才发现看不了。
 *
 * ⚠ 风控是这里的头号约束，所以**绝不对每个文件单独发请求**：
 *   ① 本地文件 —— fs.existsSync，零请求、零风险。
 *   ② 网盘（光鸭 / WebDAV）—— 按「要列的目录」聚合，**一个目录只列一次**。
 *      光鸭实测是一部片一个目录（1050 部散在 996 个目录），但它们的父目录是同一个
 *      （gy:/测试/KIMR-006/xxx.mp4 → 父目录都挂在 gy:/测试 下）→ 列 1 次就能验完近千部。
 *      判据：路径深度 ≥2 时验「所在目录还在不在」；深度 1（文件直接在根）时验文件名。
 *   ③ 115 —— 没有目录 id 可用，只能按 pickcode 取直链；条目数超过 DL_115_MAX 就跳过不去撞风控。
 * 全程只列目录、不下载任何字节，也不逐个取直链（get_res_download_url 每次都算风控配额）。 */
const DL_FILE = path.join(UI_ROOT, 'deadlink.json')
const DL_115_MAX = 60            // 115 逐个取直链的上限
let DL = { running: false, at: 0, total: 0, done: 0, dead: [], err: '', cancel: false, note: '' }
try {
  const d = JSON.parse(fs.readFileSync(DL_FILE, 'utf8'))
  if (d && Array.isArray(d.dead)) DL.at = d.at || 0, DL.dead = d.dead, DL.note = d.note || ''
} catch (_) {}
function dlSave() {
  const t = DL_FILE + '.tmp'
  try { fs.writeFileSync(t, JSON.stringify({ at: DL.at, dead: DL.dead, note: DL.note })); fs.renameSync(t, DL_FILE) }
  catch (e) { console.error('[deadlink] 写入失败', e.message) }
}
const dlLabel = rel => {
  if (v115Rel(rel)) return '115'
  const sp = davSplitRel(rel)
  if (!sp) return '本地'
  return (sp.kind === 'guangya' ? '光鸭' : 'WebDAV') + (sp.n > 1 ? '（账号 ' + sp.n + '）' : '')
}
async function dlScan() {
  if (DL.running) return { ok: false, error: '已经在检测中了' }
  DL.running = true; DL.cancel = false; DL.err = ''; DL.dead = []; DL.done = 0; DL.note = ''
  const items = (DATA && Array.isArray(DATA.items) ? DATA.items : []).filter(x => String(x.relVideo || ''))
  DL.total = items.length
  const dead = []
  /* ① 本地：零请求 */
  const netItems = []
  for (const it of items) {
    const rel = String(it.relVideo || '')
    if (v115Rel(rel) || davRel(rel)) { netItems.push(it); continue }
    if (/^web:\/\//i.test(rel)) continue              // 纯线上条目没有本地文件可验
    let fp = null
    try { fp = safeMediaPath(rel) } catch (_) { fp = null }
    if (!fp || !fs.existsSync(fp)) dead.push({ code: it.code || '', rel, src: '本地', why: '文件已不在磁盘上' })
  }
  DL.done += items.length - netItems.length
  /* ② 网盘：按「要列的目录」聚合 */
  const groups = new Map()
  const w115 = []
  for (const it of netItems) {
    const rel = String(it.relVideo || '')
    if (v115Rel(rel)) { w115.push(it); continue }
    const sp = davSplitRel(rel)
    if (!sp) continue
    const segs = String(sp.p || '').split('/').filter(Boolean)
    if (!segs.length) continue
    /* 深度 ≥2：验「所在目录」在不在（光鸭一部片一个目录，验目录即验片子）；
       深度 1：文件直接挂在根下，只能验文件名。 */
    const wantDir = segs.length >= 2
    const listDir = wantDir ? segs.slice(0, -2).join('/') : ''
    const name = wantDir ? segs[segs.length - 2] : segs[0]
    if (!name) continue
    const k = sp.kind + '|' + sp.n + '|' + listDir
    let g = groups.get(k)
    if (!g) { g = { kind: sp.kind, n: sp.n, dir: listDir, checks: [] }; groups.set(k, g) }
    g.checks.push({ it, name, wantDir })
  }
  /* ③ 115：逐个取直链（有上限，超了只提示不去撞风控） */
  if (w115.length > DL_115_MAX) {
    DL.note = '115 网盘有 ' + w115.length + ' 部，逐个取直链会撞风控 —— 已跳过（上限 ' + DL_115_MAX + ' 部）。要验请直接重扫媒体库。'
  } else {
    for (const it of w115) {
      if (DL.cancel) break
      DL.done++
      const rel = String(it.relVideo || '')
      try {
        const r = await v115DownURLByApi(String(it.pick || ''), (v115RelParse(rel) || {}).n || 1)
        if (!r || !r.url) dead.push({ code: it.code || '', rel, src: '115', why: '取不到播放直链' })
      } catch (e) {
        const m = String((e && e.message) || e || '')
        dead.push({
          code: it.code || '', rel, src: '115',
          why: /登录|Cookie|失效|401|403/i.test(m) ? '115 登录已失效（重新填 Cookie 再验）' : '取直链失败：' + m.slice(0, 60)
        })
      }
      await new Promise(r => setTimeout(r, 250))       // 别打太急
    }
  }
  /* ④ 列目录：一个目录一次请求 */
  let dirErr = ''
  for (const g of groups.values()) {
    if (DL.cancel) break
    let list = null
    try { list = await davList(g.kind, g.dir, true, g.n) }
    catch (e) {
      dirErr = String((e && e.message) || e || '')
      /* 列不出来 ≠ 文件没了：可能是登录过期 / 网络抖动。整组标「未知」而不是判死。 */
      g.checks.forEach(c => dead.push({
        code: (c.it.code || ''), rel: String(c.it.relVideo || ''), src: dlLabel(c.it.relVideo),
        why: '无法确认（' + dirErr.slice(0, 70) + '）', unsure: true
      }))
      DL.done += g.checks.length
      continue
    }
    const byName = new Map()
    ;(list || []).forEach(f => byName.set(String(f.name || '').trim(), !!f.isDir))
    for (const c of g.checks) {
      DL.done++
      const hit = byName.has(c.name) && (c.wantDir ? byName.get(c.name) === true : byName.get(c.name) === false)
      if (!hit) {
        dead.push({
          code: c.it.code || '', rel: String(c.it.relVideo || ''), src: dlLabel(c.it.relVideo),
          why: c.wantDir ? '网盘上已没有这个目录（文件多半被删了）' : '网盘上已没有这个文件'
        })
      }
    }
    await new Promise(r => setTimeout(r, 250))         // 目录之间留点间隔，稳一点
  }
  DL.dead = dead
  DL.at = Date.now()
  DL.running = false
  if (DL.cancel) DL.note = (DL.note ? DL.note + ' ' : '') + '已手动停止，结果不完整'
  dlSave()
  console.log('[deadlink] 检测完成：' + DL.total + ' 部，失效 ' + dead.length + ' 部')
  return { ok: true, total: DL.total, dead: dead.length }
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
/* 在某些网络（如 NAS 出口）下恒定 403、纯浪费时间的源。默认禁用这 3 个；
 * 想在其他网络恢复它们，设环境变量 JAVPACO_DISABLE_SOURCES 为空字符串即可覆盖。 */
const DISABLED_SOURCES = new Set((process.env.JAVPACO_DISABLE_SOURCES !== undefined
  ? process.env.JAVPACO_DISABLE_SOURCES : 'avbase,airav_io,miss_av').split(',').map(s => s.trim()).filter(Boolean))
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
  /* 媒体根不存在时**不再直接退出**，按顺序回落到：① 真实存在的已配置库 ② 合法的历史基准提示
   * ③ JP_MEDIA_ROOT ④ 系统盘根 / 家目录；全都没有才报错退出。
   * 起因（2026-10-13 用户报「启动失败」）：缓存里存了脏基准 → 算出的媒体根不存在 → 又没有任何库可回退 →
   * 一键 exit(1)，用户只有一个弹窗、连「去设置页把目录指回来」的机会都没有。
   * 而「0 个媒体库」时媒体根本来只是个相对路径基准（扫描按 LIBS 走，不会去爬整盘），
   * 没有理由为了它把整个 App 拦在门外。 */
  const cands = LIBS.concat([HINT_ROOT])
  let fallback = cands.find(p => { try { return !!p && fs.existsSync(p) } catch (_) { return false } })
  if (!fallback && process.env.JP_MEDIA_ROOT) { try { if (fs.existsSync(process.env.JP_MEDIA_ROOT)) fallback = process.env.JP_MEDIA_ROOT } catch (_) {} }
  if (!fallback) {
    const sysRoot = process.platform === 'win32' ? ((process.env.SystemDrive || 'C:') + path.sep) : '/'
    try { if (fs.existsSync(sysRoot)) fallback = sysRoot } catch (_) {}
  }
  if (!fallback) {
    try { if (fs.existsSync(os.homedir())) fallback = os.homedir() } catch (_) {}
  }
  if (fallback) {
    console.error(`[警告] 媒体目录不存在: ${MEDIA_ROOT}，已回退到: ${fallback}` +
      (LIBS.length ? '' : '（当前没有配置任何媒体库 —— 请在「添加影片 → 视频目录」里添加真正的媒体目录）'))
    MEDIA_ROOT = fallback
  } else {
    console.error(`[错误] 媒体目录不存在: ${MEDIA_ROOT}`)
    console.error(`用法: node server.js <媒体文件夹路径> [端口]`)
    console.error(`或者把路径写进 nexdex-ui/media-path.txt（每行一个路径）后直接运行 node server.js`)
    process.exit(1)
  }
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

/* ================= 115 网盘来源（Cookie 直连 webapi） =================
 * 需求：把 115 网盘上的片子当作媒体库来源，播放走 115 的 302 直链。
 *
 * 设计要点（改这段前先读完）：
 *  1) 配置存 CFG.pan115 = { cookie, savepath, cid, cidName, timeout, roots:[{cid,name,path}], linkTpl }，
 *     落 server-config.json；其中 cookie / savepath / cid / cidName / timeout 与「115 离线推送」共用一份，
 *  2) 条目 relVideo 统一用虚拟前缀 `115:/<115内路径>`，如 `115:/我的资源/无码/IPX-123.mp4`。
 *     这个前缀不会和真实磁盘路径冲突（Windows 路径不可能出现 `:/`），
 *     且 `relVideo.split('/').pop()` 取文件名依然正确 —— 下游那套「像路径一样用」的代码零改动；
 *  3) pickcode 是 115 取直链的唯一凭据：扫描时随条目写进 `pick` 字段（落 scan-result.json），
 *     播放时按 relVideo 反查 V115_MAP 拿 pick（重启后由扫描结果重建，见 rebuildV115Map）；
 *  4) 播放**不直连**：`/media/115:/…` 在路由层拦下来，服务端带 Cookie 取 302 真链后
 *     代理转发 Range 流。这样 <video> 不必满足 115 CDN 的 UA / Referer 校验，
 *     拖动进度条也正常（与 mvStreamUpstream 同一套思路）。
 *
 * ⚠ 走的是 115 网页版非公开接口（与 AList / 115drive-webdav 同源），**不是**官方开放平台。
 *   Cookie 失效要在设置页重贴；接口若改版，日志里会打印原始响应（[115] 前缀）便于定位。
 */
const V115_PREFIX = '115:/'
/* ---- 多账号（2026-10-14）----
 * 账号 1 = CFG.pan115（离线推送共用，保持原样 → 存量 relVideo `115:/…` 零迁移）；
 * 账号 N（≥2）= CFG.pan115x[N-2]，relVideo 前缀 `115@N:/…`。
 * 前缀里带账号号 → 同名路径在两个账号间不会撞车；V115_MAP 直接拿整个 vpath 当键，下游零改动。 */
const v115Pref = n => { n = parseInt(n, 10) || 1; return n > 1 ? ('115@' + n + ':/') : V115_PREFIX }
const V115_REL_RE = /^115(?:@(\d+))?:\//i
/* '115@2:/AV/x.mp4' → { n:2, p:'AV/x.mp4' }；不是 115 前缀 → null */
function v115RelParse(rel) {
  const m = V115_REL_RE.exec(String(rel || ''))
  if (!m) return null
  return { n: Math.max(1, parseInt(m[1], 10) || 1), p: String(rel).slice(m[0].length) }
}
const V115_UA = 'Mozilla/5.0 115Browser/27.0.5.7'
const V115_API = 'https://webapi.115.com'
const V115_PRO = 'https://proapi.115.com'
const V115_ORIGIN = 'https://115.com'
const V115_MAX_DIRS = 3000        // 单个媒体库最多遍历多少个目录（防递归跑飞）
const V115_MAX_FILES = 40000      // 单个媒体库最多收录多少个文件
let V115_MAP = new Map()          // relVideo('115:/…') -> { pick, size, mtime, name }
/* 目录 id -> { t, items }：列目录结果带**有效期**的缓存。
 * 每次重扫都重走整棵网盘树 = 几百次接口调用，而 115 的 WAF 对密集请求很敏感（见 v115Throttle），
 * 所以这份缓存在多次扫描之间**保留 10 分钟**；浏览弹层用 force=true 绕开它，保证看到的是实时目录。 */
const V115_SNAP_TTL = 10 * 60 * 1000
let V115_SNAP = new Map()
let V115_FIND_NOTE = ''           // 上一次按番号找网盘文件失败的原因（回给 /api/library/matchCode 提示用户）
let V115_URL = new Map()          // pick -> { url, exp } 直链缓存（直链有时效，过期即重取）
let V115_PREF_LAST = 0            // 上次「直链预热」发起时刻（/api/115/lib/prefetch 的全局节流，见该路由）

/* ===== 115 取直链：网页版内部协议（RSA + XOR），只用 Node 内置 crypto，不引入依赖 =====
 * 为什么非做不可：GET webapi.115.com/files/download 对**大文件**只回
 *   {"state":false,"msg":"文件大小超出限制，请使用115电脑端下载","msg_code":50028}
 * —— 几个 GB 的片子（本机媒体库里 3~8GB）全部命中，一条直链都拿不到。
 * 115 浏览器走的是另一条路：
 *   POST https://proapi.115.com/app/chrome/downurl?t=<unix秒>
 *   Content-Type: application/x-www-form-urlencoded
 *   body: data = base64( RSA_PKCS1( 16字节随机key ‖ transform(JSON.stringify({pickcode})) ) )
 *   响应 { state:true, data:"…" } 里的 data 用同一把 key 反解 → { "<pickcode>": { url:{url}, … } }
 * 算法与 AList / 115drive-webdav / fake115 的公开实现一致（已在多个项目长期验证）。 */
const V115_XOR_SEED = Buffer.from([
  0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a,
  0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8,
  0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4,
  0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa,
  0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86,
  0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6,
  0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd,
  0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7,
  0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e,
  0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86,
  0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34,
  0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81,
  0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59,
  0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48,
  0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77,
  0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e,
  0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b,
  0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
])
const V115_XOR_CLIENT = Buffer.from([0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46])
const V115_RSA_PUBLIC = Buffer.from(
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCGhpgMD1okxLnUMCDNLCJwP/P0\n' +
  'UHVlKQWLHPiPCbhgITZHcZim4mgxSWWb0SLDNZL9ta1HlErR6k02xrFyqtYzjDu2\n' +
  'rGInUC0BCZOsln0a7wDwyOA43i5NO8LsNory6fEKbx7aT3Ji8TZCDAfDMbhxvxOf\n' +
  'dPMBDjxP5X3zr7cWgwIDAQAB\n' +
  '-----END PUBLIC KEY-----\n')

/* key[i] = (seed[i] + XOR_SEED[size*i]) ^ XOR_SEED[size*(size-1-i)] */
function v115XorDerive(seed, size) {
  const key = Buffer.alloc(size)
  for (let i = 0; i < size; i++) {
    key[i] = (seed[i] + V115_XOR_SEED[size * i]) & 0xff
    key[i] ^= V115_XOR_SEED[size * (size - i - 1)]
  }
  return key
}
/* 前 len%4 个字节先按原位异或，其余按 (i-mod) 循环 —— 与 Go 版逐字节等价 */
function v115XorBuf(data, key) {
  const mod = data.length % 4
  for (let i = 0; i < mod; i++) data[i] ^= key[i % key.length]
  for (let i = mod; i < data.length; i++) data[i] ^= key[(i - mod) % key.length]
  return data
}
function v115ReverseBuf(data) {
  for (let i = 0, j = data.length - 1; i < j; i++, j--) { const t = data[i]; data[i] = data[j]; data[j] = t }
  return data
}
function v115Encode(plainBytes, key) {
  const buf = Buffer.concat([key, Buffer.from(plainBytes)])
  const tail = buf.subarray(16)
  v115XorBuf(tail, v115XorDerive(key, 4))
  v115ReverseBuf(tail)
  v115XorBuf(tail, V115_XOR_CLIENT)
  const bs = 117                       // 1024 位密钥 PKCS#1 v1.5 填充后单块最多 117 字节
  const out = []
  for (let off = 0; off < buf.length; off += bs) {
    out.push(crypto.publicEncrypt(
      { key: V115_RSA_PUBLIC, padding: crypto.constants.RSA_PKCS1_PADDING },
      buf.subarray(off, Math.min(off + bs, buf.length))))
  }
  return Buffer.concat(out).toString('base64')
}
function v115Decode(b64, key) {
  const raw = Buffer.from(String(b64 || ''), 'base64')
  const bs = 128
  const parts = []
  for (let off = 0; off < raw.length; off += bs) {
    const chunk = crypto.publicDecrypt(
      { key: V115_RSA_PUBLIC, padding: crypto.constants.RSA_NO_PADDING },
      raw.subarray(off, Math.min(off + bs, raw.length)))
    /* 对齐 Go 的 big.Int.Bytes()：先去前导 0，再取第一个 0x00 之后的内容（PKCS#1 的 00 02 … 00 分隔） */
    let i = 0
    while (i < chunk.length - 1 && chunk[i] === 0) i++
    const idx = chunk.indexOf(0, i)
    if (idx < 0) return null
    parts.push(chunk.subarray(idx + 1))
  }
  const all = Buffer.concat(parts)
  if (all.length <= 16) return null
  const body = Buffer.from(all.subarray(16))
  v115XorBuf(body, v115XorDerive(all.subarray(0, 16), 12))
  v115ReverseBuf(body)
  v115XorBuf(body, v115XorDerive(key, 4))
  return body
}
/* 调 115 的 downurl 取直链。返回 { url, cookie }：
 *   url    = 真正的 CDN 地址
 *   cookie = CDN 校验用的 auth_cookie（**必须一起带着**，否则 403 {"message":"no cookie"}）
 * 返回形态有两种，都要认（2026-10 实测）：
 *   A) HTTP 302 → https://dl.115cdn.net/files/dl302?t=…&f=pro → 再取一次，body 是 { state:true, data:"…" }
 *   B) HTTP 200 + { state:true, data:"…" }  → 直接就是密文
 * 密文都用**本次请求我们自己生成的 key** 解开（115 用请求方的 key 加密响应，不是 URL 里那个 t）。 */
async function v115DownURLByApi(pick, n, prio) {
  const key = crypto.randomBytes(16)
  const data = v115Encode(Buffer.from(JSON.stringify({ pickcode: pick }), 'utf8'), key)
  const url = V115_PRO + '/app/chrome/downurl?t=' + Math.floor(Date.now() / 1000)
  const rs = await v115FetchRaw(url, {
    method: 'POST', timeout: 20000, prio: prio,
    body: new URLSearchParams({ data }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
  }, n)

  /* 从一段响应里抠出加密 data（同时兼容「直接给 url」的老形态） */
  const pickPayload = async (r, tag) => {
    const txt = await r.text().catch(() => '')
    let j = null
    try { j = JSON.parse(txt) } catch (_) {}
    if (!j) {
      console.log('[115] ' + tag + ' 非 JSON HTTP ' + r.status + ' → ' + txt.slice(0, 200))
      if (v115Blocked(r.status, txt)) { v115MarkBlocked(); throw v115BlockErr() }
      throw new Error('115 返回了非预期内容（HTTP ' + r.status + '，多半是 Cookie 失效或被风控）')
    }
    if (j.state === false || j.state === 0 || j.state === '0') {
      console.log('[115] ' + tag + ' state=false → ' + JSON.stringify(j).slice(0, 260))
      throw new Error(v115ErrText(j.error || j.msg || j.message || ''))
    }
    if (typeof j.data === 'string' && j.data) return j.data
    const direct = (j.data && (j.data.url || j.data.file_url)) || j.url || j.file_url || ''
    if (direct) return { direct: direct }
    console.log('[115] ' + tag + ' 没有 data → ' + JSON.stringify(j).slice(0, 260))
    throw new Error('115 未返回直链数据')
  }

  let payload = ''
  const loc = rs.headers.get('location')
  if ([301, 302, 303, 307, 308].includes(rs.status) && loc) {
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
    const next = new URL(loc, url).href
    const r2 = await v115FetchRaw(next, { timeout: 20000, prio: prio, headers: { 'Accept': '*/*' } }, n)
    payload = await pickPayload(r2, 'dl302')
  } else {
    payload = await pickPayload(rs, 'downurl')
  }
  if (payload && payload.direct) return { url: payload.direct, cookie: '' }

  const plain = v115Decode(payload, key)
  if (!plain) throw new Error('115 直链响应解密失败（协议可能改版）')
  const text = plain.toString('utf8')
  let info = null
  try { info = JSON.parse(text) } catch (_) { throw new Error('115 直链响应不是 JSON：' + text.slice(0, 160)) }
  const one = (info && (info[pick] || info[Object.keys(info)[0]])) || {}
  const uo = one.url
  const u = (typeof uo === 'string' ? uo : (uo && uo.url)) || ''
  if (!u) {
    console.log('[115] downurl 解密后没有 url → ' + text.slice(0, 260))
    throw new Error('115 没有返回直链')
  }
  /* auth_cookie：CDN 侧校验用，不带上必 403 */
  const ac = (uo && uo.auth_cookie) || null
  const cookie = (ac && ac.name) ? (ac.name + '=' + ac.value) : ''
  return { url: u, cookie: cookie }
}

function v115Cfg(n) {
  /* ⚠ Cookie 与「115 离线推送」共用同一份（设置页只填一次，两个功能都生效）：
   *   CFG.pan115 = { cookie, savepath, cid, cidName, timeout, linkTpl, roots[] }   ← 账号 1
   *   cookie/savepath/cid/cidName/timeout 归离线推送用（见 handleActorApi 里的 pan115Cfg）；
   *   本模块只用 cookie + linkTpl + roots。账号 N（≥2）存 CFG.pan115x[N-2]（见多账号注释）。 */
  n = Math.max(1, parseInt(n, 10) || 1)
  if (!CFG.pan115 || typeof CFG.pan115 !== 'object') CFG.pan115 = {}
  const c = CFG.pan115
  if (typeof c.cookie !== 'string') c.cookie = ''
  if (typeof c.linkTpl !== 'string') c.linkTpl = ''
  if (!Array.isArray(c.roots)) c.roots = []
  if (n === 1) return c
  if (!Array.isArray(CFG.pan115x)) CFG.pan115x = []
  const cx = CFG.pan115x[n - 2] = (CFG.pan115x[n - 2] && typeof CFG.pan115x[n - 2] === 'object') ? CFG.pan115x[n - 2] : {}
  if (typeof cx.cookie !== 'string') cx.cookie = ''
  if (typeof cx.linkTpl !== 'string') cx.linkTpl = ''
  if (!Array.isArray(cx.roots)) cx.roots = []
  if (typeof cx.name !== 'string') cx.name = ''
  return cx
}
/* 推送目标账号（2026-10-15）：CFG.pan115.pushAcct，缺省 1 —— 离线推送/离线任务/推送目录/盯梢登记共用。
 * 模块层函数（watch115Push 也要用，不能放 handleActorApi 局部）。 */
function pan115PushAcctOf() { return Math.max(1, parseInt(CFG.pan115 && CFG.pan115.pushAcct, 10) || 1) }
/* 账号 N 算「存在」= 配了 Cookie / 收录了目录 / 起了名（三占其一；纯空槽不算） */
function v115AcctExists(n) {
  const c = v115Cfg(n)
  return !!(String(c.cookie || '').trim() || (Array.isArray(c.roots) && c.roots.length) || String(c.name || '').trim())
}
/* 现存账号号列表（[1] 或 [1,2,…]，稀疏空槽跳过） */
function v115AcctList() {
  const out = []
  const x = Array.isArray(CFG.pan115x) ? CFG.pan115x.length : 0
  if (v115AcctExists(1)) out.push(1)
  for (let i = 0; i < x; i++) { const n = i + 2; if (v115AcctExists(n)) out.push(n) }
  return out
}
/* 新账号该用几号：现存最高号 + 1 */
const v115AcctNext = () => { const l = v115AcctList(); return l.length ? l[l.length - 1] + 1 : 1 }
/* 对外展示用的账号列表：**账号 1 恒在**（哪怕还没配置 Cookie —— 卡片要显示「未连接 / 还没有收录目录」）。
   这是老行为，前端与外界都依赖它；账号 ≥2 才要求真的存在（没建过不该凭空冒一张空卡）。 */
const v115AcctListAll = () => { const l = v115AcctList(); return l.includes(1) ? l : [1].concat(l) }
const v115Cookie = n => String(v115Cfg(n).cookie || '').trim()
const v115Ready = n => !!v115Cookie(n)
function v115Roots(n) { return v115Cfg(n).roots.filter(r => r && r.cid != null && r.cid !== '') }

/* 遍历用的根列表（风控优化 2026-10-13）：去掉「被另一个已收录根包含」的根。
 * 场景：用户先收了 /AV，又收了 /AV/破解测试 —— 遍历时前者已经把后者整棵走完，
 *   再走一遍 = 同一批目录重复请求（本机实测一个根 27 个子目录 = 27 次 webapi 请求，翻倍很致命）。
 * 判据用 115 内路径按**段**比：p 以 q + '/' 开头（或 q 为空 = 根目录）即被包含。
 * ⚠ 只在遍历/查找时用；UI 展示（卡片、管理面板）仍用 v115Roots()，用户加了什么就列什么。 */
function v115WalkRoots(all) {
  all = all || v115Roots(1)   // 默认账号 1；多账号由调用方传各自的 roots（不同账号之间不存在互相包含）
  const norm = r => String(r.path || '').replace(/^\/+|\/+$/g, '')
  return all.filter(r => {
    const p = norm(r)
    const ri = all.indexOf(r)
    return !all.some(o => {
      if (o === r) return false
      const q = norm(o)
      if (q === p) return all.indexOf(o) < ri     // 同一路径（重复添加）：只保留先加的那个
      if (!q) return true                         // 另一个是「根目录」→ 包含一切
      return p.startsWith(q + '/')
    })
  })
}

/* ---- 115「网盘可读」状态（2026-10-13）------------------------------------------------
 * ⚠ 115 的 Cookie 有**两套鉴权**，不能用一条「连接成功」概括：
 *   ① 离线推送：clouddownload.115.com/web/?ac=task_lists  —— 还能用
 *   ② 网盘文件：webapi.115.com/files（show_dir=1）       —— 已经 errNo 990001「登录超时，请重新登录」
 * 实测（2026-10-13 用户报「SNOS-338 明明下载了却匹配不到」）：设置页「测试连接」只打了 ①，
 * 于是显示「✓ 连接成功」，而扫描网盘 / 📂 匹配文件 / 目录下拉 全部读不到网盘 —— UI 上一点异常都看不出来。
 * 这里把「网盘能不能读」单独记一份，供设置页 / 媒体源卡片 / 匹配失败提示分路显示。 */
const V115_AUTHS = {}                             // acct -> { ok, err, at }（每个账号各有一份登录态）
const v115AuthOf = n => {
  n = Math.max(1, parseInt(n, 10) || 1)
  if (!V115_AUTHS[n]) V115_AUTHS[n] = { ok: null, err: '', at: 0 }
  return V115_AUTHS[n]
}
const V115_AUTH_SKIP = 60 * 1000                  // 「读不了」的结论只压 60 秒：过期后允许再试（用户换了 Cookie 就能自愈）
/* 只有「登录类」失败才算网盘读不了；WAF 拦截（405）/ 网络超时都是暂态，不能据此判死 */
const v115AuthErr = msg => /登录|未登录|过期|失效|login|重新登录/i.test(String(msg || ''))
function v115MarkAuth(ok, err, n) {
  const a = v115AuthOf(n)
  a.ok = !!ok
  a.err = ok ? '' : String(err || '')
  a.at = Date.now()
}
/* 一句话原因（没问题返回 ''）；粘性显示 —— 只有下次读盘成功才会翻回 true */
function v115AuthNote(n) {
  const a = v115AuthOf(n)
  if (a.ok !== false) return ''
  const which = (parseInt(n, 10) || 1) > 1 ? '（账号 ' + parseInt(n, 10) + '）' : ''
  return '115 网盘读不了' + which + '（' + (a.err || '登录已过期') + '）。注意：离线推送接口可能仍然是好的，' +
    '所以「测试连接」看着正常 —— 账号 1 到「设置 → 115 推送」、账号 ≥2 到「媒体源管理」重新粘贴 Cookie'
}
const v115AuthStale = n => { const a = v115AuthOf(n); return a.ok === false && Date.now() - a.at < V115_AUTH_SKIP }
/* Cookie 里的 UID：部分直链接口要带 user_id */
const v115Uid = n => (v115Cookie(n).match(/(?:^|;\s*)UID=(\d+)/i) || [])[1] || ''

/* 统一的错误文案：把 115 的黑话翻成人话 */
function v115ErrText(msg) {
  const m = String(msg || '')
  if (/登录|未登录|login|过期|失效/i.test(m)) return '115 未登录或登录已过期 —— 账号 1 到「设置 → 115 推送」、账号 ≥2 到「媒体源管理」重新粘贴 Cookie'
  if (/频繁|限流|too many|稍后/i.test(m)) return '115 提示操作过于频繁，请稍等一会儿再试'
  return '115 拒绝了请求：' + (m || '未知原因')
}

/* ==================== 115 请求节流器（2026-10-13 重做） ====================
 * 为什么改：115 的阿里云 WAF 看的是**请求密度与规律性**。原实现是固定 350ms 等距脉冲
 *   （≈2.9 req/s 不停歇），遍历一棵 100 目录的网盘树 = 100 次请求 / 35 秒不间断 ——
 *   这是教科书级的爬虫特征，实测几轮就被整段拦 /files（HTTP 405「访问被阻断」）。
 *
 * 现在的三层节奏：
 *   ① 基础间隔 × 随机抖动（0.65~1.35）→ 打散等距脉冲，不再是机器心拍
 *   ② 每连续 20 次请求插入 3~8 秒「翻页停顿」→ 模拟人翻目录时的间歇
 *   ③ 全部请求**串行排队**（同一时刻只飞一个）→ 不会出现多任务并发抢跑
 * 被拦一次 → 惩罚升级：基础间隔 ×1.7（上限 = 基础 ×2.5）+ 长停顿更久，冷却时间指数递增
 *   （5 → 12 → 30 分钟，封顶 30）；此后连续 40 次成功且 20 分钟无异常 → 惩罚缓慢降回 1x。
 *
 * 2026-10-15 补两件事（用户诉求「降低请求速率，保证不被风控」）：
 *   · **基础间隔可档位调节**（CFG.v115Pace）：标准 780ms / 保守 1500ms / 极慢 3000ms，
 *     默认「保守」—— 宁可慢一点，也别把 Cookie 送进风控；
 *   · **离线推送那条通道以前完全没节流**（pan115Request 是独立的 https 请求，没走这里），
 *     批量推 20 部磁力 = 瞬间 40 个请求，是最典型的「自己灌爆自己」。现在两条通道共用本闸门。
 * 所有数值都只是**下限**：宁可慢，也不喂拦截。见 v115ThrottleState() 可观测。 */
const V115_PACE = { fast: 420, normal: 780, safe: 1500, turtle: 3000 }
function v115GapBase() {
  try { return V115_PACE[String((CFG && CFG.v115Pace) || 'safe')] || V115_PACE.safe } catch (_) { return V115_PACE.safe }
}
const v115GapMax = () => Math.max(3500, Math.round(v115GapBase() * 2.5))
const V115_BURST = 20
let V115_LAST = 0
let V115_BURST_N = 0
let V115_PENALTY = 1              // 自适应惩罚倍率（1 = 无惩罚）
let V115_OK_STREAK = 0            // 连续成功请求数（用于惩罚回落）
let V115_LAST_BAD = 0             // 最近一次被拦的时刻
let V115_REQ_TOTAL = 0            // 本进程累计请求数（诊断用）
/* 2026-10-16 播放优先（用户诉求：「点播放，播放器半天加载不出来」）
 * 老实现只维护一条 Promise 链 —— 所有 115 请求（含**播放取直链**）挤在同一队列里，
 * 播放要排在全量扫描 / 刮削后面。实测并发 10 个 115 流请求，首字节 0.34s → 25.7s 线性累加，
 * 刮削一轮几十上百个请求时点播放要等几分钟，观感就是「加载不出来」。
 * 现在分两条车道：
 *   high   = 用户点播放 / 取直链 / 直链预热（等不起，且一次只有 1~2 个请求）
 *   normal = 扫描 / 刮削 / 回填 / 离线推送（后台批量，慢一点没关系）
 * 调度器在每个「时间片」开始前**重新判优先级** —— 播放请求一到，下一个时间片就是它，
 * 最多只等一个间隔（≈1.5s）而不是几十个请求。长停顿（每 20 次那 3~8 秒）也允许被播放请求提前结束。
 * ⚠ 只改**排队顺序**：基础间隔、0.65~1.35 抖动、每 20 次的翻页停顿、风控惩罚倍率全部照旧，
 *    不削弱任何风控节奏（播放请求本身照样只占一个时间片，密度不变）。 */
const V115_LANE = { high: [], normal: [] }
let V115_RUNNING = false          // 同一时刻只有一个时间片在跑
let V115_REST_WAKE = null         // 「翻页停顿」的唤醒句柄（播放请求可提前结束停顿）
let V115_QUEUE_DEPTH = 0          // 诊断用：当前排队请求数
const v115GapNow = () => Math.min(v115GapMax(), Math.round(v115GapBase() * V115_PENALTY))
/* 排队取号。prio='high' 走优先车道 —— 只有播放链路（v115Serve / 直链预热）会这么传。 */
function v115Throttle(prio) {
  const lane = prio === 'high' ? V115_LANE.high : V115_LANE.normal
  return new Promise(resolve => {
    lane.push(resolve)
    V115_QUEUE_DEPTH = V115_LANE.high.length + V115_LANE.normal.length
    /* 正在「翻页停顿」时来了播放请求 → 提前结束停顿（基础间隔仍然保留，见 v115Slot） */
    if (prio === 'high' && V115_REST_WAKE) {
      const w = V115_REST_WAKE; V115_REST_WAKE = null
      console.log('[115] 节流：播放优先，提前结束翻页停顿')
      try { w() } catch (_) {}
    }
    v115Pump()
  })
}
/* 一个「时间片」= 等够基础间隔（带抖动）+ 每 20 次的翻页停顿。与原实现逐行等价，
 * 只有一处例外：prio='high'（用户点播放那一两下）**不吃翻页停顿** —— 那是给「连续爬页面」
 * 设计的模拟停顿，用户点一次播放在里面干等 3~8 秒没有意义。基础间隔照旧（密度不变）。 */
async function v115Slot(prio) {
  const gap = v115GapNow()
  const jitter = 0.65 + Math.random() * 0.7         // 0.65 ~ 1.35
  const wait = V115_LAST + Math.round(gap * jitter) - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  V115_LAST = Date.now()
  V115_REQ_TOTAL++
  /* 长停顿：一口气翻太多页不是人的行为 */
  V115_BURST_N++
  if (V115_BURST_N >= V115_BURST) {
    V115_BURST_N = 0
    if (prio === 'high') { console.log('[115] 节流：播放请求，跳过一次翻页停顿'); return }
    const rest = Math.round((3000 + Math.random() * 5000) * Math.min(2, V115_PENALTY))
    console.log('[115] 节流：连续 ' + V115_BURST + ' 次请求，休息 ' + (rest / 1000).toFixed(1) + 's')
    await new Promise(r => { V115_REST_WAKE = r; setTimeout(() => { if (V115_REST_WAKE === r) V115_REST_WAKE = null; r() }, rest) })
    V115_LAST = Date.now()
  }
}
/* 车道调度：每个时间片取「当前」优先级最高的那条车道（每轮重新判，所以能插队） */
async function v115Pump() {
  if (V115_RUNNING) return
  V115_RUNNING = true
  try {
    while (V115_LANE.high.length || V115_LANE.normal.length) {
      const isHigh = !!V115_LANE.high.length
      const next = isHigh ? V115_LANE.high.shift() : V115_LANE.normal.shift()
      V115_QUEUE_DEPTH = V115_LANE.high.length + V115_LANE.normal.length
      try { await v115Slot(isHigh ? 'high' : 'normal') } catch (e) { console.log('[115] 节流异常：' + ((e && e.message) || e)) }
      try { next() } catch (_) {}
    }
  } finally { V115_RUNNING = false; V115_QUEUE_DEPTH = 0; V115_REST_WAKE = null }
}
/* 惩罚升级（被拦 / 明确限流时调用） */
function v115PenaltyUp(why) {
  V115_PENALTY = Math.min(4.5, V115_PENALTY * 1.7)
  V115_OK_STREAK = 0
  V115_LAST_BAD = Date.now()
  console.log('[115] 风控惩罚升级' + (why ? '（' + why + '）' : '') + '：基础间隔 → ' + v115GapNow() + 'ms（倍率 ' + V115_PENALTY.toFixed(2) + '）')
}
/* 惩罚回落：连续 40 次成功 且 距上次出事 > 20 分钟，才降一档（降到 1x 为止） */
function v115PenaltyDecay() {
  if (V115_PENALTY <= 1) {
    /* 惩罚已回到正常 且 一小时没出事 → 冷却档位也重置（下次出事从 5 分钟重新开始） */
    if (V115_BLOCK_COUNT > 0 && Date.now() - V115_LAST_BAD > 60 * 60 * 1000) V115_BLOCK_COUNT = 0
    return
  }
  V115_OK_STREAK++
  if (V115_OK_STREAK >= 40 && Date.now() - V115_LAST_BAD > 20 * 60 * 1000) {
    V115_PENALTY = Math.max(1, V115_PENALTY / 1.5)
    V115_OK_STREAK = 0
    console.log('[115] 风控惩罚回落：基础间隔 → ' + v115GapNow() + 'ms（倍率 ' + V115_PENALTY.toFixed(2) + '）')
  }
}
/* 供 UI / 诊断查看当前节流状态（设置页「请求节奏」卡片直接显示这些） */
function v115ThrottleState() {
  return {
    gapMs: v115GapNow(), pace: v115PaceOf(), penalty: Math.round(V115_PENALTY * 100) / 100,
    requests: V115_REQ_TOTAL, blocked: v115BlockedNow(), remainMin: v115BlockRemain(),
    blockCount: V115_BLOCK_COUNT,
    /* 队列深度（两条车道合计）：播放请求会插到 normal 前面，这里能看出后台积压了多少 */
    queued: V115_QUEUE_DEPTH,
    /* 登录失效冷却（分通道：web = 网盘列目录/搜索，push = 离线推送） */
    authCd: { web: v115AuthCdRemain('web', 1), push: v115AuthCdRemain('push', 1) }
  }
}
/* 判断是不是被 WAF 拦了（非 JSON + 405 / 拦截页特征） */
const v115Blocked = (status, txt) => status === 405 || /security threat|blocked|访问被阻断|安全威胁/i.test(String(txt || '').slice(0, 1000))
const V115_BLOCK_MSG = '115 安全拦截：短时间内请求过多，被临时阻断（HTTP 405）—— 稍后重试即可，程序已自动放慢速度'
/* 被拦之后进冷却：这段时间内**不再打接口**（否则会一路喂拦截、越喂越久），直接抛带剩余时间的错。
 * 冷却时长**指数递增**（5 → 12 → 30 分钟）：反复撞同一堵墙说明对面判定更严，硬试只会更久。 */
let V115_BLOCK_UNTIL = 0
let V115_BLOCK_COUNT = 0          // 已发生的**累计**拦截次数（定冷却档位用，见 v115CooldownMs）
const V115_COOLDOWN_MIN = [5, 12, 30]
/* 档位取「本次之前」的次数：第 1 次被拦 → 5 分钟，第 2 次 → 12，第 3 次起 → 30 */
const v115CooldownMs = () => V115_COOLDOWN_MIN[Math.min(V115_BLOCK_COUNT, V115_COOLDOWN_MIN.length - 1)] * 60 * 1000
const v115BlockedNow = () => Date.now() < V115_BLOCK_UNTIL
const v115BlockRemain = () => Math.max(0, Math.ceil((V115_BLOCK_UNTIL - Date.now()) / 60000))
const v115MarkBlocked = () => {
  const cd = v115CooldownMs()                  // ⚠ 先按「之前的次数」定档，再自增 —— 否则第 1 次就跳到 12 分钟
  V115_BLOCK_COUNT++
  V115_BLOCK_UNTIL = Date.now() + cd
  v115PenaltyUp('HTTP 405')
  console.log('[115] 进入冷却 ' + (cd / 60000) + ' 分钟（累计第 ' + V115_BLOCK_COUNT + ' 次被拦，冷却时间递增）')
}
function v115BlockErr() {
  const e = new Error(V115_BLOCK_MSG + (v115BlockedNow() ? '（冷却中，还剩约 ' + v115BlockRemain() + ' 分钟）' : ''))
  e.v115Blocked = true
  return e
}

/* ==================== 登录失效冷却（2026-10-15 新增） ====================
 * 与上面的「风控冷却」是两回事，必须分开处理：
 *   · 风控（HTTP 405）：请求太密被 WAF 挡 → 放慢即可自愈；
 *   · 登录失效（errNo 990001「登录超时，请重新登录」）：**Cookie 已经死了**。
 *     拿一张死 Cookie 继续按节奏打接口，既一次也打不通，又是白白送给风控的流量 ——
 *     而且这类请求往往成串（扫描整棵树 = 几十次），极其难看。
 * 所以一旦某条通道明确报「未登录 / 登录超时」，就给它单独进冷却（15 → 45 → 120 分钟递增），
 * 冷却期内该通道的请求**直接本地失败**，一个字节都不发；用户重新粘贴 Cookie（/api/115/config
 * 或媒体源里保存）时立即解冻。
 * ⚠ 按**通道**分开记（web = webapi 列目录/搜索，push = 离线推送/任务列表）：
 *   实测这两套接口鉴权独立 —— 推送还正常时 webapi 可能已经 990001，反之亦然，
 *   一刀切会把还能用的那条路也一起封掉。 */
const V115_AUTH_CD_MIN = [15, 45, 120]
const V115_AUTH_CD = new Map()          // 'web@1' / 'push@2' → { until, hits }
const v115CdKey = (ch, n) => ch + '@' + Math.max(1, parseInt(n, 10) || 1)
function v115AuthCdOf(ch, n) { return V115_AUTH_CD.get(v115CdKey(ch, n)) || null }
const v115AuthCdRemain = (ch, n) => { const c = v115AuthCdOf(ch, n); return c ? Math.max(0, Math.ceil((c.until - Date.now()) / 60000)) : 0 }
const v115AuthCdOn = (ch, n) => { const c = v115AuthCdOf(ch, n); return !!(c && Date.now() < c.until) }
function v115AuthCdHit(ch, n, why) {
  const k = v115CdKey(ch, n)
  const c = V115_AUTH_CD.get(k) || { until: 0, hits: 0 }
  const cd = V115_AUTH_CD_MIN[Math.min(c.hits, V115_AUTH_CD_MIN.length - 1)] * 60 * 1000
  c.hits++
  c.until = Date.now() + cd
  V115_AUTH_CD.set(k, c)
  console.log('[115] ' + ch + ' 通道登录失效 → 暂停请求 ' + (cd / 60000) + ' 分钟（第 ' + c.hits + ' 次，' + String(why || '').slice(0, 80) + '）')
}
function v115AuthCdClear(ch, n) {
  const k = v115CdKey(ch, n)
  if (V115_AUTH_CD.has(k)) { V115_AUTH_CD.delete(k); console.log('[115] ' + ch + ' 通道鉴权恢复（账号 ' + Math.max(1, parseInt(n, 10) || 1) + '），已解除请求暂停') }
}
/* 换 Cookie / 改账号凭据后调用：解除登录失效冷却 + 丢掉 get_id 缓存。
 * 没有它的话，用户重贴了新 Cookie 还得干等 15~120 分钟冷却（界面上看不出为什么还是失败）。 */
function v115CookieChanged(n) {
  const k = Math.max(1, parseInt(n, 10) || 1)
  v115AuthCdClear('web', k)
  v115AuthCdClear('push', k)
  try { V115_LXID.delete(k) } catch (_) {}
}
/* 请求节奏档位（设置 → 115 推送 → 请求节奏）：safe（默认，1.5s）最省心 */
function v115PaceOf() {
  const v = String((CFG && CFG.v115Pace) || 'safe')
  return V115_PACE[v] ? v : 'safe'
}
function v115AuthCdErr(ch, n) {
  const m = v115AuthCdRemain(ch, n)
  const e = new Error('115 ' + (ch === 'push' ? '离线推送' : '网盘') + '接口登录已失效，为避免继续被风控，' +
    (m > 0 ? '已暂停请求 ' + m + ' 分钟' : '已暂停请求') + '。请在 ' +
    (ch === 'push' ? '「设置 → 115 推送」' : '「设置 → 115 推送」或「媒体源 → 115 网盘」') + '重新粘贴 Cookie')
  e.v115AuthCd = true
  return e
}
/* 115 的「登录失效」长相：errNo/errno = 990001，或文案里带登录超时/重新登录 */
const v115LoginErrCode = j => { const v = Number(j && (j.errNo != null ? j.errNo : j.errno)); return v === 990001 || v === 990002 }
const v115LoginErrText = s => /登录超时|重新登录|未登录|请先登录|登录已过期/i.test(String(s || ''))

/* WAF 会话粘性（2026-10-13 新增）：
 * 115 的 WAF（阿里云）用 acw_tc 标记「同一个访客的连续请求」。我们以前每次请求都把它丢掉，
 * 等于每打一次接口就换一张脸 —— 风控看到的是一串互不相干的陌生请求，评分更高、更容易被限流。
 * 这里把响应里下发的这条存住，后续请求带上（内存即可：它是短期流量标记，重启重取）。
 * ⚠ 实测（同日）：115 只下发 acw_tc，**不会**下发新的 SEID / CID / KID ——
 *   所以「保存 Set-Cookie 就能续期登录」这条思路不成立，Cookie 失效是 115 服务端的主动行为，
 *   本地无法靠回写续命。见 v115AuthNote() / w115GapMs() 上方的说明。 */
let V115_WAF = ''
/* 两条请求通道（fetch 的 v115FetchRaw / https 的 pan115Request）共用这一份吸收逻辑 */
function v115WafAbsorb(arr) {
  try {
    for (const s of (arr || [])) {
      const kv = String(s).split(';')[0].trim()
      const nm = kv.split('=')[0].trim()
      if (!/^(acw_tc|cdn_sec_tc|acw_sc__v2)$/i.test(nm)) continue
      const dead = /max-age=0/i.test(s) || /expires=thu, 01 jan 1970/i.test(s)
      V115_WAF = (!dead && kv.indexOf('=') > 0) ? ('; ' + kv) : ''
    }
  } catch (_) {}
}
function v115WafKeep(rs) {
  try { v115WafAbsorb(typeof rs.headers.getSetCookie === 'function' ? rs.headers.getSetCookie() : []) } catch (_) {}
}

/* 带 Cookie / UA / Referer 的请求封装（UA 必须伪装成 115 浏览器，否则风控直接挡）。
 * ⚠ UA 必须与 pan115Request 的**完全一致** —— 同一份 Cookie（同一设备 CID）从「两个不同浏览器」
 *   发请求是 115 判定会话异常的经典特征，可能直接让登录态被安全下线。 */
async function v115FetchRaw(url, opts, n) {
  opts = opts || {}
  const ck = v115Cookie(n)
  if (!ck) throw new Error('未配置 115 Cookie（设置 → 115 网盘' + ((parseInt(n, 10) || 1) > 1 ? '，账号 ' + parseInt(n, 10) : '') + '）')
  if (v115BlockedNow()) throw v115BlockErr()       // 风控冷却期内不打接口
  /* 登录失效冷却：一个字节都不发。⚠ 健康自检（probe）例外 —— 自检的唯一目的就是判断
   * 「Cookie 到底活了没有」，被自己的冷却挡住就永远等不到「自动恢复」那一刻（2026-10-15）。 */
  if (v115AuthCdOn('web', n) && !opts.probe) throw v115AuthCdErr('web', n)
  if (opts.throttle !== false) await v115Throttle(opts.prio)   // prio='high' = 播放取直链，插到扫描/刮削前面
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000)
  try {
    const rs = await fetch(url, {
      method: opts.method || 'GET',
      redirect: opts.redirect || 'manual',
      headers: Object.assign({
        'Cookie': ck + V115_WAF,
        'User-Agent': V115_UA,
        'Referer': V115_ORIGIN + '/',
        'Accept': 'application/json, text/plain, */*'
      }, opts.headers || {}),
      body: opts.body,
      signal: ctl.signal
    })
    v115WafKeep(rs)
    return rs
  } finally { clearTimeout(timer) }
}

/* 期望 JSON 的接口：非 JSON / state=false 一律抛出可读错误，并把原始响应打进日志 */
async function v115Json(pathname, opts, n) {
  const rs = await v115FetchRaw(V115_API + pathname, opts, n)
  const txt = await rs.text().catch(() => '')
  let j = null
  try { j = JSON.parse(txt) } catch (_) {}
  if (!j) {
    console.log('[115] 非 JSON 响应 HTTP ' + rs.status + ' ' + pathname + ' → ' + txt.slice(0, 300))
    if (v115Blocked(rs.status, txt)) { v115MarkBlocked(); throw v115BlockErr() }
    throw new Error('115 返回了非预期内容（HTTP ' + rs.status + '，多半是 Cookie 失效或被风控）')
  }
  const bad = j.state === false || j.state === 0 || j.state === '0' ||
    (j.errno !== undefined && Number(j.errno) !== 0) ||
    (j.errNo !== undefined && Number(j.errNo) !== 0)
  if (bad) {
    const raw = String(j.error || j.errorMsg || j.msg || j.message || '')
    console.log('[115] state=false ' + pathname + ' → ' + JSON.stringify(j).slice(0, 300))
    /* 115 有时把「操作过于频繁」也塞在 state=false 里 —— 这同样算风控信号，一并升级惩罚 */
    if (/频繁|限流|稍后/i.test(raw)) { v115MarkBlocked(); throw v115BlockErr() }
    /* 登录失效（990001）：不是频率问题，别去加节流惩罚 —— 直接让这条通道进「暂停请求」冷却，
     * 免得拿死 Cookie 继续把整棵树打一遍（扫描时一次就是几十个请求）。 */
    if (v115LoginErrCode(j) || v115LoginErrText(raw)) {
      v115AuthCdHit('web', n, raw)
      throw v115AuthCdErr('web', n)
    }
    throw new Error(v115ErrText(raw))
  }
  v115AuthCdClear('web', n)   // 通了 → 解冻（用户换了 Cookie 之后自愈）
  v115PenaltyDecay()          // 一次干净的成功：喂给节流器的「风控已缓和」信号
  return j
}

/* 115 账号信息（2026-10-13）：容量 + 会员状态 + 账号，媒体源卡片 / 115 设置 / 管理弹窗共用。
 *   容量  GET https://webapi.115.com/user/space
 *         → data.all_total / all_use / all_remain，各带 {size, size_format}（实测 51.36TB / 44.52TB / 6.84TB）
 *   会员  网盘页 https://115.com/?cid=0&mode=wangpan 的 HTML 里内嵌 `is_vip: Number('1')`
 *         —— 没有独立的 JSON 会员接口（/user/vip 等全是「服务器开小差了」），只能从页面里抠这一行。
 *   账号  GET /user/info → data 是脱敏手机号 "198*****405"
 * 10 分钟缓存；纯展示性数据，任何一步失败都不抛 —— 拿不到就让 UI 缺着，不影响主流程。 */
const V115_USERS = {}   // acct -> { t, data, busy }
const V115_LXID = new Map()   // 离线推送 get_id 缓存：acct -> { t, data }（见 pan115GetId）
function v115UserCached(n) {
  const u = V115_USERS[Math.max(1, parseInt(n, 10) || 1)]
  const d = u && u.data
  return (d && u.t && Date.now() - u.t < 600000) ? d : null
}
async function v115UserInfo(force, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  if (!force) { const c = v115UserCached(n); if (c) return c }
  const slot = V115_USERS[n] = (V115_USERS[n] || { t: 0, data: null, busy: null })
  if (slot.busy) return slot.busy     // 并发请求共用同一次探测
  slot.busy = (async () => {
    const out = {}
    try {
      const j = await v115Json('/user/space', null, n)
      const a = (j.data && j.data.all_total) || {}, u = (j.data && j.data.all_use) || {}, r = (j.data && j.data.all_remain) || {}
      out.total = Number(a.size) || 0; out.totalFmt = a.size_format || ''
      out.used = Number(u.size) || 0; out.usedFmt = u.size_format || ''
      out.remain = Number(r.size) || 0; out.remainFmt = r.size_format || ''
      out.percent = out.total ? Math.min(100, Math.round(out.used / out.total * 1000) / 10) : 0
    } catch (e) { out.err = e.message }
    try {
      const rs = await v115FetchRaw('https://115.com/?cid=0&mode=wangpan', { redirect: 'follow' }, n)
      const html = await rs.text().catch(() => '')
      const mv = html.match(/is_vip:\s*Number\('(\d)'\)/)
      if (mv) out.vip = mv[1] === '1'
    } catch (_) {}
    try {
      const u = await v115Json('/user/info', null, n)
      if (u && typeof u.data === 'string') out.user = u.data
    } catch (_) {}
    Object.assign(slot, { t: Date.now(), data: out, busy: null })
    return out
  })()
  try { return await slot.busy } finally { slot.busy = null }
}

/* 目录 / 文件判定（2026-10-13 用真实账号实测，原始响应如下）：
 *   目录项：{ fc:"0", cid:<自己的id>, pid:<父目录id>, n:名字, m:<子目录数>, pc:<pickcode> }
 *   文件项：{ fc:"1", fid:<自己的id>, cid:<所在目录id>, n:名字, s:<字节数>, pc:<pickcode>, m }
 * ⚠ 两个坑：
 *   ① **目录也有 pc（pickcode）**！所以「没有 pc 就是目录」的写法会把所有目录误判成文件 ——
 *      真实账号根目录 15 个文件夹会全部消失，界面只剩「根目录」可加（就是踩过的这个）。
 *   ② 文件也有 cid（父目录 id），所以也不能靠 cid 区分。
 * 可靠顺序：fc（0=目录 1=文件）> 有无 fid > 有无 pid。 */
function v115IsDir(f) {
  f = f || {}
  const yes = v => (v === true || v === 1 || v === '1')
  if (f.is_dir !== undefined) return yes(f.is_dir)
  if (f.is_directory !== undefined) return yes(f.is_directory)
  if (f.fc !== undefined && f.fc !== null && f.fc !== '') return String(f.fc) === '0'
  if (f.fid !== undefined) return false
  return f.pid !== undefined
}
/* 115 各端返回的字段名不统一，这里统一归一化（字段名差异见 v115IsDir 上方注释）。
 * 拿不准时把首条字段名打进日志（见 v115List / /api/115/lib/browse），接口改版后能第一时间发现。 */
function v115NormItem(f) {
  f = f || {}
  const name = String(f.n != null ? f.n : (f.fn != null ? f.fn : (f.name != null ? f.name : (f.file_name || ''))))
  const pick = String(f.pc != null ? f.pc : (f.pickcode != null ? f.pickcode : (f.pick_code || '')))
  const isDir = v115IsDir(f)
  const id = String(isDir ? (f.cid != null ? f.cid : '') : (f.fid != null ? f.fid : (f.id != null ? f.id : '')))
  let size = Number(f.s != null ? f.s : (f.fs != null ? f.fs : (f.size != null ? f.size : (f.file_size != null ? f.file_size : 0))))
  if (!isFinite(size) || size < 0) size = 0
  const tp = f.tp || f.uet || f.modify_time || f.mtime || f.utime || f.user_ptime || ''
  const mtime = Date.parse(String(tp).replace(/-/g, '/')) || (Number(f.te) ? Number(f.te) * 1000 : 0)
  /* 注意别用 m 当子项数：真实返回里「影视」明明有 6 个子目录却给 m=1，文件和目录都带这个字段，语义不明 */
  return { id, name, pick, size, isDir: !!isDir, mtime: mtime || 0 }
}

/* 列一个目录的全部子项（自动翻页）。按 cid 缓存（10 分钟有效，见 V115_SNAP_TTL），
 * 避免「每加一个本地目录/改一次设置 → 重扫 → 又把整棵网盘树重打一遍」。
 * 查询参数直接沿用项目里已实测可用的那套（见 /api/115/dirs），别自行精简。
 * ⚠ 防重：万一 115 忽略 offset 参数，会反复返回同一页 —— 用「首项 id + 条数」指纹识别并立刻收手，
 *   否则会一路拉到 V115_MAX_FILES 才对（40 次无效请求）。
 * force=true（浏览弹层）永远打接口，保证用户看到的是实时目录。 */
async function v115List(cid, force, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const cidS = String(cid || '0')
  const key = n + '|' + cidS
  if (!force) {
    const hit = V115_SNAP.get(key)
    if (hit && hit.t && Date.now() - hit.t < V115_SNAP_TTL) return hit.items
  }
  try {
    const out = []
    const LIMIT = 1000
    let lastSig = ''
    for (let off = 0; off < V115_MAX_FILES; off += LIMIT) {
      const q = new URLSearchParams({
        cid: cidS, show_dir: '1', limit: String(LIMIT), offset: String(off),
        o: 'user_ptime', asc: '0', format: 'json'
      })
      const j = await v115Json('/files?' + q.toString(), null, n)
      let arr = Array.isArray(j.data) ? j.data : (j.data && Array.isArray(j.data.list) ? j.data.list : [])
      if (off === 0 && arr.length) console.log('[115] 列目录 cid=' + key + '（' + arr.length + ' 项）字段：' + Object.keys(arr[0]).join(','))
      if (!arr.length) break
      if (off > 0) {
        const f0 = arr[0] || {}
        const sig = arr.length + ':' + String(f0.fid || f0.cid || '')
        if (sig === lastSig) { console.log('[115] 分页参数似乎未被支持（返回同一页），提前结束 cid=' + key); break }
        lastSig = sig
      } else {
        const f0 = arr[0] || {}
        lastSig = arr.length + ':' + String(f0.fid || f0.cid || '')
      }
      for (const f of arr) out.push(v115NormItem(f))
      const total = Number(j.count || 0)
      if (arr.length < LIMIT) break
      if (total && out.length >= total) break
    }
    v115MarkAuth(true, '', n)          // 列目录成功 = 网盘确实可读
    V115_SNAP.set(key, { t: Date.now(), items: out })
    return out
  } catch (e) {
    /* 集中在这里判定「网盘读不了」—— 任何走 v115List 的路径（扫描 / 匹配文件）都会把状态带出来，
     * 不必让每个调用方各自去认错（以前就是没人认，才被静默吞掉）。 */
    if (v115AuthErr(e && e.message)) v115MarkAuth(false, e && e.message, n)
    throw e
  }
}

/* 目录 cid → 收录根内相对路径（'AV/破解测试'，**不含** V115_PREFIX、无尾斜杠；根=''）。
 * v115Walk 遍历时顺手填 —— 与扫描的拼接口径**完全一致**；v115PathOf 兜底。 */
const V115_PID_PATH = new Map()

/* 递归遍历一个 115 媒体库根，产出与本地 walk 同构的条目：
 * { vpath:'115:/…', pick, size, mtime, name }
 * ⚠ 失败处理见函数末尾 —— 以前把「列目录失败」静默吞成空数组，调用方分不清「目录真的是空的」
 *   和「网盘根本没读到」（2026-10-13 用户报的「匹配文件找不到」就是这个坑）。 */
async function v115Walk(root, onDir, force) {
  const n = Math.max(1, parseInt(root && root.acct, 10) || 1)   // 账号号随 root 走（root.acct 由扫描/收录路由填好）
  const pref = v115Pref(n)
  const files = []
  const base = String(root.path || '').replace(/^\/+|\/+$/g, '')
  const t0 = Date.now()
  let dirs = 0
  let err0 = null
  let failSeq = 0          // 连续列目录失败次数（2026-10-15：见下方「早停」）
  const rec = async (cid, rel, depth) => {
    V115_PID_PATH.set(n + '|' + String(cid || '0'), rel || '')   // 顺手建「cid → 网盘路径」映射（0 成本；按番号搜索解析路径要用，见 v115PathOf）
    if (files.length >= V115_MAX_FILES || dirs >= V115_MAX_DIRS) return
    /* 扫描中途取消 → 每个子目录问一次，立刻收手（口径见 scWalkStopped 注释） */
    if (scWalkStopped()) return files
    let list = []
    try { list = await v115List(cid, force, n); failSeq = 0 }
    catch (e) {
      console.log('[115] 列目录失败 cid=' + cid + '：' + e.message)
      if (!err0) err0 = e
      /* ⚠ 早停（2026-10-15）：以前列目录失败只是「跳过这个目录」然后继续 ——
       * Cookie 失效 / 被风控时，一棵 30 个目录的树照样要打满 30 次请求才收手，
       * 全是注定失败的请求，纯给风控送流量。现在连续 3 次失败、或已进冷却/风控期，
       * 立刻中止整棵树（已拿到的文件照常返回）。 */
      failSeq++
      if (failSeq >= 3 || e.v115Blocked || e.v115AuthCd) throw e
      return
    }
    for (const f of list) {
      if (!f.name || f.name.startsWith('.')) continue
      const p = rel ? rel + '/' + f.name : f.name
      if (f.isDir) {
        if (depth < 12) { dirs++; if (onDir) onDir(p); await rec(f.id, p, depth + 1) }
      } else if (VIDEO_EXT.includes(extOf(f.name))) {
        files.push({ vpath: pref + p, pick: f.pick, size: f.size, mtime: f.mtime, name: f.name })
      }
    }
  }
  try { await rec(String(root.cid || '0'), base, 0) } catch (e) { if (!err0) err0 = e }   // 早停时 rec 会抛，统一在这里收
  console.log('[115' + (n > 1 ? '@' + n : '') + '] 遍历「' + (root.name || root.path || root.cid) + '」：' + files.length + ' 个视频 / ' + dirs + ' 个目录，用时 ' + (Date.now() - t0) + 'ms')
  /* 一个文件都没拿到又出过错 → 抛出去（调用方能看到真实原因；扫描那条路本来就包了 try/catch）；
   * 拿到了一部分 → 照常返回，把错误挂在数组的 err 上备查，别把已有结果一起丢掉。 */
  if (err0) {
    if (!files.length) throw err0
    files.err = err0.message
  }
  return files
}

/* ---------- 按番号找网盘文件：搜索接口优先（2026-10-14 风控优化） ----------
 * 以前 v115FindByCode 是「整棵收录树逐目录列一遍」—— 每个子目录一次 /files 请求
 * （本机实测一个根 27 个子目录 = 27 次）。📂 匹配文件每按一次、盯梢快照一失效（10 分钟），
 * 就把整树重打一遍 —— 这是触发 115 风控、进而让 Cookie 被安全下线的最大来源。
 * 实测（2026-10-14，真实账号）：
 *   ① GET webapi.115.com/files/search?search_value=<番号>&format=json —— **1 次请求**
 *      按文件名/目录名搜出全盘匹配；文件项 { fc:'1', fid, cid:<所在目录>, pc, s, n }。
 *   ② GET webapi.115.com/files?cid=X 顶层带 path 数组 = 根→X 的完整目录链，
 *      直接拼出 '115:/AV/破解测试/…' 路径。
 * 所以「搜 1 次 + 拼路径 0~1 次」≤ 2 个请求，替代整树。 */

/* 从 10 分钟列目录快照反查路径（纯内存，0 请求）：SNAP 只存「cid → 子项列表」没有路径，
 * 从每个收录根 DFS 一次即可建全表。返回本次新补了多少条。 */
function v115SnapFillPaths(n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  let cnt = 0
  const walk = (cid, rel) => {
    const k = n + '|' + String(cid || '0')
    if (V115_PID_PATH.has(k)) return
    V115_PID_PATH.set(k, rel || '')
    cnt++
    const hit = V115_SNAP.get(k)
    if (!hit || !Array.isArray(hit.items)) return
    for (const f of hit.items) {
      if (!f || !f.isDir || !f.id) continue
      walk(f.id, rel ? rel + '/' + f.name : f.name)
    }
  }
  for (const r of v115Roots(n)) walk(r.cid, String(r.path || '').replace(/^\/+|\/+$/g, ''))
  return cnt
}

/* 目录 cid → '115:/AV/破解测试/MIDA-812'（文件所在目录的完整虚拟路径，带所在账号的前缀）。
 * 三级：内存映射 → 快照反查 → 列一次该目录拿 path 链（1 请求）。
 * 返回 '' = 解析失败或**不在任何已收录根内**（调用方据此跳过）。 */
async function v115PathOf(cid, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  cid = String(cid || '0')
  const k = n + '|' + cid
  let rel = V115_PID_PATH.get(k)
  if (rel === undefined) { v115SnapFillPaths(n); rel = V115_PID_PATH.get(k) }
  if (rel === undefined) {
    try {
      const j = await v115Json('/files?cid=' + encodeURIComponent(cid) + '&show_dir=1&limit=1&offset=0&format=json', null, n)
      const chain = Array.isArray(j.path) ? j.path : []
      rel = chain.filter(x => x && x.cid !== '0' && x.cid !== 0).map(x => String(x.name || '')).join('/')
      V115_PID_PATH.set(k, rel)
    } catch (e) { rel = null }   // 列不出（权限/风控）→ 按收录范围外处理，别把一次失败放大成整树重打
  }
  if (rel === null || rel === undefined) return ''
  const pref = v115Pref(n)
  for (const r of v115WalkRoots(v115Roots(n))) {
    const rp = String(r.path || '').replace(/^\/+|\/+$/g, '')
    if (!rp || rel === rp || rel.startsWith(rp + '/')) return pref + rel
  }
  return ''
}

/* 按番号搜索网盘文件（webapi /files/search）：1 次请求替代整树遍历。只返回文件项（fc=1），
 * 附 dirCid（所在目录 id，v115NormItem 会把它归并进 id，这里单独留一份）。 */
async function v115SearchByCode(ccode, n) {
  const out = []
  const LIMIT = 200
  let lastSig = ''
  for (let off = 0; off < 4000; off += LIMIT) {
    const q = new URLSearchParams({ search_value: ccode, format: 'json', limit: String(LIMIT), offset: String(off) })
    const j = await v115Json('/files/search?' + q.toString(), null, n)
    const arr = Array.isArray(j.data) ? j.data : (j.data && Array.isArray(j.data.list) ? j.data.list : [])
    if (!arr.length) break
    const sig = arr.length + ':' + String(arr[0].fid || arr[0].cid || '')
    if (off > 0 && sig === lastSig) break    // 分页参数被忽略（返回同一页）→ 立刻收手
    lastSig = sig
    for (const f of arr) {
      if (String(f.fc) !== '1') continue
      out.push(Object.assign(v115NormItem(f), { dirCid: String(f.cid || '') }))
    }
    const total = Number(j.count || 0)
    if (out.length >= total || arr.length < LIMIT) break
  }
  return out
}

/* 在 115 网盘里按番号找视频 —— 供「📂 匹配文件」和「推送自动认领盯梢」用。
 * ccode = bare 化番号（'MIDA812'，匹配判定用）；origCode = 原始形态（'MIDA-812'，**搜索用**）。
 * 2026-10-14 重写：**先走搜索接口（1~2 次请求），彻底不再整树实时遍历**。
 *   · 搜索命中/零命中都到此为止 —— 搜索覆盖整个网盘，零命中就是真没有；
 *   · 搜索接口不可用（改版/权限，非风控）→ 回退「10 分钟列目录快照内查找」（纯内存，0 请求）；
 *   · 风控冷却中 → 什么都不打，把状态交出去。
 * 返回结构与本地 walkAsync 那条支路同构：{ relVideo, file, dir, net115, size }。 */
async function v115FindByCode(ccode, origCode) {
  const out = []
  V115_FIND_NOTE = ''
  const accts = v115AcctList().filter(n => v115Ready(n))
  if (!ccode || !accts.length) return out
  /* 搜索形态（原始番号优先，见下）对每个账号都一样，先算一次 */
  const tries = []
  const oc = String(origCode || ccode || '').trim().toUpperCase()
  if (oc) tries.push(oc)
  const hm = ccode.match(/^([A-Z]{2,6})(\d{2,6})$/)
  if (hm) { const hy = hm[1] + '-' + hm[2]; if (tries.indexOf(hy) < 0) tries.push(hy) }

  const nameHit = (f, dirName) => {
    const bn = bare(baseOf(f.name))
    const dn = bare(String(dirName || ''))
    let pc = ''
    try { pc = bare(parseName(f.name).code) } catch (_) {}
    return pc === ccode || (ccode.length >= 3 && (bn.includes(ccode) || dn.includes(ccode)))
  }

  let searchOkAny = false      // 有没有任何一个账号的搜索接口是通的（用于区分「搜了没有」和「压根没搜成」）
  for (const n of accts) {
    if (v115AuthStale(n)) { V115_FIND_NOTE = v115AuthNote(n); continue }

    /* ① 搜索接口。⚠ 115 的搜索是普通子串匹配：文件名里是「MIDA-812」时搜「MIDA812」搜不到
     * （2026-10-14 实测 0 结果）。按「最像发布名」的形态搜：优先原始番号；原始形态就是
     * 裸「字母+数字」时补一次「字母-数字」。两次封顶，仍远小于整树。 */
    let cand = []
    let searchOk = false
    try {
      for (const sv of tries) {
        cand = await v115SearchByCode(sv, n)
        console.log('[115' + (n > 1 ? '@' + n : '') + '] 按番号搜索「' + sv + '」：' + cand.length + ' 个候选（1 次请求，不遍历目录）')
        if (cand.length) break
      }
      searchOk = true
      searchOkAny = true
      /* 搜索成功 = 网盘确实读得到 → 把「读不了」的结论翻回来（自愈）。
       * 与 v115List 列目录成功同口径；否则用户换了 Cookie 之后，
       * 媒体源卡片会一直挂着「网盘读不了」直到下一次扫描。 */
      v115MarkAuth(true, '', n)
    } catch (e) {
      if (e && e.v115Blocked) { V115_FIND_NOTE = '115 正在风控冷却中，稍后再试匹配'; return out }
      /* 登录类失败 = 网盘确实读不了 → 记进账号状态（设置页/媒体源卡片据此提示重新贴 Cookie）。
       * ⚠ 必须在这里记：搜索接口现在是「📂 匹配文件」的第一条路，如果只让 v115List 记，
       *   搜索这条路上的登录失效就永远不会浮出来 —— 又变成当年那个「界面看着一切正常、
       *   匹配就是找不到」的坑。 */
      if (v115AuthErr(e && e.message)) v115MarkAuth(false, e && e.message, n)
      cand = null
      console.log('[115' + (n > 1 ? '@' + n : '') + '] 按番号搜索不可用，回退列目录快照：' + e.message)
    }
    /* ⚠ 只有「搜出了候选」才算到此为止。**搜索成功但零命中要继续往下走**：
     *   115 的搜索只匹配名字，文件名字面里没有番号的（典型：番号在目录名上，
     *   如「SNOS-338/part1.mp4」「MIDA-812/CD1/part1.mp4」）永远搜不到 ——
     *   而这正是当年用户报「明明下载了却匹配不到」的场景。零命中时再花 0 请求查一遍
     *   内存里的 10 分钟列目录快照，能捞回一大批。 */
    if (cand && cand.length) {
      /* 搜索是全盘的 —— 只留「已收录目录里」的（bindCode/重扫才收得进来）。
       * 路径解析走内存/快照缓存，只有快照没有的新目录才发 1 次列目录。 */
      let outside = 0
      for (const f of cand) {
        const dir = await v115PathOf(f.dirCid, n)
        if (!dir) { outside++; continue }
        const pp = v115RelParse(dir)
        const rel = pp ? pp.p : ''
        if (!nameHit(f, rel.split('/').pop())) continue   // 搜索是子串匹配，防 ABC-1 误伤 ABC-123
        out.push({ relVideo: dir + '/' + f.name, file: f.name, dir: rel, net115: true, size: f.size || 0, acct: n })
      }
      if (!out.length && outside && !V115_FIND_NOTE) {
        V115_FIND_NOTE = '在网盘里搜到了「' + ccode + '」，但都不在已收录的目录里 —— 到 设置 → 115 网盘 把那个目录收进来'
      }
      continue
    }

    /* ② 回退：10 分钟列目录快照内查找（纯内存，0 请求）。
     * 走到这里有两种来路：搜索接口不可用（cand === null），或搜索成功但零命中。 */
    v115SnapFillPaths(n)
    for (const [k, info] of V115_SNAP) {
      const m = /^(\d+)\|/.exec(String(k))
      if (!m || parseInt(m[1], 10) !== n || !info || !Array.isArray(info.items)) continue
      const rel = V115_PID_PATH.get(String(k)) || ''
      for (const f of info.items) {
        if (!f || f.isDir || !VIDEO_EXT.includes(extOf(f.name))) continue
        if (!nameHit(f, rel ? rel.split('/').pop() : '')) continue
        const fp = rel ? rel + '/' + f.name : f.name
        out.push({ relVideo: v115Pref(n) + fp, file: f.name, dir: rel, net115: true, size: f.size || 0, acct: n })
      }
    }
  }
  if (!out.length && !V115_FIND_NOTE) {
    /* 优先说真因：有账号被判「网盘读不了」时，别拿「搜不到」糊弄用户 ——
     * 这正是当年 SNOS-338 那个坑（Cookie 已失效，界面却显示一切正常）。 */
    const dead = accts.filter(n => v115AuthStale(n))
    if (dead.length) V115_FIND_NOTE = v115AuthNote(dead[0])
    else if (searchOkAny) V115_FIND_NOTE = '115 网盘里没搜到「' + ccode + '」（文件名与 10 分钟列目录快照都查过了）—— 确认文件已经放进「设置 → 115 网盘」收录的目录里，或等下次扫描后再试'
    else V115_FIND_NOTE = '115 按番号搜索接口暂不可用，且 10 分钟列目录快照里没有「' + ccode + '」—— 等下次扫描后再试'
  }
  return out
}

/* 跟随重定向取最终地址；返回 '' 表示这个接口没给直链（交给下一个候选接口） */
async function v115Follow(url, n, prio) {
  const rs = await v115FetchRaw(url, { timeout: 20000, headers: { 'Accept': '*/*' }, prio: prio }, n)
  const loc = rs.headers.get('location')
  if ([301, 302, 303, 307, 308].includes(rs.status) && loc) {
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
    return new URL(loc, url).href
  }
  const txt = await rs.text().catch(() => '')
  let j = null
  try { j = JSON.parse(txt) } catch (_) {}
  console.log('[115] 直链接口 ' + url.replace(/pickcode=[^&]+/, 'pickcode=…') + ' → HTTP ' + rs.status + ' ' + txt.slice(0, 200))
  if (!j && v115Blocked(rs.status, txt)) { v115MarkBlocked(); throw v115BlockErr() }
  if (j) {
    if (j.state === false) throw new Error(v115ErrText(j.error || j.msg || ''))
    const u = j.file_url || j.url || (j.data && (j.data.url || j.data.file_url))
    if (u) return u
  }
  return ''
}

/* 直链进缓存（115 直链有时效，4 分钟后自动重取；最多留 80 条）。缓存键带账号（pickcode 虽全局唯一，稳妥起见分账号）。 */
function v115CacheURL(pick, info, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  V115_URL.set(n + '|' + pick, { url: info.url, cookie: info.cookie || '', exp: Date.now() + 4 * 60 * 1000 })
  if (V115_URL.size > 80) V115_URL.delete(V115_URL.keys().next().value)
  return info
}

/* pickcode → 302 直链。先试用户在设置里填的自建服务，再走官方加密协议；
 * 都失败时给出明确指引。
 * prio='high'：播放链路专用（插到扫描/刮削前面，见 v115Throttle）。 */
async function v115DownURL(pick, n, prio) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const key = String(pick || '')
  if (!key) throw new Error('缺少 pickcode（115 条目没有识别到文件标识）')
  const ck = n + '|' + key
  const hit = V115_URL.get(ck)
  if (hit && hit.exp > Date.now()) return { url: hit.url, cookie: hit.cookie || '' }
  const uid = v115Uid(n)
  const tpl = String(v115Cfg(n).linkTpl || '').trim()
  let last = ''
  /* 1) 用户自建 302 服务（填了就最优先，方便内置协议失效时自救） */
  if (tpl) {
    const u = tpl.replace(/\{\{?pick(code)?\}?\}/gi, encodeURIComponent(key)).replace(/\{\{?uid\}?\}/gi, uid)
    try {
      const got = await v115Follow(u, n, prio)
      if (got) return v115CacheURL(key, { url: got, cookie: '' }, n)
      last = '自定义接口未返回直链'
    } catch (e) { last = e.message }
  }
  /* 2) 官方网页版协议：POST + RSA 加密（见 v115DownURLByApi）。
   *    这是**大文件唯一可行**的一条 —— GET webapi/files/download 对几 GB 的片子
   *    一律回「文件大小超出限制，请使用115电脑端下载」(50028)，所以不再拿它当候选。 */
  try {
    const got = await v115DownURLByApi(key, n, prio)
    if (got && got.url) return v115CacheURL(key, got, n)
    last = '官方接口未返回直链'
  } catch (e) { last = e.message }
  throw new Error('115 没能返回直链（' + last + '）。可在「设置 → 115 网盘」填「自定义直链接口」兜底')
}

/* 代理转发 115 的流：带 Range 透传，直链过期/CDN 403 时自动重取一次。
 * ⚠ 超时只能兜「迟迟拿不到响应头」这一段：响应体是动辄几 GB 的视频，
 *   把 AbortSignal.timeout 一路带进传输期会把正常播放掐断（fetch 的 signal 覆盖整个 body 传输）。
 *   所以拿到响应头立刻 clearTimeout，之后按客户端节奏慢慢传。 */
async function v115Proxy(req, res, url, pick, rel, depth, ck) {
  depth = depth || 0
  const hdrs = { 'User-Agent': V115_UA, 'Referer': V115_ORIGIN + '/', 'Accept': '*/*' }
  /* CDN 侧的 auth_cookie（由 downurl 一并返回）：缺了它 CDN 直接 403 {"message":"no cookie"} */
  if (ck) hdrs.Cookie = ck
  if (req.headers.range) hdrs.Range = req.headers.range
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30000)
  let rs
  try { rs = await fetch(url, { headers: hdrs, redirect: 'manual', signal: ctl.signal }) }
  catch (e) {
    clearTimeout(timer)
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('115 取流失败：' + e.message)
  }
  clearTimeout(timer)
  const loc = rs.headers.get('location')
  if ([301, 302, 303, 307, 308].includes(rs.status) && loc && depth < 3) {
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
    return v115Proxy(req, res, new URL(loc, url).href, pick, rel, depth + 1, ck)
  }
  if (rs.status === 401 || rs.status === 403) {
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
    if (depth < 2) {
      const pn = (v115RelParse(rel) || { n: 1 }).n
      V115_URL.delete(pn + '|' + pick)               // 直链多半过期了 → 重取再试
      const next = await v115DownURL(pick, pn, 'high').catch(() => null)
      if (next && next.url) return v115Proxy(req, res, next.url, pick, rel, depth + 1, next.cookie)
    }
  }
  if (rs.status !== 200 && rs.status !== 206) {
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
    res.writeHead(rs.status === 416 ? 416 : 502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('115 CDN 返回 HTTP ' + rs.status)
  }
  const hh = {
    'Content-Type': rs.headers.get('content-type') || MIME['.' + extOf(rel).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
  }
  const cl = rs.headers.get('content-length'); if (cl) hh['Content-Length'] = cl
  const cr = rs.headers.get('content-range'); if (cr) hh['Content-Range'] = cr
  res.writeHead(rs.status === 206 ? 206 : 200, hh)
  const body = require('stream').Readable.fromWeb(rs.body)
  /* 客户端断开（关播放器 / 拖进度条换 Range / 跳转）→ 中止上游，别让 115 那条连接空挂着 */
  let finished = false
  const stop = () => {
    if (finished) return
    finished = true
    try { body.destroy() } catch (_) {}
    try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
  }
  res.on('close', stop)
  body.on('end', () => { finished = true })
  body.on('error', stop)
  /* HEVC hev1 → hvc1（说明见 streamWith 下方）。探测只读 moov 区段（几 MB），
   * 失败/超时一律原样透传 —— 绝不能因为这一步让本来能播的片子播不了。 */
  let patch = null
  if (HEV1_RETAG && isMp4Rel(rel)) {
    try { patch = await hev1PatchFor115(pick, url, ck, hev1TotalOf(rs.headers)) } catch (_) { patch = null }
  }
  if (finished || res.destroyed) { stop(); return }     // 探测期间客户端可能已经断开
  if (patch) body.pipe(hev1Transform(patch, hev1AbsStart(rs.headers))).pipe(res)
  else body.pipe(res)
}

/* 播放取流失败该说什么（2026-10-13）：直链是**现取**的（缓存 4 分钟），Cookie 一失效就断在半路，
 * 而用户看到「取 115 直链失败：…」只会以为是网络问题。这里把「登录失效」单独标出来，
 * 明确告诉他要做什么 —— 也顺手解释了「播一会儿就断」这个现象的真正原因。 */
function v115PlayErrText(e, n) {
  const msg = (e && e.message) || '未知错误'
  const loginish = v115AuthOf(n).ok === false || /登录|重新登录|未登录|Cookie/i.test(msg)
  const which = (parseInt(n, 10) || 1) > 1 ? '（账号 ' + parseInt(n, 10) + '）' : ''
  return loginish
    ? '115 登录状态已失效' + which + '，取不到播放直链。账号 1 到「设置 → 115 推送」、账号 ≥2 到「媒体源管理」重新粘贴 Cookie 后再播放。\n（原始错误：' + msg + '）'
    : '取 115 直链失败：' + msg
}

/* 播放入口：relVideo → pick → 直链 → 代理 */
async function v115Serve(req, res, rel) {
  const pn = (v115RelParse(rel) || { n: 1 }).n
  const pick = v115PickOf(rel)
  if (!pick) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('115 条目缺少文件标识（pickcode）。请在「添加影片 → 全部重新扫描」后再试')
  }
  let down = null
  try { down = await v115DownURL(pick, pn, 'high') }
  catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(v115PlayErrText(e, pn))
  }
  return v115Proxy(req, res, down.url, pick, rel, 0, down.cookie)
}

/* relVideo → pickcode：先查内存表（扫描时填的），没有再翻已扫描出来的条目（重启后未重扫也能播） */
function v115PickOf(rel) {
  const hit = V115_MAP.get(rel)
  if (hit && hit.pick) return hit.pick
  try {
    const items = (DATA && DATA.items) || []
    for (const it of items) {
      if (it.relVideo !== rel) continue
      if (it.pick) { V115_MAP.set(rel, { pick: it.pick, size: it.size || 0, mtime: it.mtime || 0, name: it.relVideo }); return it.pick }
      const fs2 = (it.files || []).find(f => f && f.relVideo === rel && f.pick)
      if (fs2) { V115_MAP.set(rel, { pick: fs2.pick, size: fs2.size || 0, mtime: fs2.mtime || 0, name: rel }); return fs2.pick }
    }
  } catch (_) {}
  return ''
}

/* 从已扫描的条目重建 V115_MAP（服务启动 / 重扫开始时调用） */
function rebuildV115Map() {
  V115_MAP = new Map()
  try {
    for (const it of (DATA && DATA.items) || []) {
      if (!it || !it.relVideo || !v115Rel(it.relVideo)) continue
      if (it.pick) V115_MAP.set(it.relVideo, { pick: it.pick, size: it.size || 0, mtime: it.mtime || 0, name: it.relVideo })
      for (const f of (it.files || [])) {
        if (f && f.relVideo && f.pick && v115Rel(f.relVideo))
          V115_MAP.set(f.relVideo, { pick: f.pick, size: f.size || 0, mtime: f.mtime || 0, name: f.relVideo })
      }
    }
  } catch (_) {}
}
const v115Rel = vp => !!v115RelParse(vp)

/* 115 媒体库根的收录统计（设置页逐库展示，与本地库 libStats 同形）。n = 账号号 */
function v115Stats(n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const items = (DATA && DATA.items) || []
  const pref = v115Pref(n)
  return v115Roots(n).map(r => {
    const base = pref + String(r.path || '').replace(/^\/+|\/+$/g, '')
    const bp = base === pref ? pref : base + '/'
    let videos = 0, ok = 0, fail = 0, cover = 0
    for (const it of items) {
      const rv = (it && it.relVideo) ? String(it.relVideo) : ''
      if (rv.indexOf(pref) !== 0) continue
      if (!(rv === base || rv.indexOf(bp) === 0)) continue
      videos++
      if (it.pending) fail++; else ok++
      if (it.relPoster || it.relFanart) cover++
    }
    return {
      kind: '115', acct: n, cid: String(r.cid), path: r.path || '',
      name: r.name || r.path || ('115 目录 ' + r.cid),
      videos, ok, fail, cover
    }
  })
}
/* ==================== WebDAV / 光鸭网盘媒体源（2026-10-13） ====================
 * 与 115 同一套思路，但协议是**标准 WebDAV**（RFC 4918），所以整个引擎比 115 短得多：
 *   列目录 = PROPFIND Depth:1（自带文件大小 / 修改时间，不用翻页）
 *   播放   = GET + Range 原样转发（服务端只当管道，不需要解析直链）
 *   容量   = PROPFIND 根目录的 quota-used-bytes / quota-available-bytes（有就显示，没有就不显示）
 * 两个来源共用这一个引擎，只是配置和 relVideo 前缀不同：
 *   webdav  → CFG.webdav  = { url, user, pass, name, roots[] }，relVideo = `dav:/<路径>`
 *   guangya → CFG.guangya = { url, user, pass, name, roots[] }，relVideo = `gy:/<路径>`
 * 光鸭 = 光鸭云盘客户端「设置 → WebDAV」里复制的 服务器地址 + 账号 + 专属访问密钥；
 *   它没有公开 API，官方支持的方式就是 WebDAV（Vidhub/爆米花 也是这么接的）。
 * 网盘地址通常是局域网（NAS 上的 Alist 等）→ **不走系统代理**，直连。 */
const DAV_PREFIX = 'dav:/'
const GY_PREFIX = 'gy:/'
const DAV_MAX_DIRS = 3000
const DAV_MAX_FILES = 40000
const DAV_KINDS = ['webdav', 'guangya']
const DAV_INFO = {
  webdav: { prefix: DAV_PREFIX, label: 'WebDAV' },
  guangya: { prefix: GY_PREFIX, label: '光鸭网盘' },
}
const DAV_DEFNAME = { webdav: 'WebDAV', guangya: '光鸭网盘' }
let DAV_MAP = new Map()                 // relVideo('dav:/…' | 'gy:/…' | 带账号的 'dav@2:/…') -> { size, mtime, name }
const DAV_SNAP_TTL = 10 * 60 * 1000     // 列目录快照（与 115 同策略：重扫之间复用，浏览弹层 force 绕开）
const DAV_SNAP = new Map()
/* ---- 多账号（2026-10-14）：账号 1 = CFG[kind]（存量零迁移），账号 N（≥2）= CFG[kind+'x'][N-2]，
 * relVideo 前缀 `dav@N:/…` / `gy@N:/…`。状态桶（DAV_AUTH/DAV_QUOTA）与快照键都带账号段。 ---- */
const DAV_AUTH = {}                     // 'webdav' | 'guangya@2' … -> { ok: true|false|null, err }
const DAV_QUOTA = {}                    // 同上 -> { t, space }
let DAV_FIND_NOTE = ''                  // 按番号查找失败的原因（回给 /api/library/matchCode）
/* 来源实例键：账号 1 = kind 原样（老数据/老键全兼容），账号 N = kind@N */
const davInst = (kind, n) => { n = parseInt(n, 10) || 1; return n > 1 ? (kind + '@' + n) : kind }
/* 账号 N 的 relVideo 前缀 */
const davPref = (kind, n) => {
  const p = (DAV_INFO[kind] || DAV_INFO.webdav).prefix
  n = parseInt(n, 10) || 1
  return n > 1 ? p.replace(/^([a-z]+):\//i, '$1@' + n + ':/') : p
}

function davCfg(kind, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const key = n === 1 ? kind : (kind + 'x')
  if (n === 1) {
    if (!CFG[kind] || typeof CFG[kind] !== 'object') CFG[kind] = {}
    var c = CFG[kind]
  } else {
    if (!Array.isArray(CFG[kind + 'x'])) CFG[kind + 'x'] = []
    const slot = (CFG[kind + 'x'][n - 2] && typeof CFG[kind + 'x'][n - 2] === 'object') ? CFG[kind + 'x'][n - 2] : {}
    CFG[kind + 'x'][n - 2] = slot
    c = slot
  }
  if (typeof c.url !== 'string') c.url = ''
  if (typeof c.user !== 'string') c.user = ''
  if (typeof c.pass !== 'string') c.pass = ''
  if (typeof c.name !== 'string') c.name = ''
  if (!Array.isArray(c.roots)) c.roots = []
  /* 光鸭官方接口模式（短信验证码登录）的字段（2026-10-13）：
   * mode='api'|'webdav'（空 = 按有无 token 自动认），tokenExp 为秒级时间戳。 */
  if (kind === 'guangya') {
    if (typeof c.mode !== 'string') c.mode = ''
    if (typeof c.accessToken !== 'string') c.accessToken = ''
    if (typeof c.refreshToken !== 'string') c.refreshToken = ''
    if (typeof c.account !== 'string') c.account = ''
    if (typeof c.tokenExp !== 'number') c.tokenExp = 0
    /* 设备指纹（对齐 AList GuangYaPan 驱动的 device_id / device_sign）：
     * 必须是**持久且稳定**的 —— 每次重启都换一个新的，光鸭就当成「新设备」，
     * 既容易触发风控、又可能让已登录态被判无效。首次生成后写回 server-config.json。 */
    if (typeof c.deviceId !== 'string') c.deviceId = ''
  }
  return c
}
/* 账号 N 算「存在」= 配了凭据 / 收录了目录 / 起了名（光鸭有 token 也算） */
function davAcctExists(kind, n) {
  const c = davCfg(kind, n)
  if (String(c.name || '').trim() || (Array.isArray(c.roots) && c.roots.length)) return true
  if (kind === 'guangya' && (String(c.accessToken || '').trim() || String(c.refreshToken || '').trim())) return true
  return !!(String(c.url).trim() && String(c.user).trim() && String(c.pass).trim())
}
function davAcctList(kind) {
  const out = []
  if (davAcctExists(kind, 1)) out.push(1)
  const x = Array.isArray(CFG[kind + 'x']) ? CFG[kind + 'x'].length : 0
  for (let i = 0; i < x; i++) { const n = i + 2; if (davAcctExists(kind, n)) out.push(n) }
  return out
}
const davAcctNext = kind => { const l = davAcctList(kind); return l.length ? l[l.length - 1] + 1 : 1 }
/* 同 v115AcctListAll：账号 1 恒在（未配置 = added:false，由前端决定隐不隐藏） */
const davAcctListAll = kind => { const l = davAcctList(kind); return l.includes(1) ? l : [1].concat(l) }
const davReady = (kind, n) => {
  const c = davCfg(kind, n)
  if (kind === 'guangya' && gyIsApi(kind, n)) return !!(String(c.accessToken || '').trim() || String(c.refreshToken || '').trim())
  return !!(String(c.url).trim() && String(c.user).trim() && String(c.pass).trim())
}
const davLabel = kind => (DAV_INFO[kind] || DAV_INFO.webdav).label
function davRoots(kind, n) { return davCfg(kind, n).roots.filter(r => r && typeof r.path === 'string' && String(r.path).replace(/^\/+|\/+$/g, '') !== '') }
/* 服务器地址：没写协议就补 http://（局域网地址常写成 192.168.1.5:5244 这种裸 host:port） */
function davBase(kind, n) {
  let u = String(davCfg(kind, n).url || '').trim().replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u
  return u
}
/* 把 relVideo / 目录路径拼成请求 URL：每一段单独 encode（保留 / 与已 encoded 的段不二次转义） */
function davUrl(kind, n, p) {
  const enc = String(p || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    .map(s => { try { return /^[%A-Za-z0-9._~!$&'()*+,;=@-]+$/.test(decodeURIComponent(s)) ? s : encodeURIComponent(s) } catch (_) { return encodeURIComponent(s) } })
    .join('/')
  return davBase(kind, n) + '/' + enc
}
/* relVideo → { kind, n, p }；不是 WebDAV 系前缀返回 null */
function davSplitRel(rel) {
  const m = /^(dav|gy)(?:@(\d+))?:\//i.exec(String(rel || ''))
  if (!m) return null
  return { kind: m[1].toLowerCase() === 'gy' ? 'guangya' : 'webdav', n: Math.max(1, parseInt(m[2], 10) || 1), p: String(rel).slice(m[0].length) }
}
const davRel = rel => !!davSplitRel(rel)

/* 底层请求：Buffer（readBuf=true）或流（readBuf=false，播放转发用）。
 * 网络层任何失败都抛错（调用方分路认 401/404），不静默 —— 「账号不对」和「地址不通」必须分得开。 */
function davReq(kind, method, p, { headers = {}, body = null, timeout = 20000, readBuf = true } = {}, n) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(davUrl(kind, n, p)) } catch (e) { return reject(new Error('WebDAV 地址无效：' + davBase(kind, n))) }
    const c = davCfg(kind, n)
    const mod = u.protocol === 'http:' ? http : https
    const rq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method,
      headers: Object.assign({
        Authorization: 'Basic ' + Buffer.from((c.user || '') + ':' + (c.pass || '')).toString('base64'),
        'User-Agent': 'JavPaco/1.0 WebDAV',
        Accept: '*/*'
      }, headers)
    }, rsp => {
      if (!readBuf) return resolve({ status: rsp.statusCode, headers: rsp.headers, stream: rsp })
      const chunks = []
      rsp.on('data', d => chunks.push(d))
      rsp.on('end', () => resolve({ status: rsp.statusCode, headers: rsp.headers, buf: Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString('utf8') }))
      rsp.on('error', reject)
    })
    rq.setTimeout(timeout, () => { try { rq.destroy(new Error('请求超时（' + Math.round(timeout / 1000) + 's）')) } catch (_) {} })
    rq.on('error', reject)
    if (body) rq.write(body)
    rq.end()
  })
}
function davAuthErr(msg) { return /401|Unauthorized|认证|账号|密钥|password|credentials/i.test(String(msg || '')) }

/* ---- 多状态 XML 解析：只抠 6 个字段，正则足矣（不引依赖；命名空间前缀 d:/D:/ns0:/裸标签都认） ---- */
function davXmlText(blk, tag) {
  const m = blk.match(new RegExp('<(?:[\\w.-]+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + tag + '>', 'i'))
  return m ? m[1].trim() : ''
}
function davHrefToPath(href, reqPath) {
  let h = String(href || '').trim()
  if (/^https?:\/\//i.test(h)) { try { h = new URL(h).pathname } catch (_) {} }
  else if (h.charAt(0) !== '/') {          // 个别服务器给相对路径 → 按请求目录的父级拼
    const parent = String(reqPath || '').replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    h = parent + '/' + h
  }
  try { h = decodeURIComponent(h) } catch (_) {}
  return '/' + h.replace(/^\/+|\/+$/g, '')
}
function davParseMultistatus(xml, reqPath) {
  const out = []
  for (const blk of String(xml || '').split(/<\/(?:[\w.-]+:)?response>/i)) {
    if (!/<(?:[\w.-]+:)?response[\s>]/i.test(blk)) continue
    const href = davXmlText(blk, 'href')
    if (!href) continue
    const isDir = /<(?:[\w.-]+:)?collection\s*\/?>/i.test(blk)
    let name = davXmlText(blk, 'displayname')
    const p = davHrefToPath(href, reqPath)
    if (!name) name = p.replace(/\/+$/, '').split('/').pop() || '/'
    out.push({
      path: p, name: String(name).replace(/&lt;|&gt;|&amp;|&quot;|&apos;/g, ch => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" }[ch])),
      isDir,
      size: parseInt(davXmlText(blk, 'getcontentlength'), 10) || 0,
      mtime: Date.parse(davXmlText(blk, 'getlastmodified')) || 0,
      used: parseInt(davXmlText(blk, 'quota-used-bytes'), 10) || 0,
      avail: parseInt(davXmlText(blk, 'quota-available-bytes'), 10) || 0
    })
  }
  return out
}
const DAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/>' +
  '<d:getlastmodified/><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>'

/* 列一个目录的全部子项（PROPFIND Depth:1，带 10 分钟快照缓存）。
 * 第一条返回的是目录本身（Depth:1 的约定），按 path 对齐剔除。 */
async function davList(kind, p, force, n) {
  /* 光鸭官方接口模式：不走 PROPFIND，走 get_file_list（返回 items 与 PROPFIND 同构，下游全部无感） */
  if (kind === 'guangya' && gyIsApi(kind, n)) return gyApiList(p, force, n)
  const inst = davInst(kind, n)
  const key = inst + ' ' + String(p || '').replace(/^\/+|\/+$/g, '')
  if (!force) {
    const hit = DAV_SNAP.get(key)
    if (hit && Date.now() - hit.t < DAV_SNAP_TTL) return hit.items
  }
  let rs
  try {
    rs = await davReq(kind, 'PROPFIND', p, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: DAV_PROPFIND_BODY }, n)
  } catch (e) {
    DAV_AUTH[inst] = { ok: false, err: '连接失败：' + e.message }
    throw new Error(davLabel(kind) + (parseInt(n, 10) > 1 ? '（账号 ' + parseInt(n, 10) + '）' : '') + ' 连接失败：' + e.message)
  }
  if (rs.status === 401) { DAV_AUTH[inst] = { ok: false, err: '账号或密钥不对（HTTP 401）' }; throw new Error(davLabel(kind) + ' 账号或密钥不对（HTTP 401）') }
  if (rs.status === 404) throw new Error(davLabel(kind) + ' 目录不存在：/' + String(p || '').replace(/^\/+|\/+$/g, ''))
  if (rs.status >= 400) { DAV_AUTH[inst] = { ok: false, err: 'HTTP ' + rs.status }; throw new Error(davLabel(kind) + ' 服务器返回 HTTP ' + rs.status + '（地址可能没写对，或不是 WebDAV 端点）') }
  const self = '/' + String(p || '').replace(/^\/+|\/+$/g, '')
  const items = davParseMultistatus(rs.text(), p).filter(x => x.path !== self)
  DAV_AUTH[inst] = { ok: true, err: '' }
  DAV_SNAP.set(key, { t: Date.now(), items })
  return items
}

/* 递归遍历一个 WebDAV 媒体库根，产出与本地 / 115 walk 同构的条目：{ vpath, size, mtime, name } */
async function davWalk(kind, root, onDir, force) {
  const n = Math.max(1, parseInt(root && root.acct, 10) || 1)   // 账号号随 root 走
  const pref = davPref(kind, n)
  const files = []
  const base = String(root.path || '').replace(/^\/+|\/+$/g, '')
  const t0 = Date.now()
  let dirs = 0, err0 = null
  const rec = async (p, rel, depth) => {
    if (files.length >= DAV_MAX_FILES || dirs >= DAV_MAX_DIRS) return
    /* 扫描中途点了「停止扫描」→ 立即收手（每个子目录一次检查）。
     * 之前只在大根循环处检查，一个根内部（光鸭整树可能上百目录）完全不理会取消，
     * 用户按了停止要干等几分钟 —— 就是他看到的「停止没用」。 */
    if (scWalkStopped()) return files
    let list = []
    try { list = await davList(kind, p, force, n) }
    catch (e) { console.log('[' + kind + (n > 1 ? '@' + n : '') + '] 列目录失败 /' + p + '：' + e.message); if (!err0) err0 = e; return }
    for (const f of list) {
      if (!f.name || f.name.startsWith('.')) continue
      const rp = rel ? rel + '/' + f.name : f.name
      if (f.isDir) {
        if (depth < 12) { dirs++; if (onDir) onDir(rp); await rec(f.path.replace(/^\/+/, ''), rp, depth + 1) }
      } else if (VIDEO_EXT.includes(extOf(f.name))) {
        files.push({ vpath: pref + rp, size: f.size, mtime: f.mtime, name: f.name })
      }
    }
  }
  await rec(base, base, 0)
  console.log('[' + kind + (n > 1 ? '@' + n : '') + '] 遍历「' + (root.name || root.path || '/') + '」：' + files.length + ' 个视频 / ' + dirs + ' 个目录，用时 ' + (Date.now() - t0) + 'ms')
  if (err0) {
    if (!files.length) throw err0
    files.err = err0.message
  }
  return files
}

/* 容量探测（PROPFIND 根目录 Depth:0 的 quota-*）：拿得到就上卡片容量条，拿不到就 null。
 * 10 分钟缓存；纯展示，失败绝不影响扫描 / 播放。 */
function davFmtBytes(b) {
  b = Number(b) || 0
  const u = [['TB', 1 << 40], ['GB', 1 << 30], ['MB', 1 << 20]]
  for (const [s, d] of u) if (b >= d) return (b / d).toFixed(b >= d * 10 ? 1 : 2) + s
  return Math.max(0, Math.round(b)) + 'B'
}
async function davQuota(kind, force, n) {
  const inst = davInst(kind, n)
  const hit = DAV_QUOTA[inst]
  if (!force && hit && Date.now() - hit.t < DAV_SNAP_TTL) return hit.space
  if (!davReady(kind, n)) return null
  /* 光鸭官方接口模式：容量从 user/me 里尽力扫（没有就不显示，绝不影响其它功能） */
  if (kind === 'guangya' && gyIsApi(kind, n)) {
    try {
      const u = await gyUserInfo(n, true)
      DAV_QUOTA[inst] = { t: Date.now(), space: (u && u.space) || null }
    } catch (_) { DAV_QUOTA[inst] = { t: Date.now(), space: null } }
    return DAV_QUOTA[inst].space
  }
  try {
    const rs = await davReq(kind, 'PROPFIND', '', { headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: DAV_PROPFIND_BODY, timeout: 12000 }, n)
    if (rs.status >= 400) { DAV_QUOTA[inst] = { t: Date.now(), space: null }; return null }
    const one = davParseMultistatus(rs.text(), '')[0]
    if (!one || !(one.used || one.avail)) { DAV_QUOTA[inst] = { t: Date.now(), space: null }; return null }
    const used = Number(one.used) || 0
    const total = used + (Number(one.avail) || 0)
    const space = total > 0 ? {
      used, total,
      usedFmt: davFmtBytes(used), totalFmt: davFmtBytes(total), remainFmt: davFmtBytes(Math.max(0, total - used)),
      percent: Math.min(100, Math.round(used / total * 1000) / 10)
    } : null
    DAV_QUOTA[inst] = { t: Date.now(), space }
    return space
  } catch (_) { return null }
}
const davQuotaCached = (kind, n) => { const h = DAV_QUOTA[davInst(kind, n)]; return (h && Date.now() - h.t < DAV_SNAP_TTL) ? h.space : null }

/* 播放：GET + Range 原样转发（<video> 的拖动靠 Range，Accept-Ranges 透传即可） */
async function davServe(req, res, rel) {
  const sp = davSplitRel(rel)
  if (!sp) { res.writeHead(404); return res.end('Not Found') }
  const kind = sp.kind, n = sp.n
  /* 光鸭官方接口模式：路径 → fileId → 官方下载直链 → 管道转发（与 WebDAV 的 GET 转发同一个出口体验） */
  if (kind === 'guangya' && gyIsApi(kind, n)) return gyApiServe(req, res, sp.p, n)
  if (!davReady(kind, n)) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(davLabel(kind) + (n > 1 ? '（账号 ' + n + '）' : '') + ' 还没有配置服务器地址 / 账号 / 密钥，请到「添加影片 → 管理面板」补齐后再播放')
  }
  let rs
  try {
    rs = await davReq(kind, 'GET', sp.p, { headers: req.headers.range ? { Range: String(req.headers.range) } : {}, readBuf: false, timeout: 30000 }, n)
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(davLabel(kind) + ' 取流失败：' + ((e && e.message) || e))
  }
  if (rs.status >= 400) {
    try { rs.stream.destroy() } catch (_) {}
    res.writeHead(rs.status === 401 ? 502 : rs.status, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(rs.status === 401
      ? davLabel(kind) + ' 账号或密钥不对（HTTP 401），请到管理面板重新填写'
      : davLabel(kind) + ' 服务器返回 HTTP ' + rs.status + '（文件可能已被移动或删除）')
  }
  const h = {}
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'])
    if (rs.headers[k]) h[k] = rs.headers[k]
  if (!h['content-type']) h['content-type'] = 'video/mp4'
  if (!h['accept-ranges']) h['accept-ranges'] = 'bytes'
  res.writeHead(rs.status === 206 ? 206 : 200, h)
  rs.stream.pipe(res)
  /* 取消/断开要回收上游连接，否则网盘侧连接越积越多 */
  res.on('close', () => { try { rs.stream.destroy() } catch (_) {} })
  req.on('aborted', () => { try { rs.stream.destroy() } catch (_) {} })
}

/* 从已扫描条目重建 DAV_MAP（启动 / 重扫时调用；WebDAV 没有 pickcode，留着 size/mtime 供详情页用） */
function rebuildDavMap() {
  DAV_MAP = new Map()
  try {
    for (const it of (DATA && DATA.items) || []) {
      if (!it || !it.relVideo) continue
      const sp = davSplitRel(it.relVideo)
      if (!sp) continue
      DAV_MAP.set(it.relVideo, { size: it.size || 0, mtime: it.mtime || 0, name: it.relVideo })
      for (const f of (it.files || [])) {
        if (f && f.relVideo && davSplitRel(f.relVideo)) DAV_MAP.set(f.relVideo, { size: f.size || 0, mtime: f.mtime || 0, name: f.relVideo })
      }
    }
  } catch (_) {}
}
rebuildDavMap()

/* ==================== 光鸭云盘 · 官方接口模式（短信验证码登录，2026-10-13） ====================
 * 用户要「像 AList 那样的登录途径」—— 即在表单里直接登录拿 token，不用去客户端翻 WebDAV 密钥。
 * 光鸭官方 C 端 API（网页版 guangyapan.com 同源；端点与公开的 guangya/guangyaclient 客户端一致）：
 *   短信登录 = /v1/shield/captcha/init → /v1/auth/verification → …/verify → /v1/auth/signin
 *              （4 步，拿 access_token + refresh_token；签名用一组 x-client-* 头）
 *   列目录   = POST api.guangyapan.com/userres/v1/file/get_file_list { parentId, page, pageSize }
 *              （parentId 为空 = 根目录；返回 data.list[]，fileName/fileSize 已证实，其余字段防御式兼容）
 *   下载直链 = POST api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url { fileId }
 *   用户信息 = POST account.guangyapan.com/v1/user/me（账号显示 + 尽力探容量）
 * 与 WebDAV 模式共存：CFG.guangya.mode = 'api' | 'webdav'；relVideo 都是 gy:/<路径>，
 * 列目录时顺手建 路径→fileId 映射（GY_IDS），播放时反查。Token 过期自动用 refresh_token 续。 */
const GY_API_BASE = 'https://api.guangyapan.com'
const GY_ACC_BASE = 'https://account.guangyapan.com'
const GY_CLIENT_ID = 'aMe-8VSlkrbQXpUR'
const GY_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
const GY_DIDS = {}                       // acct -> 设备号（会话内固定；接口头的 did / x-device-id 都用它）
const GY_IDS = new Map()                 // acct|网盘路径('Movies/MovieA') -> fileId（列目录时顺手建）
/* 光鸭直链缓存：acct|fileId -> { url, exp }（get_res_download_url 有风控配额，别每条 Range 都打一次） */
const GY_URL = new Map()
const GY_SMS = { phone: '', captchaToken: '', verificationId: '', t: 0, acct: 1 }   // 短信登录中间态（10 分钟有效）；acct=登录目标账号
const GY_USERS = {}                      // acct -> user/me 缓存 { t, user, space }
function gyIsApi(kind, n) {
  if (kind !== 'guangya') return false
  const c = davCfg('guangya', n)
  if (c.mode === 'api') return true
  if (c.mode === 'webdav') return false
  return !!(String(c.accessToken || '').trim() || String(c.refreshToken || '').trim())   // 有 token 默认走官方接口
}
const gyMask = s => String(s || '').replace(/[\s-]/g, '').replace(/^(\+?\d{1,3})?(\d{3})\d{4}(\d{4})$/, '$1$2****$3')
/* 手机号规范化（2026-10-13：用户实测「登录失败：HTTP 400」）。
 * 光鸭官方要求 username/phone_number **带国际区号**（官方客户端示例：+86 13800138000），
 * 四步登录（init/send/verify/signin）必须用**同一个字符串** —— 少一个 +86 就在 signin 被 400 掉。
 * 规则：已带 '+' 原样透传；大陆 11 位手机号自动补「+86 」；带 86 前缀的补回来；其余按纯数字加 '+'。 */
function gyNormPhone(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('+')) return s
  const digits = s.replace(/\D/g, '')
  if (/^1\d{10}$/.test(digits)) return '+86 ' + digits
  if (/^86(1\d{10})$/.test(digits)) return '+86 ' + digits.slice(2)
  if (digits.length >= 8) return '+' + digits
  return ''
}
/* 设备号：**落盘持久**（AList 的 device_id 也是存进存储配置的）。
 * 以前是纯会话内随机 → 每次重启 = 一台新设备，光鸭风控会重新认识你（加重验证/掉登录态）。
 * 现在首启生成一次写进 server-config.json，之后一直复用。 */
function gyDid(n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const c = davCfg('guangya', n)
  if (c.deviceId) { GY_DIDS[n] = c.deviceId; return c.deviceId }
  if (!GY_DIDS[n]) GY_DIDS[n] = crypto.createHash('md5').update(String(Math.random()) + String(Date.now()) + 'gy' + n).digest('hex')
  c.deviceId = GY_DIDS[n]
  try { writeCfg() } catch (_) {}
  console.log('[guangya' + (n > 1 ? '@' + n : '') + '] 已生成并固定设备号 device_id=' + GY_DIDS[n])
  return GY_DIDS[n]
}
/* W3C traceparent（官方客户端对每个请求都带，格式 00-<32hex>-<16hex>-01） */
const gyTrace = () => '00-' + crypto.randomBytes(16).toString('hex') + '-' + crypto.randomBytes(8).toString('hex') + '-01'
/* 官方接口走 global fetch（undici 不读系统代理，正好 —— 网盘不该走代理）
 * 每个请求都带 traceparent（与官方客户端一致，缺了部分风控端点会 400）。 */
async function gyFetch(url, { headers = {}, json = null, timeout = 20000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const h = Object.assign({ traceparent: gyTrace() }, headers)
    const init = { method: json !== null ? 'POST' : 'GET', headers: h, signal: ctl.signal }
    if (json !== null) { h['content-type'] = 'application/json'; init.body = JSON.stringify(json) }
    const rsp = await fetch(url, init)
    const text = await rsp.text()
    let j = null
    try { j = JSON.parse(text) } catch (_) {}
    return { status: rsp.status, text, j }
  } finally { clearTimeout(timer) }
}
/* 给用户看的失败详情：优先 message/msg，其次把原始响应体截一段贴在后面（便于诊断 400 这种无文案的失败） */
function gyErrDetail(status, j, rawText) {
  const d = gyUnwrap(j) || {}
  const m = j && (j.message || j.msg || j.error_description || j.error) || d.message || d.msg || d.error || ''
  if (m) return String(m)
  const t = String(rawText || '').replace(/\s+/g, ' ').trim()
  return 'HTTP ' + status + (t && t !== '{}' ? '：' + t.slice(0, 160) : '')
}
/* 响应解包：有的端点包在 data 里、有的裸给 —— 两边都认（guangya JS 客户端用 .data?，python 客户端直接取顶层） */
const gyUnwrap = j => (j && typeof j === 'object' && j.data && typeof j.data === 'object') ? j.data : (j || {})
function gyApiHeaders(n) {
  const c = davCfg('guangya', n)
  return {
    accept: 'application/json, text/plain, */*',
    authorization: 'Bearer ' + (c.accessToken || ''),
    did: gyDid(n), dt: '4',
    origin: 'https://www.guangyapan.com', referer: 'https://www.guangyapan.com/',
    'user-agent': GY_UA
  }
}
function gyAccHeaders(n, extra = {}) {
  return Object.assign({
    accept: '*/*',
    origin: 'https://www.guangyapan.com', referer: 'https://www.guangyapan.com/',
    'user-agent': GY_UA,
    'x-client-id': GY_CLIENT_ID, 'x-client-version': '0.0.1',
    'x-device-id': gyDid(n), 'x-device-model': 'chrome%2F147.0.0.0', 'x-device-name': 'PC-Chrome',
    'x-device-sign': 'wdi10.' + gyDid(n) + crypto.randomBytes(16).toString('hex'),
    'x-net-work-type': 'NONE', 'x-os-version': 'MacIntel', 'x-platform-version': '1',
    'x-protocol-version': '301', 'x-provider-name': 'NONE', 'x-sdk-version': '9.0.2'
  }, extra)
}
/* refresh_token 续期（过期前自动调 + 401 后兜底调） */
async function gyRefresh(n) {
  const c = davCfg('guangya', n)
  const rt = String(c.refreshToken || '').trim()
  if (!rt) throw new Error('登录已过期且没有 refresh_token，请重新用短信验证码登录')
  const r = await gyFetch(GY_ACC_BASE + '/v1/auth/token', {
    headers: gyAccHeaders(n, { 'x-action': '401' }),
    json: { client_id: GY_CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt }
  })
  const d = gyUnwrap(r.j) || {}
  if (r.status !== 200 || !d.access_token) {
    const m = '刷新登录状态失败（HTTP ' + r.status + (d.message || d.msg ? '：' + (d.message || d.msg) : '') + '），请重新登录'
    DAV_AUTH[davInst('guangya', n)] = { ok: false, err: m }
    throw new Error(m)
  }
  c.accessToken = d.access_token
  if (d.expires_in) c.tokenExp = Date.now() / 1000 + Number(d.expires_in)
  if (d.refresh_token) c.refreshToken = d.refresh_token
  writeCfg()
  console.log('[guangya' + (parseInt(n, 10) > 1 ? '@' + parseInt(n, 10) : '') + '] access_token 已用 refresh_token 续期')
  return true
}
/* 带鉴权的 API 调用：token 快过期先续；401 再续一次重试 */
async function gyApi(url, { json = null, timeout = 20000, retried = false } = {}, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const c = davCfg('guangya', n)
  /* 登录凭据优先级（与 AList 一致）：access_token → refresh_token → 重新短信登录。
   * 只有 refresh_token（用户「粘贴 Token」时只填了这个）就先换票，别白打一次 401。 */
  if (!String(c.accessToken || '').trim() && String(c.refreshToken || '').trim()) {
    await gyRefresh(n)
  } else if (c.tokenExp && Date.now() / 1000 >= c.tokenExp - 30) {
    await gyRefresh(n)
  }
  let r
  try { r = await gyFetch(url, { headers: gyApiHeaders(n), json, timeout }) }
  catch (e) { throw new Error('光鸭云盘连接失败：' + e.message) }
  if (r.status === 401 && !retried && String(c.refreshToken || '').trim()) {
    try { await gyRefresh(n) } catch (_) {}
    return gyApi(url, { json, timeout, retried: true }, n)
  }
  if (r.status === 401) {
    const m = '光鸭登录已过期' + (n > 1 ? '（账号 ' + n + '）' : '') + '（HTTP 401），请到管理面板重新登录'
    DAV_AUTH[davInst('guangya', n)] = { ok: false, err: m }
    throw new Error(m)
  }
  if (r.status >= 400) throw new Error('光鸭云盘接口返回 HTTP ' + r.status)
  return r.j
}
/* 账号信息 + 尽力探容量（容量字段官方没文档，深度扫 capacity/space 类数字键，找不到就不显示） */
function gySpaceScan(d, depth, acc) {
  if (!d || typeof d !== 'object' || depth > 3) return
  for (const k of Object.keys(d)) {
    const v = d[k]
    if (v && typeof v === 'object') { gySpaceScan(v, depth + 1, acc); continue }
    if (typeof v !== 'number' || v <= 0) continue
    if (/total|capacity|quota|space/i.test(k) && !/used|free|avail|remain/i.test(k)) acc.total = Math.max(acc.total || 0, v)
    else if (/used/i.test(k)) acc.used = Math.max(acc.used || 0, v)
    else if (/^(free|avail\w*|remain\w*)$/i.test(k)) acc.avail = Math.max(acc.avail || 0, v)
  }
}
async function gyUserInfo(n, force, retried) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const cu = GY_USERS[n]
  if (!force && cu && Date.now() - cu.t < 600000) return cu
  if (!davReady('guangya', n) || !gyIsApi('guangya', n)) return null
  const r = await gyFetch(GY_ACC_BASE + '/v1/user/me', {
    headers: gyAccHeaders(n, { authorization: 'Bearer ' + (davCfg('guangya', n).accessToken || '') }), timeout: 15000
  })
  if (r.status === 401) {
    /* 401 → 先续期；续期失败把真实原因抛出去（⚠ 不能吞掉异常再递归 —— 那=无限循环） */
    if (retried) {
      const m = '光鸭登录已过期（HTTP 401），请重新登录'
      DAV_AUTH[davInst('guangya', n)] = { ok: false, err: m }
      throw new Error(m)
    }
    await gyRefresh(n)
    return gyUserInfo(n, true, true)
  }
  if (r.status >= 400) throw new Error('光鸭用户信息获取失败（HTTP ' + r.status + '）')
  const d = gyUnwrap(r.j) || {}
  const nm = gyMask(d.phone_number || d.phone || d.mobile || '') || String(d.nickname || d.nick_name || d.username || d.user_name || d.account || '').trim()
  if (nm) davCfg('guangya', n).account = nm
  const sp = {}
  gySpaceScan(d, 0, sp)
  let space = null
  if (sp.total > 0) {
    const used = sp.used || Math.max(0, sp.total - (sp.avail || 0))
    space = {
      used, total: sp.total,
      usedFmt: davFmtBytes(used), totalFmt: davFmtBytes(sp.total), remainFmt: davFmtBytes(Math.max(0, sp.total - used)),
      percent: Math.min(100, Math.round(used / sp.total * 1000) / 10)
    }
  }
  GY_USERS[n] = { t: Date.now(), user: davCfg('guangya', n).account || '', space }
  return GY_USERS[n]
}
/* 官方接口模式列目录：路径 → parentId 反查（GY_IDS）+ 分页拉全，产出与 PROPFIND 同构的 items。
 * 目录类型判定官方无文档，多形态兼容 + 兜底「无扩展名且 size=0 视作目录」（媒体树里够准）。 */
async function gyResolveId(rp, n) {
  rp = String(rp || '').replace(/^\/+|\/+$/g, '')
  if (!rp) return ''
  const k = (Math.max(1, parseInt(n, 10) || 1)) + '|' + rp
  if (GY_IDS.has(k)) return GY_IDS.get(k)
  const segs = rp.split('/')
  let cur = ''
  for (let i = 0; i < segs.length; i++) {
    const kk = (Math.max(1, parseInt(n, 10) || 1)) + '|' + segs.slice(0, i + 1).join('/')
    if (!GY_IDS.has(kk)) await gyApiList(cur, true, n)      // 缺哪段就列哪段父目录
    if (!GY_IDS.has(kk)) throw new Error('光鸭云盘里找不到目录：/' + segs.slice(0, i + 1).join('/'))
    cur = segs.slice(0, i + 1).join('/')
  }
  return GY_IDS.get(k)
}
async function gyApiList(p, force, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const rp = String(p || '').replace(/^\/+|\/+$/g, '')
  const key = davInst('guangya', n) + ' ' + rp
  if (!force) {
    const hit = DAV_SNAP.get(key)
    if (hit && Date.now() - hit.t < DAV_SNAP_TTL) return hit.items
  }
  const parentId = await gyResolveId(rp, n)
  const items = []
  let page = 0
  for (;;) {
    const j = await gyApi(GY_API_BASE + '/userres/v1/file/get_file_list', {
      json: { parentId, page, pageSize: 200, orderBy: 0, sortType: 0 }
    }, n)
    const d = gyUnwrap(j) || {}
    const list = d.list || d.files || d.fileList || []
    for (const f of list) {
      if (!f || typeof f !== 'object') continue
      const name = String(f.fileName || f.name || f.file_name || '').trim()
      if (!name) continue
      const id = String(f.fileId || f.fileID || f.id || '')
      const rel = rp ? rp + '/' + name : name
      if (id) GY_IDS.set(n + '|' + rel, id)
      /* 目录判定（2026-10-15 抓包）：光鸭的 `dirType` 对**目录和文件都是 1**，不能拿来判；
       * 真正的判据是 `resType`（2=目录 / 1=文件）。缺 resType 时才回退到老的那串猜测。 */
      let isDir
      if (f.resType === 2) isDir = true
      else if (f.resType === 1) isDir = false
      else isDir = f.isDir === true || f.is_dir === true || f.dir === true || f.dir === 1 ||
        f.folder === true || f.folderFlag === 1 || f.type === 0 || f.fileType === 0
      if (f.resType !== 1 && !isDir && !(Number(f.fileSize || f.size || 0) > 0) && !/\.[a-z0-9]{1,5}$/i.test(name)) isDir = true
      /* 修改时间：光鸭实测字段是 `utime`（秒），老代码只认 updateTime/modifyTime/lastUpdateTime
       * → mtime 恒为 0，增量扫描每次都当「新文件」。这里补上 utime / ctime 兜底。 */
      let mtime = Number(f.updateTime || f.modifyTime || f.lastUpdateTime || f.utime || f.ctime || 0) || 0
      if (mtime && mtime < 1e12) mtime *= 1000        // 秒 → 毫秒
      items.push({ path: '/' + rel, name, isDir: !!isDir, size: Number(f.fileSize || f.size || 0) || 0, mtime })
    }
    if (list.length < 200 || page > 100) break
    page++
  }
  DAV_AUTH[davInst('guangya', n)] = { ok: true, err: '' }
  DAV_SNAP.set(key, { t: Date.now(), items })
  return items
}
/* 官方接口模式播放：路径 → fileId → get_res_download_url → fetch 直链（带 Range）管道转发 */
async function gyApiServe(req, res, p, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const rp = String(p || '').replace(/^\/+|\/+$/g, '')
  if (!davReady('guangya', n)) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('光鸭网盘还没有登录，请到「媒体源 → 光鸭网盘」用短信验证码登录后再播放')
  }
  const fileId = await gyResolveId(rp, n).catch(() => '')
  if (!fileId) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('光鸭云盘里找不到这个文件：/' + rp)
  }
  /* 直链缓存（2026-10-15）：get_res_download_url 每次调用都算一次风控配额，而直链本身
   * 有效期 urlDuration（实测 6 小时）。按 acct|fileId 缓存，取 min(urlDuration, 30min) 保守过期，
   * 拖动进度条时就不会反复打接口。403/过期时清缓存重取一次。 */
  const gk = n + '|' + fileId
  const ghit = GY_URL.get(gk)
  let url = (ghit && ghit.exp > Date.now()) ? ghit.url : ''
  if (!url) {
    try {
      const j = await gyApi(GY_API_BASE + '/nd.bizuserres.s/v1/get_res_download_url', { json: { fileId } }, n)
      const d = gyUnwrap(j) || {}
      /* ⚠ 字段名实测是 **signedURL**（2026-10-15 抓包确证）—— 以前只认 url/download_url/downloadUrl/link，
       * 一个都对不上 → 永远「没有返回下载直链」，光鸭片源全部 502 播不了。 */
      url = d.url || d.signedURL || d.signedUrl || d.download_url || d.downloadUrl || d.link || ''
      if (url) {
        const ttl = Math.min(Math.max(60, Number(d.urlDuration) || 21600), 1800) * 1000
        GY_URL.set(gk, { url, exp: Date.now() + ttl })
        if (GY_URL.size > 64) GY_URL.clear()
      }
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('光鸭网盘取下载直链失败：' + e.message)
    }
  }
  if (!url) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('光鸭网盘没有返回下载直链（文件可能已被删除或风控限制）')
  }
  let rsp
  /* 取流：直链过期/被拒（401/403/404）时丢掉缓存重取一次（最多两轮，避免死循环） */
  for (let attempt = 0; ; attempt++) {
    try {
      const h = { 'user-agent': GY_UA }
      if (req.headers.range) h.range = String(req.headers.range)
      rsp = await fetch(url, { headers: h, redirect: 'follow' })
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('光鸭网盘取流失败：' + e.message)
    }
    const hard = rsp.status === 401 || rsp.status === 403 || rsp.status === 404
    if (rsp.status < 400) break
    if (hard && attempt === 0) {
      /* 丢缓存、重新要一条新直链，再来一轮 */
      try { if (rsp.body) rsp.body.cancel().catch(() => {}) } catch (_) {}
      GY_URL.delete(gk)
      try {
        const j = await gyApi(GY_API_BASE + '/nd.bizuserres.s/v1/get_res_download_url', { json: { fileId } }, n)
        const d = gyUnwrap(j) || {}
        const u2 = d.url || d.signedURL || d.signedUrl || d.download_url || d.downloadUrl || d.link || ''
        if (u2 && u2 !== url) {
          url = u2
          const ttl = Math.min(Math.max(60, Number(d.urlDuration) || 21600), 1800) * 1000
          GY_URL.set(gk, { url, exp: Date.now() + ttl })
          continue
        }
      } catch (_) {}
    }
    res.writeHead(hard ? 502 : rsp.status, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('光鸭网盘直链返回 HTTP ' + rsp.status + '（链接可能已过期，重试一次；反复出现就重新登录）')
  }
  const h = {}
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'])
    if (rsp.headers.get(k)) h[k] = rsp.headers.get(k)
  if (!h['content-type']) h['content-type'] = 'video/mp4'
  if (!h['accept-ranges']) h['accept-ranges'] = 'bytes'
  res.writeHead(rsp.status === 206 ? 206 : 200, h)
  const { Readable } = require('stream')
  const node = Readable.fromWeb(rsp.body)
  node.pipe(res)
  const kill = () => { try { node.destroy() } catch (_) {} }
  res.on('close', kill)
  req.on('aborted', kill)
}

/* WebDAV 媒体库根的收录统计（与 libStats / v115Stats 同形）。n = 账号号 */
function davStats(kind, n) {
  n = Math.max(1, parseInt(n, 10) || 1)
  const items = (DATA && DATA.items) || []
  const pref = davPref(kind, n)
  return davRoots(kind, n).map(r => {
    const base = pref + String(r.path || '').replace(/^\/+|\/+$/g, '')
    const bp = base === pref ? pref : base + '/'
    let videos = 0, ok = 0, fail = 0, cover = 0
    for (const it of items) {
      const rv = (it && it.relVideo) ? String(it.relVideo) : ''
      if (rv.indexOf(pref) !== 0) continue
      if (!(rv === base || rv.indexOf(bp) === 0)) continue
      videos++
      if (it.pending) fail++; else ok++
      if (it.relPoster || it.relFanart) cover++
    }
    return { kind: davLabel(kind), acct: n, path: r.path || '', name: r.name || r.path || (davLabel(kind) + ' 目录'), videos, ok, fail, cover }
  })
}

/* 在 WebDAV / 光鸭里按番号找视频（「📂 匹配文件」用），返回结构与 v115FindByCode 同构 */
async function davFindAllByCode(ccode, force) {
  const out = []
  DAV_FIND_NOTE = ''
  if (!ccode) return out
  for (const kind of DAV_KINDS) {
    for (const n of davAcctList(kind)) {
      if (!davReady(kind, n)) continue
      const inst = davInst(kind, n)
      if (DAV_AUTH[inst] && DAV_AUTH[inst].ok === false) { DAV_FIND_NOTE = davLabel(kind) + (n > 1 ? '（账号 ' + n + '）' : '') + '：' + DAV_AUTH[inst].err; continue }
      for (const root0 of davRoots(kind, n)) {
        const root = Object.assign({}, root0, { acct: n })
        let files = []
        try { files = await davWalk(kind, root, null, force !== false) }
        catch (e) {
          console.log('[' + kind + (n > 1 ? '@' + n : '') + '] 按番号查找：遍历「' + (root.name || root.path) + '」失败：' + e.message)
          if (!DAV_FIND_NOTE) DAV_FIND_NOTE = davLabel(kind) + ' 读取失败：' + ((e && e.message) || '未知错误')
          continue
        }
        if (files.err && !DAV_FIND_NOTE) DAV_FIND_NOTE = davLabel(kind) + ' 部分目录读取失败（结果可能不全）：' + files.err
        for (const f of files) {
          const bn = bare(baseOf(f.name))
          const dn = bare(path.basename(path.dirname(f.vpath)))
          let pc = ''
          try { pc = bare(parseName(f.name).code) } catch (_) {}
          if (pc === ccode || (ccode.length >= 3 && (bn.includes(ccode) || dn.includes(ccode)))) {
            out.push({
              relVideo: f.vpath,
              file: f.name,
              dir: f.vpath.split('/').slice(1, -1).join('/'),
              [kind]: true,
              size: f.size || 0
            })
          }
        }
      }
    }
  }
  return out
}
/* ======== WebDAV / 光鸭 模块结束 ======== */

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
/* 嵌入式番号提取（照 mdc-ng 的做法：番号常被噪声包裹，要在「去噪后的整串」里搜索，
 * 而不是要求整串就是番号）。三种常规写法按优先级匹配：
 *   ① 横杠式  GOJU-317 / GL-014 / STARS-238 / ABC-123 / SONE-248 / MIDE-786
 *   ② 日期式  092126-001（无码厂 carib/1pondo…）
 *   ③ 无横杠  STARS238 / HEYZO3902（字母前缀 + 数字）
 * 前缀限定 [A-Za-z]{2,6}（纯数字 2048 不会误中），数字 2~5 位（番号位数）；
 * 后缀的 B/(4K)/.restored/-www.xxx 等噪声由调用方先 stripNameNoise 清掉，这里只认番号本体。 */
const RE_EMBED_DASH = /([A-Za-z]{2,6})-(\d{2,5})/
const RE_EMBED_DATE = /(\d{6})[-_](\d{2,4})/
const RE_EMBED_NODASH = /([A-Za-z]{2,6})(\d{3,7})/
/* mdc-ng 对齐：番号只取【基础码】；破解 / 碟片 / 字幕作为【独立属性】剥离，绝不拼进 code。
 * 理由：基础码（GOJU-317 / GL-014）在 JavDB 上能正常刮到，而 -U / -cdN 形式的「完整码」常 404；
 * 且 mdc-ng 的 number_parser 正是先剥网站标识→画质→字幕，再提取基础番号。
 *   uncensored: restored/uncensored/uncut/leaked/decensored/无修正 等，或番号数字后紧贴 U
 *   cd:          数字后紧贴 B/C/D（B=2、D=4；C 当字幕不当碟）
 *   subtitle:    数字后紧贴 C（中字） */
const SUFFIX_UNC = /(restored|uncensored|uncut|leaked|decensored|de-?censored|無修正|无修正)/i
/* 显式碟标（mdc-ng 也作独立属性）：ABC-123-CD2 / -disc2 / -part3 / -vol2 / .CD1 。
 * 边界用 [-_. ] 限定，避免误中 MCD-123（cd 前无分隔符）或 CD-R（后接字母非数字）。 */
const RE_DISC_EXPLICIT = /(?:^|[-_. ])(?:cd|disc|part|vol)[-_. ]?(\d{1,2})(?![a-z0-9])/i
function detectAttrs(code, ctx) {
  const a = { uncensored: false, cd: 0, subtitle: false }
  if (SUFFIX_UNC.test(ctx || '')) a.uncensored = true
  /* 番号数字后紧贴的碟标/字幕/破解字母：GL-014B（碟2）/ SSIS-001C（字幕）/ GOJU-317U（破解）/ GL-014D（碟4） */
  const m = (ctx || '').match(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,6})-?(\d{2,5})([A-DU])(?![A-Za-z0-9])/)
  if (m && (m[1] + '-' + m[2]).toUpperCase() === String(code).toUpperCase()) {
    const L = m[3].toUpperCase()
    if (L === 'B') a.cd = 2
    else if (L === 'C') a.subtitle = true
    else if (L === 'D') a.cd = 4
    else if (L === 'U') a.uncensored = true
  }
  /* 显式碟标（优先级高于紧贴字母，二者同时出现时以显式数字为准） */
  const dm = (ctx || '').match(RE_DISC_EXPLICIT)
  if (dm) { const n = parseInt(dm[1], 10); if (n >= 1 && n <= 9) a.cd = n }
  return a
}
/* mdc-ng 式 studio 专属规则：覆盖通用正则漏掉 / 误判的厂牌前缀。
 * 顺序即优先级（先定义先匹配）。带横杠的厂牌名（S-CUTE / E-BODY…）必须显式列出，
 * 否则通用正则会把番号误成 BODY-123 / AREA-123 之类。 */
const STUDIO_RULES = [
  { re: /(^|[^a-z0-9])fc2[-_ ]?ppv[-_ ]?(\d{5,7})(?![a-z0-9])/i, fmt: m => 'FC2-PPV-' + m[2] },
  { re: /(^|[^a-z0-9])xxx[-_ ]?av[-_ ]?(\d{3,6})(?![a-z0-9])/i, fmt: m => 'xxx-av-' + m[2] },
  { re: /(^|[^a-z0-9])([nk]\d{3,4})(?![a-z0-9])/i, fmt: m => m[2] },                                       // Tokyo Hot n1234 / k1234（小写保留）
  { re: /(^|[^a-z0-9])x[-_ ]?art[.\-_ ]?(\d{2})[.\-_ ]?(\d{2})[.\-_ ]?(\d{2})(?![a-z0-9])/i, fmt: m => 'x-art-' + m[2] + '-' + m[3] + '-' + m[4] },
  { re: /(^|[^a-z0-9])hey[-_ ]?douga[-_ ]?(\d{3,5})[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'HEYDOUGA-' + m[2] + '-' + m[3] },  // HeyDouga 两段式番号
  { re: /(^|[^a-z0-9])s[-_ ]?cute[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'S-CUTE-' + m[2] },              // S-CUTE（厂牌名含横杠）
  { re: /(^|[^a-z0-9])e[-_ ]?body[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'E-BODY-' + m[2] },              // E-BODY
  { re: /(^|[^a-z0-9])g[-_ ]?area[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'G-AREA-' + m[2] },              // G-AREA
  { re: /(^|[^a-z0-9])t[-_ ]?cup[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'T-CUP-' + m[2] },                // T-CUP
  { re: /(^|[^a-z0-9])m[-_ ]?solo[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'M-SOLO-' + m[2] },              // M-SOLO
  { re: /(^|[^a-z0-9])k[-_ ]?cup[-_ ]?(\d{2,4})(?![a-z0-9])/i, fmt: m => 'K-CUP-' + m[2] },                // K-CUP
  { re: /(^|[^a-z0-9])carib(?:bean)?(?:com)?[-_ ]?(\d{3,4})(?![a-z0-9])/i, fmt: m => 'CARIB-' + m[2] },    // caribbeancom / carib
  { re: /(^|[^a-z0-9])(?:1pondo?|1pon)[-_ ]?(\d{3,6})(?![a-z0-9])/i, fmt: m => '1PON-' + m[2] },           // 1pondo / 1pon
  { re: /(^|[^a-z0-9])gana[-_ ]?(\d{3,4})(?![a-z0-9])/i, fmt: m => 'GANA-' + m[2] },                       // GANA
]
const studioCode = s => {
  if (!s) return null
  for (const r of STUDIO_RULES) { const m = s.match(r.re); if (m) return r.fmt(m) }
  return null
}
const extractEmbeddedCode = s => {
  if (!s) return null
  let m = s.match(RE_EMBED_DASH); if (m) return (m[1] + '-' + m[2]).toUpperCase()
  m = s.match(RE_EMBED_DATE); if (m) return m[1] + '-' + m[2]
  m = s.match(RE_EMBED_NODASH); if (m) return (m[1] + '-' + m[2]).toUpperCase()
  return null
}
/* 严格「干净番号」判定：只认三种规范形态（与 parseCodeFrom 接受的范围一致）。
 * 不能复用 impValidCode——它只要求「含字母且含数字」，垃圾串 2048-HK-GOJU-317-R 也会误判通过。
 * 这个判定用来识别「旧解析器误判出来的垃圾 code」，好在复用时重新识别。 */
const isCleanCode = c => {
  c = String(c || '').toUpperCase()
  return /^([A-Z0-9]{2,10})-(\d{2,7})$/.test(c) ||
         /^\d{6}[-_](\d{2,4})$/.test(c) ||
         /^[A-Z0-9]{2,6}(\d{3,7})$/.test(c) ||
         /^([A-Z0-9]{2,10})-(\d{2,7})(-U)?(-CD[1-9])?$/i.test(c) ||   // 带破解 -U / 碟片 -cdN 后缀
         /^[A-Z0-9]{2,6}(\d{3,7})(-U)?(-CD[1-9])?$/i.test(c)
}
const withAttrs = (code, title, ctx) => {
  const a = detectAttrs(code, ctx)
  return { code, title, uncensored: a.uncensored, cd: a.cd, subtitle: a.subtitle }
}
const parseName = name => {
  const raw = baseOf(name)
  const base = raw.replace(/[._]+/g, ' ').trim()
  /* ① 日期式无码番号优先：先去广告串（4k688.com@092126-001-CARIB → 092126-001-CARIB）再匹配，
   * 必须在摊平 . _ 之前做，否则 082926_001-1PON 的下划线会被吃掉、番号解析失败。 */
  const junked = stripNameJunk(raw)
  const jd = junked.match(RE_DATE_CODE)
  if (jd) return withAttrs(jd[1] + '-' + jd[2], junked.replace(/\s+/g, ' '), junked)
  /* ② 常规番号：先去噪声再解析，否则「hhd800.com@HEYZO-3902」里的域名数字会被当成番号（HHD-800）。
   * 没有噪声时 clean 与 base 相同，行为与原逻辑一致。 */
  const clean = stripNameNoise(raw).replace(/[._]+/g, ' ').trim()
  if (clean && clean !== base) {
    const st = studioCode(clean) || studioCode(base)   // mdc-ng 式 studio 专属规则（FC2-PPV / xxx-av / Tokyo Hot / x-art）
    if (st) return withAttrs(st, base, clean)
    const hit0 = parseCodeFrom(clean)
    if (hit0) return withAttrs(hit0.code, hit0.title, clean)
    /* 番号被噪声包裹（2048.hk@GOJU-317.restored / GL-014B(4K)-www.52iv.net）→
     * 在去噪串里搜嵌入式番号，而不是回退成垃圾串 */
    const emb = extractEmbeddedCode(clean)
    if (emb) return withAttrs(emb, (clean.replace(emb, '').replace(/\s+/g, ' ').trim() || base), clean)
  }
  const st2 = studioCode(base)
  if (st2) return withAttrs(st2, base, base)
  const hit = parseCodeFrom(base)
  if (hit) return withAttrs(hit.code, hit.title, base)
  const emb2 = extractEmbeddedCode(base)
  if (emb2) return withAttrs(emb2, (base.replace(emb2, '').replace(/\s+/g, ' ').trim() || base), base)
  /* 真·无番号：返回空 code（而非垃圾串），老老实实进「识别失败待处理」让用户在卡片里手填 */
  return { code: '', title: base, uncensored: false, cd: 0, subtitle: false }
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
/* ---------- 扫描稳定性/加速工具（2026-10-09） ----------
 * 背景：媒体库走 115 云盘等网络挂载，readdir/readFile/stat/open 在云盘休眠或抖动时会
 * 挂住数秒到数十秒，扫描期间任何一个单点 I/O 不返回，整条扫描就永久卡死（用户只能重启）。
 * 三件套解决：
 *   1) ioTimeout  —— 每个单点 I/O 套超时，超时降级为 null/fallback 继续，绝不阻塞整条扫描；
 *   2) poolMap     —— 有界并发（网盘并发读不能太高，否则雪崩），把串行 match 变成流水线；
 *   3) IMGSZ_CACHE —— 图片宽高按「路径+size+mtime」缓存，避免每次重扫都 open+read 头 64KB。 */

/* 超时兜底：promise 超时返回 fallback（默认 null），并对 late rejection 吞掉防 unhandledRejection。
 * 云盘挂载的 open/read/readdir 拿不到真实错误码，超时是最可靠的降级信号。 */
function ioTimeout(promise, ms, fallback = null) {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)          // 超时：降级，不抛错，让调用方用 fallback 继续
    }, ms)
    Promise.resolve(promise).then(
      v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback) } }  // 错误也降级为 fallback
    )
  })
}
/* 有界并发池：concurrency 个 worker 消费 items，逐个 await mapper(items[i], i)。
 * 用于 match 阶段（每部影片一组网盘读）。池大小固定，避免打爆网盘句柄。 */
async function poolMap(items, mapper, concurrency = 6) {
  const arr = Array.from(items)
  const out = new Array(arr.length)
  let idx = 0
  const workers = []
  const n = Math.max(1, Math.min(concurrency, arr.length))
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = idx++
        if (i >= arr.length) break
        out[i] = await mapper(arr[i], i)
      }
    })())
  }
  await Promise.all(workers)
  return out
}
/* 图片宽高缓存：fp -> {m: mtimeMs, s: size, w, h}。命中且 mtime/size 一致直接复用，不再 open+read。
 * 存内存（扫描间复用）；网盘上 open 一张图可能 1-3s，重扫 1294 部能省下可观的等待。 */
const IMGSZ_CACHE = new Map()
const IMGSZ_CACHE_MAX = 4096   // 超出按插入顺序淘汰最早的，防止无限增长
async function imgSizeCached(fp) {
  let st = null
  try { st = await ioTimeout(fsp.stat(fp), 4000, null) } catch (_) {}
  const m = st ? st.mtimeMs : 0, s = st ? st.size : 0
  const hit = IMGSZ_CACHE.get(fp)
  if (hit && hit.m === m && hit.s === s) return hit
  const r = await imgSizeAsync(fp)
  if (r) {
    if (IMGSZ_CACHE.size >= IMGSZ_CACHE_MAX) IMGSZ_CACHE.delete(IMGSZ_CACHE.keys().next().value)
    IMGSZ_CACHE.set(fp, { m, s, w: r.w, h: r.h })
  }
  return r
}

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
/* 异步版（扫描专用）：网盘挂载上 readdir 也可能卡数秒，主线程不能停。
 * 2026-09 之前是「两遍遍历」：walkAsync 只收视频、indexImgs 再收图片，同一棵目录树
 * readdir 两遍 —— 网盘上 readdir 是最贵的一步，等于扫描时间白翻一倍。
 * 现在合并成单遍：一次 readdir 同时分流「视频文件 / 图片 / NFO / extrafanart 子目录」，
 * 产出 snapshot = { 视频绝对路径[], dirs: {目录绝对路径 -> {imgs[], nfos[], samples[]}} }，
 * match 阶段直接查内存快照，不再二次读目录。
 * 并发：同层子目录并发 readdir（限并发，防止网盘句柄雪崩）；readdir 套超时，
 * 云盘卡住的目录降级为空后继续，不再永久阻塞整条扫描。
 * onDir/onFile 是扫描进度与取消的回调（每处理一个目录/文件调一次）。 */
const WALK_CONCURRENCY = 6        // 同层并发 readdir 数；网盘挂载不宜过高（FUSE 单通道，提高也无效）
const WALK_TIMEOUT_MS = 30000    // 单个目录 readdir 超时（云盘冷目录可能很慢，超时跳过该目录）
/* 目录级跳过：dircache 命中（目录 mtime 未变）时，直接复用上轮存下的目录快照，
 * 整个 readdir 都不做 —— 这是重扫提速的唯一有效手段（网盘 readdir 冷读 ~200ms 且无法并发加速）。
 * skipStat 决定是否走 stat 比对（顶层库目录强制 readdir，才能发现新增的子目录）。 */
async function walkAsync(dir, out = [], onDir, onFile, snapshot = null, dircache = null, skipStat = false) {
  /* 目录级缓存命中：mtime 未变 → 复用旧快照，跳过 readdir */
  if (snapshot && dircache && !skipStat) {
    const hit = dircache.get(dir)
    if (hit && hit.m && hit.snap) {
      try {
        const st = await ioTimeout(fsp.stat(dir), 8000, null)
        if (st && st.mtimeMs === hit.m) {
          /* 命中：把上轮快照原样搬进本轮 snapshot，视频直接进 out */
          if (onDir) onDir(dir)
          const snap = hit.snap
          snapshot.dirs.set(dir, snap)
          for (const fn of (hit.videos || [])) { const fp = path.join(dir, fn); out.push(fp); if (onFile) onFile(fp) }
          return out
        }
      } catch (_) {}
    }
  }
  const entries = await ioTimeout(fsp.readdir(dir, { withFileTypes: true }), WALK_TIMEOUT_MS, [])
  if (onDir) onDir(dir)
  const kids = []
  let newSnap = null, myVideos = null
  if (snapshot) {
    /* 单遍：一次 readdir 同时分流「视频 / 图片 / NFO / extrafanart 子目录」，视频照收不误 */
    const snap = { imgs: [], nfos: [], samples: [] }
    newSnap = snap; myVideos = []
    snapshot.dirs.set(dir, snap)
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_trash') continue
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'extrafanart') { kids.push({ fp, fanart: true }) } else { kids.push({ fp, fanart: false }) } }
      else {
        const ex = extOf(e.name)
        if (VIDEO_EXT.includes(ex)) { out.push(fp); myVideos.push(e.name); if (onFile) onFile(fp) }
        else if (IMG_EXT.includes(ex)) snap.imgs.push(fp)
        else if (ex === 'nfo') snap.nfos.push(fp)
      }
    }
    /* 记下本目录的视频文件名 + mtime（供下次 dirCache 命中时完全跳过 readdir） */
    if (dircache) {
      try {
        const st = await ioTimeout(fsp.stat(dir), 8000, null)
        if (st) dircache.set(dir, { m: st.mtimeMs, videos: myVideos, snap })
      } catch (_) {}
    }
  } else {
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_trash') continue
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) kids.push({ fp, fanart: false })
      else if (VIDEO_EXT.includes(extOf(e.name))) { out.push(fp); if (onFile) onFile(fp) }
    }
  }
  /* 同层并发下钻；fanart 子目录只收图片（剧照），不收视频也不递归更深 */
  const fanartDirs = kids.filter(k => k.fanart)
  const subDirs = kids.filter(k => !k.fanart)
  if (snapshot && fanartDirs.length) {
    for (const k of fanartDirs) {
      const es = await ioTimeout(fsp.readdir(k.fp, { withFileTypes: true }), WALK_TIMEOUT_MS, [])
      const parent = snapshot.dirs.get(dir)
      for (const e of es) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) continue
        if (IMG_EXT.includes(extOf(e.name))) parent.samples.push(path.join(k.fp, e.name))
      }
    }
  }
  await poolMap(subDirs, k => walkAsync(k.fp, out, onDir, onFile, snapshot, dircache), WALK_CONCURRENCY)
  return out
}

/* ---------- 扫描（后台异步 + 进度上报 + 可随时彻底取消，前端轮询 /api/scan 显示进度条） ----------
 * 取消语义：SCAN.cancel = true 是「请求取消」，scanAsync 在每个可中断点检查它，
 * 抛 CANCELLED 走 catch 统一收尾（清队列、不落盘半成品 DATA、不触发自动刮削、不自动续跑 pending）。
 * 这样取消后不留残根：队列里没轮到的番号不会被自动刮削，磁盘上的 scan-result.json 保持上一次完整结果。 */
const SCAN_CANCELLED = '已取消'
const SCAN = {
  running: false, phase: '', videos: 0, scanned: 0, matched: 0, okCount: 0, failCount: 0,
  startedAt: 0, finishedAt: 0, ms: 0, error: '', pending: false, cancel: false, cancelled: false,
  dirs: 0, found: 0, libsTotal: 0, libsDone: 0, current: '',
  dirsTotal: 0, videosTotal: 0,
  pendingScope: null,   // 扫描期间又来了新的 rescan(scope)：扫完按这个 scope 续跑（null = 全量）
  skippedSmall: 0   // 被「入库最小体积」挡掉的文件数（进度面板用来说明条目数为何少于视频数）
}
/* 扫描可中断点：取消时抛 SCAN_CANCELLED（区别于真错误），并且只在真正该中断时抛 */
function scScanCheck() { if (SCAN.cancel) throw new Error(SCAN_CANCELLED) }
/* 遍历递归内部的「该收手了」检查（网盘 walk 每进一个子目录问一次）。
 * ⚠ 必须是「扫描中 && 已请求取消」两个条件同时成立 —— 不能只看 SCAN.cancel：
 *   matchCode / 按番号搜索 / 预热这些**非扫描**调用方也走 davWalk / v115Walk，
 *   扫描结束后残留的 cancel 标记会把它们的无辜遍历拦腰砍断（结果静默变少，极难排查）。 */
function scWalkStopped() { return !!(SCAN.cancel && SCAN.running) }
function scScanReset() {
  SCAN.running = true; SCAN.error = ''; SCAN.cancel = false; SCAN.cancelled = false
  SCAN.phase = 'walk'; SCAN.videos = 0; SCAN.scanned = 0; SCAN.matched = 0; SCAN.okCount = 0; SCAN.failCount = 0
  SCAN.autoQueued = 0; SCAN.dirs = 0; SCAN.found = 0; SCAN.libsDone = 0; SCAN.current = ''
  SCAN.dirsTotal = 0; SCAN.videosTotal = 0   // 上一轮的规模，用来在 walk 阶段给出「估算百分比」（walk 阶段真实分母还不存在）
  SCAN.skippedSmall = 0
  SCAN.libsTotal = LIBS.length
  SCAN.startedAt = Date.now(); SCAN.finishedAt = 0
}
/* 请求取消（幂等）：不在扫描中也安全调用，返回当前状态让前端统一处理 */
function scScanCancel() {
  SCAN.pending = false          // 取消顺手撤掉「扫完自动再扫一遍」，否则取消后又自己跑起来
  SCAN.cancel = true
  if (!SCAN.running) SCAN.cancelled = true
  return { ok: true, running: SCAN.running, cancelled: SCAN.cancelled, error: SCAN.error }
}

/* ---------- 入库最小体积过滤（设置 → 刮削与整理） ----------
 * 扫盘时小于该体积的视频文件直接不收进影片库，挡掉花絮 / sample / 预览片段这类。
 * 单位 MB、1024 进制（与 magSizeMB 同口径）；空 / 0 / 非法 = 不过滤（默认，保持老行为）。
 * ⚠ 判据必须是 size > 0 && size < min：115 / WebDAV 条目偶尔列目录拿不到体积（记 0），
 *   若把 0 也算进去，那些条目会在配置一开就被整批误杀。 */
function scanMinBytes() {
  const mb = parseFloat(CFG.scanMinMb)
  if (!isFinite(mb) || mb <= 0) return 0
  return Math.round(mb * 1024 * 1024)
}
async function scanAsync(scope) {
  /* 定向扫描（scope = { roots: [{ kind:'v115'|'guangya'|'webdav', root }] }）：
   * 只 walk 收录进来的那几个网盘根，解析出条目后与既有结果合并落盘 —— 本地库与其它根一律不动。
   * 「收录新目录」和「目录旁的 ⟳ 扫描按钮」都走这条路；scope 为空 = 老的全量重扫。 */
  scope = (scope && Array.isArray(scope.roots) && scope.roots.length) ? scope : null
  const t0 = Date.now()
  scScanReset()
  /* 本轮扫描全程复用这一个快照：扫描是长任务，中途改设置不该让前后半程判据不一致 */
  const minB = scanMinBytes()
  const yieldLoop = () => new Promise(r => setImmediate(r))
  try {
    /* 单遍遍历（walk+index 合并）：一次 readdir 同时收集视频与目录媒体快照，
     * 目录树只读一遍、每个目录只 readdir 一次（原来 walkAsync + indexImgs 各读一遍，白翻一倍时间）。
     * 同层子目录并发下钻，readdir 有超时兜底 —— 云盘卡住的目录跳过而非整条卡死。 */
    const seen = new Set()
    const videos = []
    const snapshot = { dirs: new Map() }
    /* 目录级缓存：上轮存下的「目录 mtime + 完整快照」，本轮 mtime 未变的目录直接复用、不 readdir。
     * 这是重扫提速的关键（网盘 readdir 冷读 ~200ms 且 FUSE 单通道无法并发加速）。 */
    const dircache = loadDirCache()
    const dircacheOn = dircache.size > 0
    if (dircacheOn) console.log(`[scan] 载入目录缓存 ${dircache.size} 个目录（mtime 未变将跳过 readdir）`)
    const newDircache = new Map()
    /* walk 阶段（遍历目录）天然没有分母：目录总数要等这遍扫完才知道 → 进度条只能显示 0%。
     * 用「上一轮的规模」当估算分母，就能给出平滑推进的百分比（walk 占整次扫描耗时的大头，
     * 没有它整条进度条前半程是死的）。首轮无缓存时 dirsTotal 仍为 0，前端退回不确定态样式。 */
    try {
      const _prev = JSON.parse(fs.readFileSync(scanResultPath(), 'utf8'))
      if (_prev && typeof _prev === 'object') {
        SCAN.dirsTotal = Number(_prev.dirsTotal) || (Array.isArray(_prev.dirCache) ? 0 : Object.keys(_prev.dirCache || {}).length)
        SCAN.videosTotal = Number(_prev.videosTotal) || (Array.isArray(_prev.items) ? _prev.items.length : 0)
      }
    } catch (_) {}
    /* 两个来源的「纳入计数」提升到定向/全量分叉之前：定向扫描也走同一份统计，
     * 扫完的 [115] / [dav] 纳入日志两种模式都打（测试 _tdav 靠它断言）。 */
    let v115Count = 0
    let davCount = 0
    /* ---- 定向扫描：只 walk 指定的那几个网盘根（收录新目录 / 目录旁 ⟳ 按钮触发）----
     * 产出与全量 walk 完全同构的条目，V115_MAP / DAV_MAP 做**合并**而不是重建
     * （全量扫会把两个 MAP 清空重填；定向扫时其它根的条目还在用，动不得）。 */
    if (scope) {
      for (const sr of scope.roots) {
        if (SCAN.cancel) throw new Error(SCAN_CANCELLED)
        const nm = (sr.root && (sr.root.name || sr.root.path || sr.root.cid)) || '?'
        try {
          if (sr.kind === 'v115') {
            SCAN.current = '115：' + nm
            /* force=true：定向扫描是用户点名动作，要拿最新列表，不吃 10 分钟列目录快照 */
            for (const f of await v115Walk(sr.root, () => { SCAN.dirs++ }, true)) {
              V115_MAP.set(f.vpath, { pick: f.pick, size: f.size, mtime: f.mtime, name: f.name })
              if (seen.has(f.vpath)) continue
              seen.add(f.vpath); videos.push(f.vpath); v115Count++
              SCAN.found++; if (SCAN.found % 32 === 0) SCAN.videos = SCAN.found
            }
          } else if (sr.kind === 'guangya' || sr.kind === 'webdav') {
            SCAN.current = davLabel(sr.kind) + '：' + nm
            for (const f of await davWalk(sr.kind, sr.root, () => { SCAN.dirs++ }, true)) {
              DAV_MAP.set(f.vpath, { size: f.size, mtime: f.mtime, name: f.name })
              if (seen.has(f.vpath)) continue
              seen.add(f.vpath); videos.push(f.vpath); davCount++
              SCAN.found++; if (SCAN.found % 32 === 0) SCAN.videos = SCAN.found
            }
          } else { console.log('[scan] 定向扫描不支持的来源：' + sr.kind) }
        } catch (e) {
          console.log('[scan] 定向扫描「' + nm + '」失败：' + e.message)
          if (e && e.v115Blocked) { console.log('[115] 已进冷却，本次定向扫描停止'); break }
        }
        await yieldLoop()
      }
      console.log('[scan] 定向扫描：' + scope.roots.length + ' 个根，发现 ' + videos.length + ' 个视频文件（其余来源不重扫）')
    }
    if (!scope) for (let li = 0; li < LIBS.length; li++) {
      const lib = LIBS[li]
      SCAN.libsDone = li; SCAN.current = path.basename(lib) || lib
      /* 顶层库目录强制 readdir（skipStat=true）：必须列出子目录才能发现新增的影片目录 */
      for (const v of await walkAsync(lib, [], () => {
        SCAN.dirs++
        if (SCAN.cancel) throw new Error(SCAN_CANCELLED)
      }, () => { SCAN.found++; if (SCAN.found % 32 === 0) SCAN.videos = SCAN.found }, snapshot, newDircache, true)) {
        if (seen.has(v)) continue
        seen.add(v); videos.push(v)
      }
      SCAN.libsDone = li + 1
      await yieldLoop()
    }
    /* ---- 115 网盘来源：不是磁盘，走 API 列目录，产出与本地 walk 同构的条目 ----
     * vpath 统一是 `115:/<115内路径>`，进 videos[] 之后下游（番号解析 / 刮削 / 入库 / 详情页）
     * 全部复用同一套逻辑；只有「读文件」（stat / 取流）需要按前缀分流，见 matchOne 与 /media 路由。 */
    /* V115_MAP 全量扫每轮重建（pick 映射必须跟本轮条目一致），定向扫**保留**（其它根还在用）；
     * V115_SNAP 故意不重置 —— 它带 10 分钟有效期，多次扫描之间复用列目录结果，
     * 避免每次重扫都重打整棵网盘树（115 有 WAF 限速） */
    if (!scope) {
      V115_MAP = new Map()
      /* 多账号（2026-10-14）：每个账号各遍各的根（root.acct 带账号号，v115Walk 据此定前缀/Cookie）。
       * ⚠ 每个账号内用 v115WalkRoots()：嵌套的根只走最外层的那个（请求量减半，见函数注释） */
      for (const n115 of v115AcctList()) {
        if (!v115Ready(n115)) continue
        const allRoots = v115Roots(n115)
        const wroots = v115WalkRoots(allRoots)
        if (wroots.length < allRoots.length) {
          console.log('[115' + (n115 > 1 ? '@' + n115 : '') + '] 遍历时跳过了 ' + (allRoots.length - wroots.length) + ' 个被包含的根目录（避免重复请求同一棵子树）')
        }
        for (const root0 of wroots) {
          if (SCAN.cancel) throw new Error(SCAN_CANCELLED)
          const root = Object.assign({}, root0, { acct: n115 })
          SCAN.current = '115' + (n115 > 1 ? '@' + n115 : '') + '：' + (root.name || root.path || root.cid)
          try {
            for (const f of await v115Walk(root, () => { SCAN.dirs++ })) {
              V115_MAP.set(f.vpath, { pick: f.pick, size: f.size, mtime: f.mtime, name: f.name })
              if (seen.has(f.vpath)) continue
              seen.add(f.vpath); videos.push(f.vpath); v115Count++
              SCAN.found++; if (SCAN.found % 32 === 0) SCAN.videos = SCAN.found
            }
          } catch (e) {
            console.log('[115' + (n115 > 1 ? '@' + n115 : '') + '] 媒体库「' + (root.name || root.cid) + '」遍历失败：' + e.message)
            /* 被 WAF 拦了就收手：继续遍历剩下的目录只会喂满拦截，越喂冷却越久 */
            if (e && e.v115Blocked) { console.log('[115] 已进冷却，本次扫描跳过后面的网盘目录（本地文件继续）'); break }
          }
          await yieldLoop()
        }
      }
    }
    if (v115Count) console.log('[115] 本次扫描纳入 ' + v115Count + ' 个网盘视频文件')
    /* ---- WebDAV / 光鸭网盘来源：标准协议 PROPFIND 遍历，产出与本地/115 walk 同构的条目 ----
     * vpath 统一是 `dav:/<路径>` / `gy:/<路径>`，下游（番号解析/刮削/入库/详情页）全部复用同一套逻辑；
     * 只有「读文件」（取流）需要按前缀分流，见 matchOne 与 /media 路由（davServe 直接 Range 转发）。 */
    if (!scope) {
      /* 全量扫才重建 DAV_MAP；定向扫要**保留**它（其它根的映射还在用，见定向扫描块注释） */
      DAV_MAP = new Map()
      for (const davKind of DAV_KINDS) {
        for (const ndv of davAcctList(davKind)) {
          if (!davReady(davKind, ndv)) continue
          for (const root0 of davRoots(davKind, ndv)) {
            if (SCAN.cancel) throw new Error(SCAN_CANCELLED)
            const root = Object.assign({}, root0, { acct: ndv })
            SCAN.current = davLabel(davKind) + (ndv > 1 ? '@' + ndv : '') + '：' + (root.name || root.path)
            try {
              for (const f of await davWalk(davKind, root, () => { SCAN.dirs++ })) {
                DAV_MAP.set(f.vpath, { size: f.size, mtime: f.mtime, name: f.name })
                if (seen.has(f.vpath)) continue
                seen.add(f.vpath); videos.push(f.vpath); davCount++
                SCAN.found++; if (SCAN.found % 32 === 0) SCAN.videos = SCAN.found
              }
            } catch (e) {
              console.log('[' + davKind + (ndv > 1 ? '@' + ndv : '') + '] 媒体库「' + (root.name || root.path) + '」遍历失败：' + e.message)
              /* 账号不对就别把另外几个根也打一遍：同一份凭据，只会得到同一堆 401 */
              if (davAuthErr(e && e.message)) { console.log('[' + davKind + (ndv > 1 ? '@' + ndv : '') + '] 凭据无效，本次扫描跳过该来源剩余目录'); break }
            }
            await yieldLoop()
          }
        }
      }
    }
    if (davCount) console.log('[dav] 本次扫描纳入 ' + davCount + ' 个 WebDAV/光鸭 视频文件')
    /* 本轮实际 readdir 过的目录才进 newDircache；命中复用的目录沿用旧记录（mtime 未变，记录继续有效） */
    for (const [k, v] of dircache) if (!newDircache.has(k)) newDircache.set(k, v)
    DIRCACHE = newDircache
    SCAN.videos = videos.length
    SCAN.found = videos.length
    scScanCheck()
    const items = []
    const dataRoot = readMediaPathFile() || MEDIA_ROOT   // 渐进落盘用的 root（与扫描结束时的最终值一致）
    /* 重扫期间保留旧条目：scanAsync 从空 items[] 开始逐步 push，每 16 部直接挂进 DATA，
     * 导致重扫头几秒 DATA.items 只含新扫到的几十部 → 前端 LIB 被覆写为部分列表，旧影片全消失。
     * 现在先快照旧条目，渐进落盘时新条目按番号覆盖旧条目、没扫到的旧条目保留，
     * 用户重扫期间切页面回来看到的 LIB 始终包含原来已有的影片。
     * ★ 增量扫描复用：_priorMap 同时是「未变影片直接复用上次结果」的来源（见 matchOne）。 */
    const _priorMap = new Map()
    if (DATA && Array.isArray(DATA.items)) {
      for (const it of DATA.items) _priorMap.set(bare(it.code), it)
    }
    /* 复用上次磁盘扫描结果（含指纹），用于增量：指纹未变的影片跳过全部网盘 I/O。
     * 内存 DATA 已被用户手动编辑/刮削覆盖的条目不参与复用（以 _priorMap 里的现值为准）。 */
    const _savedMap = new Map()
    try {
      const saved = loadScanResult()
      if (saved && Array.isArray(saved.items)) {
        for (const it of saved.items) { if (it && it.relVideo) _savedMap.set(it.relVideo, it) }
      }
    } catch (_) {}
    /* 定向扫描：既有条目原样保留进 items（本轮只解析 scope 根下的文件），
     * 但**排除**本轮 walk 到的那些 relVideo —— 它们走下面的增量流水线
     * （指纹没变 → 复用、变了 → 重 match），否则既进 seed 又进 items 就是重复条目。 */
    const _scopedSet = scope ? new Set(videos) : null
    if (_scopedSet) {
      for (const [rv, it] of _savedMap) if (!_scopedSet.has(rv)) items.push(it)
      console.log('[scan] 定向扫描：保留既有条目 ' + items.length + ' 个')
    }

    /* 图片索引改由 walk 阶段的 snapshot 提供（单遍遍历），此处不再二次 readdir 整棵目录树。
     * 保留 dirImgs 形参与取值路径，matchOne 直接查 snapshot.dirs。 */
    scScanCheck()

    SCAN.phase = 'match'
    PROBE_TASKS.clear(); VPROBE_OFF = false; PROBE_SLOW = 0   // 每次扫描重试熔断（网盘可能已恢复）
    const MANUAL_CODES = loadManualCodes()   // 手动指定的番号覆盖（relVideo → code），重扫后仍生效

    /* 单部影片的完整解析（一次 match）。所有网盘读都走目录快照 + 缓存 + 超时，
     * 不再对同目录重复 readdir：图片/NFO/剧照都来自 walk 阶段的 snapshot.dirs。 */
    const rel = fp => path.relative(MEDIA_ROOT, fp).split(path.sep).join('/')
    async function matchOne(vp) {
      const is115 = v115Rel(vp)
      const isDav = davRel(vp)
      const dir = (is115 || isDav) ? '' : path.dirname(vp)   // 网盘条目没有本地目录（图片/NFO 走全库同番号回退）
      const p = parseName(vp)
      /* 网盘条目的 relVideo 就是 vpath 本身 —— path.relative 会把 'gy:/…' / 'dav:/…'
       * 当成「非盘符根的相对路径」按 cwd 去解析，拼出 ..\..\ 垃圾（播放/续扫全对不上） */
      const relVideo = (is115 || isDav) ? vp : path.relative(MEDIA_ROOT, vp).split(path.sep).join('/')
      const manualCode = MANUAL_CODES[relVideo]
      const code = norm(manualCode || p.code), ccode = bare(code)
      const dn = bare(path.basename(dir))
      const codeIn = fp => bare(baseOf(fp)).includes(ccode) || dn.includes(ccode)
      /* 目录快照取图片；本目录没有再全库找同番号图片（沿用旧行为） */
      const dsnap = snapshot.dirs.get(dir) || { imgs: [] }
      const imgs = dsnap.imgs.slice().sort((a, b) => codeIn(b) - codeIn(a))
      if (!imgs.length)
        for (const [, s] of snapshot.dirs) for (const x of s.imgs) { if (codeIn(x) && !imgs.includes(x)) imgs.push(x) }
      let fan = imgs.find(x => { const n = norm(path.basename(x)); return n.includes('FANART') || n.includes('THUMB') })
      let post = imgs.find(x => { const n = norm(path.basename(x)); return n.includes('POSTER') || n.includes('COVER') })
      if (!fan && !post) {
        /* 横竖判定走缓存（IMGSZ_CACHE 按 mtime+size 命中就不再 open+read），仍串行但通常直接命中 */
        for (const im of imgs) { const s = await imgSizeCached(im); if (s && s.w > s.h) { fan = im; break } }
        if (!fan) for (const im of imgs) { const s = await imgSizeCached(im); if (s && s.w <= s.h) { post = im; break } }
      }
      /* NFO：直接用目录快照（原来每部都 readdir(dir)，同目录几十部 = 几十次重复 readdir） */
      const nfos = dsnap.nfos || []
      const nfoFile = nfos.find(x => bare(baseOf(x)).includes(ccode)) || (nfos.length === 1 ? nfos[0] : null)
      let meta = {}
      if (nfoFile) { try { meta = parseNfoText(await ioTimeout(fsp.readFile(nfoFile, 'utf8'), 15000, '')) } catch (_) {} }
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
      // 剧照：目录内 extrafanart（javbus 刮削惯例）—— 已在 walk 阶段收集进快照
      const samples = dsnap.samples || []
      /* stat 优先用增量阶段已取好的结果（stMap），没有再单独 stat（带超时）
       * 115 条目：磁盘上没有对应文件，stat 只能取列目录时记下的 size/mtime */
      let st = stMap.get(vp) || null
      if (!st && is115) { const m = V115_MAP.get(vp); st = m ? { size: m.size || 0, mtimeMs: m.mtime || 0 } : null }
      if (!st && isDav) { const m = DAV_MAP.get(vp); st = m ? { size: m.size || 0, mtimeMs: m.mtime || 0 } : null }
      if (!st && !is115 && !isDav) { try { st = await ioTimeout(fsp.stat(vp), 8000, null) } catch (_) {} }
      /* 体积过滤点：walk 阶段只 readdir、拿不到体积，走到这里 st 已经在手
       * （本地是刚 stat 的、115 来自列目录），判一次零额外 I/O。
       * 放这里而不是 walk 里，就是为了不给网盘挂载额外加一次 stat —— 那是最贵的一步。 */
      if (minB > 0 && st && st.size > 0 && st.size < minB) { SCAN.skippedSmall++; return null }
      const it = {
        code, title: meta.title || p.title,
        /* mdc-ng 对齐：破解/碟片/字幕作为独立属性（不污染 code）。-U→uncensored，B/C/D→cd，C→subtitle */
        uncensored: !!p.uncensored, cd: p.cd || 0, subtitle: !!p.subtitle,
        plot: meta.plot || '', year: meta.year || '', studio: meta.studio || '',
        actors: meta.actors || [], genres,
        relVideo,
        /* 115 条目的取流凭据：写进条目（落 scan-result.json），播放时靠它换直链 */
        pick: is115 ? ((V115_MAP.get(vp) || {}).pick || '') : undefined,
        relFanart: fan ? rel(fan) : null,
        relPoster: post ? rel(post) : null,
        relSamples: samples.map(rel),
        size: (st && st.size) || 0, mtime: (st && st.mtimeMs) || 0,
        /* 指纹：供下次重扫做增量（size+mtime 变了就重新 match，没变直接复用） */
        fp: ((st && st.size) || 0) + ':' + ((st && st.mtimeMs) || 0)
      }
      if (it.relFanart || it.relPoster) SCAN.matched++
      /* 115 文件不落本地盘，无法解析 moov 取分辨率 → 跳过探测（标签退化为按文件名判定） */
      const pv = is115 ? null : await probeKick(it.relVideo)
      it.tags = videoTagsOf(baseOf(vp) + ' ' + (meta.title || '') + ' ' + (meta.genres || []).join(' '), pv ? pv.w : 0, pv ? pv.h : 0)
      enrichFromCache(it)   // 缓存里的刮削元数据回填（补空字段 + scraped 标记）
      // 识别失败待处理：没有 nfo 标题、缓存里也没刮到元数据的视频（标题只是文件名解析结果）
      it.pending = !it.scraped && !it.scrapeTitle && !(meta.title || '').trim()
      if (it.pending) SCAN.failCount++; else SCAN.okCount++
      return it
    }

    /* 增量调度：指纹（size+mtime）未变且 relVideo 命中的影片 → 直接复用上次 item，跳过全部网盘 I/O。
     * 复用时 enrichFromCache 重跑一次，保证离线缓存里新刮的元数据能生效（与全量一致）。
     * 指纹比对所需的 stat 本身也是网盘 I/O，故并发执行（限流），并把 stat 结果 stMap 传给
     * matchOne 复用，避免未命中项 stat 两次。 */
    let reused = 0, rematched = 0
    const todo = []      // 需要完整 match 的影片绝对路径
    const stMap = new Map()   // vp -> stat 结果（增量比对 + matchOne 共用，避免重复 stat）
    const STAT_CONCURRENCY = 8
    await poolMap(videos, async (vp) => {
      const is115 = v115Rel(vp)
      const isDav = davRel(vp)
      /* 网盘条目的 relVideo 就是 vpath 本身（path.relative 对 'gy:/…' 会拼出垃圾，见 matchOne 注释） */
      const relVideo = (is115 || isDav) ? vp : path.relative(MEDIA_ROOT, vp).split(path.sep).join('/')
      const saved = _savedMap.get(relVideo)
      let st = null
      if (is115) {
        /* 115 条目：size/mtime 来自列目录结果，不必也不该去 stat（磁盘上根本没这个文件） */
        const m = V115_MAP.get(vp)
        st = m ? { size: m.size || 0, mtimeMs: m.mtime || 0 } : null
      } else if (isDav) {
        /* 光鸭/WebDAV 条目同理：size/mtime 取列目录结果（DAV_MAP），不去 stat 虚拟路径 */
        const m = DAV_MAP.get(vp)
        st = m ? { size: m.size || 0, mtimeMs: m.mtime || 0 } : null
      } else {
        try { st = await ioTimeout(fsp.stat(vp), 8000, null) } catch (_) {}
      }
      stMap.set(vp, st)
      const fp = ((st && st.size) || 0) + ':' + ((st && st.mtimeMs) || 0)
      if (saved && saved.fp && saved.fp === fp && saved.code) {
        try {
          /* 复用上次结果，保留 fp（落盘需要，下轮增量比对也靠它）；快照已由 walk 阶段拿到，零额外网盘 I/O */
          const reuse = { ...saved }
          reuse.fp = fp
          enrichFromCache(reuse)         // 新刮的元数据立即生效
          /* 复用阶段顺手「番号再识别」：旧解析器曾把噪声文件名误判成垃圾 code
           * （如 2048.hk@GOJU-317.restored → "2048 hk GOJU-317 r"），导致这类待处理项永远刮不到。
           * 趁复用一次性纠正：旧 code 不干净、但能从文件名捞出干净番号、且用户没手填过时 → 改正并清掉
           * 旧刮削标记，后续自动刮削队列会用新番号重新刮。手动指定过的番号（MANUAL_CODES）不动。 */
          if (!MANUAL_CODES[relVideo] && !isCleanCode(reuse.code)) {
            try {
              const dvp = (is115 || isDav) ? vp : (MEDIA_ROOT ? path.join(MEDIA_ROOT, relVideo) : relVideo)
              const derived = parseName(dvp).code
              if (derived && isCleanCode(derived) && norm(derived) !== norm(reuse.code || '')) {
                reuse.code = norm(derived)
                reuse.scraped = false; reuse.scrapeTitle = ''
                reuse.pending = !(reuse.title || '').trim()
              }
            } catch (_) {}
          }
          reuse.pending = !reuse.scraped && !reuse.scrapeTitle && !(reuse.title || '').trim() ? true : reuse.pending
          /* 复用件也要重判体积：上次入库时阈值可能更松，这轮收紧了就得挡掉。
           * size 早已在复用件里（fp 就是 size:mtime），零额外 I/O。 */
          if (minB > 0 && reuse.size > 0 && reuse.size < minB) { SCAN.skippedSmall++; SCAN.scanned = reused + rematched; return }
          items.push(reuse); reused++
          /* ⚠ 复用件也必须计入 scanned。原来只在 matchOne 之后累加，于是「全量命中缓存」
           * （todo 为 0、增量扫描的常态）时 scanned 恒为 0 → 进度条卡在 0% 直到扫完才跳100。
           * 这正是用户看到的「百分比不动」。 */
          SCAN.scanned = reused + rematched
          return
        } catch (_) { /* 复用出错就退回完整 match */ }
      }
      todo.push(vp)
    }, STAT_CONCURRENCY)
    flushProgress()   // 复用件先进 DATA，前端立刻能看到大部分影片（不等 rematch）
    if (reused || todo.length)
      console.log(`[scan] 增量：复用未变 ${reused} 部，需重新解析 ${todo.length} 部`)

    /* 待匹配项并发执行（限并发，防网盘句柄雪崩）；取消时立刻停。
     * flushProgress 复用渐进落盘逻辑：每完成 16 部把 items 挂进 DATA，前端边扫边看。 */
    function flushProgress() {
      const merged = new Map(_priorMap)
      for (const it of items) merged.set(bare(it.code), it)
      DATA = { root: dataRoot, generated: Date.now(), items: [...merged.values()] }
    }
    const MATCH_CONCURRENCY = 6
    await poolMap(todo, async (vp, idx) => {
      if (SCAN.cancel) throw new Error(SCAN_CANCELLED)   // 取消检查：抛出会被上层 catch 收尾
      SCAN.current = path.basename(vp)
      const it = await matchOne(vp)
      /* rematched 先加：它表示「处理过的视频数」，要和 SCAN.videos（分母）对齐，
       * 被体积过滤掉的文件也算处理过 —— 否则进度条会停在 100% 之前不动。 */
      rematched++
      SCAN.scanned = reused + rematched
      if (!it) return   // 体积过滤命中：这个文件不收进影片库（matchOne 返回 null）
      /* ⚠ 必须入列！这行丢了 = 匹配结果全被扔掉，新文件永远进不了影片库
       * （旧库全靠「指纹未变→复用」那条路撑着，所以一直没暴露 —— 2026-10-14 定向扫描实测抓到）。 */
      items.push(it)
      /* 渐进落盘节奏：每 64 部刷一次（原来 16）。配合前端稳定 lid（libStableLid），
       * 扫描期海报墙只做「增量追加」，不重排不换色不闪跳 —— 节奏放缓进一步减少可见抖动。 */
      if (items.length % 64 === 0) { flushProgress(); await yieldLoop() }
    }, MATCH_CONCURRENCY)
    SCAN.scanned = items.length
    scScanCheck()
    console.log(`[scan] ${items.length} 个影片，封面匹配 ${items.filter(x => x.relFanart || x.relPoster).length}，耗时 ${Date.now() - t0}ms`)
    if (SCAN.skippedSmall) console.log(`[scan] 入库最小体积过滤：跳过 ${SCAN.skippedSmall} 个文件（阈值 ${CFG.scanMinMb} MB）`)
    /* 离线缓存兜底展示：还没配置媒体库（或扫到 0 部）时，用离线缓存里的条目做纯在线展示
     * （首次部署没挂媒体也能看到示例影片/已刮削条目，详情页在线播放、演员、系列都可用）。
     * 配上自己的媒体库并扫出内容后，这些条目自动让位。 */
    if (!items.length) {
      items.push(...bootOfflineCache())
      if (items.length) console.log('[scan] 未配置媒体库/扫到 0 部 → 展示离线缓存条目 ' + items.length + ' 部（示例与已刮削数据，纯在线浏览）')
    }
    /* 扫描完成 / 启动恢复后，把「还没刮过」的影片排队进后台刮削队列（设置页可关，默认开）。
     * 抽成函数，扫描完成和 app 启动恢复两条路径都调用（见文件底部 boot 段）。两类「还没刮过」：
     *   ① 识别失败待处理（无 nfo 标题）且番号可解析；② 有 nfo 标题但**没有海报图**的
     *   （relPoster/webPoster 都没有）—— 海报墙封面空缺的大头。缓存里已刮过的（m.scraped）
     *   不算，直接跳过。⚠ 回填口径见 enrichFromCache：只补空字段，本地 nfo 标题/简介不覆盖。 */
    autoQueueMissingCovers(items, '扫描')
    // root 显示用户配置的真实路径：容器里 MEDIA_ROOT 是挂载点（如 /media），
    // 对用户没意义，优先读 media-path.txt 里写的宿主机完整路径
    /* 保留旧网盘条目：Cookie 失效/风控导致遍历失败时，不删除已有 115/光鸭/WebDAV 条目。
     * 这样换 Cookie 后无需重扫即可恢复显示，避免反复扫盘触发 115 风控。
     * 本地文件不保留（本轮没扫到 = 确实被删/移走了）。 */
    const finalItems = items.slice()
    const seenRels = new Set(items.map(it => it.relVideo).filter(Boolean))
    for (const [rv, it] of _savedMap) {
      if (seenRels.has(rv)) continue
      if (v115Rel(rv) || davRel(rv)) {
        finalItems.push(it)
      }
    }
    if (finalItems.length > items.length) {
      console.log('[scan] 保留旧网盘条目 ' + (finalItems.length - items.length) + ' 个（未在本轮遍历中命中，Cookie/风控导致）')
    }
    finalItems.sort((a, b) => b.mtime - a.mtime)
    DATA = { root: readMediaPathFile() || MEDIA_ROOT, generated: Date.now(), items: finalItems }
    saveScanResult()   // 落盘：容器重建/更新后重启不必重扫云盘也能立刻显示影片库
    vprobeFlush()   // 分辨率探测结果落盘，重扫不重复解析
    /* 用 DIRCACHE.size 而不是 SCAN.dirs：目录缓存命中的目录不会触发 onDir 回调，
     * SCAN.dirs 只统计「本轮真readdir 过的」，会随缓存命中率上升而缩水，
     * 拿它当下一轮的分母会让估算百分比虚高。 */
    saveDirCache(DIRCACHE, { dirs: DIRCACHE.size, videos: SCAN.videos })   // 目录级缓存落盘：下次重扫 mtime 未变的目录可跳过 readdir；顺带记下本轮规模供下次估算进度
  } catch (e) {
    /* 取消不是错误：不写半成品 DATA、不落盘、不排自动刮削、不续跑 pending。
     * 磁盘上的 scan-result.json 与内存 DATA 保持「上一次完整结果」，取消是无残留的。 */
    if (e && e.message === SCAN_CANCELLED) {
      SCAN.cancelled = true; SCAN.error = ''
      console.log(`[scan] 已取消（已处理 ${SCAN.scanned}/${SCAN.videos}，用时 ${Date.now() - t0}ms），保留上一次扫描结果`)
    } else {
      SCAN.error = e.message
      console.log('[scan] error:', e.message)
    }
  }
  SCAN.ms = Date.now() - t0
  SCAN.phase = SCAN.cancelled ? 'cancelled' : 'done'
  SCAN.finishedAt = Date.now()
  SCAN.running = false
  SCAN.current = ''
  if (!SCAN.cancelled) schedulePreviews()   // 扫描完成 → 给新建档的实体影片安排悬停预览生成（低负担串行）
  /* 扫描中又有人添加/删除了媒体库 → 立刻按新列表再扫一遍（否则改动要等下次手动重扫）。
   * ⚠ 用户点了取消就不许自己再跑起来（scScanCancel 已把 pending 清掉，这里再兜一层）。 */
  if (SCAN.pending && !SCAN.cancelled) { SCAN.pending = false; const _ps = SCAN.pendingScope; SCAN.pendingScope = null; setTimeout(() => { if (!SCAN.running) scanAsync(_ps) }, 250) }
  /* 扫描完了再补网盘片源的分辨率（并发 2 慢慢跑，不阻塞界面）：
   * 云盘条目磁盘上没文件，扫描时探不了，只能等拿到条目清单后走本机代理逐个 ffprobe。 */
  if (!SCAN.cancelled) setTimeout(() => { resBackfillRun('扫描后').catch(() => {}) }, 3000)
}

/* ---------- HTTP ---------- */
let DATA = null

/* MEDIA_ROOT 动态基准统一：原生模式下媒体根会随已配置库变化（commonAncestor(LIBS)），
 * 但已扫描出的 relVideo / relPoster 是相对「扫描时的根」存的。一旦两者层级不一致
 * （比如库从「/a/b」缩到「/a/b/c」或反之、或换过媒体库父目录），所有 relVideo 解码都会
 * 多/少一层目录 → 封面与视频全部打不开，看起来像「文件不显示 / 媒体库逻辑坏掉」。
 * 这里让 MEDIA_ROOT 永远 = 已扫数据根（DATA.root）与当前库的共同祖先，覆盖所有 relVideo 的真实基准：
 * 不重扫也能正确解析历史条目，加/删库、重扫后基准也保持一致。 */
function recomputeMediaRoot() {
  if (!NATIVE) return
  const roots = LIBS.map(String)
  /* DATA.root 来自 scan-result.json，同样要过形态校验：脏基准一旦混进来，
   * 运行时的 MEDIA_ROOT 会被悄悄带偏（表格里所有 relVideo 解码错位），而且全程无日志。 */
  const dr = saneRoot(DATA && DATA.root)
  /* 除了形态合法，还得真的包住当前所有库（hintFits）—— 否则跨盘提示会把媒体根拽回 SystemDrive，
   * 库内文件的 relVideo 变成跨盘绝对路径，播放/封面被路径校验挡掉（见 hintFits 注释）。 */
  if (dr && hintFits(dr, LIBS)) roots.push(dr)
  else if (DATA && DATA.root) console.log('[media] 忽略不可用的已扫数据根 ' + JSON.stringify(String(DATA.root)) +
    (!dr ? '（路径形态非法）' : '（不包含已配置的媒体库，会带偏媒体根）'))
  const ca = roots.length ? commonAncestor(roots)
    : (process.env.JP_MEDIA_ROOT || (process.platform === 'win32' ? 'C:\\' : '/'))
  if (ca) MEDIA_ROOT = ca
}

/* ---------- 扫描结果落盘 / 恢复 ----------
 * 扫描结果过去只在内存里：容器重建（每次发版）或重启后影片库会「空掉」，
 * 只剩离线数据里的虚拟条目，必须手动重扫才有本地影片。现在把结果写进
 * cache/scan-result.json，启动时直接恢复 —— 云盘目录树不用重走一遍。
 * 只存条目（含 relVideo/files 播放信息），不存图片二进制；文件被删/改名由重扫纠正。 */
function scanResultPath() { return path.join(cacheDir(), 'scan-result.json') }
/* ---------- 目录级扫描缓存（v0.3.10，网盘重扫加速的关键） ----------
 * 实测（CloudDrive/115 挂载）：单个子目录 readdir 冷读约 200ms，且 FUSE 挂载是单通道串行的，
 * 提高 Node 并发度**毫无收益**（并发 6 与并发 24 实测同为 ~204ms/目录）。
 * 所以重扫 1294 部的 walk 阶段要 ~280s 是硬成本 —— 除非**根本不去 readdir 那些没变过的目录**。
 * 方案：上轮扫描把「每个目录的 mtime + 该目录的视频文件列表」存进 scan-result.dirCache；
 * 本轮 walk 时对每个子目录先 stat（远快于 readdir），mtime 未变就直接复用旧文件列表，
 * 跳过 readdir + 跳过快照构建 + 跳过逐文件 stat（条目本身带指纹可复用）。
 * mtime 变了的目录才真正 readdir 并重解析。
 * 风险控制：mtime 相同但内容变了的极端情况（手动改文件名不改目录 mtime）会漏检，
 * 用户手动重扫两次即可纠正；正常新增/删除文件都会更新目录 mtime。 */
let DIRCACHE = new Map()      // 目录绝对路径 -> { m: mtimeMs, files: [文件名...] }
function loadDirCache() {
  try {
    const d = JSON.parse(fs.readFileSync(scanResultPath(), 'utf8'))
    const dc = d && d.dirCache
    const m = new Map()
    if (dc && typeof dc === 'object') for (const k of Object.keys(dc)) {
      const v = dc[k]
      if (v && typeof v.m === 'number' && Array.isArray(v.videos) && v.snap) m.set(k, v)
    }
    return m
  } catch (_) { return new Map() }
}
function saveDirCache(dc, totals) {
  if (!dc || !dc.size) return
  try {
    const fp = scanResultPath()
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const obj = {}
    for (const [k, v] of dc) obj[k] = v
    d.dirCache = obj
    /* 记下本轮规模：下一轮walk 阶段要靠它当估算分母，否则遍历时进度条恒为 0% */
    if (totals && typeof totals === 'object') {
      d.dirsTotal = Number(totals.dirs) || 0
      d.videosTotal = Number(totals.videos) || 0
    }
    const t = fp + '.tmp'
    fs.writeFileSync(t, JSON.stringify(d))
    fs.renameSync(t, fp)
  } catch (e) { console.log('[scan] 目录缓存落盘失败：' + e.message) }
}
function saveScanResult() {
  try {
    if (!DATA || !Array.isArray(DATA.items) || !DATA.items.length) return
    fs.mkdirSync(path.dirname(scanResultPath()), { recursive: true })
    /* ⚠ 必须 temp + rename（原子替换），不能直接覆盖写整库索引。
     * 这个函数在刮削流程里被高频调用（每刮完一部一次、每 30 条 netres 一次），
     * 索引是好几百 KB 的 JSON；直接覆盖写时若进程被杀 / 断电 / 磁盘满，
     * scan-result.json 就是**半截文件** → 下次启动 loadScanResult() 解析失败返回 null
     * → 影片库一片空白，用户只能整盘重扫。同文件的 saveDirCache() 早就是原子写了，
     * 这里漏掉了。rename 在同分区上是原子的，最坏情况也只是丢掉这一次的更新。 */
    const fp = scanResultPath()
    const t = fp + '.tmp'
    fs.writeFileSync(t, JSON.stringify({
      root: DATA.root, generated: DATA.generated, savedAt: Date.now(),
      libraries: Array.isArray(CFG.libraries) ? CFG.libraries : [], items: DATA.items
    }))
    fs.renameSync(t, fp)
  } catch (e) { console.log('[scan] 结果落盘失败：' + e.message) }
}
function loadScanResult() {
  try {
    const d = JSON.parse(fs.readFileSync(scanResultPath(), 'utf8'))
    return (d && Array.isArray(d.items)) ? d : null
  } catch (_) { return null }
}

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
    /* 没 ffmpeg 就别试：execFile 每失败一次都是一次进程启动 + 一次媒体路径探测，
     * 在 CloudDrive/FUSE 上这些都要排队，会把正在播的视频拖卡。*/
    if (FFMPEG_OK === false) { st.status = 'error'; return }
    st.dur = await new Promise(resolve => {
      execFile(ffBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', fp], { timeout: 30000 }, (e, so) => {
        if (e && e.code === 'ENOENT') FFMPEG_OK = false
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
        execFile(ffBin('ffmpeg'), ['-ss', at.toFixed(1), '-i', fp, '-frames:v', '1', '-vf', 'scale=168:-2', '-q:v', '7', '-y', out],
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

function rescan(scope) {
  SCAN.cancel = false; SCAN.cancelled = false   // 新一轮扫描清掉上次的取消标记
  if (SCAN.running) { SCAN.pending = true; SCAN.pendingScope = scope || null; return }   // 已在扫描中 → 记一笔，扫完自动再扫
  scanAsync(scope)
}
/* ---------- 媒体源统计（/api/sources/media，2026-10-13） ----------
 * ⚠ 不能叫 /api/sources —— 那个已被「刮削站点列表」占用（外层路由拦截，handleActorApi 摸不到）。
 * 「媒体源」卡片的数据源：本地存储 / 115 网盘各一张卡，统计各自名下的影片数、封面数、
 * 预览视频数、视频段数（成/败）与缓存占用。归属：relVideo 以 115:/ 开头 = 115，其余 = 本地。
 * 目录体量递归 stat 有成本（cache 约 100~300MB、上千文件），结果缓存 60s；写操作后前端带 ?fresh=1 绕过。 */
function srcDirSize(dir, depth) {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) { if (depth > 0) n += srcDirSize(fp, depth - 1) }
      else { try { n += fs.statSync(fp).size } catch (_) {} }
    }
  } catch (_) {}
  return n
}

/* ---------- 目录统计记忆（2026-10-15 性能）----------
 * 重建 sourcesPayload 要逐部遍历 1050 部影片的 images/（**实测 744ms**），但图片目录只在刮削入库
 * 时才变化 —— 用目录 mtime 当失效判据：mtime 没变直接复用上次的「条目数 / 占用」，变了才重算。
 * 记忆落盘（cache/src-dirmemo.json），重启后依然有效；否则每次开 app 的第一次重建都要重走一遍。 */
const SRC_MEMO_PATH = () => path.join(cacheDir(), 'src-dirmemo.json')
const SRC_DIR_MEMO = new Map()      // 绝对路径 -> { mt, count, bytes }
let SRC_MEMO_DIRTY = false
let SRC_MEMO_TIMER = null
function srcMemoLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(SRC_MEMO_PATH(), 'utf8'))
    if (j && j.v === 1 && j.d && typeof j.d === 'object') for (const k in j.d) SRC_DIR_MEMO.set(k, j.d[k])
  } catch (_) {}
}
function srcMemoSaveSoon() {
  if (SRC_MEMO_TIMER) return
  SRC_MEMO_TIMER = setTimeout(() => {
    SRC_MEMO_TIMER = null
    if (!SRC_MEMO_DIRTY) return
    SRC_MEMO_DIRTY = false
    try {
      const d = {}
      for (const [k, v] of SRC_DIR_MEMO) d[k] = v
      fs.mkdirSync(path.dirname(SRC_MEMO_PATH()), { recursive: true })
      fs.writeFileSync(SRC_MEMO_PATH(), JSON.stringify({ v: 1, d }))
    } catch (_) {}
  }, 3000)
  if (SRC_MEMO_TIMER.unref) SRC_MEMO_TIMER.unref()
}
/* 目录「条目数（不含 . 开头）+ 占用」：mtime 相同直接命中记忆；目录不存在记 0 */
function srcDirStat(dir, depth) {
  let mt = 0
  try { mt = fs.statSync(dir).mtimeMs } catch (_) { return { mt: 0, count: 0, bytes: 0 } }
  const hit = SRC_DIR_MEMO.get(dir)
  if (hit && hit.mt === mt) return hit
  let count = 0, bytes = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name)
      if (!/^\./.test(e.name)) count++          // 条目数：与原实现一致，不计 . 开头（images/ 里只有 .DS_Store 时算「没封面」）
      if (e.isDirectory()) { if (depth > 0) bytes += srcDirSize(fp, depth - 1) }
      else { try { bytes += fs.statSync(fp).size } catch (_) {} }   // 占用：与 srcDirSize 完全一致（含 . 开头的文件）
    }
  } catch (_) {}
  const rec = { mt, count, bytes }
  SRC_DIR_MEMO.set(dir, rec)
  SRC_MEMO_DIRTY = true
  srcMemoSaveSoon()
  return rec
}

/* ---------- 整个 cache 目录的占用：后台异步维护（2026-10-15 性能）----------
 * srcDirSize(cache, 4) 要遍历 2218 个番号目录（**实测 1806ms**），而且是同步跑 —— 会把 Node 事件循环
 * 整整卡住两秒，这期间主页的 data.json、队列轮询等所有请求都在排队（用户感受就是「开软件要好久」）。
 * 改成后台分片遍历（每 16 个目录让出一次事件循环），请求路径只读现成数字；10 分钟内不重复遍历。 */
let SRC_TOTAL_BYTES = 0
let SRC_TOTAL_AT = 0
let SRC_TOTAL_BUSY = false
const SRC_TOTAL_TTL = 10 * 60 * 1000
async function srcTotalBytesRefresh() {
  if (SRC_TOTAL_BUSY) return
  SRC_TOTAL_BUSY = true
  try {
    let n = 0, i = 0
    const stack = [[cacheDir(), 4]]
    while (stack.length) {
      const [d, dep] = stack.pop()
      let ents
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { continue }
      for (const e of ents) {
        const fp = path.join(d, e.name)
        if (e.isDirectory()) { if (dep > 0) stack.push([fp, dep - 1]) }
        else { try { n += fs.statSync(fp).size } catch (_) {} }
      }
      if ((++i & 15) === 0) await new Promise(r => setImmediate(r))   // 让出事件循环，别卡住别的请求
    }
    SRC_TOTAL_BYTES = n
    SRC_TOTAL_AT = Date.now()
  } catch (_) {} finally { SRC_TOTAL_BUSY = false }
}
/* 请求路径只读数字：没算过 / 超过 10 分钟 / 用户点「刷新容量与统计」→ 顺手踢一次后台重算（**绝不同步等**） */
function srcTotalBytes(force) {
  if (force || !SRC_TOTAL_AT || Date.now() - SRC_TOTAL_AT > SRC_TOTAL_TTL) srcTotalBytesRefresh().catch(() => {})
  return SRC_TOTAL_BYTES
}

const SRC_TTL = 60 * 1000
let SRC_CACHE = { at: 0, data: null }
let SRC_REBUILDING = false   // stale-while-revalidate 的后台重建去重旗标（2026-10-15）
function sourcesPayload(forceTotal) {
  const mroot = path.join(cacheDir(), 'movies')
  /* 磁盘上的番号目录名 = 番号原样（只替换非法字符，保留连字符），但历史数据大小写/连字符可能有出入 → 两级索引 */
  const dirs = {}
  try { for (const d of fs.readdirSync(mroot)) { if (fs.statSync(path.join(mroot, d)).isDirectory()) dirs[d.toLowerCase()] = d } } catch (_) {}
  const dirOf = code => {
    const s = String(code || '').replace(/[^\w.-]/g, '_')
    if (dirs[s.toLowerCase()]) return dirs[s.toLowerCase()]
    const b = bare(s)
    if (b) { for (const k in dirs) { if (bare(k) === b) return dirs[k] } }
    return ''
  }
  const mk = () => ({ movies: 0, covers: { ok: 0, fail: 0 }, previews: { ok: 0, fail: 0 }, segs: { ok: 0, fail: 0 }, bytes: 0 })
  /* 分**账号实例**聚合（2026-10-14 多账号）：键 = 'local' | 'pan115' | 'pan115@2' | 'webdav' | 'guangya@3' … */
  const agg = { local: mk() }
  const aggOf = key => { if (!agg[key]) agg[key] = mk(); return agg[key] }
  let coversBytes = 0, previewBytes = 0
  for (const it of ((DATA && DATA.items) || [])) {
    if (!it || !it.code || !it.relVideo) continue     // 纯元数据条目（没有片源）不计入任何来源
    const s115 = v115RelParse(it.relVideo)            // '115@2:/…' → { n:2, … }
    const davK = davSplitRel(it.relVideo)             // 'dav:/…' → webdav，'gy@2:/…' → { kind:'guangya', n:2 }
    const is115 = !!s115
    const a = s115 ? aggOf('pan115' + (s115.n > 1 ? '@' + s115.n : ''))
      : davK ? aggOf(davInst(davK.kind, davK.n)) : agg.local
    a.movies++
    const d = dirOf(it.code)
    if (!d) { a.covers.fail++; a.previews.fail++; a.segs.fail += 6; continue }
    const full = path.join(mroot, d)
    /* mtime 记忆：目录没动就复用上次的「张数 / 占用」——原来每次重建都全量遍历，1050 部要 744ms */
    const im = srcDirStat(path.join(full, 'images'), 1)
    if (im.count > 0) {
      a.covers.ok++
      a.bytes += im.bytes; coversBytes += im.bytes
    } else a.covers.fail++
    /* 预览视频：本地抽帧 pv7.mp4，或 115 片源的线上预览片（点过卡片才有热缓存，没点过按「未知→失败」计） */
    const hasPv = previewHas(d)
    const ol = !hasPv && is115 ? pvOnlineCached(bare(it.code)) : null
    const pvOk = hasPv || !!(ol && ol.url)
    if (pvOk) {
      a.previews.ok++; a.segs.ok += 6
      if (hasPv) { try { const sz = fs.statSync(path.join(full, PREV_FILE)).size; a.bytes += sz; previewBytes += sz } catch (_) {} }
    } else { a.previews.fail++; a.segs.fail += 6 }
  }
  /* 头部三个占用：封面 = 各番号 images/；预览视频 = 抽帧 mp4 + 进度条缩略图缓存；总 = 整个 cache 目录 */
  try { previewBytes += srcDirSize(path.join(cacheDir(), 'previews'), 2) } catch (_) {}
  const c115 = (CFG.pan115 && typeof CFG.pan115 === 'object') ? CFG.pan115 : {}
  const sumAgg = () => {
    const t = mk()
    for (const k in agg) { t.movies += agg[k].movies; t.covers.ok += agg[k].covers.ok; t.covers.fail += agg[k].covers.fail; t.previews.ok += agg[k].previews.ok; t.previews.fail += agg[k].previews.fail; t.segs.ok += agg[k].segs.ok; t.segs.fail += agg[k].segs.fail }
    return t
  }
  return {
    ok: true, at: Date.now(),
    totals: {
      coversBytes, previewBytes,
      bytes: srcTotalBytes(forceTotal),   // 后台分片维护（同步遍历整个 cache 实测 1806ms，会卡死事件循环）
      movies: sumAgg().movies
    },
    sources: [
      {
        id: 'local', kind: 'local', name: (CFG.sourceNames && CFG.sourceNames.local) || '本地存储',
        connected: LIBS.length > 0, dirs: LIBS.slice(),
        /* 所在磁盘容量：可能挂了好几个目录、还分布在不同盘（D:\ 与 E:\）→ **每块盘各一条**，
         * 同一块盘上的多个目录只算一次（2026-10-13 需求「每个磁盘各一条」）。
         * disk 保留为第一块盘的（老前端 / 老断言兼容），disks 是新前端用的完整列表。 */
        ...(() => {
          const seen = {}, out = []
          for (const p of LIBS) {
            let root = ''
            try { root = path.parse(p).root || String(p).slice(0, 3) } catch (_) { root = String(p).slice(0, 3) }
            root = String(root || '').replace(/[\\/]+$/, '')
            if (!root || seen[root.toLowerCase()]) continue
            seen[root.toLowerCase()] = 1
            try {
              const st = fs.statfsSync(p)
              const total = st.bsize * st.blocks, free = st.bsize * st.bavail
              if (total > 0) out.push({ root, free, total })
            } catch (_) {}      // 盘读不到（拔了 / 权限）就跳过，不画这块
          }
          const d0 = out[0]
          return { disks: out, disk: d0 ? { free: d0.free, total: d0.total } : null }
        })(),
        stats: Object.assign({}, agg.local, { coversBytes: agg.local.bytes }),
        /* 本地盘/NAS 掉线也是「源掉线」：目录读不到就标出来，恢复了自己翻绿（2026-10-15） */
        health: srcHealthOf('local')
      },
      /* ---- 115：**每个账号一张卡**（2026-10-14 多账号）。
       * acct=1 是老卡（id 'pan115'）， acct≥2 的卡 id 同为 'pan115' 但带 acct 号（前端用 key 区分）。
       * ⚠ 账号 1 **恒出卡**（未配置时 connected=false、roots=[]）—— 这是老行为，前端卡片的「未连接 /
       *   还没有收录网盘目录」提示都靠它；账号 ≥2 才要求真的存在（没建过不该凭空冒空卡）。 ---- */
      ...(() => {
        const out = []
        const vlist = v115AcctListAll()
        for (const n of vlist) {
          const c = v115Cfg(n)
          const hasCookie = !!String(c.cookie || '').trim()
          const auth = v115AuthOf(n)
          const inst = n > 1 ? 'pan115@' + n : 'pan115'
          out.push({
            id: 'pan115', acct: n, key: inst, kind: 'web',
            name: (n > 1 ? (c.name || ('115 网盘 ' + n)) : (c.name || '115 网盘')),
            added: true,
            /* connected 用「网盘读得到」而不是「填了 Cookie」—— 半失效时卡片要自重（见 v115AuthNote 注释） */
            connected: hasCookie && auth.ok !== false,
            cookieOk: hasCookie && !v115BlockedNow(),
            authOk: auth.ok, authNote: v115AuthNote(n),
            blocked: v115BlockedNow() ? { remainMin: v115BlockRemain(), msg: V115_BLOCK_MSG } : null,
            roots: v115Roots(n).map(r => Object.assign({}, r, { acct: n })),
            /* 容量 / 会员 / 账号：只读 10 分钟缓存（v115UserInfo 自己会拉）；没有就 null + 后台补，绝不阻塞本接口。
             * 账号 = /user/info 的脱敏手机号（如 198*****405），卡片上要跟会员状态一起显示（2026-10-13 需求）。 */
            ...(() => {
              const ui = v115UserCached(n)
              return {
                space: ui && ui.total ? { totalFmt: ui.totalFmt, usedFmt: ui.usedFmt, remainFmt: ui.remainFmt, percent: ui.percent } : null,
                vip: ui ? ui.vip : null,
                user: (ui && ui.user) || ''
              }
            })(),
            stats: Object.assign({}, agg[inst] || mk(), { coversBytes: (agg[inst] || mk()).bytes }),
            /* 卡片状态与健康表对齐（把 v115AuthOf 的结论镜像进来，不额外发请求） */
            health: srcHealthMirror(inst, auth)
          })
        }
        return out
      })(),
      /* WebDAV / 光鸭网盘：引擎同一个，配置与前缀两份（见 davCfg 注释）；**每账号一张卡**（2026-10-14）。
       * 容量走 PROPFIND quota-*（多数服务器有；没有就 null，卡片自动不画条）。
       * 账号 = 用户填的账号（一般是手机号/邮箱，本就脱敏不了也无需脱敏 —— 与 115 的处理一致直接亮出）。
       * added = 「这个来源被添加过没有」—— 没添加（没配置）就**不出卡片**（2026-10-13 用户要求）。
       * 光鸭官方接口模式（mode='api'）的账号 = user/me 缓存的脱敏手机号。 */
      ...DAV_KINDS.flatMap(kind => {
        /* 账号 1 恒出卡（哪怕没配置 → added=false），由前端决定隐不隐藏 —— 这是**老行为**，
           不能因为「没配就不出卡」把账号 1 也吞掉：外界（前端老代码 / 测试）都依赖这张卡在。
           账号 ≥2 才要求真的存在（不存在就是没建过，不该凭空冒出一张空卡）。 */
        const dlist = davAcctListAll(kind)
        return dlist.map(n => {
          const c = davCfg(kind, n)
          const ready = davReady(kind, n)
          const isApi = kind === 'guangya' && gyIsApi(kind, n)
          const auth = DAV_AUTH[davInst(kind, n)] || { ok: null, err: '' }
          const q = davQuotaCached(kind, n)
          return {
            id: kind, acct: n, key: davInst(kind, n), kind: 'web',
            name: (n > 1 ? (c.name || (DAV_DEFNAME[kind] + ' ' + n)) : (c.name || DAV_DEFNAME[kind])),
            added: ready,
            mode: kind === 'guangya' ? (isApi ? 'api' : 'webdav') : 'webdav',
            connected: ready && auth.ok !== false,
            authOk: ready ? auth.ok : null,
            authNote: !ready
              ? (kind === 'guangya' && isApi ? '光鸭还没有登录' : '还没有填写服务器地址 / 账号 / 密钥')
              : (auth.ok === false ? auth.err : ''),
            roots: davRoots(kind, n).map(r => Object.assign({}, r, { acct: n })),
            user: ready ? (isApi ? (c.account || '') : (c.user || '')) : '',
            space: q && q.total ? { totalFmt: q.totalFmt, usedFmt: q.usedFmt, remainFmt: q.remainFmt, percent: q.percent } : null,
            stats: Object.assign({}, agg[davInst(kind, n)] || mk(), { coversBytes: (agg[davInst(kind, n)] || mk()).bytes }),
            health: srcHealthMirror(davInst(kind, n), auth)
          }
        })
      })
    ]
  }
}
/* ================= 来源健康自检 / 自动恢复（2026-10-15） =================
 * 要的是 Emby 那种体感：**源自己会好**。
 *   ① 掉线（115 Cookie 过期、光鸭 Token 失效、WebDAV 连不上、本地盘被拔）→ 卡片立刻标出来并说原因；
 *   ② 不用用户点任何东西，后台按退避自己复检，**一通就自动翻绿**；
 *   ③ 用户改凭据（重贴 Cookie / 重填密钥 / 重登光鸭）→ **立刻**复检，几秒内出结果，不用等冷却；
 *   ④ 恢复那一刻把被卡住的活儿一起解锁：清登录冷却、作废目录快照与统计缓存、让盯梢/扫描继续跑。
 * 状态在这里集中维护一份（SRC_HEALTH），卡片 / 设置页 / 诊断都读它，不会再出现「这边红了那边还绿」。
 * ⚠ 复检只对**已配置**的源发请求，且掉线时是退避的（60s→120s→5min→10min），不会拿死凭据空打。 */
const SRC_HEALTH = {}          // key -> 状态；key 与 sourcesPayload 的卡片 key 同构：'local' | 'pan115' | 'pan115@2' | 'webdav' | 'guangya@2'
const SRC_HEALTH_GAP = { auth: [60, 120, 300, 600], net: [45, 90, 180, 600] }   // 复检间隔（秒），先密后疏
let SRC_HEALTH_BUSY = false
function srcHealthOf(key) {
  if (!SRC_HEALTH[key]) SRC_HEALTH[key] = { key, state: 'unknown', err: '', since: 0, at: 0, nextAt: 0, tries: 0, probes: 0, recovers: 0 }
  return SRC_HEALTH[key]
}
function srcHealthGap(h, state) {
  const arr = SRC_HEALTH_GAP[state === 'auth' ? 'auth' : 'net']
  return arr[Math.min(Math.max(0, (h.tries || 0) - 1), arr.length - 1)] * 1000
}
/* quiet=true：只改状态不触发缓存重算（sourcesPayload 内部同步镜像时用它，避免自己把自己刷没了） */
function srcHealthSet(key, state, err, quiet) {
  const h = srcHealthOf(key)
  const prev = h.state
  h.state = state; h.err = String(err || ''); h.at = Date.now()
  if (state === 'ok') {
    if (prev !== 'ok' && prev !== 'unknown') {
      h.recovers++
      console.log('[health] ' + key + ' 已自动恢复 ✓（掉线 ' + Math.round((Date.now() - (h.since || Date.now())) / 1000) + 's' + (prev === 'auth' ? '，之前是登录失效' : '') + '）')
    }
    h.tries = 0; h.nextAt = 0
    if (prev !== 'ok') srcHealthUnlock(key)     // 恢复 → 解锁被这次掉线卡住的东西
  } else {
    if (prev === 'ok' || prev === 'unknown') { h.since = Date.now(); h.tries = 0 }
    h.tries++
    /* unknown（还没配置 / 还没探过）也要有下一次：不然用户在外面把 Cookie 贴好了，
     * 这边永远等不到「自动恢复」。间隔固定 5 分钟，代价极小（这类请求本地就返回，不出网）。 */
    h.nextAt = state === 'unknown' ? Date.now() + 5 * 60 * 1000 : Date.now() + srcHealthGap(h, state)
    if (prev !== state && state !== 'unknown') console.log('[health] ' + key + ' → ' + state + '：' + h.err + '（' + Math.round((h.nextAt - Date.now()) / 1000) + 's 后自动复检）')
  }
  if (!quiet) SRC_CACHE = { at: 0, data: null }   // 卡片/统计立刻重算，不用等 60s 缓存
  return h
}
/* 115 登录失效会进「暂停请求」冷却（15~120 分钟）—— 源自己恢复了（用户在别处重新登录 / Cookie 又活了）
 * 就必须把这个冷却一起撤掉，否则界面绿了、实际操作还是被本地挡着，看着像没恢复。 */
function srcHealthUnlock(key) {
  const m = /^pan115(?:@(\d+))?$/.exec(key)
  if (m) {
    const n = Math.max(1, parseInt(m[1] || '1', 10) || 1)
    try { v115CookieChanged(n) } catch (_) {}
    try { v115MarkAuth(true, '', n) } catch (_) {}
    try { if (typeof w115Reschedule === 'function') w115Reschedule(5000) } catch (_) {}
    return
  }
  if (/^(webdav|guangya)(@\d+)?$/.test(key)) {
    try { DAV_AUTH[key] = { ok: true, err: '' } } catch (_) {}
  }
}
/* 把别处判出来的结论（v115MarkAuth / DAV_AUTH）镜像进健康表 —— 不重复发请求，只同步状态 */
function srcHealthMirror(key, auth) {
  if (!auth) return srcHealthOf(key)
  if (auth.ok === false) return srcHealthSet(key, /登录|未登录|过期|失效|401|密钥|Token|token/i.test(String(auth.err || '')) ? 'auth' : 'net', auth.err, true)
  if (auth.ok === true) return srcHealthSet(key, 'ok', '', true)
  return srcHealthOf(key)
}
/* 已配置来源清单（种子）：只给这些 key 建状态，没添加的源不占条目也不发请求 */
function srcHealthKeys() {
  const keys = ['local']
  try { for (const n of v115AcctListAll()) keys.push(n > 1 ? 'pan115@' + n : 'pan115') } catch (_) {}
  try { for (const kind of DAV_KINDS) for (const n of davAcctListAll(kind)) keys.push(davInst(kind, n)) } catch (_) {}
  return keys
}
/* 115 的连通性探针：只列根目录 1 条，**一个请求**，不分页不递归（v115List 会翻完整页，太重） */
async function v115Ping(n) {
  const j = await v115Json('/files?cid=0&show_dir=1&limit=1&offset=0&o=user_ptime&asc=0&format=json', { probe: true, timeout: 15000 }, n)
  v115MarkAuth(true, '', n)
  return j
}
/* WebDAV / 光鸭的连通性探针：根目录 PROPFIND Depth 0（与 davQuota 同一条路，只读一层） */
async function davPing(kind, n) {
  const inst = davInst(kind, n)
  if (kind === 'guangya' && gyIsApi(kind, n)) {
    /* 官方接口模式不走 WebDAV：拿一次 user/me 当心跳（失败会抛，交给上层判定） */
    await gyUserInfo(n, true)
    DAV_AUTH[inst] = { ok: true, err: '' }
    return true
  }
  const rs = await davReq(kind, 'PROPFIND', '', { headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: DAV_PROPFIND_BODY, timeout: 12000 }, n)
  if (rs.status === 401) { DAV_AUTH[inst] = { ok: false, err: '账号或密钥不对（HTTP 401）' }; throw new Error(DAV_DEFNAME[kind] + ' 账号或密钥不对（HTTP 401）') }
  if (rs.status === 403) { DAV_AUTH[inst] = { ok: false, err: '没有访问权限（HTTP 403）' }; throw new Error(DAV_DEFNAME[kind] + ' 没有访问权限（HTTP 403）') }
  if (rs.status >= 400) { DAV_AUTH[inst] = { ok: false, err: 'HTTP ' + rs.status }; throw new Error(DAV_DEFNAME[kind] + ' 服务器返回 HTTP ' + rs.status) }
  DAV_AUTH[inst] = { ok: true, err: '' }
  return true
}
/* 本地存储：目录还在不在（移动硬盘拔了 / NAS 断线都会读不到） */
function localPing() {
  if (!LIBS.length) return { ok: true, err: '' }
  let miss = 0
  for (const p of LIBS) { try { if (!fs.existsSync(p)) miss++ } catch (_) { miss++ } }
  return miss ? { ok: false, err: miss + ' / ' + LIBS.length + ' 个媒体目录读不到（盘被拔了或 NAS 断了）' } : { ok: true, err: '' }
}
async function srcHealthProbe(key) {
  const h = srcHealthOf(key)
  h.probes++
  try {
    if (key === 'local') {
      const r = localPing()
      return srcHealthSet(key, r.ok ? 'ok' : 'net', r.err)
    }
    const m = /^pan115(?:@(\d+))?$/.exec(key)
    if (m) {
      const n = Math.max(1, parseInt(m[1] || '1', 10) || 1)
      if (!v115Ready(n)) return srcHealthSet(key, 'unknown', '还没有配置 Cookie')
      try { await v115Ping(n); return srcHealthSet(key, 'ok', '') }
      catch (e) {
        const msg = String((e && e.message) || e || '')
        /* 登录类失败单独成类：文案要直接告诉用户「去哪重贴 Cookie」，而不是笼统的「连不上」 */
        return srcHealthSet(key, v115AuthErr(msg) || /990001|登录|未登录/.test(msg) ? 'auth' : 'net', msg)
      }
    }
    const d = /^(webdav|guangya)(?:@(\d+))?$/.exec(key)
    if (d) {
      const kind = d[1], n = Math.max(1, parseInt(d[2] || '1', 10) || 1)
      if (!davReady(kind, n)) return srcHealthSet(key, 'unknown', '还没有配置')
      try { await davPing(kind, n); return srcHealthSet(key, 'ok', '') }
      catch (e) {
        const msg = String((e && e.message) || e || '')
        return srcHealthSet(key, davAuthErr(msg) || /过期|失效|登录|token/i.test(msg) ? 'auth' : 'net', msg)
      }
    }
    return srcHealthSet(key, 'unknown', '未知来源')
  } catch (e) {
    return srcHealthSet(key, 'net', String((e && e.message) || e || ''))
  }
}
/* 立刻复检（不等待、不阻塞调用方）：改完凭据 / 点了「重连」都走这里 */
function srcHealthProbeNow(key) {
  srcHealthOf(key).nextAt = 0
  setTimeout(() => { srcHealthProbe(key).catch(() => {}) }, 30)
}
/* 巡检：每 30s 看一眼有没有到点的复检任务。正常（ok）的源一个请求都不发。
 * unknown 也走同一条路 —— 启动 30s 后顺手把各来源探一遍，卡片状态就准了，
 * 之后只按 nextAt 到点才动（未配置的源 5 分钟一次，且不出网）。 */
function srcHealthTick() {
  if (SRC_HEALTH_BUSY) return
  const now = Date.now()
  const due = []
  for (const k in SRC_HEALTH) {
    const h = SRC_HEALTH[k]
    if (h.state === 'ok') continue
    if (h.nextAt && now < h.nextAt) continue
    due.push(k)
  }
  if (!due.length) return
  SRC_HEALTH_BUSY = true
  ;(async () => {
    for (const k of due) { try { await srcHealthProbe(k) } catch (_) {} }
  })().then(() => { SRC_HEALTH_BUSY = false }, () => { SRC_HEALTH_BUSY = false })
}
setInterval(() => { try { srcHealthTick() } catch (_) {} }, 30000)
/* 播种：把所有已配置来源登记进来（首轮巡检就把它们探一遍） */
function srcHealthSeed() {
  const keys = srcHealthKeys()
  for (const k of keys) srcHealthOf(k)
  return keys
}

/* ================= 网站（导航栏「网站」页：卡片式网址收藏，2026-10-15）=================
 * 用户需求：导航栏加个「网站」模块，按分类筛、按常用排序，卡片式（图标 + 名称 + 一句话说明）。
 * 数据落 cacheDir/sites.json（跟着「离线数据迁移」一起走，换目录不丢）。
 * 图标不再是「猜 emoji」：服务端去站点取真实 favicon 并缓存到 cacheDir/site-icons/，
 * 取不到就由前端画首字母色块 —— 断网也能看，第一次访问也只是一排色块，不影响使用。 */
const SITE_CATS = ['番号库', '磁力', '导航', '视频', '直播', '动漫', '图片', '小说', '论坛', '资讯', '其他']
const SITES_FILE = () => path.join(cacheDir(), 'sites.json')                  // 个人层（用户数据）
const SITES_BUILTIN_FILE = () => path.join(UI_ROOT, 'sites-builtin.json')     // 内置站点库（软件自带）
let SITES = null           // 合并视图：所有接口/前端看到的都是它
let SITES_BUILTIN = null   // 内置库（只读）
let SITES_BUILTIN_ICON = null   // host → 内置图标 data URI 的查表（/api/sites/icon 用，避免每次 188 次线性找）
let SITES_MINE = null      // 个人层
/* ⚠ 2026-10-15 改（用户要求「114 个都加上去，网站数据默认打包在软件里，不作为个人数据」）：
 * 站点分两层存 ——
 *   · **内置站点库** `sites-builtin.json`（跟 index.html 同目录，随安装包分发，137 个站点）。
 *     只读，磁盘上属于「软件自带内容」，永远不会被写进用户目录。
 *   · **个人层** `cacheDir/sites.json`（v2）：只存「用户自己做的事」——
 *     list  = 用户新增的站点 + 用户改过的内置站点（覆盖副本，编辑一次才生成，不是一次性拷 137 条）
 *     del   = 用户删掉的内置站 host 墓碑（不留墓碑的话，删了下一次启动它又冒出来）
 *     stats = 每站使用痕迹：点击次数 hits / 上次点击 lastAt / 上次测速 net（按 host 记，不复制站点内容）
 *   合并视图 = 内置库（用户改过的用个人版、删掉的跳过、顺序照内置）+ 个人新增（排末尾）。
 *   好处：升级换新内置库立刻生效（没动过的站跟着更新），个人数据文件里也不再躺着一百多个网址。
 *   旧的 v1 数据（整份列表都落盘）首次加载自动整理：与内置库一字不差的条目挪回内置，只留使用痕迹。 */
function sitesBuiltinList() {
  if (SITES_BUILTIN) return SITES_BUILTIN
  SITES_BUILTIN = []
  try {
    const j = JSON.parse(fs.readFileSync(SITES_BUILTIN_FILE(), 'utf8'))
    const raw = (j && Array.isArray(j.list)) ? j.list : (Array.isArray(j) ? j : [])
    for (const x of raw) {
      if (!x || !x.url) continue
      const url = siteNormUrl(x.url)
      if (!url) continue
      /* 内置库也可以带图标（logo=data URI、bg=底色、useLogo=用程序画的矢量 logo）。
       * 2026-10-15 加：作者本人改过图标 / 底色的站点也内置进来，装完就有图，不依赖联网去抓。
       * ⚠ 图标本体**不放进 /api/sites 的响应**：188 张 data URI 合计 4MB，而网站页每 4 秒就轮询一次，
       *   塞进去等于每 4 秒搬 4MB。所以这里存成 builtinLogo（仅服务端内存），对外只给一个
       *   builtinLogoAt 版本号，前端照老规矩走 /api/sites/icon 取图（浏览器自己缓存 7 天）。 */
      const lg = String(x.logo || '').trim()
      const logo = (lg && (/^https?:\/\//i.test(lg) || /^data:image\//i.test(lg))) ? lg.slice(0, 1200000) : ''
      let bg = String(x.bg || '').trim().slice(0, 32)
      if (bg && !/^transparent$/i.test(bg) && !/^#[0-9a-fA-F]{3,8}$/.test(bg)) bg = ''
      let logoAt = 0
      if (logo) {
        let h = 0
        for (let i = 0; i < logo.length; i += 11) h = (h * 31 + logo.charCodeAt(i)) | 0   // 采样算版本号，别遍历 30 万个字符
        logoAt = Math.abs(h) || 1
      }
      SITES_BUILTIN.push({
        id: String(x.id || ('b' + (SITES_BUILTIN.length + 1))),
        name: String(x.name || '').slice(0, 40) || siteHostOf(url),
        url: url,
        cat: SITE_CATS.indexOf(x.cat) >= 0 ? x.cat : '其他',
        desc: String(x.desc || '').slice(0, 120),
        logo: '',                          // ← 对外（/api/sites）看到的用户自填图标，内置的放这儿保持空
        builtinLogo: logo,                 // ← 内置图标本体：只在服务端内存 / /api/sites/icon 里用
        builtinLogoAt: logoAt,
        bg: bg, useLogo: x.useLogo ? 1 : 0, hits: 0
      })
    }
    SITES_BUILTIN_ICON = null
    console.log('[sites] 内置站点库：' + SITES_BUILTIN.length + ' 个站点（含内置图标 ' + SITES_BUILTIN.filter(x => x.builtinLogo).length + ' 个，' + SITES_BUILTIN_FILE() + '）')
  } catch (e) { console.log('[sites] 内置站点库没读到（' + e.message + '），按空库启动') }
  return SITES_BUILTIN
}
/* 「与内置库一字不差」的条目 = 本来就是软件自带的内容（不是用户自己写的）：
 * 条目本身归回内置库，只把使用痕迹（点击数 / 上次测速）留在个人层。
 * v1（整份列表落盘的时代）与 v2（现在）都要过这一道：
 *   · v1 —— 一次性把一百多条整库副本从个人数据里清出去；
 *   · v2 —— 让「作者后来把某个站补进内置库」这件事对老用户即时生效：
 *           个人层里那份一模一样的老副本自动消失，不会把已经内置的内容又盖回去。
 * 用户真改过（名称/分类/说明/网址/图标/底色 任一不同）的条目一律保留 —— 那是他的定制。 */
function sitesMineTidy(list, stats) {
  const byHost = {}
  for (const b of sitesBuiltinList()) byHost[siteHostOf(b.url)] = b
  const out = []
  for (const x of list) {
    if (!x || !x.url) continue
    const url = siteNormUrl(x.url)
    if (!url) continue
    const host = siteHostOf(url)
    const b = byHost[host]
    /* ⚠ 两个坑：
     * ① 内置图标在服务端存在 builtinLogo（不占 /api/sites 的体积），比的时候得带上它；
     * ② 个人层字段为空 = 「用户在这项上没意见」，不是「用户把它改成了空」——
     *    比如用户只改了名字、没碰图标，x.logo 就是空的，这时该沿用内置那枚图标，
     *    不能因为「内置有图、个人层没图」就判成改过、白留一条副本在个人数据里。 */
    const bLogo = b ? String(b.builtinLogo || b.logo || '') : ''
    const same = b && String(x.name || '') === b.name && String(x.cat || '') === b.cat
      && String(x.desc || '') === String(b.desc || '') && url === b.url
      && (!x.logo || String(x.logo) === bLogo)
      && (!x.bg || String(x.bg) === String(b.bg || ''))
      && (!x.useLogo || b.useLogo)
    if (same) {
      const st = {}
      if (x.hits) st.hits = x.hits
      if (x.lastAt) st.lastAt = x.lastAt
      if (x.net) st.net = x.net
      if (Object.keys(st).length && !stats[host]) stats[host] = st
      continue
    }
    out.push(Object.assign({}, x, { url: url }))
  }
  return out
}
/* 个人层：v2 结构；v1（整份列表落盘）读到就先整理一遍 */
function sitesMineLoad() {
  if (SITES_MINE) return SITES_MINE
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(SITES_FILE(), 'utf8')) } catch (_) {}
  if (raw && Array.isArray(raw.list)) {
    const isV2 = raw.v === 2
    const stats = (isV2 && raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) ? raw.stats : {}
    const src = raw.list.filter(x => x && x.url && siteNormUrl(x.url))
    const list = sitesMineTidy(src, stats)
    SITES_MINE = {
      v: 2,
      list: list,
      del: (isV2 && Array.isArray(raw.del)) ? raw.del.map(String) : [],
      stats: stats
    }
    if (!isV2 || list.length !== src.length) {
      console.log('[sites] 个人数据整理：' + src.length + ' 条 → ' + list.length + ' 条（其余 ' + (src.length - list.length) + ' 条与内置站点库一致，归入内置）')
      sitesMineSave()
    }
    return SITES_MINE
  }
  SITES_MINE = { v: 2, list: [], del: [], stats: {} }
  return SITES_MINE
}
function sitesMineSave() {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(SITES_FILE(), JSON.stringify(SITES_MINE, null, 1))
  } catch (e) { console.log('[sites] 个人数据落盘失败：' + e.message) }
}
/* 合并视图：内置库（用户改过的用个人版、删掉的跳过）+ 个人新增 */
function sitesRebuild() {
  const base = sitesBuiltinList()
  const mine = sitesMineLoad()
  const del = {}
  for (const h of (mine.del || [])) del[h] = 1
  const stats = mine.stats || {}
  const used = {}
  const out = []
  const push = (x, builtin) => {
    const host = siteHostOf(x.url)
    const st = stats[host] || {}
    const it = Object.assign({}, x)
    it.host = host
    it.builtin = builtin ? 1 : 0
    it.hits = st.hits != null ? st.hits : (x.hits || 0)
    it.lastAt = st.lastAt || x.lastAt || 0
    if (st.net) it.net = st.net
    out.push(it)
  }
  for (const b of base) {
    const host = siteHostOf(b.url)
    if (!host || del[host]) continue
    let idx = -1
    for (let i = 0; i < mine.list.length; i++) { if (!used[i] && siteHostOf(mine.list[i].url) === host) { idx = i; break } }
    if (idx >= 0) {
      used[idx] = 1
      const m = mine.list[idx]
      /* 用户只改了名字 / 说明，没动图标 → 那一格照样用内置图标（不然一改名图标就没了） */
      if (!m.logo && !m.useLogo && b.builtinLogo) {
        push(Object.assign({}, m, { builtinLogo: b.builtinLogo, builtinLogoAt: b.builtinLogoAt }), false)
      } else push(m, false)
      continue
    }
    push(b, true)
  }
  for (let i = 0; i < mine.list.length; i++) if (!used[i]) push(mine.list[i], false)
  SITES = { v: 2, list: out }
  return SITES
}
function sitesLoad() { return SITES || sitesRebuild() }
/* 兼容旧调用名：写操作一律落个人层（内置库只读） */
function sitesSave() { sitesMineSave() }
/* 这条网址在内置库里吗（删/改内置站时要留墓碑） */
function siteIsBuiltinHost(host) {
  if (!host) return false
  for (const b of sitesBuiltinList()) if (siteHostOf(b.url) === host) return true
  return false
}
/* host → 内置图标（data URI）。程序自带，不落用户目录；被删掉的站不留在这里（删了就别再吐图）。 */
function sitesBuiltinIconMap() {
  if (SITES_BUILTIN_ICON) return SITES_BUILTIN_ICON
  SITES_BUILTIN_ICON = {}
  for (const b of sitesBuiltinList()) if (b.builtinLogo) SITES_BUILTIN_ICON[siteHostOf(b.url)] = b.builtinLogo
  return SITES_BUILTIN_ICON
}
/* data URI → 二进制（给 <img> 用）。不是 data:image 就 null。 */
function dataUriToBuf(s) {
  const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(String(s || '').trim())
  if (!m) return null
  try {
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
    return buf.length ? { type: m[1].toLowerCase(), buf: buf } : null
  } catch (_) { return null }
}
function siteNewId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) }
/* 在个人层里找这条（合并视图的）站点对应的记录：
 * 用户自己加的站必然有；内置站只有被改过才会有一条「覆盖副本」。 */
function sitesMineEntry(it) {
  if (!it) return null
  const mine = sitesMineLoad()
  const host = siteHostOf(it.url)
  return mine.list.find(x => x.id === it.id)
    || mine.list.find(x => siteHostOf(x.url) === host && x.cat === it.cat)
    || mine.list.find(x => siteHostOf(x.url) === host)
    || null
}
/* 网址归一化：没写协议就补 https://；去尾部斜杠；只认 http/https */
function siteNormUrl(raw) {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '')
  let o
  try { o = new URL(u) } catch (_) { return '' }
  if (!/^https?:$/.test(o.protocol) || !o.hostname) return ''
  return o.href.replace(/\/+$/, '')
}
function siteHostOf(u) { try { return new URL(u).hostname.replace(/^www\./i, '') } catch (_) { return '' } }

/* ---- 内嵌高清站点 logo（2026-10-15 需求：「每个网站把高清 logo 都内嵌在里面」）----
 * 为什么不用 favicon：GitHub / JavBus / JavDB 这些站点国内根本连不上，抓 favicon 必然是
 * 超时 → 卡片上一排灰块；而且真实 favicon 多半只有 16~32px，放大就糊。
 * 所以改成**矢量 SVG 直接内嵌**（data URI，服务端现算）：任意尺寸都锐利 = 高清，
 * 零网络请求 = 立刻出图、断网也在。已抓到的真实 favicon 依然优先（那是站点自己的脸），
 * 内嵌 logo 负责「还没抓到 / 抓不到」的那段时间不再难看。 */
/* 手调品牌表：域名 → { t: 字母标, c: [渐变起, 渐变止], g: 图形（可选，给了就不用字母） } */
const SITE_LOGO_BRANDS = {
  'airav.io':            { t: 'AV',  c: ['#7c3aed', '#4c1d95'] },
  'avbase.net':          { t: 'AB',  c: ['#4f46e5', '#1e1b4b'] },
  'avmoo.website':       { t: 'AM',  c: ['#0ea5e9', '#0f766e'] },
  'avsox.click':         { t: 'AS',  c: ['#06b6d4', '#155e75'] },
  'caribbeancom.com':    { t: 'CB',  c: ['#ef4444', '#7f1d1d'] },
  'dmm.co.jp':           { t: 'DMM', c: ['#1d4ed8', '#0b1120'] },
  'video.dmm.co.jp':     { t: 'FANZA', c: ['#e11d48', '#4c0519'] },
  'adult.contents.fc2.com': { t: 'FC2', c: ['#ec4899', '#831843'] },
  'fc2.com':             { t: 'FC2', c: ['#ec4899', '#831843'] },
  'javten.com':          { t: 'J10', c: ['#f97316', '#7c2d12'] },
  'freejavbt.com':       { t: 'FJ',  c: ['#22c55e', '#14532d'] },
  'freejavbt.me':        { t: 'FJ',  c: ['#22c55e', '#14532d'] },
  'hbox.jp':             { t: 'HB',  c: ['#f59e0b', '#78350f'] },
  'jav321.com':          { t: '321', c: ['#3b82f6', '#1e3a8a'] },
  'javbus.com':          { t: 'JB',  c: ['#dc2626', '#450a0a'], g: 'bus' },
  'javdb.com':           { t: 'DB',  c: ['#b91c1c', '#1c1917'], g: 'db' },
  'javlibrary.com':      { t: 'JL',  c: ['#a16207', '#292524'] },
  'madou.club':          { t: 'MD',  c: ['#e11d48', '#4c0519'] },
  'madouqu.com':         { t: 'MQ',  c: ['#f43f5e', '#500724'] },
  'mgstage.com':         { t: 'MG',  c: ['#475569', '#0f172a'] },
  'missav123.com':       { t: 'MA',  c: ['#f472b6', '#831843'], g: 'play' },
  'missav.ws':           { t: 'MA',  c: ['#f472b6', '#831843'], g: 'play' },
  '7mmtv.sx':            { t: 'MM',  c: ['#8b5cf6', '#3b0764'] },
  'api.theporndb.net':   { t: 'DB',  c: ['#14b8a6', '#134e4a'] },
  'theporndb.net':       { t: 'DB',  c: ['#14b8a6', '#134e4a'] },
  'xchina.co':           { t: 'X',   c: ['#facc15', '#78350f'] },
  'sukebei.nyaa.si':     { t: 'SK',  c: ['#334155', '#020617'], g: 'torii' },
  'nyaa.si':             { t: 'N',   c: ['#4ade80', '#14532d'], g: 'torii' },
  'nyaa.land':           { t: 'N',   c: ['#4ade80', '#14532d'], g: 'torii' },
  '115.com':             { t: '115', c: ['#2563eb', '#0c1a3a'], g: 'cloud' },
  'guangyapan.com':      { t: 'GY',  c: ['#fb923c', '#7c2d12'], g: 'cloud' },
  'minnano-av.com':      { t: 'MN',  c: ['#f9a8d4', '#9d174d'] },
  /* 用户从 iTab 备份里搬进来的那批，顺手指上牌子色 */
  'jable.tv':            { t: 'JA',  c: ['#f97316', '#7f1d1d'], g: 'play' },
  '123av.com':           { t: '123', c: ['#ef4444', '#701a75'], g: 'play' },
  'netflav5.com':        { t: 'NF',  c: ['#dc2626', '#1f2937'], g: 'play' },
  'jav.sb':              { t: 'SB',  c: ['#f43f5e', '#450a0a'], g: 'play' },
  'njav.com':            { t: 'NJ',  c: ['#8b5cf6', '#2e1065'], g: 'play' },
  't66y.com':            { t: 'CL',  c: ['#16a34a', '#052e16'] },
  'sis001.com':          { t: 'SIS', c: ['#0ea5e9', '#0c4a6e'] },
  'avscan.cc':           { t: 'AVS', c: ['#22d3ee', '#164e63'] },
  'whos.tv':             { t: 'WHO', c: ['#a855f7', '#3b0764'] },
  'pornpics.com':        { t: 'PP',  c: ['#f43f5e', '#4c0519'] },
  'beeg.com':            { t: 'BG',  c: ['#f59e0b', '#1c1917'], g: 'play' },
  'xvideos.com':         { t: 'XV',  c: ['#6b7280', '#111827'], g: 'play' },
  'theporndb.net':       { t: 'DB',  c: ['#14b8a6', '#134e4a'] },
  'jubt12.xyz':          { t: 'JU',  c: ['#22c55e', '#052e16'], g: 'magnet' },
  'seju.life':           { t: 'SJ',  c: ['#ec4899', '#500724'], g: 'magnet' },
  'torrentkitty.app':    { t: 'TK',  c: ['#38bdf8', '#0c4a6e'], g: 'magnet' },
  '18mag.net':           { t: '18',  c: ['#8b5cf6', '#1e1b4b'], g: 'magnet' },
  'bt1207so.top':        { t: 'BT',  c: ['#f97316', '#431407'], g: 'magnet' },
  'openbtoo.cc':         { t: 'OB',  c: ['#10b981', '#064e3b'], g: 'magnet' },
  'cn.torrentkitty.app': { t: 'TK',  c: ['#38bdf8', '#0c4a6e'], g: 'magnet' },
  '155zy.com':           { t: '115', c: ['#2563eb', '#0c1a3a'], g: 'cloud' },
  /* iTab 备份导入的那批（2026-10-15）*/
  'javrate.com':         { t: 'JR',  c: ['#f59e0b', '#78350f'] },
  'javbooks.com':        { t: 'JBS', c: ['#0ea5e9', '#0c4a6e'] },
  'avgood.com':          { t: 'AG',  c: ['#22c55e', '#052e16'] },
  'javcup.com':          { t: 'JC',  c: ['#a855f7', '#3b0764'] },
  'manko.fun':           { t: 'MK',  c: ['#f472b6', '#831843'], g: 'play' },
  'xeden.net':           { t: 'XD',  c: ['#ef4444', '#450a0a'], g: 'play' },
  'omgjav.com':          { t: 'OMG', c: ['#f43f5e', '#4c0519'], g: 'play' },
  'mythav.org':          { t: 'MY',  c: ['#8b5cf6', '#2e1065'], g: 'play' },
  'missavt41.com':       { t: 'MA',  c: ['#f472b6', '#831843'], g: 'play' },
  'fulleroticmovies.net': { t: '80S', c: ['#a16207', '#1c1917'], g: 'play' },
  'bad.news':            { t: 'BN',  c: ['#475569', '#020617'] },
  'mm18news.com':        { t: '18',  c: ['#f97316', '#431407'] },
  'allmylinks.com':      { t: '169', c: ['#6366f1', '#312e81'] },
  'avno1tw.com':         { t: 'AV1', c: ['#ec4899', '#500724'] },
  'xsijishe.com':        { t: 'XS',  c: ['#06b6d4', '#164e63'] },
  'everia.club':         { t: 'EV',  c: ['#d946ef', '#701a75'] },
  'hecoq.uuss.uk':       { t: 'HQ',  c: ['#f59e0b', '#451a03'] },
  'en.girlstop.info':    { t: 'GS',  c: ['#f43f5e', '#881337'] },
  'nv-pu-sa.pages.dev':  { t: 'NP',  c: ['#ec4899', '#831843'] },
  '134x.com':            { t: '134', c: ['#ef4444', '#7f1d1d'] },
  '5xfeed.com':          { t: 'XF',  c: ['#0f172a', '#334155'] },
  'myfans-douga.com':    { t: 'MF',  c: ['#f472b6', '#9d174d'] },
  'bit.ly':              { t: 'bit', c: ['#334155', '#0f172a'] },
  'pornhubdownloader.io': { t: 'DL', c: ['#f97316', '#1c1917'] },
  'veil.ortlinde.com':   { t: 'SS',  c: ['#8b5cf6', '#1e1b4b'] },
  '91bestporn.com':      { t: '91',  c: ['#dc2626', '#450a0a'] },
  'hygcz4.uejqxl.com':   { t: 'GC',  c: ['#16a34a', '#052e16'] }
}
/* 没登记过的站点：按域名算一组稳定的渐变（同一域名永远同一颜色，不会每次进来都换色） */
const SITE_LOGO_PALETTE = [
  ['#ef4444', '#7f1d1d'], ['#f97316', '#7c2d12'], ['#f59e0b', '#78350f'], ['#22c55e', '#14532d'],
  ['#10b981', '#064e3b'], ['#14b8a6', '#134e4a'], ['#06b6d4', '#155e75'], ['#3b82f6', '#1e3a8a'],
  ['#6366f1', '#312e81'], ['#8b5cf6', '#3b0764'], ['#d946ef', '#701a75'], ['#ec4899', '#831843'],
  ['#f43f5e', '#4c0519'], ['#64748b', '#0f172a'], ['#0ea5e9', '#0c4a6e']
]
/* 96×96 网格上的白色描边小图形（不加 fill，靠 stroke 走统一线宽） */
const SITE_LOGO_GLYPHS = {
  play:   '<circle cx="48" cy="48" r="21" fill="none" stroke="#fff" stroke-width="6"/><path d="M41.5 37.5 61 48l-19.5 10.5z" fill="#fff"/>',
  magnet: '<path d="M33 27v21a15 15 0 0 0 30 0V27" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M33 40h12M51 40h12" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
  cloud:  '<path d="M33 69a12.5 12.5 0 0 1-1.2-24.9A17.5 17.5 0 0 1 65.5 40a12.5 12.5 0 0 1-.9 29z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>',
  torii:  '<path d="M24 31h48M30 42h36M38 31v39M58 31v39" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>',
  bus:    '<rect x="27" y="25" width="42" height="34" rx="7" fill="none" stroke="#fff" stroke-width="6"/><path d="M27 43h42M35 59v8M61 59v8" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="38" cy="40" r="3.2" fill="#fff"/><circle cx="58" cy="40" r="3.2" fill="#fff"/>',
  db:     '<ellipse cx="48" cy="31" rx="20" ry="8" fill="none" stroke="#fff" stroke-width="6"/><path d="M28 31v34c0 4.4 9 8 20 8s20-3.6 20-8V31" fill="none" stroke="#fff" stroke-width="6"/><path d="M28 47c0 4.4 9 8 20 8s20-3.6 20-8" fill="none" stroke="#fff" stroke-width="5"/>'
}
const xmlEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
/* 域名 → 字母标：去掉后缀与常见前缀，取头段前 2 个字母数字 */
function siteLogoText(host, name) {
  const h = String(host || '').toLowerCase()
  let seg = h.split('.').filter(x => x !== 'www' && x !== 'api')[0] || ''
  let t = seg.replace(/[^0-9a-z]/g, '')
  if (!t || t.length < 2) t = String(name || host || '?').replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '')
  if (!t) return '?'
  return t.slice(0, 2).toUpperCase()
}
/* 生成内嵌 logo（data URI）。带缓存：同一域名只算一次。 */
const SITE_LOGO_MEMO = {}
function siteLogoUri(host, name) {
  const h = String(host || '').toLowerCase()
  if (!h) return ''
  if (SITE_LOGO_MEMO[h]) return SITE_LOGO_MEMO[h]
  const b = SITE_LOGO_BRANDS[h]
  let c = b && b.c
  if (!c) {
    let n = 0
    for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) % 99991
    c = SITE_LOGO_PALETTE[n % SITE_LOGO_PALETTE.length]
  }
  const glyph = b && b.g ? SITE_LOGO_GLYPHS[b.g] || '' : ''
  const txt = (b && b.t) || siteLogoText(h, name)
  const fs = txt.length >= 4 ? 24 : txt.length === 3 ? 29 : txt.length === 2 ? 36 : 46
  const mark = glyph || ('<text x="48" y="50" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="Arial,Helvetica,Segoe UI,sans-serif" font-size="' + fs + '" font-weight="700" ' +
    'fill="#fff" letter-spacing="0.5">' + xmlEsc(txt) + '</text>')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + c[0] + '"/><stop offset="1" stop-color="' + c[1] + '"/></linearGradient></defs>' +
    '<rect width="96" height="96" rx="23" fill="url(#g)"/>' +
    '<path d="M0 64Q48 34 96 64V73Q96 96 73 96H23Q0 96 0 73Z" fill="#ffffff" opacity=".10"/>' +
    '<rect x="0.75" y="0.75" width="94.5" height="94.5" rx="22.4" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="1.5"/>' +
    mark + '</svg>'
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  SITE_LOGO_MEMO[h] = uri
  return uri
}
/* 这个域名是不是用的内嵌 logo（登记过品牌，或有自定义 logo 字段）→ 是的话就不用再去抓 favicon 了 */
function siteHasLogo(x) {
  if (x && x.logo) return true
  return !!SITE_LOGO_BRANDS[siteHostOf(x && x.url)]
}

/* ---- 站点图标：取真实 favicon 并缓存（取不到就记 7 天负面缓存，别每次都去碰壁）---- */
const SITE_ICON_DIR = () => path.join(cacheDir(), 'site-icons')
/* 负面缓存两种时长：站点自己答了但没图标（7 天，不用再问）/ 网络没打通（3 小时，过会儿再试） */
const SITE_ICON_MISS_MS = 7 * 24 * 3600 * 1000
const SITE_ICON_NETMISS_MS = 3 * 3600 * 1000
function siteIconKey(u) { try { const o = new URL(u); return crypto.createHash('md5').update(o.origin).digest('hex').slice(0, 16) } catch (_) { return '' } }
/* 高清阈值：缓存文件名带质量分 {key}.q{score}.{ext}，≥ 此分才算「已经是原版高清」，不再重抓。
 * 分数：头部原版 <img logo> 1500 · SVG 图标 1000+ · manifest/apple-touch 大图 ≤900 · favicon.ico 10 */
const SITE_ICON_HQ = 700
/* 「上次尝试抓取」的时间戳({key}.try)：同一天内不重复去抓同一个站 —— 老逻辑每次进网站页
 * 都把低分的站重新排一遍队，配合 4 秒一次的前端轮询，等于对着 40 多个站无限重抓。 */
const SITE_ICON_TRY_MS = 24 * 3600 * 1000
function siteIconMarkTry(key) { siteIconBust(); try { fs.writeFileSync(path.join(SITE_ICON_DIR(), key + '.try'), String(Date.now())) } catch (_) {} }
function siteIconTriedRecently(key) {
  try { const st = fs.statSync(path.join(SITE_ICON_DIR(), key + '.try')); return Date.now() - st.mtimeMs < SITE_ICON_TRY_MS } catch (_) { return false }
}
/* 图标目录清单缓存 + key 索引（2026-10-15）。
 * 起因：siteIconExisting() 原来每调用一次就 readdirSync 整个图标目录，然后**把整份文件名清单
 * 逐个 startsWith 比一遍**；而 /api/sites 要为每个站点调一次它，前端又是每 4 秒轮询这个接口。
 * 188 个站 × 200 个文件名 ⇒ 每次请求约 3.8 万次字符串比较 + 188 次 readdirSync。
 * 实测（188 站 / 200 个图标文件）：中位 3.55ms，每 4 秒一轮，纯白烧 —— 而且离线数据目录可能在慢盘上。
 * 做法：一次 readdir，把清单**预折叠成 key → best** 的 Map（语义与原来的循环逐条对齐），
 * 之后每个站点就只是一次 Map.get。TTL 2 秒只是兜底；所有写图标的路径都会 siteIconBust() 立即失效，
 * 所以「抓到新图标 → 前端下一轮就看到」这条链路不受影响。 */
let SITE_ICON_LS = { at: 0, names: null, map: null }
const SITE_ICON_LS_MS = 2000
function siteIconBust() { SITE_ICON_LS = { at: 0, names: null, map: null } }
function siteIconScan() {
  const now = Date.now()
  if (SITE_ICON_LS.names && now - SITE_ICON_LS.at < SITE_ICON_LS_MS) return SITE_ICON_LS
  let names = null
  try { names = fs.readdirSync(SITE_ICON_DIR()) } catch (_) { names = null }   // 目录不存在 = 读不了，返回 null
  let map = null
  if (names) {
    map = new Map()
    const dir = SITE_ICON_DIR()
    for (const n of names) {
      const dot = n.lastIndexOf('.')
      if (dot <= 0) continue
      const key = n.slice(0, dot)
      if (!/^[0-9a-f]{16}$/.test(key)) continue              // 只认 siteIconKey() 产出的 16 位 md5 前缀
      const tail = n.slice(dot + 1)
      if (tail === 'try') continue                           // 尝试记录，不是图标
      if (tail === 'miss' || tail === 'netmiss') {
        const cur = map.get(key)
        if (cur && !cur.miss) continue                       // 已经有真文件，负面标记不算数
        const ttl = tail === 'netmiss' ? SITE_ICON_NETMISS_MS : SITE_ICON_MISS_MS
        let st = {}
        try { st = fs.statSync(path.join(dir, n)) } catch (_) {}
        if (now - (st.mtimeMs || 0) < ttl) map.set(key, { miss: true })
        continue
      }
      /* 文件名两种形态：新格式 key.q{分数}.{ext}，旧格式 key.{ext}（早期抓的低清 favicon，分数记 0） */
      const qm = /^q(\d+)\./.exec(tail)
      const q = qm ? (parseInt(qm[1], 10) || 0) : 0
      const cur = map.get(key)
      if (!cur || cur.miss || q > (cur.q || 0)) map.set(key, { file: path.join(dir, n), q })
    }
  }
  SITE_ICON_LS = { at: now, names, map }
  return SITE_ICON_LS
}
function siteIconNames() { return siteIconScan().names }
function siteIconExisting(key) {
  const m = siteIconScan().map
  if (!m) return null
  return m.get(key) || null
}
/* 抓图标：只走一次跳转、限时 6 秒、限 1.5MB。
 * ⚠ 代理必须用 proxyUrl()：之前写成 `CFG.proxyEnabled && CFG.proxy`，而配置里通常只有 proxy
 * 没有 proxyEnabled（默认=开）→ 被判成「关」→ 全部直连 → 墙外站全超时 ——
 * 这就是「网站卡片没有原版 logo」的根因。另外图标抓取**不查 DIRECT_HOSTS 白名单**：
 * 白名单是给刮削用的（那些源必须直连）；抓 logo 走代理即使国内站也由 clash 规则分流，不亏。 */
function siteIconFetch(url, timeout) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (_) { return reject(new Error('地址不合法')) }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('协议不支持'))
    const mod = u.protocol === 'http:' ? http : https
    const pxy = proxyUrl()
    const rq = mod.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'text/html,image/*,*/*' },
      ...(u.protocol === 'https:' && pxy ? { agent: tunnelAgent(pxy) } : {}),
      timeout: timeout || 6000
    }, rsp => {
      if (rsp.statusCode >= 300 && rsp.statusCode < 400 && rsp.headers.location) {
        rsp.resume()
        let next = ''
        try { next = new URL(rsp.headers.location, url).href } catch (_) {}
        if (!next) return reject(new Error('跳转地址无效'))
        return siteIconFetch(next, timeout).then(resolve, reject)
      }
      if (rsp.statusCode !== 200) { rsp.resume(); return reject(new Error('HTTP ' + rsp.statusCode)) }
      const chunks = []; let n = 0
      rsp.on('data', d => {
        n += d.length
        if (n > 1536 * 1024) { try { rq.destroy() } catch (_) {} ; return reject(new Error('内容过大')) }
        chunks.push(d)
      })
      rsp.on('end', () => resolve({ buf: Buffer.concat(chunks), type: String(rsp.headers['content-type'] || '') }))
      rsp.on('error', reject)
    })
    rq.on('error', reject)
    rq.on('timeout', () => { try { rq.destroy(new Error('超时')) } catch (_) {} ; reject(new Error('超时')) })
  })
}
const SITE_ICON_EXT = t => /svg/i.test(t) ? 'svg' : /png/i.test(t) ? 'png' : /webp/i.test(t) ? 'webp' : /gif/i.test(t) ? 'gif' : /x-icon|vnd\.microsoft\.icon|octet-stream/i.test(t) ? 'ico' : 'png'
/* 首页 HTML 里找 <link rel="icon|shortcut icon|apple-touch-icon" href="…">
 * —— 很多站点的 /favicon.ico 是 404，真正的图标写在 HTML 里。 */
function siteIconFromHtml(html, base) {
  const out = []
  const re = /<link\b[^>]*\brel\s*=\s*["']?([^"'>]*icon[^"'>]*)["']?[^>]*>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0]
    const h = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1]
    if (!h) continue
    try { out.push(new URL(h, base).href) } catch (_) {}
    if (out.length >= 4) break
  }
  return out
}
/* ---- 原版高清 logo（2026-10-15 需求：「我要他原版高清 logo」）----
 * 之前只抓 /favicon.ico（16~32px，糊）且代理判断写反 → 墙外站全超时，卡片只剩内嵌字母标。
 * 现在改成抓**站点自己的原版 logo**，按清晰度打分、从好到差试：
 *   q1500  首页头部 <img …logo…>（站点自己摆在脑袋上的横标，就是用户截图里那种）
 *   q1000+ <link rel=icon type=image/svg+xml> / mask-icon（矢量，无限清晰）
 *   q≤900  manifest icons（512 很常见）· apple-touch-icon（规范默认 180px）· 标了 sizes 的 icon
 *   q10    /favicon.ico（保底）
 * 文件名 {key}.q{score}.{ext}：已有 ≥700（SITE_ICON_HQ）不再重抓；低于的会趁后台队列升级。 */
/* 读图片真实宽高（PNG / GIF / JPEG / WEBP）—— 判断「这是不是一枚图标」用。
 * 老逻辑只按「<img> 标签里带 logo 字样」猜，结果把首页那种 1200×630 的大横幅、
 * 剧照、宣传图当成了 logo 缓存下来 → 用户看到的就是「图片是错的」。 */
function siteIconDim(b, ext) {
  try {
    if (b.length > 24 && b.subarray(0, 4).toString('binary') === '\x89PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    if (b.length > 10 && b.subarray(0, 3).toString('binary') === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {                 // JPEG：扫 SOF 段
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue }
        const m = b[i + 1]
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
        const len = b.readUInt16BE(i + 2)
        if (len < 2) break
        i += 2 + len
      }
      return null
    }
    if (b.length > 30 && b.subarray(8, 12).toString('binary') === 'WEBP') {
      const t = b.subarray(12, 16).toString('binary')
      if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
      if (t === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 } }
    }
  } catch (_) {}
  return null
}
/* 「长得像不像一枚图标 / logo」：太宽太扁 = 横幅，太大 = 封面 / 剧照，太小 = 糊 */
function siteIconShapeOk(dim) {
  if (!dim || !dim.w || !dim.h) return true                   // 认不出尺寸就不拦（SVG / ICO 走这里）
  if (dim.w < 40 && dim.h < 40) return false                  // 16px 那种太小，还不如用内嵌矢量 logo
  if (dim.w > 1000 || dim.h > 1000) return false              // 大图基本是主图 / 剧照
  const ar = dim.w / dim.h
  if (ar > 6.5 || ar < 0.16) return false                     // 超宽横幅 / 超窄竖条：不是 logo
  return true
}
function siteIconSniff(buf, type) {
  const h = buf.subarray(0, 12).toString('binary')
  if (/svg/i.test(type) || h.includes('<svg')) return 'svg'
  if (h.startsWith('\x89PNG')) return 'png'
  if (h.startsWith('GIF8')) return 'gif'
  if (h.startsWith('\xff\xd8\xff')) return 'jpg'
  if (/webp/i.test(type) || h.slice(8, 12) === 'WEBP') return 'webp'
  if (h.startsWith('\x00\x00\x01\x00') || /icon/i.test(type)) return 'ico'
  return ''
}
function siteIconCandidates(html, base) {
  const out = []
  const push = (u, score, kind) => { try { if (!u || /^data:/i.test(u)) return; out.push({ url: new URL(u, base).href, score, kind }) } catch (_) {} }
  let m
  const imgRe = /<img\b[^>]*>/gi
  while ((m = imgRe.exec(html))) {
    const tag = m[0]
    if (!/logo/i.test(tag)) continue
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1]
    if (src) push(src, 1500, 'logoimg')
    if (out.filter(c => c.kind === 'logoimg').length >= 4) break
  }
  const linkRe = /<link\b[^>]*>/gi
  while ((m = linkRe.exec(html))) {
    const tag = m[0]
    const rel = ((tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || '').toLowerCase()
    if (!/icon|manifest/.test(rel)) continue
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1]
    if (!href) continue
    if (/manifest/.test(rel)) { push(href, -1, 'manifest'); continue }
    const sizes = (tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i) || [])[1] || ''
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || ''
    const sm = /(\d+)\s*x\s*(\d+)/i.exec(sizes); const size = sm ? parseInt(sm[1]) : 0
    if (/svg/.test(type) || /\.svg/i.test(href)) push(href, 1000 + (size || 400), 'svg')
    else if (/apple-touch/.test(rel)) push(href, Math.max(size, 180), 'png')
    else push(href, size || 16, 'icon')
  }
  return out.sort((a, b) => b.score - a.score)
}
/* 已缓存的这份图标是不是「垃圾」：老算法用「<img> 标签里带 logo 字样」猜出来的横幅 / 剧照 /
 * 超大图 / JPEG 照片。是垃圾的话，新抓到的**哪怕分数更低也允许覆盖** —— 否则脏数据永远换不掉，
 * 用户看到的就一直是「图片是错的」。 */
function siteIconJunk(file) {
  try {
    const st = fs.statSync(file)
    if (st.size > 600 * 1024) return true
    const ext = (file.match(/\.(\w+)$/) || [])[1] || ''
    if (/^jpe?g$/i.test(ext)) return true
    if (/^(ico|svg)$/i.test(ext)) return false
    const d = siteIconDim(fs.readFileSync(file), ext)
    if (!d || !d.w || !d.h) return false
    return !siteIconShapeOk(d)
  } catch (_) { return false }
}
/* 取图标 → 返回 { buf, type } 或抛错；同时负责落盘缓存 / 负面标记。
 *
 * ⚠ 2026-10-15 大修（用户反馈「网站图片一直在刷新」+「很多图片都是错的」）：
 * 老逻辑是「有缓存但分数 < 700 就重抓一次」，而 /api/sites/icon（每张卡的 <img> 都打它）
 * 也在调这个函数 → 卡片每 4 秒重画一次 → 每张图都发起一次联网重抓 → 抓到什么就覆盖
 * 什么（甚至抓到更差的 q10 favicon 把 q60 顶掉）→ mtime 变 → 前端判定「图变了」→ 再重画……
 * 无限循环，图就一直闪、一直换。现在：
 *   opts.cacheOnly  → 图片接口只读缓存，未命中立刻 404 并排进后台队列（绝不在请求里联网）
 *   opts.upgrade    → 后台队列专用：允许联网，但**只升级不降级**（score 必须更高才覆盖）
 *   opts.force      → 手动「重抓图标」：忽略 .try / 负面缓存
 */
async function siteIconEnsure(rawUrl, opts) {
  const o = opts || {}
  const u = siteNormUrl(rawUrl)
  if (!u) throw new Error('网址不合法')
  const key = siteIconKey(u)
  if (!key) throw new Error('网址不合法')
  const hit = siteIconExisting(key)
  const oldQ = (hit && hit.file) ? (hit.q || 0) : 0
  const readHit = () => {
    try { return { buf: fs.readFileSync(hit.file), type: (hit.file.match(/\.(\w+)$/) || [])[1] || 'png' } } catch (_) { return null }
  }
  if (hit && hit.file && (o.cacheOnly || !o.upgrade || oldQ >= SITE_ICON_HQ)) {
    const r = readHit()
    if (r) return r
  }
  if (o.cacheOnly) {
    /* 图片接口路径：没有缓存就立刻放弃，把它排进后台队列，下次轮询自然出现 */
    try { siteIconWarm([{ url: u }]) } catch (_) {}
    throw new Error('图标还没缓存好')
  }
  if (hit && hit.miss && !o.force) throw new Error('之前取不到（已缓存 7 天）')
  const o2 = new URL(u)
  const origin = o2.origin
  siteIconMarkTry(key)                                   // 记一笔：24 小时内不再自动重试
  let html = ''
  try {
    const page = await siteIconFetch(origin + '/', 10000)
    if (/html|text/i.test(page.type || '')) html = page.buf.toString('utf8').slice(0, 500000)
  } catch (_) {}
  const cands = siteIconCandidates(html, origin)
  const man = cands.find(c => c.kind === 'manifest')
  if (man) {
    try {
      const r = await siteIconFetch(man.url, 8000)
      const j = JSON.parse(r.buf.toString('utf8'))
      const icons = (j.icons || []).map(i => ({ src: i.src, s: parseInt((/(\d+)/.exec(String(i.sizes || '')) || [])[1]) || 0 })).sort((a, b) => b.s - a.s)
      if (icons[0] && icons[0].src) cands.push({ url: new URL(icons[0].src, man.url).href, score: Math.min(icons[0].s || 96, 900), kind: 'manifest' })
    } catch (_) {}
  }
  /* icon.horse 排在**自己的 favicon 之后**（5 < 10）：它是聚合服务，遇到不认识的站会给
   * 一张「域名首字母」的替代图 —— 那正是用户说的「图片是错的」。只有在站点自己什么都不给
   * 的时候才用它兜一下。 */
  cands.push({ url: origin + '/favicon.ico', score: 10, kind: 'ico' })
  cands.push({ url: 'https://icon.horse/icon/' + o2.hostname, score: 5, kind: 'horse' })
  cands.sort((a, b) => b.score - a.score)
  let buf = null, ext = '', score = 0, answered = false, tried = 0
  for (const c of cands) {
    if (tried++ >= 8) break
    try {
      const r = await siteIconFetch(c.url, 8000)
      answered = true
      if (!r.buf || r.buf.length < 250) continue
      const e2 = siteIconSniff(r.buf, r.type)
      if (!e2) continue
      if (e2 === 'svg') { if (r.buf.length > 300 * 1024) continue }
      else {
        if (r.buf.length > 600 * 1024) continue                       // logo 再大就是 banner 了
        const dim = siteIconDim(r.buf, e2)
        if (dim && !siteIconShapeOk(dim)) {
          /* 形状不对：横幅 / 剧照 / 16px 糊图。
           * 但「站点自己的 favicon.ico / 标了 sizes 的 icon」即使小也收 —— 那是它唯一的官方图标。 */
          const official = (c.kind === 'ico' || c.kind === 'icon' || c.kind === 'png')
          if (!official) continue
          if (dim.w < 24 && dim.h < 24) continue
          if (c.score < SITE_ICON_HQ && (dim.w > 1000 || dim.h > 1000)) continue
        }
        if (e2 === 'jpg' && c.score >= 1000) continue                 // logo 位给的是照片 → 不是 logo
      }
      buf = r.buf; ext = e2; score = c.score
      break
    } catch (e) { if (/HTTP \d/.test(String(e && e.message))) answered = true }   // 有 HTTP 应答 = 站点可达
  }
  try { fs.mkdirSync(SITE_ICON_DIR(), { recursive: true }) } catch (_) {}
  siteIconBust()   // 这一趟无论如何都会动目录（删脏图 / 写负面标记 / 落新图），先把清单缓存作废
  if (!buf) {
    /* 没抓到更好的：已有旧文件就留着用；但旧文件本身是垃圾（横幅 / 照片 / 超大图）就删掉，
     * 让卡片退回内嵌矢量 logo —— 留着一张 1.6MB 的剧照当「图标」才是真的难看。 */
    if (hit && hit.file) {
      if (siteIconJunk(hit.file)) { try { fs.unlinkSync(hit.file) } catch (_) {} }
      else { const r = readHit(); if (r) return r }
    }
    /* 站点答了但没图标 → 7 天内不再问；纯粹连不上/超时 → 只记 3 小时，过会儿还会再试 */
    try { fs.writeFileSync(path.join(SITE_ICON_DIR(), key + (answered ? '.miss' : '.netmiss')), '') } catch (_) {}
    throw new Error(answered ? '这个站点没给可用的图标' : '连不上这个站点')
  }
  /* ⚠ 只升级不降级（但要能修脏数据）：抓到的比现有的差 → 留着旧的；
   * 除非旧的本身是垃圾（横幅 / 剧照 / 超大图），那就必须换掉。 */
  if (hit && hit.file && score <= oldQ && !siteIconJunk(hit.file)) { const r = readHit(); if (r) return r }
  /* 抓到了更好的：清掉同 key 的旧图标（负面标记和 .try 留着）再落盘 */
  let es = []; try { es = fs.readdirSync(SITE_ICON_DIR()) } catch (_) {}
  for (const n of es) {
    if (!n.startsWith(key + '.')) continue
    if (n === key + '.try' || n === key + '.miss' || n === key + '.netmiss') continue
    try { fs.unlinkSync(path.join(SITE_ICON_DIR(), n)) } catch (_) {}
  }
  try { fs.unlinkSync(path.join(SITE_ICON_DIR(), key + '.miss')) } catch (_) {}
  try { fs.unlinkSync(path.join(SITE_ICON_DIR(), key + '.netmiss')) } catch (_) {}
  try { fs.writeFileSync(path.join(SITE_ICON_DIR(), key + '.q' + score + '.' + ext), buf) } catch (_) {}
  return { buf, type: ext }
}
/* 「🔍 获取图标」（2026-10-15 需求：像 iTab 新标签页那样，输入网址后列出候选图标挑）：
 * 把站点用过的图标**并行**抓回来，统一转成 data URI 交给前端。
 * 为什么转 data URI：候选图若只给浏览器地址，很多站有防盗链 / 需要 referer，列表里会一片破图；
 * 而且用户选中后要把图存进配置里 —— data URI 正好能直接存，以后断网也在。 */
async function siteIconCandidatesFor(rawUrl) {
  const u = siteNormUrl(rawUrl)
  if (!u) throw new Error('网址不对（要 http/https 的完整地址）')
  const o = new URL(u)
  const origin = o.origin
  let html = ''
  try {
    const page = await siteIconFetch(origin + '/', 10000)
    if (/html|text/i.test(page.type || '')) html = page.buf.toString('utf8').slice(0, 500000)
  } catch (_) {}
  const cands = siteIconCandidates(html, origin)
  const man = cands.find(c => c.kind === 'manifest')
  if (man) {
    try {
      const r = await siteIconFetch(man.url, 8000)
      const j = JSON.parse(r.buf.toString('utf8'))
      const icons = (j.icons || [])
        .map(i => ({ src: i.src, s: parseInt((/(\d+)/.exec(String(i.sizes || '')) || [])[1]) || 0 }))
        .sort((a, b) => b.s - a.s).slice(0, 3)
      for (const ic of icons) if (ic.src) cands.push({ url: new URL(ic.src, man.url).href, score: Math.min(ic.s || 96, 900), kind: 'manifest' })
    } catch (_) {}
  }
  /* icon.horse 放最后（给的是域名首字母替代图，只在站点自己什么都不给时才有意义） */
  cands.push({ url: origin + '/favicon.ico', score: 10, kind: 'ico' })
  cands.push({ url: 'https://icon.horse/icon/' + o.hostname, score: 4, kind: 'horse' })
  const seen = new Set(), use = []
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (!c.url || seen.has(c.url)) continue
    seen.add(c.url); use.push(c)
    if (use.length >= 12) break
  }
  const LABEL = { logoimg: '页面 logo', svg: '矢量', manifest: '应用图标', png: '站点图标', icon: '站点图标', ico: 'favicon', horse: '第三方' }
  const got = await Promise.all(use.map(async c => {
    try {
      const r = await siteIconFetch(c.url, 8000)
      if (!r.buf || r.buf.length < 100 || r.buf.length > 320 * 1024) return null
      const e2 = siteIconSniff(r.buf, r.type)
      if (!e2) return null
      const dim = e2 === 'svg' ? null : siteIconDim(r.buf, e2)
      const mime = e2 === 'svg' ? 'image/svg+xml' : e2 === 'ico' ? 'image/x-icon' : e2 === 'webp' ? 'image/webp'
        : e2 === 'gif' ? 'image/gif' : e2 === 'jpg' ? 'image/jpeg' : 'image/png'
      return {
        url: c.url, kind: c.kind, score: c.score, label: LABEL[c.kind] || '图标',
        w: dim ? dim.w : 0, h: dim ? dim.h : 0, bytes: r.buf.length,
        transparent: e2 === 'svg',
        data: 'data:' + mime + ';base64,' + r.buf.toString('base64')
      }
    } catch (_) { return null }
  }))
  /* 去掉内容完全相同的重复项（很多站 favicon.ico 和 <link icon> 是同一张图） */
  const out = [], marks = new Set()
  for (const it of got) {
    if (!it) continue
    const m = it.bytes + '|' + it.data.slice(0, 160)
    if (marks.has(m)) continue
    marks.add(m); out.push(it)
  }
  return out
}
/* 图标预热队列：进「网站」页时后台一个个去取（并发 1、间隔 1.2s），
 * 取到一个是一次（缓存住），前端那 4 秒的轮询自己会把新图标画上去。
 * 为什么不靠前端每张卡发一个 /api/sites/icon：25 个站点一次进页面就是 25 个并发请求，
 * 被墙的站点还会各挂 6~8 秒，把页面的图片通道全堵住。
 * 已有高清（≥SITE_ICON_HQ）或负面缓存内的不排队；**已有低清的会排队升级**。 */
const SITE_ICON_Q = []
let SITE_ICON_BUSY = false
/* 本次运行里已经排过队的 key：低分图标**每次启动最多升一次**，
 * 再配合 .try 的 24 小时闸门 → 同一个站在同一天不会被反复重抓。 */
const SITE_ICON_UPGRADED = new Set()
function siteIconWarm(list, force) {
  for (const x of (list || [])) {
    const key = siteIconKey(x.url)
    if (!key) continue
    if (SITE_ICON_Q.some(t => t.key === key)) continue
    if (!force) {
      const ex = siteIconExisting(key)
      if (ex && ex.miss) continue                        // 负面缓存内（7 天 / 3 小时）
      if (ex && (ex.q || 0) >= SITE_ICON_HQ) continue     // 已经是原版高清
      if (ex && ex.file && siteIconTriedRecently(key)) continue   // 今天试过了
      if (SITE_ICON_UPGRADED.has(key)) continue
    }
    SITE_ICON_UPGRADED.add(key)
    SITE_ICON_Q.push({ key, url: x.url, force: !!force })
  }
  siteIconRun()
}
function siteIconRun() {
  if (SITE_ICON_BUSY) return
  const job = SITE_ICON_Q.shift()
  if (!job) return
  SITE_ICON_BUSY = true
  const done = () => { SITE_ICON_BUSY = false; setTimeout(() => { try { siteIconRun() } catch (_) {} }, 1200) }
  try { siteIconEnsure(job.url, { upgrade: true, force: job.force }).then(done, done) } catch (_) { done() }
}

/* ---- 一键测网络（2026-10-15 需求：「加个一键测试当前网络是否能访问的按钮」）----
 * 判据刻意**不是**「HTTP 200」：很多站点对匿名请求回 403 / 401 / 302，这恰恰说明
 * 网络是通的、只是站点不让匿名进 —— 标成红色会让用户误以为是自己的网有问题。
 * 只有 DNS 解析不了 / 连接被拒 / 超时 / 证书错才算「连不上」。
 * 并发 6、单个超时 6s；任务在后台跑，前端轮询读进度（73 个站最坏 ~75s，但有实时进度不难受）。 */
const SITE_PROBE_TIMEOUT = 6000
const SITE_PROBE_CONC = 6
let SITE_PROBE = null
function siteProbeErr(e) {
  const m = String((e && e.message) || e || '')
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return '域名解析不了（被墙 / 网址写错）'
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝'
  if (/ECONNRESET|EPIPE|socket hang up/i.test(m)) return '连接被重置（多半被墙）'
  if (/ETIMEDOUT|timeout|超时/i.test(m)) return '超时没应答'
  if (/certificate|self.signed|SSL|TLS/i.test(m)) return '证书有问题'
  return m || '连不上'
}
function siteProbeOne(rawUrl, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let u = null
    try { u = new URL(siteNormUrl(rawUrl) || '') } catch (_) {}
    if (!u) return resolve({ pass: false, ms: 0, err: '地址不合法' })
    const mod = u.protocol === 'http:' ? http : https
    const pxy = proxyUrl()
    const tmo = timeout || SITE_PROBE_TIMEOUT
    let fin = false
    const done = r => { if (fin) return; fin = true; resolve(Object.assign({ ms: Date.now() - t0 }, r)) }
    let rq = null
    try {
      rq = mod.get({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: (u.pathname + u.search) || '/',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 JavPaco/1.0', Accept: 'text/html,*/*' },
        ...(u.protocol === 'https:' && agentMaybe(u, pxy) ? { agent: agentMaybe(u, pxy) } : {}),
        timeout: tmo
      }, rsp => {
        const code = rsp.statusCode || 0
        try { rsp.destroy() } catch (_) {}
        try { rq.destroy() } catch (_) {}
        done({ pass: true, code })          // 拿到任何 HTTP 应答 = 网络可达
      })
    } catch (e) { return done({ pass: false, err: siteProbeErr(e) }) }
    rq.on('error', e => done({ pass: false, err: siteProbeErr(e) }))
    rq.on('timeout', () => {
      try { rq.destroy() } catch (_) {}
      done({ pass: false, err: '超时（' + Math.round(tmo / 1000) + ' 秒没应答）' })
    })
  })
}
/* 跑一轮：结果记进个人层的 stats（`net` 字段，跟 sites.json 一起落盘，重启后还知道上次结果）。
 * ⚠ 2026-10-15：内置站点库是只读的，测试结果不能写回站点条目本身 —— 按 host 记进个人层。 */
function siteProbeRun(ids) {
  const s = sitesLoad()
  const want = (ids && ids.length) ? ids : null
  const list = s.list.filter(x => !want || want.indexOf(x.id) >= 0)
  const task = { id: 'p' + Date.now().toString(36), at: Date.now(), running: true, total: list.length, done: 0, pass: 0, fail: 0, results: {} }
  SITE_PROBE = task
  let i = 0
  const worker = async () => {
    for (;;) {
      const k = i++
      if (k >= list.length) return
      const it = list[k]
      let r
      try { r = await siteProbeOne(it.url, SITE_PROBE_TIMEOUT) } catch (_) { r = { pass: false, ms: 0, err: '测试异常' } }
      task.done++
      if (r.pass) task.pass++; else task.fail++
      const rec = { ok: r.pass ? 1 : 0, code: r.code || 0, ms: r.ms, err: r.err || '', at: Date.now() }
      task.results[it.id] = rec
      it.net = rec
      const h = it.host || siteHostOf(it.url)
      if (h) { const mine = sitesMineLoad(); const st = mine.stats[h] || (mine.stats[h] = {}); st.net = rec }
    }
  }
  const n = Math.max(1, Math.min(SITE_PROBE_CONC, list.length))
  return Promise.all(Array.from({ length: n }, worker)).then(() => {
    task.running = false
    task.endedAt = Date.now()
    try { sitesSave() } catch (_) {}
    console.log('[sites] 网络测试完成：' + task.pass + ' 个可访问 / ' + task.fail + ' 个连不上（共 ' + task.total + '，耗时 ' + Math.round((task.endedAt - task.at) / 1000) + 's）')
    return task
  })
}


/* 每个媒体库的运行统计：收录了多少视频、识别成功多少、失败多少、有封面多少（设置页逐库显示） */
function libStats() {
  const items = (DATA && DATA.items) || []
  const hostRoot = readMediaPathFile() || ''
  /* rel 只用于统计匹配（relVideo 本来就是相对 MEDIA_ROOT 的）。
   * ⚠ 显示路径不能用 rel 拼：原生 Windows 下 MEDIA_ROOT 是「多库公共祖先」（库为空时兜底 C:\），
   * 加一个 D:\115\AV 会 rel 成 'D:\115\AV' 再 join 出 'C:\D:\115\AV' 这种怪路径。
   * 容器/挂载部署（有 media-path.txt）才需要 hostPath 映射；原生 Windows 直接显示系统文件夹路径。 */
  const nativeWin = process.platform === 'win32' && !hostRoot
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
    const hostPath = nativeWin ? p : (rel ? path.join(hostRoot || MEDIA_ROOT, rel) : (hostRoot || MEDIA_ROOT))
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
    const verOf = dir => { try { return parseInt(fs.readFileSync(path.join(dir, 'SEED_VER'), 'utf8').trim(), 10) || 0 } catch (_) { return 0 } }
    const sVer = verOf(path.join(UI_ROOT, 'sample-cache'))
    let dVer = verOf(cacheDir())
    if (!cur.length) {   // 首次：整包拷进去
      fs.mkdirSync(dst, { recursive: true })
      let n = 0
      for (const d of fs.readdirSync(src)) {
        if (d.startsWith('.')) continue
        try { fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true }); n++ } catch (_) {}
      }
      try { fs.writeFileSync(path.join(cacheDir(), 'SEED_VER'), String(sVer)) } catch (_) {}
      if (n) console.log('[seed] 首次运行：已载入 ' + n + ' 部示例影片到离线缓存（配置媒体库后自动让位）')
      return
    }
    if (sVer > dVer) {   // 老用户升级：只刷新示例影片的图片（海报/大图换高清），不碰 meta 和真实影片
      let n = 0
      for (const d of fs.readdirSync(src)) {
        if (d.startsWith('.') || !cur.includes(d)) continue
        try { fs.cpSync(path.join(src, d, 'images'), path.join(dst, d, 'images'), { recursive: true }); n++ } catch (_) {}
      }
      try { fs.writeFileSync(path.join(cacheDir(), 'SEED_VER'), String(sVer)) } catch (_) {}
      if (n) console.log('[seed] 示例资源升级 v' + sVer + '：刷新 ' + n + ' 部示例图片')
    }
  } catch (e) { console.log('[seed] 示例数据载入失败：' + e.message) }
}
seedSamples()
/* 启动不自动扫描（v0.2.28）：映射的可能是 115 云盘等慢挂载，开机就全量扫会拖垮启动、
 * 还会打爆网盘 API。启动只把离线缓存载入内存做展示（示例影片/已刮削条目）；
 * 真实媒体库扫描只在这些时机触发——设置页添加/删除媒体库、修改配置、手动「重扫」、
 * 设置里开启的每日自动重扫。 */
function bootOfflineCache() {
  const mroot = path.join(cacheDir(), 'movies')
  let ces = []
  try { ces = fs.readdirSync(mroot, { withFileTypes: true }).filter(x => x.isDirectory()) } catch (_) {}
  const items = []
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
  return items
}
{
  const offline = bootOfflineCache()
  /* 恢复上次扫描结果：本地条目（含 relVideo/files 播放信息）+ 离线数据条目合并去重。
   * 条目重跑一遍 enrichFromCache → 取到最新刮削元数据（扫描后新刮的也能立即生效）。
   * 整体兜底 try：恢复失败退回「只有离线条目」，绝不让启动挂掉。 */
  let saved = null
  try { saved = loadScanResult() } catch (_) {}
  let restored = false
  try {
    if (saved && saved.items.length) {
      /* 库 → 相对 MEDIA_ROOT 的前缀。⚠ 必须用 path.relative 归一，不能 String.replace：
       * 配置里存的是原始字符串（可能是正斜杠 'D:/x/y'），MEDIA_ROOT 是反斜杠，纯替换会落空，
       * 前缀变完整绝对路径 → 本地条目全部匹配失败被丢掉（2026-10-13 测试实测踩中）。 */
      const libs = (Array.isArray(CFG.libraries) ? CFG.libraries : [])
        .map(p => {
          const rel = path.relative(MEDIA_ROOT, String(p)).split(path.sep).join('/')
          return (rel === '' || rel === '..' || rel.startsWith('../')) ? '' : rel.replace(/^\/+/, '').replace(/\/+$/, '')
        })
      const keep = saved.items.filter(it => it && it.relVideo &&
        (v115Rel(it.relVideo) || !libs.length || libs.some(l => !l || it.relVideo === l || it.relVideo.startsWith(l + '/'))))
      const K = it => String((it && it.code) || (it && it.relVideo) || '').toUpperCase()
      const map = new Map()
      for (const it of offline) map.set(K(it), it)
      for (const it of keep) {
        try { enrichFromCache(it) } catch (_) {}
        const k = K(it), v = map.get(k)
        if (v) { delete it.cachedOnly; if (!it.mtime && v.mtime) it.mtime = v.mtime }
        map.set(k, it)
      }
      const merged = [...map.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      DATA = { root: saneRoot(saved.root) || readMediaPathFile() || MEDIA_ROOT, generated: Date.now(), items: merged }
      schedulePreviews()   // 启动恢复扫描结果 → 给实体影片补生成悬停预览
      console.log('[scan] 启动恢复上次扫描结果：本地 ' + keep.length + ' 部 + 离线缓存 ' + offline.length + ' 部 → 共 ' + merged.length + ' 条' +
        (saved.savedAt ? '（结果存于 ' + new Date(saved.savedAt).toLocaleString('zh-CN') + '；要刷新请点重扫）' : ''))
      restored = true
    }
  } catch (e) { console.log('[scan] 恢复扫描结果失败（退回离线条目）：' + e.message) }
  if (!restored) {
    DATA = { root: readMediaPathFile() || MEDIA_ROOT, generated: Date.now(), items: offline }
    schedulePreviews()   // 离线缓存兜底启动 → 给实体影片补生成悬停预览
    console.log('[scan] 启动不自动扫描：已载入离线缓存 ' + offline.length + ' 部做展示；媒体库扫描请在添加页添加/重扫触发')
  }
}
/* 启动即自动补刮缺封面影片：恢复上次扫描结果（无论本地还是离线兜底）后，把没海报图的番号
 * 排队刮削。这样重启 app 后封面会自动补齐，不必每次都手动「重扫」或点进详情页。
 * 延后 1.5s 触发，避免和启动期 IO / 预览生成抢资源；重复启动不会叠加（仅本进程一次）。 */
if (DATA && DATA.items && DATA.items.length && CFG.autoScrapeNew !== false) {
  setTimeout(() => { try { autoQueueMissingCovers(DATA.items, '启动') } catch (_) {} }, 1500)
  /* 来源健康：把已配置的来源登记进自检表，30s 后的首轮巡检会把它们各探一次
   * （卡片状态从启动就是准的；哪个源掉线/恢复了也全自动，不用手点）*/
  try { srcHealthSeed() } catch (_) {}
}
/* 启动 25 秒后补一轮网盘片源分辨率（历史条目第一次拿分辨率靠它；之后有缓存，不再重复探测） */
setTimeout(() => { resBackfillRun('启动').catch(() => {}) }, 25000)
console.log('[115] 请求节奏：' + v115PaceOf() + '（基础间隔 ' + v115GapBase() + 'ms；网盘与推送共用一条串行队列，设置 → 115 推送 → 请求节奏 可调）')
recomputeMediaRoot()   // 用已扫数据根统一媒体根基准，修正 relVideo 历史路径错位（库层级变更后不重扫也能正确解析）
/* 115 播放凭据重建：从已恢复的扫描结果里把 relVideo → pickcode 填回内存表，
 * 这样「重启后还没重扫」也能直接播放 115 上的片子 */
rebuildV115Map()
if (V115_MAP.size) console.log('[115] 已从扫描结果恢复 ' + V115_MAP.size + ' 个网盘文件的可播放索引')
/* WebDAV / 光鸭：同样从已恢复的扫描结果重建 relVideo 索引（播放用不到凭据映射，
 * 但 size/mtime 留着给详情页与统计；也是「重启后未重扫也能播」的保证 —— 播放只按路径转发） */
rebuildDavMap()
if (DAV_MAP.size) console.log('[dav] 已从扫描结果恢复 ' + DAV_MAP.size + ' 个 WebDAV/光鸭 文件的索引')
/* 媒体源统计预热（2026-10-15）：sourcesPayload 要逐部遍历 images/（1050 部实测 744ms），
 * 启动后先算一次，用户点进添加页时缓存已在、秒开（不是等到第一次请求才现算）。
 * 目录统计记忆从磁盘读回 → 重启后第一次重建也只剩「每个目录一次 stat」，不再全量遍历。 */
try { srcMemoLoad() } catch (_) {}
srcTotalBytesRefresh().catch(() => {})   // 「整个 cache 占用」后台分片算（同步遍历要 1806ms、会卡死事件循环）
setTimeout(() => { try { SRC_CACHE = { at: Date.now(), data: sourcesPayload() } } catch (_) {} }, 2000)

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

/* 海报墙缩略图生成（纯 JS / jpeg-js，不依赖 ffmpeg —— Mac/Win 原生版没有 ffmpeg 也能出小图；
 * 按需+并发去重+落盘缓存 cache/thumbs/，源图更新自动失效。原图仍留给详情页。） */
const jpegLib = require('jpeg-js')
const THUMB_DIR = () => path.join(cacheDir(), 'thumbs')
const thumbInFlight = new Map()   // key -> Promise<Buffer|null>
/* 盒式降采样（区域均值），比逐点采样更干净，小图也不会糊边 */
function downscaleRGBA(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4)
  const rx = sw / dw, ry = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * ry), sy1 = Math.max(sy0 + 1, Math.min(sh, Math.floor((y + 1) * ry)))
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * rx), sx1 = Math.max(sx0 + 1, Math.min(sw, Math.floor((x + 1) * rx)))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let o = (sy * sw + sx0) * 4
        for (let sx = sx0; sx < sx1; sx++, o += 4) { r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++ }
      }
      const di = (y * dw + x) * 4
      dst[di] = r / n; dst[di + 1] = g / n; dst[di + 2] = b / n; dst[di + 3] = a / n
    }
  }
  return dst
}
async function movieThumb(code, kind) {
  if (!/^[A-Za-z0-9._-]+$/.test(code) || !['poster', 'fanart'].includes(kind)) return null
  const src = path.join(cacheDir(), 'movies', code, 'images', kind + '.jpg')
  let st; try { st = fs.statSync(src) } catch (_) { return null }
  const out = path.join(THUMB_DIR(), code + '-' + kind + '.jpg')
  try {
    const ot = fs.statSync(out)
    if (ot.mtimeMs >= st.mtimeMs) return fs.readFileSync(out)
  } catch (_) {}
  const key = code + '-' + kind
  let pr = thumbInFlight.get(key)
  if (!pr) {
    pr = new Promise(resolve => {
      const done = buf => { thumbInFlight.delete(key); resolve(buf) }
      try { fs.mkdirSync(THUMB_DIR(), { recursive: true }) } catch (_) {}
      // 限高 720（海报）/ 限宽 960（大图），不放大；纯 JS 缩放，无需 ffmpeg
      let raw
      try { raw = jpegLib.decode(fs.readFileSync(src), { useTArray: true, maxMemoryUsageInMB: 256 }) } catch (_) { return done(null) }
      const sw = raw.width, sh = raw.height
      let dw, dh
      if (kind === 'poster') { dh = Math.min(720, sh); dw = Math.max(1, Math.round(sw * dh / sh / 2) * 2) }
      else { dw = Math.min(960, sw); dh = Math.max(1, Math.round(sh * dw / sw / 2) * 2) }
      try {
        const srcData = Buffer.from(raw.data)
        const data = (dw === sw && dh === sh) ? srcData : downscaleRGBA(srcData, sw, sh, dw, dh)
        const enc = jpegLib.encode({ data, width: dw, height: dh }, 80)
        fs.writeFileSync(out, enc.data)
        return done(enc.data)
      } catch (_) { try { fs.unlinkSync(out) } catch (_) {}; return done(null) }
    })
    thumbInFlight.set(key, pr)
  }
  return pr
}

/* ⚠️ 2026-10-10 修「播放器并发 Range 卡住」：stat 必须异步。
 * 原来这里用 fs.statSync —— 对 14GB 的 CloudDrive/FUSE 文件，每次 Range 请求都要
 * 同步 stat 一次，而 FUSE 的 stat 会阻塞 Node 整个事件循环。
 * 播放器并发发多个 Range 时实测：单线程 0.29s，10 并发最慢 11.57s（慢 40 倍），
 * 期间整个服务（含其他响应）全部停摆 → 表现为「播放器卡住不动」。
 * 改成 fs.promises.stat 后事件循环不被占住，并发立刻恢复。 */
/* HEAD /media/<rel>：只回元信息（类型 / 大小 / 支持 Range），一个字节都不读上游（2026-10-16）。
 * 播放器起播前常先探一下；老实现会顺着 GET 那条路把整个文件拉下来 → 永远等不到响应。
 * ⚠ 这里刻意不用 await（外层请求处理函数不是 async）：本地文件走 fs.promises.stat 的回调式写法，
 *   避免对 CloudDrive/FUSE 用 statSync（那会阻塞整个事件循环，见 sendFile 上方的注释）。 */
function mediaHead(res, rel) {
  try {
    const type = MIME['.' + extOf(rel).toLowerCase()] || 'application/octet-stream'
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
    const done = () => { try { res.writeHead(200, h); res.end() } catch (_) {} }
    if (v115Rel(rel)) {                              // 115：大小取扫描时记下的（拿不到就不给 Content-Length）
      const sz = (V115_MAP.get(rel) || {}).size || 0
      if (sz > 0) h['Content-Length'] = String(sz)
      return done()
    }
    if (davRel(rel)) {                               // WebDAV / 光鸭：同上
      const sz = (DAV_MAP.get(rel) || {}).size || 0
      if (sz > 0) h['Content-Length'] = String(sz)
      return done()
    }
    const fp = safeMediaPath(rel)
    if (!fp) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Forbidden') }
    return fs.promises.stat(fp).then(st => {
      if (!st.isFile()) { res.writeHead(404); return res.end('Not Found') }
      h['Content-Length'] = String(st.size)
      done()
    }).catch(() => { res.writeHead(404); res.end('Not Found') })
  } catch (e) {
    try { if (!res.headersSent) res.writeHead(500) } catch (_) {}
    try { res.end() } catch (_) {}
  }
}

/* retag = true 时会对 mp4 先做一次 HEVC 探测（hev1 → hvc1），探测失败原样透传。
 * 探测结果带缓存，同一文件只探一次，正常播放路径上没有额外开销。 */
function sendFile(req, res, fp, retag) {
  fs.promises.stat(fp).then(async st => {
    let patch = null
    if (retag && HEV1_RETAG) {
      try { patch = await hev1PatchForLocal(fp, st.size, st.mtimeMs) } catch (_) { patch = null }
    }
    try { sendFileWithStat(req, res, fp, st, patch) } catch (e) {
      try { res.writeHead(500) } catch (_) {}
      res.end('Error: ' + e.message)
    }
  }).catch(() => { res.writeHead(404); res.end('Not Found') })
}
function sendFileWithStat(req, res, fp, st, patch) {
  if (!st.isFile()) { res.writeHead(404); return res.end('Not Found') }
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'
  /* 协商缓存：ETag = 大小 + mtime，内容没变直接回 304
   * （index.html 有 600KB，原来 no-store 每次刷新都整包重下，现在第二次访问 0 字节）
   * 图片给 1 小时强缓存；文本用 no-cache —— 仍会来问一次，但拿 304 就用本地副本，
   * 既省流量又不会像强缓存那样在改完代码后看到旧页面。 */
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`
  const lastMod = new Date(st.mtimeMs).toUTCString()
  const isImg = /^image\//.test(type) && !/svg/.test(type)
  /* 缓存策略分四类：
   *   女优头像（/actresses/、actor-cand）→ no-cache（换头像后文件名不变，强缓存会让浏览器一直显示旧图）
   *   其他图片 → 1 小时强缓存（封面/剧照反复出现，省掉重复读盘）
   *   音视频 → no-store（动辄几个 G，不能让浏览器往磁盘缓存里塞；播放靠 Range 按需取）
   *   文本   → no-cache（每次都来问一次，内容没变回 304，改完代码不会看到旧页面） */
  const isAva = /[/\\]actresses[/\\]|actor-cand/.test(fp)
  const cache = isAva ? 'no-cache'
    : isImg ? 'public, max-age=3600'
    : /^(video|audio)\//.test(type) ? 'no-store'
      : 'no-cache'
  const range = req.headers.range
  const inm = req.headers['if-none-match']
  if (!range && inm && String(inm).split(',').map(s => s.trim()).includes(etag)) {
    res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache, 'Vary': 'Accept-Encoding' })
    return res.end()
  }
  /* HEAD：只回头部，别去读文件（图/视频都可能被先探一下；大文件白读一遍纯浪费） */
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size,
      'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache
    })
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
    streamWith(res, fs.createReadStream(fp, { start, end }), patch, start)
  } else {
    res.writeHead(200, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size,
      'ETag': etag, 'Last-Modified': lastMod, 'Cache-Control': cache
    })
    streamWith(res, fs.createReadStream(fp), patch, 0)
  }
}

/* 云盘挂载（115/CloudDrive）里未缓存的占位文件读取会抛 ENXIO，
 * 流上不挂 error 监听的话未捕获异常会直接打挂整个进程 —— 统一经这里 pipe */
function streamWith(res, rs, patch, absStart) {
  rs.on('error', err => {
    console.error(`[stream] 读取失败: ${err.code || ''} ${err.message}`)
    try { if (!res.headersSent) res.writeHead(500) } catch (_) {}
    try { res.destroy() } catch (_) {}
  })
  /* ⚠️ 2026-10-10 加读超时：网盘挂载偶发「连接还在但一个字节都不来」（占位文件回源慢/挂载抖动）。
   * 没有超时的话这条连接会永久占着，播放器就一直等 → 卡住。
   * 只在「开了头但迟迟没数据」时计时；正常传输每有数据就重新计时，不会误杀。*/
  let idle = null
  const IDLE_MS = 30000
  const arm = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      console.error('[stream] 读取超时（' + IDLE_MS / 1000 + 's 无数据），断开该连接')
      try { rs.destroy(new Error('idle timeout')) } catch (_) {}
      try { res.destroy() } catch (_) {}
    }, IDLE_MS)
    if (idle.unref) idle.unref()
  }
  rs.on('data', arm)
  rs.on('end', () => { if (idle) { clearTimeout(idle); idle = null } })
  rs.on('close', () => { if (idle) { clearTimeout(idle); idle = null } })
  arm()
  /* HEVC 重打标：在管道中间插一层改写器（只动 4 个字节，其余原样过）。patch 为 null 时零开销。 */
  if (!patch) { rs.pipe(res); return }
  rs.pipe(hev1Transform(patch, absStart)).pipe(res)
}

/* 造一个「边过边改」的变换流。 */
function hev1Transform(patch, absStart) {
  const { Transform } = require('stream')
  let abs = absStart || 0
  const t = new Transform({
    transform(chunk, enc, cb) {
      try { patch.apply(chunk, abs) } catch (_) {}
      abs += chunk.length
      cb(null, chunk)
    }
  })
  t.on('error', err => console.error('[hev1] 改写流出错：' + err.message))
  return t
}

/* ---------- HEVC hev1 → hvc1 透明重打标（2026-10-16） ----------
 * 症状：某些片子在 Apple 系播放器里「有声音、没画面」（同一个文件 Chrome/VLC 却正常）。
 * 根因：mp4 视频轨的 sample entry 写的是 `hev1`，而 Apple 的 AVFoundation / WKWebView 只认 `hvc1`。
 *       两者都是 HEVC/H.265，差别只在容器里那 4 个字节：`hvc1` 要求参数集(VPS/SPS/PPS)放在 hvcC 盒里，
 *       `hev1` 允许参数集漂在码流里 → Apple 直接拒收视频轨（音轨照放，于是「有声无画」）。
 * 做法：只把流经的那 4 个字节换成 hvc1。视频数据不动、文件长度不变、所有 box 偏移不变
 *       → Content-Length / Range / 断点续传 / moov 定位全部不受影响。
 * 前提：hvcC 里参数集完整（本机实测库内 hev1 文件均满足；AVFoundation 改后实测解出 1920x1080）。
 * 开关：环境变量 HEV1_RETAG=0 可整块关掉（回滚用，改完无需动代码）。
 * 降级：探测失败/超时一律按原样透传，绝不影响播放；结果带缓存，同一文件只探一次。
 * ------------------------------------------------------------------------- */
const HEV1_RETAG = process.env.HEV1_RETAG !== '0'
const HEV1_BAD_TAGS = ['hev1', 'dvhe']          // 需要改成 hvc1 的 sample entry（dvhe = Dolby Vision 的 HEVC）
const HEV1_PROBE_MS = 5000                      // 单次探测总超时，超了就当没有
const HEV1_TTL_OK = 6 * 3600 * 1000             // 探测成功缓存 6 小时
const HEV1_TTL_FAIL = 60 * 1000                 // 探测失败只记 1 分钟（别把网络抖动长期记住）
const HEV1_MAX_MOOV = 96 << 20                  // 单次拉取 moov 的上限，防呆
const HEV1_PROBE_HEAD = 1 << 20                 // 先读 moov 的前 1MB 试解（stsd 基本都在这段里）
const hev1Cache = new Map()

/** 只对 mp4 家族做探测；mkv/avi 的 HEVC 是另一码事，不在本开关范围内 */
const isMp4Rel = rel => /\.(mp4|m4v|mov)$/i.test(String(rel || ''))

function hev1CacheGet(k) {
  const c = hev1Cache.get(k)
  if (!c) return null
  if (Date.now() - c.ts > (c.fail ? HEV1_TTL_FAIL : HEV1_TTL_OK)) { hev1Cache.delete(k); return null }
  return c
}
function hev1CachePut(k, v) {
  if (hev1Cache.size > 400) { let i = 0; for (const kk of hev1Cache.keys()) { hev1Cache.delete(kk); if (++i > 100) break } }
  hev1Cache.set(k, Object.assign({ ts: Date.now() }, v))
}

/** 按 box 结构遍历 [start, end)。允许最后一个 box 越界 —— 探头部时只给 64KB，moov 本体可能有几 MB；
 *  也允许 end 超出 buf（渐进读：只拿了 moov 的前一段，但子盒 size 字段仍指向整块 moov 的边界）。 */
function mp4ListBoxes(buf, start, end) {
  const out = []
  const lim = Math.min(end, buf.length)     // ⚠ 必须收口到 buf 长度，否则 readUInt32BE 会越界抛错
  let pos = start
  while (pos + 8 <= lim) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let hdr = 8
    if (size === 1) {
      if (pos + 16 > lim) break
      size = Number(buf.readBigUInt64BE(pos + 8))
      hdr = 16
    } else if (size === 0) {
      size = lim - pos
    }
    if (size < hdr) break
    out.push({ pos, size, type, hdr })
    if (pos + size > lim) break
    pos += size
  }
  return out
}

/** 在「整块 moov」的 Buffer 里找出视频轨 sample entry 的 fourcc（返回相对 moov 的偏移） */
function mp4VideoEntries(buf) {
  const out = []
  const top = mp4ListBoxes(buf, 0, buf.length)[0]
  if (!top || top.type !== 'moov') return out
  for (const trak of mp4ListBoxes(buf, top.pos + top.hdr, top.pos + top.size)) {
    if (trak.type !== 'trak') continue
    const mdia = mp4ListBoxes(buf, trak.pos + trak.hdr, trak.pos + trak.size).find(k => k.type === 'mdia')
    if (!mdia) continue
    const mdiaKids = mp4ListBoxes(buf, mdia.pos + mdia.hdr, mdia.pos + mdia.size)
    const hdlr = mdiaKids.find(k => k.type === 'hdlr')
    const handler = hdlr ? buf.toString('latin1', hdlr.pos + hdlr.hdr + 8, hdlr.pos + hdlr.hdr + 12) : null
    if (handler !== 'vide') continue                       // 音频轨的 mp4a 不动
    const minf = mdiaKids.find(k => k.type === 'minf')
    if (!minf) continue
    const stbl = mp4ListBoxes(buf, minf.pos + minf.hdr, minf.pos + minf.size).find(k => k.type === 'stbl')
    if (!stbl) continue
    const stsd = mp4ListBoxes(buf, stbl.pos + stbl.hdr, stbl.pos + stbl.size).find(k => k.type === 'stsd')
    if (!stsd) continue
    const entry = stsd.pos + stsd.hdr + 8                  // stsd: version/flags(4) + entry_count(4) + entry
    if (entry + 8 > buf.length) continue
    out.push({ off: entry + 4, tag: buf.toString('latin1', entry + 4, entry + 8) })
  }
  return out
}

/**
 * 通用探测：read(start, len) → Promise<Buffer>。
 * moov 可能在文件头（faststart）也可能在文件尾（用户库里多数如此），两条路都走一遍。
 */
async function hev1ProbeVia(read, total) {
  let moov = null, moovAt = 'head', mdatEnd = -1
  const head = await read(0, Math.min(65536, total))
  for (const b of mp4ListBoxes(head, 0, head.length)) {
    /* ⚠ 这里必须转成 {off,size}：mp4ListBoxes 给的是 pos，两者混用会让下面 read() 静默读错位置 */
    if (b.type === 'moov') { moov = { off: b.pos, size: b.size }; break }
    if (b.type === 'mdat') {
      /* 「mdat 紧邻 moov」是绝大多数压制片的形态：读到 mdat 的 size 就能直接算出 moov 落在哪，
       * 省掉「扫文件尾找 moov」那笔动辄十几 MB 的读 —— 在网盘挂载上这笔就是几秒的起播延迟。 */
      if (b.size > 0 && b.pos + b.size < total) mdatEnd = b.pos + b.size
      break
    }
  }
  if (!moov && mdatEnd >= 0) {
    try {
      const p = await read(mdatEnd, 16)
      if (p.length >= 8 && p.toString('latin1', 4, 8) === 'moov') {
        let sz = p.readUInt32BE(0), hdr = 8
        if (sz === 1 && p.length >= 16) { sz = Number(p.readBigUInt64BE(8)); hdr = 16 }
        if (sz >= hdr && mdatEnd + sz <= total) { moov = { off: mdatEnd, size: sz }; moovAt = 'tail' }
      }
    } catch (_) {}
  }
  if (!moov) {
    moovAt = 'tail'
    const cands = []
    let win = Math.min(4 << 20, total)
    while (win <= Math.min(64 << 20, total)) {
      const buf = await read(total - win, win)
      const base = total - win
      let i = buf.lastIndexOf('moov', buf.length, 'latin1')
      while (i >= 4) {
        const off = base + i - 4
        const size = buf.readUInt32BE(i - 4)
        /* 强校验：offset + size 恰好落在文件末尾的才是真 moov */
        if (size >= 8 && off >= 0 && off + size <= total && !cands.some(c => c.off === off)) {
          cands.push({ off, size, exact: off + size === total })
        }
        i = buf.lastIndexOf('moov', i - 1, 'latin1')
      }
      const hit = cands.find(c => c.exact)
      if (hit) { moov = hit; break }
      win *= 2
    }
    if (!moov) { cands.sort((a, b) => b.size - a.size); moov = cands[0] || null }
  }
  if (!moov) return { offsets: [], vtag: null, moovAt: 'missing' }
  if (!Number.isFinite(moov.off) || moov.off < 0) return { offsets: [], vtag: null, moovAt: 'bad' }
  if (moov.size > HEV1_MAX_MOOV) return { offsets: [], vtag: null, moovAt: 'too-big' }
  /* 视频轨的 stsd 通常落在 moov 很靠前的位置 —— 先读前 1MB 试解，解出来就不必把整个 moov
   * （动辄十几 MB）读一遍。网盘挂载上这一笔就是 1~2 秒的起播延迟差；解不出再老实读全量。 */
  let entries = []
  if (moov.size > HEV1_PROBE_HEAD) entries = mp4VideoEntries(await read(moov.off, HEV1_PROBE_HEAD))
  if (!entries.length) entries = mp4VideoEntries(await read(moov.off, moov.size))
  return {
    offsets: entries.filter(e => HEV1_BAD_TAGS.includes(e.tag)).map(e => moov.off + e.off),
    vtag: entries.length ? entries[0].tag : null,
    moovAt
  }
}

/** 本地文件探测（pread，不动文件指针） */
async function hev1ProbeLocal(fp, size) {
  const fh = await fs.promises.open(fp, 'r')
  try {
    const read = async (start, len) => {
      const b = Buffer.allocUnsafe(len)
      const r = await fh.read(b, 0, len, start)
      return b.subarray(0, r.bytesRead)
    }
    return await hev1ProbeVia(read, size)
  } finally { try { await fh.close() } catch (_) {} }
}

/** 115 直链探测（一串 Range 请求，只读 moov 区段，几 MB 级别） */
async function hev1ProbeRemote(url, ck, total) {
  const base = { 'User-Agent': V115_UA, 'Referer': V115_ORIGIN + '/', 'Accept': '*/*' }
  if (ck) base.Cookie = ck
  const read = async (start, len) => {
    const rs = await fetch(url, {
      headers: Object.assign({}, base, { Range: 'bytes=' + start + '-' + (start + len - 1) }),
      redirect: 'follow'
    })
    try {
      if (rs.status !== 200 && rs.status !== 206) throw new Error('HTTP ' + rs.status)
      return Buffer.from(await rs.arrayBuffer())
    } finally { try { if (rs.body && !rs.bodyUsed) rs.body.cancel() } catch (_) {} }
  }
  return await hev1ProbeVia(read, total)
}

/** 造改写器：offsets 是文件里的绝对偏移 */
function hev1MakePatch(offsets) {
  const offs = offsets.slice().sort((a, b) => a - b)
  return {
    offsets: offs,
    apply(buf, abs) {
      for (let i = 0; i < offs.length; i++) {
        const j = offs[i] - abs
        if (j < 0 || j + 4 > buf.length) continue
        if (HEV1_BAD_TAGS.includes(buf.toString('latin1', j, j + 4))) buf.write('hvc1', j, 4, 'latin1')
      }
    }
  }
}

/** 从 115 的响应头取文件总长（206 看 Content-Range 的 /total，200 看 Content-Length） */
function hev1TotalOf(headers) {
  const cr = headers.get('content-range')
  if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) return parseInt(m[1], 10) }
  const cl = headers.get('content-length')
  if (cl) return parseInt(cl, 10) || 0
  return 0
}
/** 响应体在文件里的绝对起点 */
function hev1AbsStart(headers) {
  const cr = headers.get('content-range')
  if (cr) { const m = /bytes\s+(\d+)-/i.exec(cr); if (m) return parseInt(m[1], 10) }
  return 0
}

function hev1WithTimeout(p, ms) {
  let t = null
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('probe timeout')), ms); if (t.unref) t.unref() })
  ]).finally(() => { if (t) clearTimeout(t) })
}

/** 本地 /media/ 用：拿这个文件该套的改写器（null = 不用改） */
async function hev1PatchForLocal(fp, size, mtimeMs) {
  const key = 'F|' + fp + '|' + size + '|' + Math.round(mtimeMs || 0)
  let info = hev1CacheGet(key)
  if (!info) {
    try { info = await hev1WithTimeout(hev1ProbeLocal(fp, size), HEV1_PROBE_MS) }
    catch (e) { info = { offsets: [], vtag: null, moovAt: 'err', fail: true } }
    hev1CachePut(key, info)
  }
  return (info.offsets && info.offsets.length) ? hev1MakePatch(info.offsets) : null
}

/** 115 直链用：同上的缓存版（key 用 pickcode，它在文件内容不变时稳定） */
async function hev1PatchFor115(pick, url, ck, total) {
  const key = 'V|' + pick
  let info = hev1CacheGet(key)
  if (!info) {
    if (!(total > 0)) return null
    try { info = await hev1WithTimeout(hev1ProbeRemote(url, ck, total), HEV1_PROBE_MS) }
    catch (e) { info = { offsets: [], vtag: null, moovAt: 'err', fail: true } }
    hev1CachePut(key, info)
  }
  return (info.offsets && info.offsets.length) ? hev1MakePatch(info.offsets) : null
}

/* ---------- 女优刮削/编辑 API（详情页「刮削」按钮用） ----------
 * POST /api/actor/scrape  {idx,name,mnid}  → 抓 minnano 资料页，返回最新元数据 + 下载新头像到本地
 * POST /api/actor/save    {idx,name,fields,iconPath,iconData,tags} → 写回 actresses.json / 头像文件
 * 依赖 docker-compose 里项目目录以读写方式挂载（之前是 :ro，编辑功能需要落盘）。
 */
const ROSTER = path.join(UI_ROOT, 'actresses.json')
const AVA_DIR = path.join(UI_ROOT, 'actresses')
const MN_BASE = 'https://www.minnano-av.com/'
/* minnano 云端中转：家里宽带对该站是 SNI 阻断（TCP 即 RST），但 GitHub raw / jsDelivr 国内直连可达。
 * GitHub Actions 每日抓榜单+头像，提交到公共仓库 ShHEdisonXu/javpaco-relay —— 数据公开，
 * 任何新用户拉镜像后无需配置 githubToken 即可读取（零配置开箱即用）。
 * 读取顺序：raw.githubusercontent.com → cdn.jsdelivr.net → api.github.com（配了 token 则带鉴权）。 */
const RELAY_REPO = 'ShHEdisonXu/javpaco-relay'
const RELAY_RAW = 'https://raw.githubusercontent.com/' + RELAY_REPO + '/main/relay/'
const RELAY_CDN = 'https://cdn.jsdelivr.net/gh/' + RELAY_REPO + '@latest/relay/'
const RELAY_API = 'https://api.github.com/repos/' + RELAY_REPO + '/contents/relay/'
const relayCache = new Map()   // p → {ts, buf|null}（10 分钟，避开上游限频）
async function relayBuf(p, ms) {
  const c = relayCache.get(p)
  if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.buf
  const b = await relayBufFetch(p, ms)
  relayCache.set(p, { ts: Date.now(), buf: b })
  return b
}
async function relayBufFetch(p, ms) {
  /* ① raw（公共仓库免 token，国内直连可达） ② jsDelivr CDN 兜底 */
  for (const u of [RELAY_RAW + p, RELAY_CDN + p]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(ms || 15000) })
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 2) return b }
    } catch (_) {}
  }
  /* ③ Contents API（配了 githubToken 则带鉴权，避开未认证限频） */
  const hd = { accept: 'application/vnd.github.raw' }
  const tk = String(CFG.githubToken || '').trim()
  if (tk) hd.authorization = 'Bearer ' + tk
  try {
    const r = await fetch(RELAY_API + p, { headers: hd, signal: AbortSignal.timeout(ms || 15000) })
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 2) return b }
  } catch (_) {}
  return null
}
async function relayJson(p, ms) {
  const b = await relayBuf(p, ms)
  if (!b) return null
  try { return JSON.parse(b.toString('utf8')) } catch (_) { return null }
}
/* 名字归一（与前端/同步脚本 acNorm 同口径）：全角→半角、片假名→平假名、去空白，避免「リマ/りま」这类误判 */
const cnormJa = s => String(s || '')
  .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  .replace(/[\u30A1-\u30F6\u31F0-\u31FF]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[^\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBFa-z0-9]/gi, '')
  .toLowerCase()
/* relay 名册惰性索引：minnano 直连不可达（家宽 SNI 阻断、未配代理）时，「识别刮削」回落到
 * relay 仓库的 roster.json —— GitHub Actions 每日自动从 minnano 全量同步，数据 T+1 新鲜、国内直连可达。 */
let RELAY_ROSTER_IDX = null
let RELAY_ROSTER_TS = 0
async function relayRosterIndex() {
  if (RELAY_ROSTER_IDX && Date.now() - RELAY_ROSTER_TS < 6 * 3600 * 1000) return RELAY_ROSTER_IDX
  const arr = await relayJson('roster.json', 30000)
  if (!Array.isArray(arr) || !arr.length) return RELAY_ROSTER_IDX
  const byMnid = new Map(), byName = new Map()
  for (const a of arr) {
    if (!a) continue
    const k = String(a.mnid || '').replace(/\D/g, '')
    if (k && !byMnid.has(k)) byMnid.set(k, a)
    const reg = x => { const c = cnormJa(x); if (c && !byName.has(c)) byName.set(c, a) }
    reg(a.name); if (Array.isArray(a.alias)) a.alias.forEach(reg)
  }
  RELAY_ROSTER_IDX = { byMnid, byName }
  RELAY_ROSTER_TS = Date.now()
  return RELAY_ROSTER_IDX
}
const MN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const dropEmpty = (k, v) => (v === '' || v === null || (Array.isArray(v) && v.length === 0) ? undefined : v)
const mnDec = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
const mnStrip = s => mnDec(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

function json(res, obj) {
  /* ⚠ 幂等保护：响应头一旦发出去就绝不能再 writeHead（否则抛 ERR_HTTP_HEADERS_SENT）。
   * 而本文件里大量 `.catch(e => json(res, {ok:false,error:e.message}))` 是**异步**兜底 ——
   * 很可能 handler 已经把 200 发出去了、之后才抛错，那时这个 catch 再调 json() 就会二次 writeHead。
   * 该异常发生在 catch 块内部，没人接 → 变成未捕获异常，连接既不关闭也不返回，一直挂到超时。
   * 在这里统一挡掉，比在几十个调用点各补一次 if (res.headersSent) 可靠得多。 */
  if (res.headersSent) return
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
  /* 「○○をチェックした人が見ている女優」→ rel（10 人，与 tools/minnano-sync.js 同口径） */
  const rel = []
  const ri = html.indexOf('をチェックした人が見ている女優')
  if (ri > -1) {
    const seg = html.slice(ri, ri + 6000)
    for (const m of seg.matchAll(/href="(?:\/)?actress(\d+)\.html">\s*<img[^>]*title="([^"]*)"/g)) {
      const n = mnDec(m[2])
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
    /* 站点是日文「期間」，旧写法「期间」永远匹配不上 → 两个键都认 */
    period: kv['AV出演期間'] || kv['AV出演期间'] || '', debut: kv['デビュー作品'] || '',
    agency: kv['所属事务所'] || kv['所属事務所'] || '', blog: kv['ブログ'] || '',
    /* 愛称（こなみん、ぐらちゃん 这类圈内昵称）与 公式サイト（事务所官方页）——2026-10-02 补全 */
    nick: kv['愛称'] || kv['爱称'] || '',
    official: kv['公式サイト'] || kv['公式站点'] || '',
    avatarUrl: img ? MN_BASE + img : '',
    alias: alias.filter(Boolean), tags, rel
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
  'javdb.com', 'javdb580.com', 'javdb008.com', 'jdbstatic.com',                          // JavDB 网页版（女优作品列表 + 网页图床）
  'x99dh.cc', 'x99dh.vip', 'x99dh.my', 'x99dh.pro',                                    // MissAV 线路发现
  'missav.ws', 'missav123.com', 'njavtv.my', 'thisav.my', 'missav888.cc', 'njav01.net', 'missav.watch',
  'raw.githubusercontent.com', 'api.github.com', 'github.com', 'codeload.github.com',  // 云端中转
  'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'data.jsdelivr.com',                       // jsDelivr CDN（中转兜底）
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
  /* javpaco 代理修复(2026-09-28)：Node 的 https.Agent 不认构造参数里的 createConnection
   * （只认原型方法），原写法隧道从未建立、请求实际直连目标站被墙超时——
   * 这就是「代理正常但刮削全部网络请求失败」的根因。改为实例方法覆盖，CONNECT 隧道真正生效。 */
  const agent = new https.Agent({ keepAlive: true })
  agent.createConnection = function (opts, cb) {
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
  proxyAgents.set(pUrl, agent)
  return agent
}

async function mnFetch(url, bin, pOverride, referer, opt) {
  /* opt.timeout=硬性总时限、opt.idle=空闲超时、opt.tries=重试次数——
   * 头像墙这类「一次请求几十张」的场景必须传短超时+单次，
   * 否则被墙/慢源一张磨 20s×3 次重试，浏览器同源并发全被堵死，整页图片跟着卡。 */
  const hardMs = (opt && opt.timeout) || 45000
  const idleMs = (opt && opt.idle) || 20000
  const tries = (opt && opt.tries) || 3
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
    const deadline = setTimeout(() => rq.destroy(new Error('timeout')), hardMs)
    rq.on('error', e => { clearTimeout(deadline); reject(e) })
    rq.setTimeout(idleMs, () => rq.destroy(new Error('timeout')))
    rq.end()
  })
  for (let i = 0; i < tries; i++) {
    try { return await once() } catch (e) { mnFetch.lastErr = e && e.message; if (i < tries - 1) await new Promise(s => setTimeout(s, 1200 * (i + 1))) }
  }
  return null
}

/* 数据源连通性探测（v0.2.29）：经代理发 GET，只看响应头（不收正文），跟随最多 5 次跳转。
 * 老实现「首发必须 200」会把 javbus/avmoo 这类 302 跳转（年龄门/补斜杠）误判成连不上，
 * 用户以为代理坏了，实际线路是通的。 */
function srcProbeOnce(url, pUrl) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('地址不合法')) }
    const fin = (status, location) => { try { rq.destroy() } catch (_) {} resolve({ status, location }) }
    let rq
    if (u.protocol === 'https:') {
      const opts = { host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search, method: 'GET',
        headers: { 'user-agent': MN_UA, accept: '*/*', connection: 'close' } }
      if (pUrl) { try { opts.agent = tunnelAgent(pUrl) } catch (e) { return reject(e) } }
      rq = https.request(opts, rs => { rs.resume(); fin(rs.statusCode, rs.headers.location) })
    } else {
      rq = http.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': MN_UA, accept: '*/*', connection: 'close' } },
        rs => { rs.resume(); fin(rs.statusCode, rs.headers.location) })
    }
    rq.setTimeout(15000, () => { try { rq.destroy(new Error('超时')) } catch (_) {} reject(new Error('超时')) })
    rq.on('error', e => { try { rq.destroy() } catch (_) {} reject(e) })
    rq.end()
  })
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
  /* 负缓存 6 小时：无代理环境 miss 是常态（源被墙），10 分钟太短——每 10 分钟整页头像又慢一遍。
   * 用户改代理配置时会自动清空（见 /api/config），不用担心配了代理后一直不重试。 */
  if (AVA_ONLINE_FAIL.get(key) > Date.now() - 6 * 60 * 60 * 1000) return null
  if (AVA_ONLINE_JOB.has(key)) return AVA_ONLINE_JOB.get(key)
  const job = (async () => {
    if (a && a.mnid) {   // ① GitHub 云端中转（Actions 每日抓的全量头像，raw 国内直连可达；6s 短超时防冷失败拖页面）
      const rb = await relayBuf('avatars/' + a.mnid + '.jpg', 6000)
      if (isImgBuf(rb)) {
        try { fs.mkdirSync(path.join(cacheDir(), 'actors'), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'actors', key + '.jpg'), rb) } catch (_) {}
        return rb
      }
    }
    for (const u of urls) {
      try {
        // Referer 跟着图源域名走（javbus 校验自家 Referer；minnano 用默认 MN_BASE）
        const ref = (() => { try { const o = new URL(u).origin + '/'; return o === MN_BASE ? undefined : o } catch (_) { return undefined } })()
        // 头像链专用短超时：8 秒总限、6 秒空闲、不重试——页面几十张头像并发，慢源快速放弃
        const b = await mnFetch(u, true, undefined, ref, { timeout: 8000, idle: 6000, tries: 1 })
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

/* ---------- 部署完自动拉头像：扫描名册，把本地缺的头像从 relay（raw/jsDelivr 国内直连、免 token 免代理）
 * 预取落盘 cache/actors/。触发：启动 15s 后首轮 + 每 12h 一轮；只处理带 mnid 的条目（relay 按 mn<id>.jpg 存）。
 * 并发 3、张间 250ms 温和限速；已有头像（actresses/ 或 cache/actors/）直接跳过。开关 CFG.autoAvatar 默认开。 */
let AVA_BACKFILL_RUNNING = false
let AVA_BACKFILL_STATS = null      // {todo, ok, fail, done, startedAt} 供日志/排查
/* relay 确实没有的头像：记在 cache/avatar-miss.json，3 天内不再重试。
 * 背景：名册里有一部分条目（mongo id 命名、minnano 已删号或无 og:image）relay 永远没有对应图，
 * 每轮启动都全量重试会白跑 8~13 分钟、日志刷满 fail。3 天后再试一次，relay 补图后能自动收进来。 */
const AVA_MISS_DAYS = 3
function avaMissPath() { return path.join(cacheDir(), 'avatar-miss.json') }
function avaMissLoad() {
  try { const o = JSON.parse(fs.readFileSync(avaMissPath(), 'utf8')); return new Map(Object.entries(o)) } catch (_) { return new Map() }
}
function avaMissSave(m) {
  try { fs.mkdirSync(path.dirname(avaMissPath()), { recursive: true }); fs.writeFileSync(avaMissPath(), JSON.stringify(Object.fromEntries(m))) } catch (_) {}
}
async function avatarBackfillOnce(trigger) {
  if (AVA_BACKFILL_RUNNING || CFG.autoAvatar === false) return
  AVA_BACKFILL_RUNNING = true
  const t0 = Date.now()
  try {
    const raw = []
    try { raw.push(...JSON.parse(fs.readFileSync(ROSTER, 'utf8'))) } catch (_) {}
    try { raw.push(...readExtraRoster()) } catch (_) {}
    const actorsDir = path.join(cacheDir(), 'actors')
    const miss = avaMissLoad()
    const missCut = Date.now() - AVA_MISS_DAYS * 86400 * 1000
    const seen = new Set()
    let skipped = 0
    const todo = []
    for (const a of raw) {
      if (!a || !a.mnid) continue
      const key = avaKey(a, a.mnid)
      if (seen.has(key)) continue
      seen.add(key)
      if (fs.existsSync(path.join(actorsDir, key + '.jpg'))) continue
      if (a.icon && fs.existsSync(path.join(AVA_DIR, path.basename(a.icon)))) continue
      const mt = miss.get(key)
      if (mt && mt > missCut) { skipped++; continue }   // 3 天内已知 relay 缺失 → 跳过，不白跑
      todo.push({ mnid: String(a.mnid).replace(/\D/g, ''), key })
    }
    if (!todo.length) { if (trigger !== 'boot' || skipped) console.log('[avatar-backfill] %s 无缺口（跳过 %d 个已知缺失），跳过', trigger, skipped) ; return }
    AVA_BACKFILL_STATS = { todo: todo.length, ok: 0, fail: 0, done: 0, startedAt: t0 }
    console.log('[avatar-backfill] %s 开始：本地缺 %d 张（另有 %d 个已知缺失跳过），relay 直连预取中…', trigger, todo.length, skipped)
    fs.mkdirSync(actorsDir, { recursive: true })
    let ptr = 0
    /* 连续失败熔断：relay（GitHub）不可达时（国内常见），每张头像都要等满 12s 超时才失败，
     * 2.4 万张就是好几小时的空转，还一直占着网络 —— 期间整个程序都会发闷。
     * 连续失败 40 次基本可判定源站不通，直接结束本轮，下次启动 / 12 小时后再试。 */
    let consecFail = 0, cut = false
    const worker = async () => {
      while (ptr < todo.length && CFG.autoAvatar !== false && AVA_BACKFILL_RUNNING) {
        const it = todo[ptr++]
        let hit = false
        try {
          const b = await relayBuf('avatars/' + it.mnid + '.jpg', 12000)
          if (isImgBuf(b)) { fs.writeFileSync(path.join(actorsDir, it.key + '.jpg'), b); AVA_BACKFILL_STATS.ok++; miss.delete(it.key); hit = true }
        } catch (_) {}
        if (hit) consecFail = 0
        else {
          AVA_BACKFILL_STATS.fail++; miss.set(it.key, Date.now()); consecFail++
          if (consecFail >= 40 && !cut) {
            cut = true
            AVA_BACKFILL_RUNNING = false                 // 让所有 worker 退出循环
            console.log('[avatar-backfill] %s 连续 %d 次失败，判定 relay 不可达 → 提前结束本轮（成功 %d 张）', trigger, consecFail, AVA_BACKFILL_STATS.ok)
          }
        }
        AVA_BACKFILL_STATS.done++
        if (AVA_BACKFILL_STATS.done % 500 === 0)
          console.log('[avatar-backfill] 进度 %d/%d (ok=%d fail=%d)', AVA_BACKFILL_STATS.done, AVA_BACKFILL_STATS.todo, AVA_BACKFILL_STATS.ok, AVA_BACKFILL_STATS.fail)
        await new Promise(s => setTimeout(s, 250))
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker))
    avaMissSave(miss)
    const st = AVA_BACKFILL_STATS
    console.log('[avatar-backfill] %s 完成：ok=%d fail=%d 用时 %d 分钟', trigger, st.ok, st.fail, Math.round((Date.now() - t0) / 60000))
  } catch (e) {
    console.log('[avatar-backfill] %s 出错：%s', trigger, e.message)
  } finally {
    AVA_BACKFILL_RUNNING = false
  }
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
/* ---------- 女优重名合并表 actor-merge.json ----------
 * { 被合并名: 保留名 }。与 name-alias.json 同级放在项目目录，随项目一起备份；
 * 每日名册同步只覆盖 actresses.json，冲不掉这张表；也绝不改 actresses.json 本身
 * （那样下次同步就白合并了）。 */
const MERGE_FILE = path.join(UI_ROOT, 'actor-merge.json')
function readMerge() {
  try {
    const v = JSON.parse(fs.readFileSync(MERGE_FILE, 'utf8'))
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  } catch (_) { return {} }
}
function writeMerge(map) {
  const t = MERGE_FILE + '.tmp'
  fs.writeFileSync(t, JSON.stringify(map, null, 1))
  fs.renameSync(t, MERGE_FILE)
}
/* 顺着合并链走到终点：B 已合并到 C 时，再合并 A→B 要记成 A→C */
function mergeResolve(map, name) {
  let cur = String(name || '')
  for (let i = 0; i < 8; i++) {
    const nxt = map[cur]
    if (!nxt || nxt === cur) break
    cur = nxt
  }
  return cur
}
/* 加一条合并；返回 false = 拒绝（同名 / 自我合并 / 会形成互相合并） */
function mergeAdd(map, merged, keep) {
  const d = String(merged || '').trim(), k0 = String(keep || '').trim()
  if (!d || !k0 || d === k0) return false
  const k = mergeResolve(map, k0)
  if (k === d) return false                       // 反向已存在 → 会成环
  map[d] = k
  /* 原先「合并到 d」的条目要改指 k，否则它们指向一条已经被合并掉的名字 */
  for (const key of Object.keys(map)) if (map[key] === d) map[key] = k
  delete map[k]                                   // 保留名不能同时是被合并名
  return true
}
/* 保存时共用的字段写回逻辑（内置名册 / 附加名册都走这里） */
function applyActorFields(a, body) {
  const F = body.fields || {}
  const strs = ['name', 'furi', 'birthday', 'height', 'breast', 'waist', 'hip', 'cup',
    'blood', 'place', 'period', 'debutDate', 'debut', 'agency', 'hobby', 'shoe', 'blog',
    'nick', 'official']
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
/* 把 JavDB 页磁力返回的「size（单位 MB 整数）」转成可读串，风格对齐 sukebei 的 "13.3GiB" */
function fmtMB(n) {
  n = Number(n) || 0
  if (!n) return ''
  const b = n * 1024 * 1024
  return b >= (1 << 30) ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / (1 << 20)).toFixed(1) + ' MB'
}
/* ---------- JavDB 评论区挖磁 / ED2K（P0 · 2026-10-04） ----------
 * AVdb-Only 磁力强在「评论区挖矿」：很多老番 / 冷门番的磁力只存在于影片评论里。
 * JavDB app API 的 /reviews 返回评论正文（一次最热 6 条，翻页拿不到更多），用户常把
 * magnet:/ed2k:// 贴进去。解析出来作为「本地缓存 → sukebei → JavDB 评论区」三级回退的
 * 第三来源，合入影片磁力区。 */
/* 评论正文落前先洗一遍：挖出来的整串 magnet:/ed2k: 链接本身没什么好看的，留着会把
 * 「（）」撑成一整屏乱码；去掉链接、压平空白、截断 200 字够看清「这条磁力是什么来头」了。 */
function jdbCommentText(t) {
  let s = String(t || '')
  /* ed2k：整串换成它的**文件名**。原文长这样：
   *   ed2k://|file|SNIS-789-U 女优人气大调查….mp4|30243744838|EB6BCE……|/
   * 体积和 hash 那两段全是噪音，文件名才是「这条链接到底是什么」。 */
  s = s.replace(/ed2k:\/\/\|file\|([^|]+)\|[^\s"'<>]*\|[^\s"'<>]*\|?\/?/gi, '$1')
  s = s.replace(/ed2k:\/\/[^\s"'<>]+/gi, '')
  /* magnet：同理留 dn（种子名），不要那串 xt=urn:btih:…&tr=… */
  s = s.replace(/magnet:\?[^\s"'<>]+/gi, m => {
    const dn = /[?&]dn=([^&]*)/i.exec(m)
    if (!dn) return ''
    try { return decodeURIComponent(dn[1].replace(/\+/g, ' ')) } catch (_) { return dn[1] }
  })
  return s.replace(/\s+/g, ' ').replace(/[\uFF08(]\s*[\uFF09)]/g, '').trim().slice(0, 200)
}
async function jdbCommentMagnets(code) {
  const out = []
  try {
    if (!onlineCfg().enabled) return out
    const s = await onlineScrapeSource(code)        // 先搜到 JavDB onlineId
    if (!s || !s.onlineId) return out
    const j = await onlineGet('v1/movies/' + s.onlineId + '/reviews?page=1').catch(() => null)
    const reviews = (((j || {}).data || {}).reviews) || []
    if (!Array.isArray(reviews)) return out
    const seen = new Set()
    const add = (magnet, type, rvText) => {
      magnet = String(magnet || '').replace(/&amp;/g, '&').trim()
      if (!magnet) return
      const key = magnet.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const hash = (magnet.match(/btih:([a-f0-9]{32,40})/i) || [])[1] || ''
      out.push({
        title: type === 'ed2k' ? 'ED2K 链接（来自 JavDB 评论）' : 'JavDB 评论磁力',
        hash, size: '', date: '', seeders: 0, leechers: 0,
        magnet, source: 'javdb-comment', type, fromComment: true,
        /* 评论正文（已清洗）：详情页在磁力标题后以「（…）」展示，
         * 看得出这条链接是评论里说的「4K 中字版」还是「补档」，不用点开猜。 */
        comment: jdbCommentText(rvText)
      })
    }
    for (const rv of reviews) {
      const txt = (rv && (rv.content || '')) || ''
      if (!txt) continue
      let m
      const reM = /magnet:[^"'<\s)]+/gi, reE = /ed2k:\/\/[^"'<\s]+/gi
      while ((m = reM.exec(txt))) add(m[0], 'magnet', txt)
      while ((m = reE.exec(txt))) add(m[0], 'ed2k', txt)
    }
  } catch (_) {}
  return out
}
/* ---------- JavDB 原番号页磁力（P0 · 2026-10-07） ----------
 * 与「评论区挖矿」（javdb-comment）是两条不同来源：这是 JavDB 影片页「磁力链接」区直接列出的
 * 官方多条 BT，字段更规整（name / size(MB) / cnsub 中字 / hd / created_at），质量通常比评论里
 * 随手贴的高。按 hash 去重交给 movieDetail 的合并段处理；这里只负责把每条转成统一磁力对象。 */
async function jdbPageMagnets(code) {
  const out = []
  try {
    if (!onlineCfg().enabled) return out
    const s = await onlineScrapeSource(code)        // 先搜到 JavDB onlineId
    if (!s || !s.onlineId) return out
    const d = await onlineGet('v2/movies/' + s.onlineId).catch(() => null)
    const mags = (((d || {}).data || {}).movie || {}).magnets
    if (!Array.isArray(mags)) return out
    const seen = new Set()
    for (const m of mags) {
      const hash = String(m.hash || '').trim().toLowerCase()
      if (!hash || seen.has(hash)) continue
      seen.add(hash)
      const name = String(m.name || (code + ' magnet')).trim()
      out.push({
        title: name, hash,
        size: fmtMB(m.size),
        date: String(m.created_at || '').slice(0, 10),
        seeders: 0, leechers: 0,
        magnet: 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name),
        source: 'javdb', type: 'magnet', cnsub: !!m.cnsub, hd: !!m.hd
      })
    }
  } catch (_) {}
  return out
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
    if (slow) { PROBE_SLOW++; if (PROBE_SLOW >= 3 && !VPROBE_OFF) { VPROBE_OFF = true; scLog(SCRAPE, '视频分辨率探测连续超时（网盘读取受限），本次扫描改用文件名标注') } }
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
/* ---------- 网盘片源分辨率探测（2026-10-15 新增） ----------
 * 为什么需要：分辨率标签以前只能靠 ffprobe 读**本地文件**，而云盘条目（gy:/ 115:/ dav:/ …）
 *   磁盘上根本没有文件 → tags 里永远没有 4K/1080P… → 界面不显示分辨率、
 *   按分辨率筛选几乎全是空、按分辨率排序无从下手（本机实测 1079 部里 1050 部是光鸭网盘条目，
 *   只有 41 部带分辨率，且多半是靠文件名里的「4K」猜的）。
 * 做法：网盘条目走**本机代理** `http://127.0.0.1:PORT/media/<rel>`，ffprobe 只读 moov 头就退出
 *   （实测 1.5s / 部，不下载整片）。结果落 data/cache/netres.json，按 rel 缓存，重扫不重复探测；
 *   探测失败记负面缓存，7 天内不再试（免得每次扫描都空跑一遍）。
 * 触发：扫描结束后 + 启动 30 秒后各跑一轮（resBackfillRun），并发 2，扫描中自动让路。
 * 开关：设置 → 影片库 →「探测网盘片源分辨率」（CFG.probeNetRes，默认开）。 */
const NETRES_FILE = () => { try { return path.join(cacheDir(), 'netres.json') } catch (_) { return '' } }
let NETRES = null, NETRES_DIRTY = false, NETRES_RUN = false
const NETRES_STATS = { at: 0, done: 0, ok: 0 }
function netresCache() {
  if (NETRES) return NETRES
  NETRES = {}
  try { const d = JSON.parse(fs.readFileSync(NETRES_FILE(), 'utf8')); if (d && typeof d === 'object') NETRES = d } catch (_) {}
  return NETRES
}
function netresSave() {
  try { const f = NETRES_FILE(); if (!f) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(netresCache())) } catch (_) {}
}
const RES_TAGS = ['4K', '2K', '1080P', '720P', '480P']
/* 云盘条目的 relVideo 前缀：gy: / 115: / 115@2: / dav: / webdav@2: / guangya@3: */
const isNetRel = rel => /^(?:gy|dav|webdav(?:@\d+)?|guangya(?:@\d+)?|115(?:@\d+)?|online):/i.test(String(rel || ''))
/* 与前端 mediaPath 同口径：media/ + 每段 encodeURIComponent */
function mediaUrlOf(rel) { return 'http://127.0.0.1:' + PORT + '/media/' + String(rel).split('/').map(encodeURIComponent).join('/') }
async function probeNetRes(rel) {
  const cache = netresCache()
  const hit = cache[rel]
  if (hit && hit.w) return hit                                      // 已探到 → 直接复用
  if (hit && hit.t && Date.now() - hit.t < 7 * 86400000) return null // 探过失败 → 7 天内不重试
  const out = await new Promise(resolve => {
    execFile(ffBin('ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mediaUrlOf(rel)],
      { timeout: 25000, windowsHide: true, maxBuffer: 1 << 20 },
      (e, so) => resolve(e ? '' : String(so || '')))
  })
  const m = /(\d{2,5})\s*,\s*(\d{2,5})/.exec(out)
  const e = { w: m ? parseInt(m[1], 10) : 0, h: m ? parseInt(m[2], 10) : 0, t: Date.now() }
  cache[rel] = e
  NETRES_DIRTY = true
  return e.w ? e : null
}
/* 把探测到的分辨率写进条目标签（顺带**修正**按文件名猜出来的档位） */
function applyResTag(it, w, h) {
  const tag = resTagOf(w, h)
  if (!tag) return false
  const t = Array.isArray(it.tags) ? it.tags : (it.tags = [])
  const old = t.filter(x => RES_TAGS.indexOf(x) >= 0)
  if (old.length === 1 && old[0] === tag) return false
  it.tags = t.filter(x => RES_TAGS.indexOf(x) < 0).concat(tag)
  return true
}
async function resBackfillRun(via) {
  if (NETRES_RUN || SCAN.running) return 0
  if (CFG.probeNetRes === false) return 0
  if (FFMPEG_OK === false) return 0
  if (FFMPEG_OK === null) { probeFfmpeg(); return 0 }      // 还在探测 ffmpeg → 下一轮再来
  if (!DATA || !Array.isArray(DATA.items) || !DATA.items.length) return 0
  const cache = netresCache()
  const todo = []
  let applied = 0
  for (const it of DATA.items) {
    const rel = it.relVideo || ''
    if (!rel || !isNetRel(rel)) continue
    const c = cache[rel]
    if (c && c.w) { if (applyResTag(it, c.w, c.h)) applied++; continue }
    if (c && c.t && Date.now() - c.t < 7 * 86400000) continue
    todo.push(it)
  }
  if (!todo.length) {
    if (applied && !SCAN.running) { saveScanResult(); libSeqTouch() }
    if (NETRES_DIRTY) { netresSave(); NETRES_DIRTY = false }
    return applied
  }
  NETRES_RUN = true
  const t0 = Date.now()
  let idx = 0, done = 0, ok = 0
  const worker = async () => {
    for (;;) {
      if (SCAN.running) return                 // 扫描起来了 → 立刻让路
      const i = idx++
      if (i >= todo.length) return
      const it = todo[i]
      try {
        const r = await probeNetRes(it.relVideo)
        if (r && r.w && applyResTag(it, r.w, r.h)) ok++
      } catch (_) {}
      done++
      if (done % 30 === 0) { netresSave(); NETRES_DIRTY = false; if (!SCAN.running) { saveScanResult(); libSeqTouch() } }
    }
  }
  try { await Promise.all([worker(), worker()]) } finally {
    NETRES_RUN = false
    netresSave(); NETRES_DIRTY = false
    NETRES_STATS.at = Date.now(); NETRES_STATS.done = done; NETRES_STATS.ok = ok
    if ((ok || applied) && !SCAN.running) { saveScanResult(); libSeqTouch() }
    console.log('[res] 网盘分辨率补齐 ' + (ok + applied) + ' 部（本轮探 ' + done + ' 部，缓存共 ' + Object.keys(netresCache()).length +
      ' 条，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，via ' + via + '）')
  }
  return ok + applied
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
  /* P0（2026-10-04）：本地缓存 → sukebei → JavDB 评论区 三级回退。
   * 合入评论区挖出的 magnet:/ed2k: 链接；已抓过（meta 里已有 javdb-comment）则不重复请求，
   * 仅在 refresh 或首次才向 JavDB 评论 API 取一次。 */
  try {
    const mags = (meta.magnets || [])
    /* 「是否还要去评论区挖」的三个触发条件：
     *   ① 从没挖过（没有 javdb-comment 条目）
     *   ② 挖过但没带评论正文（2026-10-06 之前入库的老数据）——补一次只为填上「（）」里的那句话，
     *      补完写回 meta.json，下次就不用再请求了
     *   ③ 用户点了详情页的「联网重新抓取」 */
    const _cmOld = mags.filter(m => m && m.source === 'javdb-comment')
    const hasComment = _cmOld.length > 0
    const missingCmt = _cmOld.some(m => !m.comment)
    if (!hasComment || missingCmt || refresh) {
      const cm = await jdbCommentMagnets(code)
      if (cm.length) {
        const have = new Set(mags.map(m => String((m && m.magnet) || '').toLowerCase()).filter(Boolean))
        for (const x of cm) {
          if (have.has(x.magnet.toLowerCase())) {
            /* 已经有了：这条可能是老数据缺 comment，就地补上（不动链接本身） */
            const hit = mags.find(m => String((m && m.magnet) || '').toLowerCase() === x.magnet.toLowerCase())
            if (hit && !hit.comment && x.comment) hit.comment = x.comment
            continue
          }
          mags.push(x); have.add(x.magnet.toLowerCase())
        }
        meta.magnets = mags
        /* 只在还没记过的时候追加一次：refresh（详情页「刷新磁力」）每次都会重取评论，
         * 无条件追加会让 meta.source 变成「xxx + javdb评论 + javdb评论 + …」并写回 meta.json。 */
        if (!/javdb评论/.test(String(meta.source || ''))) meta.source = (meta.source ? meta.source + ' + ' : '') + 'javdb评论'
        try { fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true }); fs.writeFileSync(movieCacheFile(code), JSON.stringify(meta, null, 2)) } catch (_) {}
      }
    }
  } catch (_) {}
  /* P0（2026-10-07）：合入 JavDB 原番号页（v2/movies/<id>.magnets）列出的官方磁力。
   * 与评论区挖矿（javdb-comment）并列、但来源不同。按 hash 去重：
   *   ① 已在 sukebei 命中（带 seeders）的 → 保留，只补上 cnsub/hd 标记；
   *   ② 评论区已有同 hash 的 → 不重复加；
   *   ③ 仅本页独有的（不同 hash）→ 入列。
   * 仅首次 / refresh 才向 JavDB 取一次，之后随 meta.json 落盘，下次直接读缓存。 */
  try {
    const hasPage = (meta.magnets || []).some(m => m && m.source === 'javdb')
    if (!hasPage || refresh) {
      const pm = await jdbPageMagnets(code)
      if (pm.length) {
        const haveHash = new Set((meta.magnets || []).map(m => String((m && m.hash) || '').toLowerCase()).filter(Boolean))
        for (const x of pm) {
          if (!x.hash) continue
          if (haveHash.has(x.hash)) {
            const hit = (meta.magnets || []).find(m => String((m && m.hash) || '').toLowerCase() === x.hash)
            if (hit) { if (x.cnsub) hit.cnsub = true; if (x.hd) hit.hd = true }
            continue
          }
          meta.magnets.push(x); haveHash.add(x.hash)
        }
        if (!/javdb/.test(String(meta.source || ''))) meta.source = (meta.source ? meta.source + ' + ' : '') + 'javdb'
        try {
          fs.mkdirSync(path.dirname(movieCacheFile(code)), { recursive: true })
          fs.writeFileSync(movieCacheFile(code), JSON.stringify(meta, null, 2))
        } catch (_) {}
      }
    }
  } catch (_) {}
  return { ok: true, cached: !!readMovieCache(code) && !refresh, item, meta }
}
/* 缓存目录统计（设置页「读取」用） */
function cacheStats() {
  const root = cacheDir()
  /* groups = 离线数据（刮削成果，可迁移可导回）；runtime = 运行缓存（服务运行中产生，可随时清掉自动重建） */
  const out = { ok: true, dir: root, groups: [], total: 0, runtime: { groups: [], total: 0 } }
  /* 迁移提示：旧目录副本还在 → 前端给一个「删除旧目录副本」的按钮（见 cacheMigrate / cacheCleanupOld） */
  try {
    const mf = String(CFG.migrateFrom || '')
    if (mf && fs.existsSync(mf) && path.resolve(mf) !== root) {
      out.migratedFrom = { dir: mf, size: dirTally(mf).bytes, files: dirTally(mf).files }
    }
  } catch (_) {}
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
  /* 运行缓存 ②：网站图标缓存 site-icons/（「网站」页的站点小图标，清掉后打开页面自动重取） */
  const si = { name: 'sites', folders: 0, files: 0, size: 0 }
  walk(path.join(root, 'site-icons'), si)
  if (si.folders || si.files) { out.runtime.groups.push(si); out.runtime.total += si.size }
  /* 运行缓存 ③：图片升级/候选探测中断残留的临时文件（movies 各目录下的隐藏文件） */  const tmp = { name: 'tmp', folders: 0, files: 0, size: 0 }
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
function dirTally(root) {
  const out = { files: 0, bytes: 0 }
  const walk = d => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) walk(fp)
      else { let st = {}; try { st = fs.statSync(fp) } catch (_) {}; out.files++; out.bytes += st.size || 0 }
    }
  }
  walk(root)
  return out
}
function entryTally(fp) {
  try { const st = fs.statSync(fp); if (st.isFile()) return { files: 1, bytes: st.size } } catch (_) { return { files: 0, bytes: 0 } }
  return dirTally(fp)
}
/* ---------- 离线数据「迁移」（2026-10-15） ----------
 * 场景：离线数据一直堆在程序目录 / C 盘（默认就是项目内 cache/），用户想整体搬到别的盘或 NAS。
 * 做法是**先复制、再逐项校验、最后才切配置**，任何一步不对就原样不动、一个字都不改：
 *   ① 把当前离线数据目录下的东西全部复制到目标目录（目标已有内容 → 合并，同名覆盖）；
 *   ② 逐项核对：目标里的文件数 / 总字节必须 ≥ 源（合并语义，所以是「不少于」而不是「相等」）；
 *   ③ 校验通过 → CFG.cacheDir 切到新目录 + 写配置 + 作废所有内存缓存（路径常量已改成函数，会自动跟着走）；
 *   ④ **原目录原样保留** —— 删副本是另一个动作（cacheCleanupOld），且只认这次记录下来的 from，
 *      绝不会因为一个参数写错就把别的地方删了。
 * 返回 { ok, from, to, copied, keptFrom }。 */
async function cacheMigrate(target) {
  const from = path.resolve(cacheDir())
  const to = path.resolve(String(target || '').trim())
  if (!to) return { ok: false, error: '请先填写目标目录（比如 D:\\JavPacoData 或 NAS 路径）' }
  if (to === from) return { ok: false, error: '目标目录和当前「离线数据目录」是同一个，不用迁移' }
  const inside = (parent, child) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r) }
  if (inside(from, to)) return { ok: false, error: '目标目录不能是当前目录的子目录' }
  if (inside(to, from)) return { ok: false, error: '目标目录不能是当前目录的上级目录' }
  /* 防呆：当前「离线数据目录」如果就是程序目录本身，整体迁移会把程序一起搬走 → 直接拒绝 */
  if (fs.existsSync(path.join(from, 'server-config.json'))) return { ok: false, error: '当前目录看起来是程序目录（里面有 server-config.json），不能整体迁移 —— 请在设置里指定一个专门的离线数据目录' }
  if (SCAN && SCAN.running) return { ok: false, error: '正在扫描媒体库，等扫完再迁移（避免搬到写了一半的文件）' }
  try { fs.mkdirSync(to, { recursive: true }) } catch (e) { return { ok: false, error: '创建目标目录失败：' + e.message } }
  try { fs.accessSync(to, fs.constants.W_OK) } catch (_) { return { ok: false, error: '目标目录不可写（换一个位置，或检查权限）' } }

  let entries = []
  try { entries = fs.readdirSync(from, { withFileTypes: true }) } catch (_) { entries = [] }
  if (!entries.length) return { ok: false, error: '当前目录里没有可迁移的内容' }
  const copied = { items: 0, files: 0, bytes: 0 }
  const fail = [], mismatch = []
  for (const e of entries) {
    const src = path.join(from, e.name), dst = path.join(to, e.name)
    try {
      if (e.isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true })
      else fs.copyFileSync(src, dst)
    } catch (err) { fail.push(e.name + '（' + err.message + '）'); continue }
    const a = entryTally(src), b = entryTally(dst)
    if (b.files < a.files || b.bytes < a.bytes) { mismatch.push(e.name + '（源 ' + a.files + ' 个文件，目标只看到 ' + b.files + ' 个）'); continue }
    copied.items++; copied.files += a.files; copied.bytes += a.bytes
  }
  if (fail.length) return { ok: false, error: '复制失败：' + fail.slice(0, 3).join('；') + '（原目录未做任何改动）' }
  if (mismatch.length) return { ok: false, error: '校验没通过：' + mismatch.slice(0, 3).join('；') + '（原目录未做任何改动，请检查目标盘空间/权限后重试）' }

  CFG.cacheDir = to
  CFG.migrateFrom = from          // 记下「从哪搬来的」：清副本那步只认它
  try { writeCfg() } catch (e) { return { ok: false, error: '写入配置失败：' + e.message } }
  /* 内存缓存全部作废：目录快照、预览登记、目录体量记忆都指向旧路径 */
  try { SRC_CACHE = { at: 0, data: null } } catch (_) {}
  try { V115_SNAP.clear() } catch (_) {}
  try { if (typeof DAV_SNAP !== 'undefined' && DAV_SNAP.clear) DAV_SNAP.clear() } catch (_) {}
  try { SRC_DIR_MEMO.clear() } catch (_) {}
  try { PREV_SET.clear(); previewLoad() } catch (_) {}
  try { srcMemoLoad() } catch (_) {}
  console.log('[cache] 离线数据已迁移：' + from + ' → ' + to + '（' + copied.items + ' 项 / ' + copied.files + ' 个文件 / ' + Math.round(copied.bytes / 1048576) + ' MB）')
  return { ok: true, from, to, copied, keptFrom: from, note: '原目录内容已保留，确认新目录没问题后可点「删除旧目录副本」清理' }
}
/* 删除迁移后留下的旧副本：只允许删「上一次迁移记录下来的那个目录」，且逐条删内容、保留目录本身。
 * 为什么要这么严：这是个不可逆的删除动作，宁可多一道校验，也不能让一个错参数把别处删了。 */
function cacheCleanupOld(dir) {
  const from = path.resolve(String(dir || CFG.migrateFrom || ''))
  const keep = path.resolve(cacheDir())
  if (!from || from === keep) return { ok: false, error: '没有可清理的旧目录' }
  if (String(CFG.migrateFrom || '') !== from) return { ok: false, error: '只允许清理「上一次迁移」留下的旧目录（当前记录：' + (CFG.migrateFrom || '无') + '）' }
  if (!fs.existsSync(from)) return { ok: false, error: '旧目录已经不存在了' }
  if (fs.existsSync(path.join(from, 'server-config.json'))) return { ok: false, error: '这个目录看起来是程序目录，拒绝清理' }
  let files = 0, bytes = 0, fail = 0
  let es = []
  try { es = fs.readdirSync(from, { withFileTypes: true }) } catch (e) { return { ok: false, error: '读取失败：' + e.message } }
  for (const e of es) {
    const fp = path.join(from, e.name)
    const t = entryTally(fp)
    try { fs.rmSync(fp, { recursive: true, force: true }); files += t.files; bytes += t.bytes }
    catch (_) { fail++ }
  }
  CFG.migrateFrom = ''
  try { writeCfg() } catch (_) {}
  console.log('[cache] 已清理迁移后的旧副本 ' + from + '（' + files + ' 个文件）' + (fail ? '，' + fail + ' 项失败' : ''))
  return { ok: !fail, dir: from, files, bytes, failed: fail, error: fail ? fail + ' 项没能删掉（可能被占用）' : '' }
}
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
  /* 网站图标缓存（「网站」页）：清掉完全安全，下次打开页面自动重取 */
  try {
    for (const e of fs.readdirSync(path.join(root, 'site-icons'), { withFileTypes: true })) rm(path.join(root, 'site-icons', e.name))
  } catch (_) {}
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
const SCRAPE = { running: false, code: '', title: '', phase: '', pct: 0, log: [], error: '', finishedAt: 0, stop: false, via: '' }
/* 每个并发刮削任务一份独立状态（手动单跑复用全局 SCRAPE；自动入库的 worker 各拿一份），
 * 这样多部片子同时刮削时进度/中止/错误互不串台。 */
function scMakeState() {
  return { running: false, code: '', title: '', phase: '', pct: 0, log: [], error: '', finishedAt: 0, stop: false, via: '' }
}
/* 手动中止：POST /api/scrape/stop。刮削是长流程（11 个源逐个试 + 下载图片），
 * 碰上某个源一直挂着就整条卡住，除了重启容器没有别的办法。置 stop 后各阶段自行收工。 */
function scCheckStop(S = SCRAPE) { if (S.stop) throw new Error('已手动停止') }
function scLog(S, s) {
  S.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`)
  if (S.log.length > 200) S.log.shift()
  console.log('[scrape]', s)
}
/* 低层抓取：暴露状态码与响应头（mnFetch 不暴露），支持代理 + 重定向跟随 + POST + 原始响应 */
/* 每主机并发闸：所有刮削 HTTP 都经 scOnce，这里把「同一主机同时最多 HOST_MAX 个请求」卡住，
 * 既防被源站 ban，也避免几十个请求瞬间齐发把 NAS/代理打爆。跨电影的并发靠 AUTO_INGEST 的 worker 池，
 * 跨源的并发靠 scrapeAsync 的批次，本闸是最后一道「按域名」的兜底。 */
const HOST_SEM = new Map()
const HOST_MAX = 4
/* 图片下载专用信号量：图片是带宽瓶颈不是 API 限频，且常来自静态 CDN，可放得更宽，
 * 不让 HOST_MAX=4 把单部 ~14 张图的下载也卡成 4 路串行轮询。
 * 12（2026-10-06 由 8 上调）：单部剧照上限就是 12 张，闸开到 8 时 12 张会被切成 8+4 两批，
 * 第二批要等第一批里**最慢**那张腾出名额才开工（尾延迟白等一轮）；开到 12 才能一批齐发。
 * 注意这是「每域名」上限而非全局：多部片子并行时不同域名各算各的，实测未见源站限流。 */
const IMG_HOST_SEM = new Map()
const IMG_HOST_MAX = 12
const HOST_ACQUIRE_MAX_MS = 60000   // 排队等主机闸的最长时间：到点强行放行（宁可略微超并发，也不能永久卡住）
function hostAcquire(host, sem, max) {
  let e = sem.get(host)
  if (!e) { e = { n: 0, waiters: [] }; sem.set(host, e) }
  if (e.n < max) { e.n++; return Promise.resolve() }
  /* 等太久就放行：并发计数一旦因为某条异常路径漂移（漏 release），
   * 没有这个上限的话后面所有请求都会永远排在这道闸上——整条刮削流水线就此停摆
   *（2026-10-06 DV-1582 卡在「下载图片」近 9 小时，后面排队的 10 部一部都没开工）。 */
  return new Promise(res => {
    let to = null
    const done = () => { if (to) clearTimeout(to); res() }
    to = setTimeout(() => {
      const i = e.waiters.indexOf(done)
      if (i >= 0) e.waiters.splice(i, 1)
      done()
    }, HOST_ACQUIRE_MAX_MS)
    e.waiters.push(done)
  })
}
function hostRelease(host, sem, max) {
  const e = sem.get(host)
  if (!e) return
  if (e.waiters.length && e.n >= max) { const w = e.waiters.shift(); w() }
  else e.n = Math.max(0, e.n - 1)
}
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
    /* javpaco 双通道补丁(2026-09-28)：支持通道覆写——
     * _pOverride:'' 强制直连；_forceProxy:'http://..' 强制走代理（绕过直连白名单） */
    const pUrl = opts._forceProxy ? String(opts._forceProxy).trim()
      : opts._pOverride !== undefined ? String(opts._pOverride || '').trim()
      : proxyUrl()
    if (pUrl) {
      let ag = null
      try { ag = opts._forceProxy ? tunnelAgent(pUrl) : agentMaybe(u, pUrl) } catch (_) {}
      if (ag) o.agent = ag
    }
    const isImg = !!opts.img
    const hSem = isImg ? IMG_HOST_SEM : HOST_SEM
    const hMax = isImg ? IMG_HOST_MAX : HOST_MAX
    let released = false, guard = null, settled = false
    const rel = () => { if (released) return; released = true; hostRelease(u.hostname, hSem, hMax) }
    /* ★ 墙钟守卫（2026-10-06 加）：不论请求最终走了哪条分支，到点必定 settle。
     * 没有它的时候，以下几种序列会让这个 promise 永远悬挂 —— destroy 没触发 error、end 也没来、
     * 主机闸放行后又卡在 waiters 队列上…… scrapeAsync 会一直 await 在这里不动，
     * 结果就是整条入库队列被一部片子堵死（DV-1582 卡在「下载图片」近 9 小时，后面排队的 10 部一部都没开工）。
     * 有了守卫，最坏情况只是这部失败，队列继续往下走。 */
    const clearGuard = () => { if (guard) { clearTimeout(guard); guard = null } }
    const finOK = v => { if (settled) return; settled = true; clearGuard(); rel(); resolve(v) }
    const finErr = e => { if (settled) return; settled = true; clearGuard(); rel(); reject(e) }
    guard = setTimeout(() => finErr(new Error('timeout（守卫超时）')), (Number(opts.deadline) || 45000) + 4000)
    const doReq = () => {
      let deadline = null
      let rq = null
      try {
        rq = https.request(o, rs => {
          const chunks = []
          rs.on('data', c => chunks.push(c))
          rs.on('end', () => {
            if (deadline) { clearTimeout(deadline); deadline = null }
            finOK({ status: rs.statusCode, headers: rs.headers, buf: Buffer.concat(chunks) })
          })
        })
      } catch (e) { finErr(e); return }
      // 硬性总时限：25s 的 setTimeout 是"空闲超时"，响应慢速细流会不断重置它导致永久挂起
      // （airav/missav 经代理时出现过单请求挂 10+ 分钟），所以再加一个不看重活动的墙钟上限
      deadline = setTimeout(() => { try { rq.destroy(new Error('timeout')) } catch (_) {}; rel() }, opts.deadline || 45000)
      rq.on('error', e => { if (deadline) { clearTimeout(deadline); deadline = null } finErr(e) })
      rq.setTimeout(25000, () => { try { rq.destroy(new Error('timeout')) } catch (_) {}; rel() })
      if (body) rq.write(body)
      rq.end()
    }
    hostAcquire(u.hostname, hSem, hMax).then(doReq).catch(e => finErr(e))
  })
}
async function scFetch(url, opts = {}) {
  let cur = String(url)
  const post = opts.method === 'POST' && opts.body
  /* 单个资源的总时限：域名闸 + 多次重定向 + 双通道重试叠加起来，scFetch 最坏能拖到几分钟，
   * 一部片子十几个资源串行下去就足以让队列停滞。这里再压一层上限（图片更短，看图而不是出字）。
   * _dead：上层任务已被判定卡死/中止时快速放弃，别继续占着网络资源。 */
  const totalMs = Number(opts.totalMs) || (opts.bin || opts.img ? 70000 : 120000)
  const deadlineAt = Date.now() + totalMs
  for (let hop = 0; hop < 5; hop++) {
    if (opts._dead && opts._dead()) throw new Error('任务已放弃（超时或已中止）')
    if (Date.now() > deadlineAt) throw new Error('抓取超时（' + Math.round(totalMs / 1000) + 's）')
    let rs = null
    const tryOnce = (extra) => scOnce(cur, Object.assign({}, opts, extra || {}, hop === 0 ? {} : { method: 'GET', body: '' }))
    for (let i = 0; i < 2; i++) {
      try { rs = await tryOnce({}); break } catch (e) { mnFetch.lastErr = e.message; await new Promise(s => setTimeout(s, 900 * (i + 1))) }
    }
    /* javpaco 双通道补丁(2026-09-28)：默认路径（代理 或 白名单直连）整体失败时，
     * 自动换另一条路再试一次：默认走代理的源 → 换直连；默认直连（白名单内，如 missav）
     * 的源 → 强制走代理（绕过白名单）。与 mnGetFollow 的「代理优先+直连兜底」同思路。 */
    if (!rs) {
      let alt = null
      try {
        const pv = proxyUrl()
        const wentProxy = pv && !isDirectHost(new URL(cur).hostname)
        alt = wentProxy ? { _pOverride: '' } : (pv ? { _forceProxy: pv } : null)
      } catch (_) {}
      if (alt) { try { rs = await tryOnce(alt) } catch (e) { mnFetch.lastErr = e.message } }
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
/* ---------- JavDB 网页版「演员页」解析（女优作品全量列表的唯一来源） ----------
 * 页面形状：<span class="actor-section-name">坂道美琉, 坂道みる</span> + <span class="section-meta">miru</span>
 *          + <span class="section-meta">255 部影片</span>；列表每条 = <a href="/v/{vid}" class="box">
 *          内含 .cover>img（竖版封面）/ .video-title（<strong>番号</strong> 标题）/ .score / .meta（日期）。
 * 页脚 .pagination 给出总页数（每页 40 部）。 */
/* JavDB 网页版封面（cN.jdbstatic.com）在容器里取不到（实测 NAS 请求该域名返回 404，
 * 而同网络下 tp.spfcas.com 正常），但同一张图在订阅图床上有镜像：两边路径都是
 * /covers/{id 前两位小写}/{id}.jpg，所以换掉 host 即可。spfcas 的路径段（如 rhe951l4q）
 * 由接口下发、不能写死，按需抓一次最新影片列表把段提取出来并缓存 12 小时。 */
let JDB_IMG_BASE = ''
let JDB_IMG_BASE_AT = 0
async function jdbImgBase() {
  if (JDB_IMG_BASE && Date.now() - JDB_IMG_BASE_AT < 12 * 3600 * 1000) return JDB_IMG_BASE
  try {
    const j = await onlineGet('v1/movies/latest?page=1&limit=1')
    const m = ((((j || {}).data || {}).movies) || [])[0] || {}
    const u = String(m.cover_url || m.thumb_url || '')
    const mt = u.match(/^(https?:\/\/[^/]+\/[A-Za-z0-9_-]+)\//)
    if (mt) { JDB_IMG_BASE = mt[1]; JDB_IMG_BASE_AT = Date.now() }
  } catch (_) {}
  return JDB_IMG_BASE
}
function jdbImgMirror(u, base) {
  const s = String(u || '')
  if (!base || !/^https?:\/\/[^/]*jdbstatic\.com\//i.test(s)) return s
  return s.replace(/^https?:\/\/[^/]+\//i, base + '/')
}
function jdbParseActorMovies(html) {
  const out = { name: '', aliases: [], total: 0, totalPages: 1, movies: [] }
  const sec = html.match(/class="actor-section-name">([\s\S]*?)<\/span>/)
  if (sec) {
    out.aliases = scText(sec[1]).split(/[,，]/).map(s => s.trim()).filter(Boolean)
    out.name = out.aliases[0] || ''
  }
  const cm = html.match(/([0-9][0-9,]*)\s*部影片/)
  if (cm) out.total = parseInt(cm[1].replace(/,/g, ''), 10) || 0
  /* 总页数：页脚分页里的最大 page= 与「总数 ÷ 每页 40」取大。
   * ⚠ 只信页脚会少算：实测葵司 476 部（= 12 页）时页脚只渲染到 page=6，
   * 拿它当上限就直接砍掉后半程作品（第 7 页往后根本翻不到）。 */
  let maxPg = 0
  for (const mm of html.matchAll(/[?&]page=([0-9]+)/g)) { const n = parseInt(mm[1], 10); if (n > maxPg) maxPg = n }
  out.totalPages = Math.max(1, maxPg, Math.ceil((out.total || 0) / 40))
  const re = /<a[^>]*href="\/v\/([A-Za-z0-9]+)"[^>]*\sclass="box[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const seen = new Set()
  let m
  while ((m = re.exec(html))) {
    const vid = m[1], blk = m[2]
    const img = blk.match(/<img[^>]+src="([^"]+)"/)
    const ttl = blk.match(/<div class="video-title">([\s\S]*?)<\/div>/)
    let code = '', title = ''
    if (ttl) {
      const cm2 = ttl[1].match(/<strong>([\s\S]*?)<\/strong>/)
      code = cm2 ? scText(cm2[1]) : ''
      title = scText(ttl[1].replace(/<strong>[\s\S]*?<\/strong>/, ''))
    }
    const date = (blk.match(/class="meta">\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) || [])[1] || ''
    const sc = (blk.match(/([0-9]+(?:\.[0-9]+)?)\s*分/) || [])[1] || ''
    if (!code && !title) continue
    if (seen.has(code || vid)) continue
    seen.add(code || vid)
    const cover = img ? String(img[1]).replace(/^\/\//, 'https://') : ''
    out.movies.push({
      id: vid, code, title, thumb: cover, cover, date, duration: 0,
      score: sc, magnets: 0, hasSub: false, canPlay: false, maker: ''
    })
  }
  return out
}
/* 抓一页演员页 —— 唯一能给出「某位女优全部作品」的来源。
 * 供 /api/online/actor_movies 与「订阅检查」共用（后者**不能**再退回 v2/search 标题搜索，见下）。
 * 参数：page≥1；sortType 0 发行日期倒序 / 1 评分 / 2 热度 / 3 想看 / 4 看过；t p 可播放 / s 单体 / d 含磁链 / c 含字幕。 */
async function jdbActorMoviesPage(id, page, sortType, t) {
  const qs = []
  if (t) qs.push('t=' + t)
  if (sortType && sortType !== '0') qs.push('sort_type=' + sortType)
  if (page && page > 1) qs.push('page=' + page)
  const rel = '/actors/' + encodeURIComponent(String(id || '').trim()) + (qs.length ? '?' + qs.join('&') : '')
  let lastErr = null
  for (const base of ['https://javdb.com', 'https://javdb580.com']) {
    try {
      /* 短超时：scFetch 默认能拖到 120s（域名闸+多跳重定向+双通道重试叠加），
       * 网页版在没配代理的机器上必然连不上，让用户干等两分钟才看到「失败」体验很差。 */
      const html = await scFetch(base + rel, { totalMs: 25000, hdrs: { referer: base + '/', cookie: 'over18=1; locale=zh' } })
      if (!/class="item"|actor-section-name/.test(html)) throw new Error('演员页没有内容（女优 id 可能不对）')
      const parsed = jdbParseActorMovies(html)
      parsed.hasMore = (page || 1) < parsed.totalPages
      parsed.perPage = 40
      parsed.webUrl = base + '/actors/' + id
      /* 封面从 cN.jdbstatic.com 换到国内可达的 spfcas 镜像（详见 jdbImgBase 注释） */
      const imgBase = await jdbImgBase()
      parsed.movies = parsed.movies.map(m => Object.assign({}, m, {
        thumb: jdbImgMirror(m.thumb, imgBase), cover: jdbImgMirror(m.cover, imgBase)
      }))
      return parsed
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('演员页抓取失败')
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
  const log = s => { if (logN++ < 12) scLog(SCRAPE, '  · ' + c.id + '：' + s) }
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
    // 超时记为"未命中"继续下一个源，不让整个刮削队列卡死。总顶压到 45s（与通用路径 scOnce 的
    // deadline 对齐）—— 一个源若连 45s 都拿不到数据，再等也没意义，只会把整批拖死。
    new Promise(s => setTimeout(() => s({ ok: false, reason: '抓取超时（45s）' }), 45000))
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
  if (DISABLED_SOURCES.has(s.id)) return null   // 该网络下恒定 403 的源，直接不进候选（覆盖所有路径含 by_fields）
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
/* ---------- 用「站点给的 DMM 图 URL」反推真实 cid，再换成高清模板 ----------
 * 上面的 scDmmCdnCands 是照着番号**猜** cid（前缀+5 位补零），对 SSE/素人/老片常常猜错：
 *   SS-061 猜成 ss00061  → 真身 h_113ss00061（プラム 素人セーラー服）
 *   START-549 猜成 start00549 → 真身 1start00549
 * 猜错的下场不是 404，而是 302 到 DMM 的 noimage 占位图（状态码还是 200），于是「海报」成了一块白板。
 * 站点（jav321/JavBus/DMM 规则）给出来的 URL 里的 cid 一定是准的，抠出来套 awsimgsrc 模板即可拿高清：
 *   实测 1start00549 —— pics.dmm.co.jp 的 ps 只有 147×200，换 awsimgsrc pics_dig 后是 1536×2184。 */
function scDmmCidOf(url) {
  const m = String(url || '').match(
    /\/(?:pics_dig\/digital\/video|dig\/mono\/movie|digital\/video|mono\/movie(?:\/adult)?)\/([a-z0-9_]{4,32})\/\1(?:ps|pl|jp-\d+)\.jpe?g/i)
  return m ? m[1] : ''
}
function scDmmCandsFromCids(cids) {
  const poster = [], fanart = [], samples = []
  for (const cid of cids) {
    /* pics_dig（在售数字版，最大）排在 dig/mono 前面：pick 找到够宽的图就收工，顺序即质量 */
    poster.push('https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/' + cid + '/' + cid + 'ps.jpg')
    fanart.push('https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/' + cid + '/' + cid + 'pl.jpg')
    poster.push('https://awsimgsrc.dmm.com/dig/mono/movie/' + cid + '/' + cid + 'ps.jpg')
    fanart.push('https://awsimgsrc.dmm.com/dig/mono/movie/' + cid + '/' + cid + 'pl.jpg')
  }
  for (let i = 1; i <= 10 && cids[0]; i++) samples.push('https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/' + cids[0] + '/' + cids[0] + 'jp-' + i + '.jpg')
  return { poster, fanart, samples }
}
/* ---------- DMM 图床 cid 前缀爆破（2026-10-07） ----------
 * scDmmCdnCands 照番号猜 cid（前缀 + 5 位补零）只对一半：DMM 内部 cid 常带厂商/レーベル编号前缀，
 * 番号里根本看不出来 —— DLDSS-537 的真身是 1dldss00537（猜成 dldss00537 只换回 now_printing 占位图，
 * 于是整部片子丢掉 DMM 的 1032×1467 高清封面，只能退回 JavDB 的 147×200 缩略图）；
 * START-549 → 1start00549、SS-061 → h_113ss00061 同理。
 * 基础 cid 在图床上探不到时，按前缀并发试探（只取前 1KB 看状态码，命中才正式下载），
 * 命中就把前缀记进 cache/dmm-cid-prefix.json —— 同系列（DLDSS-*）下次一步命中，不用再爆。 */
const DMM_CID_PFX_FILE = 'dmm-cid-prefix.json'
let _dmmPfx = null
function dmmPfxMap() {
  if (_dmmPfx) return _dmmPfx
  try { _dmmPfx = JSON.parse(fs.readFileSync(path.join(cacheDir(), DMM_CID_PFX_FILE), 'utf8')) || {} } catch (_) { _dmmPfx = {} }
  return _dmmPfx
}
function dmmPfxSet(key, pfx) {
  const m = dmmPfxMap()
  if (m[key] === pfx) return
  m[key] = pfx
  try { fs.writeFileSync(path.join(cacheDir(), DMM_CID_PFX_FILE), JSON.stringify(m)) } catch (_) {}
}
/* 探某个 cid 在不在图床上：pics_dig 路径不存在时是 404（旧图床则是 302 到 now_printing，
 * 所以只认 200/206 —— 拿到就算有图，尺寸由后面正式下载时复核）。走 scOnce 单次请求，
 * 不像 scFetch 那样失败重试 + 换通道再试一轮（爆破十几个候选时不值得）。 */
async function dmmCidHasImg(cid) {
  const u = 'https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/' + cid + '/' + cid + 'ps.jpg'
  try {
    const r = await scOnce(u, { bin: true, img: true, deadline: 8000, hdrs: { referer: u, range: 'bytes=0-1023' } })
    const st = Number(r && r.status) || 0
    return st === 200 || st === 206
  } catch (_) { return false }
}
async function scDmmResolveCid(code) {
  const s = MDCNG.splitNumber(code)
  if (!s.serial_name || !/^\d+$/.test(s.serial_number || '')) return ''
  const base = s.serial_name.toLowerCase().replace(/[^a-z0-9]/g, '') + String(s.serial_number).padStart(5, '0')
  const key = String(s.serial_name || '').toUpperCase()
  const seen = new Set()
  const probe = async c => {
    if (!c || seen.has(c)) return ''
    seen.add(c)
    return (await dmmCidHasImg(c)) ? c : ''
  }
  const memo = dmmPfxMap()[key]
  if (memo && await probe(memo + base)) return memo + base          // 同系列以前爆出来过的前缀：一次命中
  if (await probe(base)) { dmmPfxSet(key, ''); return base }        // 大多数片子：番号直接就是 cid
  const PFX = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'h_113', 'h_068', 'h_150', 'h_175', 'h_055', 'h_001']
  for (let i = 0; i < PFX.length; i += 8) {
    const got = (await Promise.all(PFX.slice(i, i + 8).map(p => probe(p + base)))).filter(Boolean)
    if (got.length) { dmmPfxSet(key, got[0].slice(0, got[0].length - base.length)); return got[0] }
  }
  return ''
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
/* 搜索结果页误判守卫：missav 等站对任何番号都返回搜索页，页面标题形如「ZZZ-999的搜尋結果」，
 * 正文里又恰好含番号文本 → 曾被解析成「影片」入库，主页轮播出垃圾。命中这类标题一律视为未搜到。 */
const SC_SEARCHY = /的搜尋結果|的搜索结果|search[\s_-]?results?\b|搜尋結果|搜索結果/i

async function scTryCandidate(code, c, S = SCRAPE) {
  const rule = MDCNG.ruleFor(c.id)
  if (rule) {
    try {
      const r = await scMdcCandidate(code, c, rule)
      if (r.parsed && r.parsed.title && !SC_SEARCHY.test(r.parsed.title)) { scLog(S, '✓ ' + c.id + ' 命中（mdc-ng 规则 ' + rule.__file + '）'); return r.parsed }
      if (r.parsed && r.parsed.title && SC_SEARCHY.test(r.parsed.title)) scLog(S, c.id + '：抓到的是搜索结果页（' + String(r.parsed.title).slice(0, 40) + '），不算命中')
      scLog(S, c.id + '：mdc-ng 规则未命中（' + (r.reason || '无内容') + '）' + (c.ruleOnly ? '，该源只由规则驱动，跳过通用解析' : '，改用通用解析兜底'))
    } catch (e) {
      scLog(S, c.id + '：mdc-ng 规则执行出错（' + e.message + '）' + (c.ruleOnly ? '，跳过通用解析' : '，改用通用解析兜底'))
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
  if (SC_SEARCHY.test(parsed.title)) return null   // 搜索结果页标题（如「XX-123的搜尋結果」）不算命中
  parsed.usedUrl = usedUrl
  return parsed
}
/* ---------- 占位图识别（DMM 的「无图」） ----------
 * 猜错 cid 时 DMM 不返回 404，而是给一张占位图，状态码还是 200：
 *   pics.dmm.co.jp/mono/movie/<cid>/<cid>ps.jpg → 302 → pics.dmm.com/mono/noimage/noimage_ps.jpg（147×200 / 2.6KB）
 *   awsimgsrc 系 → 404 带本体 90×122 / 2.7KB（now_printing.jpg）
 * 旧门槛「小于 2500 字节才算无效」正好放它们过去，于是被存成正式海报
 * （SS-061 / DTSL-142 / HODV-21806 / WPSL-195 / WPSL-212 就这么白板了）。
 * 真实小封面同尺寸（147×200）有 13~16KB，所以按「尺寸 + 字节」联合判，别一竿子打死小图。 */
function scPlaceholderImg(sz, bytes) {
  if (!sz || !sz.w) return true
  if (sz.w <= 96 && sz.h <= 130) return true                             // now printing（90×122）
  if (sz.w <= 170 && sz.h <= 215 && (bytes || 0) < 4200) return true     // noimage（147×200 / 2.6KB）
  /* ⚠️ 加了这条才拦得住「缩放版占位图」：DMM 图床 cid 不存在时不返回 404，而是 302 到
   * now_printing.jpg 并**按请求参数重新渲染**（例：MIDE-566 请求 pl 规格 → 拿到 590×800 / 19KB 的白板，
   * 尺寸和字节都完全正常，上面两条判据全部失效，于是白板被当成海报存了下来 —— 用户看到就是「没有封面」）。
   * 判据用「字节/像素」：纯色块的 JPEG 压得极小。实测 80 张正常封面**最低 0.182**（中位 0.263），
   * 而这类白板只有 0.041 —— 阈值取 0.10 有 1.8 倍安全余量，不会误杀真实封面。 */
  if (bytes && sz.h && bytes / (sz.w * sz.h) < 0.10) return true
  return false
}
/* ---------- 同名不同作品（番号撞车）防线 ----------
 * 一个番号在不同站可能指向两部毫不相干的片：SS-061 在 jav321 是プラム「素人セーラー服生中出し（改）
 * 061」(2010)，在 JavDB 线上却是ファインピクチャーズ「My Girl/新井リマ」(2022)。多源是「字段级择优」，
 * 不设防就会把 A 的标题、日期 + B 的演员拼成一部不存在的片子（用户看到的「识别错了」就是它）。
 * 判据：各源发行年份投票取锚点 → 与锚点差 ≥2 年**且**标题不像（去掉番号/【】修饰后的 2-gram 相似度
 * < 0.5）才算撞车。两个条件都要满足，是为了放过 DMM 的【ベストヒッツ】【アウトレット】重发行版
 * （GDRD-006 / BAB-044 那种：年份差 2 年但标题其实是同一部，不能误杀）。 */
function scNormTitle(t) {
  return String(t || '')
    .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ')
    .replace(/^[A-Za-z]{2,8}[-_ ]?\d{2,6}\s*/, ' ')
    .replace(/(無料で見る|チェキ付き|の検索結果|搜尋結果|搜索结果)/g, ' ')
    .replace(/[\s　\-–—_/・、,.。:：|+]/g, '')
    .toLowerCase()
}
function scTitleSim(a, b) {
  const A = scNormTitle(a), B = scNormTitle(b)
  if (!A || !B) return 1                     // 没标题 → 无从判断，当作同一部
  if (A === B) return 1
  const gram = s => { const m = new Set(); for (let i = 0; i + 1 < s.length; i++) m.add(s.slice(i, i + 2)); return m }
  const ga = gram(A), gb = gram(B)
  let inter = 0
  for (const x of ga) if (gb.has(x)) inter++
  return inter / ((ga.size + gb.size - inter) || 1)
}
const scYearOf = v => { const m = String(v || '').match(/(19|20)\d{2}/); return m ? +m[0] : 0 }
function scOffFilmSources(results, gotId) {
  const rows = Object.entries(results || {}).map(([id, r]) => ({
    id, title: (r && (r.title || '')) || '', rel: (r && (r.release || r.date)) || '', y: scYearOf(r && (r.release || r.date))
  }))
  const ys = rows.filter(r => r.y).map(r => r.y)
  if (ys.length < 2) return { off: new Set(), items: [], anchorYear: ys[0] || 0 }
  const cnt = {}
  ys.forEach(y => { cnt[y] = (cnt[y] || 0) + 1 })
  let anchor = gotId && results[gotId] && scYearOf(results[gotId].release || results[gotId].date)
  if (!anchor || !(anchor in cnt) || cnt[anchor] < Math.max.apply(null, Object.values(cnt))) {
    let n = -1
    for (const y of Object.keys(cnt)) if (cnt[y] > n) { n = cnt[y]; anchor = +y }   // 年票最多者为锚点
  }
  const base = rows.find(r => r.y === anchor) || rows[0]
  const off = new Set(), items = []
  for (const r of rows) {
    if (!r.y || r.id === base.id || Math.abs(r.y - anchor) < 2) continue
    if (scTitleSim(r.title, base.title) >= 0.5) continue        // 标题像 = 重发行/合集版，不算撞车
    off.add(r.id)
    items.push({ id: r.id, title: r.title, release: r.rel, year: r.y })
  }
  return { off, items, anchorId: base.id, anchorYear: anchor }
}
/* 图片落盘（MDC-NG 规则：不看文件名，按下载后的真实宽高定角色）
   poster.jpg 竖版海报（h>w） / fanart.jpg 横版主图（w>h） / sampleNN.jpg 剧照（不与主图重复） */
async function scSaveImages(dir, parsed, S = SCRAPE) {
  const imgDir = path.join(dir, 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const web = f => '/cache/movies/' + path.basename(dir) + '/images/' + f
  const out = { poster: '', fanart: '', samples: [] }
  const used = new Set()          // 已作为主图的来源 URL（剧照里剔除）
  const PORTRAIT = (sz, b) => sz.h > sz.w * (b || 1.06)
  const LANDSCAPE = (sz, b) => sz.w > sz.h * (b || 1.06)
  const dl = async url => {
    /* deadline 30s：图片体积小，45s 的默认墙钟对单张图太宽松，一张图慢会拖住整部。
     * _dead：所属刮削任务已被判定卡死时要立刻放手，别继续占着图片闸。
     * raw：要拿「跟完跳转后的最终地址」——DMM 图床 cid 不存在时是 302 到 now_printing/noimage，
     * 光看下载到的字节认不出来，看最终地址一枪毙命（bpp 判据是第二道保险）。 */
    const r = await scFetch(url, {
      bin: true, raw: true, hdrs: { referer: url }, img: true, deadline: 30000,
      _dead: () => !!(S && S.dead)
    })
    const finalUrl = String((r && r.url) || url)
    let b = (r && r.buf) || Buffer.alloc(0)
    /* raw 分支不解密，这里补上（JavDB 图片 CDN 的字节流是加密的；其它站点原样放行） */
    try { if (IMG_HOST_OK.test(new URL(finalUrl).hostname)) b = imgMaybeDecrypt(b) } catch (_) {}
    if (/(now_printing|noimage)/i.test(finalUrl)) throw new Error('是 DMM 的「无图」占位图（跳转后 ' + finalUrl.slice(-46) + '）')
    if (b.length < 2500) throw new Error('图片太小')
    const fp = path.join(imgDir, '.tmp' + (Math.random() * 1e9 | 0) + '.jpg')
    fs.writeFileSync(fp, b)
    const sz = imgSize(fp)
    if (!sz) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('不是有效图片') }
    /* DMM 的「无图」占位图当没图处理（规则见 scPlaceholderImg）——存下来只会得到一块白板海报 */
    if (scPlaceholderImg(sz, b.length)) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('是 DMM 的「无图」占位图') }
    return { fp, sz, bytes: b.length }
  }
  const put = (fp, name) => { fs.renameSync(fp, path.join(imgDir, name)); return web(name) }
  // —— 本地基线：缓存里已有的成品图也参与择优（整部重刮时，线上候选没有它大就保留原文件，绝不降级）
  const localSz = name => {
    try {
      const fp = path.join(imgDir, name)
      const s = imgSize(fp)
      if (!s || !s.w) return null
      let bytes = 0
      try { bytes = fs.statSync(fp).size } catch (_) {}
      /* 本地存着的本来就是占位图（历史遗留）→ 不能拿它当基线，否则重刮永远换不掉它（面积相同不算「更大」） */
      if (scPlaceholderImg(s, bytes)) return null
      return s
    } catch (_) { return null }
  }
  const locP = localSz('poster.jpg'), locF = localSz('fanart.jpg')
  // —— 候选择优：同一张图站点常给多个尺寸变体（含缩略图/占位图），靠前的不一定最清晰，
  //    所以试前几个候选取面积最大的那张，而不是碰到第一张符合朝向的就收工；
  //    local 传入本地现有图的尺寸作为初始基线，与其比面积
  const IMG_CHUNK = 8   // 海报/主图候选并发下载（≤ IMG_HOST_MAX=12）——两批共 maxTry 12 条
  const pick = async (cands, want, good, maxTry, onOther, local) => {
    let best = local ? { fp: null, sz: local, u: null, local: true } : null, attempt = 0
    let loose = null   // 朝向不符但接近正方形的兜底：JavDB 的 FC2 封面常是 1:1，竖/横判定都过不了，
                       // 严格按朝向筛会把唯一能用的图丢掉 → 宁可用方图也比没图强（详情页可再手动裁竖版）
    for (let ci = 0; ci < cands.length && !(best && !best.local && good(best.sz)); ci += IMG_CHUNK) {
      if (attempt >= maxTry) break
      const chunk = cands.slice(ci, ci + IMG_CHUNK)
      const gotArr = await Promise.all(chunk.map(async u => {
        if (attempt >= maxTry) return null
        attempt++
        try { const g = await dl(u); return { g, u } } catch (_) { return null }
      }))
      for (const item of gotArr) {
        if (!item) continue
        const { fp, sz } = item.g; const u = item.u
        if (best && !best.local && good(best.sz)) { try { fs.unlinkSync(fp) } catch (_) {}; continue }
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
    }
    return best || loose
  }
  // —— 竖版海报：候选里取面积最大的竖版；横版候选也不浪费（转投横版池）
  //    撞车源（同名不同作品）的图单独放 fallback 池：混在一个池里「排最后」没用 —— pick 是按面积挑的，
  //    错片那张只要尺寸不输，照样会被选中。所以信任池挑不出来才轮到它。
  const landPool = (parsed.fanartCands || []).slice()
  const landPoolFB = (parsed.fanartFallback || []).slice()
  /* 转投用 push（原来 unshift 会把它插到队首）——fanartCands 现在是「DMM 图床在前」，
   * 从海报池转投来的站点横版图插队会把 DMM 的 2184×1467 挤到 maxTry 之外。 */
  const toLand = pool => ({ sz, u }) => { if (LANDSCAPE(sz) && !pool.includes(u)) pool.push(u); return false }
  const bp = (await pick(parsed.posterCands || [], PORTRAIT, sz => sz.w >= 500, 12, toLand(landPool), locP))
    || (await pick(parsed.posterFallback || [], PORTRAIT, sz => sz.w >= 500, 8, toLand(landPoolFB), locP))
  if (bp) {
    if (bp.local) { out.poster = web('poster.jpg'); scLog(S, '竖版海报：保留本地 ' + bp.sz.w + '×' + bp.sz.h + '（线上候选没有更大的）') }
    else { out.poster = put(bp.fp, 'poster.jpg'); used.add(bp.u); out.posterUrl = bp.u; scLog(S, '竖版海报：' + bp.sz.w + '×' + bp.sz.h + ' ← ' + bp.u.split('/').pop()) }
  }
  // —— 横版主图：同样取面积最大的横版；顺手留一张竖版备用
  let posterAlt = null
  const onPort = ({ fp, sz, u }) => { if (PORTRAIT(sz) && !out.poster && !posterAlt) { posterAlt = { fp, sz, u }; return true } return false }
  const bf = (await pick(landPool.filter(u => !used.has(u)), LANDSCAPE, sz => sz.w >= 1600, 12, onPort, locF))
    || (await pick(landPoolFB.filter(u => !used.has(u)), LANDSCAPE, sz => sz.w >= 1600, 8, onPort, locF))
  if (bf) {
    if (bf.local) { out.fanart = web('fanart.jpg'); scLog(S, '横版主图：保留本地 ' + bf.sz.w + '×' + bf.sz.h + '（线上候选没有更大的）') }
    else { out.fanart = put(bf.fp, 'fanart.jpg'); used.add(bf.u); out.fanartUrl = bf.u; scLog(S, '横版主图：' + bf.sz.w + '×' + bf.sz.h + ' ← ' + bf.u.split('/').pop()) }
  }
  if (!out.poster && posterAlt) { out.poster = put(posterAlt.fp, 'poster.jpg'); used.add(posterAlt.u); out.posterUrl = posterAlt.u }
  // —— 剧照（跳过已用作主图的 URL；顺手记下第一张横版剧照作兜底）
  const SAMP_CHUNK = 12  // 剧照并发下载：与下面 12 张的上限对齐，一批齐发（配合 IMG_HOST_MAX=12）
  let firstLand = null, firstPort = null
  const sampEligible = []
  for (const s of (parsed.samples || [])) { if (!used.has(s)) sampEligible.push(s); if (sampEligible.length >= 12) break }
  for (let si = 0; si < sampEligible.length; si += SAMP_CHUNK) {
    const chunk = sampEligible.slice(si, si + SAMP_CHUNK)
    const gotArr = await Promise.all(chunk.map(async s => {
      try { const g = await dl(s); return { g, s } } catch (_) { return null }
    }))
    for (let k = 0; k < gotArr.length; k++) {
      const item = gotArr[k]; if (!item) continue
      const { fp, sz } = item.g; const s = item.s
      const i = si + k + 1
      const name = 'sample' + String(i).padStart(2, '0') + '.jpg'
      if (!firstLand && LANDSCAPE(sz)) firstLand = name
      if (!firstPort && PORTRAIT(sz)) firstPort = name
      try { fs.renameSync(fp, path.join(imgDir, name)); out.samples.push(web(name)); used.add(s) } catch (_) {}
    }
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
function scCoreComplete(results, pri, candIds, tried, dbg) {
  for (const f of ['title', 'release', 'actors', 'genres', 'poster', 'fanart']) {
    if (!scPickField(results, f, pri)) { if (dbg) dbg.push('缺字段:' + f); return false }
  }
  /* 「by_fields 优先源是否都试过」的检查：剧照、标签、封面这些**肉眼可见**的字段
   * 不能为了快就跳过它们的优先源（试过跳过，结果剧照从 12 张掉到 1 张，不值）。
   * 提速改由「一批并发跑完所有源」实现 —— 既不牺牲字段，又省掉分批的串行等待。 */
  const bfd = pri.by_fields || {}
  for (const key of Object.keys(bfd)) {
    for (const id of (bfd[key] || [])) {
      if (candIds.has(id) && !tried.has(id)) { if (dbg) dbg.push('未试优先源:' + id + '(' + key + ')'); return false }
    }
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
  const MAX_TRY = 8
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
      if (scPlaceholderImg(sz, b.length)) { try { fs.unlinkSync(fp) } catch (_) {} throw new Error('是 DMM 的「无图」占位图') }
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
  scLog(SCRAPE, label + '换源：' + best.sz.w + '×' + best.sz.h + ' ← ' + best.u.split('/').pop())
  return { url: web(role + '.jpg'), w: best.sz.w, h: best.sz.h, bytes }
}

async function scrapeAsync(job) {
  const t0 = Date.now()
  const S = job._S || SCRAPE
  S.running = true; S.code = job.code; S.phase = '准备'; S.pct = 2
  S.error = ''; S.log = []; S.finishedAt = 0; S.title = ''; S.stop = false
  S.via = String((job && job.via) || '手动')    // 来源（离线/订阅/手动），前端在任务行里显示
  const dir = path.join(cacheDir(), 'movies', job.code.replace(/[^\w.-]/g, '_'))
  const scTried = []      // 本次实际抓过的源：[{id, ok, reason}]，写进 meta 供详情页显示「数据源一览」
  let scSkipped = []      // 提前收工没来得及试的源 id
  try {
    if (job.nfo) {
      scLog(S, '收到 NFO（' + job.nfo.length + ' 字节），落盘备查')
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'movie.nfo'), job.nfo) } catch (_) {}
    }
    let candidates
    if (job.url) {
      candidates = [{ id: 'custom', url: job.url, cookies: /mgstage\.com/i.test(job.url) ? 'adc=1' : '' }]
      scLog(S, '指定网址模式，所有数据只从该网址抓取：' + job.url)
    } else {
      candidates = scCandidates(job.code, job.sourceId)
      scLog(S, `按数据源优先级排列 ${candidates.length} 个候选站点` + (job.sourceId ? '（指定：' + job.sourceId + '）' : ''))
    }
    if (!candidates.length) throw new Error('没有可用站点：请到 设置 → 数据源 启用带番号搜索模板的站点，或直接填该番号的详情页网址')
    let results = {}          // 每站解析结果（多源聚合，字段级择优）
    let got = null            // 第一个命中的源（source 字段展示用）
    let single = !!(job.url || job.sourceId)
    if (single) {
      // 单源模式：指定网址 / 指定站点，所有字段只从这一处取
      const r = await scTryCandidate(job.code, candidates[0], S)
      if (r && (r.title || '').trim()) {
        r.sourceId = job.url ? '指定网址' : job.sourceId
        /* 键用真实源 id（指定站点模式）——下面字段合并 scPickField 按 results[源id] 取值，
         * 之前误存成 custom 导致指定站点刮到的字段全部对不上号，落盘成「有记录没内容」的空壳 */
        results = { [job.url ? 'custom' : job.sourceId]: r }; got = r
        scTried.push({ id: job.url ? 'custom' : job.sourceId, ok: true })
        scLog(S, `✓ ${r.sourceId} 命中：《${got.title}》`)
      } else {
        /* 指定来源抓不到内容（典型：DMM 站点是 JS 渲染 + 地域封锁）——不直接报错，
         * 改按番号走多源刮削；DMM 的封面/主图仍由图床直链兜底补上 */
        scLog(S, (job.url ? '指定网址' : job.sourceId) + '：这个页面抓不到可用信息（JS 渲染 / 反爬），改按番号「' + job.code + '」多源刮削')
        scTried.push({ id: job.url ? 'custom' : job.sourceId, ok: false, reason: '该页面抓不到可用信息（JS 渲染 / 反爬）' })
        job.url = ''; job.sourceId = ''; single = false
      }
    }
    /* JavDB 线上源提前起跑：它与下面的站点不同域名（主机闸按域名放行），
     * 没必要排在最后串行等 —— 原来每部都要白等它一轮独立的网络往返。
     * 这里只起跑不 await，等聚合循环结束后再收结果。 */
    let pDb = null, dbDone = false
    /* 收 javdb 的结果（幂等，只收一次）。
     * 关键：javdb 是必跑的（指定网址模式除外），它的耗时跑不掉；而它常是**唯一能给演员表**的源
     * —— HTML 站普遍拿不到 actors，于是「核心字段已齐」永远差它一个，早停一次都触发不了。
     * 所以把它的结果**提前并入**，再判断能否收工：等待时间一分没多花，却能省掉后面整批。 */
    const collectDb = async () => {
      if (!pDb || dbDone) return
      dbDone = true
      try {
        const o = await pDb
        if (o.e) throw o.e
        const r = o.r
        if (r) { results.javdb = r; if (!got) { got = r; got.sourceId = 'javdb' }; scTried.push({ id: 'javdb', ok: true }); scLog(S, '✓ javdb 命中：《' + r.title + '》（线上 ' + (r.reviewsCount || 0) + ' 条评价）') }
        else { scTried.push({ id: 'javdb', ok: false, reason: '线上搜不到这个番号' }); scLog(S, 'javdb：线上搜不到该番号') }
      } catch (e) { scTried.push({ id: 'javdb', ok: false, reason: e.message }); scLog(S, 'javdb 失败：' + e.message) }
    }
    if (!job.url && !job.sourceId) {
      try { S.phase = '抓取 javdb' } catch (_) {}
      pDb = onlineScrapeSource(job.code).then(r => ({ r })).catch(e => ({ e }))
    }
    if (!single) {
      // 多源聚合（MDC-NG 语义）：字段优先级站点先试，再按全局优先级补齐；核心字段齐了就提前收工
      /* JavDB 线上源提前起跑：它与下面的站点不同域名，主机闸按域名放行，
       * 没必要排在最后串行等（原来每部都要白等它一轮网络往返）。 */
      const pri = getSourcesData().priorities
      const preferred = new Set()
      for (const bf of Object.values(SC_FIELD_MAP)) for (const id of ((pri.by_fields || {})[bf] || [])) preferred.add(id)
      const candIds = new Set(candidates.map(c => c.id))
      const triedSet = new Set()
      /* 单部内多源并发批次。原来 6，8 个候选要拆成 6+2 两批 ——
       * 第二批是**等第一批全跑完才启动**的，白白多一轮串行等待（实测多花 8~16 秒）。
       * 各源是不同域名，主机闸按域名放行，跨源并发不受限，直接一批全开。 */
      const SRC_BATCH = 8
      for (let i = 0; i < candidates.length; i += SRC_BATCH) {
      scCheckStop(S)                       // 逐源检查：中止时把没试的源记进「已跳过」
      const batch = candidates.slice(i, i + SRC_BATCH)
      for (const c of batch) triedSet.add(c.id)
      S.phase = '抓取 ' + batch.map(c => c.id).join('/'); S.pct = 6 + Math.round(54 * Math.min(i + SRC_BATCH, candidates.length) / candidates.length)
      const out = await Promise.all(batch.map(c => scTryCandidate(job.code, c, S).then(r => ({ c, r })).catch(e => ({ c, e }))))
      for (const o of out) {
        const c = o.c
        if (o.e) { scLog(S, c.id + ' 失败：' + o.e.message); scTried.push({ id: c.id, ok: false, reason: o.e.message }); continue }
        const r = o.r
        if (r) { results[c.id] = r; if (!got) { got = r; got.sourceId = c.id }; scLog(S, `✓ ${c.id} 命中：《${r.title}》`); scTried.push({ id: c.id, ok: true }) }
        else {
          /* DMM 特殊：站点内容由 JS 渲染 + 地域封锁，抓不到文字，但图床直链能用 ——
           * 这里说明清楚，别让用户以为整个刮削失败（封面/主图会在下载阶段从 dmm 图床补） */
          const dm = scDmmCdnCands(job.code)
          const dmOk = dm.poster.length || dm.fanart.length
          scLog(S, c.id + (dmOk && c.id === 'dmm' ? '：站点需 JS 渲染（抓不到文字），已改用图床直链补封面/主图' : '：页面不含该番号或没有可用信息'))
          scTried.push({ id: c.id, ok: false, reason: dmOk && c.id === 'dmm'
            ? '站点是 JS 渲染 + 地域封锁，抓不到文字信息；封面/主图已走 DMM 图床直链'
            : '该站页面里没有这个番号的信息（未收录 / 被反爬挡了）' })
        }
      }
      await collectDb()   // 已并发跑完，这里通常瞬间返回；并入后 actors 才能齐，早停才有意义
      const _dbg = []
      if (got && !job.full && scCoreComplete(results, pri, candIds, triedSet, _dbg)) {
        scLog(S, '核心字段已齐，提前收工（已聚合 ' + Object.keys(results).length + ' 个源）')
        scSkipped = candidates.slice(i + batch.length).map(x => x.id)   // 没试的源：详情页「刮削内容」里可以按需补抓
        break
      }
      /* 诊断日志已移除：一批跑完后它基本不触发，打在用户的「刮削日志」里只是噪音。 */
    } }
    /* JavDB 线上源：HTML 站就算已命中也照跑一遍 —— 它常有独家封面/剧照（FC2、无码流出），
     * 而且元数据更全（评分、想看人数）。指定网址模式除外（用户明确只信那一个页面）。 */
    await collectDb()   // 循环内没收到的（如 single 模式、或循环一次都没进）在这里兜底
    if (!got) throw new Error('所有站点都未能获取到「' + job.code + '」的元数据（可能被站点反爬或番号不存在）。可尝试直接粘贴该番号的详情页网址。')
    S.phase = '合并字段'; S.pct = 60
    const pri = getSourcesData().priorities
    /* 先判「同名不同作品」（番号撞车）：这些源的文字字段一律不进择优，否则会拼出一部不存在的片子 */
    const xf = scOffFilmSources(results, got && got.sourceId)
    const resultsTxt = xf.off.size
      ? Object.keys(results).reduce((o, id) => { if (!xf.off.has(id)) o[id] = results[id]; return o }, {})
      : results
    if (xf.off.size) {
      scLog(S, '⚠ 同名不同作品：' + xf.items.map(x => x.id + '《' + String(x.title || '').slice(0, 24) + '》' + x.year).join('、') +
        ' 与主片（' + xf.anchorYear + ' 年）对不上 → 已排除其标题/演员/剧情等文字字段，图片只作最后兜底')
    }
    const pk = {}
    /* 文字字段只认「没撞车」的源；图片/剧照仍看全部源（撞车源的图已在候选里排到最后兜底） */
    for (const f of SC_TEXT_FIELDS.concat(['actors', 'genres'])) pk[f] = scPickField(resultsTxt, f, pri)
    for (const f of ['poster', 'fanart', 'samples']) pk[f] = scPickField(results, f, pri)
    /* 兜底：聚合择优没取到、但首个命中源里其实有 → 直接用它的（防止再出现「scraped:true 却全空」的空壳条目） */
    const fv = f => {
      if (pk[f]) return pk[f].v
      if (got && !xf.off.has(got.sourceId)) {
        const v = f === 'release' ? (got.date || got.release) : got[f]
        if (f === 'actors' || f === 'genres') return Array.isArray(v) && v.length ? v : []
        if (f === 'runtime') return v > 0 ? v : 0
        return v || ''
      }
      return f === 'actors' || f === 'genres' ? [] : f === 'runtime' ? 0 : ''
    }
    const fsr = f => pk[f] ? pk[f].src : ''
    S.title = fv('title')   // 供「添加影片」批量进度逐条回显标题
    S.phase = '下载图片'; S.pct = 62
    scCheckStop(S)                       // 图片是最容易卡住的阶段（几十张图逐个试站点）
    /* 图片候选：把所有源的候选按优先级串起来，而不是只取「第一个有图的源」那一份清单 ——
     * 只认一份清单时，万一那源只给了小图/横图就再无挑选余地（START-549 竖版海报卡在 147×200 就是这样）。
     * 撞车源的图排在最后，只在前面全挂时才轮到它兜底。 */
    const urlSrc = Object.create(null)
    const pushC = (arr, list, id) => {
      for (const u of (list || [])) {
        if (!u || typeof u !== 'string') continue
        if (!urlSrc[u]) urlSrc[u] = id
        if (arr.indexOf(u) < 0) arr.push(u)
      }
    }
    /* 剧照：把所有源按优先级串起来（某源的图全挂了就顺延到下一个源），去重后交给下载循环。
     * 撞车源的剧照是另一部片的画面，垫到最后。 */
    const samplesAll = []
    for (const id of scFieldOrder('samples', pri)) {
      if (xf.off.has(id)) continue
      const r = results[id] || {}
      for (const s of (r.samples || [])) if (samplesAll.indexOf(s) < 0) samplesAll.push(s)
    }
    for (const id of scFieldOrder('samples', pri)) {
      if (!xf.off.has(id)) continue
      const r = results[id] || {}
      for (const s of (r.samples || [])) if (samplesAll.indexOf(s) < 0) samplesAll.push(s)
    }
    const posterAll = [], fanartAll = [], posterFB = [], fanartFB = []
    const imgOrder = [], seenSrc = new Set()
    for (const id of scFieldOrder('poster', pri).concat(scFieldOrder('fanart', pri)).concat(Object.keys(results))) {
      if (!seenSrc.has(id)) { seenSrc.add(id); imgOrder.push(id) }
    }
    for (const id of imgOrder) {
      if (xf.off.has(id)) continue
      pushC(posterAll, (results[id] || {}).posterCands, id)
      pushC(fanartAll, (results[id] || {}).fanartCands, id)
    }
    for (const id of imgOrder) {                 // 撞车源：图单独成池，只在信任池一张都挑不出时才用
      if (!xf.off.has(id)) continue
      pushC(posterFB, (results[id] || {}).posterCands, id)
      pushC(fanartFB, (results[id] || {}).fanartCands, id)
    }
    /* DMM 直链候选分两档：①按站点给的真实 cid 反推（准）②按番号猜（SSE/素人老片常猜错，垫底） */
    const knownCids = []
    for (const u of posterAll.concat(fanartAll)) {
      const cid = scDmmCidOf(u)
      if (cid && knownCids.indexOf(cid) < 0) knownCids.push(cid)
    }
    /* 站点没给出真实 cid（javdb 等只给自家 CDN 的图）→ 按前缀爆破探一次 DMM 图床：
     * 探到的高清 cid 排在候选最前，DLDSS-537 这类「番号拼不出 cid」的片子全靠它拿到大图。
     * 已经拿到站点真 cid 时不必爆（那才是 100% 准的）。 */
    let probeCid = ''
    if (!knownCids.length) {
      try { S.phase = '探测 DMM 图床 cid' } catch (_) {}
      probeCid = await scDmmResolveCid(job.code)
      if (probeCid) scLog(S, 'DMM 图床 cid 修正：番号拼出的 cid 在图床上没有图，真身是 ' + probeCid)
    }
    const dmmP = probeCid ? scDmmCandsFromCids([probeCid]) : { poster: [], fanart: [], samples: [] }
    const dmmK = scDmmCandsFromCids(knownCids.slice(0, 3))
    const dmmC = probeCid ? { poster: [], fanart: [], samples: [] } : scDmmCdnCands(job.code)
    const builtUrls = new Set([].concat(dmmK.poster, dmmK.fanart, dmmK.samples, dmmC.poster, dmmC.fanart, dmmC.samples))
    const imgs = await scSaveImages(dir, {
      /* DMM 图床候选排在站点候选**前面**：图床给的是 1032×1467 / 2184×1467 这类原图，
       * 站点给的大多是 147×200 缩略图。放在队尾时会被 pick 的 maxTry 截断（SSIS-500：
       * 站点候选 8 条用完，DMM 那条根本没轮到，海报就停在 147×200）——排前面反而更早收工。 */
      posterCands: dmmP.poster.concat(dmmK.poster, dmmC.poster, posterAll),
      fanartCands: dmmP.fanart.concat(dmmK.fanart, dmmC.fanart, fanartAll),
      posterFallback: posterFB, fanartFallback: fanartFB,
      samples: samplesAll.length ? samplesAll : (pk.samples ? pk.samples.cands : []).concat(dmmP.samples, dmmK.samples, dmmC.samples)
    }, S)
    /* 来源标注：**按图片的真实 CDN 主机**归属，而不是「哪个站把这条 URL 给我的」。
     * 旧写法只认「谁给的 URL」，于是 jav321 转手 DMM 官方图时会被标成 jav321 —— 用户看到
     * MIRD285「图片来源是 jav321」，而图其实就在 DMM 图床上（meta 里明明写着 dmm 图床）。
     * 现在只要图真的来自 DMM 图床就标 DMM；非 DMM 才回退到给 URL 的站 / 字段来源。 */
    const DMM_IMG_HOST = /(^|\.)(awsimgsrc|pics)\.dmm\.(co\.jp|com)$/i
    const imgHost = u => { try { return new URL(String(u)).hostname } catch (_) { return '' } }
    const srcOf = (u, f) => {
      if (!u) return pk[f] ? pk[f].src : ''
      if (DMM_IMG_HOST.test(imgHost(u))) return 'DMM'
      return urlSrc[u] || (builtUrls.has(u) ? 'DMM' : (pk[f] ? pk[f].src : ''))
    }
    imgs.posterSrc = srcOf(imgs.posterUrl, 'poster')
    imgs.fanartSrc = srcOf(imgs.fanartUrl, 'fanart')
    imgs.samplesSrc = pk.samples ? pk.samples.src : ''
    delete imgs.posterUrl; delete imgs.fanartUrl
    S.phase = '抓取磁力'; S.pct = 86
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
      /* 同名不同作品（番号撞车）记录：被排除文字字段的源 + 它指向的片名，面板里要给用户看得见 */
      offFilm: xf.items.length ? xf.items : undefined,
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
    /* 评分 / 想看人数：javdb 独有字段，择优取（其它源没有 → 空） */
    score: (results.javdb && results.javdb.score) || '',
    wantWatch: (results.javdb && results.javdb.wantWatch) || 0,
    /* 原番号：DMM/JavDB 用的无连字符形式（如 MIDE-775 → mide00775） */
    origCode: (() => { try { const s = MDCNG.splitNumber(job.code); return s.serial_name && /^\d+$/.test(s.serial_number || '') ? s.serial_name.toLowerCase().replace(/[^a-z0-9]/g, '') + String(s.serial_number).padStart(5, '0') : '' } catch (_) { return '' } })(),
    /* 本次刮削日志：以前只存在内存（S.log），任务一结束就丢 → 历史任务详情页的「刮削日志」列没数据。
     * 落盘一份（含时间戳前缀的完整行），供详情页按时间线渲染。 */
    scrapeLog: (S.log || []).slice(-200),
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
    S.pct = 100; S.phase = '完成'
    scLog(S, `完成：《${got.title}》 竖版封面${imgs.poster ? '✓' : '✕'} 横版主图${imgs.fanart ? '✓' : '✕'} 剧照 ${imgs.samples.length} 张 磁力 ${magnets.length} 条`)
    /* 日志最后一行（完成/失败）是写盘之后才产生的 → 回填一次 scrapeLog 再落盘，
     * 否则详情页的「刮削日志」永远少最后一条。 */
    meta.scrapeLog = (S.log || []).slice(-200)
    try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)) } catch (_) {}
    scrapeHistAdd({ code: job.code, ok: true, err: '', src: got.sourceId || '', imgSrc: imgs.posterSrc || imgs.fanartSrc || '', via: job.via || '手动', at: t0, dur: Date.now() - t0 })
  } catch (e) {
    S.error = e.message
    scLog(S, '失败：' + e.message)
    scrapeHistAdd({ code: job.code, ok: false, err: String(e.message || '').slice(0, 120), src: '', via: job.via || '手动', at: t0, dur: Date.now() - t0 })
  } finally {
    S.running = false; S.finishedAt = Date.now(); S.stop = false
    /* 无论手动单跑还是队列 worker，这部刮完都要从 active 摘掉：否则 firstActive() 下次被触发时
     * 还会把这部早已结束的番号当成"当前在刮"，前端一直显示它在刮。worker 路径在自己的循环里也会再清一次（幂等）。 */
    if (AUTO_INGEST.active && AUTO_INGEST.active[job.code]) {
      delete AUTO_INGEST.active[job.code]
      firstActive(); autoQSave()
    }
    console.log('[scrape]', job.code, S.error ? '失败: ' + S.error : 'OK', Date.now() - t0 + 'ms')
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
const fileOf = it => ({ relVideo: it.relVideo, size: it.size || 0, mtime: it.mtime || 0, tags: it.tags || [], pick: it.pick || undefined })
function mergeCodeGroup(list) {
  if (list.length === 1) return Object.assign({}, list[0], { files: [fileOf(list[0])].filter(f => f && f.relVideo) })
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
  /* files 只留真有视频文件的：没本地视频的条目（离线入库的 virtual 条目就是 relVideo:''）
   * 一旦和别的同番号条目并组，就会混进这个数组里充数 —— 详情页于是显示出「影片文件 2 个版本」，
   * 点开却只有两行空名字、播放按钮指向空路径（2026-10-06 IPX-497 反馈）。 */
  g.files = list.map(fileOf).filter(f => f && f.relVideo)
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
const AUTO_INGEST = { running: false, workers: 0, queue: [], done: 0, total: 0, current: '', currentVia: '', ok: 0, fail: 0, paused: false, active: {} }
/* 维护 AUTO_INGEST.current 显示「当前在刮的番号」：并发下有多部同时在刮，取 active 里第一条（先开始的）。
 * 单部完成时 delete active[code] 再 firstActive() 即可把展示切到下一部。 */
function firstActive() {
  const A = AUTO_INGEST.active || {}
  const keys = Object.keys(A)
  if (!keys.length) { if (AUTO_INGEST.current) { AUTO_INGEST.current = ''; AUTO_INGEST.currentVia = '' } return }
  const code = keys[0]
  AUTO_INGEST.current = code
  AUTO_INGEST.currentVia = (A[code] && A[code].via) || (AUTO_INGEST.queue.via || {})[code] || '订阅'
}
/* ---------- 单任务看门狗（2026-10-06） ----------
 * scrapeAsync 是一条很长的链（多源逐个试 → 下载十来张图 → 抓磁力），任何一步 await 挂住，
 * 整部任务就停在那儿不动 —— 而且没有谁会来叫醒它。2026-10-06 就出了这样的事：
 * DV-1582 卡在「下载图片」62%，一直挂了近 9 小时，后面排队的 10 部一部都没开工，用户只看到
 * 「队列不动了」。这里从外面套两层保险，放弃时写一条带原因的失败历史，队列照常往下跑：
 *   ① 无推进：TASK_STALL_MS 内 phase / pct / 日志行数毫无变化 → 判定卡死；
 *   ② 硬上限：一部最多刮 TASK_HARD_MS。
 * 放弃只是「把 worker 让出来」（Promise.race），后台那次 scrapeAsync 会因为 S.dead 在下一个
 * 网络请求处自行中断，不会留下僵尸任务。 */
const TASK_HARD_MS = 12 * 60 * 1000      // 一部最多刮 12 分钟
const TASK_STALL_MS = 5 * 60 * 1000      // 5 分钟毫无推进 = 卡死
async function scrapeWithWatchdog(job, st) {
  const sigOf = () => String(st.phase || '') + '|' + String(st.pct || 0) + '|' + ((st.log && st.log.length) || 0)
  let lastSig = sigOf(), lastAt = Date.now(), reason = ''
  const watcher = setInterval(() => {
    const s = sigOf()
    if (s !== lastSig) { lastSig = s; lastAt = Date.now(); return }
    const stall = Date.now() - lastAt
    if (stall > TASK_STALL_MS) reason = '刮削卡住：' + Math.round(stall / 1000) + ' 秒没有任何进展（停在「' + (st.phase || '未知阶段') + '」）'
  }, 15000)
  const hardAt = Date.now() + TASK_HARD_MS
  let bailTimer = null
  let bailPromise = null
  await new Promise(res => {
    let done = false
    const fin = () => { if (done) return; done = true; res() }
    bailTimer = setInterval(() => {
      if (!reason && Date.now() <= hardAt) return
      if (!reason) reason = '刮削超时：超过 ' + Math.round(TASK_HARD_MS / 60000) + ' 分钟未完成'
      clearInterval(bailTimer); fin()
    }, 10000)
    bailPromise = fin
    scrapeAsync(job).catch(e => { st.error = st.error || String((e && e.message) || e); fin() }).then(fin)
  })
  clearInterval(watcher); if (bailTimer) clearInterval(bailTimer)
  if (reason) {
    st.error = st.error || reason
    st.running = false
    st.dead = true                                   // 通知还在后台的那次 scrapeAsync 尽快收手
    try { scLog(st, '✗ ' + reason) } catch (_) {}
    try { scrapeHistAdd({ code: job.code, ok: false, err: String(reason).slice(0, 120), src: '', via: job.via || '手动', at: Date.now(), dur: Date.now() - (job.t0 || Date.now()) }) } catch (_) {}
    console.log('[scrape] 看门狗放弃「' + job.code + '」：' + reason)
  }
}
/* ---------- 自动入库 worker 池（2026-10-06 重写为「常驻」） ----------
 * 旧写法：worker 一看队列空就 return，Promise.all 结束后 running 置 false。
 * 问题是 4 个 worker 是**陆续**退出的：在只剩最后一个 worker 的那段窗口里入队的新任务，
 * 只能由它一部一部串行处理（并发从 4 退化成 1）；它万一再卡住，整条队列就彻底停摆。
 * 现在 worker 常驻（队列空就 2 秒轮询一次），ensureWorkers 幂等补员到 AUTO_CONCUR 个，
 * 保证任何时候有新任务都有人接、且始终是满并发。 */
const AUTO_CONCUR = 4   // 同时刮几部；单部内部的多源/图片并发由 scrapeAsync + scOnce 主机闸控制
function ensureWorkers() {
  while ((AUTO_INGEST.workers || 0) < AUTO_CONCUR) {
    AUTO_INGEST.workers = (AUTO_INGEST.workers || 0) + 1
    autoWorker().catch(() => {})
  }
}
/* ⚠️ 必须返回 Promise：外面有 4 处写成 `autoIngestRun().catch(() => {})`
 *   （入队 / 启动恢复 / resume / front）。返回 undefined 时 `undefined.catch` 直接 TypeError，
 *   接口就以 500 收场——而队列其实已经入好了，前端却收到 ok:false，
 *   用户看到「提交失败」再点一次 → 重复提交（2026-10-06 实测）。 */
function autoIngestRun() { ensureWorkers(); return Promise.resolve() }
async function autoWorker() {
  try {
    while (true) {
      /* running 反映「是不是真的有活」：队列里还有号或还有部在刮。
       * 以前这是个手置的布尔，锁在 autoIngestRun 上，一旦某条路径没解锁就永远 true/false。 */
      AUTO_INGEST.running = AUTO_INGEST.queue.length > 0 || Object.keys(AUTO_INGEST.active || {}).length > 0
      if (AUTO_INGEST.paused) { await new Promise(s => setTimeout(s, 2000)); continue }   // 暂停：保留队列，只是不取新任务
      if (!AUTO_INGEST.queue.length) { await new Promise(s => setTimeout(s, 2000)); continue }
      const via = (AUTO_INGEST.queue.via || {})[AUTO_INGEST.queue[0]] || '订阅'
      const subId = (AUTO_INGEST.queue.sub || {})[AUTO_INGEST.queue[0]] || ''   // 这条番号若来自某条订阅，记下来 → 刮完按需推 115
      const code = AUTO_INGEST.queue.shift()
      /* 已经有 worker 正在刮这部（用户重复提交 / 重试点太快）→ 这次让路：
       * 那一路刮完照样会写历史、覆盖掉排队占位，这部等于是有结果的。
       * 若这里照刮就是两路并发写同一个 cache/movies/<番号>/ 目录 —— writeFileSync 非原子、
       * 图片还是同名覆盖，最终的 meta.json 可能变成两次结果的混合体。 */
      if (Object.keys(AUTO_INGEST.active || {}).some(k => bare(k) === bare(code))) {
        await new Promise(s => setTimeout(s, 1500))
        continue
      }
      const st = scMakeState(); st.code = code; st.via = via
      AUTO_INGEST.active[code] = st
      firstActive(); autoQSave()
      if (SCRAPE.running) { AUTO_INGEST.queue.unshift(code); delete AUTO_INGEST.active[code]; firstActive(); autoQSave(); await new Promise(s => setTimeout(s, 3000)); continue }
      let already = false
      try { const m = readMovieCache(code); already = !!(m && m.scraped) } catch (_) {}
      if (already) {
        /* 已有离线数据 → 跳过重刮。但**必须把历史记录收尾**：
         * 提交时（/api/scrape/start 入队那刻）会先写一条 state:'queued' 占位，若这里不覆盖，
         * 那条占位会永远停在「排队中」（用户 2026-10-06 反馈：卡片一直卡住、历史里也只有排队中）。
         * 补一条「已存在，跳过重刮」的成功记录，语义也如实。 */
        AUTO_INGEST.done++; AUTO_INGEST.ok++
        const _mm = (() => { try { return readMovieCache(code) } catch (_) { return null } })()
        scrapeHistAdd({
          code, ok: true, err: '', via,
          src: ((_mm && _mm.images && _mm.images.posterSrc) || (_mm && String(_mm.source || '').split(' ')[0]) || '本地已有'),
          imgSrc: (_mm && _mm.images && (_mm.images.posterSrc || _mm.images.fanartSrc)) || '',
          at: Date.now(), dur: 0, skipped: true,
          note: '本地已有离线数据，未重复刮削'
        })
        delete AUTO_INGEST.active[code]; firstActive(); autoQSave(); continue
      }
      try { await scrapeWithWatchdog({ code, via, _S: st, t0: Date.now() }, st) } catch (_) {}
      if (st.error) AUTO_INGEST.fail++; else AUTO_INGEST.ok++
      AUTO_INGEST.done++
      delete AUTO_INGEST.active[code]
      firstActive(); autoQSave()
      if (subId) subAfterScrape(code, subId).catch(() => {})
    }
  } catch (e) {
    /* worker 不该死：真有没料到的异常也不能让并发数永久减一（每少一个，队列就慢一分）。 */
    console.log('[auto-ingest] worker 异常退出：' + ((e && e.message) || e) + '，稍后自动补员')
  } finally {
    AUTO_INGEST.workers = Math.max(0, (AUTO_INGEST.workers || 0) - 1)
    setTimeout(() => { try { if (AUTO_INGEST.queue.length) autoIngestRun() } catch (_) {} }, 5000)
  }
}
/* front = true → 插到队首（手动指定的番号优先于订阅批量）。
 * 返回该番号在队列里的位次（1 起），给前端显示「前面还有几部」。 */
function autoIngestQueue(codes, via = '订阅', front = false, subId = '') {
  const q = AUTO_INGEST.queue
  q.via = q.via || {}
  q.sub = q.sub = q.sub || {}          // 番号 → 来源订阅 id（自动下载要据此判断这条订阅开没开）
  let added = 0
  for (const c of codes) {
    if (!c) continue
    const at = q.indexOf(c)
    if (at >= 0) {
      /* 已在队列里：front 时把它提到队首（用户重复点「开始刮削」期望的是「马上刮我这部」），
       * 否则原样留着。原来这里直接 continue，导致 autoIngestQueue 返回 0，
       * 上层以为「没入队」而写下永远收不了尾的 queued 占位。 */
      if (front && at > 0) { q.splice(at, 1); q.unshift(c) }
      continue
    }
    if (front) q.unshift(c); else q.push(c)
    q.via[c] = via
    if (subId) q.sub[c] = subId
    added++
  }
  if (!q.length) return 0
  AUTO_INGEST.total = q.length + AUTO_INGEST.done
  autoQSave()
  /* ⚠️ 位次必须在**启动 worker 之前**算出来。
   * autoIngestRun → ensureWorkers → autoWorker 的循环体在第一个 await 之前是同步执行的
   * （含 `queue.shift()`），所以它会当场把刚 push 进去的这部取走 → 队列变空 →
   * 后面再算 indexOf 就是 -1+1=0 → 上层当成「没能入队」走 dup 分支：不写排队占位、
   * 返回 queued:false。前端因此既不显示排队、也等不到结果，最后判成超时失败
   * （服务端其实正在刮、而且很快就成功了）。2026-10-06 实测：服务端空闲时提交单部必中。 */
  const pos0 = q.indexOf(codes[0]) + 1
  autoIngestRun().catch(() => {})
  /* 返回「第一部在队列里的位次」（1 起）。注意不能因为 added===0 就返回 0：
   * 那样上层会误判「没入队」。已经在队列里的照样返回它的真实位次。 */
  return pos0
}

/* 刮削失败的番号：自动排队冷却多久（默认 7 天）。
 * 用户诉求「没刮成功的番号等手动刮，不要自动重试」—— 手动刮削完全不受影响，
 * 这里只拦「每次启动 / 每次扫描自动塞回队列」那条路。 */
const SCRAPE_FAIL_COOL_MS = 7 * 24 * 3600 * 1000

/* 把「还没刮过」的影片排队进后台刮削队列（设置页 autoScrapeNew 可关，默认开）。
 * 两类：① 识别失败待处理（无 nfo 标题）且番号可解析；② 有 nfo 标题但**没有海报图**的
 * （relPoster/webPoster 都没有）—— 海报墙封面空缺的大头。
 * 缓存里已有离线数据的（之前刮过，m.scraped）不算，直接跳过；每次最多 500 部防刷站。
 * 扫描完成与 app 启动恢复两条路径都调用（后者见文件底部 boot 段），保证重启即自动补封面，不必手动重扫。
 * ⚠ 回填口径见 enrichFromCache：只补空字段，本地 nfo 标题/简介不会被覆盖。返回本次入队数量。 */
function autoQueueMissingCovers(items, via) {
  if (CFG.autoScrapeNew === false) return 0
  if (!Array.isArray(items) || !items.length) return 0
  const codeOk = c => /^\d{6}-\d{2,4}$/.test(c) || (/[A-Z]/.test(c) && /\d/.test(c))
  const fresh = []
  let cooled = 0        // 因「最近刮失败」被跳过的数量（打进日志，方便确认机制真的在生效）
  for (const it of items) {
    if (!it || !it.code) continue
    const code = String(it.code).toUpperCase()
    if (!codeOk(code) || fresh.includes(code)) continue
    try { const m = readMovieCache(code); if (m && m.scraped) continue } catch (_) {}
    /* 2026-10-15：刮削**失败过**的番号设 24 小时冷却，别每次启动 / 每次扫描都重新排队。
     * 根因：上面判「要不要刮」只看 `m.scraped`，而失败的番号 scraped 恒为 false →
     *   每次启动（今天重启了 20 次）都把它们原样塞回队列，实测 MELVSC-011 / HHD-800 /
     *   9OAE-312 / 586HNHU-0206 等一天被刮了 18~19 次，每次都是同一个失败原因
     *   （站点反爬或番号根本不存在）—— 纯浪费配额，还容易被站点判成爬虫。
     * 现在查 scrape-history 里该番号最近一条：ok=false 且在冷却期内 → 跳过自动排队。
     * ⚠ 只拦「自动」这条路；用户在添加页 / 详情页手动点刮削不受任何影响。
     * 冷却期 = SCRAPE_FAIL_COOL_MS（默认 7 天）：失败的原因（番号不存在 / 站点反爬）几乎不会
     *   在几天内自己变好，24 小时重试一次只是每天白刮一遍；7 天 ≈「等用户手动」，
     *   既给临时故障留了自愈窗口，也不会再出现「一天刮 19 次同一个失败番号」。 */
    try {
      scrapeHistLoad()
      const h = SCRAPE_HIST.list.find(x => x && bare(String(x.code || '')) === bare(code))
      if (h && h.ok === false && (Date.now() - (h.at || 0)) < SCRAPE_FAIL_COOL_MS) { cooled++; continue }
    } catch (_) {}
    /* ① 识别失败待处理；② 从未刮过且本地/缓存都没有海报图（封面空缺） */
    if (!it.pending && !(!it.scraped && !it.relPoster && !it.webPoster)) continue
    fresh.push(code)
    if (fresh.length >= 500) break
  }
  if (cooled) console.log('[scan] 自动刮削跳过 ' + cooled + ' 个最近刮失败的番号（冷却 ' + (SCRAPE_FAIL_COOL_MS / 86400000) + ' 天，可手动刮削）')
  if (fresh.length) {
    SCAN.autoQueued = (SCAN.autoQueued || 0) + fresh.length
    autoIngestQueue(fresh, via)
    console.log('[scan] 自动刮削：' + fresh.length + ' 个新番号已排队（via ' + via + '，设置 → 自动化 可关）')
  }
  return fresh.length
}

/* ================== 订阅自动下载：刮削完成后自动把磁力推到 115 ==================
 * 触发链：订阅检查 → 新作排进刮削队列 → 刮完拿到磁力 → 若这条订阅开了自动下载，
 *         就把磁力列表第一条（按 seeders 降序，即种子最多的那条）推到 115 离线目录。
 * 与「自动入库」是两件事：入库 = 抓元数据进本地库；自动下载 = 把文件拉回 115。
 * 两个都开时先刮元数据（库里马上能看到条目），再把磁力推去 115 拉文件。
 *
 * 三道保险，缺一不可：
 *   ① 全局开关 CFG.subAutoDl（默认关）—— 免得某条订阅误开就一路狂推；
 *   ② 每条订阅单独的 autoDl（默认关）；
 *   ③ 单次检查最多推 CFG.subAutoDlMax 部（默认 20）—— 订阅到多产女优时一次能冒出上百部，
 *      不限量会瞬间灌爆 115 的离线配额（实测 2026-10 配额 1500 已被用满）。
 * 另外用 SUB_DL.pushed 记住推过的番号，下次检查不会重复推同一部。 */
const SUB_DL = { pushed: {}, round: { at: 0, n: 0, ok: 0, fail: 0, skipped: 0, last: [] } }
const SUB_DL_FILE = () => { try { return path.join(cacheDir(), 'sub-autodl.json') } catch (_) { return '' } }
function subDlSave() {
  try { fs.writeFileSync(SUB_DL_FILE(), JSON.stringify({ pushed: SUB_DL.pushed, round: SUB_DL.round })) } catch (_) {}
}
function subDlLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(SUB_DL_FILE(), 'utf8'))
    if (d && d.pushed && typeof d.pushed === 'object') SUB_DL.pushed = d.pushed
    if (d && d.round && typeof d.round === 'object') SUB_DL.round = Object.assign(SUB_DL.round, d.round)
  } catch (_) {}
}
function subDlOn() { return CFG.subAutoDl === '1' }                  // 全局总开关：默认关
function subDlMax() { const n = parseInt(CFG.subAutoDlMax, 10); return isNaN(n) ? 20 : Math.max(1, Math.min(200, n)) }
/* ── 磁力质量识别（对标 Byte-Muse DEFAULT_FILTER / DEFAULT_SORT，作用在「同一步片子的多条磁力」上）──
 * 磁力对象字段见刮削处（title / hash / size / date / seeders / leechers / magnet）。
 * 这些标都藏在 title 里：中字 / 無修正(无码) / 4K·UHD / HEVC / VR / AI / 字幕 … */
function magTitle(m) { return String((m && (m.title || (m.magnet || ''))) || '').toLowerCase() }
function magIsChinese(t) { if (/(无|無)字幕|字幕なし|英字|no[-\s]?sub/i.test(t)) return false; return /中文字幕|中字|字幕|chinese|\b(chs|cht|zh|sub|bilingual)\b|subtitle/i.test(t) }
function magIsUC(t) { return /無修正|无码|无修正|uncensored|reducing\s*mosaic|\buc\b|破解|流出/.test(t) }
/* 破解：有码原片被软件去码（reducing mosaic）/ 流出片。语义上 破解 ⊆ 无码 ——
   「只要无码」把它算进来（用户要的就是「去码」），「排除无码」也一并排除；
   但「破解」单独成项，这样同档里能把破解版排到原生无码前面（原版 HD 去码 > 老片无码）。 */
function magIsBreak(t) { return /破解|reducing\s*mosaic|流出|\bleak(?:ed)?\b|uncensored\s*leak/.test(t) }
/* UHD：分隔符要认括号。【原实现只认 空格/./_/- ，`[4K]`、`(4K)`、`【4K】` 这类方括号包裹的写法全漏判，
   而磁力标题里方括号恰恰是最常见的 —— 等于「默认排除 4K」经常形同虚设。】 */
function magIsUHD(t) { return /(^|[^a-z0-9])(4k|2160p|uhd)/.test(t) }
/* 画质档位：FHD/1080p = 2，HD/720p = 1，未标注 = 0。
   仅用于同分排序（同种子数时 1080p 优先于 720p）——原实现只分「4K / 非4K」，
   默认排除 4K 之后剩下的一堆 720p 与 1080p 完全不加区分，按种子数排容易选中 720p。 */
function magQual(t) {
  if (/(^|[^a-z0-9])(fhd|full\s*-?\s*hd|1080[pi]|1920x1080)([^a-z0-9]|$)/.test(t)) return 2
  if (/(^|[^a-z0-9])(hd|720[pi]|1280x720)([^a-z0-9]|$)/.test(t)) return 1
  return 0
}
/* 去码档位：破解/流出(2) > 原生无码(1) > 有码(0)。同一步片子的多条磁力里这是内容上的实质差别，
   但「能不能下完」（种子数）比它更重，所以放在种子数、画质之后做同档微调。 */
function magDecensor(t) { return magIsBreak(t) ? 2 : (magIsUC(t) ? 1 : 0) }
function magSizeMB(m) {
  const s = String((m && m.size) || '')
  const m1 = s.match(/([\d.]+)\s*(TiB|TB|GiB|GB|MiB|MB)/i); if (!m1) return 0
  const v = parseFloat(m1[1]); const u = m1[2].toUpperCase()
  if (u === 'TIB' || u === 'TB') return v * 1024 * 1024
  if (u === 'GIB' || u === 'GB') return v * 1024
  if (u === 'MIB' || u === 'MB') return v
  return 0
}
/* 从一批磁力里挑「最佳」那一条（只推 1 条）。返回 null = 没挑到任何合格磁力。
 * sub 可为空：仅用全局过滤；sub.requireSub / sub.requireUncensored 是订阅级「只要中字/只要无码」，
 *   会作为额外 AND 条件叠加到全局 DEFAULT_FILTER 上（和 Byte-Muse 的 only_chinese/only_uc 同语义）。 */
function subMagnetPick(magnets, sub) {
  let list = (Array.isArray(magnets) ? magnets : []).filter(m => /^magnet:/i.test(String((m && (m.magnet || m.url)) || '').trim()))
  if (!list.length) return null
  const onlyChinese = (sub && sub.requireSub === true) || CFG.subDlOnlyChinese === '1'
  const onlyUc = (sub && sub.requireUncensored === true) || CFG.subDlOnlyUc === '1'
  const onlyBreak = CFG.subDlOnlyBreak === '1'
  // onlyX 优先于 excludeX：勾「只要无码 / 只要破解 / 只要4K」时，不应再执行对应的「排除无码 / 排除破解 / 排除4K」，
  // 否则两开关互斥 → 任何磁力都过不了 → 自动下载静默跳过（不占额度、无报错，极难察觉）。
  // 「只要破解」还要连带架空「排除无码」—— 破解 ⊆ 无码（见 magIsUC），两条同时生效必然零结果。
  const excludeUc = (onlyUc || onlyBreak) ? false : (CFG.subDlExcludeUc === '1')
  const excludeBreak = onlyBreak ? false : (CFG.subDlExcludeBreak === '1')
  const onlyUhd = CFG.subDlOnlyUhd === '1'
  const excludeUhd = onlyUhd ? false : (CFG.subDlExcludeUhd !== '')   // 默认开（排除 4K/UHD，对标 Byte-Muse exclude_uhd:true）
  const includeKw = String(CFG.subDlIncludeKw || '').toLowerCase().split(/[,，\s]+/).filter(Boolean)
  const excludeKw = String(CFG.subDlExcludeKw || '').toLowerCase().split(/[,，\s]+/).filter(Boolean)
  const minMB = parseFloat(CFG.subDlMinSize); const maxMB = parseFloat(CFG.subDlMaxSize)
  list = list.filter(m => {
    const t = magTitle(m)
    if (onlyChinese && !magIsChinese(t)) return false
    if (onlyUc && !magIsUC(t)) return false
    if (excludeUc && magIsUC(t)) return false
    if (onlyBreak && !magIsBreak(t)) return false
    if (excludeBreak && magIsBreak(t)) return false
    if (onlyUhd && !magIsUHD(t)) return false
    if (excludeUhd && magIsUHD(t)) return false
    if (includeKw.length && !includeKw.some(k => t.includes(k))) return false
    if (excludeKw.length && excludeKw.some(k => t.includes(k))) return false
    const mb = magSizeMB(m); if (!isNaN(minMB) && mb && mb < minMB) return false
    if (!isNaN(maxMB) && mb && mb > maxMB) return false
    return true
  })
  if (!list.length) return null
  /* 挑最优（只推 1 条）。优先级自上而下：
   *   ① 有活种（seeders > 0）—— 死种推过去基本下不动，先淘汰
   *   ② 中文字幕
   *   ③ 种子数（多者优先）
   *   ④ 画质档位：1080p/FHD > 720p/HD > 未标注
   *   ⑤ 去码档位：破解/流出 > 原生无码 > 有码（同档微调）
   *   ⑥ 非 UHD（默认）；勾了「只要 4K」时反过来
   * 原实现把「无码」排在种子数之前，导致无码片里只标了「無修正」的 1 种条目
   * 会挤掉旁边 5 种的主条目（实测 020324-001 就是这样挑错的）——
   * 「能不能下完」应当比「标签」更重，故把无码降为同档微调。 */
  list.sort((a, b) => {
    const ta = magTitle(a), tb = magTitle(b)
    const la = (a.seeders || 0) > 0 ? 1 : 0, lb = (b.seeders || 0) > 0 ? 1 : 0; if (la !== lb) return lb - la
    const ca = magIsChinese(ta) ? 1 : 0, cb = magIsChinese(tb) ? 1 : 0; if (ca !== cb) return cb - ca
    const sa = a.seeders || 0, sb = b.seeders || 0; if (sb !== sa) return sb - sa
    const qa = magQual(ta), qb = magQual(tb); if (qa !== qb) return qb - qa
    const da = magDecensor(ta), db = magDecensor(tb); if (da !== db) return db - da   // 破解/流出 > 原生无码
    const va = magIsUHD(ta) ? 1 : 0, vb = magIsUHD(tb) ? 1 : 0
    return onlyUhd ? (vb - va) : (va - vb)   // 默认非 UHD 优先；onlyUhd 时 UHD 优先
  })
  return list[0]
}
/* 新一轮订阅检查：重置本轮计数 —— 额度是「每次检查」的，不是「每天」的 */
function subDlRoundStart() {
  SUB_DL.round = { at: Date.now(), n: 0, ok: 0, fail: 0, skipped: 0, last: [] }
  subDlSave()
}
/* 推一条磁力到 115：
 * ⚠ pan115 那批函数（签名/重试/cookie）都定义在 handleActorApi() 内部，顶层作用域拿不到，
 *   这里不复制一份（重复实现迟早走样），直接请求自己的 /api/115/push ——
 *   顺带复用推完的 watch115Push 自动认领盯梢（115 下完自动入库就是靠那条链路）。 */
async function subPush115(code, magnet) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/api/115/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, magnets: [magnet] }),
    signal: AbortSignal.timeout(45000)
  })
  return await r.json()
}
/* 刮削完成后调用：符合条件就把这部片子的最佳磁力推到 115。返回 null = 没推（正常跳过）。 */
async function subAfterScrape(code, subId) {
  try {
    if (!subId || !subDlOn()) return null
    const subs = Array.isArray(data.subs) ? data.subs : []
    const s = subs.find(x => x && x.id === subId)
    if (!s || s.autoDl !== '1') return null
    if (SUB_DL.pushed[code]) return null                        // 这部推过了
    if (SUB_DL.round.n >= subDlMax()) { SUB_DL.round.skipped++; subDlSave(); return null }
    let magnets = []
    try { const m = readMovieCache(code); magnets = (m && Array.isArray(m.magnets)) ? m.magnets : [] } catch (_) { magnets = [] }
    /* 选最佳磁力：先按质量过滤（对标 Byte-Muse DEFAULT_FILTER：中字/无码/UHD/关键词/体积），
     * 再按质量优先排序（DEFAULT_SORT：中字 > 无码 > 种子数 > 非UHD），只推 1 条。
     * 原实现是纯 seeders 降序，已改为质量优先。 */
    const best = subMagnetPick(magnets, s)
    const mg = String((best && (best.magnet || best.url)) || '').trim()
    if (!/^magnet:/i.test(mg)) return null                      // 没挖到合格磁力：跳过，且不占额度
    SUB_DL.round.n++
    let d = null
    try { d = await subPush115(code, mg) } catch (e) { d = { ok: false, error: e.message } }
    const ok = !!(d && d.ok)
    if (ok) { SUB_DL.round.ok++; SUB_DL.pushed[code] = { at: Date.now(), subId, subName: s.name || '' } }
    else SUB_DL.round.fail++
    SUB_DL.round.last.unshift({ code, at: Date.now(), ok, error: ok ? '' : String((d && d.error) || '推送失败') })
    SUB_DL.round.last = SUB_DL.round.last.slice(0, 30)
    subDlSave()
    console.log('[sub-autodl] ' + code + ' → 115 ' + (ok ? '✓ 已推送' : '✗ ' + String((d && d.error) || '失败')))
    return { code, ok }
  } catch (_) { return null }
}
/* 队列落盘：几百部的批量入库要跑好几个小时，容器中途重启（部署/断电）不能把没跑的番号全丢了。
 * ⚠️ 「正在刮的那一部」在 autoIngestRun 里已经 shift 出队了，**只存 queue 会把它弄丢** ——
 *   容器在刮到一半时重启/被 stop，那一部就永远消失了（实测踩过）。所以 current 一起落盘，
 *   启动时 autoQLoad 把它 unshift 回队首，接着刮。手动 POST /api/scrape/start 起的单跑任务同理。 */
const AUTO_Q_FILE = () => { try { return path.join(cacheDir(), 'ingest-queue.json') } catch (_) { return '' } }
function autoQSave() {
  try {
    fs.writeFileSync(AUTO_Q_FILE(), JSON.stringify({
      queue: AUTO_INGEST.queue, via: AUTO_INGEST.queue.via || {},
      current: AUTO_INGEST.current, currentVia: AUTO_INGEST.currentVia || '',
      done: AUTO_INGEST.done, ok: AUTO_INGEST.ok, fail: AUTO_INGEST.fail, total: AUTO_INGEST.total
    }))
  } catch (_) {}
}
function autoQLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(AUTO_Q_FILE(), 'utf8'))
    /* 手动单跑的任务也要能续：SCRAPE.code 有值且不在队列里 → 补进队首（重启后接着刮） */
    let extra = []
    if (SCRAPE.code && Array.isArray(d.queue) && d.queue.indexOf(SCRAPE.code) < 0 && !d.current) extra = [SCRAPE.code]
    if (d.current && Array.isArray(d.queue) && d.queue.indexOf(d.current) < 0) extra = [d.current].concat(extra)
    if (Array.isArray(d.queue) && d.queue.length) {
      AUTO_INGEST.queue = d.queue; AUTO_INGEST.queue.via = d.via || {}
      AUTO_INGEST.done = Number(d.done) || 0; AUTO_INGEST.ok = Number(d.ok) || 0; AUTO_INGEST.fail = Number(d.fail) || 0
      for (const c of extra) { AUTO_INGEST.queue.unshift(c); AUTO_INGEST.queue.via[c] = '断点续跑' }
      AUTO_INGEST.total = AUTO_INGEST.queue.length + AUTO_INGEST.done
      autoQSave()
      autoIngestRun().catch(() => {})
      console.log('[auto-ingest] 恢复上次没跑完的队列：' + AUTO_INGEST.queue.length + ' 个番号' + (extra.length ? '（含中断的 ' + extra.join(',') + '）' : ''))
    }
  } catch (_) {}
}

/* 启动时收拾「孤儿排队记录」：state:'queued' 的占位是提交任务那一刻写的，
 * 正常会被刮完时的 scrapeHistAdd 覆盖。但只要 worker 没跑到那一步（容器在排队期间重启、
 * 队列被清空、already 短路等），这条占位就会永远停在「排队中」—— 用户看到的就是
 * 「历史里一直排队中 / 卡片卡住」（2026-10-06 反馈）。
 * 这里在启动时按「当前队列 + 当前在刮」核对一遍：对不上的占位按实际落地情况收尾
 * （有离线数据 = 成功跳过，没有 = 失败中断），不留下永久假状态。 */
function reconcileQueuedHist() {
  try {
    scrapeHistLoad()
    if (!SCRAPE_HIST.list.some(x => x && x.state === 'queued')) return
    const inQ = new Set(AUTO_INGEST.queue.map(c => bare(c)))
    if (SCRAPE.code) inQ.add(bare(SCRAPE.code))
    for (const k of Object.keys(AUTO_INGEST.active || {})) inQ.add(bare(k))
    let fixed = 0
    for (const r of SCRAPE_HIST.list) {
      if (!r || r.state !== 'queued') continue
      if (inQ.has(bare(r.code))) continue          // 真的还在队列里 → 保留
      let m = null
      try { m = readMovieCache(r.code) } catch (_) {}
      if (m && m.scraped) {
        r.ok = true; r.skipped = true; r.note = '本地已有离线数据，未重复刮削'
        r.src = String(m.source || '').split(' ')[0] || '本地已有'
        r.imgSrc = (m.images && (m.images.posterSrc || m.images.fanartSrc)) || ''
      } else {
        r.ok = false; r.err = r.err || '排队期间被中断（容器重启或队列清空），未刮成'
      }
      delete r.state                            // 收尾后不再是排队态
      r.dur = 0
      fixed++
    }
    if (fixed) {
      try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
      console.log('[scrape-hist] 收拾了 ' + fixed + ' 条中断的「排队中」记录')
    }
  } catch (_) {}
}
const SCRAPE_HIST = { loaded: false, list: [] }
/* 媒体库「脏了」的自增序号：任何一部刮削入库（成功或失败写完历史）都会 +1。
 * 前端全站常驻的 aqPoll 本来就每 2s 拉一次 /api/scrape/queue，把这个号捎带回去，
 * 它就拿到了一个「零额外请求」的信号 —— 号变了就把媒体库补一次，
 * 于是在首页/影片库/演员页待着也能立刻看到刚入的部（以前只有添加页会补，
 * 而且靠的是队列 done 计数，手动单跑那一部时计数根本不动 → 库里永远不出现）。 */
const LIB_SEQ = { n: Date.now() % 1000000 }
function libSeq() { return LIB_SEQ.n }
function libSeqTouch() { LIB_SEQ.n = (LIB_SEQ.n + 1) % 100000000 }
const SCRAPE_HIST_FILE = () => { try { return path.join(cacheDir(), 'scrape-history.json') } catch (_) { return '' } }
function dedupeHist() {
  // 一个番号只保留一条记录（取最后出现的，即最新状态），避免历史里反复出现重复番号
  const map = new Map()
  for (const x of SCRAPE_HIST.list) { if (x && x.code != null) map.set(bare(x.code), x) }
  SCRAPE_HIST.list = Array.from(map.values())
}
function scrapeHistLoad() {
  if (SCRAPE_HIST.loaded) return
  SCRAPE_HIST.loaded = true
  try { const a = JSON.parse(fs.readFileSync(SCRAPE_HIST_FILE(), 'utf8')); if (Array.isArray(a)) SCRAPE_HIST.list = a } catch (_) {}
  dedupeHist()   // 读入即去重：旧文件里已有的重复番号立刻合并成一条
  scrapeHistBackfillImgSrc()
}
/* 补 imgSrc：imgSrc 是 2026-10-05 才加进历史记录的字段，之前刮过的成功条目没有它，
 * 前端就会回退显示「元数据来源」（MIRD285 因此显示 jav321，而它的图其实来自 DMM 图床）。
 * 这里在读入历史时按番号回查各自 meta.json 的 images.posterSrc/fanartSrc 补齐 —— meta 里
 * 一直存着真实图源，所以不必重新刮。补完写回文件，只做一次（补过就不再扫）。 */
function scrapeHistBackfillImgSrc() {
  let changed = false
  for (const r of SCRAPE_HIST.list) {
    if (!r || !r.ok || r.imgSrc) continue
    try {
      const m = readMovieCache(r.code)
      const s = m && m.images && (m.images.posterSrc || m.images.fanartSrc)
      if (s) { r.imgSrc = s; changed = true }
    } catch (_) {}
  }
  if (changed) { try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {} }
}
function scrapeHistAdd(rec) {
  scrapeHistLoad()
  const k = bare(rec.code)
  const idx = SCRAPE_HIST.list.findIndex(x => x && bare(x.code) === k)
  if (idx >= 0) {
    /* 迟到的旧结果不许盖掉新结果：看门狗放弃某部之后，后台那次 scrapeAsync 可能还活着，
     * 它最终完成/报错时写的记录 at（任务开始时间）比现在的新状态更早，
     * 无条件覆盖会把「用户重试后已成功」打回失败、meta 也可能被旧数据覆盖。 */
    const old = SCRAPE_HIST.list[idx]
    if (old && old.state !== 'queued' && rec.state !== 'queued' &&
        (Number(rec.at) || 0) < (Number(old.at) || 0)) return
    SCRAPE_HIST.list[idx] = rec   // 同番号已存在 → 直接覆盖（更新最新状态），不再追加
  } else SCRAPE_HIST.list.push(rec)
  /* 历史不再设上限：哪怕刮了上千部也全部保留（去重仍按番号，不会重复行）。 */
  try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
  /* 通知前端「媒体库变了，去补一次」。排队占位那次不算 —— 那时候还什么都没入进来，
   * 只有任务真正有结果（成功/失败/skipped）才值得让前端重拉 data.json。 */
  if (rec.state !== 'queued') libSeqTouch()
}
/* 把一批番号的历史「排队中」占位就地收尾。
 * 用在「用户把番号从待跑队列里清掉/移掉」的时候：这些占位本来是等 worker 刮完覆盖的，
 * 可番号已经不在队列里了，永远不会有 worker 来覆盖它 → 历史里会一直挂着「排队中」。
 * （启动时的 reconcileQueuedHist 能兜底，但那要等下次重启，本次会话内看着就是卡住了。） */
function histFinishQueued(codes, msg) {
  try {
    scrapeHistLoad()
    const ds = new Set((codes || []).map(c => bare(c)))
    if (!ds.size) return
    let fixed = 0
    for (const r of SCRAPE_HIST.list) {
      if (!r || r.state !== 'queued' || !ds.has(bare(r.code))) continue
      r.ok = false; r.err = String(msg || '已从队列移除，未刮成'); delete r.state; r.dur = 0
      fixed++
    }
    if (fixed) {
      try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
      libSeqTouch()
      console.log('[scrape-hist] 收尾了 ' + fixed + ' 条被移出队列的「排队中」记录')
    }
  } catch (_) {}
}

/* ---------- 订阅女优「全量作品自动入库」 ----------
 * 和上面的 autoIngest 是两件事，别混：
 *   autoIngest —— 每次检查订阅时，把「线上有、本机没有」的**新作**排进队列；actor 只翻前 2 页（≈20 部）。
 *   这里       —— 订阅一个女优的**那一刻**，把她的**全部作品**翻页拉到底（可能几百部）再排队刮削。
 * 开关：设置 → 偏好 → 「订阅女优后自动获取全部作品」（uiPrefs.subsfull，默认关）。
 * 默认关的理由：热门女优几百部，一开就会连续刮很久、也吃线上配额，不该由代码替用户决定。 */
const SUB_FULL = { running: false, name: '', subId: '', found: 0, page: 0, total: 0, err: '', at: 0, dry: false, expect: 0, terms: '', dropped: '', exact: false, note: '' }
const subsFullOn = () => String((((CFG || {}).uiPrefs) || {}).subsfull || '') === '1'

/* ---------- JavDB 女优代号（2026-10-03） ----------
 * 网页 https://javdb.com/actors/A5yq 里的 A5yq 与 app API 的 actor id 是同一套：
 * 实测 v1/actors/A5yq 直接 200，返回 葵司 / 别名「葵つかさ」/ videos_count 476。
 * 有代号 = 100% 锁人，全量抓取不再需要「拿名字去搜然后猜是不是同一个人」。
 * 注意：app API 没有「按 id 取作品」的端点（v1|v2/actors/{id}/videos 全 404），
 * 作品列表仍要按名字翻页搜 —— 代号的作用是把「人」钉死，再用官方主名 + 全量别名去搜。 */
function jdbActorCodeOf(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  const m = s.match(/javdb\.com\/actors\/([A-Za-z0-9]+)/i)
  if (m) return m[1]
  /* 裸代号只「可能」是代号（MIDE 也是合法的系列前缀）——add/update 里会用 v1/actors/{code}
   * 实测验证，404 就退回普通名字订阅，不会误伤。 */
  return /^[A-Za-z0-9]{3,6}$/.test(s) ? s : ''
}
async function onlineActorById(id) {
  const j = await onlineGet('v1/actors/' + encodeURIComponent(String(id || '').trim()))
  return ((((j || {}).data) || {}).actor) || null
}
/* 订阅对象填的是 JavDB 代号 / 女优页链接吗？命中 → 返回 { code, actor }（官方主名 + 全量别名 + 线上作品数） */
async function onlineActorResolve(input) {
  const code = jdbActorCodeOf(input)
  if (!code) return null
  try {
    const d = await onlineActorById(code)
    if (d && d.name) return { code, actor: d }
  } catch (_) {}
  return null
}

/* ---------- 库内女优 JavDB 代号回填（2026-10-03） ----------
 * 给影片库（data.json items 的 actors）里每位演员查 JavDB 代号，存 cache/jdb-codes.json：
 *   name -> { id, name, videos_count, at }（命中）或 { miss: 1, at }（线上查无此人，7 天后才重试）。
 * 用途：① 订阅按名字添加时自动升级成 id 锁定（onlineActorSmartResolve）；
 *      ② 女优详情页显示代号 + 直达 JavDB 女优页（免搜索）。
 * 限速 350ms/人（每人一次 v2/search），匹配复用 onlineActorExact（精确同名 + 姓相同+名部=别名两步），
 * 每查 10 个落一次盘，可断点续跑；启动时自动续跑没查完的。 */
const JDB_CODE_FILE = () => path.join(cacheDir(), 'jdb-codes.json')
let JDB_CODES = null
function jdbCodeMap() {
  if (JDB_CODES) return JDB_CODES
  try { JDB_CODES = JSON.parse(fs.readFileSync(JDB_CODE_FILE(), 'utf8')) || {} } catch (_) { JDB_CODES = {} }
  return JDB_CODES
}
function jdbCodeSave() {
  try { fs.writeFileSync(JDB_CODE_FILE(), JSON.stringify(JDB_CODES || {})) } catch (_) {}
}
/* 目标名单：① 影片库里出现过的演员（原来的范围，几百人）
 *          ② **整个女优名册 actresses.json（2.5 万人）** —— 命中后订阅/刮削/详情页全都受益，
 *             所以回填目标是名册而非库；两者合并去重，谁还没查过就查谁。 */
function jdbCodeTargets() {
  const set = new Set()
  for (const it of ((DATA && DATA.items) || [])) {
    const a = it.actors
    if (Array.isArray(a)) for (const x of a) { const n = String(x || '').trim(); if (n) set.add(n) }
    else { const n = String(a || '').trim(); if (n) set.add(n) }
  }
  return [...set]
}
/* 不像人名的杂质直接跳过 —— 25,422 人的名册里混着乱码/片商前缀/标注串，
 * 给它们发请求纯属浪费配额（还会平白把 miss 率拉高）。 */
function jdbNamePlausible(n) {
  if (!n || n.length < 2 || n.length > 20) return false
  if (/^[\x20-\x7F]+$/.test(n)) return false                    // 纯 ASCII：片商前缀（ABP/IPZZ）/ 拉丁艺名
  if (/[（(）)?？:：/\\|,，、]/.test(n)) return false           // 括号与标点：标注串/刮削残渣
  if (/[0-9０-９]/.test(n)) return false                        // 含数字：场次编号类
  return true
}
function jdbCodeRosterTargets() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(UI_ROOT, 'actresses.json'), 'utf8'))
    if (!Array.isArray(arr)) return []
    const out = new Set()
    for (const a of arr) {
      const n = String((a && a.name) || '').trim()
      if (jdbNamePlausible(n)) out.add(n)
    }
    return [...out]
  } catch (_) { return [] }
}
/* 上次跑的模式（名册 / 库）落盘 —— 容器重启后要接着同一个模式跑，别掉回小范围 */
const JDB_RUN_FILE = () => path.join(cacheDir(), 'jdb-codes-run.json')
let JDB_RUN = { mode: 'lib' }
function jdbRunLoad() { try { JDB_RUN = JSON.parse(fs.readFileSync(JDB_RUN_FILE(), 'utf8')) || JDB_RUN } catch (_) {} }
function jdbRunSave() { try { fs.writeFileSync(JDB_RUN_FILE(), JSON.stringify(JDB_RUN)) } catch (_) {} }
jdbRunLoad()
let JDBCODE = { running: false, total: 0, done: 0, hits: 0, cur: '', stop: false, mode: '', phase: 0, etaMs: 0, reqs: 0, gap: 0, backoffs: 0, startedAt: 0 }
async function jdbCodeBackfill({ mode = 'lib', phase = 2 } = {}) {
  if (JDBCODE.running) return
  const M = jdbCodeMap()
  const names = mode === 'roster' ? jdbCodeRosterTargets() : jdbCodeTargets()
  /* 没查过的全查；miss 的 7 天后才重试（线上收录会变） */
  const targets = names.filter(n => {
    const e = M[n]
    return !e || (!e.id && Date.now() - (e.at || 0) > 7 * 864e5)
  })
  if (!targets.length) return
  JDBCODE.running = true; JDBCODE.stop = false
  JDBCODE.mode = mode; JDBCODE.phase = phase
  JDBCODE.total = targets.length; JDBCODE.done = 0; JDBCODE.hits = 0
  JDBCODE.startedAt = Date.now(); JDBCODE.etaMs = 0
  /* 开启节流（自适应：起始 1100ms，成功逐步加速，失败立刻退避） */
  RATE.on = true; RATE.gap = 1100; RATE.next = 0; RATE.backoffs = 0; RATE.reqs = 0
  const deep = phase !== 1                      // phase 1 = 快扫：不做候选详情比对，省 80% 请求
  try {
    for (const name of targets) {
      if (JDBCODE.stop) break
      JDBCODE.cur = name; JDBCODE.done++
      try {
        const a = await onlineActorExact(name, { deep })
        if (a && a.id) { M[name] = { id: a.id, name: a.name, videos_count: Number(a.videos_count) || 0, at: Date.now() }; JDBCODE.hits++ }
        else M[name] = { miss: 1, at: Date.now() }
      } catch (_) { M[name] = { miss: 1, at: Date.now() } }
      if (JDBCODE.done % 10 === 0) jdbCodeSave()
      /* ETA：先跑 20 个人校准出一个真实速率，之后每 200 人刷新一次 */
      const el = Date.now() - JDBCODE.startedAt
      if (JDBCODE.done === 20 || JDBCODE.done % 200 === 0) JDBCODE.etaMs = Math.round((el / JDBCODE.done) * (JDBCODE.total - JDBCODE.done))
      JDBCODE.reqs = RATE.reqs; JDBCODE.gap = RATE.gap; JDBCODE.backoffs = RATE.backoffs
    }
  } finally {
    jdbCodeSave()
    RATE.on = false
    JDBCODE.running = false; JDBCODE.cur = ''
  }
}
/* 全量回填 = 两阶段：① 快扫（每人 1~2 次搜索，最快拿到大部分代号）
 *                    ② 精查（只对没中的人做全变体 + 候选详情比对，也就是贵的第三次机会） */
async function jdbCodeRunAll() {
  JDB_RUN = { mode: 'roster' }; jdbRunSave()
  await jdbCodeBackfill({ mode: 'roster', phase: 1 })
  if (JDBCODE.stop) { JDB_RUN = { mode: 'lib' }; jdbRunSave(); return }
  await jdbCodeBackfill({ mode: 'roster', phase: 2 })
  await jdbCodeBackfill({ mode: 'lib', phase: 2 })
  JDB_RUN = { mode: 'roster' }; jdbRunSave()
}
/* 订阅锁人三级跳：代号/链接 → 库内代号缓存（按名字命中，缓存过期会按 id 再验证）→ 名字精确匹配 */
async function onlineActorSmartResolve(input) {
  const direct = await onlineActorResolve(input).catch(() => null)
  if (direct) return direct
  const name = String(input || '').trim()
  if (!name || jdbActorCodeOf(name)) return null
  const e = jdbCodeMap()[name]
  if (e && e.id) {
    try {
      const d = await onlineActorById(e.id)
      if (d && d.name) return { code: e.id, actor: d }
    } catch (_) {}
  }
  /* 第三级：名字精确匹配（2026-10-13 补 —— 注释一直写着「三级跳」，但这一级从没实现）。
   * 后果：从女优名册直接点「✚ 订阅」时只带名字，一旦代号缓存还没回填到她（新人 / 刚重建缓存），
   * 就锁不到 id，订阅检查只好退回「拿名字当标题搜影片」→ 收进来一堆不相干的片子。
   * 用 onlineActorExact（同名 → 姓同+名部=别名 → 详情全量别名+异体字）：认不出就 null，
   * 由调用方决定怎么提示，绝不猜一个人回来。 */
  const a = await onlineActorExact(name).catch(() => null)
  if (a && a.id) return { code: a.id, actor: a }
  return null
}

/* 异体字归一（第三次机会比对用）：旧字体/假名汉字混淆形 —— 三上悠「亞」vs 三上悠「亜」、
 * 水卜さくら 的「卜」线上常写作片假名「ト」等。只用于别名比对，不动原有 onNorm 精确逻辑。 */
const JDB_VARMAP = { '卜': 'ト', '亞': '亜', '澁': '渋', '惠': '恵', '澤': '沢', '濱': '浜', '邊': '辺', '櫻': '桜', '圓': '円', '龜': '亀', '廣': '広', '德': '徳', '豐': '豊', '黑': '黒', '戶': '戸', '结': '結', '绪': '緒', '响': '響', '叶': '葉', '冈': '岡', '泽': '沢', '满': '満', '关': '関', '绘': '絵', '荣': '栄', '边': '辺', '滨': '浜' }
const onNormVar = s => onNorm(onKana(String(s || ''))).replace(/./g, c => JDB_VARMAP[c] || c)

/* 只认「精确同名」的女优（onlineActorFind 会兜底取首条，那对全量抓取太危险 ——
 * 实测「恋れん」在线上搜不到同名，兜底返回的是「朝日奈花戀」，
 * 拿她的别名去搜会把别人几百部片子整批刮进来）。 */
/* 查询词变体（2026-10-03）：线上搜索对异体字不模糊（「波多野结衣」搜不到「結衣」）、
 * 也不认「本名（备注）」整串 —— 依次试：原名 → 去括号 → 括号内真名 → 异体字归一 → 组合。
 * 实测「ひなたなつ（日向なつ）」的真名在括号里、「百田光稀（百田光希）」两边都要能查。 */
function onlineActorQueryVariants(name) {
  const base = String(name || '').trim()
  const inner = (base.match(/[（(]([^（）()]*)[）)]/) || [])[1] || ''
  const nopp = base.replace(/[（(][^）)]*[）)]/g, '').trim()
  const trans = s => String(s || '').replace(/./g, c => JDB_VARMAP[c] || c)
  const out = [base, nopp, inner, trans(base), trans(nopp), trans(inner)].filter((x, i, a) => x && a.indexOf(x) === i)
  return out
}
async function onlineActorExact(name, { deep = true } = {}) {
  const n = onNorm(name)
  if (!n) return null
  let list = []
  for (const q of onlineActorQueryVariants(name)) {
    const j = await onlineGetPaced('v2/search?q=' + encodeURIComponent(q) + '&type=actor&page=1')
    list = ((j || {}).data || {}).actors || []
    if (list.length) break
  }
  for (const a of list) {
    const names = [a.name, a.name_zht, a.other_name].filter(Boolean).join(',')
    for (const x of String(names).split(',')) if (x && onNorm(x) === n) return a
  }
  /* 第二次机会（2026-10-03）：线上主名用字可能不同 —— 实测订阅「新井リマ」，线上主名是「新井莉麻」，
   * 全名比对必不相等，但搜索结果里她的别名 other_name=りま,リマ 恰好就是订阅名的名部。
   * 规则：**姓相同 + 名部等于某个别名（平/片假名不敏感）** → 也认作同一人。
   * 对「恋れん」那种真·不同人仍然安全：她搜不到姓相同且别名正好是「れん」的人。 */
  const qSur = onSurOf(name)
  const qGiven = qSur && qSur.length < name.length ? name.slice(qSur.length) : ''
  if (qSur && qGiven) for (const a of list) {
    for (const nm of [a.name, a.name_zht]) {
      if (!nm || !onNorm(nm).startsWith(onNorm(qSur))) continue   // 演员名以订阅名的「姓」开头（新井莉麻 ∋ 新井）
      const aliases = String(a.other_name || '').split(',').map(x => onNorm(onKana(x)))
      if (aliases.some(x => x && x === onNorm(onKana(qGiven)))) return a
    }
  }
  /* 第三次机会（2026-10-03）：主名与查询名完全不同形 —— 实测「つぼみ」线上主名是「蕾」、
   * 「あやみ旬果」是「彩美旬果」、「水卜さくら」是「水卜櫻」（别名还写作水「ト」さくら）。
   * 拿搜索前 5 个候选的 v1 详情（全量别名）逐一比对，异体字归一（卜/ト、亞/亜…）后等值即认。
   * deep=false（快扫阶段）跳过这一步 —— 2.5 万人每人再打 5 次详情太贵，留给第二轮只对 miss 的人做。 */
  if (deep && list.length) {
    const cands = list.slice(0, 5).slice().sort((x, y) => (Number(y.videos_count) || 0) - (Number(x.videos_count) || 0))
    for (const a of cands) {
      if (!a.id) continue
      try {
        const j = await onlineGetPaced('v1/actors/' + encodeURIComponent(a.id))
        const d = ((((j || {}).data) || {}).actor) || {}
        const names = [d.name, d.name_zht, d.other_name].filter(Boolean).join(',').split(',').map(x => onNormVar(x))
        if (names.some(x => x && x === onNormVar(name))) {
          return { id: a.id, name: d.name || a.name, name_zht: d.name_zht || a.name_zht, other_name: d.other_name || a.other_name, videos_count: Number(d.videos_count) || Number(a.videos_count) || 0 }
        }
      } catch (_) {}
    }
  }
  return null
}

/* 全量抓取要搜哪些词：订阅名 + 精确同名时的别名。
 * 为什么必须加别名：线上同一个人的主名常常是日文/罗马字 —— 实测「坂道美琉」直接搜只有 3 部，
 * 她的别名 other_name=miru，线上记录（videos_count）是 255 部。不扩别名等于没抓。 */
async function onlineActorSearchTerms(name, actorId) {
  const base = String(name || '').trim()
  const terms = []
  const aliasDropped = []
  const addTerm = (x) => { const t = String(x || '').trim(); if (t && t.length >= 2 && !terms.includes(t)) terms.push(t) }
  addTerm(base)
  let a = null
  /* 有 JavDB 女优代号（订阅时填了代号/链接，或旧订阅已回填 actorId）→ 按 id 直取官方资料，
   * 跳过整个「搜索结果里猜是哪位」环节，从根上消灭同名/用字不同误判。 */
  if (actorId) { try { a = await onlineActorById(actorId) } catch (_) {} }
  if (!a) { try { a = await onlineActorExact(base) } catch (_) {} }
  /* ⚠️ 别名必须从 v1 详情取，不能只信 v2/search 的列表 —— 列表里的 other_name 是**残缺的**：
   * 实测「坂道美琉」列表只给 `miru`（罗马字，搜出 103 部），
   * 而 v1/actors/vd5z 详情里是 `坂道みる, miru`（日文名，搜出 276 部）。
   * 只信列表 → 106 部；补上日文名 → 281 部（线上 videos_count 255）。差的就是这里。 */
  if (a && a.id) {
    try {
      const j = await onlineGet('v1/actors/' + encodeURIComponent(a.id))
      const d = ((((j || {}).data) || {}).actor) || {}
      for (const f of [d.name, d.name_zht, d.other_name]) for (const x of String(f || '').split(',')) addTerm(x)
      if (Number(d.videos_count)) a.videos_count = d.videos_count   // 详情更准（列表给 247，详情给 255）
    } catch (_) {}
  }
  if (a) for (const f of [a.name, a.name_zht, a.other_name]) for (const x of String(f || '').split(',')) addTerm(x)
  /* 泛化别名过滤（2026-10-03）：不含「姓」的纯名部（りま/リマ/miru）会把别人的片整批搜回来
   * —— 实测搜「リマ」400 部起步，cap（线上记录 ×1.5）根本拦不住（新井リマ cap=983）。
   * 保留：带姓的别名（坂道みる）/ 纯汉字全名（兒玉七海）/ 带空格的罗马字全名（Kodama Nanami）。 */
  if (terms.length > 1) {
    const surs = []
    for (const cand of [base, a && a.name, a && a.name_zht].filter(Boolean)) {
      const sp = onNmSplit(cand); if (sp) surs.push(onNorm(sp[0]))
    }
    const keepT = t => {
      if (t === base) return true
      const nt = onNorm(t)
      if (surs.some(x => x && nt.includes(x))) return true
      if (!/[\u3040-\u30ffa-z]/i.test(t)) return true   // 纯汉字全名
      if (/ /.test(t)) return true                       // 罗马字全名
      return false
    }
    for (let i = terms.length - 1; i >= 0; i--) if (!keepT(terms[i])) { aliasDropped.unshift(terms.splice(i, 1)[0]) }
  }
  return { terms: terms.slice(0, 6), actor: a, exact: !!a, expect: a ? (Number(a.videos_count) || 0) : 0, aliasDropped }
}

/* 某女优的**全部作品**：逐词翻页搜到底，合并去重。
 * 泛化词过滤：别名（尤其罗马字如 miru）会搜出一堆别人的片。线上给了这位女优的作品数
 * （videos_count），某词的结果超过它的 1.5 倍 + 10 就判定该词不可信、整词丢弃（宁可少不准多错）。 */
async function onlineActorAllWorks(name, { maxPages = 0, meta: preMeta = null } = {}) {
  const meta = preMeta || await onlineActorSearchTerms(name)
  const cap = meta.expect > 0 ? Math.floor(meta.expect * 1.5) + 10 : 400
  /* limit=50 是关键：v2/search 默认每页 10 条，且翻页有深度限制 —— 实测「三上悠亜」（线上记录 323）
   * 用默认 limit 翻到第 20 页只有 186 部，换成 limit=50 只要 7 页就拿到 319 部。 */
  const LIM = 50
  const pgMax = maxPages || Math.min(30, Math.ceil((meta.expect || 200) / LIM) + 3)
  const codes = []; const seen = new Set(); const dropped = []
  /* bare 会把「SSNI-826」压成「SSNI826」（去连字符），但消费方要的是**能拿去刮削的原始番号**，
   * 所以顺手记一份 bare → 原始写法的映射（2026-10-15：缺口体检要用它把番号显示回原样）。 */
  const raw = {}
  let rounds = 0
  for (const term of meta.terms) {
    const got = new Set(); let pgs = 0
    for (let pg = 1; pg <= pgMax; pg++) {
      const j = await onlineGet('v2/search?q=' + encodeURIComponent(term) + '&type=movie&page=' + pg + '&limit=' + LIM)
      const list = ((j || {}).data || {}).movies || []
      pgs = pg
      if (!list.length) break
      for (const m of list) {
        const src = String(m.number || m.code || '').trim()
        const c = bare(src)
        if (!c) continue
        got.add(c)
        if (src && !raw[c]) raw[c] = src
      }
      if (got.size > cap) break             // 已能判定是泛化词（如「みる」921 部）→ 立刻停，别白翻十几页
      if (list.length < LIM) break          // 不满一页 = 这个词已经到底
    }
    rounds += pgs
    if (got.size > cap) { dropped.push(term + '（' + got.size + ' 部，超线上记录 ' + meta.expect + '，疑为同名泛化词）'); continue }
    for (const c of got) if (!seen.has(c)) { seen.add(c); codes.push(c) }
  }
  return { codes, raw, rounds, terms: meta.terms, expect: meta.expect, exact: meta.exact, dropped, matched: meta.actor ? meta.actor.name : '' }
}

/* ---------- 缺口体检缓存（2026-10-15）
 * /api/gap/actor 拉一位女优的线上全量作品要翻十几页、十几秒，同一个人短时间内反复点要秒回。
 * 只放进程内存：数据会随线上更新，落盘反而容易给出过期的「缺 N 部」。 */
const GAP_ACTOR_CACHE = new Map()
const GAP_ACTOR_TTL = 30 * 60 * 1000
const GAP_ACTOR_MAX = 40

/* dry = 只抓取、不入库：用于「先看看这位女优线上有多少部」的诊断，也方便无损验证抓取链路 */
async function subsFullRun(sub, { dry = false } = {}) {
  if (SUB_FULL.running) { SUB_FULL.err = '已有全量任务在跑（' + (SUB_FULL.name || '') + '）'; return }
  SUB_FULL.running = true
  SUB_FULL.name = sub.name; SUB_FULL.subId = sub.id || ''; SUB_FULL.dry = !!dry
  SUB_FULL.found = 0; SUB_FULL.page = 0; SUB_FULL.total = 0; SUB_FULL.err = ''; SUB_FULL.at = Date.now()
  SUB_FULL.expect = 0; SUB_FULL.terms = ''; SUB_FULL.dropped = ''; SUB_FULL.exact = false; SUB_FULL.note = ''
  try {
    const meta = await onlineActorSearchTerms(sub.name, sub.actorId)
    SUB_FULL.exact = !!meta.exact; SUB_FULL.expect = meta.expect; SUB_FULL.terms = meta.terms.join(' / ')
    /* 线上没有同名女优 → 直接跳过。
     * 实测「恋れん」就是这样：线上搜不到这个名字的女优，硬搜却能返回 344 部，
     * 里面绝大部分是名字含「れん」的**其他**女优 —— 照单全收等于把别人几百部片子刮进自己库。
     * 这种情况只在 UI 提示「改用线上正式名字订阅」，不做任何入库。 */
    if (!meta.exact) {
      SUB_FULL.note = '线上没有同名女优（搜到的都是名字相近的别人），已跳过全量抓取'
      SUB_FULL.found = 0; SUB_FULL.total = 0
      return
    }
    const r = await onlineActorAllWorks(sub.name, { meta })
    SUB_FULL.found = r.codes.length; SUB_FULL.page = r.rounds
    SUB_FULL.expect = r.expect; SUB_FULL.terms = r.terms.join(' / '); SUB_FULL.dropped = r.dropped.join('；')
    SUB_FULL.exact = !!r.exact
    if ((meta.aliasDropped || []).length) SUB_FULL.dropped = (SUB_FULL.dropped ? SUB_FULL.dropped + '；' : '') + '泛化别名不搜：' + meta.aliasDropped.join(' / ')
    if (r.codes.length >= 400) SUB_FULL.note = '线上搜索最多返回 400 部（翻页深度限制），她的线上记录是 ' + r.expect + ' —— 能搜到的已全部排队'
    const local = new Set()
    for (const it of ((DATA && DATA.items) || [])) if (it.code) local.add(bare(it.code))
    for (const it of scrapedVirtualItems()) if (it.code) local.add(bare(it.code))
    const fresh = r.codes.filter(c => !local.has(c))
    SUB_FULL.total = fresh.length
    if (fresh.length && !dry) autoIngestQueue(fresh, '订阅·全量')   // 复用同一条串行队列：不与手动刮削抢资源
  } catch (e) { SUB_FULL.err = (e && e.message) || String(e) }
  finally { SUB_FULL.running = false }
}

/* ---------- 订阅自动检查调度（P1a） ----------
 * 之前订阅检查完全靠前端「重新检查线上」按钮手动触发，没有服务端定时、也没有进度可视化。
 * 现在：服务端按 CFG.subCheckInterval（分钟，默认 60）定时跑 subsFeed(true)，并把
 * 上次/下次检查时间、进度（done/total/current）通过 feed 接口暴露给前端订阅页。 */
function subCheckEnabled() { return CFG.subCheckEnabled !== false }
function subCheckIntervalMin() { const m = parseInt(CFG.subCheckInterval, 10); return isNaN(m) ? 60 : Math.max(5, Math.min(1440, m)) }
const SUB_CHECK = { running: false, lastAt: 0, nextAt: 0, done: 0, total: 0, current: '', startAt: 0 }
async function subCheckRun() {
  if (SUB_CHECK.running) return { ok: false, running: true }
  try { await subsFeed(true, true); return { ok: true, at: SUB_CHECK.lastAt, nextAt: SUB_CHECK.nextAt } }
  catch (e) { return { ok: false, error: e.message } }
}
function subCheckTick() {
  if (subCheckEnabled() === false) return
  if (SUB_CHECK.running) return
  const now = Date.now()
  if (!SUB_CHECK.nextAt) { SUB_CHECK.nextAt = now + 2 * 60 * 1000; return }  // 启动后首次检查延后 2 分钟，避免重启风暴
  if (now < SUB_CHECK.nextAt) return
  subCheckRun().catch(() => {})
}
setInterval(subCheckTick, 60 * 1000)
setTimeout(subCheckTick, 60 * 1000)

/* ---------- 订阅规则过滤（对标 Byte-Muse 的 limit_date + DEFAULT_FILTER）----------
 * 之前 requireSub / requireUncensored / min-maxSizeMb 这些字段在 add / update 里存了下来，
 * 却**从没在判定新作时用过** —— 等于死字段，订阅实际表现就是「抓到啥算啥」。
 * 现在统一在这里接上，并补齐 Byte-Muse 最有价值的一条：limitDate（起始日期门槛），
 * 让「订阅多产女优时被几百部历史作品淹没」这件事有解。
 *
 * 设计：规则没配 = 全放行（向后兼容老订阅），配了才筛。
 * 能筛什么取决于线上影片对象 onlineMovie 实际给了什么：
 *   date(发行日) ✓ / sub(中字) ✓ / magnets(磁力数) ✓ / code+title+maker(关键词) ✓
 *   ✗ 没有体积 —— 所以 min/maxSizeMb 在订阅判定阶段**无法生效**（线上影片不给体积，只有种子才有）。
 */
const UNCENSORED_HINT = /^(fc2|heydouga|heyzo|carib|caribbeancom|1pondo|pacopacomama|10musume|kirari|gachinco|tokyo[-_]?hot|muramura|天然むすめ|パコパコ)/i
function subFilterOk(s, m) {
  if (!s || !m) return true
  /* ① 起始日期门槛：只追这一天之后发行的作品（对应 Byte-Muse 的 limit_date）。
   *    YYYY-MM-DD 字符串比较，字典序 == 日期序。作品没给日期时放行，不误杀。 */
  const ld = String(s.limitDate || '').trim().slice(0, 10)
  if (ld && /^\d{4}-\d{2}-\d{2}$/.test(ld)) {
    const md = String(m.date || '').trim().slice(0, 10)
    if (md && /^\d{4}-\d{2}-\d{2}$/.test(md) && md < ld) return false
  }
  const hay = (String(m.title || '') + ' ' + String(m.code || '') + ' ' + String(m.maker || '')).toLowerCase()
  /* ② 关键词白名单：逗号分隔，命中其一才留 */
  const inc = String(s.include || '').trim()
  if (inc) {
    const ks = inc.split(/[,，]/).map(x => x.trim().toLowerCase()).filter(Boolean)
    if (ks.length && !ks.some(k => hay.indexOf(k) >= 0)) return false
  }
  /* ③ 关键词黑名单：命中任一就丢 */
  const exc = String(s.exclude || '').trim()
  if (exc) {
    const ks = exc.split(/[,，]/).map(x => x.trim().toLowerCase()).filter(Boolean)
    if (ks.some(k => hay.indexOf(k) >= 0)) return false
  }
  /* ④ 只要中字 */
  if (s.requireSub === true && !m.sub) return false
  /* ⑤ 只要无码：线上影片对象没有 uncensored 字段，用番号前缀 / 片商名做启发式判断 */
  if (s.requireUncensored === true) {
    if (!UNCENSORED_HINT.test(String(m.code || '')) && !UNCENSORED_HINT.test(String(m.maker || ''))) return false
  }
  /* ⑥ 至少要有 N 个磁力（线上只给计数不给链接；0 = 不限）—— 零磁力的大多下不到，提前滤掉省事 */
  const mm = Number(s.minMagnets || 0)
  if (mm > 0 && Number(m.magnets || 0) < mm) return false
  return true
}

/* ---------- 榜单订阅（kind='rank'）----------
 * 对标 Byte-Muse 的 RANK_TYPE / RANK_PAGE：它订阅的是 PT 站榜单（种子），我们订阅的是本机
 * 每天自动更新的**女优排行榜**（rankings.json：日/周/月各 100 人）。
 * 语义是「一组女优的合订订阅」——取榜前 N 名，逐个去线上搜她的新作；榜单每天变，覆盖的人跟着变。
 * 数据（rankings.json）和管道（autoIngestQueue 刮削队列）都是现成的，这里只负责把它们接起来。 */
const RANK_LB = { day: '日榜', week: '周榜', month: '月榜' }
function rankBoard(key) {
  try {
    const d = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'))
    const a = Array.isArray(d[key]) ? d[key] : []
    return a.filter(x => x && x.name).sort((x, y) => (Number(x.rank) || 999) - (Number(y.rank) || 999))
  } catch (_) { return [] }
}
function rankTopN(v) { return Math.max(1, Math.min(30, Number(v) || 10)) }   // 上限 30：每人一次搜索，别把线上配额打爆
function rankSubName(board, topN) { return (RANK_LB[board] || '日榜') + ' Top' + rankTopN(topN) }

async function subsFeed(force, auto) {
  if (!force && SUB_FEED.data && Date.now() - SUB_FEED.at < SUB_FEED_TTL) return SUB_FEED.data
  const subs = Array.isArray(CFG.subscriptions) ? CFG.subscriptions : []
  const local = new Set()
  for (const it of ((DATA && DATA.items) || [])) if (it.code) local.add(bare(it.code))
  for (const it of scrapedVirtualItems()) if (it.code) local.add(bare(it.code))
  const all = [], subOut = []
  let firstErr = ''
  if (auto) { SUB_CHECK.running = true; SUB_CHECK.total = subs.length; SUB_CHECK.done = 0; SUB_CHECK.current = ''; subDlRoundStart() }   // 新一轮订阅检查：重置本轮 115 推送额度计数
  /* ⚠ 从这里到 return 的整段必须在 try/finally 里：中途任何异常（旧订阅 name 为空、线上请求抛错、
   * 写盘失败…）若没把 running 复位，SUB_CHECK.running 会永远停在 true —— subCheckTick 与
   * subCheckRun 首行都有 running 判断，于是之后所有定时检查和「立即检查」全被挡死，只能重启进程。
   * 但 data 必须声明在 try 之外：finally 之后还要往它上面挂 subCheck 并 return（写在 try 里会因
   * 块级作用域变成 ReferenceError: data is not defined —— 2026-10-04 实测踩过）。 */
  let data = null
  try {
  for (const s of subs) {
    if (auto) SUB_CHECK.current = s.name
    /* 规则字段一并回传，前端才能在订阅明细上把「这条订阅设了什么条件」显示出来 */
    const rec = { id: s.id, kind: s.kind, name: s.name, query: s.query || s.name, active: s.active !== false, matched: 0, fresh: 0, filtered: 0, onlineId: '', note: '',
      limitDate: s.limitDate || '', include: s.include || '', exclude: s.exclude || '',
      requireSub: !!s.requireSub, requireUncensored: !!s.requireUncensored, minMagnets: Number(s.minMagnets) || 0,
      autoIngest: !!s.autoIngest,   // 明细行的「自动入库」徽章原先取不到这个字段，等于从不显示
      autoDl: s.autoDl === '1',     // 明细行的「自动下载115」徽章：这条订阅开了自动下载才显示
      board: s.board || '', topN: s.kind === 'rank' ? rankTopN(s.topN) : 0 }
    if (!rec.active) { subOut.push(rec); if (auto) SUB_CHECK.done++; continue }
    let movies = []
    try {
      if (s.kind === 'actor') {
        /* ⚠ 2026-10-13：**不能**再用 v2/search?type=movie&q=<女优名>。
         * 那是标题模糊搜索 —— 实测搜「葵司」返回的是松嶋葵／藤咲葵／葵百合香甚至无关国产片，
         * 一部她的都没有（它把名字拆成「葵」去匹配标题）。用户报的「自动订阅老是下载不相干的、
         * 根本没有该女优的影片」就是它。正确来源是网页版演员页 /actors/<id>（每页 40 部、按发行日期倒序）。
         * 锁人：订阅填了 JavDB 代号就用它；否则 onlineActorExact 精确匹配，认不出就**跳过这条订阅**
         * ——宁可什么都不收，也不能把别人的片子收进来。 */
        let aid = String(s.actorId || '').trim()
        if (!aid) {
          const a = await onlineActorExact(s.name).catch(() => null)
          if (a && a.id) aid = a.id
        }
        if (!aid) {
          rec.note = '线上没有同名女优，已跳过（避免抓到别人的片子；订阅里可直接贴她的 JavDB 女优页链接）'
          movies = []
        } else {
          rec.onlineId = aid
          try {
            /* 只取第 1 页就够：演员页按发行日期倒序、一页 40 部，追「新作」绰绰有余，
             * 而且比原来 app 搜索拉 2 页还省请求。 */
            const r = await jdbActorMoviesPage(aid, 1, '0', '')
            movies = r.movies || []
          } catch (e) {
            rec.note = '演员页抓取失败：' + ((e && e.message) || '未知错误')
            movies = []
          }
        }
      } else if (s.kind === 'rank') {
        /* 榜单：读本机榜单 → 取前 N 名 → 每人抓一次演员页第 1 页（40 部，按发行日期倒序）。
         * ⚠ 2026-10-13：原先这里是 v2/search?type=movie&q=<女优名> 标题模糊搜索，和 actor 订阅
         * 犯的是同一个错 —— 榜上第 3 名是「葵司」时，搜回来的可能是松嶋葵／藤咲葵的片子。
         * 现在先精确锁 id 再抓演员页；锁不到就跳过这个人（不拿名字去瞎搜）。
         * 请求量没变（每人 1 次），只是从 app 搜索换成网页版演员页。
         * 记下 _actress，前端才能在列表里显示「这是谁的作品」（榜名只能说明来源）。 */
        const board = rankBoard(s.board || 'day')
        const topN = rankTopN(s.topN)
        const rows = board.slice(0, topN)
        rec.checked = rows.length
        if (!board.length) rec.note = '本机还没有榜单数据（排行榜每天自动更新，也可去「排行榜」页面手动刷新）'
        const acc = []
        const skipped = []
        for (const row of rows) {
          const nm = String(row.name || '').trim()
          if (!nm) continue
          let aid = ''
          try { const a = await onlineActorExact(nm); if (a && a.id) aid = a.id } catch (_) {}
          if (!aid) { skipped.push(nm); continue }
          try {
            const r = await jdbActorMoviesPage(aid, 1, '0', '')
            for (const x of (r.movies || [])) acc.push(Object.assign({}, x, { _actress: nm }))
          } catch (e) { skipped.push(nm) }
        }
        if (skipped.length) rec.note = '这几位在线上没能精确匹配到，已跳过：' + skipped.join('、')
        movies = acc
      } else {
        const j = await onlineGet('v2/search?q=' + encodeURIComponent(rec.query) + '&type=movie&page=1')
        movies = (((j || {}).data || {}).movies || []).map(onlineMovie)
      }
    } catch (e) {
      rec.note = e.message; firstErr = firstErr || e.message
      subOut.push(rec); if (auto) SUB_CHECK.done++; continue
    }
    rec.matched = movies.length
    const seen = new Set()
    for (const m of movies) {
      const b = bare(m.code)
      if (!b || seen.has(b)) continue
      seen.add(b)
      if (local.has(b) || m.inLibrary) continue
      /* 订阅规则过滤：不满足「起始日期 / 关键词 / 中字 / 无码 / 最少磁力」的不算新作、也不进列表。
       * 注意只作用于日常检查；「⇄ 补全全部作品」是主动补历史，不受 limitDate 限制。 */
      if (!subFilterOk(s, m)) { rec.filtered++; continue }
      rec.fresh++
      /* 榜单订阅多带一个女优名：列表里显示「订阅 日榜Top10 · 凪沢ひかる」，否则看不出是谁的作品 */
      all.push(Object.assign({}, m, { subId: s.id, subKind: s.kind, subName: m._actress ? s.name + ' · ' + m._actress : s.name }))
    }
    s.lastCheckedAt = new Date().toISOString()
    subOut.push(rec); if (auto) SUB_CHECK.done++
  }
  const uniq = new Map()
  for (const x of all) {
    const k = bare(x.code)
    if (!uniq.has(k)) uniq.set(k, x)
    else if (!uniq.get(k).subName.includes(x.subName)) uniq.get(k).subName += ' / ' + x.subName
  }
  const items = [...uniq.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  /* 自动入库：开了开关的订阅 → 把这批新作的番号排进后台刮削队列（默认一条都不会自动入） */
  /* 自动入库 / 自动下载（115）：开了其中任一个开关的订阅，把它的新作番号排进后台刮削队列。
   * 自动入库 = 刮完把元数据落进本地库；自动下载 = 刮完拿到磁力再推 115（需全局总开关 + 这条订阅开 autoDl）。
   * 两个都靠「先刮削」：不刮就拿不到磁力，所以开了 autoDl 也得进队列刮一遍（元数据顺带落库，符合「下载到自己库」的预期）。
   * 来源订阅 id 一并带进队列（q.sub[code]=subId），刮完后据此判断要不要推 115。 */
  for (const s of subs) {
    if (s.active === false) continue
    if (s.autoIngest !== true && s.autoDl !== '1') continue
    const codes = items.filter(x => x.subId === s.id && x.code).map(x => x.code)
    if (codes.length) autoIngestQueue(codes, '订阅', false, s.id)
  }
  const oc = onlineCfg()
  data = {
    ok: true, at: Date.now(), items, subs: subOut, error: firstErr,
    online: { enabled: oc.enabled, lines: oc.lines, active: JDB_LINE_OK,
      reachable: JDB_PROBE.at ? JDB_PROBE.reachable : !!JDB_LINE_OK,
      probe: JDB_PROBE.probe || [], at: JDB_PROBE.at || 0 },
    stats: { subs: subs.length, active: subs.filter(x => x.active !== false).length, fresh: items.length, local: local.size },
    autoIngest: { running: AUTO_INGEST.running, pending: AUTO_INGEST.queue.length, done: AUTO_INGEST.done, total: AUTO_INGEST.total, current: AUTO_INGEST.current, ok: AUTO_INGEST.ok, fail: AUTO_INGEST.fail },
    /* 订阅自动下载（115）实时状态：开关是否生效、单次检查额度、本轮已推/成功/失败/超额度跳过、最近 30 条明细。
     * 前端订阅页调度面板读这个展示「本轮推了多少、有没有超额度」。 */
    subAutoDl: { on: subDlOn(), max: subDlMax(), round: SUB_DL.round, pushed: Object.keys(SUB_DL.pushed).length,
      filter: { excludeUhd: CFG.subDlExcludeUhd !== '', onlyUhd: CFG.subDlOnlyUhd === '1', onlyChinese: CFG.subDlOnlyChinese === '1', onlyUc: CFG.subDlOnlyUc === '1', excludeUc: CFG.subDlExcludeUc === '1', onlyBreak: CFG.subDlOnlyBreak === '1', excludeBreak: CFG.subDlExcludeBreak === '1', includeKw: CFG.subDlIncludeKw || '', excludeKw: CFG.subDlExcludeKw || '', minSize: CFG.subDlMinSize || '', maxSize: CFG.subDlMaxSize || '' } },
    subFull: Object.assign({ on: subsFullOn() }, SUB_FULL)
  }
  /* P1a：自动检查结束 → 先落定 SUB_CHECK 终态（lastAt/nextAt/running），再快照进 feed，
   * 否则缓存的 feed 会停留在「running=true、lastAt/nextAt=0」的中间态，前端永远显示「检查中」。 */
  } finally {
    /* 无论上面是正常跑完还是抛异常，都要落定终态并复位 running（异常时也要把 nextAt 推后，
     * 否则异常会被定时器一分钟内反复触发）。 */
    try {
      if (auto) {
        SUB_CHECK.lastAt = Date.now()
        SUB_CHECK.nextAt = Date.now() + subCheckIntervalMin() * 60000
        SUB_CHECK.running = false
        SUB_CHECK.current = ''
      }
    } catch (_) {}
  }
  data.subCheck = { enabled: subCheckEnabled(), intervalMin: subCheckIntervalMin(), running: SUB_CHECK.running, lastAt: SUB_CHECK.lastAt, nextAt: SUB_CHECK.nextAt, done: SUB_CHECK.done, total: SUB_CHECK.total, current: SUB_CHECK.current,
    subAutoDl: CFG.subAutoDl === '1', subAutoDlMax: subDlMax(),
    subAutoDlFilter: { excludeUhd: CFG.subDlExcludeUhd !== '', onlyUhd: CFG.subDlOnlyUhd === '1', onlyChinese: CFG.subDlOnlyChinese === '1', onlyUc: CFG.subDlOnlyUc === '1', excludeUc: CFG.subDlExcludeUc === '1', onlyBreak: CFG.subDlOnlyBreak === '1', excludeBreak: CFG.subDlExcludeBreak === '1', includeKw: CFG.subDlIncludeKw || '', excludeKw: CFG.subDlExcludeKw || '', minSize: CFG.subDlMinSize || '', maxSize: CFG.subDlMaxSize || '' } }   // 全局总开关 + 单次额度上限 + 质量过滤：调度面板读这个
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
      rankAuto: CFG.rankAuto !== false,
      rankHour: rankHour(), rankUpdatedAt: rankUpdatedAt(), rankRunning: RANKUP.running,
      autoScrapeNew: CFG.autoScrapeNew !== false,
      /* 网盘片源分辨率探测（默认开）：云盘条目走本机代理 ffprobe 读 moov 头拿宽高，
       * 没有它云盘片永远没有分辨率 → 不显示、筛不了、排不了 */
      probeNetRes: CFG.probeNetRes !== false, netResRun: NETRES_RUN, netResStats: NETRES_STATS,
      autoAvatar: CFG.autoAvatar !== false,
      auto115Watch: CFG.auto115Watch !== false,
      autoAvatarRunning: AVA_BACKFILL_RUNNING, autoAvatarStats: AVA_BACKFILL_STATS,
      /* 默认开：设置里「媒体库每日自动重扫」开关默认开启，只有显式 false 才算关 */
      autoRescan: CFG.autoRescan !== false, autoRescanHour: autoRescanHour(), autoRescanLast: autoRescanLast(),
      /* 入库最小体积（MB，字符串；空 = 不过滤）。扫盘时小于它的视频不进影片库 */
      scanMinMb: CFG.scanMinMb || '',
      subCheckEnabled: CFG.subCheckEnabled !== false, subCheckInterval: subCheckIntervalMin(), subCheckRunning: SUB_CHECK.running, subCheckLast: SUB_CHECK.lastAt, subCheckNext: SUB_CHECK.nextAt,
      subAutoDl: CFG.subAutoDl === '1', subAutoDlMax: subDlMax(),
      subDlExcludeUhd: CFG.subDlExcludeUhd !== '', subDlOnlyUhd: CFG.subDlOnlyUhd === '1',
      subDlOnlyChinese: CFG.subDlOnlyChinese === '1', subDlOnlyUc: CFG.subDlOnlyUc === '1', subDlExcludeUc: CFG.subDlExcludeUc === '1',
      subDlOnlyBreak: CFG.subDlOnlyBreak === '1', subDlExcludeBreak: CFG.subDlExcludeBreak === '1',
      subDlIncludeKw: CFG.subDlIncludeKw || '', subDlExcludeKw: CFG.subDlExcludeKw || '',
      subDlMinSize: CFG.subDlMinSize || '', subDlMaxSize: CFG.subDlMaxSize || '',
      accessOn: !!ACCESS_CODE(),
      mounts: containerMounts(), mediaRoot: MEDIA_ROOT,
      sourceNames: CFG.sourceNames || {}
    })
    /* 媒体源显示名（添加页卡片标题）：{ local: '本地存储', pan115: '115 网盘' }，可自定义 */
    if ('sourceNames' in body) {
      const sn = (body.sourceNames && typeof body.sourceNames === 'object') ? body.sourceNames : {}
      CFG.sourceNames = {
        local: String(sn.local || '').trim().slice(0, 30),
        pan115: String(sn.pan115 || '').trim().slice(0, 30)
      }
      SRC_CACHE = { at: 0, data: null }   // 名字变了，来源统计缓存作废（下次拉取重算）
    }
    // 各字段独立保存：body 里带哪个就更新哪个，互不覆盖
    if ('autoScrapeNew' in body) CFG.autoScrapeNew = !!body.autoScrapeNew
    /* 网盘片源分辨率探测：打开开关立刻补跑一轮（不然要等下次扫描/重启才见效） */
    if ('probeNetRes' in body) {
      CFG.probeNetRes = !!body.probeNetRes
      if (CFG.probeNetRes) setTimeout(() => { resBackfillRun('开关').catch(() => {}) }, 800)
      else console.log('[res] 已关闭网盘片源分辨率探测（已有标签保留）')
    }
    if ('autoAvatar' in body) {
      CFG.autoAvatar = !!body.autoAvatar
      if (!CFG.autoAvatar) AVA_BACKFILL_RUNNING = false   // 关开关 → 立即叫停进行中的预取
    }
    if ('autoRescan' in body) CFG.autoRescan = !!body.autoRescan
    if ('auto115Watch' in body) CFG.auto115Watch = !!body.auto115Watch
    if ('autoRescanHour' in body) CFG.autoRescanHour = Math.max(0, Math.min(23, parseInt(body.autoRescanHour, 10) || 0))
    /* 入库最小体积（MB）：只存字符串，真正的换算在 scanMinBytes()（扫描时按 1024 进制算一次） */
    if ('scanMinMb' in body) CFG.scanMinMb = String(body.scanMinMb === null || body.scanMinMb === undefined ? '' : body.scanMinMb).trim().slice(0, 12)
    if ('rankAuto' in body) CFG.rankAuto = !!body.rankAuto
    if ('rankHour' in body) CFG.rankHour = Math.max(0, Math.min(23, parseInt(body.rankHour, 10) || 0))
    if ('subCheckEnabled' in body) CFG.subCheckEnabled = !!body.subCheckEnabled
    if ('subCheckInterval' in body) CFG.subCheckInterval = Math.max(5, Math.min(1440, parseInt(body.subCheckInterval, 10) || 60))
    if ('subAutoDl' in body) CFG.subAutoDl = body.subAutoDl ? '1' : ''   // 全局总开关：默认关（字符串 '1' 表示开）。关着时所有订阅的自动下载都不生效
    if ('subAutoDlMax' in body) CFG.subAutoDlMax = Math.max(1, Math.min(200, parseInt(body.subAutoDlMax, 10) || 20))   // 单次订阅检查最多推多少部（防灌爆 115 离线配额）
    /* 订阅自动下载（115）的质量过滤：对标 Byte-Muse DEFAULT_FILTER，作用在「同一步片子的多条磁力」上 */
    if ('subDlExcludeUhd' in body) CFG.subDlExcludeUhd = body.subDlExcludeUhd ? '1' : ''   // 排除 4K/UHD（默认开，和 Byte-Muse exclude_uhd:true 一致）
    if ('subDlOnlyUhd' in body) CFG.subDlOnlyUhd = body.subDlOnlyUhd ? '1' : ''
    if ('subDlOnlyChinese' in body) CFG.subDlOnlyChinese = body.subDlOnlyChinese ? '1' : ''
    if ('subDlOnlyUc' in body) CFG.subDlOnlyUc = body.subDlOnlyUc ? '1' : ''
    if ('subDlExcludeUc' in body) CFG.subDlExcludeUc = body.subDlExcludeUc ? '1' : ''
    if ('subDlOnlyBreak' in body) CFG.subDlOnlyBreak = body.subDlOnlyBreak ? '1' : ''      // 只要破解/流出
    if ('subDlExcludeBreak' in body) CFG.subDlExcludeBreak = body.subDlExcludeBreak ? '1' : ''   // 排除破解/流出
    if ('subDlIncludeKw' in body) CFG.subDlIncludeKw = String(body.subDlIncludeKw || '').slice(0, 200)
    if ('subDlExcludeKw' in body) CFG.subDlExcludeKw = String(body.subDlExcludeKw || '').slice(0, 200)
    if ('subDlMinSize' in body) CFG.subDlMinSize = String(body.subDlMinSize || '').trim()
    if ('subDlMaxSize' in body) CFG.subDlMaxSize = String(body.subDlMaxSize || '').trim()
    if ('proxy' in body) {
      const pv = String(body.proxy || '').trim()
      if (pv && !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(pv)) return json(res, { ok: false, error: '代理格式应为 http://host:port，留空表示直连' })
      CFG.proxy = pv
      proxyAgents.clear()   // 让下一次请求立即使用新代理
      AVA_ONLINE_FAIL.clear()   // 代理地址变了 → 头像负缓存作废，允许立刻重试
    }
    if ('proxyEnabled' in body) {
      CFG.proxyEnabled = !!body.proxyEnabled
      proxyAgents.clear()
      AVA_ONLINE_FAIL.clear()   // 代理开关变了 → 头像负缓存作废，允许立刻用新链路重试
    }
    if ('githubToken' in body) {   // GitHub PAT：私有仓库的 relay/ 中转数据经 Contents API 读取
      CFG.githubToken = String(body.githubToken || '').trim()
      relayCache.clear()
    }
    if ('cacheDir' in body) {
      const cd = String(body.cacheDir || '').trim()
      /* 绝对路径校验（2026-10-15 修）：以前只认 '/…'（容器路径），Windows 版填 D:\JavPacoData
       * 会被判成「不是绝对路径」—— 离线数据目录在 Windows 上根本改不了。现在盘符路径也认。 */
      const abs = /^\//.test(cd) || /^[A-Za-z]:[\\/]/.test(cd) || /^\\\\/.test(cd)
      if (cd && !abs) return json(res, { ok: false, error: '请填写绝对路径（Windows 如 D:\\JavPacoData，容器如 /media/cache），留空用默认 cache/' })
      if (cd && fs.existsSync(path.join(path.resolve(cd), 'server-config.json'))) {
        return json(res, { ok: false, error: '这个目录是程序目录（里面有 server-config.json），不能当离线数据目录' })
      }
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
      autoScrapeNew: CFG.autoScrapeNew !== false,
      autoRescan: CFG.autoRescan !== false, autoRescanHour: autoRescanHour(), autoRescanLast: autoRescanLast(),
      rankAuto: CFG.rankAuto !== false, rankHour: rankHour(),
      rankUpdatedAt: rankUpdatedAt(), rankRunning: RANKUP.running,
      subCheckEnabled: CFG.subCheckEnabled !== false, subCheckInterval: subCheckIntervalMin(), subCheckRunning: SUB_CHECK.running, subCheckLast: SUB_CHECK.lastAt, subCheckNext: SUB_CHECK.nextAt,
      subAutoDl: CFG.subAutoDl === '1', subAutoDlMax: subDlMax(),
      subDlExcludeUhd: CFG.subDlExcludeUhd !== '', subDlOnlyUhd: CFG.subDlOnlyUhd === '1',
      subDlOnlyChinese: CFG.subDlOnlyChinese === '1', subDlOnlyUc: CFG.subDlOnlyUc === '1', subDlExcludeUc: CFG.subDlExcludeUc === '1',
      subDlOnlyBreak: CFG.subDlOnlyBreak === '1', subDlExcludeBreak: CFG.subDlExcludeBreak === '1',
      subDlIncludeKw: CFG.subDlIncludeKw || '', subDlExcludeKw: CFG.subDlExcludeKw || '',
      subDlMinSize: CFG.subDlMinSize || '', subDlMaxSize: CFG.subDlMaxSize || ''
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
    if (req.method === 'GET') {
      const oc = onlineCfg()
      /* 本地写法反查：同一 JavDB 代号在库里的写法可能和线上官方名不同
       * （「新井リマ」vs 官方「新井莉麻」、「坂道みる」vs「坂道美琉」），
       * 把库内所有指向同一代号的名字一并带回去 —— 女优页 / 女优列表才能认出「已订阅」。 */
      /* ⚠ 变量名不能叫 subs —— 外层 const subs 是「取订阅数组」的函数，
       *    同名 let 会在同一作用域里触发 TDZ（Cannot access 'subs' before initialization）。 */
      let subsOut = subs()
      try {
        const M = jdbCodeMap(), byCode = {}
        for (const k of Object.keys(M)) {
          const id = (M[k] || {}).id
          if (!id) continue
          ;(byCode[id] = byCode[id] || []).push(k)
        }
        subsOut = subsOut.map(s => {
          const locals = (s.kind === 'actor' && s.actorId && byCode[s.actorId]) ? byCode[s.actorId].slice(0, 20) : []
          return locals.length ? Object.assign({}, s, { locals }) : s
        })
      } catch (_) {}
      return json(res, {
        /* online 必须带 reachable / probe：订阅页页头那个「JavDB 通不通」的小方块只读这里，
         * 少了这两个字段它会永远显示「不通」。探测不在这里发（太慢），读 JDB_PROBE 缓存；
         * 一次都没探过时退化为「JDB_LINE_OK 非空 = 至少有一条线路成功过」。 */
        ok: true, subs: subsOut,
        online: { enabled: oc.enabled, lines: oc.lines, active: JDB_LINE_OK,
          reachable: JDB_PROBE.at ? JDB_PROBE.reachable : !!JDB_LINE_OK,
          probe: JDB_PROBE.probe || [], at: JDB_PROBE.at || 0, error: JDB_PROBE.error || '' },
        full: Object.assign({ on: subsFullOn() }, SUB_FULL),     // 全量入库开关 + 当前进度（前端订阅页展示）
        blacklist: Array.isArray(CFG.subBlacklist) ? CFG.subBlacklist : []   // P1b：取消订阅后自动进这里，避免被重新订阅
      })
    }
    const action = String(body.action || '')
    const list = subs().slice()
    if (action === 'add') {
      /* maker = 片商：没有专属作品端点，和 series 一样走 v2/search 关键词匹配 */
      const kind = ['actor', 'series', 'maker', 'code', 'rank'].includes(body.kind) ? body.kind : 'actor'
      /* 榜单订阅：对象不是「名字」而是「哪个榜 + 前几名」，名字自动生成（如「日榜 Top10」）。
       * 用户仍可自己填名字覆盖（比如「想追的周榜前五」）。 */
      const board = kind === 'rank' ? (['day', 'week', 'month'].includes(body.board) ? body.board : 'day') : ''
      const topN = kind === 'rank' ? rankTopN(body.topN) : 0
      let name = String(body.name || '').trim()
      if (kind === 'rank' && !name) name = rankSubName(board, topN)
      const query = String(body.query || name).trim()
      if (!name) return json(res, { ok: false, error: '请填写订阅对象' })
      /* 女优订阅锁人三级跳（onlineActorSmartResolve）：
       * ① JavDB 代号/链接（如 A5yq）→ ② 库内代号缓存按名字命中 → ③ 退回普通名字订阅。
       * 命中 → 订阅名统一成线上官方主名 + 记下 actorId，全量抓取按 id 锁人。 */
      let actorId = ''
      let viaCode = false
      let hit = null
      if (kind === 'actor') {
        hit = await onlineActorSmartResolve(String(body.actorId || '').trim() || name).catch(() => null)
        if (hit) { actorId = hit.code; name = hit.actor.name; viaCode = true }
      }
      if (list.some(x => (actorId && x.actorId === actorId) || (x.kind === kind && String(x.name) === name))) return json(res, { ok: true, subs: list, dup: true })
      /* P1b：被「取消订阅」时会进黑名单，避免重复订阅同一条（例如未来支持父订阅/分享码导入后，删了又回来） */
      const bl0 = Array.isArray(CFG.subBlacklist) ? CFG.subBlacklist : []
      const bk1 = actorId ? 'actor:' + actorId : null
      /* 榜单用「rank:{榜}」做 key 而不是名字：名字里带 TopN，改了人数就会被当成另一条订阅 */
      const bk2 = kind === 'rank' ? 'rank:' + board : kind + ':' + name.trim().toLowerCase()
      if (bl0.some(b => (bk1 && b.key === bk1) || b.key === bk2)) {
        return json(res, { ok: false, blacklisted: true, error: '这条在「不再订阅」名单里，无法重复添加（去「我的订阅」底部移出名单即可）' })
      }
      const rec = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind, name, query: viaCode ? name : query, actorId,
        board: kind === 'rank' ? board : '', topN,
        videosCount: viaCode ? (Number(((hit || {}).actor || {}).videos_count) || 0) : 0,
        quality: String(body.quality || ''), requireSub: !!body.requireSub, requireUncensored: !!body.requireUncensored,
        minSizeMb: Number(body.minSizeMb) || 0, maxSizeMb: Number(body.maxSizeMb) || 0,
        /* 订阅规则（对标 Byte-Muse 的 limit_date + DEFAULT_FILTER）：
         *   limitDate 只追该日期之后发行的；include/exclude 关键词（逗号分隔）；minMagnets 最少磁力数。
         *   注：requireSub / requireUncensored 是早就有的字段，这次才真正接上过滤（见 subFilterOk）。 */
        limitDate: String(body.limitDate || '').trim().slice(0, 10),
        include: String(body.include || '').trim().slice(0, 200),
        exclude: String(body.exclude || '').trim().slice(0, 200),
        minMagnets: Number(body.minMagnets) || 0,
        autoIngest: !!body.autoIngest,      // 自动入库：默认关。开了才会把该订阅的线上新作自动刮进离线数据
        autoDl: body.autoDl ? '1' : '',     // 订阅自动下载到 115：默认关。开了且该订阅下确有新作刮完，会把最佳磁力推到 115 离线下载（还需全局总开关）
        note: String(body.note || '').slice(0, 300),
        active: true, createdAt: new Date().toISOString(), lastCheckedAt: ''
      }
      list.push(rec); CFG.subscriptions = list; writeCfg(); SUB_FEED = { at: 0, data: null }
      /* 订阅女优 + 开关开着 → 立刻去线上把她的全部作品翻页拉全，排队刮进离线数据（不等订阅页刷新） */
      const fullGrab = kind === 'actor' && subsFullOn()
      if (fullGrab) subsFullRun(rec).catch(() => {})
      return json(res, { ok: true, subs: list, added: rec, fullGrab })
    }
    if (action === 'remove') {
      const id = String(body.id || '')
      const target = list.find(x => x.id === id)
      if (!target) return json(res, { ok: true, subs: CFG.subscriptions })
      /* P1b：取消订阅同时进黑名单，避免被（未来的）父订阅 / 导入重新拉回来 */
      const bl = Array.isArray(CFG.subBlacklist) ? CFG.subBlacklist.slice() : []
      const bk = (target.kind === 'actor' && target.actorId) ? 'actor:' + target.actorId
        : (target.kind === 'rank' && target.board) ? 'rank:' + target.board
          : target.kind + ':' + String(target.name || '').trim().toLowerCase()
      if (!bl.some(b => b.key === bk)) bl.push({ key: bk, kind: target.kind, name: target.name, actorId: target.actorId || '', at: new Date().toISOString() })
      CFG.subBlacklist = bl
      CFG.subscriptions = list.filter(x => x.id !== id)
      writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: CFG.subscriptions, blacklisted: target.name })
    }
    /* P1b：黑名单管理 */
    if (action === 'blacklist-remove') {
      const key = String(body.key || '')
      CFG.subBlacklist = (Array.isArray(CFG.subBlacklist) ? CFG.subBlacklist : []).filter(b => b.key !== key)
      writeCfg()
      return json(res, { ok: true, blacklist: CFG.subBlacklist })
    }
    if (action === 'blacklist-clear') {
      CFG.subBlacklist = []
      writeCfg()
      return json(res, { ok: true, blacklist: [] })
    }
    /* P1a：立即触发一次订阅检查（计入自动调度，会重置下次检查时间） */
    if (action === 'check-now') {
      const r = await subCheckRun()
      return json(res, r)
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
      if (body.kind !== undefined && ['actor', 'series', 'maker', 'code', 'rank'].includes(body.kind)) patch.kind = body.kind
      /* 榜单订阅改「哪个榜 / 前几名」：没同时给新名字 → 名字跟着重新生成（如 日榜 Top10 → 周榜 Top5） */
      const curRec = list.find(x => x.id === id) || {}
      if ((patch.kind || curRec.kind) === 'rank') {
        if (body.board !== undefined && ['day', 'week', 'month'].includes(body.board)) patch.board = body.board
        if (body.topN !== undefined) patch.topN = rankTopN(body.topN)
        if ((patch.board || patch.topN) && body.name === undefined) {
          patch.name = rankSubName(patch.board || curRec.board || 'day', patch.topN || curRec.topN || 10)
          patch.query = patch.name
        }
      }
      ;['name', 'query', 'quality', 'note'].forEach(k => { if (body[k] !== undefined) patch[k] = String(body[k]) })
      /* 编辑女优订阅时把名字换成 JavDB 代号/链接（或库内已回填过代号的名字）→ 按 id 锁人。
       * ⚠ 名字改成非代号时必须**清空** actorId —— 残留旧代号会让全量抓取按旧人锁定，
       * 而搜索词又来自新名字，两拨人的作品会混在一起（实测踩过：A5yq 改成三上悠亜后代号没清）。 */
      if ((patch.kind || (list.find(x => x.id === id) || {}).kind) === 'actor' && patch.name !== undefined) {
        const hit2 = await onlineActorSmartResolve(patch.name).catch(() => null)
        if (hit2) {
          patch.name = hit2.actor.name
          patch.actorId = hit2.code
          if (body.query === undefined) patch.query = patch.name
          patch.videosCount = Number(hit2.actor.videos_count) || 0
        } else {
          patch.actorId = ''
          patch.videosCount = 0
        }
      }
      ;['requireSub', 'requireUncensored', 'autoIngest'].forEach(k => { if (body[k] !== undefined) patch[k] = !!body[k] })
      if (body.autoDl !== undefined) patch.autoDl = body.autoDl ? '1' : ''   // 订阅自动下载到 115 的开关（字符串 '1' / 空）
      ;['minSizeMb', 'maxSizeMb'].forEach(k => { if (body[k] !== undefined) patch[k] = Number(body[k]) || 0 })
      /* 订阅规则（起始日期 / 关键词 / 最少磁力）—— 全部留空即恢复「全放行」 */
      ;['include', 'exclude'].forEach(k => { if (body[k] !== undefined) patch[k] = String(body[k]).trim().slice(0, 200) })
      if (body.limitDate !== undefined) patch.limitDate = String(body.limitDate).trim().slice(0, 10)
      if (body.minMagnets !== undefined) patch.minMagnets = Number(body.minMagnets) || 0
      CFG.subscriptions = list.map(x => x.id === id ? Object.assign({}, x, patch) : x)
      writeCfg(); SUB_FEED = { at: 0, data: null }
      return json(res, { ok: true, subs: CFG.subscriptions })
    }
    /* 手动对一个「已订阅」的女优补全全部作品（开关是自动触发，这条是补课入口） */
    if (action === 'full') {
      const id = String(body.id || '')
      const s = list.find(x => x.id === id)
      if (!s) return json(res, { ok: false, error: '订阅不存在' })
      if (s.kind !== 'actor') return json(res, { ok: false, error: '只有「女优」订阅支持全量拉取' })
      if (SUB_FULL.running) return json(res, { ok: false, error: '已有全量任务在跑：' + (SUB_FULL.name || '') })
      subsFullRun(s, { dry: !!body.dry }).catch(() => {})
      return json(res, { ok: true, started: true, name: s.name, dry: !!body.dry })
    }
    if (action === 'feed-reset') { SUB_FEED = { at: 0, data: null }; return json(res, { ok: true }) }
    return json(res, { ok: false, error: '未知操作：' + action })
  }
  /* 库内女优 JavDB 代号：GET 查 map+进度；POST start/stop/clear/one（one = 单个即时补查） */
  if (p === '/api/jdbcodes') {
    if (req.method === 'GET') return json(res, { ok: true, map: jdbCodeMap(), status: JDBCODE })
    const act = String(body.action || '')
    if (act === 'start') { jdbCodeBackfill({ mode: body.mode === 'roster' ? 'roster' : 'lib', phase: 2 }).catch(() => {}); return json(res, { ok: true, started: true, status: JDBCODE }) }
    /* 全名册回填（2.5 万人）：先快扫再精查，内部自适应限速 + 断点续跑 */
    if (act === 'start-all') { jdbCodeRunAll().catch(() => {}); return json(res, { ok: true, started: true, status: JDBCODE }) }
    if (act === 'stop') { JDBCODE.stop = true; RATE.on = false; return json(res, { ok: true }) }
    if (act === 'clear') { JDB_CODES = {}; jdbCodeSave(); return json(res, { ok: true }) }
    if (act === 'retry-miss') {   // 清掉 miss 记录后精查一轮（匹配规则升级 / 想复查时用）
      const M = jdbCodeMap()
      for (const k of Object.keys(M)) if (!M[k].id) delete M[k]
      jdbCodeSave()
      jdbCodeBackfill({ mode: (JDB_RUN.mode === 'roster' || body.mode === 'roster') ? 'roster' : 'lib', phase: 2 }).catch(() => {})
      return json(res, { ok: true, started: true, status: JDBCODE })
    }
    if (act === 'one') {
      const name = String(body.name || '').trim()
      if (!name) return json(res, { ok: false, error: '缺少 name' })
      const a = await onlineActorExact(name).catch(() => null)
      const M = jdbCodeMap()
      if (a && a.id) { M[name] = { id: a.id, name: a.name, videos_count: Number(a.videos_count) || 0, at: Date.now() }; jdbCodeSave() }
      return json(res, { ok: true, hit: !!(a && a.id), code: a ? a.id : '', name: a ? a.name : '', videos_count: (a && a.videos_count) || 0 })
    }
    return json(res, { ok: false, error: '未知操作：' + act })
  }
  /* ---------- 女优「有码 / 无码」判定（JavDB 作品番号，2026-10-07） ----------
   * 背景：minnano 名册的 type 字段不可靠 —— 24959 位里只有 5 位标 uncensored，
   * 而那 5 位在 minnano 上又都是普通 actress 页（疑似分类标错）。演员页要按
   * 「有码/无码」分 tab，靠名册字段只会分出个几乎空的页。
   * 判据：JavDB 上这位女优的作品里有没有 **n 前缀的无码番号**（n1011/n1448…）。
   * 纯有码演员（葵司/白石茉莉奈…）各页都是 0，混合演员（桜井怜奈）能扫出 n 番号。
   * 只判「影片库里出现过的女优」——全量 2.5 万人打 JavDB 成本太高，不值当。
   * 结果落 cache/jdb-uncensored.json：{ 名字: {uc:bool, actor:id, n:番号样本[], at} }。 */
  const JDB_UC_FILE = () => path.join(cacheDir(), 'jdb-uncensored.json')
  const JDB_UC_RE = /^n\d+$/i
  let JDB_UC = null, JDB_UC_RUN = { on: false, stop: false, done: 0, total: 0, phase: '' }
  function jdbUcMap() {
    if (JDB_UC) return JDB_UC
    try { JDB_UC = JSON.parse(fs.readFileSync(JDB_UC_FILE(), 'utf8')) || {} } catch (_) { JDB_UC = {} }
    return JDB_UC
  }
  function jdbUcSave() { try { fs.writeFileSync(JDB_UC_FILE(), JSON.stringify(JDB_UC || {})) } catch (_) {} }
  /* 判一位女优是否拍过无码：搜她名字 → 作品列表里找 n 番号（翻 3 页，够了；
   * 476 部的葵司实测三页全 0，混合演员第一页就能扫出来）。 */
  async function jdbUncensoredOf(name) {
    const n = onNorm(name)
    if (!n) return null
    const hits = []
    for (let page = 1; page <= 3; page++) {
      const j = await onlineGetPaced('v2/search?q=' + encodeURIComponent(name) + '&type=movie&page=' + page + '&limit=50').catch(() => null)
      const list = ((j || {}).data || {}).movies || []
      if (!list.length) break
      for (const m of list) {
        const num = String(m.number || m.code || '')
        if (JDB_UC_RE.test(num) && hits.indexOf(num) < 0) hits.push(num)
      }
      if (hits.length >= 12) break              // 够判定了，不用继续翻
    }
    return hits
  }
  async function jdbUcBackfill() {
    if (JDB_UC_RUN.on) return
    const targets = jdbCodeTargets().filter(jdbNamePlausible)
    const M = jdbUcMap()
    JDB_UC_RUN = { on: true, stop: false, done: 0, total: targets.length, phase: '查 JavDB 作品番号' }
    RATE.on = true
    try {
      for (const name of targets) {
        if (JDB_UC_RUN.stop) { JDB_UC_RUN.phase = '已停止'; break }
        JDB_UC_RUN.phase = '查 ' + name
        try {
          const hits = await jdbUncensoredOf(name)
          if (hits) M[name] = { uc: hits.length > 0, n: hits.slice(0, 8), at: Date.now() }
        } catch (e) {}
        jdbUcSave()
        JDB_UC_RUN.done++
      }
    } finally { RATE.on = false; JDB_UC_RUN.on = false; JDB_UC_RUN.phase = JDB_UC_RUN.phase === '已停止' ? '已停止' : '完成' }
  }
  if (p === '/api/jdbcuncensored') {
    if (req.method === 'GET') {
      const M = jdbUcMap()
      const known = Object.keys(M).length
      const uc = Object.keys(M).filter(k => M[k] && M[k].uc).length
      return json(res, { ok: true, map: M, status: { ...JDB_UC_RUN, known, uncensored: uc } })
    }
    const act = String(body.action || '')
    if (act === 'start') { jdbUcBackfill().catch(() => {}); return json(res, { ok: true, started: true }) }
    if (act === 'stop') { JDB_UC_RUN.stop = true; RATE.on = false; return json(res, { ok: true }) }
    if (act === 'clear') { JDB_UC = {}; jdbUcSave(); return json(res, { ok: true }) }
    if (act === 'one') {
      const name = String(body.name || '').trim()
      if (!name) return json(res, { ok: false, error: '缺少 name' })
      try {
        const hits = await jdbUncensoredOf(name)
        const M = jdbUcMap()
        M[name] = { uc: !!(hits && hits.length), n: (hits || []).slice(0, 8), at: Date.now() }
        jdbUcSave()
        return json(res, { ok: true, ...M[name] })
      } catch (e) { return json(res, { ok: false, error: e.message }) }
    }
    return json(res, { ok: false, error: '未知操作：' + act })
  }
  /* 订阅 → 线上新作（线上有、本机没有的） */
  if (p === '/api/subscriptions/feed') {
    const force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'
    try { return json(res, await subsFeed(force)) }
    catch (e) { return json(res, { ok: false, error: e.message, items: [], subs: [], stats: { subs: 0, active: 0, fresh: 0, local: 0 } }) }
  }
  /* ---------- 线上数据源（JavDB 国内直连）只读代理 ---------- */
  /* 逐条线路探一次「最新入库」，成功即记 JDB_LINE_OK（后续请求优先复用）。
   * 结果缓存进 JDB_PROBE：订阅页的 GET /api/subscriptions 不发探测（慢），直接读这份缓存回答「通不通」。 */
  async function jdbProbeLines(lines) {
    const probe = []
    for (const base of (lines || [])) {
      const t0 = Date.now()
      try {
        const r = await fetch(base + '/api/v1/movies/latest?filter_by=magnets&limit=1&page=1&sort_by=update&type=all', {
          signal: AbortSignal.timeout(8000),
          headers: { jdsignature: jdbSign(), 'User-Agent': 'Dart/3.5 (dart:io)', 'Accept-Language': 'zh-TW', Accept: 'application/json' }
        })
        const j = await r.json().catch(() => null)
        probe.push({ base, ok: r.ok && !!(j && j.success), status: r.status, ms: Date.now() - t0 })
        if (r.ok && j && j.success) JDB_LINE_OK = base
      } catch (e) { probe.push({ base, ok: false, error: e.message, ms: Date.now() - t0 }) }
    }
    const reachable = probe.some(x => x.ok)
    const error = reachable ? '' : ((probe[0] && (probe[0].error || ('HTTP ' + probe[0].status))) || '线路均不可用')
    JDB_PROBE = { at: Date.now(), probe: probe.slice(), reachable, error }
    return JDB_PROBE
  }
  if (p === '/api/online/status') {
    const c = onlineCfg()
    const out = { ok: true, enabled: c.enabled, lines: c.lines, img: c.img, active: JDB_LINE_OK }
    if (!c.enabled) return json(res, out)
    const pr = await jdbProbeLines(c.lines)
    out.probe = pr.probe
    out.reachable = pr.reachable
    out.error = pr.error
    if (out.reachable) { try { out.stats = (((await onlineGet('v1/movies/latest?filter_by=magnets&limit=24&page=1&sort_by=update&type=all')) || {}).data || {}).pagination || null } catch (_) {} }
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
  /* 名字叫 direct 更名副其实：这只是「前端 → 本机 server → JavDB 国内直连线路」的本地只读中转，
   * server 出网固定直连（onlineGet 纯 fetch，不走代理隧道），/api/online/proxy 旧名保留兼容 */
  if (p === '/api/online/proxy' || p === '/api/online/direct') {
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
      const r = await boardLatest(q.searchParams.get('sort'), parseInt(q.searchParams.get('page') || '1', 10) || 1, q.searchParams.get('type'), q.searchParams.get('filter'))
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
  if (p === '/api/online/playlines') {
    if (req.method === 'GET') return json(res, { ok: true, lines: playLinesCfg() })
    const arr = Array.isArray(body && body.lines) ? body.lines : []
    const out = []
    for (const x of arr) {
      const n = String(x.n || '').trim(), u = String(x.u || '').trim(), act = String(x.act || '').trim()
      if (!n && !u && !act) continue
      if (u) {
        if (!/^https?:\/\//i.test(u)) return json(res, { ok: false, error: 'URL 必须以 http(s):// 开头：' + u })
        if (!/\{CODE\}|\{LCODE\}|\{code\}|\{lcode\}/.test(u)) return json(res, { ok: false, error: 'URL 必须含 {CODE} 占位符（或用 act 走应用内播放）：' + u })
      }
      out.push({ n, u, d: String(x.d || '').trim(), act, on: x.on !== false })
    }
    CFG.playlines = out; writeCfg()
    return json(res, { ok: true, lines: out })
  }
  /* ---------- JavDB 线上搜索（独立搜索模块用）：v2/search 逐页代理 ----------
   * 完整对齐 JavDB app 搜索参数：movie_type（all/0有码/1无码/2欧美/3FC2/4动漫）、
   * movie_sort_by（relevance/release/update/score）、movie_filter_by（all/can_play/magnets/subtitle/single）、limit。 */
  if (p === '/api/online/search') {
    const uq = new URL(req.url, 'http://x')
    const qs = String((body && body.q) || uq.searchParams.get('q') || '').trim()
    const pg = Math.max(1, parseInt((body && body.page) || uq.searchParams.get('page') || '1', 10) || 1)
    const mt = ['all', '0', '1', '2', '3', '4'].includes(String((body && body.movie_type) || uq.searchParams.get('movie_type') || 'all')) ? String((body && body.movie_type) || uq.searchParams.get('movie_type') || 'all') : 'all'
    const msb = ['relevance', 'release', 'update', 'score'].includes(String((body && body.movie_sort_by) || uq.searchParams.get('movie_sort_by') || 'relevance')) ? String((body && body.movie_sort_by) || uq.searchParams.get('movie_sort_by') || 'relevance') : 'relevance'
    const mfb = ['all', 'can_play', 'magnets', 'subtitle', 'single'].includes(String((body && body.movie_filter_by) || uq.searchParams.get('movie_filter_by') || 'all')) ? String((body && body.movie_filter_by) || uq.searchParams.get('movie_filter_by') || 'all') : 'all'
    const lim = [10, 20, 24, 48].includes(parseInt((body && body.limit) || uq.searchParams.get('limit') || '24', 10)) ? parseInt((body && body.limit) || uq.searchParams.get('limit') || '24', 10) : 24
    /* app 搜索页的类型页签：影片 / 演员 / 系列 / 片商（非影片类型同一 v2/search，只换 type） */
    const ty = ['movie', 'actor', 'series', 'maker'].includes(String((body && body.type) || uq.searchParams.get('type') || 'movie')) ? String((body && body.type) || uq.searchParams.get('type') || 'movie') : 'movie'
    if (!qs) return json(res, { ok: false, error: '请输入搜索关键词（番号 / 片名 / 女优 / 系列 / 片商）' })
    try {
      if (ty !== 'movie') {
        const j2 = await onlineGet('v2/search?q=' + encodeURIComponent(qs) + '&type=' + ty + '&page=' + pg)
        const d2 = (j2 || {}).data || {}
        const actors = (d2.actors || []).map(a => ({ id: a.id || '', name: a.name || a.name_zht || '', nameZht: a.name_zht || '', otherName: a.other_name || '', avatar: a.avatar_url || '', videos: (a.videos_count != null ? a.videos_count : ''), uncensored: !!a.uncensored })).filter(a => a.id)
        const series = (d2.series || []).map(s => ({ id: s.id || '', name: s.name || '', videos: (s.videos_count != null ? s.videos_count : '') })).filter(s => s.id)
        const makers = (d2.makers || []).map(m => ({ id: m.id || '', name: m.name || '', videos: (m.videos_count != null ? m.videos_count : '') })).filter(m => m.id)
        return json(res, { ok: true, q: qs, type: ty, page: pg, movies: [], actors, series, makers,
          total: actors.length + series.length + makers.length })
      }
      /* 聚合翻页：上游每页硬上限 24 且不给总数（v2/search 响应只有 current_page+movies）。
       * 这里把上游 2 页合并成本地 1 页（48 个），再用第 3 个上游页探测「还有没有下一页」——
       * 翻页条的最后一页判定从此是真实的，不再靠「本页不满」猜。 */
      const UP = 24
      const upUrl = p => 'v2/search?q=' + encodeURIComponent(qs) + '&from_recent=false&type=movie&movie_type=' + mt +
        '&movie_sort_by=' + msb + '&movie_filter_by=' + mfb + '&page=' + p + '&limit=' + UP
      const up1 = onlineGet(upUrl(pg * 2 - 1))
      const up2 = onlineGet(upUrl(pg * 2))
      const up3 = onlineGet(upUrl(pg * 2 + 1)).catch(() => null)   // 探测页：失败按没有下一页处理
      const j1 = await up1, j2 = await up2, j3 = await up3
      const seenM = new Set(), movies = []
      for (const src of [j1, j2]) for (const m of (((src || {}).data || {}).movies || [])) {
        const it = {
          id: m.id || '', code: m.number || m.code || '', title: m.title || m.origin_title || '',
          thumb: m.thumb_url || '', cover: m.cover_url || '',
          date: m.release_date || '', duration: Number(m.duration) || 0,
          score: m.score || '', magnets: Number(m.magnets_count || m.magnet_count) || 0,
          hasSub: !!(m.has_cnsub || m.has_subtitle), canPlay: !!m.can_play, maker: m.maker_name || ''
        }
        if (!it.code && !it.title) continue
        if (it.id && seenM.has(it.id)) continue
        if (it.id) seenM.add(it.id)
        movies.push(it)
      }
      /* 搜索同时会带出女优/系列/片商联想——女优结果可直接点进 JavDB 女优页 */
      const seenA = new Set(), actors = []
      for (const src of [j1, j2]) for (const a of (((src || {}).data || {}).actors || [])) {
        if (!a.id || seenA.has(a.id)) continue
        seenA.add(a.id)
        actors.push({
          id: a.id || '', name: a.name || a.name_zht || '', nameZht: a.name_zht || '', otherName: a.other_name || '',
          avatar: a.avatar_url || '', videos: (a.videos_count != null ? a.videos_count : '')
        })
      }
      return json(res, { ok: true, q: qs, type: 'movie', page: pg, perPage: UP * 2, movies, actors,
        total: 0, hasMore: ((((j3 || {}).data || {}).movies || []).length > 0) })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* ---------- JavDB 女优详情页（复刻 app 女优页）：v1/actors/{id} ----------
   * 支持直接传 id（搜索结果里点进来）或按名字解析（本地女优页「全部作品」按钮进来）。
   * 返回 profile（头像/别名/生日/身高/三围/社交账号/作品数）+ names（按命中率排序的搜索候选名，
   * 作品列表走 v2/search 名字搜索——站方 app 同款做法，没有独立的女优作品端点）。 */
  if (p === '/api/online/actor') {
    const uq = new URL(req.url, 'http://x')
    const aid = String((body && body.id) || uq.searchParams.get('id') || '').trim()
    const aname = String((body && body.name) || uq.searchParams.get('name') || '').trim()
    if (!aid && !aname) return json(res, { ok: false, error: '缺少女优 id 或名字' })
    try {
      let id = aid
      if (!id) {
        /* ⚠ 用 onlineActorExact，不用 onlineActorFind（2026-10-13）：
         * 后者原先兜底返回搜索结果第一条，实测 21% 的名字会因此锁到**另一个人**，
         * 于是「▣ JavDB 女优页」列出来的是那个人的全部作品。exact 认不出就明确报错，不猜。 */
        const hit = await onlineActorExact(aname).catch(() => null)
        if (!hit || !hit.id) return json(res, { ok: false, error: '线上没有找到这位女优（试试她的日文原名；或在订阅里直接贴她的 JavDB 女优页链接）' })
        id = hit.id
      }
      const j = await onlineGet('v1/actors/' + encodeURIComponent(id))
      const d = ((j || {}).data || {})
      const a = d.actor || {}
      /* share_info 形如「深田えいみ\nhttps://javdb580.com/actors/E26vd」——网页版链接可当资料页兜底入口 */
      const webUrl = (String(d.share_info || '').match(/https?:\/\/\S+\/actors\/\S+/) || [''])[0]
      const names = []
      for (const n of [a.name, a.name_zht, a.other_name].concat(String(a.other_name || '').split(/[,，、]/))) {
        const s = String(n || '').trim()
        if (s && !names.includes(s)) names.push(s)
      }
      return json(res, {
        ok: true,
        actor: {
          id: a.id || id, name: a.name || aname || '', nameZht: a.name_zht || '', otherName: a.other_name || '',
          avatar: a.avatar_url || '', birthday: a.birthday || '', age: a.age || '', bloodType: a.blood_type || '',
          height: a.height || '', bust: a.bust || '', cup: a.cup || '', waist: a.waist || '', hips: a.hips || '',
          birthplace: a.birthplace || '', twitter: a.twitter_id || '', instagram: a.instagram_id || '',
          videosCount: a.videos_count != null ? a.videos_count : ''
        },
        names,
        tags: (d.tags || []).map(t => ({ name: t.name || '', count: Number(t.videos_count) || 0 })).filter(t => t.name),
        webUrl
      })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* ---------- 女优作品列表（网页版演员页）：唯一能给「全部作品」的来源 ----------
   * 背景：app API 根本没有「女优作品」端点 —— v1/movies/latest 的 actor_id / actor_ids /
   * filter_by=actor 等参数全被静默忽略（实测带与不带返回逐字节相同），v2/search 只按标题
   * 关键词匹配。于是「坂道美琉 = 255 部」在旧实现里只剩标题里恰好写了 miru 的那 3 部。
   * 网页版演员页 /actors/{id} 才有完整分页（每页 40 部 + 页脚总页数）。
   * 参数：page（≥1）、sort_type（0 发行日期倒序 / 1 评分 / 2 热度 / 3 想看 / 4 看过）、
   *       t（筛选：p 可播放 / s 单体作品 / d 含磁链 / c 含字幕；留空 = 全部）。 */
  if (p === '/api/online/actor_movies') {
    const uq = new URL(req.url, 'http://x')
    const id = String((body && body.id) || uq.searchParams.get('id') || '').trim()
    const pg = Math.max(1, parseInt((body && body.page) || uq.searchParams.get('page') || '1', 10) || 1)
    const _st = String((body && body.sort_type) || uq.searchParams.get('sort_type') || '0')
    const st = ['0', '1', '2', '3', '4'].includes(_st) ? _st : '0'
    const _tf = String((body && body.t) || uq.searchParams.get('t') || '').trim()
    const tf = ['', 'p', 's', 'd', 'c'].includes(_tf) ? _tf : ''
    if (!/^[A-Za-z0-9]{3,16}$/.test(id)) return json(res, { ok: false, error: '女优 id 不合法' })
    try {
      const parsed = await jdbActorMoviesPage(id, pg, st, tf)
      return json(res, Object.assign({ ok: true, id, page: pg, sortType: st, t: tf }, parsed))
    } catch (e) {
      return json(res, { ok: false, error: '演员页抓取失败：' + ((e && e.message) || '未知错误') })
    }
  }
  /* ---------- JavDB 目录页（复刻 app「演员」「片商」「系列」tab）：v1/actors|makers|series ----------
   * 目录 = 大全式翻页（type: 0有码 1无码 all）；带 q 时走 v2/search 对应类型。
   * 片商/系列没有专属作品端点（实测 maker_id 会被 v1/movies/latest 静默忽略），作品列表用名字搜索兜底。 */
  /* ---- 缺口体检：某位女优的线上全量作品 × 本地库存 = 缺哪几部（2026-10-15）
   * 复用「订阅·全量」那条链路（onlineActorSearchTerms + onlineActorAllWorks）——
   * 泛化别名过滤、翻页深度限制、限速都已在那边处理好，这里不重造一套。 */
  if (p === '/api/gap/actor') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const name = String(body.name || '').trim()
    if (!name) return json(res, { ok: false, error: '缺少女优名' })
    const ck = onNorm(name)
    const hit = GAP_ACTOR_CACHE.get(ck)
    if (hit && Date.now() - hit.at < GAP_ACTOR_TTL) {
      return json(res, Object.assign({ ok: true, cached: true, at: hit.at }, hit.data))
    }
    try {
      const meta = await onlineActorSearchTerms(name)
      /* ⚠ 线上没有同名女优时**绝不能硬搜**：实测「恋れん」能搜回 344 部别人的片。
       * 这里同样严格执行（与订阅一致），认不出就明确说认不出。 */
      if (!meta || !meta.exact) {
        return json(res, { ok: false, name, error: '线上没有找到这位女优（搜到的都是名字相近的别人）。试试日文原名，或在订阅里贴她的 JavDB 女优页链接。' })
      }
      const r = await onlineActorAllWorks(name, { meta })
      const local = new Set()
      for (const it of ((DATA && DATA.items) || [])) if (it.code) local.add(bare(it.code))
      for (const it of scrapedVirtualItems()) if (it.code) local.add(bare(it.code))
      const missing = r.codes.filter(c => !local.has(c))
      /* 显示 / 入队都用**原始番号**（SSNI-826），不用 bare 压缩形态（SSNI826）—— 后者拿去刮削容易被当野格式 */
      const missingRaw = missing.map(c => (r.raw && r.raw[c]) || c)
      const data = {
        name, matched: r.matched || (meta.actor && meta.actor.name) || name,
        expect: r.expect || 0, fetched: r.codes.length,
        localCount: r.codes.length - missing.length,
        missing: missingRaw.slice(0, 500),
        missingAll: missing.length,
        terms: r.terms || [], dropped: r.dropped || [], rounds: r.rounds || 0
      }
      if (GAP_ACTOR_CACHE.size >= GAP_ACTOR_MAX) GAP_ACTOR_CACHE.delete(GAP_ACTOR_CACHE.keys().next().value)
      GAP_ACTOR_CACHE.set(ck, { at: Date.now(), data })
      return json(res, Object.assign({ ok: true, cached: false, at: Date.now() }, data))
    } catch (e) {
      return json(res, { ok: false, name, error: '抓取失败：' + ((e && e.message) || String(e)) })
    }
  }
  /* ---- 磁盘容量（「珍藏 → 空间」用）----
   * 与媒体源卡片的容量同源：fs.statfsSync，每块盘一条，同一块盘上的多个目录只算一次。
   * 单独成一个接口是因为空间页需要**离线数据目录所在盘**（它常和媒体库不同盘）。 */
  if (p === '/api/disk') {
    if (req.method !== 'GET') { res.writeHead(405); return res.end() }
    const seen = {}, disks = []
    const addDisk = (dir) => {
      let root = ''
      try { root = path.parse(dir).root || String(dir).slice(0, 3) } catch (_) { root = String(dir || '').slice(0, 3) }
      root = String(root || '').replace(/[\\/]+$/, '')
      if (!root || seen[root.toLowerCase()]) return
      seen[root.toLowerCase()] = 1
      try {
        const st = fs.statfsSync(dir)
        const total = st.bsize * st.blocks, free = st.bsize * st.bavail
        if (total > 0) disks.push({ root, free, total, dirs: [dir] })
      } catch (_) {}   // 盘读不到（拔了 / 权限）就跳过，不画这块
    }
    for (const d of LIBS) addDisk(d)
    try { addDisk(cacheDir()) } catch (_) {}
    return json(res, { ok: true, disks, roots: { media: LIBS.slice(), cache: cacheDir() } })
  }
  if (p === '/api/online/dirs') {
    const uq = new URL(req.url, 'http://x')
    const kindRaw = String(uq.searchParams.get('kind') || 'actors').toLowerCase()
    const kind = ['actors', 'makers', 'series'].includes(kindRaw) ? kindRaw : 'actors'
    const ty = ['0', '1', 'all'].includes(String(uq.searchParams.get('type') || 'all')) ? String(uq.searchParams.get('type') || 'all') : 'all'
    const pg = Math.max(1, parseInt(uq.searchParams.get('page') || '1', 10) || 1)
    const qs = String(uq.searchParams.get('q') || '').trim()
    try {
      /* 聚合翻页：上游目录每页很小（actors 实测只有 10 条/页）且不给总数（v1/* 响应无 pagination.total）。
       * 同 search：上游 2 页合并成本地 1 页，第 3 页探测 hasMore，翻页条末页判定真实。 */
      const singular = kind === 'actors' ? 'actor' : (kind === 'series' ? 'series' : 'maker')
      /* 上游坑：v1/makers 不认 type=all（500），片商的「全部」回落成有码 */
      const tySend = (kind === 'makers' && ty === 'all') ? '0' : ty
      const UP = 24
      const upDir = p => qs
        ? onlineGet('v2/search?q=' + encodeURIComponent(qs) + '&type=' + singular + '&page=' + p)
        : onlineGet('v1/' + kind + '?type=' + tySend + '&page=' + p)
      const j1 = await upDir(pg * 2 - 1), j2 = await upDir(pg * 2), j3 = await upDir(pg * 2 + 1).catch(() => null)
      let list = [], hasMore = false
      for (const [idx, j] of [j1, j2].entries()) {
        const d = (j || {}).data || {}
        const raw = d[kind] || []
        list = list.concat(raw)
        if (idx === 1) {
          const d3 = (j3 || {}).data || {}
          hasMore = (d3[kind] || []).length > 0
        }
      }
      const seen = new Set(); const items = []
      for (const x of list) {
        if (!x.id || seen.has(x.id)) continue
        seen.add(x.id)
        items.push(kind === 'actors'
          ? { id: x.id || '', name: x.name || x.name_zht || '', nameZht: x.name_zht || '', otherName: x.other_name || '', avatar: x.avatar_url || '', videos: (x.videos_count != null ? x.videos_count : ''), uncensored: !!x.uncensored }
          : { id: x.id || '', name: x.name || '', videos: (x.videos_count != null ? x.videos_count : '') })
      }
      const total = ((((j1 || {}).data || {}).pagination || {}).total) || 0
      return json(res, { ok: true, kind, type: ty, page: pg, q: qs, items, total, hasMore })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  /* ---------- 片商 / 系列详情：v1/makers/{id} | v1/series/{id}（share_info 里带网页版链接） ---------- */
  if (p === '/api/online/entity') {
    const uq = new URL(req.url, 'http://x')
    const kindRaw = String(uq.searchParams.get('kind') || '').toLowerCase()
    const kind = ['maker', 'series'].includes(kindRaw) ? kindRaw : ''
    const eid = String(uq.searchParams.get('id') || '').trim()
    if (!kind || !eid) return json(res, { ok: false, error: '缺少 kind 或 id' })
    try {
      /* 复数化特判：v1 端点里 maker→makers，但 series 本身就是复数——
       * 直接 kind+'s' 会拼出 v1/seriess/{id}（404），三条线路全挂，报错文案还只报最后一条线路，极具迷惑性 */
      const path = kind === 'series' ? 'series' : kind + 's'
      const j = await onlineGet('v1/' + path + '/' + encodeURIComponent(eid))
      const d = ((j || {}).data || {})
      const x = d[kind] || {}
      const webUrl = (String(d.share_info || '').match(new RegExp('https?://\\S+/' + path + '/\\S+')) || [''])[0]
      return json(res, { ok: true, kind, id: x.id || eid, name: x.name || '', videos: (x.videos_count != null ? x.videos_count : ''), webUrl })
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
  function pan115Cfg(acct) {
    /* acct 缺省 = 配置的推送账号 pan115PushAcctOf()。账号 1 = CFG.pan115（老卡，推送目录也在这）；
     * 账号 N（≥2）= CFG.pan115x[N-2]，savepath/cid/cidName/timeout 存该账号自己的槽
     * （媒体源模块只用 cookie/linkTpl/roots/name，互不干扰）。自动认领不用改 —— v115FindByCode 本来就遍历所有就绪账号。 */
    let n = acct != null ? (parseInt(acct, 10) || 1) : pan115PushAcctOf()
    n = Math.max(1, n)
    const base = (CFG.pan115 && typeof CFG.pan115 === 'object') ? CFG.pan115 : {}
    if (n === 1) return { acct: 1, cookie: String(base.cookie || '').trim(), savepath: String(base.savepath || '').trim(), cid: String(base.cid || '').trim(), cidName: String(base.cidName || '').trim(), timeout: Number(base.timeout) || 20, name: String(base.name || '').trim() }
    const cx = (Array.isArray(CFG.pan115x) ? CFG.pan115x[n - 2] : null) || {}
    return { acct: n, cookie: String(cx.cookie || '').trim(), savepath: String(cx.savepath || '').trim(), cid: String(cx.cid || '').trim(), cidName: String(cx.cidName || '').trim(), timeout: Number(cx.timeout) || Number(base.timeout) || 20, name: String(cx.name || '').trim() }
  }
  /* ⚠ 2026-10-15：这条通道以前**完全不过节流器**（它是独立的 https 请求，不是 v115FetchRaw），
   *   于是「批量推 20 部磁力」= 40 个请求瞬间打出去（每部 get_id + add_task_url），
   *   是本机把 115 逼到风控的最直接来源。现在与网盘那条路共用同一个串行闸门。 */
  async function pan115Request(url, { method = 'GET', form = null, timeout, acct } = {}) {
    if (v115AuthCdOn('push', acct)) throw v115AuthCdErr('push', acct)   // 推送通道登录失效 → 暂停
    await v115Throttle()
    return new Promise((resolve, reject) => {
      const c = pan115Cfg(acct)
      const to = (timeout || c.timeout || 20) * 1000
      let u
      try { u = new URL(url) } catch (e) { return reject(new Error('URL 无效')) }
      const mod = u.protocol === 'http:' ? http : https
      const payload = form ? Object.entries(form).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : null
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method,
        headers: Object.assign({
          'Cookie': c.cookie + V115_WAF,
          /* ⚠ UA 必须与 v115FetchRaw 一致（都是 V115_UA）：同一 Cookie + 两个不同 UA
           * = 115 眼里的「同一设备被两个浏览器同时使用」，是会话被判异常/强制下线的经典特征。
           * 2026-10-13 前这里伪装的是 macOS Chrome，与另一条通道的 115Browser 冲突。 */
          'User-Agent': V115_UA,
          'Referer': 'https://115.com/web/lixian/',
          'Accept': 'application/json, text/plain, */*'
        }, payload ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Length': Buffer.byteLength(payload) } : {})
      }, rsp => {
        try { v115WafAbsorb(rsp.headers['set-cookie']) } catch (_) {}   // 同一份 WAF 会话粘性
        const chunks = []
        rsp.on('data', d => chunks.push(d))
        rsp.on('end', () => {
          const buf = Buffer.concat(chunks)
          let j = null
          try { j = JSON.parse(buf.toString('utf8')) } catch (_) {}
          /* 推送通道自己的登录失效判定（990001）：与 webapi 那条路分开记冷却，
           * 否则「推送还能用、网盘已掉线」会被一刀切，反之亦然。 */
          if (j) {
            const raw = String(j.error || j.errorMsg || j.error_msg || j.msg || '')
            if (v115LoginErrCode(j) || v115LoginErrText(raw)) v115AuthCdHit('push', acct, raw)
            else v115AuthCdClear('push', acct)
          }
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
  /* get_id 结果缓存 5 分钟（2026-10-15 降速）：
   * 推一部磁力要两个请求（get_id 拿签名 key + add_task_url 提交），批量推 20 部 = 40 次。
   * 签名用的 userkey 短期不变，缓存之后一批推送只剩 21 次 —— 请求量直接砍半。
   * 换了 Cookie / 切换推送账号时清空（见 v115CookieChanged）。 */
  async function pan115GetId(acct) {
    const k = acct == null ? pan115PushAcctOf() : Math.max(1, parseInt(acct, 10) || 1)
    const hit = V115_LXID.get(k)
    if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data
    const d = await pan115GetIdRaw(acct)
    V115_LXID.set(k, { t: Date.now(), data: d })
    return d
  }
  async function pan115GetIdRaw(acct) {
    const cfg = pan115Cfg(acct)
    const ukOf = j => j && (j.userkey || (j.data && j.data.userkey) || (j.info && j.info.userkey) || (j.result && j.result.userkey)) || ''
    const uidOf = j => { const u = j && (j.user_id || (j.data && j.data.user_id) || (j.info && j.info.user_id)); if (u) return String(u); return (cfg.cookie.match(/UID=(\d+)/i) || [])[1] || '' }
    const dcOf = j => String((j && (j.dest_cid || (j.data && j.data.dest_cid))) || '')
    const r = await pan115Request('https://115.com/web/lixian/?ct=lixian&ac=get_id', { acct })
    const j = r.json
    const uk = ukOf(j)
    if (!uk) {
      /* 115 改版（2026-09 实测）：get_id 现在只返回 {cid, dest_cid}，不再下发 userkey ——
       * 而实测 add_task_url 不带 sign 也能成功提交（cookie 对就行），所以缺 userkey 不再算失败，
       * 只有请求本身出错（非 200 / JSON 解析失败）才报 cookie 问题 */
      if (r.status === 200 && j) return { userkey: '', uid: uidOf(j), destCid: dcOf(j) }
      const reason = (j && (j.error || j.errorMsg || j.error_msg)) || (r.status !== 200 ? 'HTTP ' + r.status : '返回里没有 userkey')
      throw new Error('验证 115 失败（' + reason + '）—— 大概率 cookie 失效，去 115 网页版重新复制')
    }
    return { userkey: String(uk), uid: uidOf(j), destCid: dcOf(j) }
  }
  async function pan115AddOne(magnet) {
    /* 目标目录用 wp_path_id（目录 cid，与网页版行为一致：落在所选目录 + 按任务建子文件夹）。
     * 不要用 savepath 字符串——它相对 115 默认离线目录（dest_cid，如「云下载」）解析，
     * 且会平铺文件不建任务文件夹（2026-09 实测踩坑）。 */
    const cid = pan115Cfg().cid
    let id = null
    try { id = await pan115GetId() } catch (e) { id = { err: e.message } }
    /* 推送通道已因登录失效暂停 → 别再提交（提交必然失败，还白送一次请求给风控） */
    if (id && id.err && /登录已失效|暂停请求/.test(String(id.err))) return { ok: false, error: id.err }
    const time = Math.floor(Date.now() / 1000)
    const form = { url: magnet, time: String(time) }
    if (cid) form.wp_path_id = cid
    const uid = (id && id.uid) || (pan115Cfg().cookie.match(/UID=(\d+)/i) || [])[1] || ''
    if (uid) form.uid = uid
    if (id && id.userkey) form.sign = pan115Sign(id.userkey, time, uid).sign
    const r = await pan115Request('https://115.com/web/lixian/?ct=lixian&ac=add_task_url', { method: 'POST', form })
    const j = r.json
    const okState = j && (j.state === true || j.state === 1 || j.errno === 0 || (j.info && j.info.name))
    if (okState) return { ok: true, name: (j.info && (j.info.name || j.info.url)) || '' }
    const msg = (j && (j.error || j.errorMsg || j.error_msg)) || r.text || ('HTTP ' + r.status)
    /* 记录原始响应，便于定位签名/字段变化（115 接口常改） */
    console.log('[115-push] 提交失败 raw=' + (r.text || '').slice(0, 300) + ' | status=' + r.status)
    return { ok: false, error: String(msg).slice(0, 200) }
  }
  if (p === '/api/115/config') {
    /* acct：媒体源多账号（2026-10-14）。acct=1 = 老卡（Cookie 与离线推送共用）；acct≥2 = 附加账号（CFG.pan115x）。
     * 推送账号（2026-10-15）：CFG.pan115.pushAcct，可设为任意已配置账号 —— 推送/离线任务/推送目录都跟着走该账号。 */
    const qAcct = () => {
      try { return Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('acct'), 10) || 1) } catch (_) { return 1 }
    }
    if (req.method === 'GET') {
      const n = qAcct()
      const c = v115Cfg(n)
      /* 容量/会员（v115UserCached 可能还没拉过 → 空时后台补一发，下次刷新就有） */
      let ui = v115UserCached(n)
      if (!ui && v115Ready(n)) { v115UserInfo(false, n).catch(() => {}); ui = null }
      /* 推送账号下拉的数据源：对外账号列表（账号 1 恒在）+ 各自显示名 + 是否已有 Cookie */
      const accts = v115AcctListAll().map(a => { const cc = v115Cfg(a); return { acct: a, name: String(cc.name || '').trim() || ('115 网盘 ' + a), ready: v115Ready(a) } })
      if (n > 1) {
        const pc = pan115Cfg(n)
        return json(res, {
          ok: true, acct: n, hasCookie: !!c.cookie, linkTpl: c.linkTpl || '', name: c.name || '',
          pushAcct: pan115PushAcctOf(), accts, savepath: pc.savepath, cid: pc.cid, cidName: pc.cidName, timeout: pc.timeout,
          fileOk: v115AuthOf(n).ok, fileError: v115AuthOf(n).err, authNote: v115AuthNote(n),
          pace: v115PaceOf(), throttle: v115ThrottleState(),
          space: ui ? { total: ui.total, totalFmt: ui.totalFmt, used: ui.used, usedFmt: ui.usedFmt, remainFmt: ui.remainFmt, percent: ui.percent } : null,
          vip: ui ? ui.vip : null, user: (ui && ui.user) || '', userErr: (ui && ui.err) || ''
        })
      }
      const pan = pan115Cfg(1)
      return json(res, {
        ok: true, acct: 1, hasCookie: !!c.cookie, savepath: pan.savepath, cid: pan.cid, cidName: pan.cidName,
        timeout: pan.timeout, linkTpl: c.linkTpl || '', name: c.name || '',
        pushAcct: pan115PushAcctOf(), accts,
        /* 网盘是否真的读得到（null=还没试过）。与「离线推送可用」是两回事，UI 必须分开展示 */
        fileOk: v115AuthOf(1).ok, fileError: v115AuthOf(1).err, authNote: v115AuthNote(1),
        pace: v115PaceOf(), throttle: v115ThrottleState(),
        space: ui ? { total: ui.total, totalFmt: ui.totalFmt, used: ui.used, usedFmt: ui.usedFmt, remainFmt: ui.remainFmt, percent: ui.percent } : null,
        vip: ui ? ui.vip : null, user: (ui && ui.user) || '', userErr: (ui && ui.err) || ''
      })
    }
    /* 115 请求节奏档位（2026-10-15）：设置页「请求节奏」直接改这个，立即生效，不用重启 */
    if ('v115Pace' in body) {
      const pc = String(body.v115Pace || 'safe')
      if (V115_PACE[pc]) {
        CFG.v115Pace = pc
        writeCfg()
        console.log('[115] 请求节奏 → ' + pc + '（基础间隔 ' + V115_PACE[pc] + 'ms，所有 115 请求共用）')
      }
    }
    /* 推送账号切换：先于其它字段处理（独立于 body.acct —— body.acct 是「这份表单在改哪个账号」，pushAcct 是「推送走哪个账号」） */
    if ('pushAcct' in body) {
      const pa = Math.max(1, parseInt(body.pushAcct, 10) || 1)
      const allowed = v115AcctListAll()
      if (!allowed.includes(pa)) return json(res, { ok: false, error: '账号 ' + pa + ' 还没有配置（先在 媒体源 里添加）' })
      if (!CFG.pan115 || typeof CFG.pan115 !== 'object') CFG.pan115 = {}
      CFG.pan115.pushAcct = pa
      writeCfg()
    }
    const n = Math.max(1, parseInt(body.acct, 10) || 1)
    if (n > 1) {
      /* 附加账号：媒体库字段 + 推送目录都存该账号自己的配置槽（互不串号） */
      const c = v115Cfg(n)
      if ('cookie' in body) c.cookie = String(body.cookie || '').trim()
      if ('name' in body) c.name = String(body.name || '').trim().slice(0, 30)
      if ('linkTpl' in body) c.linkTpl = String(body.linkTpl || '').trim()
      if ('savepath' in body) c.savepath = String(body.savepath || '').trim()
      if ('cid' in body) c.cid = String(body.cid || '').trim()
      if ('cidName' in body) c.cidName = String(body.cidName || '').trim()
      if ('timeout' in body) c.timeout = Math.max(5, Math.min(120, parseInt(body.timeout, 10) || 20))
      writeCfg()
      if ('cookie' in body) {
        const a = v115AuthOf(n); a.ok = null; a.err = ''; a.at = 0
        for (const k of Array.from(V115_SNAP.keys())) if (k.startsWith(n + '|')) V115_SNAP.delete(k)
        V115_USERS[n] = { t: 0, data: null, busy: null }
        SRC_CACHE = { at: 0, data: null }
        v115CookieChanged(n)      // 换了 Cookie → 立刻解除登录失效冷却 + 丢掉 get_id 缓存
        srcHealthProbeNow(n > 1 ? 'pan115@' + n : 'pan115')   // 立刻复检：新 Cookie 对不对，几秒内就在卡片上出结果
      }
      const cc = v115Cfg(n)
      return json(res, { ok: true, acct: n, name: cc.name || ('115 网盘 ' + n), ready: v115Ready(n) })
    }
    const o = Object.assign({}, (CFG.pan115 && typeof CFG.pan115 === 'object') ? CFG.pan115 : {})
    if ('cookie' in body) o.cookie = String(body.cookie || '').trim()
    if ('savepath' in body) o.savepath = String(body.savepath || '').trim()
    if ('cid' in body) o.cid = String(body.cid || '').trim()
    if ('cidName' in body) o.cidName = String(body.cidName || '').trim()
    if ('timeout' in body) o.timeout = Math.max(5, Math.min(120, parseInt(body.timeout, 10) || 20))
    /* 媒体源卡片显示名（添加页「添加媒体源 → 115 网盘」表单里的「名称」） */
    if ('name' in body) o.name = String(body.name || '').trim().slice(0, 30)
    if ('linkTpl' in body && !('savepath' in body)) o.linkTpl = String(body.linkTpl || '').trim()   // 纯媒体库表单也允许改模板
    CFG.pan115 = o; writeCfg()
    /* 换了凭据就把结论清空：否则「网盘读不了」的旧状态会一直粘着，用户重贴 Cookie 也看不到恢复 */
    if ('cookie' in body) {
      const a = v115AuthOf(1); a.ok = null; a.err = ''; a.at = 0
      V115_SNAP = new Map()
      V115_USERS[1] = { t: 0, data: null, busy: null }   // 容量/会员也跟着换账号，必须重拉
      SRC_CACHE = { at: 0, data: null }
      v115CookieChanged(1)
      srcHealthProbeNow('pan115')   // 立刻复检（Emby 式：一贴完 Cookie 就自己恢复，不用等冷却）
    }
    const c = pan115Cfg()
    return json(res, {
      ok: true, hasCookie: !!c.cookie, savepath: c.savepath, cid: c.cid, cidName: c.cidName,
      timeout: c.timeout, linkTpl: v115Cfg().linkTpl || '', name: c.name || '',
      pushAcct: pan115PushAcctOf(), accts: v115AcctListAll().map(a => { const cc = v115Cfg(a); return { acct: a, name: String(cc.name || '').trim() || ('115 网盘 ' + a), ready: v115Ready(a) } }),
      fileOk: v115AuthOf(1).ok, fileError: v115AuthOf(1).err, authNote: v115AuthNote(1),
      space: null, vip: null, user: '', userErr: ''
    })
  }
  if (p === '/api/115/dirs') {   // 目标文件夹下拉：列出 cid 下的子目录 + 面包屑路径（acct=浏览哪个账号的网盘，缺省推送账号）
    const q = new URL(req.url, 'http://x')
    const cid = (q.searchParams.get('cid') || '0').replace(/[^\d]/g, '') || '0'
    const acct = Math.max(1, parseInt(q.searchParams.get('acct'), 10) || pan115PushAcctOf())
    if (!pan115Cfg(acct).cookie) return json(res, { ok: false, error: '该账号还没有填写 115 cookie（账号 ' + acct + '）' })
    try {
      const r = await pan115Request('https://webapi.115.com/files?cid=' + cid + '&show_dir=1&limit=1000&o=user_ptime&asc=0&format=json', { acct })
      const j = r.json
      if (!j || j.state !== true) {
        const msg = (j && (j.error || j.errorMsg || j.errNo)) || ('HTTP ' + r.status)
        /* 这条和扫描/匹配文件打的是同一个 webapi/files —— 顺手把「网盘可读」状态带出来，
         * 用户在设置页拉目录失败时就不会只看到一句「读取目录失败」而不知道网盘整体不可读了 */
        if (v115AuthErr(msg)) v115MarkAuth(false, String(msg), acct)
        return json(res, { ok: false, error: '读取目录失败（' + msg + '）' })
      }
      v115MarkAuth(true, '', acct)
      const dirs = (j.data || []).filter(x => x && x.pid !== undefined && x.cid !== undefined && x.n)
        .map(x => ({ cid: String(x.cid), name: x.n, cnt: Number(x.m) || 0 }))
      const path = (j.path || []).map(p2 => ({ cid: String(p2.cid), name: p2.name || '' }))
      return json(res, { ok: true, cid, dirs, path })
    } catch (e) { return json(res, { ok: false, error: e.message }) }
  }
  if (p === '/api/115/test') {   // 验证 cookie：主验证走任务列表（cookie 有效必返回 state:true + 配额），get_id 只作补充
    /* 多账号（2026-10-15）：body.acct / ?acct= 指定测哪个账号，缺省 = 配置的推送账号。
       推送已支持任意账号 → 每个账号都做完整验证（离线推送通道 task_lists + 网盘文件接口 webapi/files + 配额）。 */
    /* ⚠ 本段作用域没有预解析的 URL 对象（别段的 u/uq 在这里都不存在），按本段惯例现场解析 */
    const tn = Math.max(1, parseInt((body && body.acct) || (new URL(req.url, 'http://x').searchParams.get('acct')), 10) || pan115PushAcctOf())
    const c = pan115Cfg(tn)
    if (!c.cookie) return json(res, { ok: false, error: '该账号还没有填写 115 cookie' + (tn > 1 ? ('（账号 ' + tn + '，在 媒体源 里配置）') : '') })
    try {
      let id = null, quota = null, uid = (c.cookie.match(/UID=(\d+)/i) || [])[1] || ''
      const tr = await pan115Request('https://clouddownload.115.com/web/?ac=task_lists&page=1&page_size=1&stat=1', { acct: tn })
      const tj = tr.json
      if (!tj || tj.state !== true) {
        const msg = (tj && (tj.error || tj.errorMsg || tj.errtype)) || ('HTTP ' + tr.status + (tr.text ? ' ' + tr.text.slice(0, 80) : ''))
        return json(res, { ok: false, error: 'cookie 无效或已过期（' + msg + '）—— 去 115 网页版重新复制（要含 UID/CID/SEID）' })
      }
      try { id = await pan115GetId(tn) } catch (_) {}
      uid = (id && id.uid) || uid
      /* 任务列表自带离线配额：quota=已用，total=总量（2026-09 实测 {"quota":1421,"total":1500}） */
      quota = tj.total ? { total: tj.total, used: tj.quota } : null
      /* ★ 再单独探一次「网盘能不能读」—— 上面那条是**离线推送**接口，
       *   两者鉴权不同：实测 2026-10-13 推送接口 state:true 而 webapi/files 已 errNo 990001。
       *   不分开测的话，用户会看到「✓ 连接成功」却怎么都扫不到/匹配不到网盘文件。 */
      let fileOk = v115AuthOf(tn).ok, fileError = v115AuthOf(tn).err
      /* 60 秒内刚确认过「网盘能读」就复用结论 —— 反复点「测试连接」不该反复打 115 接口（风控优化）。
       * 没有近期结论时才探一次，且走快照（根目录快照就够判断可读性）。 */
      if (!(fileOk === true && Date.now() - v115AuthOf(tn).at < 60000)) {
        try {
          await v115List('0', false, tn)
          fileOk = true; fileError = ''
        } catch (e) {
          fileOk = false; fileError = (e && e.message) || '未知错误'
        }
      }
      return json(res, {
        ok: true, acct: tn, uid, signed: !!(id && id.userkey), destCid: (id && id.destCid) || '',
        savepath: c.savepath, cid: c.cid, cidName: c.cidName, quota,
        fileOk, fileError
      })
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
    if (okN > 0) watch115Push(String(body.code || ''), c.acct)   // 推送成功 → 登记自动认领盯梢（记下推到哪个账号，展示用）
    return json(res, { ok: okN > 0, code: String(body.code || ''), pushed: okN, total: magnets.length, results, savepath: c.savepath, acct: c.acct, acctName: c.name || ('115 网盘 ' + c.acct) })
  }
  if (p === '/api/115/watch') {   // 自动认领盯梢状态：body { code }（可空）→ 任务列表（详情页轮询本页番号的任务）
    const code = norm(String(body.code || ''))
    const jobs = W115.jobs
      .filter(j => !code || bare(j.code) === bare(code))
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, 20)
    return json(res, { ok: true, watching: jobs.some(j => j.status === 'watching'), jobs })
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
  /* ---------- 115 网盘「媒体库来源」----------
   * 与上面的「离线推送」是两件事：推送是把磁力丢给 115 下载；这里是**把 115 上的目录当媒体库根**，
   * 扫描时走 API 列目录（不落本地盘），播放时服务端取 302 直链后代理转发。
   * 归属 CFG.pan115.roots = [{ cid, name, path }]，与本地 LIBS 并列但不混在一起。 */
  if (p === '/api/115/lib') {   // 状态：Cookie 是否配好 + 已添加的网盘根目录 + 收录统计（多账号：accts 数组逐账号一份）
    const c = v115Cfg(1)
    const accts = v115AcctListAll().map(n => {
      const cx = v115Cfg(n), auth = v115AuthOf(n), ui = v115UserCached(n)
      return {
        acct: n, key: n > 1 ? 'pan115@' + n : 'pan115',
        name: n > 1 ? (cx.name || ('115 网盘 ' + n)) : (cx.name || '115 网盘'),
        hasCookie: !!String(cx.cookie || '').trim(),
        user: (ui && ui.user) || '',
        roots: v115Roots(n).map(r => Object.assign({}, r, { acct: n })),
        stats: v115Stats(n), authOk: auth.ok, authNote: v115AuthNote(n)
      }
    })
    return json(res, {
      ok: true, hasCookie: !!c.cookie, linkTpl: c.linkTpl || '', accts,
      roots: v115Roots(1), stats: v115Stats(1), mapped: V115_MAP.size,
      throttle: v115ThrottleState(),
      blocked: v115BlockedNow() ? { remainMin: v115BlockRemain(), msg: V115_BLOCK_MSG } : null
    })
  }
  if (p === '/api/115/lib/browse') {   // 浏览网盘目录（只列一层，前端逐级下钻 + 多选）
    const q = new URL(req.url, 'http://x')
    const cid = String(q.searchParams.get('cid') || '0').replace(/[^\d]/g, '') || '0'
    const acct = Math.max(1, parseInt(q.searchParams.get('acct'), 10) || 1)
    const fresh = q.searchParams.get('fresh') === '1'
    if (!v115Cookie(acct)) return json(res, { ok: false, hasCookie: false, error: '还没有填写 115 Cookie —— 在「设置 → 115 推送」里粘贴（两个功能共用这一份）' })
    try {
      /* ⚠ 默认**走 10 分钟快照**，不再每次实时打接口（2026-10-13 风控优化）：
       * 用户在弹层里逐级下钻 / 来回切目录 = 一连串实时请求，是触发 405 的主要来源之一。
       * 想看最新目录时前端会带 ?fresh=1（弹层里的「⟳ 刷新目录」按钮）。 */
      const items = await v115List(cid, fresh, acct)
      const snap = V115_SNAP.get(acct + '|' + String(cid)) || null
      const ageMin = snap && snap.t ? Math.round((Date.now() - snap.t) / 60000) : 0
      const dirs = items.filter(x => x.isDir && x.id).map(x => ({ cid: x.id, name: x.name }))
      const vids = items.filter(x => !x.isDir && VIDEO_EXT.includes(extOf(x.name)))
      return json(res, { ok: true, acct, cid, fresh: !!fresh, ageMin, dirs, videos: vids.length, samples: vids.slice(0, 5).map(x => x.name) })
    } catch (e) {
      /* 把失败原因结构化带出去：前端要区分「没 Cookie」（要去贴）和「405 限流冷却」（等几分钟自动恢复），
       * 不能一律弹「去粘贴 Cookie」—— 那对被限流的用户是误导（2026-10-13 实测反馈）。 */
      return json(res, {
        ok: false, hasCookie: true, error: e.message,
        blocked: v115BlockedNow() ? { remainMin: v115BlockRemain(), msg: V115_BLOCK_MSG } : null
      })
    }
  }
  if (p === '/api/115/lib/add') {   // 把网盘目录收进媒体库（支持一次加多个：body.roots=[{cid,name,path}]，加完只重扫一次；body.acct 指定账号）
    const acct = Math.max(1, parseInt(body.acct, 10) || 1)
    if (!v115Cookie(acct)) return json(res, { ok: false, error: '还没有填写 115 Cookie' })
    const list = Array.isArray(body.roots) && body.roots.length
      ? body.roots
      : [{ cid: body.cid, name: body.name, path: body.path }]     // 兼容旧的单个添加
    const c = v115Cfg(acct)
    const added = []
    let skipped = 0, bad = 0
    for (const r of list) {
      const cid = String((r && r.cid) || '').replace(/[^\d]/g, '')
      if (!cid) { bad++; continue }
      if (c.roots.some(x => String(x.cid) === cid)) { skipped++; continue }
      const name = String((r && r.name) || '').trim()
      const pth = String((r && r.path) || '').trim().replace(/^\/+|\/+$/g, '')
      const root = { cid, name: name || pth || cid, path: pth, acct }
      c.roots.push(root)
      added.push(root)
    }
    if (!added.length && !skipped && bad) return json(res, { ok: false, error: '缺少目录 id（请先在浏览里勾选目标文件夹）' })
    /* 2026-10-14：收录后**只扫新收录的这几个根**（定向扫描），不再全库重扫 ——
     * 全库重扫要把 115 整树重走一遍，又慢又喂风控；移出媒体库那条路仍走全量（要把条目摘出去）。 */
    if (added.length) { writeCfg(); rescan({ roots: added.map(r => ({ kind: 'v115', root: r })) }) }
    console.log('[115' + (acct > 1 ? '@' + acct : '') + '] 收录目录：新增 ' + added.length + '（' + added.map(a => a.name).join('、') + '），重复跳过 ' + skipped + '，无效 ' + bad)
    return json(res, {
      ok: true, acct, added: added.length, addedNames: added.map(a => a.name), skipped: skipped, invalid: bad,
      roots: v115Roots(acct), stats: v115Stats(acct), scanning: SCAN.running
    })
  }
  if (p === '/api/115/lib/remove') {   // 移出媒体库（只删配置，网盘文件不动；body.acct 指定账号）
    const acct = Math.max(1, parseInt(body.acct, 10) || 1)
    const c = v115Cfg(acct)
    const before = c.roots.length
    /* 批量：body.cids=[...]（编辑弹层里逐行删）/ body.all=true（卡片上「删除媒体源」＝清空这个来源）。
     * 都只写一次配置、只重扫一次 —— 逐条删会触发多次 rescan。 */
    if (body.all === true || Array.isArray(body.cids)) {
      const set = body.all === true ? null : body.cids.map(x => String(x).replace(/[^\d]/g, ''))
      c.roots = set ? c.roots.filter(r => set.indexOf(String(r.cid)) < 0) : []
    } else {
      const cid = String(body.cid || '').replace(/[^\d]/g, '')
      c.roots = c.roots.filter(r => String(r.cid) !== cid)
    }
    const removed = before - c.roots.length
    if (removed > 0) { writeCfg(); rescan() }
    return json(res, { ok: true, acct, removed: removed, roots: v115Roots(acct), stats: v115Stats(acct), scanning: SCAN.running })
  }
  if (p === '/api/115/lib/config') {   // 自定义直链接口模板（内置接口失效时的兜底） + 清直链缓存（body.acct 指定账号）
    const acct = Math.max(1, parseInt(body.acct, 10) || 1)
    const c = v115Cfg(acct)
    if ('linkTpl' in body) c.linkTpl = String(body.linkTpl || '').trim()
    if (body.clearUrlCache) V115_URL = new Map()
    writeCfg()
    return json(res, { ok: true, acct, linkTpl: c.linkTpl, cacheCleared: !!body.clearUrlCache })
  }
  if (p === '/api/115/lib/stream') {   // 备用播放入口（正常播放走 /media/115:/…）
    const q = new URL(req.url, 'http://x')
    const pick = String(q.searchParams.get('pick') || '').trim()
    const acct = Math.max(1, parseInt(q.searchParams.get('acct'), 10) || 1)
    if (!pick) { res.writeHead(400); return res.end('缺少 pick') }
    let down = null
    try { down = await v115DownURL(pick, acct, 'high') }
    catch (e) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(v115PlayErrText(e, acct)) }
    return v115Proxy(req, res, down.url, pick, '115:/x.mp4', 0, down.cookie)
  }
  if (p === '/api/115/lib/prefetch') {   // 播放直链预热（2026-10-16）
    /* 详情页一打开就先取一次直链、塞进 V115_URL 缓存（4 分钟有效），点「播放」时 /media 直接用缓存 → 秒开。
     * 为什么需要：取直链要过 115 节流闸门，扫描/刮削在跑时本来要排队（实测最坏 25s+）；
     * 预热把这段等待挪到「用户还在看详情页」的时候，点播放只剩本地一跳。
     * 节流控制（不额外增加风控压力）：① 已有新鲜缓存 → 一个请求都不发；② 全局最快 2.5s 一次；
     * ③ 风控冷却中直接跳过；④ 只预热 115 条目。失败不报错（真播的时候还会再取一次）。 */
    const q = new URL(req.url, 'http://x')
    const rel = String(q.searchParams.get('rel') || '')
    if (!v115Rel(rel)) return json(res, { ok: false, why: 'not115' })
    const pn = (v115RelParse(rel) || { n: 1 }).n
    const pick = v115PickOf(rel)
    if (!pick) return json(res, { ok: false, why: 'nopick' })
    const hit = V115_URL.get(pn + '|' + pick)
    if (hit && hit.exp > Date.now()) return json(res, { ok: true, cached: true })
    if (v115BlockedNow()) return json(res, { ok: false, why: 'blocked' })
    const now = Date.now()
    if (now - V115_PREF_LAST < 2500) return json(res, { ok: false, why: 'rate' })
    V115_PREF_LAST = now
    /* 后台预热：不等它 —— 用户可能只在详情页停 1 秒；失败就算了（真播时会再取一次并给出完整错误） */
    v115DownURL(pick, pn, 'high')
      .then(u => { if (u && u.url) console.log('[115] 直链预热就绪：' + rel.slice(0, 90)) })
      .catch(e => console.log('[115] 直链预热失败：' + ((e && e.message) || e)))
    return json(res, { ok: true, warming: true })
  }
  /* ---------- WebDAV / 光鸭网盘「媒体库来源」----------
   * 两个来源共用 davApiRoute()：区别只有 CFG 键名（webdav/guangya）与 relVideo 前缀（dav:/ gy:/）。 */
  const davApiRoute = async (kind, p, body, res) => {
    const label = davLabel(kind)
    /* acct：多账号（2026-10-14）。GET 用 ?acct=，POST 用 body.acct；缺省 1（老行为不变）。 */
    const qAcct = () => {
      try { return Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('acct'), 10) || 1) } catch (_) { return 1 }
    }
    if (p === '/api/' + kind + '/config') {
      if (req.method === 'GET') {
        const n = qAcct()
        const c = davCfg(kind, n)
        const isApi = kind === 'guangya' && gyIsApi(kind, n)
        const auth = DAV_AUTH[davInst(kind, n)] || {}
        return json(res, {
          ok: true, acct: n, name: c.name || (n > 1 ? (DAV_DEFNAME[kind] + ' ' + n) : DAV_DEFNAME[kind]),
          url: c.url || '', user: c.user || '', hasPass: !!c.pass, ready: davReady(kind, n),
          mode: kind === 'guangya' ? (isApi ? 'api' : 'webdav') : 'webdav',
          account: kind === 'guangya' ? (c.account || '') : '',
          hasToken: kind === 'guangya' ? !!(String(c.accessToken || '').trim() || String(c.refreshToken || '').trim()) : false,
          authOk: davReady(kind, n) ? (auth.ok === undefined ? null : auth.ok) : null, authErr: auth.err || '',
          roots: davRoots(kind, n), stats: davStats(kind, n),
          space: davQuotaCached(kind, n)
        })
      }
      const n = Math.max(1, parseInt(body.acct, 10) || 1)
      const c = davCfg(kind, n)
      /* 名称：媒体源卡片显示名（空 = 用默认「WebDAV / 光鸭网盘」） */
      if ('name' in body) c.name = String(body.name || '').trim().slice(0, 30)
      if ('url' in body) c.url = String(body.url || '').trim().replace(/\/+$/, '')
      if ('user' in body) c.user = String(body.user || '').trim()
      /* 密钥支持「留空 = 不改」：表单把已保存的密钥显示成占位符，只在真的输入了新值时才覆盖 */
      if ('pass' in body && String(body.pass || '') !== '') c.pass = String(body.pass)
      if (body.clearPass) c.pass = ''
      /* 光鸭登录途径切换 / 断开：clearToken 连 token 一起清（卡片会随之隐藏，等重新添加） */
      if (kind === 'guangya') {
        if (body.mode === 'api' || body.mode === 'webdav') c.mode = body.mode
        if (body.clearToken) {
          c.accessToken = ''; c.refreshToken = ''; c.tokenExp = 0; c.account = ''
          GY_USERS[n] = null
        }
      }
      writeCfg()
      /* 换了地址/凭据 → 旧快照与容量缓存全部作废（地址都换了，还拿着旧目录列表就是错误信息） */
      const inst = davInst(kind, n)
      for (const k of Array.from(DAV_SNAP.keys())) if (k.startsWith(inst + ' ')) DAV_SNAP.delete(k)
      DAV_QUOTA[inst] = null
      DAV_AUTH[inst] = { ok: null, err: '' }
      console.log('[' + inst + '] 配置已保存：url=' + (c.url || '(空)') + ' user=' + (c.user || '(空)') + ' roots=' + c.roots.length +
        (kind === 'guangya' ? ' mode=' + (gyIsApi(kind, n) ? 'api' : 'webdav') : ''))
      srcHealthProbeNow(inst)   // 改了地址/密钥就立刻复检：对了马上翻绿，错了马上告诉你错在哪（2026-10-15）
      return json(res, { ok: true, acct: n, name: c.name || (n > 1 ? (DAV_DEFNAME[kind] + ' ' + n) : DAV_DEFNAME[kind]), ready: davReady(kind, n) })
    }
    if (p === '/api/' + kind + '/test') {   // 连接测试：PROPFIND 根目录，附带把容量一并探回来
      const n = Math.max(1, parseInt(body.acct, 10) || qAcct())
      if (!davReady(kind, n)) return json(res, { ok: false, error: '请先填写服务器地址、账号和密钥' })
      const t0 = Date.now()
      return davQuota(kind, true, n).then(space => {
        const auth = DAV_AUTH[davInst(kind, n)] || {}
        return json(res, { ok: auth.ok !== false, acct: n, ms: Date.now() - t0, error: auth.err || '',
          space, url: davBase(kind, n) })
      }).catch(e => json(res, { ok: false, error: e.message }))
    }
    if (p === '/api/' + kind + '/lib') {   // 状态：凭据是否齐 + 已收录根目录 + 收录统计（多账号：accts 数组逐账号一份）
      const accts = davAcctListAll(kind).map(n => {
        const c = davCfg(kind, n), auth = DAV_AUTH[davInst(kind, n)] || {}
        const isApi = kind === 'guangya' && gyIsApi(kind, n)
        return {
          acct: n, key: davInst(kind, n),
          name: n > 1 ? (c.name || (DAV_DEFNAME[kind] + ' ' + n)) : (c.name || DAV_DEFNAME[kind]),
          ready: davReady(kind, n), mode: kind === 'guangya' ? (isApi ? 'api' : 'webdav') : 'webdav',
          account: kind === 'guangya' ? (c.account || '') : (c.user || ''),
          roots: davRoots(kind, n).map(r => Object.assign({}, r, { acct: n })),
          stats: davStats(kind, n)
        }
      })
      return json(res, { ok: true, accts, ready: davReady(kind, 1), roots: davRoots(kind, 1), stats: davStats(kind, 1), mapped: DAV_MAP.size })
    }
    if (p === '/api/' + kind + '/lib/browse') {   // 浏览网盘目录（只列一层，前端逐级下钻 + 多选）
      const q = new URL(req.url, 'http://x')
      const bpath = String(q.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '')
      const n = Math.max(1, parseInt(q.searchParams.get('acct'), 10) || 1)
      if (!davReady(kind, n)) return json(res, { ok: false, error: '请先填写 ' + label + ' 的服务器地址、账号和密钥' })
      try {
        /* force=true：浏览是用户主动操作，必须看实时目录，不走 10 分钟快照 */
        const items = await davList(kind, bpath, true, n)
        const dirs = items.filter(x => x.isDir).map(x => ({ path: x.path.replace(/^\/+/, ''), name: x.name }))
        const vids = items.filter(x => !x.isDir && VIDEO_EXT.includes(extOf(x.name)))
        return json(res, { ok: true, acct: n, path: bpath, dirs, videos: vids.length, samples: vids.slice(0, 5).map(x => x.name) })
      } catch (e) { return json(res, { ok: false, error: e.message }) }
    }
    if (p === '/api/' + kind + '/lib/add') {   // 收录目录进媒体库（body.roots=[{path,name}]，加完只重扫一次；body.acct 指定账号）
      const n = Math.max(1, parseInt(body.acct, 10) || 1)
      if (!davReady(kind, n)) return json(res, { ok: false, error: '请先填写 ' + label + ' 的服务器地址、账号和密钥' })
      const list = Array.isArray(body.roots) && body.roots.length ? body.roots : [{ path: body.path, name: body.name }]
      const c = davCfg(kind, n)
      const added = []
      let skipped = 0, bad = 0
      for (const r of list) {
        const pth = String((r && r.path) || '').trim().replace(/^\/+|\/+$/g, '')
        if (!pth) { bad++; continue }
        if (c.roots.some(x => String(x.path || '').replace(/^\/+|\/+$/g, '') === pth)) { skipped++; continue }
        const name = String((r && r.name) || '').trim()
        const root = { path: pth, name: name || pth, acct: n }
        c.roots.push(root)
        added.push(root)
      }
      if (!added.length && !skipped) return json(res, { ok: false, error: bad ? '目录路径无效' : '没有可添加的目录' })
      /* 收录后只扫新根（定向扫描），不全库重扫 —— 同 /api/115/lib/add 的 2026-10-14 改动 */
      if (added.length) {
        writeCfg()
        for (const k of Array.from(DAV_SNAP.keys())) if (k.startsWith(davInst(kind, n) + ' ')) DAV_SNAP.delete(k)
        rescan({ roots: added.map(r => ({ kind, root: r })) })
      }
      console.log('[' + davInst(kind, n) + '] 收录目录：新增 ' + added.length + '（' + added.map(a => a.name).join('、') + '），重复跳过 ' + skipped + '，无效 ' + bad)
      return json(res, { ok: true, acct: n, added: added.length, addedNames: added.map(a => a.name), skipped,
        invalid: bad, roots: davRoots(kind, n), stats: davStats(kind, n), scanning: SCAN.running })
    }
    if (p === '/api/' + kind + '/lib/remove') {   // 移出媒体库（只删配置，网盘文件不动；body.acct 指定账号）
      const n = Math.max(1, parseInt(body.acct, 10) || 1)
      const c = davCfg(kind, n)
      const normP = s => String(s || '').replace(/^\/+|\/+$/g, '')
      const before = c.roots.length
      if (body.all === true) c.roots = []
      else if (Array.isArray(body.paths)) { const set = body.paths.map(normP); c.roots = c.roots.filter(r => set.indexOf(normP(r.path)) < 0) }
      else c.roots = c.roots.filter(r => normP(r.path) !== normP(body.path))
      const removed = before - c.roots.length
      if (removed > 0) { writeCfg(); rescan() }
      return json(res, { ok: true, acct: n, removed, roots: davRoots(kind, n), stats: davStats(kind, n), scanning: SCAN.running })
    }
    /* ---------- 光鸭专有：官方接口登录（短信验证码 / 粘贴 Token）----------
     * 登录中间态存 GY_SMS（10 分钟有效）；成功后 token 落 CFG.guangya[.x]，mode='api'。
     * 多账号（2026-10-14）：body.acct 指定登录到哪个账号槽（缺省 1 = 老行为）。 */
    if (kind === 'guangya') {
      if (p === '/api/guangya/sms/send' && req.method === 'POST') {
        const n = Math.max(1, parseInt(body.acct, 10) || 1)
        /* ⚠ 手机号必须规范成官方要求的「+86 13800138000」形态：少区号在 signin 会被 HTTP 400 拒掉
         *   （2026-10-13 用户实测报的「登录失败：HTTP 400」就是这个）。四步登录全程用同一个串。 */
        const phone = gyNormPhone(body.phone)
        if (!phone) return json(res, { ok: false, error: '手机号格式不对（填 13800138000 即可，会自动补 +86）' })
        /* captcha_token：与 AList GuangYaPan 驱动一致，也是**可人工填**的一项
         * （AList 文档：「如果页面要求 captcha_token，先按提示完成验证码校验，再填写验证码」）。
         * 两条路：用户填了就用他过完人机的 token；没填就自己向 /v1/shield/captcha/init 要一个。 */
        const manualCaptcha = String(body.captchaToken || '').trim()
        try {
          let captchaToken = manualCaptcha
          if (!captchaToken) {
            const init = await gyFetch(GY_ACC_BASE + '/v1/shield/captcha/init', {
              headers: gyAccHeaders(n), json: {
                client_id: GY_CLIENT_ID, action: 'POST:/v1/auth/verification',
                device_id: gyDid(n), meta: { phone_number: phone }
              }
            })
            const d0 = gyUnwrap(init.j) || {}
            captchaToken = d0.captcha_token || ''
            if (!captchaToken) {
              /* init 没给 captcha_token：多半触发了网页端人机验证（滑块）——
               * 让用户自己去网页过一遍，把拿到的 captcha_token 填回来（AList 就是这么做的）。 */
              const why = gyErrDetail(init.status, init.j, init.text)
              if (/captcha|verify|challenge|slide|人机/i.test(why)) {
                return json(res, { ok: false, needCaptcha: true, error: '光鸭要求先过网页人机验证，短信发不出去。请到 guangyapan.com 触发一次登录验证（F12 → Network 里搜 captcha）把 captcha_token 填到上面的输入框，或改用「粘贴 Token」方式登录。' })
              }
              return json(res, { ok: false, error: '验证码初始化失败：' + why })
            }
          }
          const sent = await gyFetch(GY_ACC_BASE + '/v1/auth/verification', {
            headers: gyAccHeaders(n, { 'x-captcha-token': captchaToken }),
            json: { phone_number: phone, target: 'ANY', client_id: GY_CLIENT_ID }
          })
          const d1 = gyUnwrap(sent.j) || {}
          if (sent.status !== 200 || !d1.verification_id) {
            return json(res, { ok: false, error: '验证码发送失败：' + gyErrDetail(sent.status, sent.j, sent.text) })
          }
          GY_SMS.phone = phone; GY_SMS.captchaToken = captchaToken
          GY_SMS.verificationId = d1.verification_id; GY_SMS.t = Date.now(); GY_SMS.acct = n
          console.log('[guangya' + (n > 1 ? '@' + n : '') + '] 短信验证码已发送：' + gyMask(phone))
          return json(res, { ok: true, acct: n, phone: gyMask(phone) })
        } catch (e) { return json(res, { ok: false, error: e.message }) }
      }
      if (p === '/api/guangya/sms/verify' && req.method === 'POST') {
        if (!GY_SMS.verificationId || Date.now() - GY_SMS.t > 10 * 60 * 1000) {
          return json(res, { ok: false, error: '登录会话已过期，请重新发送验证码' })
        }
        const n = Math.max(1, parseInt(body.acct, 10) || GY_SMS.acct || 1)
        const code = String(body.code || '').trim()
        if (!code) return json(res, { ok: false, error: '请输入收到的短信验证码' })
        try {
          const vf = await gyFetch(GY_ACC_BASE + '/v1/auth/verification/verify', {
            headers: gyAccHeaders(n),
            json: { verification_id: GY_SMS.verificationId, verification_code: code, client_id: GY_CLIENT_ID }
          })
          const d2 = gyUnwrap(vf.j) || {}
          /* 验证码是一次性的（AList 文档同样注明）——失败多为「填错」或「这条码已经用过」 */
          if (!d2.verification_token) return json(res, { ok: false, error: '验证码不对或已被使用（光鸭验证码一次性，一次登录只能用一个）：请重新「发送验证码」再试 → ' + gyErrDetail(vf.status, vf.j, vf.text) })
          const si = await gyFetch(GY_ACC_BASE + '/v1/auth/signin', {
            headers: gyAccHeaders(n, { 'x-captcha-token': GY_SMS.captchaToken }),
            json: {
              verification_code: code, verification_token: d2.verification_token,
              username: GY_SMS.phone, client_id: GY_CLIENT_ID
            }
          })
          const d3 = gyUnwrap(si.j) || {}
          if (si.status !== 200 || !d3.access_token) {
            return json(res, { ok: false, error: '登录失败：' + gyErrDetail(si.status, si.j, si.text) })
          }
          const c = davCfg('guangya', n)
          c.mode = 'api'
          c.accessToken = d3.access_token
          c.refreshToken = String(d3.refresh_token || '') || c.refreshToken
          if (d3.expires_in) c.tokenExp = Date.now() / 1000 + Number(d3.expires_in)
          writeCfg()
          const inst = davInst('guangya', n)
          for (const k of Array.from(DAV_SNAP.keys())) if (k.startsWith(inst + ' ')) DAV_SNAP.delete(k)
          DAV_QUOTA[inst] = null
          DAV_AUTH[inst] = { ok: true, err: '' }
          GY_USERS[n] = null
          GY_SMS.verificationId = ''
          gyUserInfo(n, true).catch(() => {})      // 后台补账号名/容量，不阻塞登录返回
          srcHealthProbeNow(inst)                  // 登录成功 → 立刻复检一次，卡片马上从「登录失效」翻绿（2026-10-15）
          console.log('[guangya' + (n > 1 ? '@' + n : '') + '] 短信验证码登录成功：' + gyMask(GY_SMS.phone))
          return json(res, { ok: true, acct: n, mode: 'api', user: c.account || gyMask(GY_SMS.phone) })
        } catch (e) { return json(res, { ok: false, error: e.message }) }
      }
      if (p === '/api/guangya/token' && req.method === 'POST') {
        /* 粘贴 Token：网页版 guangyapan.com 登录后 F12 → 应用 → Local Storage → token 键里的
         * access_token / refresh_token。填 refresh_token 最划算（能自动续期）。 */
        const n = Math.max(1, parseInt(body.acct, 10) || 1)
        const at = String(body.accessToken || '').trim()
        const rt = String(body.refreshToken || '').trim()
        if (!at && !rt) return json(res, { ok: false, error: '请粘贴 access_token 或 refresh_token（至少一个）' })
        const c = davCfg('guangya', n)
        c.mode = 'api'
        if (at) c.accessToken = at
        if (rt) c.refreshToken = rt
        c.tokenExp = 0
        if ('name' in body) c.name = String(body.name || '').trim().slice(0, 30)
        writeCfg()
        const inst = davInst('guangya', n)
        for (const k of Array.from(DAV_SNAP.keys())) if (k.startsWith(inst + ' ')) DAV_SNAP.delete(k)
        DAV_QUOTA[inst] = null
        DAV_AUTH[inst] = { ok: null, err: '' }
        GY_USERS[n] = null
        /* 验活：user/me 打得通才算真的登录上了（失败也保存，给 warning 让用户自己看） */
        try {
          const u = await gyUserInfo(n, true)
          srcHealthSet(inst, 'ok', '')      // 验活通了 → 健康表立刻翻绿（卡片同步，2026-10-15）
          return json(res, { ok: true, acct: n, mode: 'api', user: (u && u.user) || '' })
        } catch (e) {
          srcHealthSet(inst, 'auth', e.message)
          return json(res, { ok: true, acct: n, warn: 'Token 已保存，但验活没通过：' + e.message, mode: 'api' })
        }
      }
      if (p === '/api/guangya/logout' && req.method === 'POST') {
        const n = Math.max(1, parseInt(body.acct, 10) || 1)
        const c = davCfg('guangya', n)
        c.accessToken = ''; c.refreshToken = ''; c.tokenExp = 0; c.account = ''; c.mode = ''
        GY_USERS[n] = null
        writeCfg()
        const inst = davInst('guangya', n)
        for (const k of Array.from(DAV_SNAP.keys())) if (k.startsWith(inst + ' ')) DAV_SNAP.delete(k)
        DAV_QUOTA[inst] = null
        DAV_AUTH[inst] = { ok: null, err: '' }
        return json(res, { ok: true, acct: n })
      }
      /* 光鸭「新增账号」：清空一个空槽，让前端表单知道下一个可用账号号 */
      if (p === '/api/guangya/acct/next' && req.method === 'GET') {
        return json(res, { ok: true, acct: davAcctNext('guangya') })
      }
    }
    return null
  }
  for (const dk of DAV_KINDS) {
    const hit = await davApiRoute(dk, p, body, res)
    if (hit !== null) return hit
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
  /* ⚠ 海报墙缩略图 /thumb/<番号>/<poster|fanart> 的路由已挪到主 createServer 处理器里。
   * 原来它写在这儿（handleActorApi 内部），而 handleActorApi 只被 /api/actor|offline|import|scrape|images
   * 这几类路径调用 —— /thumb/ 永远进不来，前端 thumbOf() 改写后全部 404，再静默回退全尺寸原图，
   * 于是「缩略图优化」等于没生效，首页铺几百张 1MB 海报（Mac 上尤其慢，因为还没 ffmpeg）。 */

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
  /* ---------- 女优人气榜：手动更新 / 状态（每日自动更新由内置定时器负责） ---------- */
  if (p === '/api/rank/update') {
    if (RANKUP.running) return json(res, { ok: false, error: '排行榜正在更新中（' + (RANKUP.phase || '') + '）' })
    rankUpdateAsync().catch(() => {})
    return json(res, { ok: true, started: true })
  }
  if (p === '/api/rank/status') return json(res, { ok: true, running: RANKUP.running, phase: RANKUP.phase, error: RANKUP.error, added: RANKUP.added, count: RANKUP.count, finishedAt: RANKUP.finishedAt, updatedAt: rankUpdatedAt(), rankAuto: CFG.rankAuto !== false, rankHour: rankHour() })
  /* ---------- 网盘死链检测：POST 开始 / 停止 / 清空，GET 查状态与结果 ---------- */
  if (p === '/api/audit/deadlink') {
    if (req.method === 'GET') {
      return json(res, {
        ok: true, running: DL.running, at: DL.at, total: DL.total, done: DL.done,
        dead: DL.dead, note: DL.note, err: DL.err
      })
    }
    const act = String((body && body.act) || 'run')
    if (act === 'stop') { DL.cancel = true; return json(res, { ok: true }) }
    if (act === 'clear') { DL.dead = []; DL.at = 0; DL.note = ''; dlSave(); return json(res, { ok: true }) }
    return json(res, await dlScan())
  }
  /* ---------- 女优名册自动同步：GET 查状态 / POST 立即拉一次（每日自动由内置定时器负责） ---------- */
  if (p === '/api/roster/sync') {
    if (req.method === 'GET') {
      const st = rosterSyncState()
      return json(res, {
        ok: true, running: ROSTER_SYNC.running, phase: ROSTER_SYNC.phase, error: ROSTER_SYNC.error,
        count: rosterCount(), last: st.last || 0, before: st.before || 0, remote: st.remote || 0,
        added: st.added || 0, filled: st.filled || 0, skipped: !!st.skipped, note: st.note || '', remoteSize: st.remoteSize || 0,
        auto: CFG.rosterSync !== false, hour: rosterSyncHour()
      })
    }
    if (ROSTER_SYNC.running) return json(res, { ok: false, error: '名册同步中（' + (ROSTER_SYNC.phase || '') + '）' })
    rosterSyncOnce('manual').catch(() => {})
    return json(res, { ok: true, started: true })
  }
  if (p === '/api/config/test') {
    /* 线路延迟测试（v0.2.29）：只测「这条代理线路本身」的延迟，不绑任何具体网站。
     * 目标用中立的连通性检测端点（微软 NCSI connecttest.txt，国内外直连/经代理都可达）。
     * 注意必须走 HTTP 80：该域名的 HTTPS 在国内会被解析到没有证书的 Akamai 节点（实测）。
     * 经 http 代理用 absolute-form GET（代理测延迟的标准做法），连测 3 次回每次耗时 + 平均。 */
    /* 对齐 mdc-ng proxyConnectionTest：成功 = HTTP 200–399；代理地址缺协议前缀时补 http://（mdc-ng 是直接报错，这里更宽容） */
    let pv = body.proxy !== undefined ? String(body.proxy || '').trim() : proxyUrl()
    if (pv && !/^(https?|socks4|socks5):\/\//i.test(pv)) pv = 'http://' + pv
    const lineProbe = () => new Promise(resolve => {
      const t0 = Date.now()
      const done = r => resolve(Object.assign({ ms: Date.now() - t0 }, r))
      try {
        const u = new URL('http://www.msftconnecttest.com/connecttest.txt')
        let rq
        if (pv) {
          const pu = new URL(pv)
          rq = http.request({ host: pu.hostname, port: Number(pu.port) || 80, path: 'http://www.msftconnecttest.com/connecttest.txt', method: 'GET', headers: { host: u.hostname, 'user-agent': MN_UA, accept: '*/*' } },
            rs => { rs.resume(); done({ ok: rs.statusCode >= 200 && rs.statusCode < 400, status: rs.statusCode }) })
        } else {
          rq = http.request({ host: u.hostname, path: u.pathname, method: 'GET', headers: { host: u.hostname, 'user-agent': MN_UA, accept: '*/*' } },
            rs => { rs.resume(); done({ ok: rs.statusCode >= 200 && rs.statusCode < 400, status: rs.statusCode }) })
        }
        rq.setTimeout(8000, () => { try { rq.destroy(new Error('超时')) } catch (_) {} done({ ok: false, error: '超时' }) })
        rq.on('error', e => done({ ok: false, error: e.message }))
        rq.end()
      } catch (e) { done({ ok: false, error: e.message }) }
    })
    const samples = []
    for (let i = 0; i < 3; i++) { samples.push(await lineProbe()); if (i < 2) await new Promise(s => setTimeout(s, 300)) }
    const okN = samples.filter(x => x.ok)
    const avg = okN.length ? Math.round(okN.reduce((s, x) => s + x.ms, 0) / okN.length) : 0
    const bad = samples.find(x => !x.ok) || {}
    const errText = bad.error ? bad.error : (bad.status ? '代理请求失败：HTTP ' + bad.status : '无响应')
    /* 出口 IP 归属地（2026-10-01）：测通后顺路查一次出口 IP 的国家/地区（ip-api.com 免费端点，
     * 中文国名、http-only，与上面的线路探测同一条路 —— 开代理就查代理出口，直连就查本机出口）。
     * 查不到不报错：geo 为 null 时前端只省略这半句，不影响测速结果本身。 */
    const geoProbe = () => new Promise(resolve => {
      const GHOST = 'ip-api.com'
      const GPATH = '/json/?fields=status,country,countryCode,query&lang=zh-CN'
      const fin = txt => { try { const g = JSON.parse(txt); resolve(g && g.status === 'success' ? { ip: g.query, country: g.country, cc: g.countryCode } : null) } catch (_) { resolve(null) } }
      try {
        let rq
        if (pv) {
          const pu = new URL(pv)
          rq = http.request({ host: pu.hostname, port: Number(pu.port) || 80, path: 'http://' + GHOST + GPATH, method: 'GET', headers: { host: GHOST, 'user-agent': MN_UA, accept: '*/*' } },
            rs => { let b = ''; rs.on('data', c => { b += c }); rs.on('end', () => fin(b)); rs.resume() })
        } else {
          rq = http.request({ host: GHOST, path: GPATH, method: 'GET', headers: { host: GHOST, 'user-agent': MN_UA, accept: '*/*' } },
            rs => { let b = ''; rs.on('data', c => { b += c }); rs.on('end', () => fin(b)); rs.resume() })
        }
        rq.setTimeout(5000, () => { try { rq.destroy(new Error('超时')) } catch (_) {} resolve(null) })
        rq.on('error', () => resolve(null))
        rq.end()
      } catch (_) { resolve(null) }
    })
    const geo = okN.length ? await geoProbe() : null
    return json(res, { ok: okN.length > 0, via: pv || 'direct', avg, samples, error: okN.length ? '' : errText, geo })
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
  /* 女优详情页「识别刮削」：按 minnano 现况核对单人资料，有变化（含改名识别）直接写回名册。
   * 与每日同步脚本同一套解析/改名口径；头像只在本地没有时补 —— 铁律：统一暂存 cache/actor-cand/，不直接写 actresses/。
   * body: { name, idx }（idx 越界 = 附加名册/媒体库孤儿 → 按名在附加名册里找，没有就建档）。 */
  if (p === '/api/actor/sync') {
    try {
      const nm = String(body.name || '').trim()
      if (!nm) return json(res, { ok: false, error: '缺少女优名' })
      const idx = body.idx | 0
      let list = []
      try { list = JSON.parse(fs.readFileSync(ROSTER, 'utf8')) } catch (_) {}
      let rec = null, local = false, exList = null, created = false
      if (idx >= 0 && idx < list.length && list[idx] && list[idx].name === nm) {
        rec = list[idx]
      } else {
        exList = readExtraRoster()
        rec = exList.find(r => r.name === nm) || null
        local = true
        if (!rec) {
          /* 名册里没有（媒体库解析出的孤儿女优）→ 建附加名册档 */
          created = true
          rec = { uid: 'local', lid: 'lo' + require('crypto').createHash('sha1').update(nm).digest('hex').slice(0, 12), name: nm, videoCount: 0 }
        }
      }
      /* 定位 mnid：记录里有 → 直接用；没有 → 按名搜索（唯一命中或名字/别名精确匹配才认）；
       * minnano 直连不可达时回落 relay 名册（CI 每日全量同步，T+1 数据） */
      let via = 'minnano'
      let mnid = String(rec.mnid || '').replace(/\D/g, '')
      if (!mnid) {
        const s = await mnSearchActress(rec.name)
        const cand = s.exact || (((s.list || []).find(x => x.name === rec.name || (Array.isArray(rec.alias) && rec.alias.includes(x.name))) || {}).mnid || '')
        if (!cand) {
          const ridx = await relayRosterIndex()
          const rr = ridx && ridx.byName.get(cnormJa(rec.name))
          if (!rr || !rr.mnid) return json(res, { ok: false, error: 'minnano 搜不到该女优，relay 名册也没有（同名多人时请用「✎ 刮削」手动选）' })
          via = 'relay'
          mnid = String(rr.mnid).replace(/\D/g, '')
        } else mnid = String(cand)
      }
      /* 抓资料页：直连失败（家宽 SNI 阻断 / 未配代理）→ relay 名册兜底，数据来自每日 CI 同步 */
      const pr = await mnGetFollow(MN_BASE + 'actress' + mnid + '.html', false)
      let prof = pr && pr.body ? parseMinnanoProfile(pr.body) : null
      if (!prof || (!prof.canon && !prof.height && !prof.birthday)) {
        const ridx = await relayRosterIndex()
        const rr = ridx && (ridx.byMnid.get(String(mnid)) || ridx.byName.get(cnormJa(rec.name)))
        if (!rr) return json(res, { ok: false, error: 'minnano 资料页抓取失败，relay 名册也无此女优（该站需代理，检查设置里的代理配置，或等每日自动同步）' })
        via = 'relay'
        const nocm = v => String(v || '').replace(/cm$/i, '')
        prof = {
          canon: rr.name || rec.name, birthday: rr.birthday || '',
          height: nocm(rr.height), bust: nocm(rr.breast), cup: rr.cup || '',
          waist: nocm(rr.waist), hip: nocm(rr.hip), shoe: nocm(rr.shoe),
          blood: rr.blood || '', place: rr.place || '', hobby: rr.hobby || '',
          period: rr.period || '', debut: rr.debut || '', agency: rr.agency || '', blog: rr.blog || '',
          nick: rr.nick || '', official: rr.official || '',
          avatarUrl: '',   // 头像由 avatarOnline 的 relay 链路兜底，不走 minnano 直连
          alias: Array.isArray(rr.alias) ? rr.alias : [], tags: Array.isArray(rr.tags) ? rr.tags : [],
          rel: Array.isArray(rr.rel) ? rr.rel : []
        }
      }
      const cnorm = cnormJa
      const patch = {}
      const changes = []
      let renamed = null
      /* 改名识别：同 mnid 但站点现用名不同 → 更名 + 旧名进别名（与每日同步同口径，否则按新名查详情会扑空） */
      if (prof.canon && cnorm(prof.canon) !== cnorm(rec.name)) {
        renamed = { from: rec.name, to: prof.canon }
        patch.name = prof.canon
        patch.name_ja = prof.canon
        patch.alias = Array.from(new Set([].concat(rec.alias || [], [rec.name], prof.alias || [])))
        changes.push('改名 ' + rec.name + ' → ' + prof.canon)
      } else if (prof.alias && prof.alias.length) {
        const merged = Array.from(new Set([].concat(rec.alias || [], prof.alias))).filter(x => x && x !== rec.name)
        if (merged.length !== (rec.alias || []).length) { patch.alias = merged; changes.push('别名') }
      }
      const cmv = v => (v ? String(v).replace(/cm$/i, '') + 'cm' : '')
      const put = (k, v, lab) => { if (v && String(v) !== String(rec[k] == null ? '' : rec[k])) { patch[k] = v; changes.push(lab) } }
      put('birthday', prof.birthday, '生年月日')
      put('height', cmv(prof.height), '身高')
      put('breast', cmv(prof.bust), '胸围')
      put('cup', prof.cup, '罩杯')
      put('waist', cmv(prof.waist), '腰围')
      put('hip', cmv(prof.hip), '臀围')
      put('shoe', cmv(prof.shoe), '鞋码')
      put('blood', prof.blood, '血型')
      put('place', prof.place, '出身地')
      put('hobby', prof.hobby, '爱好')
      put('period', prof.period, '出演期间')
      put('debut', prof.debut, '出道作品')
      put('agency', prof.agency, '事务所')
      put('blog', prof.blog, '博客')
      put('nick', prof.nick, '爱称')
      put('official', prof.official, '官网')
      if (Array.isArray(prof.tags) && prof.tags.length && JSON.stringify(prof.tags) !== JSON.stringify(rec.tags || [])) { patch.tags = prof.tags; changes.push('标签') }
      if (Array.isArray(prof.rel) && prof.rel.length && JSON.stringify(prof.rel) !== JSON.stringify(rec.rel || [])) { patch.rel = prof.rel; changes.push('相关女优') }
      if (!rec.msrc) patch.msrc = MN_BASE + 'actress' + mnid + '.html'
      if (String(rec.mnid || '') !== String(mnid)) { patch.mnid = mnid; if (!created) changes.push('补全档案') }
      /* 头像：仅本地没有时补 —— 暂存到 cache/actor-cand/（不直接写 actresses/） */
      if (!rec.icon && prof.avatarUrl) {
        const buf = await fetchImageBuf(prof.avatarUrl)
        if (buf && buf.length > 500) {
          const key = avaKey(rec, mnid)
          const dir = path.join(cacheDir(), 'actor-cand')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, key + '.jpg'), buf)
          patch.icon = '/cache/actor-cand/' + key + '.jpg'
          changes.push('头像')
        }
      }
      if (!changes.length && !Object.keys(patch).length) {
        return json(res, { ok: true, changed: [], renamed: null, created: false, via })
      }
      if (local) {
        if (created) exList.push(rec)
        Object.assign(rec, patch)
        writeExtraRoster(exList)
      } else {
        rosterUpdate(idx, nm, r => Object.assign(r, patch))
      }
      return json(res, { ok: true, changed: changes, renamed, created, via })
    } catch (e) {
      return json(res, { ok: false, error: e.message })
    }
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
  /* 女优重名合并表：GET 读全表；POST 改（set / setMany / unset / clear）。
   * 前端拿到 map 后作废女优名册缓存重算，所以这里的写必须落盘成功再返回 ok。 */
  if (p === '/api/actor/merge') {
    try {
      if (req.method === 'GET') return json(res, { ok: true, map: readMerge() })
      const map = readMerge()
      const act = String(body.action || 'set')
      if (act === 'set') {
        const d = String(body.merged || '').trim()
        if (!mergeAdd(map, d, body.keep)) {
          return json(res, { ok: false, error: '这两个名字已经（或互相）合并过了：先撤销原来那条，或换一个保留名', map })
        }
      } else if (act === 'setMany') {
        const src = (body.map && typeof body.map === 'object') ? body.map : {}
        let n = 0
        for (const d of Object.keys(src)) if (mergeAdd(map, d, src[d])) n++
        if (!n) return json(res, { ok: false, error: '没有可合并的名字（可能都已经合并过了）', map })
      } else if (act === 'unset') {
        delete map[String(body.merged || '').trim()]
      } else if (act === 'clear') {
        for (const k of Object.keys(map)) delete map[k]
      } else {
        return json(res, { ok: false, error: '未知操作：' + act, map })
      }
      writeMerge(map)
      const dk = String(body.merged || '').trim()
      return json(res, { ok: true, map, keep: map[dk] || '', count: Object.keys(map).length })
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
  /* ---------- 媒体源（添加页「媒体源」卡片 + 统计，2026-10-13） ----------
   * 把「视频目录 / 115 网盘」并成一组来源，每个来源一张卡片：影片数、封面数、预览视频数、
   * 视频段数（成/败）与缓存占用。归属规则：relVideo 以 115:/ 开头 = 115 网盘来源，其余 = 本地存储。
   * 目录体量要递归 stat，60s 内存缓存（管理页轮询不卡盘）。 */
  if (p === '/api/sources/media') {
    if (req.method === 'GET') {
      const now = Date.now()
      /* fresh=1（卡片右键「刷新容量与统计」）= 用户明确要最新 → 同步重算等他
       * ⚠ 这个变量必须在本块内定义（2026-10-15 重写时漏掉 → 接口全程抛 "fresh is not defined"、
       *   媒体源卡片整片空白，用户报「状态都不显示」）。 */
      const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1'
      /* stale-while-revalidate：sourcesPayload 要遍历全部番号目录的 images/（实测 ~1900 条要 2s），
       * 60s 缓存一过期用户进页面就干等 —— 有旧数据先秒回旧的，后台静默重建，下一轮自动是新的。 */
      if (!SRC_CACHE.data || fresh) SRC_CACHE = { at: now, data: sourcesPayload(fresh) }
      else if (now - SRC_CACHE.at >= SRC_TTL && !SRC_REBUILDING) {
        SRC_REBUILDING = true
        setImmediate(() => { try { SRC_CACHE = { at: Date.now(), data: sourcesPayload() } } catch (_) {} finally { SRC_REBUILDING = false } })
      }
      /* 容量/会员还没拉过（或已过期）→ 后台补一发；下一轮卡片刷新就有数据，本请求不等它。
       * 拿到后把统计缓存标记过期（at=0）→ 下一次请求走 SWR 后台重建，卡片上就能显示容量/会员行（2026-10-15）。 */
      for (const n of v115AcctList()) if (v115Cookie(n) && !v115UserCached(n)) {
        v115UserInfo(false, n).then(() => { SRC_CACHE.at = 0 }).catch(() => {})
      }
      return json(res, SRC_CACHE.data)
    }
    return json(res, { ok: false, error: '只支持 GET' })
  }
  /* ---------- 来源健康（2026-10-15）：掉线自愈的状态出口 ----------
   * GET  /api/srchealth        → 各来源当前状态 + 原因 + 上次/下次复检时间（前端画状态点、恢复时弹提示）
   * POST /api/srchealth/probe  → 立刻复检某个 key（卡片上的「重连」按钮）或全部（key 省略） */
  if (p === '/api/srchealth') {
    if (req.method !== 'GET') { res.writeHead(405); return res.end() }
    srcHealthSeed()
    return json(res, {
      ok: true, at: Date.now(),
      list: Object.keys(SRC_HEALTH).map(k => Object.assign({}, SRC_HEALTH[k])),
      down: Object.keys(SRC_HEALTH).filter(k => SRC_HEALTH[k].state !== 'ok' && SRC_HEALTH[k].state !== 'unknown')
    })
  }
  if (p === '/api/srchealth/probe') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const key = String(body.key || '').trim()
    if (key) {
      if (srcHealthKeys().indexOf(key) < 0) return json(res, { ok: false, error: '没有这个来源：' + key })
      await srcHealthProbe(key)
      return json(res, { ok: true, key, health: srcHealthOf(key) })
    }
    const keys = srcHealthKeys()
    for (const k of keys) { try { await srcHealthProbe(k) } catch (_) {} }
    return json(res, { ok: true, list: keys.map(k => Object.assign({}, srcHealthOf(k))) })
  }
  if (p === '/api/library') {
    return json(res, {
      ok: true, root: MEDIA_ROOT, hostPath: readMediaPathFile() || '', native: NATIVE,
      libraries: LIBS, libs: libStats(), scanning: SCAN.running,
      /* 115 网盘来源（与本地库并列，不属于 LIBS）：Cookie 状态 + 网盘根目录 + 收录统计（多账号：accts 逐账号一份） */
      v115: {
        hasCookie: !!v115Cookie(1), roots: v115Roots(1), stats: v115Stats(1),
        accts: v115AcctListAll().map(n => ({
          acct: n, key: n > 1 ? 'pan115@' + n : 'pan115',
          name: n > 1 ? (v115Cfg(n).name || ('115 网盘 ' + n)) : (v115Cfg(n).name || '115 网盘'),
          hasCookie: !!v115Cookie(n), roots: v115Roots(n), stats: v115Stats(n)
        })),
        blocked: v115BlockedNow() ? { remainMin: v115BlockRemain(), msg: V115_BLOCK_MSG } : null
      },
      /* WebDAV / 光鸭网盘来源：连接状态 + 根目录 + 收录统计（设置页/管理面板用；多账号：每账号一条） */
      dav: DAV_KINDS.flatMap(kind => davAcctListAll(kind).map(n => {
        const c = davCfg(kind, n)
        const auth = DAV_AUTH[davInst(kind, n)] || { ok: null, err: '' }
        return {
          id: kind, acct: n, key: davInst(kind, n),
          name: n > 1 ? (c.name || (DAV_DEFNAME[kind] + ' ' + n)) : (c.name || DAV_DEFNAME[kind]),
          ready: davReady(kind, n), url: c.url || '', user: c.user || '',
          hasCreds: davReady(kind, n), authOk: davReady(kind, n) ? auth.ok : null, authErr: auth.ok === false ? auth.err : '',
          roots: davRoots(kind, n), stats: davStats(kind, n)
        }
      })),
      /* 「添加 → 导入视频整理」用过的目录：设置 → 媒体库里展示，可一键收进媒体库 */
      importDirs: Array.isArray(CFG.importDirs) ? CFG.importDirs : [],
      scan: { running: SCAN.running, phase: SCAN.phase, videos: SCAN.videos, scanned: SCAN.scanned, matched: SCAN.matched, ok: SCAN.okCount, fail: SCAN.failCount, error: SCAN.error, ms: SCAN.ms, finishedAt: SCAN.finishedAt }
    })
  }
  /* 重新扫描（等价「⟳ 重新扫描」）：扫描中调用会在本轮结束后自动再扫一遍 */
  if (p === '/api/library/rescan') {
    /* 手动重扫 = 用户明确要「看到最新」→ 清掉 115 列目录快照（10 分钟缓存）。
     * 否则刚离线下载完/刚放进网盘的文件会因为缓存命中而扫不出来（用户点重扫却看不到新片）。 */
    V115_SNAP = new Map()
    DAV_SNAP.clear()   // WebDAV / 光鸭 同理
    rescan(); return json(res, { ok: true, scanning: SCAN.running })
  }
  /* 番号页「📂 找媒体文件」（v0.2.29）：按番号在媒体库里找文件名/文件夹匹配的视频（手动触发，不自动跑）。
   * 场景：线上详情页推送 115 离线下载完成后，文件落进挂载目录，来这里认领绑定入库。 */
  if (p === '/api/library/matchCode') {
    const code = norm(String(body.code || ''))
    if (!code || !bare(code)) return json(res, { ok: false, error: '缺少番号' })
    const ccode = bare(code)
    const matches = []
    const seen = new Set()
    for (const lib of LIBS) {
      for (const v of await walkAsync(lib)) {
        if (seen.has(v)) continue; seen.add(v)
        const bn = bare(baseOf(v))
        const dn = bare(path.basename(path.dirname(v)))
        let pc = ''
        try { pc = bare(parseName(v).code) } catch (_) {}
        if (pc === ccode || (ccode.length >= 3 && (bn.includes(ccode) || dn.includes(ccode)))) {
          matches.push({
            relVideo: path.relative(MEDIA_ROOT, v).split(path.sep).join('/'),
            file: path.basename(v),
            dir: path.relative(lib, path.dirname(v)).split(path.sep).join('/')
          })
        }
      }
    }
    /* 115 网盘来源：按番号**搜索**（1~2 次请求，2026-10-14 起不再遍历整树 —— 风控）。
     * 用户刚在网盘里放好/离线下载完就能立刻匹配到。 */
    for (const m of await v115FindByCode(ccode, code)) {
      if (seen.has(m.relVideo)) continue
      seen.add(m.relVideo)
      matches.push(m)
    }
    /* WebDAV / 光鸭：同样实时列目录按番号找（force=true 绕开快照缓存） */
    for (const m of await davFindAllByCode(ccode)) {
      if (seen.has(m.relVideo)) continue
      seen.add(m.relVideo)
      matches.push(m)
    }
    matches.sort((a, b) => a.relVideo.localeCompare(b.relVideo))
    /* 一条都没搜到时把「为什么搜不到」明说 —— 用户最常踩的两条：
     *   ① 本地媒体库是空的（根本没添加过目录，磁盘上自然搜不到）；
     *   ② 115 Cookie 过期了（网盘里的文件一个也列不出来）。
     * 以前只回一句空列表，用户完全看不出问题在哪（2026-10-13 反馈）。 */
    const notes = []
    if (!matches.length) {
      if (!LIBS.length) notes.push('本机还没配置任何「媒体库目录」（添加影片 → 视频目录），磁盘上没有任何可搜的地方。')
      else notes.push('已搜过本机 ' + LIBS.length + ' 个媒体库目录，没有文件名或目录名含「' + code + '」的视频。')
      /* ⚠ 判定顺序（用户可操作性优先）：没 Cookie → 没登记目录 → 搜失败 → 搜过没结果。
         中间两条别颠倒：「没登记目录」是用户能立刻动手修的，比「搜索接口暂时不可用」更该先看到。 */
      if (!v115AcctList().some(n => v115Ready(n))) notes.push('115 网盘还没配置 Cookie，网盘里的文件搜不到。')
      else if (!v115AcctList().some(n => v115Roots(n).length)) notes.push('115 网盘没登记任何目录（设置 → 115 网盘 → 要收录的目录），网盘里的文件搜不到。')
      else if (V115_FIND_NOTE) notes.push(V115_FIND_NOTE)
      else notes.push('已用 115 全盘搜索搜过一遍（1 次请求，不遍历目录），没有文件名或目录名含「' + code + '」的视频。')
      if (DAV_KINDS.some(k => davAcctList(k).some(n => davReady(k, n)))) {
        if (DAV_FIND_NOTE) notes.push(DAV_FIND_NOTE)
        else if (!DAV_KINDS.some(k => davAcctList(k).some(n => davRoots(k, n).length))) notes.push('WebDAV/光鸭 已连上但没登记任何目录，网盘里的文件搜不到。')
      }
    }
    return json(res, { ok: true, code, matches, notes })
  }
  /* 把找到的文件绑定到番号：写 manual-codes.json（重扫后仍生效）→ 触发重扫入库。
   * 重扫后该文件的番号取 manualCode，enrichFromCache 会回填本番号已有的离线数据 → 详情页自动变在库。 */
  if (p === '/api/library/bindCode') {
    const code = norm(String(body.code || ''))
    const relVideo = String(body.relVideo || '').trim().replace(/\\/g, '/')
    if (!code || !relVideo) return json(res, { ok: false, error: '缺少番号或文件路径' })
    /* 115 网盘条目：文件本来就在已收录的网盘目录里，没有「绑定本地文件」这回事 —— 重扫一遍即可。
     * ⚠ 风控优化（2026-10-13）：**不清 V115_SNAP**。能绑到这里说明刚在「📂 匹配文件」里实时列过目录
     *   （matchCode → v115FindByCode 走实时），而 v115List 无论实时与否都会把结果写进快照，
     *   所以这份快照已经是新鲜的 —— 直接重扫就能收录，省掉整树重打。 */
    if (v115Rel(relVideo)) {
      rescan()
      return json(res, { ok: true, code, relVideo, scanning: SCAN.running })
    }
    /* WebDAV / 光鸭条目同理：文件本来就在网盘目录里，清快照重扫即可 */
    if (davRel(relVideo)) {
      DAV_SNAP.clear()
      rescan()
      return json(res, { ok: true, code, relVideo, scanning: SCAN.running })
    }
    if (relVideo.includes('..') || path.isAbsolute(relVideo)) return json(res, { ok: false, error: '非法路径' })
    /* relVideo 相对挂载根（MEDIA_ROOT）；必须落在某个已配置媒体库（LIBS 是挂载根的子目录）里 */
    const fp = path.resolve(MEDIA_ROOT, relVideo)
    let exists = false
    for (const lib of LIBS) {
      const rl = path.resolve(lib)
      if (fp === rl || fp.startsWith(rl + path.sep)) { try { if (fs.statSync(fp).isFile()) exists = true } catch (_) {} break }
    }
    if (!exists) return json(res, { ok: false, error: '文件不在媒体库中（或已被移动）' })
    saveManualCode(relVideo, code)
    rescan()
    return json(res, { ok: true, code, relVideo, scanning: SCAN.running })
  }
  if (p === '/api/library/add' || p === '/api/library/remove') {
    /* 移除「导入整理用过目录」的记录（body.importDir）：不动文件、不重扫 */
    if (p === '/api/library/remove' && body.importDir) {
      const ip = path.resolve(String(body.importDir))
      CFG.importDirs = (Array.isArray(CFG.importDirs) ? CFG.importDirs : []).filter(x => path.resolve(String(x)) !== ip)
      try { writeCfg() } catch (_) {}
      return json(res, { ok: true, importDirs: CFG.importDirs })
    }
    /* 批量删除：body.paths=[...]（编辑弹层里逐行删）/ body.all=true（卡片上「删除媒体源」＝清空本地目录）。
     * 只写一次配置、只重扫一次 —— 逐条删会触发多次 rescan。 */
    if (p === '/api/library/remove' && (body.all === true || Array.isArray(body.paths))) {
      const want = body.all === true ? null : body.paths.map(x => path.resolve(String(x)))
      const gone = []
      for (const lib of LIBS.slice()) {
        if (want === null || want.indexOf(path.resolve(lib)) >= 0) { gone.push(lib); LIBS.splice(LIBS.indexOf(lib), 1) }
      }
      if (!gone.length) return json(res, { ok: false, error: '没有匹配到任何本地媒体库目录' })
      if (NATIVE) recomputeMediaRoot()
      try { writeCfg() } catch (e) { return json(res, { ok: false, error: '保存失败：' + e.message }) }
      rescan()
      return json(res, { ok: true, removed: gone, libraries: LIBS, libs: libStats(), scanning: SCAN.running })
    }
    let raw = String(body.path || '').trim()
    if (!raw) return json(res, { ok: false, error: '请填写文件夹路径' })
    /* ~ 的展开：原生 Windows = 用户主目录（C:\Users\xxx）；容器部署维持原样 = MEDIA_ROOT */
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      raw = (process.platform === 'win32' && NATIVE)
        ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]/, ''))
        : path.join(MEDIA_ROOT, raw.slice(1))
    }
    const rp = path.resolve(raw)
    if (!NATIVE) {
      if (!(rp === MEDIA_ROOT || rp.startsWith(MEDIA_ROOT + path.sep)))
        return json(res, { ok: false, error: `只能添加挂载进来的目录（${MEDIA_ROOT}）里的文件夹。宿主机的路径在容器里不存在——要挂别的目录请先在 docker-compose.yml 里加一行映射，再重建容器` })
    }
    if (p === '/api/library/add') {
      let st = null
      try { st = fs.statSync(rp) } catch (_) {}
      if (!st || !st.isDirectory())
        return json(res, { ok: false, error: `路径不存在或不可读：${rp}` + (NATIVE ? '' : '（检查容器是否已挂载该目录、云盘是否在线）') })
      if (!LIBS.includes(rp)) {
        LIBS.push(rp)
        /* 原生模式：加进跨共同祖先的目录时把媒体根扩张到新的共同祖先，保证 relVideo 不含 `..` */
        if (NATIVE) recomputeMediaRoot()
      }
      /* 转正成媒体库了 → 从「导入整理用过目录」记录里移除，避免两处重复展示 */
      if (Array.isArray(CFG.importDirs)) {
        CFG.importDirs = CFG.importDirs.filter(x => path.resolve(String(x)) !== rp)
      }
    } else {
      const i = LIBS.indexOf(rp)
      if (i < 0) return json(res, { ok: false, error: '该文件夹不在媒体库列表里' })
      LIBS.splice(i, 1)
      if (NATIVE) recomputeMediaRoot()
    }
    try { writeCfg() } catch (e) { return json(res, { ok: false, error: '保存失败：' + e.message }) }
    rescan()
    return json(res, {
      ok: true, libraries: LIBS, libs: libStats(), scanning: SCAN.running,
      warn: (!NATIVE && rp === MEDIA_ROOT) ? '加的是挂载根目录（整根扫描）。挂载点只是权限范围，通常建议改加它下面的子文件夹，例如 ' + MEDIA_ROOT + '/某个子目录' : ''
    })
  }
  /* ---------- 备份 / 恢复：配置 + 播放记录 + 个人数据打成一个 JSON ----------
   * 换机、清库、重装容器前先导出；恢复时只合并白名单字段，不会动影片文件。 */
  if (p === '/api/backup') {
    if (req.method === 'GET') {
      /* ⚠ 这份导出里躺着 server-config.json 的全部内容 —— 115 Cookie、多账号 Cookie、
       *   WebDAV/光鸭的账号密码、GitHub PAT、以及**访问口令本体**。
       *   原来是无条件原样吐出来的：局域网里任何人一条 GET 就能把全部网盘凭据端走
       *   （默认没设口令时更是裸奔），比越权访问还严重。
       * 现在：只有「从本机发出来的」请求才给完整版；外部请求一律把这些字段抹成空串，
       * 并在 secretsOmitted 里列出抹了哪些，前端可以照实提示用户（凭据请在设置里重填）。
       * 本机判定用 TCP 对端地址，不看 Host（Host 客户端可以随便写 localhost）。 */
      const localReq = (typeof isLocalReq === 'function') ? isLocalReq(req) : true
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) || {} } catch (_) { cfg = {} }
      const omitted = []
      if (!localReq) {
        const wipe = (o, k) => { try { if (o && typeof o === 'object' && o[k]) { o[k] = ''; omitted.push(k) } } catch (_) {} }
        ;['accessCode', 'githubToken'].forEach(k => { if (cfg[k]) { cfg[k] = ''; omitted.push(k) } })
        ;['cookie', 'pass', 'password', 'token', 'refreshToken', 'apiKey'].forEach(k => {
          wipe(cfg.pan115, k)
          if (Array.isArray(cfg.pan115x)) cfg.pan115x.forEach(a => wipe(a, k))
          wipe(cfg.webdav, k)
          wipe(cfg.guangya, k)
        })
      }
      const bundle = {
        app: 'javpaco', version: 1, exportedAt: new Date().toISOString(),
        config: cfg, watch: WATCH, userdata: UD
      }
      if (omitted.length) bundle.secretsOmitted = [...new Set(omitted)]
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
        const SAFE = ['proxy', 'proxyEnabled', 'cacheDir', 'metaMode', 'autoScrapeNew', 'probeNetRes', 'autoAvatar', 'autoRescan', 'autoRescanHour', 'auto115Watch', 'rankAuto', 'rankHour', 'hidden', 'uiPrefs', 'libraries', 'importDirs', 'sources', 'priority', 'priorities', 'keywords', 'accessCode', 'favorites', 'subscriptions', 'online', 'pan115']
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
    /* kind：poster（竖版海报，默认）/ fanart（横版主图）。
     * 播放器「存为封面」传 fanart —— 视频帧本来就是横的，塞进竖版海报会被裁得很难看。 */
    const kind = String(body.kind || 'poster') === 'fanart' ? 'fanart' : 'poster'
    const safe = String(code).replace(/[^\w.-]/g, '_')
    const dir = path.join(cacheDir(), 'movies', safe, 'images')
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    const fp = path.join(dir, kind + '.jpg')
    try { fs.writeFileSync(fp, buf) } catch (e) { return json(res, { ok: false, error: '写入失败：' + e.message }) }
    /* 回写 meta.json：图片指向本地文件 + 记尺寸/来源/时间（前端据此显示分辨率与「手动裁剪」标记） */
    const meta = readMovieCache(code) || { code }
    meta.code = meta.code || code
    meta.images = Object.assign({}, meta.images || {})
    const sz = imgSize(fp) || {}
    const relImg = '/cache/movies/' + safe + '/images/' + kind + '.jpg'
    meta.images[kind] = relImg
    meta.images[kind === 'poster' ? 'posterManual' : 'fanartManual'] = true
    meta.images[kind === 'poster' ? 'posterSrc' : 'fanartSrc'] = 'manual-crop'
    meta.images[kind === 'poster' ? 'posterMeta' : 'fanartMeta'] = { w: sz.w || 0, h: sz.h || 0, bytes: buf.length, src: 'manual-crop' }
    /* 存下裁剪构图（归一化到原底图的 0~1 区间）：底图将来升级成更高清时，可按此构图自动重裁 */
    if (kind === 'poster' && body.crop && typeof body.crop === 'object') {
      const cl = v => Math.max(0, Math.min(1, +v || 0))
      meta.images.posterCrop = {
        x: cl(body.crop.x), y: cl(body.crop.y),
        w: Math.max(0.01, Math.min(1, +body.crop.w || 0)), h: Math.max(0.01, Math.min(1, +body.crop.h || 0)),
        src: body.crop.src === 'poster' ? 'poster' : 'fanart'
      }
    } else delete meta.images.posterCrop
    try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(meta, null, 2)) } catch (e) { return json(res, { ok: false, error: '元数据写入失败：' + e.message }) }
    mirrorMeta(code)   // 选了「跟视频放一起」时同步平铺到番号文件夹
    console.log(`[poster] ${code} 手动设置${kind === 'fanart' ? '横版主图' : '海报'} ${sz.w}×${sz.h} ${(buf.length / 1024).toFixed(0)}KB`)
    return json(res, { ok: true, code, kind, poster: relImg, w: sz.w || 0, h: sz.h || 0, bytes: buf.length })
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
  /* 离线数据迁移（2026-10-15）：复制 + 校验 + 切目录；旧副本另走 cleanup（二次确认） */
  if (p === '/api/cache/migrate') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    return json(res, await cacheMigrate(body.dir))
  }
  if (p === '/api/cache/migrate/cleanup') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    return json(res, cacheCleanupOld(body.dir))
  }
  /* ---------- 网站（导航栏「网站」页：卡片式网址收藏，2026-10-15） ---------- */
  if (p === '/api/sites') {
    if (req.method !== 'GET') { res.writeHead(405); return res.end() }
    const s = sitesLoad()
    /* 每张卡带上「图标版本号」= 图标文件 mtime：换了图标前端自然刷新（不然浏览器一直用旧图）。
     * logo = 内嵌高清矢量 logo（data URI，零网络）；custom 字段优先（用户自己填的图标地址）。 */
    const list = s.list.map(x => {
      const host = siteHostOf(x.url)
      const key = siteIconKey(x.url)
      let iconAt = 0
      /* 优先级：用户自己填的图标 > 内置图标（人工筛过，比运行时抓的靠谱）> 本地抓到的 favicon。
       * 三者都通过 iconAt 这个「版本号」告诉前端该去 /api/sites/icon 取图，图本身不进这个响应。 */
      if (x.logo) iconAt = 0
      else if (x.builtinLogo) iconAt = x.builtinLogoAt
      else if (key) {
        const hit = siteIconExisting(key)
        if (hit && hit.file) { try { iconAt = Math.round(fs.statSync(hit.file).mtimeMs) } catch (_) {} }
      }
      let logo = String(x.logo || '').trim()
      const logoAuto = siteLogoUri(host, x.name)             // 程序画的内嵌矢量 logo（永远有）
      const out = Object.assign({}, x, { host, iconAt, logo, logoAuto, bg: x.bg || '', useLogo: x.useLogo ? 1 : 0 })
      delete out.builtinLogo                                  // 4MB 的图标本体绝不进这个响应
      delete out.builtinLogoAt
      return out
    })
    /* 进页面顺手把还没图标的站点排进后台队列（并发 1、间隔 1.2s；前端轮询会自己把新图标画出来）。
     * 已经是内嵌 logo / 用户自填图标的站点不进队列 —— 它们本来就有图，没必要去碰墙。 */
    /* ⚠ 2026-10-15 改：老逻辑是 filter(!siteHasLogo(x)) —— 而品牌表里登记了全部 73 个域名，
     * 等于**一个站都不会去抓真图标**，卡片只能一直显示程序画的那枚 logo。
     * 现在改成「只要用户没指定图标 / 没选「用内置」就都排一次队」：
     * 抓到真图标就显示真的，抓不到再退回内置矢量 logo —— 品牌表退回它本来的职责（让兜底好看）。 */
    try { siteIconWarm(s.list.filter(x => !x.logo && !x.useLogo && !x.builtinLogo)) } catch (_) {}
    return json(res, { ok: true, cats: SITE_CATS, list, file: SITES_FILE(), builtinFile: SITES_BUILTIN_FILE(), builtinCount: sitesBuiltinList().length })
  }
  if (p === '/api/sites/save') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    let s = sitesLoad()
    const url = siteNormUrl(body.url)
    if (!url) return json(res, { ok: false, error: '网址不对（要 http/https 的完整地址，比如 https://www.javbus.com）' })
    const name = String(body.name || '').trim().slice(0, 40) || siteHostOf(url)
    const cat = SITE_CATS.indexOf(String(body.cat || '')) >= 0 ? String(body.cat) : '其他'
    const desc = String(body.desc || '').trim().slice(0, 120)
    /* 自定义图标：http(s) 网址 或 data:image/svg 都收（用户想用自己的 logo 就用）
     * 留空 = 用内嵌矢量 logo / 站点真实 favicon */
    let logo = String(body.logo || '').trim().slice(0, 1200000)
    if (logo && !/^https?:\/\//i.test(logo) && !/^data:image\//i.test(logo)) logo = ''
    /* 图标底色（2026-10-15 需求）：'' = 默认统一白 · 'transparent' = 透明 · '#rrggbb' = 指定颜色。
     * 只收这三种，别的写法一律回到默认白，前端不用做兜底判断。 */
    let bg = String(body.bg || '').trim().slice(0, 32)
    if (bg && !/^transparent$/i.test(bg) && !/^#[0-9a-fA-F]{3,8}$/.test(bg)) bg = ''
    if (/^transparent$/i.test(bg)) bg = 'transparent'
    const useLogo = body.useLogo ? 1 : 0
    const id = String(body.id || '').trim()
    const host = siteHostOf(url)
    const mine = sitesMineLoad()
    let it = id ? s.list.find(x => x.id === id) : null
    /* 新增时同域名且同分类视为重复（只更新不新增一条），跟旧逻辑一致 */
    if (!it && !id) it = s.list.find(x => siteHostOf(x.url) === host && x.cat === cat) || null
    const oldHost = it ? siteHostOf(it.url) : ''
    /* 落点：内置站 → 在个人层建/改一份「覆盖副本」（位置仍旧按内置顺序显示，卡片不会跳走）；
     * 自己加的站 → 直接改个人层里那条；新站 → 新建一条进个人层。 */
    let target = sitesMineEntry(it)
    if (!target) {
      target = { id: it ? it.id : siteNewId(), url: it ? it.url : url, hits: it ? (it.hits || 0) : 0, at: Date.now() }
      mine.list.push(target)
    }
    if (oldHost && oldHost !== host && siteIsBuiltinHost(oldHost)) {
      /* 内置站的网址被改到了别的域名：原来那一格留墓碑，改后的这条当成「自己的站点」 */
      if (mine.del.indexOf(oldHost) < 0) mine.del.push(oldHost)
      target.id = siteNewId()
    }
    Object.assign(target, { name, cat, desc, logo, bg, useLogo })
    target.url = url
    mine.del = mine.del.filter(h => h !== host)     // 之前删过又想加回来 → 撤墓碑
    sitesSave()
    s = sitesRebuild()
    it = s.list.find(x => x.id === target.id) || target
    /* 新增/改了网址 → 顺手后台取一次图标（不阻塞保存；取不到前端画内嵌 logo）。
     * 用户明确选了「不用抓来的图」就不去碰墙了。 */
    if (!it.logo && !useLogo) setTimeout(() => { siteIconEnsure(it.url, { upgrade: true }).catch(() => {}) }, 50)
    return json(res, { ok: true, site: it, total: s.list.length })
  }
  if (p === '/api/sites/del') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    let s = sitesLoad()
    const mine = sitesMineLoad()
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : (body.id ? [String(body.id)] : [])
    if (!ids.length) return json(res, { ok: false, error: '没有指定要删的网站' })
    let removed = 0
    for (const id of ids) {
      const it = s.list.find(x => x.id === id)
      if (!it) continue
      const host = siteHostOf(it.url)
      const before = mine.list.length
      mine.list = mine.list.filter(x => x !== sitesMineEntry(it))
      if (mine.list.length !== before) removed++
      /* 内置库里有同域名 → 必须留墓碑，否则重启后它又回来了（这一格会被认为从没删过） */
      if (host && siteIsBuiltinHost(host) && mine.del.indexOf(host) < 0) { mine.del.push(host); if (mine.list.length === before) removed++ }
      if (host && mine.stats[host]) delete mine.stats[host]
    }
    sitesSave()
    s = sitesRebuild()
    return json(res, { ok: true, removed: removed, total: s.list.length })
  }
  if (p === '/api/sites/hit') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const s = sitesLoad()
    const it = s.list.find(x => x.id === String(body.id || ''))
    if (!it) return json(res, { ok: true, hits: 0 })
    const host = siteHostOf(it.url)
    if (!host) return json(res, { ok: true, hits: 0 })
    /* 点击次数属于「使用痕迹」，按 host 记在个人层，不去复制内置站的条目内容 */
    const mine = sitesMineLoad()
    const st = mine.stats[host] || (mine.stats[host] = {})
    st.hits = (st.hits || 0) + 1
    st.lastAt = Date.now()
    it.hits = st.hits
    it.lastAt = st.lastAt
    sitesSave()
    return json(res, { ok: true, hits: st.hits })
  }
  if (p === '/api/sites/icon') {
    const u = new URL(req.url, 'http://x').searchParams.get('u') || ''
    if (!u) { res.writeHead(400); return res.end('bad') }
    /* ① 内置图标优先：从内存里的内置站点库直接取，不联网、不落用户目录。
     *    （装完就有图，不用等它一个个去抓；删掉的站留了墓碑就不再吐图。） */
    try {
      const bHost = siteHostOf(siteNormUrl(u) || u)
      const mineIc = sitesMineLoad()
      if (bHost && (!mineIc.del || mineIc.del.indexOf(bHost) < 0)) {
        const dec = dataUriToBuf(sitesBuiltinIconMap()[bHost])
        if (dec) {
          res.writeHead(200, { 'Content-Type': dec.type, 'Content-Length': dec.buf.length, 'Cache-Control': 'public, max-age=604800' })
          return res.end(dec.buf)
        }
      }
    } catch (_) {}
    try {
      /* ② 再走本地缓存（运行时抓到的 favicon / 用户点过「重新抓」的）。
       * ⚠ 只读缓存（cacheOnly）：每张卡的 <img> 都会打这个地址，绝不能在这里联网 ——
       * 否则卡片每次重画都会触发一轮重抓，图就会「一直刷新」。没缓存就 404 + 排后台队列。 */
      const r = await siteIconEnsure(u, { cacheOnly: true })
      const ct = /^(png|gif|webp|ico|svg)$/.test(r.type) ? (r.type === 'svg' ? 'image/svg+xml' : r.type === 'ico' ? 'image/x-icon' : 'image/' + r.type) : 'image/png'
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': r.buf.length, 'Cache-Control': 'public, max-age=604800' })
      return res.end(r.buf)
    } catch (_) { res.writeHead(404); return res.end('Not Found') }
  }
  /* 「🔍 获取图标」：列出这个网址的候选图标（不回写缓存，纯给用户挑） */
  if (p === '/api/sites/icons/candidates') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const url = siteNormUrl(body.url)
    if (!url) return json(res, { ok: false, error: '网址不对（要 http/https 的完整地址，比如 https://www.javbus.com）' })
    try {
      const list = await siteIconCandidatesFor(url)
      return json(res, { ok: true, url: url, list: list })
    } catch (e) { return json(res, { ok: false, error: (e && e.message) || '抓取失败' }) }
  }
  /* 「✂ 裁剪图标」的取图通道（2026-10-15 需求：编辑图标的时候能手动裁剪）。
   * 为什么不让前端直接 `<img src=外部地址>` 再画进 canvas：跨域图片会把画布**污染**，
   * 之后 canvas.toDataURL() 直接抛 SecurityError —— 裁好的图根本存不进去。
   * 所以统一由本地服务把图取回来（照样走用户的代理）转成 data URI：同源、能画、能存、断网也在。 */
  if (p === '/api/sites/img') {
    if (req.method !== 'GET') { res.writeHead(405); return res.end() }   // 只读端点：方法不对直接 405，别返回一个 200 的错误体
    const u = siteNormUrl(new URL(req.url, 'http://x').searchParams.get('u') || '')
    if (!u) return json(res, { ok: false, error: '图片地址不对（要 http/https 的完整地址）' })
    try {
      const r = await siteIconFetch(u, 12000)
      if (!r.buf || r.buf.length < 20) return json(res, { ok: false, error: '这张图是空的' })
      const e2 = siteIconSniff(r.buf, r.type)
      if (!e2) return json(res, { ok: false, error: '这不是浏览器能画的图片（png/jpg/gif/webp/svg/ico）' })
      const mime = e2 === 'svg' ? 'image/svg+xml' : e2 === 'ico' ? 'image/x-icon' : e2 === 'webp' ? 'image/webp'
        : e2 === 'gif' ? 'image/gif' : e2 === 'jpg' ? 'image/jpeg' : 'image/png'
      const dim = e2 === 'svg' ? null : siteIconDim(r.buf, e2)
      return json(res, { ok: true, data: 'data:' + mime + ';base64,' + r.buf.toString('base64'),
        w: dim ? dim.w : 0, h: dim ? dim.h : 0, bytes: r.buf.length })
    } catch (e) {
      /* 说人话：底层报的是「TLS socket disconnected」这种，用户看不懂也帮不上忙 */
      const m = String((e && e.message) || '')
      const friendly = /ENOTFOUND|EAI_AGAIN/i.test(m) ? '这个地址解析不了（网址写错或被墙）'
        : /ETIMEDOUT|timeout|超时/i.test(m) ? '取图超时了（网络慢或站点不通）'
        : /内容过大/i.test(m) ? '这张图太大了（超过 1.5MB），换张小点的'
        : /HTTP \d/.test(m) ? '这个地址返回了 ' + (m.match(/HTTP \d+/) || [''])[0] + '，取不到图'
        : /ECONNREFUSED|ECONNRESET|socket|TLS|EPIPE|证书/i.test(m) ? '连不上这个地址（被墙或代理没通）'
        : m || '取图失败'
      return json(res, { ok: false, error: '取图失败：' + friendly })
    }
  }
  /* 手动「重抓图标」（2026-10-15）：把选中网站已缓存的图标清掉重新抓一遍。
   * 换过代理 / 发现某个站的图不对时用它；不阻塞请求，抓好的图下次轮询自然出现。 */
  if (p === '/api/sites/icons/refresh') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const s = sitesLoad()
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
    const cand = ids.length ? s.list.filter(x => ids.indexOf(x.id) >= 0) : s.list
    if (!cand.length) return json(res, { ok: false, error: '没有要重抓的网站' })
    try { fs.mkdirSync(SITE_ICON_DIR(), { recursive: true }) } catch (_) {}
    let n = 0
    for (const x of cand) {
      const key = siteIconKey(x.url)
      if (!key) continue
      try {
        for (const name of siteIconNames()) {
          if (!name.startsWith(key + '.')) continue
          try { fs.unlinkSync(path.join(SITE_ICON_DIR(), name)) } catch (_) {}
        }
      } catch (_) {}
      siteIconBust()
      SITE_ICON_UPGRADED.delete(key)
      n++
    }
    siteIconWarm(cand, true)
    return json(res, { ok: true, total: n })
  }
  if (p === '/api/sites/probe') {
    if (req.method === 'POST') {
      /* 单点即时测：编辑弹层里「📡 测这个网址通不通」用（不建任务，直接等结果） */
      if (body.url && !body.ids) {
        const r = await siteProbeOne(String(body.url), SITE_PROBE_TIMEOUT)
        return json(res, { ok: true, one: { ok: r.pass ? 1 : 0, code: r.code || 0, ms: r.ms, err: r.err || '', at: Date.now() } })
      }
      if (SITE_PROBE && SITE_PROBE.running) return json(res, { ok: false, error: '上一次测试还没跑完（' + SITE_PROBE.done + '/' + SITE_PROBE.total + '），等它结束再试' })
      const s = sitesLoad()
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      const cand = ids.length ? s.list.filter(x => ids.indexOf(x.id) >= 0) : s.list
      if (!cand.length) return json(res, { ok: false, error: '没有要测试的网站' })
      /* 不 await：立刻返回，前端轮询同一个地址读进度（不然 73 个站得挂住这个请求一分多钟） */
      siteProbeRun(ids).catch(e => console.log('[sites] 测试异常：' + e.message))
      return json(res, { ok: true, id: SITE_PROBE.id, total: cand.length })
    }
    const t = SITE_PROBE
    return json(res, {
      ok: true,
      running: !!(t && t.running),
      at: t ? t.at : 0,
      total: t ? t.total : 0,
      done: t ? t.done : 0,
      pass: t ? t.pass : 0,
      fail: t ? t.fail : 0,
      results: t ? t.results : {}
    })
  }
  /* ---------- 在线刮削（添加本地库没有的影片） ---------- */
  if (p === '/api/scrape/start') {
    /* 批量：一次把整批番号全部塞进服务端持久队列（ingest-queue.json 落盘）。
     * 这样「关掉软件 / 重启 docker」后队列还在、自动续跑，不会丢未提交的任务。 */
    if (Array.isArray(body.codes) && body.codes.length) {
      const via = String(body.via || '手动')
      const seen = new Set(), resolved = []
      for (const raw of body.codes) {
        const c = parseName(String(raw || '').trim().toUpperCase() + '.mp4').code
        if (c && !seen.has(c)) { seen.add(c); resolved.push(c) }
      }
      if (!resolved.length) return json(res, { ok: false, error: '没有可识别的番号' })
      autoIngestQueue(resolved, via, false)
      return json(res, { ok: true, queued: true, count: resolved.length, pending: AUTO_INGEST.queue.length })
    }
    const wantQueue = body.queue === true || body.queue === 'front'
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
    /* 带 queue 的请求一律进持久队列（订阅全量 / 批量 / 添加页都走这），
     * 不再「服务端空闲就直接 scrapeAsync」——否则队列里同一部会被重复刮。 */
    if (wantQueue) {
      const pos = autoIngestQueue([code], '手动', body.queue === 'front')
      /* pos===0 = 这部**没能进队列**（autoIngestQueue 的 `q.includes(c) continue` 命中重复，
       * 或入队瞬间队列已被 worker 取空）。这时绝不能写 queued 占位 —— 没有 worker 会来收尾，
       * 占位会永远停在「排队中」（用户 2026-10-06 第二次遇到）。
       * 这种情况按「本地已有就直接算成功」处理：先看缓存，再看历史里有同番号的成功记录就复用。 */
      if (!pos) {
        let m = null
        try { m = readMovieCache(code) } catch (_) {}
        if (m && m.scraped) {
          scrapeHistAdd({
            code, ok: true, err: '', via: '手动',
            src: String(m.source || '').split(' ')[0] || '本地已有',
            imgSrc: (m.images && (m.images.posterSrc || m.images.fanartSrc)) || '',
            at: Date.now(), dur: 0, skipped: true, note: '本地已有离线数据，未重复刮削'
          })
        }
        return json(res, { ok: true, code, queued: false, dup: true, pos: 0, pending: AUTO_INGEST.queue.length })
      }
      /* 立刻记一条「排队中」：否则从提交到刮完这几十秒里，历史记录是空的、
       * 卡片看着像卡住（用户 2026-10-06 反馈）。刮完时 scrapeHistAdd 会按番号覆盖它。 */
      scrapeHistAdd({ code, ok: false, state: 'queued', err: '', src: '', via: '手动', at: Date.now(), dur: 0 })
      return json(res, { ok: true, code, queued: true, pos, pending: AUTO_INGEST.queue.length })
    }
    if (SCRAPE.running) return json(res, { ok: false, error: '正在刮削「' + SCRAPE.code + '」，请等它完成' })
    const job = { code, url: String(body.url || '').trim(), sourceId: String(body.sourceId || '').trim(), nfo, full: !!body.full, via: '手动' }
    /* 单跑任务也记进落盘：中途重启/崩溃时 autoQLoad 会把它补回队首接着刮（不记就丢了） */
    AUTO_INGEST.current = code; AUTO_INGEST.currentVia = '手动'
    AUTO_INGEST.active = AUTO_INGEST.active || {}
    AUTO_INGEST.active[code] = SCRAPE   // 手动单跑复用全局 SCRAPE 作为它的状态，firstActive 也能带出它
    autoQSave()
    /* 单跑也**必须**走看门狗。这条路径用的是全局 SCRAPE，而 4 个队列 worker 一见
     * SCRAPE.running 就把取出的任务塞回队列、睡 3 秒再来 —— 单跑一旦卡死（典型：卡在图片下载），
     * 整条队列就跟着永久停摆；而 stop 只在两个检查点生效，卡在 await 里根本救不回来
     * （2026-10-06 的 DV-1582 就是这样把队列堵了 9 小时）。 */
    scrapeWithWatchdog(Object.assign({}, job, { t0: Date.now() }), SCRAPE).catch(() => {})
    return json(res, { ok: true, code })
  }
  /* ---- 重新刮削（成功/失败都能重来）：清掉旧离线数据 → 排队 → 立刻回填历史记录 ----
   * 放在任务详情面板用。成功过的也要能重刮（比如换了想让它抓的网址、或数据源坏了想重来），
   * 所以这里不区分成败；wipe 会先抹掉该番号的 cache/movies 目录，否则 scrapeAsync 的
   * 「已有离线数据就跳过」快路径会让重刮形同虚设。 */
  if (p === '/api/scrape/redo') {
    if (req.method !== 'POST') return json(res, { ok: false, error: '请用 POST' })
    const rawCode = String((body || {}).code || '').trim()
    const url = String((body || {}).url || '').trim()
    if (!rawCode && !url) return json(res, { ok: false, error: '请填番号或详情页网址' })
    let code = rawCode
    if (!code && url) {
      try { code = (scCodeFromUrl(url) || scCodeFromUrl(rawCode) || scText(rawCode)).toUpperCase() } catch (_) {}
    }
    if (code) code = (parseName(code + '.mp4').code || code)
    if (!code) return json(res, { ok: false, error: url ? ('这个网址里认不出番号，请直接填番号（形如 STARS-238）') : '无法识别番号' })
    const b = bare(code)
    /* 抹掉旧数据 + 旧历史记录（成功/失败都清），让面板立刻反映「正在重刮」 */
    try {
      const root = path.join(cacheDir(), 'movies')
      const d = offlineCodeDir(code, null)
      if (d && d.startsWith(root + path.sep) && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
    } catch (_) {}
    const _before = SCRAPE_HIST.list.length
    SCRAPE_HIST.list = SCRAPE_HIST.list.filter(x => !(x && bare(x.code) === b))
    if (SCRAPE_HIST.list.length !== _before) {
      try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
    }
    patchDataItem(code)
    const pos = autoIngestQueue([code], '手动·重刮', true)
    /* 立刻插一条「排队中」记录：面板马上能看到状态，不用等 2.5s 轮询。
     * 用 state:'queued' 而不是 ok:null —— ok 只有 true/false 两义，null 会被前端当失败渲染。 */
    scrapeHistAdd({ code, ok: false, state: 'queued', err: '', src: '', via: '手动·重刮', at: Date.now(), dur: 0, url })
    return json(res, { ok: true, code, url, pos: pos || 1, pending: AUTO_INGEST.queue.length })
  }
  if (p === '/api/scrape/status') return json(res, Object.assign({ ok: true }, SCRAPE, {
    /* 同 /api/scrape/queue：把媒体库版本号给前端当「有片子入库了」的信号（见 LIB_SEQ 注释） */
    libSeq: libSeq(),
    /* 入库队列进度：前端的「排队中」要显示真实位次/剩余量，否则整批计时器会被误读成单条耗时 */
    queue: {
      pending: AUTO_INGEST.queue.length, current: AUTO_INGEST.current,
      done: AUTO_INGEST.done, ok: AUTO_INGEST.ok, fail: AUTO_INGEST.fail,
      total: AUTO_INGEST.total, running: AUTO_INGEST.running, paused: !!AUTO_INGEST.paused
    }
  }))
  /* ---------- 卡住时的自救工具箱（2026-10-03） ----------
   * 以前「刮削卡住 / 队列太长」除了重启容器没有别的办法，现在：
   *   stop    中止当前这部（逐阶段检查 SCRAPE.stop，不会写出半成品 meta）
   *   pause   暂停队列（保留不跑，随时恢复）
   *   resume  恢复队列
   *   clear   清空待跑队列（已入库的不受影响）
   *   remove  把某一部从队列里去掉
   *   front   把某一部提到队首（手动优先于订阅批量） */
  if (p === '/api/scrape/stop') {
    if (!SCRAPE.running && !(AUTO_INGEST.active && Object.keys(AUTO_INGEST.active).length)) return json(res, { ok: true, already: true })
    SCRAPE.stop = true; SCRAPE.phase = '正在停止'
    if (AUTO_INGEST.active) for (const k of Object.keys(AUTO_INGEST.active)) AUTO_INGEST.active[k].stop = true
    scLog(SCRAPE, '收到手动停止指令，正在收尾…')
    return json(res, { ok: true, stopping: true, code: SCRAPE.code })
  }
  if (p === '/api/scrape/queue') {
    if (req.method === 'GET') {
      /* 完整任务清单：排队中的每条都带 via（来源），前端才能在单个任务里显示是「离线」还是「订阅」。
       * 2026-10-03 之前只回 head 前 20 个且不带 via，前端只能显示番号、无法区分来源。 */
      const items = AUTO_INGEST.queue.map(c => ({ code: c, via: (AUTO_INGEST.queue.via || {})[c] || '订阅' }))
      return json(res, {
        ok: true, pending: AUTO_INGEST.queue.length, current: AUTO_INGEST.current,
        currentVia: AUTO_INGEST.currentVia || '',
        /* 媒体库版本号：前端全站轮询靠它判断「是不是有新片入库了」，变了就补一次 LIB（见 LIB_SEQ 注释） */
        libSeq: libSeq(),
        done: AUTO_INGEST.done, okN: AUTO_INGEST.ok, fail: AUTO_INGEST.fail,
        total: AUTO_INGEST.total,
        /* running 现在按「事实」算：队列里还有号、或还有部在刮 → 忙。
         * 不再用一个手置的布尔，免得某条路径没解锁就永远停在 true（前端因此一直以为服务端在忙）。 */
        running: AUTO_INGEST.queue.length > 0 || Object.keys(AUTO_INGEST.active || {}).length > 0,
        paused: !!AUTO_INGEST.paused,
        head: AUTO_INGEST.queue.slice(0, 20),
        items: items,
        /* 正在刮的每一部（不止一部：autoIngestRun 是 CONCUR=4 的 worker 池）。
         * ⚠️ 必须给 active 而不是只给全局 SCRAPE —— 队列刮削时 scrapeAsync 走的是**每任务独立状态**
         *   （job._S = scMakeState()），全局 SCRAPE.running 永远是 false，光看它「刮削中」列会一直是空的
         *   （用户反馈：失败任务点重试后不显示刮削中）。runningTasks 才带真实的 phase/pct。 */
        runningTasks: Object.keys(AUTO_INGEST.active || {}).map(k => {
          const a = AUTO_INGEST.active[k] || {}
          return {
            code: a.code || k, via: a.via || (AUTO_INGEST.queue.via || {})[k] || '手动',
            phase: a.phase || '', pct: a.pct || 0, title: a.title || '', log: a.log || []
          }
        }),
        scraping: SCRAPE.running
          ? { code: SCRAPE.code, phase: SCRAPE.phase, pct: SCRAPE.pct, via: SCRAPE.via || '' }
          : null
      })
    }
    const act = String(body.action || '')
    const q = AUTO_INGEST.queue
    if (act === 'pause') { AUTO_INGEST.paused = true; return json(res, { ok: true, paused: true }) }
    if (act === 'resume') {
      AUTO_INGEST.paused = false; autoQSave()
      autoIngestRun().catch(() => {})
      return json(res, { ok: true, paused: false })
    }
    if (act === 'clear') {
      const n = q.length
      const dropped = q.slice()
      q.length = 0; AUTO_INGEST.paused = false
      histFinishQueued(dropped, '已手动清空待跑队列，这部没刮')
      /* 计数一并归零：点「清空待跑」的语义就是「这批到此为止 / 重新来」，
       * 再让状态条继续显示「已完成 13（失败 4）」（那是好几个小时前的累计战绩）会让人以为
       * 刚才这批也是这个结果。刮削历史本身不受影响，照旧能在历史表里查到。 */
      AUTO_INGEST.done = 0; AUTO_INGEST.ok = 0; AUTO_INGEST.fail = 0; AUTO_INGEST.total = 0
      autoQSave()
      console.log('[auto-ingest] 手动清空队列：' + n + ' 个番号')
      return json(res, { ok: true, cleared: n, pending: 0 })
    }
    const code = String(body.code || '').trim().toUpperCase()
    if (act === 'remove' && code) {
      const i = q.indexOf(code)
      if (i >= 0) {
        q.splice(i, 1)
        histFinishQueued([code], '已从待跑队列移除，这部没刮')
        autoQSave(); return json(res, { ok: true, removed: code, pending: q.length })
      }
      return json(res, { ok: true, removed: '', pending: q.length })
    }
    if (act === 'front' && code) {
      const i = q.indexOf(code)
      if (i > 0) { q.splice(i, 1); q.unshift(code) }
      else if (i < 0) { q.unshift(code); q.via = q.via || {}; q.via[code] = '手动' }
      autoQSave(); autoIngestRun().catch(() => {})
      return json(res, { ok: true, pos: q.indexOf(code) + 1, pending: q.length })
    }
    return json(res, { ok: false, error: '未知操作：' + act })
  }
  /* ---- 刮削历史（添加影片页「历史记录」栏）：GET 取（新→旧），POST {action:'clear'} 清空 ---- */
  if (p === '/api/scrape/history') {
    scrapeHistLoad()
    if (req.method === 'POST') {
      const ha = String((body || {}).action || '')
      if (ha === 'clear') {
        SCRAPE_HIST.list = []
        try { fs.writeFileSync(SCRAPE_HIST_FILE(), '[]') } catch (_) {}
        return json(res, { ok: true, total: 0 })
      }
      /* ---- 单条重试：把这条重新插到服务端队列队首（不重复排队，已有则返回原位次） ---- */
      if (ha === 'retry') {
        const code = String((body || {}).code || '').trim().toUpperCase()
        if (!code) return json(res, { ok: false, error: '缺少番号' })
        const via = String((body || {}).via || '手动')
        const _b = bare(code)
        /* 重试意味着旧的失败记录要消失：先把该番号从失败历史里移除，
         * 否则用户点了重试、任务也跑起来了，失败栏里它还在、历史里也还在（用户反馈的 bug） */
        const _before = SCRAPE_HIST.list.length
        SCRAPE_HIST.list = SCRAPE_HIST.list.filter(x => !(x && bare(x.code) === _b))
        if (SCRAPE_HIST.list.length !== _before) {
          try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
        }
        /* 重试前先把该番号已有的缓存抹掉，否则「已有离线数据就跳过」会让重试无效 */
        if (body.wipe !== false) {
          try {
            const d = offlineCodeDir(code, null)
            const root = path.join(cacheDir(), 'movies')
            if (d && d.startsWith(root + path.sep) && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
          } catch (_) {}
        }
        const pos = autoIngestQueue([code], via, true)   // 返回该番号在队列里的位次（1 起），0 = 队列空
        return json(res, { ok: true, code: code, via: via, pos: pos || 1, pending: AUTO_INGEST.queue.length })
      }
      /* ---- 单条删除：可选连带删掉这条任务线产生的离线数据（meta.json + images/ + 磁力缓存） ---- */
      if (ha === 'remove') {
        const code = String((body || {}).code || '').trim().toUpperCase()
        const at = Number((body || {}).at) || 0
        const wipe = body.wipe !== false
        if (!code && !at) return json(res, { ok: false, error: '缺少番号或时间戳' })
        const _b = bare(code)
        /* 旧版本 bug 可能给同一番号留下多条重复记录，这里把所有匹配的都找出来一并删，
         * 否则删一条剩几条，失败栏看着像"点了没反应" */
        const matches = SCRAPE_HIST.list.filter(x => (_b && bare(x.code) === _b) || (at && Number(x && x.at) === at))
        let rec = matches.length ? matches[0] : null
        let files = null
        if (wipe && rec) {
          try {
            const d = offlineCodeDir(rec.code, null)
            const root = path.join(cacheDir(), 'movies')
            /* 只删这个番号自己的文件夹，绝不越出 cache/movies */
            if (d && d.startsWith(root + path.sep) && fs.existsSync(d)) {
              const st = fs.statSync(d)
              if (st.isDirectory()) { fs.rmSync(d, { recursive: true, force: true }); files = d }
            }
          } catch (e) { files = null }
          /* 顺便隐藏库里的条目（视频文件不动，只是不再展示） */
          try { setHidden(rec.code, true) } catch (_) {}
        }
        if (matches.length) SCRAPE_HIST.list = SCRAPE_HIST.list.filter(x => matches.indexOf(x) < 0)
        try { fs.writeFileSync(SCRAPE_HIST_FILE(), JSON.stringify(SCRAPE_HIST.list)) } catch (_) {}
        return json(res, {
          ok: true, removed: rec ? rec.code : code, files: files,
          left: SCRAPE_HIST.list.length
        })
      }
      return json(res, { ok: false, error: '未知操作：' + ha })
    }
    const lim = Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 120)   // 不再封顶 600：历史/队列本就不该有上限
    /* 必须按时间排序后再倒序取：scrapeHistAdd 对「同番号已有记录」是**原地覆盖**（位置不变），
     * 于是「一年前第一次刮、今天重刮」的那部会留在数组的旧位置上 —— 只读最后 lim 条再 reverse
     * 会得到一张乱序的表（实测 09:16 / 09:15 / 09:18 / 08:30 / 06:38 / 08:32 交错），
     * 而且重刮过的旧条目会被挤出窗口。这里按 at 升序排一次再取尾部，保证「新的在前」。 */
    const ordered = SCRAPE_HIST.list.slice().sort((a, b) => (Number(a && a.at) || 0) - (Number(b && b.at) || 0))
    return json(res, { ok: true, total: ordered.length, list: ordered.slice(-lim).reverse() })
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
    if (!NATIVE && !(root === MEDIA_ROOT || root.startsWith(MEDIA_ROOT + path.sep))) throw new Error(mountTip())
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
      if (!NATIVE && !(root === MEDIA_ROOT || root.startsWith(MEDIA_ROOT + path.sep))) return json(res, { ok: false, error: mountTip() })
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
    /* 「改版」标签（有码/无码/破解/流出/中字/分辨率）：番号本身就能判大部分，不依赖本地视频文件。
     * meta.tags 是刮削当时写好的（3913 行），没有就现算一份。 */
    const edTags = Array.isArray(m.tags) && m.tags.length ? m.tags : videoTagsOf('', 0, 0, (m.title || '') + ' ' + ((m.genres || []) || []).join(' '))
    return json(res, {
      ok: true, code, fields: m.fields, images: imgs, sources, sourceData: srcVals,
      offFilm: m.offFilm || null,
      /* MDC-NG 式详情页要的额外字段：原番号 / 评分 / 想看人数 / 刮削日志 / 改版 */
      origCode: m.origCode || '', score: m.score || '', wantWatch: Number(m.wantWatch) || 0,
      scrapeLog: Array.isArray(m.scrapeLog) ? m.scrapeLog : [],
      /* 逐源尝试记录（每部都持久化，含成功/失败与原因）：老任务没有 scrapeLog 时，
       * 前端靠它合成出「每个源试了什么、为什么失败」的详细日志，不至于只显示一句「没有日志」。 */
      scrapeTried: (m.scrapeTried || {}).tried || [],
      scrapeSkipped: (m.scrapeTried || {}).skipped || [],
      edition: edTags,
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
  /* 单独换某字段的来源：文本字段直接取该源的值；主图字段从该源候选重新下载 */
  if (p === '/api/scrape/field') {
    const code = String(body.code || '').trim()
    const field = String(body.field || '').trim()
    const src = String(body.src || '').trim()
    const m = readMovieCache(code)
    if (!m || !m.fields) return json(res, { ok: false, error: '没有刮削数据（请先刮削一次）' })
    /* ---- 批量手动编辑（详情面板的「编辑元数据」）：一次改多个文本字段，全标来源「手动」 ---- */
    if (field === '__bulk__') {
      const vals = (body && body.values) || {}
      const changed = []
      for (const [k, raw] of Object.entries(vals)) {
        if (!SC_TEXT_FIELDS.concat(['actors', 'genres']).includes(k)) continue
        let v = Array.isArray(raw) ? raw : String(raw == null ? '' : raw)
        if (k === 'runtime') v = Number(v) || 0
        if (k === 'actors' || k === 'genres') v = String(raw || '').split(/[、,，\s]+/).map(x => x.trim()).filter(Boolean)
        m.fields[k] = { v, src: '手动' }
        changed.push(k)
        if (k === 'title') m.title = Array.isArray(v) ? v.join('、') : v
        if (k === 'plot') m.plot = v
        if (k === 'release') { m.release = v; m.year = String(v || '').slice(0, 4) }
        if (k === 'runtime') m.runtime = Number(v) || 0
        if (k === 'studio') m.studio = v
        if (k === 'publisher') m.publisher = v
        if (k === 'series') m.series = v
        if (k === 'director') m.director = v
        if (k === 'actors') m.actors = v
        if (k === 'genres') m.genres = v
      }
      if (!changed.length) return json(res, { ok: false, error: '没有可保存的字段' })
      m.manualEditedAt = new Date().toISOString()
      m.scrapedAt = new Date().toISOString()
      try { fs.writeFileSync(movieCacheFile(code), JSON.stringify(m, null, 2)) } catch (e) { return json(res, { ok: false, error: '写入失败：' + e.message }) }
      mirrorMeta(code); patchDataItem(code)
      return json(res, { ok: true, code, changed })
    }
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
      if (nc !== it.code) {
        saveManualCode(relVideo, nc); it.code = nc
        /* 番号变了 → 缓存目录名跟着变，新番号下还没有 pv6.mp4，立刻补排一次悬停预览生成 */
        try { enqueuePreview(nc) } catch (_) {}
      }
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
  /* ---------- 移除影片（详情页「删除」按钮，v0.3.0 只读媒体库语义）----------
   * 视频文件一律不动。动作只有两个：
   *   1. 该番号的离线数据（cache/movies/<番号>/：meta.json + 图片 + 磁力缓存）整个删除；
   *   2. 条目从影片库隐藏（hidden），挂载目录里的视频不再展示；
   *      想彻底恢复：删掉视频文件后取消隐藏，或在设置里清掉隐藏列表。 */
  if (p === '/api/movie/delete') {
    const code = String(body.code || '').trim()
    if (!code) return json(res, { ok: false, error: '缺少番号' })
    const items = (DATA && Array.isArray(DATA.items) ? DATA.items : []).filter(x => bare(x.code) === bare(code))
    /* 离线数据：整个番号文件夹（meta.json + images + 磁力缓存） */
    const root = path.join(cacheDir(), 'movies')
    const offDir = offlineCodeDir(code, items[0])
    let offline = false, offlineErr = ''
    if (offDir.startsWith(root + path.sep) && fs.existsSync(offDir)) {
      try { fs.rmSync(offDir, { recursive: true, force: true }); offline = true }
      catch (e) { offlineErr = '离线数据文件夹删除失败：' + e.message }
    }
    /* 条目隐藏 + 观看记录出清 */
    try { setHidden(code, true) } catch (e) { if (!offlineErr) offlineErr = e.message }
    if (DATA && Array.isArray(DATA.items)) {
      const vids = []
      for (const it of items) {
        for (const r of [it.relVideo].concat((it.files || []).map(f => f.relVideo))) {
          if (r && !vids.includes(r)) vids.push(r)
        }
      }
      const prefixes = vids.map(r => (r.split('/').slice(0, -1).join('/')))
      Object.keys(WATCH).forEach(k => {
        const rel = k.replace(/^\//, '')
        if (vids.some(v => rel === v || rel.startsWith(v + '/')) || prefixes.some(pp => pp && rel.startsWith(pp + '/'))) delete WATCH[k]
      })
      watchSaveSoon()
    }
    return json(res, { ok: true, code, offline, offlineErr, hidden: true })
  }

  return json(res, { ok: false, error: 'unknown api' })
}

/* 文件夹浏览：逐级选择子文件夹（Emby 同款体验），只允许挂载点以内 */
function libraryBrowse(q) {
  let raw = String(q || '').trim()
  /* ~ 同 /api/library/add：原生 Windows = 用户主目录；容器 = MEDIA_ROOT */
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = (process.platform === 'win32' && NATIVE)
      ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]/, ''))
      : path.join(MEDIA_ROOT, raw.slice(1))
  }
  const dir = raw ? path.resolve(raw) : MEDIA_ROOT
  if (!NATIVE && !(dir === MEDIA_ROOT || dir.startsWith(MEDIA_ROOT + path.sep)))
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

/* ================= 项目内置动作 ③：115 推送自动认领（v0.2.29） =================
 * 线上详情页推送磁力到 115 离线下载后，服务自动盯梢：
 *   ① 本机媒体库（115 挂载盘 / 同步目录）：文件落盘（连续两轮看到且大小不变才算稳定）
 *      → 绑定番号（manual-codes.json，文件名解析不出番号也能挂对）
 *      → 清理同目录垃圾文件（网页 / 种子 / 快捷方式 / 系统文件，不动视频图片 nfo 字幕）
 *   ② 115 网盘（纯云片源）：列一遍已收录的网盘目录，按番号命中就直接重扫入库
 *      → 重扫（v0.3.0 起不再原地整理）。
 * 两条路都走 w115Claim*，最终都是 rescan()；库里已有该番号离线数据（详情页）→
 * 重扫时 enrichFromCache 自动挂上；没有 → 扫描尾部的 autoScrapeNew 自动排队刮削。
 * 开关：设置 → 刮削「115 推送自动认领」（CFG.auto115Watch，默认开）。任务 24h 未等到文件自动作废。 */
const W115 = { jobs: [], timer: null }
function w115File() { return path.join(cacheDir(), '115-watch.json') }
function w115Load() {
  try { const v = JSON.parse(fs.readFileSync(w115File(), 'utf8')); if (Array.isArray(v.jobs)) W115.jobs = v.jobs } catch (_) {}
}
function w115Save() {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(w115File(), JSON.stringify({ jobs: W115.jobs.slice(-50) }, null, 2)) } catch (_) {}
}
function watch115Push(code, acct) {
  code = norm(String(code || ''))
  if (!code || !bare(code) || CFG.auto115Watch === false) return
  if (W115.jobs.some(j => j.code === code && (j.status === 'watching' || j.status === 'rescanning'))) return
  W115.jobs.push({ code, addedAt: Date.now(), status: 'watching', rounds: 0, seen: {}, note: '', acct: Math.max(1, parseInt(acct, 10) || pan115PushAcctOf()) })
  W115.jobs = W115.jobs.slice(-50)
  w115Save()
  console.log('[115-watch] 盯梢 ' + code + '：等离线下载的文件落进媒体库（每 2 分钟查一轮，24h 内有效）')
  if (W115.timer) { clearTimeout(W115.timer); W115.timer = null }
  W115.timer = setTimeout(() => { W115.timer = null; w115Pump() }, 20000)
}
/* 与 /api/library/matchCode 同口径找文件，但用「词边界」匹配防误伤（ABC-1 不许匹配 ABC-123）。
 * ⚠ 只搜本机媒体库（LIBS）。115 网盘那一侧由 w115Pump 单独调 v115FindByCode —— 这里返回的是
 *   可以用来 fs.statSync 的本地绝对路径，网盘的 `115:/…` 混进来会让后面的稳定性闸门全判失败。 */
async function w115FindMatches(code) {
  const ccode = bare(code)
  if (!ccode || ccode.length < 3) return []
  const re = new RegExp('(^|[^A-Z0-9])' + ccode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Z0-9])')
  const matches = []
  const seen = new Set()
  for (const lib of LIBS) {
    for (const v of await walkAsync(lib)) {
      if (seen.has(v)) continue; seen.add(v)
      let pc = ''
      try { pc = bare(parseName(v).code) } catch (_) {}
      const rawName = (path.basename(v) + ' ' + path.basename(path.dirname(v))).toUpperCase()
      if (pc === ccode || re.test(rawName)) matches.push(v)
    }
  }
  return matches
}
function waitScanDone(maxMs) {
  return new Promise(resolve => {
    const t0 = Date.now()
    const tick = () => {
      if (!SCAN.running || Date.now() - t0 > (maxMs || 30 * 60 * 1000)) return resolve()
      setTimeout(tick, 2000)
    }
    setTimeout(tick, 1500)
  })
}
async function w115Claim(job, files) {
  const code = job.code
  let bound = 0
  for (const v of files) {
    const rel = path.relative(MEDIA_ROOT, v).split(path.sep).join('/')
    let pc = ''
    try { pc = norm(parseName(v).code || '') } catch (_) {}
    if (bare(pc) !== bare(code)) { saveManualCode(rel, code); bound++ }
  }
  job.status = 'rescanning'; job.note = ''; w115Save()
  rescan()                                   // 入库：manualCode 生效 + enrichFromCache / autoScrapeNew
  await waitScanDone()
  enqueuePreview(code)   // 115 下载完成认领入库后，立刻给这部生成悬停预览
  job.status = 'done'
  job.finishedAt = Date.now()
  job.found = files.length; job.bound = bound
  job.note = '已入库 ' + files.length + ' 个文件' + (bound ? '、绑定番号' : '')
  console.log('[115-watch] ✓ ' + code + '：' + job.note)
}
/* 网盘侧认领：文件本来就在已收录的网盘目录里，没有「绑定本地文件」这回事 —— 重扫一遍即可。
 * 扫描时 v115Walk 会把它变成 `115:/…` 条目，enrichFromCache 自动挂上本番号的离线数据。
 * ⚠ 风控优化（2026-10-13）：**故意不清 V115_SNAP** —— 能走到这里说明刚刚（盯梢的 v115FindByCode，
 *   走的就是同一份快照）在这棵目录树里找到了文件，复用同一份快照重扫就能收录，
 *   省掉一次整树重打（实测一个根 27 个子目录 = 27 次 webapi 请求）。 */
async function w115ClaimNet(job, files) {
  const code = job.code
  job.status = 'rescanning'; job.note = ''; w115Save()
  rescan()
  await waitScanDone()
  enqueuePreview(code)
  job.status = 'done'
  job.finishedAt = Date.now()
  job.found = files.length; job.bound = 0
  job.note = '网盘里发现 ' + files.length + ' 个文件，已重新扫描入库'
  console.log('[115-watch] ✓ ' + code + '：' + job.note)
}
/* 盯梢退避（2026-10-13 新增）—— 降低后台对 115 的持续高频访问。
 * 一轮 = 全树遍历网盘（本机实测「破解测试」一个根就 27 个子目录 = 27 次 webapi 请求）。
 * 以前固定 2 分钟一轮：只要有 watching 任务，一天就是上千次带 Cookie 的规整请求 ——
 * 这是最可能触发 115 风控、进而让登录态被安全下线的因素。文件落盘后几分钟内就稳定，
 * 没必要时时刻刻高频扫。间隔：连续未命中 2 → 4 → 8 → 16 → 30 分钟（封顶）；
 * 一旦有发现立刻回到 2 分钟。计数**不落盘**：重启从 0 开始（刚打开程序时盯勤一点更符合直觉）。 */
const W115_MISS = new Map()
const W115_ROUND_MAX = 3          // 每轮最多查几个盯梢任务（多了就是给风控送流量，见 w115Pump）
function w115GapMs() {
  let best = null
  for (const j of W115.jobs) {
    if (j.status !== 'watching') { W115_MISS.delete(j.code); continue }
    const m = W115_MISS.get(j.code) || 0
    best = best === null ? m : Math.min(best, m)     // 最新鲜的那个任务决定频率
  }
  if (best === null) return 120000
  return Math.min(120000 * Math.pow(2, Math.min(best, 4)), 30 * 60 * 1000)
}
async function w115Pump() {
  W115.timer = null
  if (W115.running) { w115Reschedule(120000); return }   // 上一轮还没跑完 → 稍后再来
  W115.running = true
  try {
    if (CFG.auto115Watch !== false) {
      if (SCAN.running) return w115Reschedule(120000)   // 扫描中让路（walk 云盘挂载很贵）
      const act = []
      const now = Date.now()
      for (const job of W115.jobs) {
        if (job.status !== 'watching') continue
        if (now - job.addedAt > 24 * 3600 * 1000) { job.status = 'expired'; job.note = '24 小时未等到文件，已放弃'; continue }
        act.push(job)
      }
      /* ⚠ 每轮只查前 W115_ROUND_MAX 个（2026-10-15）：一次盯梢十来部时，
       * 旧实现一轮就是十几次搜索请求，而且这些请求彼此只隔 2 分钟 —— 后台长期高频打接口，
       * 是最容易把登录态耗掉的一种用法。现在一轮封顶 3 个，其余顺延到下一轮（退避照旧生效）。 */
      if (act.length > W115_ROUND_MAX) {
        for (const job of act.slice(W115_ROUND_MAX)) if (!job.note) job.note = '排队中（本轮先查前 ' + W115_ROUND_MAX + ' 个）'
      }
      for (const job of act.slice(0, W115_ROUND_MAX)) {
        try {
          const matches = await w115FindMatches(job.code)
          /* ★ 网盘侧也要看（2026-10-13 修）：w115FindMatches 只遍历 LIBS（本机媒体库），
           *   而「推送 115 离线下载 → 等文件落盘」这套流程在纯网盘片源下根本没有本地文件 ——
           *   于是 rounds 永远是 0，任务干等 24h 才过期，用户以为「自动认领」坏了。
           *   走 force=false 复用 10 分钟列目录快照，不额外打接口。 */
          let net = []
          try { net = await v115FindByCode(bare(job.code), job.code) } catch (_) {}   // 2026-10-14 起 = 搜索接口 1~2 请求，不再整树
          if (!matches.length && !net.length) {
            job.rounds = 0; job.seen = {}
            W115_MISS.set(job.code, (W115_MISS.get(job.code) || 0) + 1)   // 连续没等到 → 下一轮拉长间隔
            /* 匹配不到时把原因挂到任务上（网盘读不了 / 没登记目录 …），详情页与设置页能直接看到，
             * 而不是盯着一个永远「等待中」的任务猜 */
            const why = V115_FIND_NOTE || v115AuthNote()
            if (why) job.note = why
            continue
          }
          W115_MISS.delete(job.code)   // 一有动静就回到高频，别让退避拖慢真实文件的认领
          /* 网盘里已经有了 → 直接走重扫入库（网盘文件没有「等大小稳定」这回事：离线下载完成后就是最终大小） */
          if (net.length) { await w115ClaimNet(job, net); continue }
          /* 稳定性闸门：连续两轮都看到且大小不变才认领（防云盘列表瞬态） */
          const snap = {}
          const stable = []
          for (const v of matches) {
            let sz = 0
            try { sz = fs.statSync(v).size } catch (_) { continue }
            const rel = path.relative(MEDIA_ROOT, v).split(path.sep).join('/')
            snap[rel] = sz
            if (sz > 0 && (job.seen || {})[rel] === sz) stable.push(v)
          }
          job.seen = snap
          if (!stable.length) continue
          await w115Claim(job, stable)
        } catch (e) { job.note = e.message }
      }
      w115Save()
    }
  } finally { W115.running = false }
  w115Reschedule(w115GapMs())
}
function w115Reschedule(ms) {
  if (W115.timer || !W115.jobs.some(j => j.status === 'watching')) return
  W115.timer = setTimeout(() => { W115.timer = null; w115Pump() }, ms)
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
    const name = mnStrip((chunk.match(/<h[23] class="ttl"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
    const works = +((chunk.match(/<td[^>]*>\s*(\d{1,6})\s*<\/td>/) || [])[1] || 0)
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
  if (CFG.autoRescan === false) return            // 默认开：只有设置里明确关掉才停
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
try { if (!fs.existsSync(MERGE_FILE)) fs.writeFileSync(MERGE_FILE, '{}') } catch (_) {}

/* ---------- 女优名册每日自动同步（relay/roster.json → actresses.json） ----------
 * 名册约 16MB，不便随镜像分发，改放公共仓库 ShHEdisonXu/javpaco-relay
 * （GitHub Actions 每日从 minnano 全量同步后提交）。本服务每天拉一次，
 * 以后本机/CI 侧更新名册，容器次日自动跟上，不必再手动部署。
 *
 * 通道：relayBuf() 依次试 raw.githubusercontent.com → cdn.jsdelivr.net → GitHub Contents API。
 *   NAS 实测 raw 被墙（fetch failed），jsDelivr 可用（16MB 约 100s），任一成功即可。
 *
 * ⚠️ 安全阀（重要）：只有远端条数 > 本地条数才写回。relay 通常落后于本机同步结果
 * （2026-10-01 实测远端 25407 < 本地 25421），无条件覆盖会把本地补全的资料整体回退。
 * 写回走 tmp+rename 原子替换；/actresses.json 的合并缓存以 mtime+size 作 key，会自动失效。
 *
 * 省钱优化：先用 Contents API 取远端字节数（几 KB），与上次同步记录一致就跳过下载，
 *   避免每天白拉 16MB。探测失败则照常走全量。
 * 默认每天 04:00 同步（CFG.rosterSyncHour 可改），CFG.rosterSync === false 可关闭。 */
const RELAY_ROSTER_API = RELAY_API + 'roster.json'
const ROSTER_SYNC_STATE = path.join(UI_ROOT, 'roster-sync-state.json')
const ROSTER_SYNC = { running: false, phase: '', last: 0, ok: false, remote: 0, before: 0, added: 0, filled: 0, error: '', skipped: false, note: '', remoteSize: 0 }
function rosterSyncState() { try { return JSON.parse(fs.readFileSync(ROSTER_SYNC_STATE, 'utf8')) || {} } catch (_) { return {} } }
function rosterSyncHour() { const h = parseInt(CFG.rosterSyncHour, 10); return isNaN(h) ? 4 : Math.max(0, Math.min(23, h)) }
function rosterSyncLast() { return +rosterSyncState().last || 0 }
function rosterCount() { try { const v = JSON.parse(fs.readFileSync(ROSTER, 'utf8')); return Array.isArray(v) ? v.length : 0 } catch (_) { return 0 } }
function rosterSyncSave() {
  try {
    fs.writeFileSync(ROSTER_SYNC_STATE, JSON.stringify({
      last: ROSTER_SYNC.last, remote: ROSTER_SYNC.remote, before: ROSTER_SYNC.before,
      added: ROSTER_SYNC.added, filled: ROSTER_SYNC.filled, ok: ROSTER_SYNC.ok, skipped: ROSTER_SYNC.skipped,
      note: ROSTER_SYNC.note, error: ROSTER_SYNC.error, remoteSize: ROSTER_SYNC.remoteSize
    }))
  } catch (_) {}
}
/* 远端字节数（Contents API 返回的 JSON 很小）——只用来判断值不值得下 16MB 全量 */
async function relayRosterSize() {
  try {
    const r = await fetch(RELAY_ROSTER_API, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return 0
    const j = await r.json()
    return +((j && j.size) || 0) || 0
  } catch (_) { return 0 }
}
async function rosterSyncOnce(tag) {
  if (ROSTER_SYNC.running) return { ok: false, error: '同步中' }
  ROSTER_SYNC.running = true
  ROSTER_SYNC.phase = '探测远端'; ROSTER_SYNC.error = ''; ROSTER_SYNC.skipped = false; ROSTER_SYNC.note = ''
  try {
    /* ① 先问一下远端的字节数：和上次同步时一致就说明没更新，直接跳过（省 16MB 下载） */
    const rz = await relayRosterSize()
    const prev = rosterSyncState()
    if (rz && prev.remoteSize && rz === prev.remoteSize && prev.ok) {
      ROSTER_SYNC.ok = true; ROSTER_SYNC.skipped = true; ROSTER_SYNC.phase = '跳过'
      ROSTER_SYNC.note = '远端未变化（' + rz + ' 字节）'; ROSTER_SYNC.remoteSize = rz
      ROSTER_SYNC.last = Date.now(); rosterSyncSave()
      console.log('[roster-sync] ' + tag + '：远端未变化（' + rz + ' 字节），跳过')
      return { ok: true, skipped: true, note: ROSTER_SYNC.note }
    }
    /* ② 拉全量（绕过 10 分钟缓存，确保拿到远端最新）
     * 超时给足 5 分钟：jsDelivr 拉 16MB 实测 100~180s 波动，余量不够会白等一场。 */
    ROSTER_SYNC.phase = '拉取 roster.json'
    relayCache.delete('roster.json')
    const buf = await relayBuf('roster.json', 300000)
    if (!buf) throw new Error('relay 不可达（raw / jsDelivr / Contents API 均失败）')
    ROSTER_SYNC.phase = '解析'
    let remote
    try { remote = JSON.parse(buf.toString('utf8')) } catch (_) { throw new Error('远端 roster.json 不是合法 JSON') }
    if (!Array.isArray(remote) || !remote.length) throw new Error('远端名册为空或格式异常')
    const before = rosterCount()
    ROSTER_SYNC.remote = remote.length; ROSTER_SYNC.before = before
    /* ③ 合并写回（2026-10-02 改造，原来是「远端条数更多才整体覆盖」）：
     * 远端 CI 会全量补资料（愛称/公式サイト/现用名 mcanon/别名/标签…），条数不一定比本地多
     * （本地手工补过的人不在远端），按条数做安全阀会把补全的资料永远挡在门外。
     * 改成逐条合并 —— 只「填空」不覆盖：本地已有值的字段一律保留，远端只补本地为空的字段，
     * 远端独有的女优整条追加。任何方向的回退都不可能发生。 */
    const MERGE_FILL = ['furi', 'birthday', 'height', 'breast', 'cup', 'waist', 'hip', 'shoe',
      'blood', 'place', 'hobby', 'period', 'debut', 'agency', 'blog', 'nick', 'official',
      'mcanon', 'mimg', 'msrc', 'icon', 'iconRemote', 'debutDate', 'videoCount', 'type',
      'name_ja', 'name_zh', 'name_en']
    const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    const byMnid = new Map(), byName = new Map()
    let list
    try { list = JSON.parse(fs.readFileSync(ROSTER, 'utf8')) } catch (_) { list = [] }
    for (const a of list) {
      if (!a) continue
      const k = String(a.mnid || '').replace(/\D/g, '')
      if (k && !byMnid.has(k)) byMnid.set(k, a)
      const nk = cnormJa(a.name)
      if (nk && !byName.has(nk)) byName.set(nk, a)
      if (Array.isArray(a.alias)) for (const x of a.alias) { const ak = cnormJa(x); if (ak && !byName.has(ak)) byName.set(ak, a) }
    }
    let addedN = 0, filled = 0
    for (const r of remote) {
      if (!r) continue
      const k = String(r.mnid || '').replace(/\D/g, '')
      let a = k ? byMnid.get(k) : null
      if (!a) { const nk = cnormJa(r.name); if (nk) a = byName.get(nk) }
      if (!a) { list.push(r); if (k) byMnid.set(k, r); const nk = cnormJa(r.name); if (nk) byName.set(nk, r); addedN++; continue }
      for (const f of MERGE_FILL) if (isEmpty(a[f]) && !isEmpty(r[f])) { a[f] = r[f]; filled++ }
      if (isEmpty(a.alias) && Array.isArray(r.alias) && r.alias.length) a.alias = r.alias
      if (isEmpty(a.tags) && Array.isArray(r.tags) && r.tags.length) a.tags = r.tags
      if (isEmpty(a.rel) && Array.isArray(r.rel) && r.rel.length) a.rel = r.rel
    }
    ROSTER_SYNC.phase = '写回'
    const tmp = ROSTER + '.sync'
    fs.writeFileSync(tmp, JSON.stringify(list, dropEmpty)); fs.renameSync(tmp, ROSTER)
    AVA_ONLINE_INDEX = null                    // 名册换了 → 头像在线索引作废
    ROSTER_SYNC.added = addedN; ROSTER_SYNC.filled = filled; ROSTER_SYNC.ok = true; ROSTER_SYNC.phase = '完成'
    ROSTER_SYNC.remoteSize = rz || buf.length
    ROSTER_SYNC.last = Date.now(); rosterSyncSave()
    console.log('[roster-sync] %s：合并完成 远端 %d / 本地 %d → 新增 %d 人、补全字段 %d 处', tag, remote.length, before, addedN, filled)
    return { ok: true, before, remote: remote.length, added: addedN, filled }
  } catch (e) {
    /* 失败**不**更新 last（last 只记「上次成功」）→ 定时器隔 1 小时会再试，
     * 否则一次网络抖动就把当天机会用光、要等明天。 */
    ROSTER_SYNC.ok = false; ROSTER_SYNC.phase = '失败'; ROSTER_SYNC.error = String((e && e.message) || e)
    rosterSyncSave()
    console.log('[roster-sync] ' + tag + ' 失败：' + ROSTER_SYNC.error)
    return { ok: false, error: ROSTER_SYNC.error }
  } finally {
    ROSTER_SYNC.running = false
  }
}
let rosterSyncTrying = 0
function rosterSyncTick() {
  if (CFG.rosterSync === false) return                    // 设置里关掉了
  if (ROSTER_SYNC.running) return
  const now = new Date()
  if (now.getHours() < rosterSyncHour()) return           // 还没到今天的同步时刻
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rosterSyncHour()).getTime()
  if (rosterSyncLast() >= todayAt) return                 // 今天已经同步过
  if (Date.now() - rosterSyncTrying < 55 * 60 * 1000) return   // 失败后至少隔 1 小时再试
  rosterSyncTrying = Date.now()
  rosterSyncOnce('auto').catch(() => {})
}
setInterval(rosterSyncTick, 30 * 60 * 1000)
setTimeout(rosterSyncTick, 8 * 60 * 1000)                 // 启动 8 分钟后先查一次（补上停机期间错过的时点）

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

/* 直连抓取：优先 fetch（undici）——CDN（vcsheaye.cc 等）会对 https.request 的
 * 裸请求特征直接 403（同 URL fetch 200 / https.get 403 实测）；失败且配置了代理
 * 时兜底走一次隧道代理（fetch 不认代理环境变量，退回 https.request 实现）。 */
function mvRawOnce(url, hdrs = {}, deadlineMs = 20000, useProxy = false) {
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
async function mvOnce(url, hdrs = {}, deadlineMs = 20000, useProxy = false) {
  if (useProxy) return mvRawOnce(url, hdrs, deadlineMs, true)
  const h = Object.assign({}, hdrs)
  delete h.__proxied
  try {
    const rs = await fetch(url, { headers: h, redirect: 'manual', signal: AbortSignal.timeout(deadlineMs || 20000) })
    const headers = {}
    rs.headers.forEach((v, k) => { headers[k] = v })
    return { status: rs.status, headers, buf: Buffer.from(await rs.arrayBuffer()) }
  } catch (e) {
    if (proxyUrl()) return mvRawOnce(url, hdrs, deadlineMs, true)
    throw e
  }
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
  const ordered = [mirror, ...routes].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4)
  /* CDN 防盗链策略组合拳（域名还会轮换）：有的 CDN 带镜像 referer 才给真 m3u8，
   * 有的反而只给无 referer 放行，还有的直接 403。逐镜像 ×「带/不带 referer」组合尝试，
   * 每次结果都用 #EXTM3U 验货，假货（JPEG 诱饵）就换下一组合。 */
  const attempts = []
  for (const site of ordered) attempts.push({ site, ref: true }, { site, ref: false })
  let idx = 0
  const tryRoute = () => {
    if (idx >= attempts.length) { if (!res.headersSent) { res.writeHead(502) } return res.end('missav relay failed') }
    const att = attempts[idx++]
    const upstream = att.site + '/jmpres/surrit.com/' + uuid + rest + suffix
    mvStreamUpstream(upstream, att, isPlaylist, res, (err, buf) => {
      if (buf) {   // m3u8 内容拿到但需要重写——先验货：CDN 防盗链会把请求引到 JPEG 诱饵图
        const text0 = Buffer.concat(buf).toString('utf8')
        if (!/^\uFEFF?\s*#EXTM3U/.test(text0)) { mvNote(att.site, false); return tryRoute() }
        mvNote(att.site, true)
        const baseDir = rest.replace(/[^/]*$/, '')
        const out = missavRewriteM3U8(text0, uuid, baseDir, att.site)
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
        return res.end(out)
      }
      mvNote(att.site, false)
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
/* 上游取流：m3u8 走 302 跟随后缓冲（交给回调重写），分片直接管道。
 * 同 mvOnce：必须用 fetch（undici），https.get 会被 CDN 403。
 * referer 必须保留（镜像站 referer 是 CDN 防盗链白名单，不带会收到 JPEG 诱饵图）。 */
function mvStreamUpstream(url, att, isPlaylist, res, onDone, uuid) {
  const site = att.site
  const hdrs = { 'user-agent': MISSAV_UA, accept: '*/*' }
  if (att.ref !== false) hdrs.referer = site + '/'   // 带/不带 referer 两种组合都试（见 missavHlsReq）
  const deadline = isPlaylist ? 25000 : 120000   // 分片可能几 MB，给足墙钟；m3u8 快速失败
  ;(async () => {
    let cur = url
    for (let hop = 0; hop <= 5; hop++) {
      let rs
      try { rs = await fetch(cur, { headers: hdrs, redirect: 'manual', signal: AbortSignal.timeout(deadline) }) }
      catch (e) { return onDone(e, null) }
      if ([301, 302, 303, 307, 308].includes(rs.status) && rs.headers.get('location')) {
        try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {}
        cur = new URL(rs.headers.get('location'), cur).href
        continue
      }
      if (rs.status !== 200) { try { if (rs.body) rs.body.cancel().catch(() => {}) } catch (_) {} return onDone(new Error('HTTP ' + rs.status), null) }
      if (!isPlaylist) {
        const hh = { 'Content-Type': rs.headers.get('content-type') || 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
        if (rs.headers.get('content-length')) hh['Content-Length'] = rs.headers.get('content-length')
        if (rs.headers.get('accept-ranges')) hh['Accept-Ranges'] = rs.headers.get('accept-ranges')
        if (rs.headers.get('content-range')) hh['Content-Range'] = rs.headers.get('content-range')
        res.writeHead(rs.status === 206 ? 206 : 200, hh)
        require('stream').Readable.fromWeb(rs.body).pipe(res)
        return
      }
      const chunks = []
      try { for await (const c of rs.body) chunks.push(Buffer.from(c)) }
      catch (e) { return onDone(e, null) }
      return onDone(null, chunks)
    }
    return onDone(new Error('重定向次数过多'), null)
  })()
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    const p = decodeURIComponent(u.pathname)
    /* 访问口令（可选）：开启后除登录页与本机之外都要先验证。
     * 本机判定走 TCP 对端地址（isLocalReq），不看 Host —— 见该函数上方注释。 */
    if (ACCESS_CODE() && !isLocalReq(req)) {
      if (p === '/login') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML) }
      if (!hasAccess(req, p)) {
        if (p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/cache/') || p.startsWith('/thumb/')) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end('{"ok":false,"error":"需要访问口令"}') }
        res.writeHead(302, { Location: '/login' }); return res.end()
      }
    }
    /* ---------- 海报墙缩略图：/thumb/<番号>/<poster|fanart> ----------
     * 全尺寸原图（海报可到 1032×1468、大图 2184×1468，单张几百 KB ~ 1MB）直接喂墙会拖慢滚动，
     * 这里压成墙用小图（海报限高 720 / 大图限宽 960），原图仍留给详情页。
     * 缩略图缓存 cache/thumbs/，按源图 mtime 失效；生成失败回退原图。
     * ⚠ 这段必须放在主处理器里：之前它被误写在 handleActorApi 内部，而那个函数只服务
     *   /api/* 几类路径，/thumb/ 永远 404 → 前端静默回退全尺寸原图，缩略图优化形同虚设。 */
    if (p.startsWith('/thumb/')) {
      const MT = /^\/thumb\/([A-Za-z0-9._-]+)\/(poster|fanart)$/.exec(p)
      if (MT) {
        movieThumb(MT[1], MT[2]).then(tb => {
          if (tb) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': tb.length, 'Cache-Control': 'public, max-age=604800' })
            return res.end(tb)
          }
          sendFile(req, res, path.join(cacheDir(), 'movies', MT[1], 'images', MT[2] + '.jpg'))
        }).catch(() => { try { res.writeHead(404); res.end('Not Found') } catch (_) {} })
        return
      }
      res.writeHead(404); return res.end('Not Found')
    }
    if (p === '/api/library/browse') return json(res, libraryBrowse(u.searchParams.get('path') || ''))
    /* 前端自动重载用：返回 index.html 的 mtime；前端轮询发现变化就自动刷新页面，
     * 免去 Mac 版 webview 不认 ⌘R/⌘Q 导致的「改了不生效」。 */
    if (p === '/api/ui-version') {
      try { const st = fs.statSync(path.join(__dirname, 'index.html')); return json(res, { ok: true, ts: st.mtimeMs }) } catch (_) { return json(res, { ok: false }) }
    }
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
    /* 外部播放器（Mac 原生）：返回视频在宿主机上的绝对路径，原生桥用它调起 IINA/VLC/mpv。
     * 仅在原生模式（NATIVE=Mac/Win）有意义 —— 浏览器/容器里路径对客户端不可见。
     * 走 Node 代理经 FUSE 单通道读网盘很慢，原生播放器直接读挂载（或走 HTTP 流）缓冲好得多。*/
    if (p === '/api/filepath') {
      if (!NATIVE) return json(res, { ok: false, error: '仅原生版（Mac/Win）支持外部播放器' })
      const rel = (u.searchParams.get('rel') || '').trim()
      const fp = safeMediaPath(rel)
      if (!fp) return json(res, { ok: false, error: 'bad rel' })
      fs.promises.stat(fp).then(st => {
        if (!st.isFile()) return json(res, { ok: false, error: '文件不存在' })
        json(res, { ok: true, path: fp, native: true })
      }).catch(e => json(res, { ok: false, error: e.code || e.message || String(e) }))
      return
    }
    /* 女优头像候选缩略图：外部图床多半防盗链，统一由服务端代取（GET，供 <img src> 直接用） */
    if (p === '/api/actor/thumb') return actorThumb(res, u.searchParams.get('u') || '')
    /* 海报悬停预览动图：只回「本地抽帧短片」的清单（codes + file）。
     * 线上动图（JavDB 预览片）走 /api/preview/online，按番号现查（正负都有缓存）。
     * 抽帧参数改版时只需改服务端 PREV_FILE，前端不用跟着改。 */
    if (p === '/api/previews') {
      if (!previewEnabled()) return json(res, { ok: true, on: false, codes: [], file: PREV_FILE })
      const codes = previewScanCodes()
      for (const c of PREV_SET) if (codes.indexOf(c) < 0) codes.push(c)
      return json(res, { ok: true, on: true, codes, file: PREV_FILE })
    }
    /* 悬停预览·线上动图（JavDB 官方预览片，真 HLS 视频，浏览器端 hls.js 直连拉流）：
     *   /api/preview/online           → JSON { ok, url, marks, total, slices }
     *                                   marks = 每个切片起始秒数，前端按「每片 1 秒」跳着播；
     *                                   url 指下面的播放列表，由前端交给 hls.js.loadSource。
     *   /api/preview/online/playlist  → 裁好的 HLS 播放列表文本（6 个切片）。
     * 注：本回调不是 async，凡是要 await 的路由都包一层内层 async IIFE（与既有 ;(async () => { 风格一致） */
    if (p === '/api/preview/online') {
      if (!previewEnabled()) return json(res, { ok: false, error: '悬停预览已关闭' })
      const code = String(u.searchParams.get('code') || '').trim()
      if (!code) return json(res, { ok: false, error: '缺少番号' })
      const n = Math.max(1, Math.min(12, parseInt(u.searchParams.get('n') || '', 10) || PREV_SEGS))
      ;(async () => {
        const key = bare(code)
        const warmed = pvOnlineCached(key)
        /* 还没预热到这部 → 立刻插到预热队首（下一轮一定轮到），本轮最多只等 2.5s。
         * 不能让前端一直干等：它那边 hover 只停一两秒，等 1.8s 以上等于没有预览；
         * 而且前端会把「慢」误当成「没有」把这个番号冻住 10~15 分钟
         *（那一边已改成 warming 响应不落缓存，见 index.html 的 fetchOnline）。 */
        if (!warmed) pvWarmStart([code])
        let pl = null
        try {
          pl = await Promise.race([
            previewOnlinePlaylist(code, n),
            new Promise(r => setTimeout(() => r(null), 2500))
          ])
        } catch (e) {
          /* 服务端明确查到「线上没这部片 / 没预览片」→ 如实回报，让前端缓存住别反复问 */
          if (e && e.pvMiss) return json(res, { ok: false, error: (e && e.message) || '这部片线上没有预览片' })
          if (!warmed) return json(res, { ok: true, warming: true, code, url: '', marks: [] })
          return json(res, { ok: false, error: (e && e.message) || '取线上预览片失败' })
        }
        /* 2.5s 没回来 = 还在查（或在排队）→ 回 warming：前端这次不出画面，但**不记成没有**，
         * 下次 hover 直接命中（那时预热已把它查好了）。 */
        if (!pl) return json(res, { ok: true, warming: true, code, url: '', marks: [] })
        return json(res, {
          ok: true, code, id: pl.id, slices: n, marks: pl.marks, total: pl.total,
          url: '/api/preview/online/playlist?code=' + encodeURIComponent(code) + '&n=' + n
        })
      })().catch(e => { try { json(res, { ok: false, error: (e && e.message) || '取线上预览片失败' }) } catch (_) {} })
      return
    }
    /* 前端把「当前这一屏」的番号报过来，让预热先照顾用户马上要 hover 的那些。
     * 只要番号、不要结果：服务端查完写进自己的缓存，前端下一次 hover 就是毫秒级命中。
     * 所以这一路即使失败也完全不影响页面（前端 fire-and-forget）。 */
    if (p === '/api/preview/warm') {
      if (!previewEnabled()) return json(res, { ok: false, error: '悬停预览已关闭' })
      ;(async () => {
        let body = ''
        try { body = await readBody(req) } catch (_) {}
        let codes = []
        try { codes = (JSON.parse(String(body || '{}')).codes || []) } catch (_) {}
        /* 上限 60：一屏卡片通常十几张，设大了等于被一个请求拖着预热整库 */
        codes = codes.map(c => String(c || '').trim()).filter(Boolean).slice(0, 60)
          if (codes.length) pvWarmStart(codes)
          /* codes 为空 = 「重排一次队列」。前端切换「用 115 云盘片源生成预览」开关后靠它立刻生效
             —— 否则服务端要等到下次启动或重扫才会把 115 那批排进去。 */
          else { try { schedulePreviews() } catch (_) {} }
          return json(res, { ok: true, queued: codes.length, running: PVWARM.on })
      })().catch(() => { try { json(res, { ok: false }) } catch (_) {} })
      return
    }
    if (p === '/api/preview/online/playlist') {
      if (!previewEnabled()) { res.writeHead(403); return res.end('preview off') }
      const code = String(u.searchParams.get('code') || '').trim()
      const n = Math.max(1, Math.min(12, parseInt(u.searchParams.get('n') || '', 10) || PREV_SEGS))
      if (!code) { res.writeHead(400); return res.end('missing code') }
      ;(async () => {
        const pl = await previewOnlinePlaylist(code, n)
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
        })
        return res.end(pl.list)
      })().catch(e => {
        console.log('[preview] 线上预览片失败 ' + code + '：' + ((e && e.message) || e))
        try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('preview unavailable') } catch (_) {}
      })
      return
    }
    /* ---------- MissAV 在线播放：解析（GET）+ HLS 中转（GET） ---------- */
    if (p === '/api/missav/play') return handleMissavPlay(req, res, u)
    if (p.startsWith('/api/missav/hls/')) return missavHlsReq(res, p, u)
    /* 数据源列表（只读）：番号外链排序 + 添加页数据源下拉用（v0.3.0 起界面不再编辑数据源） */
    if (p === '/api/sources') {
      if (req.method !== 'GET') { res.writeHead(405); return res.end() }
      const sd = getSourcesData()
      return json(res, { ok: true, sources: sd.sources.map(x => ({ id: x.id, name: x.name, enabled: !!x.enabled })), priorities: sd.priorities })
    }
    if (p === '/api/config' || p === '/api/config/test' || p === '/api/prefs' || p === '/api/rank/update' || p === '/api/rank/status' || p === '/api/roster/sync' ||
        p === '/api/audit/deadlink' ||
        p === '/api/gap/actor' || p === '/api/disk' ||
        p === '/api/actor/scrape' || p === '/api/actor/save' || p === '/api/actor/sync' ||
        p === '/api/actor/merge' ||
        p === '/api/actor/probe' || p === '/api/actor/pick-avatar' ||
        p === '/api/library' || p === '/api/library/add' || p === '/api/library/remove' || p === '/api/library/rescan' ||
        p === '/api/sources/media' || p === '/api/srchealth' || p === '/api/srchealth/probe' ||
        p === '/api/sites' || p === '/api/sites/save' || p === '/api/sites/del' || p === '/api/sites/hit' || p === '/api/sites/icon' || p === '/api/sites/probe' ||
        p === '/api/sites/icons/refresh' || p === '/api/sites/icons/candidates' || p === '/api/sites/img' ||
        p === '/api/library/matchCode' || p === '/api/library/bindCode' || p === '/api/lib/hide' ||
        p === '/api/watch' || p === '/api/watch/del' || p === '/api/watch/done' ||
        p === '/api/userdata' ||
        p === '/api/movie/delete' ||
        p === '/api/backup' || p === '/api/login' ||
        p === '/api/favorites' || p === '/api/subscriptions' || p === '/api/subscriptions/feed' || p === '/api/jdbcodes' ||
        p === '/api/jdbcuncensored' ||
        p === '/api/online/status' || p === '/api/online/proxy' || p === '/api/online/direct' || p === '/api/online/image' || p === '/api/online/config' || p === '/api/online/playlines' ||
        p === '/api/online/detail' || p === '/api/online/reviews' || p === '/api/online/board' || p === '/api/online/search' || p === '/api/online/actor' ||
        p === '/api/online/actor_movies' ||
        p === '/api/online/dirs' || p === '/api/online/entity' ||
        p === '/api/115/config' || p === '/api/115/test' || p === '/api/115/push' || p === '/api/115/tasks' || p === '/api/115/dirs' || p === '/api/115/watch' ||
        p.startsWith('/api/115/lib') ||
        /* WebDAV / 光鸭网盘（config 是 GET+POST，lib 同；test/lib/add/lib/remove 只 POST） */
        p === '/api/webdav/config' || p.startsWith('/api/webdav/') ||
        p === '/api/guangya/config' || p.startsWith('/api/guangya/') ||
        p === '/api/subs' || p === '/api/subs/get') {
      if (req.method !== 'POST' &&
        !(p === '/api/config' && req.method === 'GET') && !(p === '/api/prefs' && req.method === 'GET') &&
        !(p === '/api/actor/merge' && req.method === 'GET') &&
        !(p === '/api/rank/status' && req.method === 'GET') &&
        !(p === '/api/roster/sync' && req.method === 'GET') &&
        !(p === '/api/audit/deadlink' && req.method === 'GET') &&
        !(p === '/api/disk' && req.method === 'GET') &&
        !(p === '/api/watch' && req.method === 'GET') &&
        !(p === '/api/userdata' && req.method === 'GET') &&
        !(p === '/api/backup' && req.method === 'GET') &&
        !(p === '/api/favorites' && req.method === 'GET') &&
        !(p === '/api/subscriptions' && req.method === 'GET') &&
        !(p === '/api/subscriptions/feed' && req.method === 'GET') &&
        !(p === '/api/jdbcodes' && req.method === 'GET') &&
        !(p === '/api/jdbcuncensored' && req.method === 'GET') &&
        !(p.startsWith('/api/online/') && req.method === 'GET') &&
        !(p === '/api/115/config' && req.method === 'GET') &&
        !(p === '/api/115/dirs' && req.method === 'GET') &&
        !(p === '/api/115/lib' && req.method === 'GET') &&
        !(p === '/api/115/lib/browse' && req.method === 'GET') &&
        !(p === '/api/115/lib/stream' && req.method === 'GET') &&
        !(p === '/api/115/lib/prefetch' && req.method === 'GET') &&
        !(p === '/api/webdav/config' && req.method === 'GET') &&
        !(p === '/api/guangya/config' && req.method === 'GET') &&
        !(p === '/api/webdav/lib' && req.method === 'GET') &&
        !(p === '/api/guangya/lib' && req.method === 'GET') &&
        !(p === '/api/guangya/acct/next' && req.method === 'GET') &&   // 光鸭「下一个可用账号号」（多账号）
        !((p.startsWith('/api/webdav/') || p.startsWith('/api/guangya/')) && req.method === 'GET' && /\/lib\/browse$/.test(p)) &&
        !(p === '/api/subs/get' && req.method === 'GET') &&
        !(p === '/api/library' && req.method === 'GET') &&
        !(p === '/api/sources/media' && req.method === 'GET') &&
        !(p === '/api/srchealth' && req.method === 'GET') &&
        !(p === '/api/sites' && req.method === 'GET') &&
        !(p === '/api/sites/icon' && req.method === 'GET') &&
        !(p === '/api/sites/img' && req.method === 'GET') &&
        !(p === '/api/sites/probe' && req.method === 'GET')) { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p.startsWith('/api/offline/') || p.startsWith('/api/import/')) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p.startsWith('/api/scrape/') || p.startsWith('/api/images/')) {
      const isGet = p === '/api/scrape/status' || p === '/api/scrape/list' || p === '/api/scrape/meta' ||
        (p === '/api/scrape/history' && req.method === 'GET')
      /* 队列端点两种方法都要：GET 查状态 / POST 暂停·继续·清空·插队·移除。
       * ⚠️ 别把它塞进 isGet —— 那样 POST 会被 405 挡掉（改队列管理时踩过）。 */
      const bothWays = p === '/api/scrape/queue'
      if (!bothWays && (isGet ? req.method !== 'GET' : req.method !== 'POST')) { res.writeHead(405); return res.end() }
      handleActorApi(req, res, p).catch(e => json(res, { ok: false, error: e.message }))
      return
    }
    if (p === '/api/scan') {
      return json(res, Object.assign({ ok: true }, SCAN, { hasData: !!DATA }))
    }
    /* 取消扫描：POST /api/scan/cancel —— 幂等，不在扫描中也返回 ok。
     * 前端「停止」按钮用；服务端在每个可中断点检查 SCAN.cancel 真正停下来（不是前端假装的）。 */
    if (p === '/api/scan/cancel') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      return json(res, scScanCancel())
    }
    /* 定向扫描：POST /api/scan/scope { kind:'115'|'guangya'|'webdav', acct:<账号号>, key:<cid|path> }
     * 「已收录目录」列表里每个目录旁的 ⟳ 按钮 → 只重扫这一个根，其它来源不碰。
     * key 按来源查 roots（115 按 cid、dav/光鸭 按 path），查不到就明确报错。
     * ⚠ 2026-10-14：**用户点名动作优先** —— 有扫描在跑时先把它取消掉再跑定向，
     *   否则定向请求只能挂在 pendingScope 后面干等（全量扫 115 整树要十几分钟，
     *   用户点了 ⟳ 半天没反应，看起来就是「按钮点不了」）。 */
    if (p === '/api/scan/scope') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      ;(async () => {
        let body = ''
        try { body = await readBody(req) } catch (_) {}
        let kind = '', key = '', acct = 1
        try {
          const b = JSON.parse(String(body || '{}'))
          kind = String(b.kind || ''); key = String(b.key || '')
          acct = Math.max(1, parseInt(b.acct, 10) || 1)
        } catch (_) {}
        let root = null
        if (kind === '115') root = v115Roots(acct).find(r => String(r.cid) === key.replace(/[^\d]/g, '')) || null
        else if (kind === 'guangya' || kind === 'webdav') {
          const np = s => String(s || '').replace(/^\/+|\/+$/g, '')
          root = davRoots(kind, acct).find(r => np(r.path) === np(key)) || null
        }
        if (!root) return json(res, { ok: false, error: '找不到这个已收录目录（可能刚被移出，刷新一下列表）' })
        root = Object.assign({}, root, { acct })
        /* 抢占：取消正在跑的那一轮，等它真正停下（每个可中断点最多 10s 收手）再起定向扫描 */
        let preempted = false
        if (SCAN.running) {
          preempted = true
          scScanCancel()
          for (let i = 0; i < 200 && SCAN.running; i++) await new Promise(r => setTimeout(r, 100))
          if (SCAN.running) return json(res, { ok: false, error: '当前扫描停不下来（可能卡在网盘读取），稍后再点一次' })
        }
        SCAN.pending = false; SCAN.pendingScope = null
        rescan({ roots: [{ kind: kind === '115' ? 'v115' : kind, root }] })
        return json(res, { ok: true, acct, scanning: SCAN.running, preempted, name: root.name || root.path || root.cid })
      })().catch(e => { try { json(res, { ok: false, error: e.message }) } catch (_) {} })
      return
    }
    if (p === '/api/movie' || p === '/api/cache' || p === '/api/cache/clean' ||
        p === '/api/cache/migrate' || p === '/api/cache/migrate/cleanup') {
      const okM = (p === '/api/movie' && req.method === 'POST') ||
        (p === '/api/cache' && req.method === 'GET') ||
        ((p === '/api/cache/clean' || p === '/api/cache/migrate' || p === '/api/cache/migrate/cleanup') && req.method === 'POST')
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
        /* 404 也让浏览器缓存 30 分钟：前端几十个头像请求 miss 时不反复打回来，
         * 否则每次翻页/刷新都重试在线链，页面资源队列被拖慢。
         * 在线兜底的 200 只给 1h 强缓存（曾经 24h）：本地文件落盘前，浏览器会拿这个
         * 无版本号的 URL 强缓存住，之后用户换头像（路径不变）会一直显示旧图——
         * 前端详情页大图已补 ?v= 版本号兜住主路径，这里再降级缩短残留窗口 */
        if (!b) { res.writeHead(404, { 'Cache-Control': 'public, max-age=1800' }); return res.end('Not Found') }
        const ct = /\.png$/i.test(p) ? 'image/png' : (/\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg')
        res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=3600' })
        res.end(b)
      }).catch(() => { try { res.writeHead(404); res.end('Not Found') } catch (_) {} })
      return
    }
    /* 男优数据（roster_male.json / avatars_male/）走 /cache/male/… —— 已由下面的 /cache/ 分支覆盖：
     * 容器 bind mount 是逐文件挂的，只有 /vol4/1000/pako 整个目录进了 /app/cache，
     * 放 UI_ROOT 下容器读不到（新增目录不会自动进挂载点）。 */
    if (/^\/(covers\/|actresses\/|favicon\.ico|manifest\.webmanifest|sw\.js|hls\.light\.min\.js|icon-192\.png|icon-512\.png|apple-touch-icon\.png)/.test(p) ||
        ['/actresses.json', '/name-map.json', '/name-alias.json', '/actor-merge.json', '/rankings.json', '/tags-zh.json'].includes(p)) {
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
      const rel = p.slice('/media/'.length)
      /* HEAD 只问元信息，绝不能去流整个文件（2026-10-16）：
       * 原来 HEAD 一律走 GET 那条路 —— 115 会去取直链、再把整个 14GB 拉回来（客户端永远等不到响应，
       * 实测 curl -I 12 秒零返回）；WebDAV / 本地大文件同理（Node 会照样把文件读完，只是不回 body）。
       * 播放器起播前常先发一个 HEAD 探大小/类型，卡在这里就等于「播放器加载不出来」。 */
      if (req.method === 'HEAD') return mediaHead(res, rel)
      /* 115 网盘条目：磁盘上不存在，交给代理去取 302 直链后转发（支持 Range 拖动） */
      if (v115Rel(rel)) return v115Serve(req, res, rel)
      /* WebDAV / 光鸭条目：标准协议，GET + Range 原样转发 */
      if (davRel(rel)) return davServe(req, res, rel)
      const fp = safeMediaPath(rel)
      /* mp4 家族额外做一道 HEVC hev1→hvc1 探测（详情见 streamWith 下方那块注释） */
      if (fp) return sendFile(req, res, fp, isMp4Rel(rel))
      res.writeHead(403); return res.end('Forbidden')
    }
    res.writeHead(404); res.end('Not Found')
  } catch (e) {
    /* ⚠ 这里必须判 headersSent：异常完全可能发生在响应已经发出去之后（例如 json() 之后又抛），
     * 那时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT —— 而这个抛错发生在 catch 块里没人接，
     * 会升级成未捕获异常，结果是这个连接既没关也没回内容，一直挂到超时。
     * 另外错误详情只写日志：e.message 里常带服务器绝对路径，不该回给客户端。 */
    console.error('[http] ' + ((e && e.stack) || e))
    try {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Internal Error') }
      else res.end()
    } catch (_) {}
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
  /* 部署完自动拉头像：等扫描稳定后首轮，之后每 12h 补一次新增（开关 设置→autoAvatar） */
  setTimeout(() => avatarBackfillOnce('boot').catch(() => {}), 15000)
  setInterval(() => avatarBackfillOnce('timer').catch(() => {}), 12 * 3600 * 1000).unref()
  /* 115 推送自动认领：恢复上次没盯完的任务（服务重启不丢） */
  w115Load()
  /* 悬停预览：清单版本对不上（旧版单段 5s）→ 先清旧文件，再让 schedulePreviews 整批重排 */
  if (previewLoad()) { try { previewCleanupOld() } catch (e) { console.log('[preview] 旧版清理出错：' + e.message) } }
  /* 先读回上次预热好的线上预览地址（不然 schedulePreviews 里的预热会以为「一条都没有」把整库重查一遍） */
  try { pvWarmLoad() } catch (_) {}
  schedulePreviews()   // 重排必须走 schedulePreviews（enqueuePreview 单独调只覆盖首次入库的场景）
  if (W115.jobs.some(j => j.status === 'watching')) setTimeout(w115Pump, 30000)
  /* 订阅/扫描自动入库队列：恢复上次没跑完的（服务重启不丢） */
  autoQLoad()
  /* 收拾上次没跑完的「排队中」占位记录（重启后队列已空、worker 不会再收尾的那些） */
  setTimeout(reconcileQueuedHist, 1500)
  /* 订阅自动下载（115）已推送记录：恢复上次记的「哪些番号推过」，避免重启后重复推 */
  subDlLoad()
  /* 女优 JavDB 代号回填：断点续跑 —— 接着上次跑的模式（名册全量 / 仅影片库）继续 */
  setTimeout(() => {
    const fn = JDB_RUN.mode === 'roster' ? jdbCodeRunAll() : jdbCodeBackfill({ mode: 'lib', phase: 2 })
    fn.catch(() => {})
  }, 20000)
})

process.on('SIGINT', () => { console.log('\n已停止'); process.exit(0) })
/* 退出前把预热结果落盘（macOS/Linux 有效；Windows 上 main.js 用 TerminateProcess 杀子进程，
 * 收不到信号，那种情况靠 pvWarmPump 里的定期落盘兜住） */
process.on('SIGTERM', () => { try { pvWarmSave() } catch (_) {}; process.exit(0) })
