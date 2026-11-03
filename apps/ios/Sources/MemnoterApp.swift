import SwiftUI

@main struct MemnoterApp: App {
    @State private var store = AppStore()
    var body: some Scene {
        WindowGroup { RootView(store: store).task { await store.start() } }
    }
}

@MainActor @Observable final class AppStore {
    var client: CoreClient?
    var modules: [NoteModule] = []
    var counts: [DueCount] = []
    private var recentModuleIds = UserDefaults.standard.stringArray(forKey: "recentModuleIds") ?? []
    var recentModules: [NoteModule] {
        let byId = Dictionary(uniqueKeysWithValues: modules.map { ($0.id, $0) })
        let recent = recentModuleIds.compactMap { byId[$0] }
        let remaining = modules.filter { !recentModuleIds.contains($0.id) }
        return Array((recent + remaining).prefix(5))
    }
    func recordOpenedModule(_ id: String) {
        recentModuleIds = [id] + recentModuleIds.filter { $0 != id }.prefix(4)
        UserDefaults.standard.set(recentModuleIds, forKey: "recentModuleIds")
    }
    var error: String?
    var directory = URL.applicationSupportDirectory.appendingPathComponent("Memnoter", isDirectory: true)
    func start() async {
        guard client == nil else { return }
        do { client = try await CoreClient.open(directory); await refresh(); try await client?.dailyBackup() }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async {
        guard let client else { return }
        do {
            modules = try await client.call("modules", Empty())
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let end = Int64(Calendar.current.startOfDay(for: Date()).addingTimeInterval(86400).timeIntervalSince1970 * 1000)
            counts = try await client.call("due_counts", CountArgs(now: now, dayEnd: end))
        } catch { self.error = String(describing: error) }
    }
    func perform(_ body: () async throws -> Void) async {
        do { try await body(); await refresh() } catch { self.error = String(describing: error) }
    }
}
