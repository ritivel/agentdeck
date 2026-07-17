import SwiftUI

struct MenuContent: View {
    @EnvironmentObject var bridge: BridgeManager
    @EnvironmentObject var client: BridgeClient
    @Environment(\.openWindow) private var openWindow
    @State private var showingQR = false
    @State private var approvalsBusy = false
    @State private var approvalsError: String?

    private var statusColor: Color {
        switch bridge.state {
        case .running: return .green
        case .starting: return .yellow
        case .stopped: return .gray
        case .failed: return .red
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text("Bridge \(bridge.state.label.lowercased())")
                    .font(.headline)
                Spacer()
                if bridge.state.isRunning {
                    Button("Stop") { bridge.stop(); client.disconnect() }
                        .controlSize(.small)
                } else {
                    Button("Start") { bridge.start() }
                        .controlSize(.small)
                }
            }

            if case .failed(let message) = bridge.state {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }

            if bridge.state.isRunning {
                sessionSummary
            }

            Divider()

            Button {
                openWindow(id: "deck")
                NSApp.activate(ignoringOtherApps: true)
            } label: {
                Label("Open AgentDeck", systemImage: "rectangle.stack")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                showingQR.toggle()
            } label: {
                Label("Pair your phone…", systemImage: "qrcode")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(!bridge.state.isRunning)

            if showingQR {
                PairingQRView()
                    .padding(.vertical, 4)
            }

            Divider()

            Toggle(isOn: approvalsBinding) {
                Label("Phone approvals", systemImage: "checkmark.shield")
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(!bridge.state.isRunning || approvalsBusy || bridge.hooksInstalled == nil)
            Text("Approve Claude's tool calls from your phone. Ignore a prompt and the terminal asks as usual — nothing about your setup changes.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let approvalsError {
                Text(approvalsError)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            Divider()

            HStack {
                SettingsLink {
                    Label("Settings…", systemImage: "gearshape")
                }
                Spacer()
                Button("Quit AgentDeck") {
                    NSApp.terminate(nil)
                }
            }
            .controlSize(.small)
        }
        .padding(14)
        .frame(width: 300)
        .task(id: bridge.state.isRunning) {
            if bridge.state.isRunning { await bridge.refreshHooksStatus() }
        }
    }

    private var approvalsBinding: Binding<Bool> {
        Binding(
            get: { bridge.hooksInstalled == true },
            set: { enabled in
                approvalsBusy = true
                approvalsError = nil
                Task {
                    approvalsError = await bridge.setHooksEnabled(enabled)
                    approvalsBusy = false
                }
            })
    }

    private var sessionSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Platform.allCases) { platform in
                let count = client.sessions.filter { $0.platform == platform }.count
                let available = client.platforms[platform.rawValue]?.available == true
                if count > 0 || available {
                    HStack(spacing: 6) {
                        Circle().fill(platform.accent).frame(width: 7, height: 7)
                        Text(platform.displayName).font(.callout)
                        Spacer()
                        Text(available || count > 0 ? "\(count) session\(count == 1 ? "" : "s")" : "not installed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}
