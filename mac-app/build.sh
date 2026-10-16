#!/bin/bash
# 把 javpaco 打包成 macOS App：Swift 外壳 + 内置 Node + 原有 server.js/index.html 运行时
#
#   ./build.sh          # 编译 release + 组装 JavPaco.app + ad-hoc 签名
#   ./build.sh --dmg    # 额外打一个可以分发的 DMG
#
# 产物：mac-app/dist/JavPaco.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${DIST_DIR:-$ROOT/dist}"   # 可用 DIST_DIR=/tmp/xxx 换输出目录（本机有「批量删除保护」，删不掉的旧产物就别硬删）
APP="$DIST/JavPaco.app"
SWIFT_BIN="${SWIFT_BIN:-/Library/Developer/CommandLineTools/usr/bin/swift}"
NODE_BIN="${NODE_BIN:-/Users/fff/.workbuddy/binaries/node/versions/22.22.2-6/bin/node}"

# 注意：这里不用 swiftpm（swift build）—— 它会调 sandbox-exec，在受限环境里直接 Operation not permitted。
# 项目只有两个源文件，直接 swiftc 反而更快更可控。
echo "① 编译 Swift 外壳（swiftc -O / arm64）"
cd "$ROOT"
mkdir -p "$ROOT/.build"
# ⚠️ 不能加 -parse-as-library：入口在 Sources/JavPaco/main.swift（有顶层代码，默认就是入口）。
#    加了它 Swift 会把所有文件当库，@main 那套还会导致 delegate 不回调（详见 main.swift 注释）。
/usr/bin/swiftc -O -target arm64-apple-macosx14.0 \
  -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  -o "$ROOT/.build/JavPaco" Sources/JavPaco/*.swift
BIN="$ROOT/.build/JavPaco"
test -x "$BIN" || { echo "✗ 编译产物不存在：$BIN"; exit 1; }
echo "  ✓ $(ls -lh "$BIN" | awk '{print $5}')"

echo "② 组装 .app Bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime"
cp "$BIN" "$APP/Contents/MacOS/JavPaco"

# 运行时：server.js / index.html / mdcng.js / node_modules / actresses.json …
cp -R "$ROOT/staging/." "$APP/Contents/Resources/runtime/"
# Node 二进制：内置一份，这样用户机器上没装 Node 也能跑
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"

# 版本号写在 version.txt：installRuntimeIfNeeded 靠它决定要不要重装
VERSION="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d-%H%M%S)"
echo "$VERSION" > "$APP/Contents/Resources/runtime/version.txt"

cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>JavPaco</string>
    <key>CFBundleDisplayName</key><string>JavPaco</string>
    <key>CFBundleIdentifier</key><string>local.javpaco.mac</string>
    <key>CFBundleExecutable</key><string>JavPaco</string>
    <key>CFBundleIconFile</key><string>AppIcon.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.5.2</string>
    <key>CFBundleVersion</key><string>0.5.2</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
    <key>NSLocalNetworkUsageDescription</key><string>javpaco 在本机 127.0.0.1 上提供本地影库服务</string>
</dict>
</plist>
PLIST

# App 图标：和浏览器标签页的 favicon 同一套（assets/app-icon.svg 就是从 index.html 里抠出来的那段
# 内联 SVG，用 sharp/librsvg 渲成 1024px 的 app-icon-src.png）。生成脚本见 tools/make-icon.sh。
ICON_SRC="$ROOT/assets/app-icon-src.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$ROOT/staging/icon-512.png"   # 没有就用 PWA 图标兜底
ICONSET="$DIST/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -Z "${s}" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  sips -Z "$((s*2))" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || echo "（图标生成失败，不影响运行）"
rm -rf "$ICONSET"

# 运行时可在「设置 → 外观」里切换的 Dock 图标，随包带走（AppDelegate.DockIcon 读的就是这三个文件）
mkdir -p "$APP/Contents/Resources/icons"
cp "$ROOT/assets/icon-neon.png"       "$APP/Contents/Resources/icons/neon.png"    # 霓虹：深色底 + 粉青渐变发光字
cp "$ROOT/assets/icon-glass.png"      "$APP/Contents/Resources/icons/glass.png"   # 毛玻璃：磨砂玻璃质感
# 注：旧版 PWA 招牌图标（staging/icon-512.png）已按用户要求移除，不要再拷进来
echo "  ✓ 内置图标：$(ls "$APP/Contents/Resources/icons" | tr '\n' ' ')"

echo "③ 签名（ad-hoc：本机可跑；分发给别人需要 Developer ID 签名）"
# ⚠️ 血泪教训（0.3.5 事故）：codesign 中途被打断会在 Contents/MacOS/ 留下 JavPaco.cstemp，
#    多出来的文件会破坏资源封印 → App 下次启动被 Gatekeeper 判「已损坏」，这就是
#    「退出后再开会报错」的根因。所以：签名前先清一遍 cstemp，签名后强校验，发现 cstemp 就重签。
codesign_find_cstemp() { find "$APP" -name '*.cstemp' -print 2>/dev/null; }
for attempt in 1 2 3; do
  codesign_find_cstemp | while read -r f; do rm -f "$f"; done
  codesign --force --deep --timestamp=none --sign - "$APP" 2>&1 | tail -2
  if [ -z "$(codesign_find_cstemp)" ]; then break; fi
  echo "  ⚠ 第 $attempt 次签名后仍发现 .cstemp 残留，清理后重签"
done
if [ -n "$(codesign_find_cstemp)" ]; then
  echo "  ✗ 三次签名后仍有 .cstemp 残留，产物不可信，中止"; exit 1
fi
codesign --verify --deep --strict "$APP" || { echo "  ✗ 签名校验失败，中止"; exit 1; }
echo "  ✓ 签名有效（无 cstemp 残留）"
echo "  App 版本标记：$VERSION"
du -sh "$APP"

if [[ "${1:-}" == "--dmg" ]]; then
  echo "④ 打 DMG"
  "$ROOT/build-dmg.sh"                 # 带 /Applications 快捷方式 + 版本号卷名，见该脚本
fi
echo "完成 → $APP"
