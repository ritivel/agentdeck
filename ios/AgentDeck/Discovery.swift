import Foundation
import Network
import Combine

struct DiscoveredBridge: Identifiable, Equatable {
    let id: String       // endpoint name
    let name: String
    let host: String
    let port: Int
}

@MainActor
final class Discovery: ObservableObject {
    @Published private(set) var bridges: [DiscoveredBridge] = []
    @Published private(set) var isBrowsing = false

    private var browser: NWBrowser?
    private var resolvers: [String: NWConnection] = [:]

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = true
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_agentdeck._tcp", domain: nil)
        let browser = NWBrowser(for: descriptor, using: params)
        self.browser = browser

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.isBrowsing = true
                case .failed, .cancelled: self?.isBrowsing = false
                default: break
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in self?.handle(results: results) }
        }

        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        for c in resolvers.values { c.cancel() }
        resolvers.removeAll()
        bridges.removeAll()
        isBrowsing = false
    }

    private func handle(results: Set<NWBrowser.Result>) {
        // Keep only endpoints still present.
        let currentNames: Set<String> = Set(results.compactMap { result in
            if case let .service(name, _, _, _) = result.endpoint { return name }
            return nil
        })
        bridges.removeAll { !currentNames.contains($0.id) }

        for result in results {
            guard case let .service(name, _, _, _) = result.endpoint else { continue }
            if bridges.contains(where: { $0.id == name }) { continue }
            if resolvers[name] != nil { continue }
            resolve(endpoint: result.endpoint, name: name)
        }
    }

    private func resolve(endpoint: NWEndpoint, name: String) {
        let conn = NWConnection(to: endpoint, using: .tcp)
        resolvers[name] = conn
        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    if let (host, port) = Self.extract(from: conn.currentPath?.remoteEndpoint) {
                        let bridge = DiscoveredBridge(id: name, name: name, host: host, port: port)
                        if !self.bridges.contains(where: { $0.id == name }) {
                            self.bridges.append(bridge)
                        }
                    }
                    conn.cancel()
                    self.resolvers[name] = nil
                case .failed, .cancelled:
                    self.resolvers[name] = nil
                default:
                    break
                }
            }
        }
        conn.start(queue: .main)
    }

    private static func extract(from endpoint: NWEndpoint?) -> (String, Int)? {
        guard let endpoint else { return nil }
        switch endpoint {
        case let .hostPort(host, port):
            let h: String
            switch host {
            case .ipv4(let addr):
                h = "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
            case .ipv6(let addr):
                h = "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
            case .name(let n, _):
                h = n
            @unknown default:
                h = "\(host)"
            }
            return (h, Int(port.rawValue))
        default:
            return nil
        }
    }
}
