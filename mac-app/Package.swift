// swift-tools-version:6.0
import PackageDescription

/* javpaco macOS 版：AppKit 外壳 + 内置 Node 跑原有的 server.js / index.html。
 * 用纯命令行工具链（swift build）就能编译，装 .app 在 build.sh 里完成。 */
let package = Package(
    name: "JavPaco",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "JavPaco")
    ]
)
