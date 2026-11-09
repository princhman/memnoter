import XCTest
@testable import Memnoter

final class SidebarLayoutTests: XCTestCase {
    private let modules = ["a", "b", "c"].map { NoteModule(id: $0, name: $0.uppercased(), heading_numbering: false) }
    private func folder(_ id: String, _ order: Int64, collapsed: Bool = false, deleted: Bool = false) -> SidebarItem {
        SidebarItem(id: id, name: id, folder_id: nil, sort_order: order, collapsed: collapsed, deleted: deleted)
    }
    private func note(_ id: String, _ order: Int64, in folder: String? = nil) -> SidebarItem {
        SidebarItem(id: id, name: nil, folder_id: folder, sort_order: order, collapsed: false, deleted: false)
    }
    private func layout(_ items: [SidebarItem]) -> [String] {
        SidebarLayout.rows(items: items, modules: modules).map(\.id)
    }

    @MainActor func testCreatingFolderPersistsUnsavedModulePositions() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let store = AppStore()
        store.client = client
        for name in ["A", "B", "C"] {
            let _: String = try await client.call("create_module", NameArgs(name: name))
        }
        await store.refresh()
        let before = store.sidebarItems.map(\.id)
        let order = (store.sidebarItems.map(\.sort_order).max() ?? -1) + 1
        await store.saveSidebar([folder("new", order)])
        await store.refresh()
        XCTAssertEqual(store.sidebarItems.map(\.id), before + ["new"])
    }

    func testFoldersFromAnotherDeviceGroupModulesAndDeletedFoldersReleaseThem() {
        let saved = [folder("f", 0), note("b", 0, in: "f"), note("a", 1), folder("gone", 2, deleted: true), note("c", 3, in: "gone")]
        let items = SidebarLayout.items(modules: modules, saved: saved)
        XCTAssertEqual(layout(items), ["f", "b", "a", "c"])
        XCTAssertNil(items.first { $0.id == "c" }?.folder_id)
        XCTAssertEqual(layout(items.map { $0.id == "f" ? folder("f", 0, collapsed: true) : $0 }), ["f", "a", "c"])
    }

    func testDraggingAModuleUnderAFolderMovesItInAndAboveMovesItOut() {
        let items = SidebarLayout.items(modules: modules, saved: [folder("f", 0), note("a", 0, in: "f"), note("b", 1), note("c", 2)])
        let rows = SidebarLayout.rows(items: items, modules: modules)
        XCTAssertEqual(rows.map(\.id), ["f", "a", "b", "c"])

        let into = SidebarLayout.move(items: items, rows: rows, from: [3], to: 2)
        XCTAssertEqual(layout(into), ["f", "a", "c", "b"])
        XCTAssertEqual(into.first { $0.id == "c" }?.folder_id, "f")

        let out = SidebarLayout.move(items: items, rows: rows, from: [1], to: 0)
        XCTAssertEqual(layout(out), ["a", "f", "b", "c"])
        XCTAssertNil(out.first { $0.id == "a" }?.folder_id)
        XCTAssertEqual(SidebarLayout.changed(out, from: items).map(\.id).sorted(), ["a", "b", "c", "f"])
    }

    func testMovingAFolderKeepsItsModulesAndMoveToMenuAppends() {
        let items = SidebarLayout.items(modules: modules, saved: [note("a", 0), folder("f", 1), note("b", 0, in: "f"), note("c", 2)])
        let rows = SidebarLayout.rows(items: items, modules: modules)
        let moved = SidebarLayout.move(items: items, rows: rows, from: [1], to: 0)
        XCTAssertEqual(layout(moved), ["f", "b", "a", "c"])

        let menu = SidebarLayout.move(items: items, module: "c", into: "f")
        XCTAssertEqual(layout(menu), ["a", "f", "b", "c"])
        XCTAssertEqual(SidebarLayout.changed(menu, from: items).map(\.id), ["c"])
    }
}
