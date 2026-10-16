import AppKit

/* ⚠️ 必须显式建入口，不能用 Swift 的 @main（2026-10-03 实测踩坑）：
 * 用 `@main final class AppDelegate` + `swiftc -parse-as-library` 编译出来的 App，
 * 进程能起来、Dock 里没图标、**applicationDidFinishLaunching 永远不回调** —— 表现就是
 * 「双击没反应，进程还挂着」。对照实验：同样的回调，显式 NSApplication.shared.delegate = …
 * 能触发，@main 版触发不了。所以这里手写入口，别改回 @main。 */
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
