import AppKit
import WebKit
import ServiceManagement
import UniformTypeIdentifiers   // 系统默认关联查询（UTType.mpeg4Movie / .application）

/* 入口在 main.swift（显式 NSApplication.shared.delegate = …）。别在这里加 @main —— 详见 main.swift 注释 */
final class AppDelegate: NSObject, NSApplicationDelegate {
    let server = ServerManager()
    var mainWindow: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var settingsWindow: NSWindow?
    /* ⚠️ 原生画中画小窗 / 原生全屏都已删除（2026-10-10，用户要求）：
     *   - 画中画整个去掉（WKWebView/macOS 本来就没有 PiP API，那套实现注定是坏的）
     *   - 全屏改成前端「软件页面内全屏」，不再把 App 窗口切成系统全屏
     *   → 这里不再需要 pipWindow / pipWebView / nativeFullscreen，也不需要 NSWindowDelegate。 */
    /* 鼠标前进/后退侧键的局部事件监听（见 installMouseNavMonitor）。存引用防失效，
     * 必须在主类上——extension 里不能放存储属性。 */
    var mouseNavMonitor: Any?

    /* ---- 外部播放器（2026-10-15 补齐 Win 版的四个桥命令）----
     * ⚠️ 存储属性只能放主类上：下面的实现写在 `extension AppDelegate: WKScriptMessageHandler` 里，
     *   而 extension 不允许新增存储属性（同一个坑以前在 mouseNavMonitor 上踩过）。 */
    static let knownPlayers: [(bid: String, name: String)] = [
        ("com.colliderli.iina", "IINA"),
        ("org.videolan.vlc",    "VLC"),
        ("io.mpv.mpv",          "mpv"),
    ]
    static let playerKey = "jp.customPlayer"
    /// 探测结果缓存：一次会话里只查一遍（查包很便宜，但没必要每进一次设置页都查）
    var playerProbeCache: [String: Any]?

    func applicationDidFinishLaunching(_ notification: Notification) {
        debugLog("didFinishLaunching start")
        NSApp.setActivationPolicy(.regular)
        buildMenuBar()
        debugLog("bundle=\(Bundle.main.bundlePath) res=\(Bundle.main.resourceURL?.path ?? "nil")")

        do { try server.installRuntimeIfNeeded() }
        catch { debugLog("installRuntime 失败: \(error)"); alert("初始化失败", error.localizedDescription); return }
        debugLog("runtime ok: \(ServerManager.runtimeDir.path)")

        /* 不再一上来就弹「选影片目录」——直接进首页，用户到「添加媒体 → 视频目录 → 浏览」里
           用访达挑就行（那边的浏览按钮会通过 WKScriptMessageHandler 走原生打开面板）。 */
        boot()
    }

