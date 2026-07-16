import SwiftUI

struct NewSessionView: View {
    @EnvironmentObject var client: BridgeClient
    @Environment(\.dismiss) private var dismiss

    /// Optional platform to preselect (e.g. when created from a platform page).
    var initialPlatform: Platform?

    @State private var platform: Platform = .claude
    @State private var cwd: String = ""
    @State private var permissionMode: PermissionMode = .acceptEdits
    @State private var firstPrompt: String = ""

    private let defaults = UserDefaults.standard
    private let defaultCwdFallback = "/Users/tpavankalyan"

    var body: some View {
        NavigationStack {
            Form {
                Section("Platform") {
                    Picker("Platform", selection: $platform) {
                        ForEach(client.availablePlatforms) { p in
                            Text(p.displayName).tag(p)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: platform) { _, newValue in
                        cwd = savedCwd(for: newValue)
                    }
                }

                Section("Working directory") {
                    TextField("/Users/me/project", text: $cwd)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout.monospaced())
                    if !client.suggestedDirs.isEmpty {
                        Menu {
                            ForEach(client.suggestedDirs, id: \.self) { dir in
                                Button(dir) { cwd = dir }
                            }
                        } label: {
                            Label("Choose a project…", systemImage: "folder")
                                .font(.callout)
                        }
                    }
                }

                Section("Permission mode") {
                    Picker("Permission mode", selection: $permissionMode) {
                        ForEach(PermissionMode.allCases) { m in
                            Text(m.displayName).tag(m)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Section("First prompt (optional)") {
                    TextField("What should the agent do?", text: $firstPrompt, axis: .vertical)
                        .lineLimit(2...6)
                }

                Section {
                    Button {
                        create()
                    } label: {
                        HStack {
                            Spacer()
                            Text("Create Session").bold()
                            Spacer()
                        }
                    }
                    .disabled(cwd.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onAppear {
                let available = client.availablePlatforms
                if let initialPlatform, available.contains(initialPlatform) {
                    platform = initialPlatform
                } else if let first = available.first {
                    platform = first
                }
                cwd = savedCwd(for: platform)
            }
        }
    }

    private func savedCwd(for p: Platform) -> String {
        defaults.string(forKey: cwdKey(p)) ?? defaultCwdFallback
    }

    private func cwdKey(_ p: Platform) -> String {
        "agentdeck.cwd.\(p.rawValue)"
    }

    private func create() {
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        defaults.set(dir, forKey: cwdKey(platform))
        client.createSession(
            platform: platform,
            cwd: dir,
            permissionMode: permissionMode,
            title: nil,
            model: nil,
            prompt: firstPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        dismiss()
    }
}
