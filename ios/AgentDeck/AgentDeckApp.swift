import SwiftUI

@main
struct AgentDeckApp: App {
    @StateObject private var client = BridgeClient()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(client)
                .preferredColorScheme(.dark)
                .onAppear {
                    wireNotifications()
                    client.autoConnect()
                }
                .onOpenURL { url in
                    client.handlePairingURL(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    NotificationManager.shared.isForeground = (phase == .active)
                    if phase == .active {
                        // Resume connection if it dropped while backgrounded.
                        if case .connected = client.connectionState {} else {
                            client.autoConnect()
                        }
                    }
                }
                .onChange(of: client.connectionState) { _, state in
                    if case .connected = state {
                        NotificationManager.shared.requestAuthorizationIfNeeded()
                    }
                }
        }
    }

    private func wireNotifications() {
        client.onIncomingEvent = { sessionId, stored in
            let session = client.session(id: sessionId)
            NotificationManager.shared.handle(sessionId: sessionId, stored: stored, session: session)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var client: BridgeClient

    var body: some View {
        switch client.connectionState {
        case .connected:
            DeckView()
        default:
            PairingView()
        }
    }
}