    /* 排障用：AppKit App 没有 stdout，把关键步骤记到 /tmp/javpaco-mac-debug.log */
    static let debugPath = "/tmp/javpaco-mac-debug.log"
    func debugLog(_ s: String) {
        let line = "[\(Date())] \(s)\n"
        print(line)
        if let h = FileHandle(forWritingAtPath: AppDelegate.debugPath) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
        } else {
            try? line.data(using: .utf8)?.write(to: URL(fileURLWithPath: AppDelegate.debugPath))
        }
    }

    /* 正常退出（⌘Q / 菜单退出）时把 node 服务带走。
     * ⚠️ 但这只挡得住「优雅退出」：killall / 强杀 / 崩溃都会留下一个孤儿 node 占着端口，
     *   而它跑的是**上一次装进去的旧 server.js** —— 页面看起来是新的（它从磁盘读 index.html），
     *   服务端逻辑却是旧的（新建的字段 / 新接口全没有），症状就是「改了没效果」，极难自查。
     *   所以 ServerManager.start() 里还有一道 killOrphanServer() 兜底。 */
    func applicationWillTerminate(_ notification: Notification) {
        debugLog("退出：停掉本机服务")
        server.stop()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow(nil) }
        return true
    }

    // MARK: - 启动流程

    func boot() {
        /* 先把窗口摆出来（显示「正在启动」），不然首次启动那 20~30 秒界面是一片空白 */
        buildWindow()
        showWindow(nil)
        webView.loadHTMLString(AppDelegate.loadingHTML(port: server.port), baseURL: nil)

        server.start()
        if let e = server.lastError { alert("服务启动失败", e); return }
        server.waitReady { [weak self] ok in
            guard let self else { return }
            if ok { self.loadHome() }
            else {
                self.alert("服务没起来", "等了 60 秒首页仍不可访问（首次启动通常 20~30 秒）。\n看看 ~/Library/Application Support/javpaco/logs/server.log")
            }
        }
    }

    static func loadingHTML(port: Int) -> String {
        """
        <html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
          font-family:-apple-system;background:#141414;color:#e8e8e8;text-align:center">
          <div>
            <div style="font-size:22px;font-weight:600">JavPaco 正在启动…</div>
            <div style="margin-top:10px;color:#9a9a9a;font-size:13px">
              首次启动需要把影库、名册载入内存，通常 20~30 秒<br>
              本机服务地址：http://127.0.0.1:\(port)
            </div>
          </div>
        </body></html>
        """
    }

    func askMediaPath(thenStart: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "选这个目录"
        panel.message = "选一个放影片的目录（之后可以在「设置」里改）"
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/Movies")
        guard panel.runModal() == .OK, let url = panel.url else {
            if thenStart { alert("还没选影片目录", "没选目录就用默认的 ~/Movies 启动了，之后在设置里改。"); boot() }
            return
        }
        server.mediaPath = url.path
        if thenStart { boot() }
    }

    // MARK: - 窗口

    func buildWindow() {
        if mainWindow != nil { return }
        let cfg = WKWebViewConfiguration()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        cfg.allowsAirPlayForMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        /* 网页 ↔ 原生桥接：网页用 window.webkit.messageHandlers.javpaco 叫原生弹访达选目录 */
        cfg.userContentController.add(self, name: AppDelegate.bridgeName)
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 javpaco-mac"
        /* ⚠️ 没有 uiDelegate，WKWebView 里的 window.confirm/alert/prompt 会被静默吞掉（直接返回 false/空），
         * 表现为「点了删除/隐藏/清空没反应」。补上 delegate 原生弹窗，整个 App 的确认框在 Mac 上才能用。 */
        webView.uiDelegate = self
        /* 外链（jav321 / javdb / 详情页番号链接页 / 刮削历史的图源按钮等）交给系统默认浏览器打开，
         * 不在应用内 WebView 跳转；应用自身 SPA（同一 127.0.0.1 主机）照常内嵌。 */
        webView.navigationDelegate = self

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "JavPaco"
        win.contentView = webView
        win.center()
        win.setFrameAutosaveName("javpaco.main")
        /* ⚠️ 血泪教训（0.5.1 崩溃，2026-10-16）：程序化创建的 NSWindow 默认 isReleasedWhenClosed = true，
         * 红按钮关窗会对对象**多做一次 release** —— 在 ARC 下就是过度释放：AppDelegate 的强引用还指着它，
         * 对象却已经被释放了。之后点 Dock 图标 → applicationShouldHandleReopen → showWindow
         * → mainWindow.makeKeyAndOrderFront → objc_msgSend 打在已释放对象上 → SIGSEGV（崩溃报告里
         * 那句 "possible pointer authentication failure" 就是这么来的）。
         * 本机最小复现已验证：默认 true 时 close 后再 touch = exit 139；设 false 则正常存活。
         * 下面的设置窗口（openSettings）从最早就带了这行，唯独主窗口漏了。 */
        win.isReleasedWhenClosed = false
        mainWindow = win
        /* ⚠️ 鼠标「后退/前进」侧键：WKWebView 自己不吃这两个键（allowsBackForwardNavigationGestures
         * 只管触摸板横扫），所以按了完全没反应。在窗口上装事件监听直接转给网页 history。*/
        installMouseNavMonitor()
        /* Dock 图标由用户偏好决定（设置 → 外观）。以前这里硬写死用 runtime/icon-512.png（一张方牌里
           排着好几个字的 PWA 图标），结果「没运行时是打包图标、一运行就被换成那张牌」—— 见 setDockIcon()。*/
        setDockIcon()
        loadHome()
    }

    /* MARK: - 鼠标前进/后退侧键 → 网页 history.back() / goForward()
     * AppKit 没有「侧键」这种语义，只能靠 NSEvent 的 buttonNumber 识别：
     * 4 = 后退（返回键/侧左键），5 = 前进。
     * 用局部 monitor（addLocalMonitorForEvents）而不是 NSWindowDelegate，
     * 免得给窗口塞 delegate 跟别处打架（这个类只继承了 NSApplicationDelegate）。
     * ⚠️ 必须返回 nil 让事件继续往下传：吃掉的话，网页里选中文字这类操作会失效。 */
    fileprivate func installMouseNavMonitor() {
        mouseNavMonitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .otherMouseUp]) { [weak self] ev in
            guard let self = self else { return ev }
            let n = ev.buttonNumber
            guard n == 4 || n == 5 else { return ev }
            // 只处理按下那一下，避免 up 又来一次
            if ev.type == .otherMouseDown {
                if n == 4 { self.goBackInPage() } else { self.goForwardInPage() }
            }
            return nil
        }
    }

    /* ⚠️ 本项目前端是 hash 路由（#/、#/movie/xxx…），**不是**真实页面导航。
     * WKWebView.canGoBack 对纯 hash 路由经常返回 false（WebKit 认为没发生导航），
     * 所以这里不能只依赖 goBack()/canGoBack —— 实测 Chromium 里 history.back() 一切正常。
     * 兜底：直接让网页自己改 location.hash / history.back()，走前端自己的 hashchange 路由。*/
    fileprivate func goBackInPage() {
        if webView.canGoBack { webView.goBack(); return }
        webView.evaluateJavaScript("window.history.back()") { _, err in
            if err != nil { self.debugLog("鼠标后退：history.back() 失败 \(err)") }
        }
    }
    fileprivate func goForwardInPage() {
        if webView.canGoForward { webView.goForward(); return }
        webView.evaluateJavaScript("window.history.forward()") { _, err in
            if err != nil { self.debugLog("鼠标前进：history.forward() 失败 \(err)") }
        }
    }

    func loadHome() { webView.load(URLRequest(url: server.baseURL)) }

    @objc func showWindow(_ sender: Any?) {
        /* isReleasedWhenClosed=false 之后窗口永远不会被提前释放，这里的判空才真正可靠；
         * 关掉的窗口 makeKeyAndOrderFront 会把它重新摆出来（closed ≠ released）。 */
        if mainWindow == nil { buildWindow() }
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - 菜单栏

    func buildMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = item.button {
            b.title = ""
            b.image = NSImage(systemSymbolName: "film.stack", accessibilityDescription: "JavPaco")
        }
        let m = NSMenu()
        m.addItem(NSMenuItem(title: "打开 JavPaco", action: #selector(showWindow(_:)), keyEquivalent: "o"))
        m.addItem(NSMenuItem(title: "重新加载", action: #selector(reloadPage(_:)), keyEquivalent: "r"))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "设置…", action: #selector(openSettings(_:)), keyEquivalent: ","))
        m.addItem(NSMenuItem(title: "数据目录", action: #selector(openDataDir(_:)), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "影片目录", action: #selector(openMediaDir(_:)), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "服务日志", action: #selector(openLog(_:)), keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "重启服务", action: #selector(restartServer(_:)), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "退出并停止服务", action: #selector(quit(_:)), keyEquivalent: "q"))
        m.items.forEach { $0.target = self }
        item.menu = m
        statusItem = item
    }

    @objc func reloadPage(_ sender: Any?) { loadHome() }
    @objc func quit(_ sender: Any?) { NSApp.terminate(nil) }

    @objc func openDataDir(_ sender: Any?) {
        NSWorkspace.shared.open(ServerManager.appSupportDir)
    }
    @objc func openMediaDir(_ sender: Any?) {
        let p = server.mediaPath.isEmpty ? NSHomeDirectory() + "/Movies" : server.mediaPath
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: p)
    }
    @objc func openLog(_ sender: Any?) {
        NSWorkspace.shared.open(ServerManager.logDir)
    }
    @objc func restartServer(_ sender: Any?) {
        server.restart()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.loadHome() }
    }

    // MARK: - Dock 图标（设置 → 外观）

    /* Dock 图标 —— 全部都是「不透明底板 + 单个「ぱ」」，可在「设置 → 外观」里切换。
       （更早还硬写死用 runtime/icon-512.png 那张旧招牌，已删。） */
    enum DockIcon: String, CaseIterable {
        case neon, glass

        var title: String {
            switch self {
            case .neon:  return "霓虹（深色 + 粉青渐变）"
            case .glass: return "毛玻璃（磨砂玻璃质感）"
            }
        }
        var file: String {
            switch self {
            case .neon:  return "neon.png"
            case .glass: return "glass.png"
            }
        }
    }

    static let dockIconKey = "jp.dockIcon"

    var dockIcon: DockIcon {
        DockIcon(rawValue: UserDefaults.standard.string(forKey: AppDelegate.dockIconKey) ?? "") ?? .neon
    }

    /// 读取偏好并应用到 Dock。改动立即生效，不用重启 App。
    func setDockIcon(_ style: DockIcon? = nil) {
        let style = style ?? dockIcon
        let name = style.file
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("icons/\(name)"),
              let img = NSImage(contentsOf: url) else {
            NSApp.applicationIconImage = nil
            debugLog("dock icon 找不到资源 icons/\(name)，回退 bundle")
            return
        }
        img.size = NSSize(width: 128, height: 128)
        NSApp.applicationIconImage = img
        debugLog("dock icon = \(style.rawValue)")
    }

    func dockIconPreview(_ style: DockIcon) -> NSImage? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("icons/\(style.file)") else { return nil }
        return NSImage(contentsOf: url)
    }

    @objc func changeDockIcon(_ sender: NSPopUpButton) {
        let style = DockIcon.allCases[sender.indexOfSelectedItem]
        UserDefaults.standard.set(style.rawValue, forKey: AppDelegate.dockIconKey)
        setDockIcon(style)
        guard let win = settingsWindow,
              let iv = objc_getAssociatedObject(win, "iconPreview") as? NSImageView else { return }
        iv.image = dockIconPreview(style) ?? NSApp.applicationIconImage
    }

    // MARK: - 设置

    @objc func openSettings(_ sender: Any?) {
        if settingsWindow != nil { settingsWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 430),
                           styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.title = "JavPaco 设置"
        let v = NSView(frame: win.contentView!.bounds)

        func label(_ s: String, y: CGFloat) {
            let l = NSTextField(labelWithString: s)
            l.frame = NSRect(x: 24, y: y, width: 120, height: 20)
            l.alignment = .right
            v.addSubview(l)
        }
        label("影片目录", y: 358)
        let pathField = NSTextField(frame: NSRect(x: 152, y: 354, width: 300, height: 24))
        pathField.stringValue = server.mediaPath
        pathField.placeholderString = "放视频的目录"
        pathField.isEditable = false
        v.addSubview(pathField)
        let browse = NSButton(frame: NSRect(x: 460, y: 350, width: 80, height: 28))
        browse.title = "选择…"
        browse.bezelStyle = .rounded
        browse.target = self
        browse.action = #selector(pickMedia(_:))
        v.addSubview(browse)

        label("端口", y: 318)
        let portField = NSTextField(frame: NSRect(x: 152, y: 314, width: 100, height: 24))
        portField.stringValue = String(server.port)
        v.addSubview(portField)

        let loginBtn = NSButton(frame: NSRect(x: 148, y: 276, width: 320, height: 22))
        loginBtn.title = "登录时自动启动 JavPaco"
        loginBtn.setButtonType(.switch)
        loginBtn.state = UserDefaults.standard.bool(forKey: "jp.launchAtLogin") ? .on : .off
        loginBtn.target = self
        loginBtn.action = #selector(toggleLogin(_:))
        v.addSubview(loginBtn)

        // --- 外观：Dock 图标 ---
        let sep = NSBox(frame: NSRect(x: 24, y: 258, width: 512, height: 1))
        sep.boxType = .separator
        v.addSubview(sep)

        label("Dock 图标", y: 226)
        let iconPop = NSPopUpButton(frame: NSRect(x: 152, y: 222, width: 250, height: 26), pullsDown: false)
        DockIcon.allCases.forEach { iconPop.addItem(withTitle: $0.title) }
        iconPop.selectItem(at: DockIcon.allCases.firstIndex(of: dockIcon) ?? 0)
        iconPop.target = self
        iconPop.action = #selector(changeDockIcon(_:))
        v.addSubview(iconPop)

        let preview = NSImageView(frame: NSRect(x: 416, y: 206, width: 72, height: 72))
        preview.image = dockIconPreview(dockIcon) ?? NSApp.applicationIconImage
        preview.imageScaling = .scaleProportionallyUpOrDown
        v.addSubview(preview)

        let iconTip = NSTextField(labelWithString: "切换后立刻生效，不用重启；重新登录时也记得会保留。")
        iconTip.frame = NSRect(x: 152, y: 196, width: 380, height: 18)
        iconTip.textColor = .secondaryLabelColor
        iconTip.font = NSFont.systemFont(ofSize: 11)
        v.addSubview(iconTip)

        let tip = NSTextField(wrappingLabelWithString:
            "数据（名册 / 封面 / 元数据）都在 ~/Library/Application Support/javpaco，卸载 App 不会删。\n端口改动需要重启服务才生效。想把 NAS 上旧数据搬过来：先把 NAS 的 cache 目录拷到「数据目录」里再重启服务。")
        tip.frame = NSRect(x: 24, y: 100, width: 500, height: 80)
        tip.textColor = .secondaryLabelColor
        v.addSubview(tip)

        let save = NSButton(frame: NSRect(x: 440, y: 24, width: 100, height: 32))
        save.title = "保存并重启"
        save.bezelStyle = .rounded
        save.target = self
        save.action = #selector(saveSettings(_:))
        v.addSubview(save)

        portField.identifier = NSUserInterfaceItemIdentifier("port")
        win.contentView = v
        win.center()
        win.isReleasedWhenClosed = false
        objc_setAssociatedObject(win, "portField", portField, .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(win, "iconPreview", preview, .OBJC_ASSOCIATION_RETAIN)
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow = win
    }

    @objc func pickMedia(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        guard panel.runModal() == .OK, let u = panel.url else { return }
        server.mediaPath = u.path
        openSettingsClose(); openSettings(nil)
    }

    @objc func saveSettings(_ sender: Any?) {
        if let pf = objc_getAssociatedObject(settingsWindow!, "portField") as? NSTextField,
           let p = Int(pf.stringValue.trimmingCharacters(in: .whitespaces)) { server.port = p }
        openSettingsClose()
        server.restart()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.loadHome() }
    }

    @objc func toggleLogin(_ sender: NSButton) {
        let on = sender.state == .on
        UserDefaults.standard.set(on, forKey: "jp.launchAtLogin")
        if #available(macOS 13.0, *) {
            do {
                if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch { alert("开机启动设置失败", "\(error.localizedDescription)\n（正式做法需要给 App 做开发者签名）") }
        } else {
            alert("不支持", "这个系统版本不支持 SMAppService（需要 macOS 13+）")
        }
    }

    private func openSettingsClose() { settingsWindow?.close(); settingsWindow = nil }

    /* ⚠️ 原生全屏 / 画中画的回调（windowDidEnter/ExitFullScreen、windowWillClose）与
     *   `win.delegate = self` 都在 2026-10-10 一起删掉了 —— 全屏已改成前端软件全屏，
     *   画中画整个取消。留这些回调只会让人以为还有原生全屏。 */

    func alert(_ title: String, _ msg: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = msg
        a.alertStyle = .warning
        a.runModal()
    }
}

// MARK: - 网页 ↔ 原生桥接（网页拿到访达选出来的文件夹路径）

/* 网页里：
   window.webkit.messageHandlers.javpaco.postMessage({cmd:'pickDir', cbId:1, current:'/Users/…', multiple:false})
   原生弹 NSOpenPanel → 选完调 window.__onNativePick(cbId, path)。
   浏览器里没有这个 handler，前端会退回原来的输入/逐级浏览。 */
extension AppDelegate: WKScriptMessageHandler {
    static let bridgeName = "javpaco"

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == AppDelegate.bridgeName,
              let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "pickDir":
            let cbId = body["cbId"] as? Int ?? 0
            let multiple = body["multiple"] as? Bool ?? false
            /* 对话框标题 / 确认按钮文案可由调用方覆盖（「离线数据迁移」用的是「选择离线数据目录」）。
             * ⚠ 与 Windows 版 main.js 的 dialog.showOpenDialog({title, buttonLabel}) 同一契约：
             *   不传就是原来的默认文案，传了必须生效，否则迁移那一页的引导文案会对不上。 */
            let title = (body["title"] as? String)?.trimmingCharacters(in: .whitespaces)
            let btn = (body["buttonLabel"] as? String)?.trimmingCharacters(in: .whitespaces)
            var start: URL?
            if let cur = body["current"] as? String, !cur.isEmpty,
               FileManager.default.fileExists(atPath: cur) { start = URL(fileURLWithPath: cur) }
            DispatchQueue.main.async {
                self.chooseDir(start: start, cbId: cbId, multiple: multiple, title: title, button: btn)
            }
        case "getIcon":     // 网页（设置 → 外观）问当前用的是哪套图标
            tellIcon()
        case "setIcon":     // 网页（设置 → 外观）换图标
            guard let raw = body["style"] as? String, let style = DockIcon(rawValue: raw) else {
                debugLog("bridge setIcon 参数不对: \(body)")
                return
            }
            UserDefaults.standard.set(style.rawValue, forKey: AppDelegate.dockIconKey)
            setDockIcon(style)
            tellIcon()
        case "ping":
            debugLog("bridge ping from web")
        case "bridgeErr":
            // 网页侧桥回执抛异常时的详情回传（见 replyBridge 的 try/catch 包装）
            let m = body["msg"] as? String ?? "(无详情)"
            let c = body["cbId"] as? Int ?? -1
            debugLog("网页侧桥回执异常 cbId=\(c)：\(m.prefix(900))")
        /* ---- 系统默认浏览器打开外链（网站页 / 详情页的站外链接）----
         * 网页 openSiteUrl() 的用法：失败才回退 window.open，所以这里**只在真的失败时**回执错误。 */
        case "openUrl":
            guard let u = body["url"] as? String, let url = URL(string: u),
                  let sch = url.scheme?.lowercased(), sch == "http" || sch == "https" else {
                replyBridge(body["cbId"] as? Int ?? 0, "{}", "无效的网址")
                return
            }
            DispatchQueue.main.async {
                if !NSWorkspace.shared.open(url) {
                    self.debugLog("openUrl 打不开：\(u)")
                    self.replyBridge(body["cbId"] as? Int ?? 0, "{}", "系统拒绝打开该网址")
                }
            }
        /* ---- 外部播放器四件事（2026-10-15 Win 版新增，Mac 端在此补齐）----
         * 契约与 Windows 版 main.js 完全一致，前端 index.html 里 probePlayer / pickPlayerExe /
         * useSystemPlayer / clearCustomPlayer 四个函数就是按这套字段写的：
         *   playerProbe  → data:{exe,label,via,custom,icon,list,sysExe,sysLabel}
         *   setPlayer    → {path}，写进偏好，之后所有「本地播放 / ↗」都用它
         *   pickPlayer   → 弹面板挑一个 .app，回 data:{path}
         *   clearPlayer  → 清掉手动指定，回到「系统默认关联」
         * ⚠ 少了这几个命令的后果（本次修的就是这个）：设置 → 播放整页「正在检测本机播放器…」
         *   永远不结束、点「选择文件」毫无反应、点「本地播放」只弹一句「正在唤起外部播放器…」。 */
        case "playerProbe":
            let force = body["force"] as? Bool ?? false
            let sel = body["sel"] as? String ?? "default"
            let info = playerProbeInfo(force: force, sel: sel)
            replyBridge(body["cbId"] as? Int ?? 0, jsonOfObject(info), "")
        case "setPlayer":
            guard let p = (body["path"] as? String)?.trimmingCharacters(in: .whitespaces), !p.isEmpty else {
                replyBridge(body["cbId"] as? Int ?? 0, "{}", "缺少播放器路径")
                return
            }
            setCustomPlayer(p)
            replyBridge(body["cbId"] as? Int ?? 0, "{\"path\":\(jsonString(p))}", "")
        case "clearPlayer":
            UserDefaults.standard.removeObject(forKey: AppDelegate.playerKey)
            playerProbeCache = nil
            debugLog("清掉手动指定的播放器，回到系统默认")
            replyBridge(body["cbId"] as? Int ?? 0, "{}", "")
        case "pickPlayer":
            let cb = body["cbId"] as? Int ?? 0
            DispatchQueue.main.async { self.pickPlayerApp(cbId: cb) }
        case "saveShot":
            // 网页截图：把 base64 PNG 交给原生，直接写进 ~/Downloads（WKWebView 里 <a download> 不落地）
            guard let b64 = body["pngBase64"] as? String, !b64.isEmpty else {
                debugLog("bridge saveShot 参数不对: \(body.keys)")
                replyBridge(body["cbId"] as? Int ?? 0, "{}", "缺少 pngBase64")
                return
            }
            let name = (body["name"] as? String) ?? "JavPaco-截图.png"
            let ts = body["at"] as? Double ?? 0
            DispatchQueue.main.async { self.saveShot(base64: b64, name: name, at: ts, cbId: body["cbId"] as? Int ?? 0) }
        case "openExternal":
            // 网页点「↗ 外部播放器」/ 详情页「▶ 本地播放」：把当前影片交给本机播放器打开。
            // 网页内置 <video> 是弱客户端，字节要从 Node 代理经 CloudDrive/FUSE 单通道网盘读，首字节延迟高；
            // 本机播放器自己有成熟的缓冲/seek，直接读挂载（或走 HTTP 流）就快得多。
            let path = body["path"] as? String
            let url = body["url"] as? String
            let player = body["player"] as? String ?? "default"
            let cb = body["cbId"] as? Int ?? 0
            DispatchQueue.main.async { self.openExternal(path: path, url: url, player: player, cbId: cb) }
        /* ⚠️ fullscreen / pip / pipState / closePip 四个命令都在 2026-10-10 删除了：
         *   全屏改成前端软件全屏（不碰原生窗口），画中画整个取消。 */
        default:
            debugLog("bridge 未知指令 \(cmd)")
        }
    }

    /// 通用回调用：把 JSON 字符串交给网页里的 window.__onNativeBridge(cbId, json, err)
    /// - Parameter noPlayer: 只在 openExternal 失败时用 —— 前端据此弹「选择播放器…」按钮，
    ///   而不是干巴巴一句「打开失败」让用户无从下手（Win 版就是这个契约）。
    private func replyBridge(_ cbId: Int, _ json: String, _ err: String = "", noPlayer: Bool = false) {
        //走 JSON 编码再塞进单引号字符串，天然处理引号/换行，避免手写转义漏掉
        var inner: [String: Any] = [:]
        if let d = json.data(using: .utf8),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { inner = o }
        var payload: [String: Any] = err.isEmpty
            ? ["ok": true, "data": inner]
            : ["ok": false, "error": err, "data": inner]
        if noPlayer { payload["noPlayer"] = true }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        let j = escapeForJS(text)
        /* ⚠ 2026-10-16 深测发现：网页侧回调一旦抛异常，WKWebView 只回一句笼统的
         * "A JavaScript exception occurred"，连哪一行都不知道。这里包一层 try/catch，
         * 把异常堆栈经原生桥传回 debugLog —— 网页侧的 bug 从此能定位到行。 */
        let js = "(function(){try{ window.__onNativeBridge && __onNativeBridge(\(cbId), '\(j)', '') }" +
            "catch(e){ try{ window.webkit.messageHandlers.javpaco.postMessage({cmd:'bridgeErr', cbId:\(cbId), msg:[e&&e.name, e&&e.message, e&&e.stack].filter(Boolean).join(' || ')}) }catch(_){}} })()"
        webView?.evaluateJavaScript(js) { _, e2 in
            if let e2 { self.debugLog("bridge 回执失败: \(e2.localizedDescription)") }
        }
    }

    /// 把 [String: Any] 直接编成 JSON 字符串（用于 playerProbe 这类结构化回执）
    private func jsonOfObject(_ o: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    private func escapeForJS(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "'", with: "\\'")
         .replacingOccurrences(of: "\n", with: "\\n")
    }

    /// 去掉末尾扩展名，得到「原始基名」（用于重名时拼 a(2).png）
    private func destSafeBase(_ filename: String) -> String {
        let u = URL(fileURLWithPath: filename)
        let b = u.deletingPathExtension().lastPathComponent
        return b.isEmpty ? filename : b
    }

    // MARK: - 截图落盘：~/Downloads
    /// 存到用户「下载」文件夹。重名时自动加(2)(3)…，永远不覆盖已有文件。
    private func saveShot(base64: String, name: String, at: Double, cbId: Int) {
        /*⚠️ 故意不调NSApp.activate：用户要求「后台放入下载文件夹」，
           弹到前台会打断正在播放的视频、还会挡住全屏画面。静默写盘即可。*/
        /* ⚠️ 前端 FileReader.readAsDataURL 给的是完整 data URL：
         *   data:image/png;base64,iVBORw0K...
         * 之前只砍掉 "data:" 五个字符，剩下的 "image/png;base64," 还粘在 base64 前面
         * → Data(base64Encoded:) 直接解不出来（截图功能等于坏的）。
         * 正确做法：取**最后一个逗号之后**的 payload（base64 自身不含逗号）。*/
        var raw = base64
        if let comma = base64.lastIndex(of: ",") {
            raw = String(base64[base64.index(after: comma)...])
        }
        raw = raw.replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = Data(base64Encoded: raw, options: .ignoreUnknownCharacters), data.count > 0 else {
            replyBridge(cbId, "{}", "图片数据解码失败")
            return
        }
        // 文件名清洗：去掉路径分隔符与冒号（截图名里含时间戳 hh:mm:ss）
        var safe = name.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
        if safe.isEmpty { safe = "JavPaco-截图.png" }
        if !safe.lowercased().hasSuffix(".png") { safe += ".png" }

        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
        // ⚠️去重必须用「原始基名」重新拼，不能拿已加过 (n) 的名字再加工
        //   （那样会滚成 a(2)(3)(3)… 无限套娃，实测踩过）。
        let base = destSafeBase(safe)
        var dest = dir.appendingPathComponent(safe)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent("\(base)(\(n)).png")
            n += 1
            if n > 9999 { break }
        }
        do {
            try data.write(to: dest, options: .atomic)
            debugLog("截图已保存: \(dest.path) (\(data.count) bytes)")
            replyBridge(cbId, "{\"path\":\(jsonString(dest.path))}", "")
        } catch {
            replyBridge(cbId, "{}", "写入失败：\(error.localizedDescription)")
        }
    }

    // MARK: - 外部播放器：手动指定 / 系统默认关联 / 自动探测（IINA·VLC·mpv）
    /* 契约与 Windows 版 main.js 对齐（2026-10-15 补齐）：
     *   ·「设置 → 播放」那一页的方块、探测文案、四个按钮全靠下面这套字段；
     *   · 解析优先级 = 手动指定 > 系统默认关联 > 自动挑一个已装的；
     *   · 手动指定的程序记在 UserDefaults（Win 版记在 data\userdata\player.txt）。
     * ⚠ 之前 Mac 壳没有 playerProbe / setPlayer / pickPlayer / clearPlayer / openUrl 五个命令，
     *   网页发过来一律落进 default 分支只写一行日志 → 设置 → 播放整页卡在「正在检测本机播放器…」，
     *   「选择文件」点了没反应，网站页点卡片也不会开浏览器。 */

    /// 已知播放器（Mac 端没有 PotPlayer 这类，保持这三种 + 系统默认）
    private var customPlayerPath: String {
        UserDefaults.standard.string(forKey: AppDelegate.playerKey) ?? ""
    }

    /// 显示名：优先 CFBundleName，退回文件名
    private func appName(_ url: URL) -> String {
        if let b = Bundle(url: url), let n = b.object(forInfoDictionaryKey: "CFBundleName") as? String, !n.isEmpty {
            return n
        }
        return url.deletingPathExtension().lastPathComponent
    }

    private func appURL(bid: String) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid)
    }

    /// 系统对 .mp4 的默认程序（≈ Finder 里双击会用哪个）—— 与 Win 版读注册表关联同义
    private func systemDefaultMovieApp() -> URL? {
        if #available(macOS 11.0, *) {
            return NSWorkspace.shared.urlForApplication(toOpen: UTType.mpeg4Movie)
        }
        return nil
    }

    /// 取程序图标（64px PNG data URI）—— 设置页方块用它显示「当前用哪个播放器」
    private func iconDataURI(path: String) -> String {
        guard !path.isEmpty else { return "" }
        let img = NSWorkspace.shared.icon(forFile: path)
        img.size = NSSize(width: 64, height: 64)
        guard let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return "" }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    /// 解析「这次到底会用哪个播放器」。honor 是网页传来的偏好值（default / custom / iina / vlc / mpv）。
    private func resolvePlayer(honor: String?) -> (exe: String, label: String, via: String) {
        // ① 手动指定（最高优先级，网页方块选完就写这里）
        let cust = customPlayerPath
        if !cust.isEmpty, FileManager.default.fileExists(atPath: cust) {
            return (cust, appName(URL(fileURLWithPath: cust)), "custom")
        }
        // ② 网页点名某个具体播放器（旧路径保留，兼容历史 localStorage 值）
        switch honor {
        case "iina": if let u = appURL(bid: "com.colliderli.iina") { return (u.path, appName(u), "system") }
        case "vlc":  if let u = appURL(bid: "org.videolan.vlc")    { return (u.path, appName(u), "system") }
        case "mpv":  if let u = appURL(bid: "io.mpv.mpv")          { return (u.path, appName(u), "system") }
        default: break
        }
        // ③ 系统默认关联（跟访达双击一致）
        if let sys = systemDefaultMovieApp() { return (sys.path, appName(sys), "system") }
        // ④ 自动挑一个已装的
        for p in AppDelegate.knownPlayers {
            if let u = appURL(bid: p.bid) { return (u.path, appName(u), "auto") }
        }
        return ("", "", "")
    }

    /// 设置 → 播放：把探测结果按 Win 版同款字段回给网页
    private func playerProbeInfo(force: Bool, sel: String) -> [String: Any] {
        if !force, let c = playerProbeCache { return c }
        let r = resolvePlayer(honor: sel)
        var out: [String: Any] = ["exe": r.exe, "label": r.label, "via": r.via]
        let cust = customPlayerPath
        if !cust.isEmpty {
            out["custom"] = cust
            let ic = iconDataURI(path: cust)
            out["icon"] = ic
        }
        var list: [[String: String]] = []
        for p in AppDelegate.knownPlayers {
            if let u = appURL(bid: p.bid) { list.append(["label": p.name, "exe": u.path]) }
        }
        out["list"] = list
        if let sys = systemDefaultMovieApp() {
            out["sysExe"] = sys.path
            out["sysLabel"] = appName(sys)
        }
        playerProbeCache = out
        debugLog("playerProbe: exe=\(r.exe.isEmpty ? "(无)" : r.exe) via=\(r.via) 已装=\(list.map { $0["label"] ?? "" }.joined(separator: "/"))")
        return out
    }

    /// 记下用户手动挑的播放器（网页方块 / 拖进来 / pickPlayer 面板都走这里）
    private func setCustomPlayer(_ p: String) {
        var path = p
        // 允许用户挑到 .app 里的可执行文件 → 归一化成 .app 本体
        if let r = path.range(of: ".app/") { path = String(path[path.startIndex..<r.lowerBound]) + ".app" }
        UserDefaults.standard.set(path, forKey: AppDelegate.playerKey)
        playerProbeCache = nil
        debugLog("指定外部播放器：\(path)")
    }

    /// 弹面板挑一个播放器程序（Mac 上是 .app；Win 版挑的是 .exe）
    private func pickPlayerApp(cbId: Int) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = false
        panel.prompt = "选择"
        panel.message = "选一个播放器程序（.app）"
        if #available(macOS 11.0, *) {
            panel.allowedContentTypes = [.application, .unixExecutable, .executable]
        }
        let apps = URL(fileURLWithPath: "/Applications")
        if FileManager.default.fileExists(atPath: apps.path) { panel.directoryURL = apps }
        guard panel.runModal() == .OK, let u = panel.url else {
            debugLog("pickPlayer: 用户取消")
            replyBridge(cbId, "{}", "已取消")
            return
        }
        var chosen = u.path
        if let r = chosen.range(of: ".app/") { chosen = String(chosen[chosen.startIndex..<r.lowerBound]) + ".app" }
        setCustomPlayer(chosen)
        replyBridge(cbId, "{\"path\":\(jsonString(chosen))}", "")
    }

    /// 网页「↗ 外部播放器」/「▶ 本地播放」调用：path 是宿主机真实文件路径（Mac 上视频挂在
    /// CloudDrive/FUSE，播放器能直接读）；url 是兜底 HTTP 流地址（http://127.0.0.1:8099/media/<rel>）。
    /// player: default=按上面的解析优先级；custom=用手动指定的。**必须回执** ——
    ///   前端收到 noPlayer 会弹「选择播放器…」，收到普通错误会弹「打开失败」，都不回就是
    ///   永远停在「正在唤起外部播放器…」。
    private func openExternal(path: String?, url: String?, player: String, cbId: Int) {
        // 1) 解析目标：优先真实文件，否则用 HTTP 流地址
        var target: URL?
        if let p = path, !p.isEmpty, FileManager.default.fileExists(atPath: p) {
            target = URL(fileURLWithPath: p)
        } else if let u = url, !u.isEmpty, let uu = URL(string: u), uu.scheme == "http" || uu.scheme == "https" {
            target = uu
        }
        guard let target else {
            debugLog("openExternal: 既无有效文件也无有效地址")
            replyBridge(cbId, "{}", "没有可播放的文件或地址")
            return
        }
        // 2) 按与 playerProbe 完全相同的优先级选程序，保证「设置里显示哪个」= 「实际用哪个」
        let r = resolvePlayer(honor: player)
        debugLog("openExternal: 目标=\(target.lastPathComponent) 解析=\(r.label)(\(r.via))")

        if !r.exe.isEmpty, FileManager.default.fileExists(atPath: r.exe) {
            let appURL = URL(fileURLWithPath: r.exe)
            NSWorkspace.shared.open([target], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration()) { _, err in
                if let err {
                    self.debugLog("openExternal: 用 \(r.label) 打开失败 \(err.localizedDescription)")
                    DispatchQueue.main.async { self.replyBridge(cbId, "{}", err.localizedDescription) }
                }
            }
            return
        }
        // 3) 一个播放器都找不到：交给系统默认，并把「没播放器」告诉网页（让它给「选择播放器」按钮）
        if NSWorkspace.shared.open(target) {
            debugLog("openExternal: 已用系统默认打开 \(target.lastPathComponent)")
            replyBridge(cbId, "{}", "")
            return
        }
        debugLog("openExternal: 没有可用播放器")
        replyBridge(cbId, "{}", "本机没有可用的外部播放器，可以点「选择播放器…」指定一个。", noPlayer: true)
    }

    /// 把 Swift 字符串安全地包成 JSON 字符串字面量（含引号与转义）
    private func jsonString(_ s: String) -> String {
        if let d = try? JSONSerialization.data(withJSONObject: [s]),
           let arr = String(data: d, encoding: .utf8) {
            return String(arr.dropFirst().dropLast())
        }
        return "\"\""
    }

    /* ⚠️ 原生全屏（setWindowFullscreen / pushFsState）与原生画中画（togglePiP /
       openPiPWindow / pipHTML / closePiP / jsStr）都在 2026-10-10 整块删除。
       原因：用户要求「去掉画中画，全屏改成软件页面内全屏」。
       - 画中画：WKWebView/macOS 没有 PiP API，置顶小窗那套是绕路且体验不对。
       - 全屏：不再把整个 App 窗口切成系统全屏（会吃掉菜单栏、切换 Space 很跳），
         改成前端把播放器搬到 body 上的 fixed 浮层里，浏览器与 Mac App 表现一致。
       保留 NSWindow.toggleFullScreen 相关的任何代码都会让人误以为还有原生全屏路径。 */

    /// 弹访达让用户选文件夹，选完把路径回传给网页（多选时用 \n 分隔）
    /// title / button 由调用方覆盖（「离线数据迁移」用「选择离线数据目录」），不传就用默认文案。
    func chooseDir(start: URL?, cbId: Int, multiple: Bool, title: String? = nil, button: String? = nil) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = multiple
        panel.prompt = (button?.isEmpty == false) ? button! : "选择"
        if let t = title, !t.isEmpty {
            panel.message = t
        } else {
            panel.message = multiple ? "选择文件夹（可多选）" : "选择文件夹"
        }
        if let start { panel.directoryURL = start }
        guard panel.runModal() == .OK, !panel.urls.isEmpty else {
            callPick(cbId, "")
            return
        }
        callPick(cbId, panel.urls.map { $0.path }.joined(separator: "\n"))
    }

    /// 把当前图标风格告诉网页，让「设置 → 外观」里的选项显示选中态
    private func tellIcon() {
        let js = "__onNativeIcon && __onNativeIcon('\(dockIcon.rawValue)')"
        webView?.evaluateJavaScript(js) { _, err in
            if let err { self.debugLog("同步图标状态给网页失败: \(err.localizedDescription)") }
        }
    }

    private func callPick(_ cbId: Int, _ path: String) {
        let esc = path.replacingOccurrences(of: "\\", with: "\\\\")
                      .replacingOccurrences(of: "'", with: "\\'")
                      .replacingOccurrences(of: "\n", with: "\\n")
        debugLog("bridge pick -> \(path.isEmpty ? "(取消)" : path)")
        webView?.evaluateJavaScript("__onNativePick(\(cbId), '\(esc)')") { _, err in
            if let err { self.debugLog("回调 JS 失败: \(err.localizedDescription)") }
        }
    }
}

