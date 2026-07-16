import SwiftUI
import ServiceManagement

struct MacSettingsView: View {
    @EnvironmentObject var bridge: BridgeManager
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var portText = ""
    @State private var loginItemError: String?

    var body: some View {
        Form {
            Section {
                Toggle("Launch AgentDeck at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in
                        setLaunchAtLogin(enabled)
                    }
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.red)
                }
            }

            Section {
                HStack {
                    TextField("Bridge port", text: $portText)
                        .frame(width: 90)
                    Button("Apply & Restart Bridge") {
                        if let p = Int(portText), (1024...65535).contains(p) {
                            bridge.port = p
                            bridge.restart()
                        }
                    }
                    .disabled(Int(portText) == nil)
                }
                Text("Phones pair against this port. Default is 8787.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                LabeledContent("Bridge log") {
                    Button("Open in Console") {
                        let url = FileManager.default.homeDirectoryForCurrentUser
                            .appendingPathComponent("Library/Logs/AgentDeck/bridge.log")
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .onAppear { portText = String(bridge.port) }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginItemError = nil
        } catch {
            loginItemError = error.localizedDescription
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}
