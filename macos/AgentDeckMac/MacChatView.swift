import SwiftUI

struct MacChatView: View {
    @EnvironmentObject var client: BridgeClient
    let sessionId: String

    @State private var draft: String = ""
    @FocusState private var inputFocused: Bool

    private var session: SessionInfo? { client.session(id: sessionId) }
    private var events: [StoredEvent] { client.transcripts[client.resolve(sessionId)] ?? [] }
    private var accent: Color { session?.platform.accent ?? .accentColor }
    private var isReadOnly: Bool { session?.isReadOnly == true }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            if isReadOnly {
                takeoverHint
            }
            inputBar
        }
        .onAppear {
            client.requestHistoryIfNeeded(sessionId)
            NotificationManager.shared.openSessionId = sessionId
        }
        .onDisappear {
            if NotificationManager.shared.openSessionId == sessionId {
                NotificationManager.shared.openSessionId = nil
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session?.title ?? "Session")
                    .font(.headline)
                    .lineLimit(1)
                Text((session?.cwd as NSString?)?.abbreviatingWithTildeInPath ?? "")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if session?.isAttached == true { LiveBadge() }
            if let state = session?.state { StatePill(state: state) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(events) { stored in
                        EventRow(stored: stored, accent: accent)
                            .id(stored.seq)
                    }
                    Color.clear.frame(height: 1).id("BOTTOM")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .onChange(of: events.count) { _, _ in
                proxy.scrollTo("BOTTOM", anchor: .bottom)
            }
            .onAppear {
                proxy.scrollTo("BOTTOM", anchor: .bottom)
            }
        }
    }

    private var takeoverHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right").font(.caption)
            Text("Terminal session — sending a message takes it over in AgentDeck")
                .font(.caption)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.bubbleBackground)
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(isReadOnly ? "Take over & message…" : "Message…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color.bubbleBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .focused($inputFocused)
                .onSubmit { sendPrompt() }

            if session?.state.isBusy == true && !isReadOnly {
                Button {
                    client.interrupt(sessionId: sessionId)
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .help("Interrupt the agent")
            } else {
                Button {
                    sendPrompt()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : accent)
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: [])
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func sendPrompt() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.sendPrompt(sessionId: sessionId, text: text)
        draft = ""
    }
}
