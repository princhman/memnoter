import XCTest
@testable import Memnoter
final class CoreClientTests: XCTestCase {
    func testSwiftJSONAcrossRealFFI() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let moduleId: String = try await client.call("create_module", NameArgs(name: "日本語 \"Study\""))
        try await client.write("rename_module", RenameArgs(moduleId: moduleId, name: "Renamed"))
        try await client.write("set_module_numbering", NumberingArgs(moduleId: moduleId, enabled: false))
        let file: SavedFile = try await client.call("save_file", FileArgs(moduleId: moduleId, bytes: [0, 128, 255], mimeType: "image/png"))
        XCTAssertFalse(file.id.isEmpty)
        let reopened = try await CoreClient.open(directory)
        let modules: [NoteModule] = try await reopened.call("modules", Empty())
        XCTAssertEqual(modules.first?.name, "Renamed")
        XCTAssertEqual(modules.first?.heading_numbering, false)
        do { _ = try await client.raw("missing"); XCTFail("Unknown commands must reject") }
        catch { XCTAssertTrue(String(describing: error).contains("Unknown command")) }
    }
}
