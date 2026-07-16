import SwiftUI

@main
struct AgentDeckMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var bridge = BridgeManager.shared
    @StateObject private var client = BridgeClient()

    var body: some Scene {
        MenuBarExtra {
            MenuContent()
                .environmentObject(bridge)
                .environmentObject(client)
                .modifier(AutoConnect(bridge: bridge, client: client))
        } label: {
            Image(systemName: bridge.state.isRunning ? "square.stack.3d.up.fill" : "square.stack.3d.up")
        }
        .menuBarExtraStyle(.window)

        Window("AgentDeck", id: "deck") {
            MacDeckView()
                .environmentObject(bridge)
                .environmentObject(client)
                .modifier(AutoConnect(bridge: bridge, client: client))
                .frame(minWidth: 720, minHeight: 460)
                .onAppear { wireNotifications() }
        }
        .defaultSize(width: 980, height: 640)

        Settings {
            MacSettingsView()
                .environmentObject(bridge)
        }
    }

    private func wireNotifications() {
        client.onIncomingEvent = { sessionId, stored in
            let session = client.session(id: sessionId)
            NotificationManager.shared.handle(sessionId: sessionId, stored: stored, session: session)
        }
    }
}

/// Connects the in-app client to the local bridge whenever it becomes healthy.
private struct AutoConnect: ViewModifier {
    @ObservedObject var bridge: BridgeManager
    @ObservedObject var client: BridgeClient

    func body(content: Content) -> some View {
        content
            .onChange(of: bridge.pairingToken) { _, token in
                connectIfPossible(token: token)
            }
            .onAppear {
                connectIfPossible(token: bridge.pairingToken)
            }
    }

    private func connectIfPossible(token: String?) {
        guard let token, !token.isEmpty else { return }
        if case .connected = client.connectionState { return }
        client.connect(host: "127.0.0.1", port: bridge.port, token: token)
        NotificationManager.shared.requestAuthorizationIfNeeded()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { BridgeManager.shared.startIfConfigured() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Must run synchronously — an async Task would never execute before exit,
        // leaving the bridge child orphaned and holding the port.
        MainActor.assumeIsolated { BridgeManager.shared.stop() }
    }
}
