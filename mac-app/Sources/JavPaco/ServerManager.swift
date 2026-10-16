import Foundation

/* 管理 javpaco 的 Node 服务进程：启动、等待就绪、退出时收干净。
 *
 * 关键设计：
 *  - 运行时（server.js / index.html / node_modules / actresses.json …）装在 App 里的 Resources/runtime，
 *    首次启动整份拷到 ~/Library/Application Support/javpaco/runtime —— 因为服务端会往 __dirname 里写
 *    （cache/、server-config.json、actresses.json 都会改），不能写进 App 包内（会破坏签名、也没权限）。
 *  - Node 用内置的二进制（Resources/node），没有就用系统的。
 *  - 媒体目录通过 argv[2] 传给 server.js，端口 argv[3]。 */
final class ServerManager: ObservableObject {
    static let appSupportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("javpaco", isDirectory: true)
    }()
    static let runtimeDir = appSupportDir.appendingPathComponent("runtime", isDirectory: true)
    static let logDir = appSupportDir.appendingPathComponent("logs", isDirectory: true)

    private var process: Process?
    private(set) var lastError: String?

    var port: Int {
        get { UserDefaults.standard.integer(forKey: "jp.port").nonzero ?? 8099 }
        set { UserDefaults.standard.set(newValue, forKey: "jp.port") }
    }
    var mediaPath: String {
        get { UserDefaults.standard.string(forKey: "jp.mediaPath") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "jp.mediaPath") }
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    /* 把打包在 App 里的运行时装（更新）到 ~/Library/Application Support/javpaco/runtime。
     * version.txt 一致就跳过，避免每次启动都拷 34MB。
     *
     * ⚠️ 更新方式必须是「增量覆盖」，不能整份 move + 拷贝（2026-10-03 改）：
     *   整份 move 会把 runtime 改名成 runtime.old-<ts> 留在原地 —— 每次几百 MB，
     *   实测 11 次更新堆到 **2.8GB**（旧副本里的 cache 还是过时的，纯垃圾）；
     *   更糟的是 move 之后若 copy 失败（本机有「批量删除保护」，删不掉就失败），
     *   App 会**继续跑旧代码**，症状就是「改了没效果」，极难自查。
     *   现在只替换程序文件，cache/ 与配置原地保留，也不再留副本。 */
    func installRuntimeIfNeeded() throws {
        let fm = FileManager.default
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("runtime") else {
            throw NSError(domain: "jp", code: 1, userInfo: [NSLocalizedDescriptionKey: "App 内缺少 runtime 资源"])
        }
        let bundledVer = (try? String(contentsOf: bundled.appendingPathComponent("version.txt"), encoding: .utf8)) ?? "dev"
        let installedVer = (try? String(contentsOf: ServerManager.runtimeDir.appendingPathComponent("version.txt"), encoding: .utf8)) ?? ""
        try fm.createDirectory(at: ServerManager.appSupportDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: ServerManager.logDir, withIntermediateDirectories: true)

        if !fm.fileExists(atPath: ServerManager.runtimeDir.path) {
            try fm.copyItem(at: bundled, to: ServerManager.runtimeDir)          // 首次安装：整份拷
        } else if bundledVer != installedVer {
            /* 数据类的东西不碰：刮削缓存、配置、队列、代号缓存、断点状态…… */
            let keep: Set<String> = [
                "cache", "server-config.json", "actresses-extra.json",
                "jdb-codes.json", "jdb-codes-run.json", "scrape-history.json",
                "ingest-queue.json", "roster-sync-state.json", "node_modules", "logs",
            ]
            let items = (try? fm.contentsOfDirectory(atPath: bundled.path)) ?? []
            for name in items {
                if keep.contains(name) { continue }
                let dst = ServerManager.runtimeDir.appendingPathComponent(name)
                if fm.fileExists(atPath: dst.path) { try? fm.removeItem(at: dst) }    // 单个条目，不整目录删
                try? fm.copyItem(at: bundled.appendingPathComponent(name), to: dst)
            }
            /* node_modules 只在缺失时补（几千个文件，整份替换会被删除保护拦，而且很少变） */
            let nm = ServerManager.runtimeDir.appendingPathComponent("node_modules")
            if !fm.fileExists(atPath: nm.path) {
                try? fm.copyItem(at: bundled.appendingPathComponent("node_modules"), to: nm)
            }
        }
        /* version.txt 最后写：中途失败时下次启动仍会重试更新 */
        try? bundledVer.write(to: ServerManager.runtimeDir.appendingPathComponent("version.txt"),
                              atomically: true, encoding: .utf8)
        /* 服务端要能写 __dirname 下的东西，去掉拷贝带过来的只读位 */
        if let en = fm.enumerator(at: ServerManager.runtimeDir, includingPropertiesForKeys: [.isWritableKey]) {
            for case let u as URL in en {
                if let v = try? u.resourceValues(forKeys: [.isWritableKey]), v.isWritable == false {
                    try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: u.path)
                }
            }
        }
    }

    private func nodeBinary() -> URL? {
        if let p = Bundle.main.path(forResource: "node", ofType: nil), FileManager.default.isExecutableFile(atPath: p) {
            return URL(fileURLWithPath: p)
        }
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    var isRunning: Bool { process?.isRunning ?? false }

    /* 杀掉占着端口的**残留**服务进程。
     * 起因（2026-10-03）：App 被强杀 / 崩溃时不会带走它 spawn 的 node，
     * 那个孤儿一直占着 8099 并且跑的是**旧 server.js** —— 页面是新的（它从磁盘读 index.html），
     * 逻辑却是旧的（/api/scrape/status 没有 queue 字段、新排队功能全部不生效），极难排查。
     * 只杀命令行里带我们 runtime 路径的 node，绝不碰别的进程。 */
    private func killOrphanServer() {
        let pat = NSRegularExpression.escapedPattern(for: ServerManager.runtimeDir.path + "/server.js")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-f", pat]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run(); p.waitUntilExit() } catch { return }
        let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let pids = s.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !pids.isEmpty else { return }
        for pid in pids { if let n = Int(pid) { kill(pid_t(n), SIGTERM) } }
        Thread.sleep(forTimeInterval: 1.2)
        for pid in pids { if let n = Int(pid) { kill(pid_t(n), SIGKILL) } }   // 不听劝的补一刀
        NSLog("[javpaco] 清掉残留服务进程 %@（端口 %d）", pids.joined(separator: ","), port)
    }

    func start() {
        guard !isRunning else { return }
        guard let node = nodeBinary() else { lastError = "找不到 Node 运行时"; return }
        let serverJS = ServerManager.runtimeDir.appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: serverJS.path) else { lastError = "缺少 server.js"; return }
        killOrphanServer()
        let media = mediaPath.isEmpty ? NSHomeDirectory() + "/Movies" : mediaPath
        let logFile = ServerManager.logDir.appendingPathComponent("server.log").path
        FileManager.default.createFile(atPath: logFile, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: logFile) else { lastError = "无法写日志"; return }
        fh.seekToEndOfFile()

        let p = Process()
        p.executableURL = node
        p.arguments = [serverJS.path, media, String(port)]
        p.currentDirectoryURL = ServerManager.runtimeDir
        p.standardOutput = fh
        p.standardError = fh
        /* 不清空继承的环境：Node 需要 HOME / PATH 等；额外标记一下，方便服务端知道自己跑在 Mac 版里 */
        var env = ProcessInfo.processInfo.environment
        env["JP_MAC"] = "1"
        p.environment = env
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.process = nil }
        }
        do { try p.run(); process = p; lastError = nil }
        catch { lastError = "启动失败：\(error.localizedDescription)" }
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        p.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }

    func restart() { stop(); DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start() } }

    /* 轮询首页直到 200 —— 150 毫秒一次，默认最多 60 秒。
     * ⚠️ 实测本机首次启动约 27 秒才 bind 端口（启动时要拉名册/CDN，网络差时更久），等短了会误判成失败。 */
    func waitReady(timeout: TimeInterval = 60, completion: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            if isRunning == false && Date() > deadline.addingTimeInterval(-timeout + 3) { completion(false); return }
            var req = URLRequest(url: baseURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
            req.httpMethod = "GET"
            URLSession.shared.dataTask(with: req) { _, resp, err in
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 { DispatchQueue.main.async { completion(true) }; return }
                if Date() > deadline { DispatchQueue.main.async { completion(false) }; return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { poll() }
            }.resume()
        }
        poll()
    }
}

private extension Int {
    var nonzero: Int? { self == 0 ? nil : self }
}
