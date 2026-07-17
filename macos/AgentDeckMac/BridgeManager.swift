import Foundation
import Combine

/// Owns the bridge daemon process: locates the bundled runtime, spawns it,
/// restarts it if it crashes, and exposes its readiness + pairing info.
@MainActor
final class BridgeManager: ObservableObject {
    static let shared = BridgeManager()

    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)

        var isRunning: Bool { self == .running }

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case .running: return "Running"
            case .failed(let m): return "Failed: \(m)"
            }
        }
    }

    @Published private(set) var state: State = .stopped
    /// Set once the bridge answers /health and the pairing token exists on disk.
    @Published private(set) var pairingToken: String?
    @Published var port: Int = UserDefaults.standard.object(forKey: "agentdeck.port") as? Int ?? 8787 {
        didSet { UserDefaults.standard.set(port, forKey: "agentdeck.port") }
    }

    private var process: Process?
    private var userStopped = false
    private var restartAttempt = 0
    private var healthTask: Task<Void, Never>?

    private let tokenFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".agentdeck/token")
    private let logFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/AgentDeck/bridge.log")

    // MARK: - Runtime location

    struct Runtime {
        let nodeURL: URL
        let entryURL: URL
    }

    /// Bundled runtime (Resources/bridge/{node,dist/index.js}); falls back to a
    /// system Node + AGENTDECK_BRIDGE_DIR for development builds.
    func locateRuntime() -> Runtime? {
        if let res = Bundle.main.resourceURL {
            let node = res.appendingPathComponent("bridge/node")
            let entry = res.appendingPathComponent("bridge/dist/index.js")
            if FileManager.default.isExecutableFile(atPath: node.path),
               FileManager.default.fileExists(atPath: entry.path) {
                return Runtime(nodeURL: node, entryURL: entry)
            }
        }
        // Dev fallback: repo checkout + system node.
        let devDir = ProcessInfo.processInfo.environment["AGENTDECK_BRIDGE_DIR"]
        let candidates = [devDir].compactMap { $0 }
        for dir in candidates {
            let entry = URL(fileURLWithPath: dir).appendingPathComponent("dist/index.js")
            if FileManager.default.fileExists(atPath: entry.path), let node = systemNode() {
                return Runtime(nodeURL: node, entryURL: entry)
            }
        }
        return nil
    }

    private func systemNode() -> URL? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    // MARK: - Lifecycle

    func startIfConfigured() {
        guard state == .stopped else { return }
        start()
    }

    func start() {
        guard process == nil else { return }
        guard let runtime = locateRuntime() else {
            state = .failed("bridge runtime not found in app bundle")
            return
        }
        userStopped = false
        state = .starting

        let p = Process()
        p.executableURL = runtime.nodeURL
        p.arguments = [runtime.entryURL.path, "--no-qr", "--port", String(port),
                       "--exit-with-parent", String(ProcessInfo.processInfo.processIdentifier)]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        // Agent CLIs (claude, cursor-agent, codex) live in user paths the GUI
        // session doesn't inherit — extend PATH so the bridge can spawn them.
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "\(home)/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        env["PATH"] = (extra + [(env["PATH"] ?? "/usr/bin:/bin")]).joined(separator: ":")
        p.environment = env

        try? FileManager.default.createDirectory(
            at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logFile.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            p.standardOutput = handle
            p.standardError = handle
        }

        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.handleTermination(status: proc.terminationStatus) }
        }

        do {
            try p.run()
            process = p
            pollHealth()
        } catch {
            state = .failed(error.localizedDescription)
            process = nil
        }
    }

    func stop() {
        userStopped = true
        healthTask?.cancel()
        healthTask = nil
        process?.terminate()
        process = nil
        state = .stopped
        pairingToken = nil
    }

    func restart() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.start() }
    }

    private func handleTermination(status: Int32) {
        process = nil
        healthTask?.cancel()
        pairingToken = nil
        guard !userStopped else { return }
        restartAttempt += 1
        if restartAttempt > 5 {
            state = .failed("bridge keeps exiting (status \(status)) — see \(logFile.path)")
            return
        }
        state = .starting
        let delay = min(10.0, pow(2.0, Double(restartAttempt)))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.userStopped, self.process == nil else { return }
            self.start()
        }
    }

    private func pollHealth() {
        healthTask?.cancel()
        healthTask = Task { [weak self] in
            guard let self else { return }
            for _ in 0..<40 {
                if Task.isCancelled { return }
                if await self.healthOK() {
                    let token = (try? String(contentsOf: self.tokenFile, encoding: .utf8))?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    await MainActor.run {
                        self.state = .running
                        self.restartAttempt = 0
                        self.pairingToken = token
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            await MainActor.run {
                if self.state == .starting { self.state = .failed("bridge did not become healthy") }
            }
        }
    }

    private func healthOK() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: - Phone approvals (Claude Code hooks)

    /// nil until the first status check completes.
    @Published private(set) var hooksInstalled: Bool?

    /// Run the bundled CLI (`node dist/index.js <args>`) and capture its output.
    private func runBridgeCommand(_ args: [String]) async -> (status: Int32, output: String) {
        guard let runtime = locateRuntime() else { return (127, "bridge runtime not found") }
        let p = Process()
        p.executableURL = runtime.nodeURL
        p.arguments = [runtime.entryURL.path] + args
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
                       env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (127, error.localizedDescription) }
        return await withCheckedContinuation { cont in
            p.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                cont.resume(returning: (proc.terminationStatus, String(data: data, encoding: .utf8) ?? ""))
            }
        }
    }

    func refreshHooksStatus() async {
        let (_, out) = await runBridgeCommand(["hooks", "status"])
        hooksInstalled = out.contains("installed:")
    }

    /// Enable/disable phone approvals. Returns an error message, or nil on success.
    /// Additive by design: with approvals on, an unanswered prompt falls back to
    /// Claude's normal terminal prompt — the user's regular flow is untouched.
    func setHooksEnabled(_ enabled: Bool) async -> String? {
        let args = enabled ? ["hooks", "install", "--port", String(port)] : ["hooks", "uninstall"]
        let (status, out) = await runBridgeCommand(args)
        await refreshHooksStatus()
        return status == 0 ? nil : out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Pairing

    /// Web-app pairing URL — opens in any phone's browser, nothing to install.
    func webPairingURL() -> String? {
        guard let token = pairingToken, let host = Self.lanIPAddress() else { return nil }
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = host
        comps.port = port
        comps.path = "/"
        comps.queryItems = [.init(name: "token", value: token)]
        return comps.string
    }

    /// The deep link the iOS app pairs with (also encoded in the QR).
    func pairingURL() -> String? {
        guard let token = pairingToken, let host = Self.lanIPAddress() else { return nil }
        var comps = URLComponents()
        comps.scheme = "agentdeck"
        comps.host = "pair"
        comps.queryItems = [
            .init(name: "host", value: host),
            .init(name: "port", value: String(port)),
            .init(name: "token", value: token),
            .init(name: "name", value: Host.current().localizedName ?? "Mac"),
        ]
        return comps.string
    }

    /// Primary IPv4 address on a non-loopback interface (en0 preferred).
    static func lanIPAddress() -> String? {
        var best: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = ptr.pointee
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ifa.ifa_name)
            guard !name.hasPrefix("lo"), (Int32(ifa.ifa_flags) & IFF_UP) != 0 else { continue }
            var addr = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &addr, socklen_t(addr.count),
                           nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: addr)
                if name == "en0" { return ip }
                if best == nil { best = ip }
            }
        }
        return best
    }
}
