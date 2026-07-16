import SwiftUI

struct MacNewSessionSheet: View {
    @EnvironmentObject var client: BridgeClient
    @Environment(\.dismiss) private var dismiss

    var initialPlatform: Platform?

    @State private var platform: Platform = .claude
    @State private var cwd: String = ""
    @State private var permissionMode: PermissionMode = .acceptEdits
    @State private var firstPrompt: String = ""

    private let defaults = UserDefaults.standard

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New Session")
                .font(.title3.bold())

            Picker("Platform", selection: $platform) {
                ForEach(client.availablePlatforms) { p in
                    Text(p.displayName).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: platform) { _, newValue in
                cwd = savedCwd(for: newValue)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Working directory").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    TextField("/Users/me/project", text: $cwd)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout.monospaced())
                    Button("Browse…") { browse() }
                    if !client.suggestedDirs.isEmpty {
                        Menu {
                            ForEach(client.suggestedDirs, id: \.self) { dir in
                                Button(dir) { cwd = dir }
                            }
                        } label: {
                            Image(systemName: "folder")
                        }
                        .menuStyle(.borderlessButton)
                        .frame(width: 32)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Permission mode").font(.caption).foregroundStyle(.secondary)
                Picker("Permission mode", selection: $permissionMode) {
                    ForEach(PermissionMode.allCases) { m in
                        Text(m.displayName).tag(m)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("First prompt (optional)").font(.caption).foregroundStyle(.secondary)
                TextField("What should the agent do?", text: $firstPrompt, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...5)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create Session") { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(cwd.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
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

    private func browse() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if !cwd.isEmpty { panel.directoryURL = URL(fileURLWithPath: cwd) }
        if panel.runModal() == .OK, let url = panel.url {
            cwd = url.path
        }
    }

    private func savedCwd(for p: Platform) -> String {
        defaults.string(forKey: cwdKey(p))
            ?? FileManager.default.homeDirectoryForCurrentUser.path
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
