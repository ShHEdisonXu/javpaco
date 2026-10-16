#!/bin/bash
# 生成 Mac App 的 Dock 图标源（都是「不透明底板 + 单个「ぱ」」；圆角外透明是 macOS 规范）
#
#   ./tools/make-icon.sh          # 默认：一次生成 neon（霓虹）+ glass（毛玻璃），并把 App 图标源同步成霓虹
#   ./tools/make-icon.sh neon     # 霓虹：深色底 + 粉青渐变发光字（= 浏览器标签页 favicon 同款）
#   ./tools/make-icon.sh glass    # 毛玻璃：浅色磨砂玻璃底 + 斜向高光 + 深色渐变字
#   ./tools/make-icon.sh plain    # 旧版透明底单字（已弃用：Dock 里像悬浮的字，没有底板）
#
# 产出：
#   assets/icon-neon.png  assets/icon-glass.png   运行时可切换（AppDelegate.DockIcon）
#   assets/app-icon-src.png                        拿去编 AppIcon.icns（静止时 Finder/Dock 看到的）
#
# ⚠️ 渲染用 sharp（librsvg）；别 flatten 到白底，否则圆角外变成白方块。
#    没装的话：cd ~/.workbuddy/binaries/node/workspace && npm install sharp

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/Users/fff/.workbuddy/binaries/node/versions/22.22.2-3/bin/node}"
NODE_PATH="${NODE_PATH:-/Users/fff/.workbuddy/binaries/node/workspace/node_modules}"

mkdir -p "$ROOT/assets"
cd "$ROOT/assets"

render_svg() {   # $1=svg  $2=png
  # macOS 图标规范：1024 画布里内容只占 ~820（约 80%），四周留84%透明安全边。
  # 直接把底板铺满整张画布会让 Dock 里的图标明显比别家大一圈 —— 务必用 extend 留白。
  NODE_PATH="$NODE_PATH" $NODE_BIN -e '
  const sharp=require("sharp"), fs=require("fs");
  const CONTENT=820, PAD=(1024-CONTENT)/2;
  sharp(Buffer.from(fs.readFileSync(process.argv[1],"utf8")),{density:1600})
    .resize(1024,1024).ensureAlpha()
    .resize(CONTENT,CONTENT,{fit:"contain"})
    .extend({top:PAD,bottom:PAD,left:PAD,right:PAD,background:{r:0,g:0,b:0,alpha:0}})
    .png({compressionLevel:9})
    .toFile(process.argv[2])
    .then(i=>console.log("   ✓ "+i.width+"x"+i.height+" 内容占80% "+Math.round(i.size/1024)+"KB"))
    .catch(e=>{console.error("✗ "+e.message);process.exit(1);});
  ' "$1" "$2"
}

case "${1:-all}" in
  all)
    echo "① 霓虹版";  render_svg icon-neon.svg  icon-neon.png
    echo "② 毛玻璃版"; render_svg icon-glass.svg icon-glass.png
    cp icon-neon.png app-icon-src.png
    echo "   AppIcon.icns 源同步为霓虹版（不透明底板）"
    ;;
  neon|glass)
    echo "① 渲染 $1 版"; render_svg "icon-$1.svg" "icon-$1.png"
    ;;
  plain)
    echo "① 渲染旧版透明底单字"
    cat > app-icon.svg << 'SVG'
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ff2fd6'/><stop offset='1' stop-color='#00e5ff'/></linearGradient><filter id='n' x='-45%' y='-45%' width='190%' height='190%'><feGaussianBlur stdDeviation='1.6' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><text x='32' y='34' font-family='Hiragino Sans,Yu Gothic,Noto Sans JP,Meiryo,sans-serif' font-size='56' font-weight='700' text-anchor='middle' dominant-baseline='central' fill='url(#g)' filter='url(#n)'>ぱ</text></svg>
SVG
    render_svg app-icon.svg app-icon-src.png
    ;;
  *) echo "用法: $0 [all|neon|glass|plain]"; exit 1 ;;
esac

echo
echo "完成。接着跑 ./build.sh 会把它们编进 App 和 Contents/Resources/icons/"