// MARK: - 让网页里的 window.confirm / alert / prompt 在 Mac 端能正常弹窗
/* 不实现这个 delegate，WKWebView 会直接丢弃这些 JS 弹窗（confirm 返回 false），
 * 导致「删除 / 隐藏 / 清空」等所有需要确认的操作在 Mac 上点了没反应。 */
extension AppDelegate: WKUIDelegate {
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = "JavPaco"
        a.informativeText = message
        a.alertStyle = .informational
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "JavPaco"
        a.informativeText = message
        a.alertStyle = .warning
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        let r = a.runModal()
        completionHandler(r == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = "JavPaco"
        a.informativeText = prompt
        a.alertStyle = .informational
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        tf.stringValue = defaultText ?? ""
        a.accessoryView = tf
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        let r = a.runModal()
        completionHandler(r == .alertFirstButtonReturn ? tf.stringValue : nil)
    }
}

// MARK: - 外链用系统默认浏览器打开（不在 App 内 WebView 跳转）
/* 点 jav321 / javdb 等外站链接（含详情页「番号链接页」、刮削历史的图源按钮）时，
 * 用 NSWorkspace 唤起默认浏览器；应用自身 SPA（同一 127.0.0.1 主机）仍内嵌渲染。 */
extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            let host = url.host?.lowercased() ?? ""
            let isLocal = host == "127.0.0.1" || host == "localhost" || host == "::1"
            if !isLocal {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    /// 页面就绪后跑一次播放器探测自检：这是设置→播放的真实链路（send → 原生探测 → 回执 →
    /// 网页回调），若有网页侧异常会被 replyBridge 的 try/catch 捕获并回传详情。
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            let js = "(function(){try{ window.probePlayer && probePlayer(true) }" +
                "catch(e){ try{ window.webkit.messageHandlers.javpaco.postMessage({cmd:'bridgeErr', cbId:-1, msg:'自检:'+String(e&&(e.stack||e.message)||e)}) }catch(_){}} })()"
            webView.evaluateJavaScript(js) { _, err in
                if let err { self?.debugLog("启动自检失败: \(err.localizedDescription)") }
            }
        }
    }
}
