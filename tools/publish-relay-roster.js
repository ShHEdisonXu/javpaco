#!/usr/bin/env node
/* 每日 minnano 同步完成后，把全量名册发布到公共 relay 仓库（ShHEdisonXu/javpaco-relay）。
 * relay/roster.json 全量资料供 server 端在 minnano 直连不可达（家宽 SNI 阻断）时兜底「识别刮削」。
 * 用法：node tools/publish-relay-roster.js   （clone 在 /tmp/javpaco-relay，缺了自动重克隆） */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const SRC = path.join(__dirname, '..', 'actresses.json')
const CLONE = '/tmp/javpaco-relay'
const PROXY = 'http://192.168.1.251:1082'
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

if (!fs.existsSync(SRC)) { console.error('源名册不存在：' + SRC); process.exit(1) }
try {
  if (!fs.existsSync(path.join(CLONE, '.git'))) {
    console.log('[relay-publish] 克隆 relay 仓库…')
    sh(`git clone --depth 1 https://github.com/ShHEdisonXu/javpaco-relay.git ${CLONE}`)
  } else {
    sh('git -c http.proxy=' + PROXY + ' pull --rebase origin main || git pull --rebase origin main', CLONE)
  }
  fs.copyFileSync(SRC, path.join(CLONE, 'roster.json'))
  sh('git add roster.json', CLONE)
  let pushed = false
  try {
    sh('git -c user.name=javpaco-bot -c user.email=bot@javpaco.local commit -m "relay: 全量名册每日同步 ' + new Date().toISOString().slice(0, 10) + '"', CLONE)
  } catch (_) { console.log('[relay-publish] 名册无变化，跳过'); process.exit(0) }
  try { sh('git -c http.proxy=' + PROXY + ' push origin main', CLONE); pushed = true }
  catch (_) { sh('git push origin main', CLONE); pushed = true }
  console.log('[relay-publish] 已发布全量名册到 relay（push=' + (pushed ? 'ok' : '?') + '，' + JSON.parse(fs.readFileSync(SRC, 'utf8')).length + ' 人）')
} catch (e) {
  console.error('[relay-publish] 失败：' + (e.stderr || e.message))
  process.exit(1)
}
