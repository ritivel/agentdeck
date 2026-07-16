import SwiftUI

struct DeckView: View {
    @EnvironmentObject var client: BridgeClient

    @State private var navPath: [String] = []          // session ids being viewed
    @State private var newSessionPlatform: Platform?
    @State private var showingNewSession = false

    /// Platforms to display: available ones plus any that currently have sessions.
    private var platformsToShow: [Platform] {
        let withSessions = Set(client.sessions.map { $0.platform })
        return Platform.allCases.filter { client.availablePlatforms.contains($0) || withSessions.contains($0) }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if platformsToShow.isEmpty {
                    emptyState
                } else {
                    verticalPager
                }
            }
            .navigationTitle(client.serverName.isEmpty ? "AgentDeck" : client.serverName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionBadge(state: client.connectionState)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            newSessionPlatform = nil
                            showingNewSession = true
                        } label: { Label("New Session", systemImage: "plus") }
                        Button(role: .destructive) {
                            client.disconnect()
                        } label: { Label("Disconnect", systemImage: "wifi.slash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .navigationDestination(for: String.self) { sessionId in
                ChatView(sessionId: sessionId)
            }
            .sheet(isPresented: $showingNewSession) {
                NewSessionView(initialPlatform: newSessionPlatform)
            }
        }
    }

    private var verticalPager: some View {
        GeometryReader { geo in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(platformsToShow) { platform in
                        PlatformPage(
                            platform: platform,
                            sessions: sessions(for: platform),
                            onOpen: { navPath.append($0) },
                            onCreate: {
                                newSessionPlatform = platform
                                showingNewSession = true
                            }
                        )
                        .frame(width: geo.size.width, height: geo.size.height)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 44)).foregroundStyle(.secondary)
            Text("No platforms available")
                .font(.headline)
            Text("The bridge reports no installed coding agents.")
                .font(.footnote).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func sessions(for platform: Platform) -> [SessionInfo] {
        client.sessions.filter { $0.platform == platform }
    }
}

// MARK: - Connection badge

struct ConnectionBadge: View {
    let state: ConnectionState
    private var color: Color {
        switch state {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .gray
        case .failed: return .red
        }
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 8, height: 8)
        }
    }
}

// MARK: - Platform page (horizontal session pager)

struct PlatformPage: View {
    let platform: Platform
    let sessions: [SessionInfo]
    let onOpen: (String) -> Void
    let onCreate: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(platform.accent).frame(width: 10, height: 10)
                Text(platform.displayName)
                    .font(.title3.bold())
                Spacer()
                Text("\(sessions.count) session\(sessions.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)

            TabView {
                ForEach(sessions) { session in
                    SessionCard(session: session, onOpen: { onOpen(session.id) })
                        .padding(.horizontal, 16)
                        .padding(.bottom, 30)
                }
                CreateSessionCard(platform: platform, onCreate: onCreate)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 30)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
        }
    }
}

// MARK: - Session card (compact live preview)

struct SessionCard: View {
    @EnvironmentObject var client: BridgeClient
    let session: SessionInfo
    let onOpen: () -> Void

    private var recentEvents: [StoredEvent] {
        let all = client.transcripts[session.id] ?? []
        return Array(all.suffix(6))
    }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title)
                            .font(.headline)
                            .lineLimit(1)
                        Text(session.cwd)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if session.isAttached {
                        LiveBadge()
                    }
                    StatePill(state: session.state)
                }

                Divider()

                if recentEvents.isEmpty {
                    VStack(spacing: 6) {
                        Spacer()
                        Text(session.lastText ?? "No activity yet")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(recentEvents) { stored in
                                EventRow(stored: stored, accent: session.platform.accent)
                            }
                        }
                    }
                    .scrollDisabled(true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }

                Spacer(minLength: 0)

                HStack {
                    Spacer()
                    Text("Tap to open")
                        .font(.caption).foregroundStyle(.tertiary)
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(session.platform.accent.opacity(0.4), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onAppear { client.requestHistoryIfNeeded(session.id) }
    }
}

// MARK: - Create session card

struct CreateSessionCard: View {
    let platform: Platform
    let onCreate: () -> Void

    var body: some View {
        Button(action: onCreate) {
            VStack(spacing: 14) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(platform.accent)
                Text("New \(platform.displayName) session")
                    .font(.headline)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [8]))
                    .foregroundStyle(platform.accent.opacity(0.5))
            )
        }
        .buttonStyle(.plain)
    }
}
