import SwiftUI

/// Main window: sidebar of sessions grouped by platform, chat detail on the right.
struct MacDeckView: View {
    @EnvironmentObject var bridge: BridgeManager
    @EnvironmentObject var client: BridgeClient
    @State private var selection: String?
    @State private var showingNewSession = false
    @State private var newSessionPlatform: Platform?

    private var platformsToShow: [Platform] {
        let withSessions = Set(client.sessions.map { $0.platform })
        return Platform.allCases.filter { client.availablePlatforms.contains($0) || withSessions.contains($0) }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 240, ideal: 290)
        } detail: {
            if let selection, client.session(id: selection) != nil {
                MacChatView(sessionId: selection)
                    .id(selection)
            } else {
                detailPlaceholder
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    newSessionPlatform = nil
                    showingNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }
                .disabled(client.availablePlatforms.isEmpty)
            }
        }
        .sheet(isPresented: $showingNewSession) {
            MacNewSessionSheet(initialPlatform: newSessionPlatform)
                .environmentObject(client)
        }
        .navigationTitle(client.serverName.isEmpty ? "AgentDeck" : client.serverName)
        .onChange(of: client.redirects) { _, redirects in
            // Follow takeovers so an open chat keeps pointing at the successor.
            if let sel = selection, let next = redirects[sel] { selection = next }
        }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            if !bridge.state.isRunning, case .failed(let message) = bridge.state {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
            ForEach(platformsToShow) { platform in
                Section {
                    let sessions = client.sessions.filter { $0.platform == platform }
                    if sessions.isEmpty {
                        Text("No sessions")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(sessions) { session in
                        SessionRow(session: session)
                            .tag(session.id)
                            .contextMenu {
                                if let command = session.resumeCommand {
                                    Button("Copy Resume Command") { copyToPasteboard(command) }
                                }
                                Button(session.isAttached ? "Hide from Deck" : "Archive Session", role: .destructive) {
                                    client.archive(sessionId: session.id)
                                    if selection == session.id { selection = nil }
                                }
                            }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Circle().fill(platform.accent).frame(width: 8, height: 8)
                        Text(platform.displayName)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if platformsToShow.isEmpty {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 34)).foregroundStyle(.secondary)
            Text(bridge.state.isRunning ? "No coding agents found" : "Bridge \(bridge.state.label.lowercased())")
                .font(.headline)
            Text(bridge.state.isRunning
                 ? "Install claude, cursor-agent, or codex and restart the bridge."
                 : "Start the bridge from the menu bar icon.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var detailPlaceholder: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40)).foregroundStyle(.tertiary)
            Text("Select a session")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Terminal and IDE sessions appear here live; sessions you start stay in sync with your phone.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: 320)
                .multilineTextAlignment(.center)
        }
    }
}

private struct SessionRow: View {
    @EnvironmentObject var client: BridgeClient
    let session: SessionInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(session.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if session.isAttached { LiveBadge() }
                if session.state.isBusy {
                    Circle().fill(session.state.color).frame(width: 7, height: 7)
                }
            }
            Text(session.lastText ?? (session.cwd as NSString).abbreviatingWithTildeInPath)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
        .onAppear { client.requestHistoryIfNeeded(session.id) }
    }
}
