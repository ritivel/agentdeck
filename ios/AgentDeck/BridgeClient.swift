import Foundation
import Combine

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)

    var label: String {
        switch self {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .failed(let m): return "Error: \(m)"
        }
    }
}

struct ConnectionTarget: Codable, Equatable {
    var host: String
    var port: Int
    var token: String
}

@MainActor
final class BridgeClient: NSObject, ObservableObject {
    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var serverName: String = ""
    @Published private(set) var version: String = ""
    @Published private(set) var platforms: [String: PlatformAvailability] = [:]
    @Published private(set) var sessions: [SessionInfo] = []
    @Published private(set) var transcripts: [String: [StoredEvent]] = [:]
    @Published private(set) var suggestedDirs: [String] = []
    @Published private(set) var lastError: String?
    @Published var target: ConnectionTarget?

    /// Notified for every incoming stored event so higher layers (notifications) can react.
    var onIncomingEvent: ((_ sessionId: String, _ stored: StoredEvent) -> Void)?

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var reconnectAttempt = 0
    private var explicitlyDisconnected = false
    private var requestedHistory: Set<String> = []

    private let defaults = UserDefaults.standard
    private let targetKey = "agentdeck.lastTarget"

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        if let data = defaults.data(forKey: targetKey),
           let saved = try? JSONDecoder().decode(ConnectionTarget.self, from: data) {
            target = saved
        }
    }

    var availablePlatforms: [Platform] {
        Platform.allCases.filter { platforms[$0.rawValue]?.available == true }
    }

    // MARK: - Connection lifecycle

    func connect(host: String, port: Int, token: String) {
        let t = ConnectionTarget(host: host, port: port, token: token)
        target = t
        explicitlyDisconnected = false
        reconnectAttempt = 0
        openSocket(with: t)
    }

    /// Handle an `agentdeck://pair?host=..&port=..&token=..` URL (QR payload / deep link).
    func handlePairingURL(_ url: URL) {
        guard url.scheme == "agentdeck",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = comps.queryItems?.first(where: { $0.name == "host" })?.value,
              let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
        else { return }
        let port = comps.queryItems?.first(where: { $0.name == "port" })?.value.flatMap(Int.init) ?? 8787
        connect(host: host, port: port, token: token)
    }

    func autoConnect() {
        guard let t = target else { return }
        explicitlyDisconnected = false
        reconnectAttempt = 0
        openSocket(with: t)
    }

    func disconnect() {
        explicitlyDisconnected = true
        teardownSocket()
        connectionState = .disconnected
    }

    private func openSocket(with t: ConnectionTarget) {
        teardownSocket()
        guard var comps = URLComponents() as URLComponents? else { return }
        comps.scheme = "ws"
        comps.host = t.host
        comps.port = t.port
        comps.path = "/ws"
        comps.queryItems = [URLQueryItem(name: "token", value: t.token)]
        guard let url = comps.url else {
            connectionState = .failed("bad URL")
            return
        }
        connectionState = .connecting
        let ws = session.webSocketTask(with: url)
        task = ws
        ws.resume()
        receiveLoop()
        send(clientMessage: ["type": "hello", "clientName": deviceName()])
        startPing()
    }

    private func teardownSocket() {
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func scheduleReconnect() {
        guard !explicitlyDisconnected else { return }
        reconnectAttempt += 1
        let delay = min(15.0, pow(2.0, Double(min(reconnectAttempt, 4)))) // 2,4,8,16→cap 15
        let capped = min(delay, 15.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + capped) { [weak self] in
            guard let self, !self.explicitlyDisconnected, let t = self.target else { return }
            if case .connected = self.connectionState { return }
            self.openSocket(with: t)
        }
    }

    // MARK: - Receive

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                Task { @MainActor in self.handleSocketFailure(error) }
            case .success(let message):
                Task { @MainActor in
                    self.handle(message: message)
                    self.receiveLoop()
                }
            }
        }
    }

    private func handleSocketFailure(_ error: Error) {
        connectionState = .failed(error.localizedDescription)
        pingTimer?.invalidate()
        pingTimer = nil
        scheduleReconnect()
    }

    private func handle(message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let d): data = d
        case .string(let s): data = s.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data else { return }
        do {
            let msg = try ServerMessage(data: data)
            apply(msg)
        } catch {
            // Ignore malformed frames rather than dropping the connection.
        }
    }

    private func apply(_ msg: ServerMessage) {
        switch msg {
        case .welcome(let name, let ver, let plats, let sess):
            serverName = name
            version = ver
            platforms = plats
            sessions = sess.sorted(by: sortSessions)
            connectionState = .connected
            reconnectAttempt = 0
            persistTarget()
            requestSuggestedDirs()
        case .sessions(let list):
            sessions = list.sorted(by: sortSessions)
        case .sessionCreated(let s):
            upsert(s)
        case .sessionUpdated(let s):
            upsert(s)
        case .sessionRemoved(let id):
            sessions.removeAll { $0.id == id }
            transcripts[id] = nil
        case .event(let sid, let stored):
            appendEvent(sid, stored)
            onIncomingEvent?(sid, stored)
        case .history(let sid, let events):
            transcripts[sid] = events.sorted { $0.seq < $1.seq }
        case .dirs(let list):
            suggestedDirs = list
        case .error(let message, _):
            lastError = message
        case .pong:
            break
        case .unknown:
            break
        }
    }

    private func upsert(_ s: SessionInfo) {
        if let idx = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[idx] = s
        } else {
            sessions.append(s)
        }
        sessions.sort(by: sortSessions)
    }

    private func appendEvent(_ sessionId: String, _ stored: StoredEvent) {
        var list = transcripts[sessionId] ?? []
        if list.contains(where: { $0.seq == stored.seq }) { return }
        list.append(stored)
        list.sort { $0.seq < $1.seq }
        transcripts[sessionId] = list
    }

    private func sortSessions(_ a: SessionInfo, _ b: SessionInfo) -> Bool {
        a.updatedAt > b.updatedAt
    }

    // MARK: - Send helpers

    private func send(clientMessage: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: clientMessage),
              let str = String(data: data, encoding: .utf8) else { return }
        task.send(.string(str)) { [weak self] error in
            if let error {
                Task { @MainActor in self?.handleSocketFailure(error) }
            }
        }
    }

    func requestSessionList() {
        send(clientMessage: ["type": "session.list"])
    }

    /// Ask the bridge to suggest project directories for new-session cwd. Optional,
    /// non-standard message; the bridge simply ignores it if unsupported.
    func requestSuggestedDirs() {
        send(clientMessage: ["type": "dirs.suggest"])
    }

    func requestHistoryIfNeeded(_ sessionId: String) {
        if transcripts[sessionId] == nil, !requestedHistory.contains(sessionId) {
            requestedHistory.insert(sessionId)
            send(clientMessage: ["type": "session.history", "sessionId": sessionId])
        }
    }

    func requestHistory(_ sessionId: String, sinceSeq: Int? = nil) {
        var m: [String: Any] = ["type": "session.history", "sessionId": sessionId]
        if let sinceSeq { m["sinceSeq"] = sinceSeq }
        send(clientMessage: m)
    }

    func createSession(platform: Platform, cwd: String, permissionMode: PermissionMode?, title: String?, model: String?, prompt: String?) {
        var m: [String: Any] = ["type": "session.create", "platform": platform.rawValue, "cwd": cwd]
        if let permissionMode { m["permissionMode"] = permissionMode.rawValue }
        if let title, !title.isEmpty { m["title"] = title }
        if let model, !model.isEmpty { m["model"] = model }
        if let prompt, !prompt.isEmpty { m["prompt"] = prompt }
        send(clientMessage: m)
    }

    func sendPrompt(sessionId: String, text: String) {
        send(clientMessage: ["type": "prompt", "sessionId": sessionId, "text": text])
    }

    func interrupt(sessionId: String) {
        send(clientMessage: ["type": "interrupt", "sessionId": sessionId])
    }

    func archive(sessionId: String) {
        send(clientMessage: ["type": "session.archive", "sessionId": sessionId])
    }

    // MARK: - Ping

    private func startPing() {
        pingTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.send(clientMessage: ["type": "ping"]) }
        }
        pingTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    // MARK: - Helpers

    func session(id: String) -> SessionInfo? {
        sessions.first { $0.id == id }
    }

    func persistTarget() {
        guard let target, let data = try? JSONEncoder().encode(target) else { return }
        defaults.set(data, forKey: targetKey)
    }

    private func deviceName() -> String {
        #if canImport(UIKit)
        return "iPhone"
        #else
        return "AgentDeck client"
        #endif
    }
}

extension BridgeClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didOpenWithProtocol protocol: String?) {
        // The welcome message drives the .connected transition; nothing to do here.
    }

    nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                               reason: Data?) {
        Task { @MainActor in
            if !self.explicitlyDisconnected {
                self.connectionState = .disconnected
                self.scheduleReconnect()
            }
        }
    }
}
