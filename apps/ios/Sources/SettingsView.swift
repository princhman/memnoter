import SwiftUI
struct SettingsView: View {
    let sync: SyncClient?
    let client: CoreClient
    let modules: [NoteModule]
    let setChapterNumbering: (String, Bool) async throws -> Void
    let beforeRestore: () async throws -> Void
    let restored: () async -> Void
    @AppStorage("skipCardsCreatedToday") private var skipCardsCreatedToday = false
    @Environment(\.dismiss) private var dismiss
    @State private var backups: [Backup] = []
    @State private var selected: Backup?
    @State private var error: String?
    @State private var busy = false
    /// "Memnoter 0.1.2, build 2710db3"; the stamp is written by scripts/build-ios-web.sh.
    private static let versionLine: String = {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let stamp = Bundle.main.url(forResource: "build-stamp", withExtension: "txt", subdirectory: "Web")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ["Memnoter \(version)", stamp.map { "build \($0)" }].compactMap { $0 }.joined(separator: ", ")
    }()
    var body: some View {
        NavigationStack {
            List {
                Section("Review") {
                    Toggle("Skip cards added to this device today", isOn: $skipCardsCreatedToday)
                    Text("Unreviewed cards first indexed on this device today become available after local midnight, including cards from older synced notes.").font(.caption).foregroundStyle(.secondary)
                }
                if let sync { SyncSettingsView(sync: sync) }
                Section {
                    if modules.isEmpty {
                        Text("No modules yet.").foregroundStyle(.secondary)
                    } else {
                        ForEach(modules) { module in
                            Toggle(module.name, isOn: Binding(
                                get: { module.heading_numbering },
                                set: { enabled in run { try await setChapterNumbering(module.id, enabled) } }
                            ))
                        }
                    }
                } header: {
                    Text("Chapter numbering")
                } footer: {
                    Text("Number headings (1, 1.1, 2 …) in a module's notes and outline. The numbers are only shown on screen and never added to the note text.")
                }
                Section { Button("Back up now") { run { let _: Backup = try await client.call("backup_now", Empty()); try await load() } } }
                Section("Backups") {
                    ForEach(backups) { backup in
                        Button { selected = backup } label: {
                            HStack { Text(Date(timeIntervalSince1970: Double(backup.created_at) / 1000), style: .date); Spacer(); Text("Restore").foregroundStyle(.secondary) }
                        }
                    }
                }
                Section("About") { Text(Self.versionLine).foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(.red) }
            }.disabled(busy).navigationTitle("Settings")
                .toolbar { Button("Done") { dismiss() }.disabled(busy) }
                .task { run { try await load() } }
                .confirmationDialog("Replace current notes with this backup?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
                    Button("Restore backup", role: .destructive) { if let selected { run {
                        sync?.pause()
                        defer { sync?.resume() }
                        try await beforeRestore()
                        try await client.write("restore_backup", BackupArgs(id: selected.id))
                        await restored(); dismiss()
                    } } }
                }
        }.interactiveDismissDisabled(busy)
            .alert("Memnoter", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") { error = nil }
            } message: { Text(error ?? "") }
    }
    func load() async throws { backups = try await client.call("list_backups", Empty()) }
    func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await operation() } catch { self.error = String(describing: error) } }
    }
}
