import SwiftUI

@main struct MemnoterApp: App {
    @State private var store = AppStore()
    var body: some Scene {
        WindowGroup { RootView(store: store).defaultAppStorage(store.preferences).onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { _ in
            Task { await store.refresh() }
        }.onReceive(NotificationCenter.default.publisher(for: .coreDidWrite)) { _ in
            Task { await store.refresh() }
        }.task {
            await store.start()
            while !Task.isCancelled {
                let midnight = Calendar.current.startOfDay(for: Date()).addingTimeInterval(24 * 60 * 60)
                let nextDay = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date())) ?? midnight
                do { try await Task.sleep(for: .seconds(max(0, nextDay.timeIntervalSinceNow))) } catch { return }
                await store.refresh()
            }
        } }
    }
}

@MainActor @Observable final class AppStore {
    var client: CoreClient?
    var sync: SyncClient?
    var modules: [NoteModule] = []
    var savedSidebar: [SidebarItem] = []
    var sidebarItems: [SidebarItem] { SidebarLayout.items(modules: modules, saved: savedSidebar) }
    var counts: [DueCount] = []
    let preferences: UserDefaults
    private let uiTesting: Bool
    private var recentModuleIds: [String]
    init() {
        var testID: String?
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ui-testing-data-id"),
           arguments.indices.contains(index + 1), let id = UUID(uuidString: arguments[index + 1]) {
            testID = id.uuidString
        }
        #endif
        uiTesting = testID != nil
        if let testID {
            directory = URL.applicationSupportDirectory.appendingPathComponent("MemnoterUITests/\(testID)", isDirectory: true)
            preferences = UserDefaults(suiteName: "com.memnoter.uitests.\(testID)")!
        } else { preferences = .standard }
        recentModuleIds = preferences.stringArray(forKey: "recentModuleIds") ?? []
    }
    var recentModules: [NoteModule] {
        let byId = Dictionary(uniqueKeysWithValues: modules.map { ($0.id, $0) })
        let recent = recentModuleIds.compactMap { byId[$0] }
        let remaining = modules.filter { !recentModuleIds.contains($0.id) }
        return Array((recent + remaining).prefix(5))
    }
    func recordOpenedModule(_ id: String) {
        recentModuleIds = [id] + recentModuleIds.filter { $0 != id }.prefix(4)
        preferences.set(recentModuleIds, forKey: "recentModuleIds")
    }
    var error: String?
    var directory = URL.applicationSupportDirectory.appendingPathComponent("Memnoter", isDirectory: true)
    func start() async {
        guard client == nil else { return }
        do { client = try await CoreClient.open(directory); await refresh()
            if let client {
                let sync = SyncClient(core: client)
                self.sync = sync
                // Keep the coordinator available to the normal view lifecycle,
                // but never load a real Keychain account during an isolated UI test.
                if !uiTesting { await sync.start() }
            }
            try await client?.dailyBackup() }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async {
        guard let client else { return }
        do {
            modules = try await client.call("modules", Empty())
            savedSidebar = try await client.call("sidebar_items", Empty())
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let end = Int64(Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date()))!.timeIntervalSince1970 * 1000)
            counts = try await client.call("due_counts", CountArgs(now: now, dayEnd: end, createdAtCutoff: preferences.bool(forKey: "skipCardsCreatedToday") ? Int64(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000) : nil))
        } catch { self.error = String(describing: error) }
    }
    /// Saves the rows that differ from the stored layout, showing them at once
    /// and restoring the previous layout if the write fails.
    func saveSidebar(_ next: [SidebarItem]) async {
        // Freeze computed module positions before a new row can shift their fallback order.
        let items = sidebarItems.filter { item in !next.contains { $0.id == item.id } } + next
        let changed = SidebarLayout.changed(items, from: savedSidebar)
        guard let client, !changed.isEmpty else { return }
        let previous = savedSidebar
        savedSidebar = previous.filter { item in !changed.contains { $0.id == item.id } } + changed
        do { try await client.write("save_sidebar_items", SidebarItemsArgs(items: changed)) }
        catch { savedSidebar = previous; self.error = String(describing: error) }
    }
    func perform(_ body: () async throws -> Void) async {
        do { try await body(); await refresh() } catch { self.error = String(describing: error) }
    }
}
