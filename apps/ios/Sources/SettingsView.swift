import SwiftUI
struct SettingsView: View {
    let sync: SyncClient?
    let client: CoreClient
    let beforeRestore: () async throws -> Void
    let restored: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var backups: [Backup] = []
    @State private var selected: Backup?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            List {
                if let sync { SyncSettingsView(sync: sync) }
                Section { Button("Back up now") { run { let _: Backup = try await client.call("backup_now", Empty()); try await load() } } }
                Section("Backups") {
                    ForEach(backups) { backup in
                        Button { selected = backup } label: {
                            HStack { Text(Date(timeIntervalSince1970: Double(backup.created_at) / 1000), style: .date); Spacer(); Text("Restore").foregroundStyle(.secondary) }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.disabled(busy).navigationTitle("Settings")
                .toolbar { Button("Done") { dismiss() }.disabled(busy) }
                .task { run { try await load() } }
                .confirmationDialog("Replace current notes with this backup?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
                    Button("Restore backup", role: .destructive) { if let selected { run {
                        try await beforeRestore()
                        try await client.write("restore_backup", BackupArgs(id: selected.id))
                        await restored(); dismiss()
                    } } }
                }
        }.interactiveDismissDisabled(busy)
    }
    func load() async throws { backups = try await client.call("list_backups", Empty()) }
    func run(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true
        Task { defer { busy = false }; do { try await operation() } catch { self.error = String(describing: error) } }
    }
}
