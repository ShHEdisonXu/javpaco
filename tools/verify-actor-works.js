#!/usr/bin/env node
/*
 * verify-actor-works.js — 校验「排行榜卡片的作品数」与「女优详情页的作品数」是否一致
 *
 * 两边取值口径（前端 fillRanking / rankWorks 与 renderActorDetail）：
 *   榜单卡片 = 本地名册按 mnid 命中者的 videoCount，命中不到才退回 rankings.json 的 works
 *   详情页   = 同一条记录的 videoCount
 * 所以只要「榜上每个人都能按 mnid 命中名册」，两处必然同值。本脚本就是验这一点：
 *   · mnid 命中率（命中不到 = 前端会退回站点值，两边可能不等）
 *   · 命中者的 videoCount 是否为空（空了详情页就不显示作品数，而榜单会显示站点值）
 *
 * 用法：node tools/verify-actor-works.js
 */
const fs = require('fs')
const path = require('path')
const UI = path.resolve(__dirname, '..')
const list = JSON.parse(fs.readFileSync(path.join(UI, 'actresses.json'), 'utf8'))
const R = JSON.parse(fs.readFileSync(path.join(UI, 'rankings.json'), 'utf8'))

const byMnid = new Map()
for (const a of list) if (a.mnid && !byMnid.has(String(a.mnid))) byMnid.set(String(a.mnid), a)

let total = 0, hit = 0, miss = 0, emptyRec = 0, diff = 0
const missList = [], emptyList = [], diffList = []
for (const tab of ['day', 'week', 'month']) {
  for (const x of (R[tab] || [])) {
    total++
    const rec = byMnid.get(String(x.mnid || x.id))
    if (!rec) { miss++; if (missList.length < 10) missList.push(`${tab} #${x.rank} ${x.name}(mnid=${x.mnid || x.id})`); continue }
    hit++
    const shown = (rec.videoCount || 0) || (x.works || 0)   // 前端 rankWorks 的取值
    const detail = rec.videoCount || 0                       // 详情页的取值
    if (!rec.videoCount) { emptyRec++; if (emptyList.length < 10) emptyList.push(`${x.name}: 名册无作品数，榜单退回站点值 ${x.works || 0}`) }
    if (shown !== detail) { diff++; if (diffList.length < 10) diffList.push(`${x.name}: 榜单 ${shown} / 详情 ${detail}`) }
  }
}
console.log(`榜单条目 ${total} 条（三日榜去重前）`)
console.log(`  mnid 命中名册：${hit}，未命中：${miss}`)
console.log(`  命中者名册无作品数（详情页会不显示、榜单会显示站点值）：${emptyRec}`)
console.log(`  两边取值不一致：${diff}`)
if (missList.length) console.log('  未命中例：\n    ' + missList.join('\n    '))
if (emptyList.length) console.log('  无作品数例（两边都空，不算不一致）：\n    ' + emptyList.join('\n    '))
if (diffList.length) console.log('  不一致例：\n    ' + diffList.join('\n    '))
console.log(diff === 0 && miss === 0
  ? '\n✓ 榜单与详情页的作品数口径一致（无作品数的条目两边都是空的）'
  : '\n✗ 仍有不一致（见上）')
