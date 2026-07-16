import SwiftUI

struct ChatView: View {
    @EnvironmentObject var client: BridgeClient
    let sessionId: String

    @State private var draft: String = ""
    @FocusState private var inputFocused: Bool

    private var session: SessionInfo? { client.session(id: sessionId) }
    private var events: [StoredEvent] { client.transcripts[sessionId] ?? [] }
    private var accent: Color { session?.platform.accent ?? .accentColor }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider()
            inputBar
        }
        .navigationTitle(session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let state = session?.state {
                    StatePill(state: state)
                }
            }
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

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let cwd = session?.cwd {
                        Text(cwd)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 8)
                    }
                    ForEach(events) { stored in
                        EventRow(stored: stored, accent: accent)
                            .id(stored.seq)
                    }
                    Color.clear.frame(height: 1).id("BOTTOM")
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            .onChange(of: events.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("BOTTOM", anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo("BOTTOM", anchor: .bottom)
            }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .focused($inputFocused)

            if session?.state.isBusy == true {
                Button {
                    client.interrupt(sessionId: sessionId)
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.red)
                }
            } else {
                Button {
                    sendPrompt()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : accent)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func sendPrompt() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.sendPrompt(sessionId: sessionId, text: text)
        draft = ""
        inputFocused = false
    }
}

// MARK: - State pill

struct StatePill: View {
    let state: SessionState
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(state.color).frame(width: 7, height: 7)
            Text(state.label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(state.color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(state.color.opacity(0.15))
        .clipShape(Capsule())
    }
}

// MARK: - Event rendering

struct EventRow: View {
    let stored: StoredEvent
    let accent: Color

    var body: some View {
        switch stored.event {
        case .user(let text):
            userBubble(text)
        case .text(let text):
            assistantBubble(text)
        case .thinking(let text):
            thinkingRow(text)
        case .toolStart(_, let name, let input):
            toolStartRow(name: name, input: input)
        case .toolEnd(_, let output, let isError):
            toolEndRow(output: output, isError: isError)
        case .turnEnd(_, let isError, let cost, let dur):
            turnEndRow(isError: isError, cost: cost, dur: dur)
        case .permissionDenied(let name, let detail):
            noticeRow(icon: "hand.raised.fill",
                      color: .orange,
                      text: "Permission denied: \(name)" + (detail.map { " — \($0)" } ?? ""))
        case .error(let message):
            noticeRow(icon: "exclamationmark.triangle.fill", color: .red, text: message)
        case .status(let state):
            statusRow(state)
        case .unknown(let kind):
            noticeRow(icon: "questionmark.circle", color: .secondary, text: "Unsupported event: \(kind)")
        }
    }

    private func userBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            Text(text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(accent.opacity(0.9))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    private func assistantBubble(_ text: String) -> some View {
        HStack {
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 40)
        }
    }

    private func thinkingRow(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.footnote.italic())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
            Spacer(minLength: 40)
        }
    }

    private func toolStartRow(name: String, input: JSONValue?) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "wrench.and.screwdriver.fill")
                .font(.caption2).foregroundStyle(accent).padding(.top, 2)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.caption.monospaced().bold())
                if let input {
                    Text(truncate(input.compact, 200))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func toolEndRow(output: String?, isError: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(isError ? .red : .green)
                .padding(.top, 2)
            Text(truncate(output ?? (isError ? "error" : "done"), 300))
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func turnEndRow(isError: Bool, cost: Double?, dur: Double?) -> some View {
        var parts: [String] = []
        if let cost { parts.append(String(format: "$%.4f", cost)) }
        if let dur { parts.append(String(format: "%.1fs", dur / 1000)) }
        let detail = parts.joined(separator: " · ")
        return HStack(spacing: 8) {
            VStack { Divider() }
            Text(isError ? "turn failed" : (detail.isEmpty ? "turn ended" : detail))
                .font(.caption2)
                .foregroundStyle(isError ? .red : .secondary)
                .fixedSize()
            VStack { Divider() }
        }
        .padding(.vertical, 2)
    }

    private func statusRow(_ state: SessionState) -> some View {
        HStack {
            Spacer()
            Text("status: \(state.label.lowercased())")
                .font(.caption2)
                .foregroundStyle(state.color)
            Spacer()
        }
        .padding(.vertical, 1)
    }

    private func noticeRow(icon: String, color: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: icon).font(.caption).foregroundStyle(color).padding(.top, 1)
            Text(text).font(.caption).foregroundStyle(color)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func truncate(_ s: String, _ n: Int) -> String {
        let flat = s.replacingOccurrences(of: "\n", with: " ")
        if flat.count <= n { return flat }
        return String(flat.prefix(n)) + "…"
    }
}
