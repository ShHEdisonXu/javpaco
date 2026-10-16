#!/bin/bash
# 把 dist/JavPaco.app 打包成分发用的 DMG
#
#   ./build-dmg.sh            # 生成 dist/JavPaco-<版本>.dmg
#
# 产物：一个只读压缩的（UDZO）磁盘镜像，里面放了 JavPaco.app 和 /Applications 的快捷方式，
# 双击打开后把图标拖进 Applications 即可。
#
# ⚠️ 本脚本只做「打包」，不负责签名。ad-hoc 签名（build.sh 里做的）只能本机跑，
#    拷给别人会被 Gatekeeper 拦（对方需右键→打开）。要真正分发请换 Developer ID 签名：
#      codesign --force --deep --sign "Developer ID Application: XXX" dist/JavPaco.app
#      （外加 notarytool 公证，否则对方仍会看到「无法验证开发者」）

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${DIST_DIR:-$ROOT/dist}"
# ⚠️ APP 必须跟着 DIST_DIR 走 —— 以前这里写死 $ROOT/dist/JavPaco.app，于是用
#    DIST_DIR=/tmp/jpbuildN 打包时，App 编到了 /tmp/jpbuildN、**DMG 却把 dist/ 里的旧包压了进去**
#    （2026-10-06 实测：DMG 内 server.js 还是上一版的 md5，version.txt 是 4 小时前的构建戳）。
#    想要照旧覆盖某个已装/已存在的 App，用 APP_DIR=... 显式指定。
APP="${APP_DIR:-$DIST/JavPaco.app}"
# 暂存目录放系统临时区、且**带时间戳不复用** —— 以前固定用 $ROOT/.dmg-stage 再 rm -rf，
# 三千多个文件的批量删除会被工作区的删除保护拦下（构建直接失败）。临时区由系统自己回收。
STAGE="${TMPDIR:-/tmp}/javpaco-dmg-stage-$(date +%H%M%S)-$$"

[ -d "$APP" ] || { echo "✗ 找不到 $APP —— 先跑 ./build.sh"; exit 1; }

VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.0.0)"
DMG="$DIST/JavPaco-$VER.dmg"
VOLNAME="JavPaco $VER"

echo "① 准备 DMG 内容（App + Applications 快捷方式 + 卷图标）"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
# 拖放安装的 /Applications 落点：曾经用 `ln -s /Applications`，但 diskutil image create from 会顺着
# symlink 把整个 /Applications 递归打进镜像（几百 GB，直接卡死）；用 osascript 建「别名」在无头
# 环境又会等 Finder 响应而挂起。两样都不可靠，故只放一份文字说明，用户自己把 JavPaco.app 拖进
# 访达左侧的「应用程序」即可（拖放安装本身不需要签名）。
echo "把 JavPaco.app 拖到 访达左侧的「应用程序」即可安装" > "$STAGE/安装说明.txt"
# 挂载后磁盘图标也用同一个（隐藏文件 .VolumeIcon.icns + 自定义图标标记）
ICNS="$APP/Contents/Resources/AppIcon.icns"
if [ -f "$ICNS" ] && [ -x /usr/bin/SetFile ]; then
  cp "$ICNS" "$STAGE/.VolumeIcon.icns"
  /usr/bin/SetFile -a C "$STAGE" 2>/dev/null || true
fi

[ -f "$DMG" ] && { echo "✗ $DMG 已存在 —— 不想覆盖旧包，先把它改名或删掉"; exit 1; }
echo "② 打包成只读压缩镜像（UDZO）"
# ⚠️ 2026-10-03：本机有「批量删除保护」，`hdiutil create -srcfolder` 会去 **/Volumes 临时卷**里
# 删它自己生成的 _CodeSignature/.BC.T_* 临时文件 → 被拦：
#   "could not access /Volumes/JavPaco 0.3.5/…/CodeResources - 操作不被允许"
# hdiutil 自己的报错还建议换 diskutil，于是改用官方推荐路径（实测 3.5 秒搞定，不再被拦）：
#   diskutil image create from <目录> <输出> --format UDZO --volumeName <卷名>
# 它直接从源目录生成镜像，不去 /Volumes 建中间卷，也就不需要删那里的任何东西。
DISKUTIL="/usr/sbin/diskutil"
if [ -x "$DISKUTIL" ] && "$DISKUTIL" image create from --help >/dev/null 2>&1; then
  "$DISKUTIL" image create from "$STAGE" "$DMG" \
    --format UDZO --volumeName "$VOLNAME" > /tmp/javpaco-diskutil.log 2>&1 \
    || { echo "✗ diskutil 失败："; tail -10 /tmp/javpaco-diskutil.log; exit 1; }
else
  # 老路径（需要能删 /Volumes 临时卷里的文件）
  hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 \
    "$DMG" > /tmp/javpaco-hdiutil.log 2>&1 || { tail -20 /tmp/javpaco-hdiutil.log; exit 1; }
fi

echo "③ 校验镜像可挂载"
hdiutil verify "$DMG" 2>&1 | tail -2

echo
echo "✓ 完成：$DMG"
echo "  （暂存目录 $STAGE 留在系统临时区，可随手删除）"
ls -lh "$DMG"
echo "  镜像版本：$VOLNAME · 运行时构建戳：$(cat "$APP/Contents/Resources/runtime/version.txt" 2>/dev/null || echo '（无）')"
echo
echo "双击它 → 把 JavPaco 拖到 Applications 就装好了（拖放安装不需要签名）。"
echo "自己用一般直接能打开；万一被 Gatekeeper 拦：xattr -cr /Applications/JavPaco.app"
