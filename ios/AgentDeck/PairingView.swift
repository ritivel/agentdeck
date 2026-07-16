import SwiftUI

struct PairingView: View {
    @EnvironmentObject var client: BridgeClient
    @StateObject private var discovery = Discovery()

    @State private var host: String = ""
    @State private var port: String = "8787"
    @State private var token: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if discovery.bridges.isEmpty {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(discovery.isBrowsing ? "Searching for bridges…" : "Starting discovery…")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ForEach(discovery.bridges) { bridge in
                            Button {
                                host = bridge.host
                                port = String(bridge.port)
                            } label: {
                                HStack {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading) {
                                        Text(bridge.name).font(.body)
                                        Text("\(bridge.host):\(bridge.port)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: {
                    Text("Discovered on your network")
                }

                Section {
                    LabeledContent("Host") {
                        TextField("192.168.1.10", text: $host)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Port") {
                        TextField("8787", text: $port)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Token") {
                        TextField("paste token", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    Text("The token is shown as a QR code in the bridge terminal. QR scanning is coming soon.")
                }

                Section {
                    Button {
                        connect()
                    } label: {
                        HStack {
                            Spacer()
                            if case .connecting = client.connectionState {
                                ProgressView().controlSize(.small)
                            }
                            Text("Connect").bold()
                            Spacer()
                        }
                    }
                    .disabled(!canConnect)
                }

                if case .failed(let msg) = client.connectionState {
                    Section {
                        Text(msg).foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle("AgentDeck")
            .onAppear {
                discovery.start()
                prefillFromSaved()
            }
            .onDisappear { discovery.stop() }
        }
    }

    private var canConnect: Bool {
        !host.isEmpty && Int(port) != nil && !token.isEmpty
    }

    private func prefillFromSaved() {
        if let t = client.target {
            if host.isEmpty { host = t.host }
            port = String(t.port)
            if token.isEmpty { token = t.token }
        }
    }

    private func connect() {
        guard let p = Int(port) else { return }
        client.connect(host: host, port: p, token: token)
    }
}
