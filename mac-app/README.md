# javpaco macOS 版

把自己的 javpaco 打包成真正的 Mac App：**原生窗口 + 菜单栏**，里面跑的是**和 NAS 版一模一样**的
`server.js` / `index.html`（连页面 md5 都一样），数据和 NAS 完全隔离地放在本机。

```
mac-app/
├── Sources/JavPaco/
│   ├── AppDelegate.swift     AppKit 外壳：窗口、菜单栏、设置面板、进程生命周期
│   └── ServerManager.swift   安装运行时、起停 Node 子进程、等待服务就绪
├── staging/                  运行时资源（server.js / index.html / node_modules / actresses.json …）
├── assets/                   App 图标源：app-icon.svg + 渲好的 1024px PNG（-square 备份是方块版）
├── tools/make-icon.sh        plain（默认，透明底单字）/ square（标签页 favicon 同款）/ square-online
├── build.sh                  编译 + 组装 JavPaco.app + 签名（--dmg 顺手打 DMG）
├── build-dmg.sh             单独打 DMG（App + /Applications 快捷方式，UDZO 压缩）
├── run-local.sh              免打包兜底：做同样的事，但用浏览器打开
├── migrate-from-nas.sh       把 NAS 的 cache/封面搬成本机副本（本机就是空库，这一步很重要）
└── dist/
    ├── JavPaco.app           产物
    └── JavPaco-<版本>.dmg    分发用镜像（约 54MB，App 143MB 压缩后）
```

## 快速开始

```bash
# 1) 打包（约 1 分钟，App 143MB）
./build.sh                  # 加 --dmg 一步到位：App + DMG
./build-dmg.sh              # 或者 App 已经打好了，只补一个 DMG

# 2) 安装（二选一）
open dist/JavPaco-*.dmg     # 双击镜像 → 把 JavPaco 图标拖进 Applications
cp -R dist/JavPaco.app /Applications/

# 3) 双击打开。本地打的 DMG 不带隔离标记，自己用一般直接就开了。
#    万一弹「来自身份不明的开发者」，一条命令解决（比右键点两次快）：
#      xattr -cr /Applications/JavPaco.app
```

**签名只影响「能不能打开」，不影响「能不能安装」** —— DMG 拖放安装这个动作本身不需要任何签名，
任何 DMG 都能拖。Gatekeeper 只在 App 带着隔离标记（`com.apple.quarantine`，从网上/别人传来的文件
才会有）时才弹窗检查。详细说明见「已知限制」。

首次启动会问你**影片目录**（之后在菜单栏 → 设置 里可以改），然后把运行时装到
`~/Library/Application Support/javpaco/runtime`，等约 20~30 秒服务就绪，窗口里就是熟悉的界面。

## 数据在哪

| 内容 | 路径 |
|---|---|
| 运行时（代码、静态资源、名册） | `~/Library/Application Support/javpaco/runtime` |
| 刮削缓存（封面/剧照/metadata） | `.../runtime/cache`（和 NAS 的 `/app/cache` 同结构） |
| 服务日志 | `~/Library/Application Support/javpaco/logs/server.log` |
| 配置文件 | `.../runtime/server-config.json` |

**卸载 App 不会删这些数据。** 想从零开始就把整个 `~/Library/Application Support/javpaco` 删掉。

## 从 NAS 搬现有库过来

本机版默认是空库，把 NAS 的 cache 搬过来就有了：

```bash
SSH_USER=Xy624202641 ./migrate-from-nas.sh          # cache 约 1.8GB，第一遍慢，之后 rsync 增量很快
SSH_USER=Xy624202641 ./migrate-from-nas.sh --cache-only
```

## 更新到最新版

NAS 上的 `server.js` / `index.html` 改了之后：

```bash
# 重新拉运行时（在 javpaco 工作区里执行，依赖 SSH 凭据）
python3 -c "见 ‘package-runtime’ 一节"
./build.sh            # 版本号变了会自动重装运行时
```

版本号写在 `dist/JavPaco.app/Contents/Resources/runtime/version.txt`，App 启动时比对：
不一样就把旧的运行时的改名留底（`runtime.old-<时间戳>`）再装新的，你改过的配置也不会丢。

## 菜单栏

- **打开 javpaco / 重新加载** — 窗口和刷新
- **设置…** — 影片目录、端口、开机自启（SMAppService，需要 macOS 13+）
- **数据目录 / 影片目录 / 服务日志** — 在 Finder 里打开
- **重启服务** — 改了配置用这个
- **退出并停止服务** — 干净退出（Node 子进程一起收掉）

## App 图标

跟**浏览器标签页的 favicon 是同一套**：深色圆角方块 + 粉青渐变描边 + 发光「ぱ」。
来源是 `index.html` 里那段内联 SVG（PWA 的 `icon-512.png` 那张霓虹灯牌不再用作 App 图标）。

```bash
./tools/make-icon.sh            # 从 nas-work/index.html 提取 → 渲成 1024px → assets/
./tools/make-icon.sh --online   # 从线上 192.168.1.5:8099 拉最新的
./build.sh                      # 把它编进 AppIcon.icns
```

渲染靠 sharp（librsvg）：`cd ~/.workbuddy/binaries/node/workspace && npm install sharp`。
改了 NAS 端的 favicon 后跑一遍这两条，Mac 版图标就跟着变。DMG 挂载后的磁盘图标也用同一张。

## 分发给别人

**你自己装自己用：什么都不用管，拖进去就能开。** 本地 `hdiutil` 打出来的 DMG 没有隔离标记，
Gatekeeper 根本不介入。

**把这个 DMG 发给别人：对方大概率会被拦。** 因为文件经微信/邮件/网盘/AirDrop 传过去就会被打上
隔离标记，Gatekeeper 一检查发现是 ad-hoc 自签名（不是"已识别开发者"），就弹「无法打开，因为它来自
身份不明的开发者」。对方可以右键→打开绕过，或跑一次 `xattr -cr /Applications/JavPaco.app`。

要别人拿到手双击就能用（不用任何绕过动作），才需要 Apple Developer ID（99$/年）：

```bash
# 1) 用 Developer ID 重签 App（--deep 覆盖内置的 node 二进制和所有 dylib）
codesign --force --deep --options runtime --timestamp \
  --sign "Developer ID Application: Your Name (TEAMID)" dist/JavPaco.app

# 2) 重新打 DMG，然后对整个镜像签名
./build-dmg.sh
codesign --timestamp --sign "Developer ID Application: Your Name (TEAMID)" dist/JavPaco-*.dmg

# 3) 公证（不做的话第一次打开还是会弹警告）
xcrun notarytool submit dist/JavPaco-*.dmg --apple-id you@x.com \
  --team-id TEAMID --password "<app专用密码>" --wait
xcrun stapler staple dist/JavPaco-*.dmg
```

## 已知限制

- **签名 ≠ 安装权限**：DMG 拖放安装在任何情况下都能做，跟签名无关。签名只决定「首次双击会不会被
  Gatekeeper 弹窗拦」。实测本机 `spctl --assess` 对 ad-hoc 签名的 App 一律 `rejected`，但因为本地
  DMG 不带隔离标记，**不触发检查**，所以自己用直接能开。被拦时 `xattr -cr <App路径>` 一行解除。
- 网络相关的功能（JavDB 刮削、订阅、relay 名册同步）走你本机的网络，和 NAS 那边的线路不一样（NAS 走 JavDB 国内直连线路）。
- 首次启动慢（20~30 秒）是因为服务端要先拉名册/CDN，属正常，不是卡死。
