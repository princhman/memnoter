import XCTest
import Security
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

final class SyncStorageTests: XCTestCase {
    func testKeychainSurvivesNewStoreAndDeletesOnlyItsAccount() throws {
        let store = SyncKeychain(service: "memnoter.tests.\(UUID().uuidString)")
        defer { try? store.delete() }
        XCTAssertNil(try store.load())
        let account = SyncAccount(server: "https://example.com", email: "a@example.com", userId: "a", token: "secret", key: [UInt8](repeating: 17, count: 32))
        try store.save(account)
        var attributes: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: store.service, kSecReturnAttributes as String: true]
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &attributes), errSecSuccess)
        XCTAssertEqual((attributes as? [String: Any])?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(try SyncKeychain(service: store.service).load()?.token, "secret")
        let renewed = SyncAccount(server: account.server, email: account.email, userId: account.userId, token: "renewed", key: account.key)
        try store.save(renewed)
        XCTAssertEqual(try store.load()?.token, "renewed")
        XCTAssertEqual(try store.load()?.key, account.key)
        try store.delete()
        XCTAssertNil(try store.load())
    }
}

private final class AuthServer: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let verified = request.url?.path == "/v1/auth/verify"
        let authorized = request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token"
        let status = verified || authorized ? 200 : 401
        let body = verified ? #"{"token":"test-token","userId":"user","email":"a@example.com"}"# : authorized ? #"{"key":null}"# : #"{"error":"Expired session"}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class SyncTransportTests: XCTestCase {
    @MainActor func testSignInCarriesBearerTokenAndSurfacesServerFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = try await CoreClient.open(directory)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AuthServer.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let sync = SyncClient(core: core, session: session)
        let (token, user, isNew) = try await sync.signIn(server: "https://mock.local", email: "a@example.com", code: "123456")
        XCTAssertEqual(token, "test-token"); XCTAssertEqual(user, "user"); XCTAssertTrue(isNew)
        do { _ = try await sync.api("https://mock.local", "/v1/key", token: "expired"); XCTFail("401 must reject") }
        catch { XCTAssertEqual(error.localizedDescription, "Expired session") }
    }
}

final class NativeSyncEndToEndTests: XCTestCase {
    /// Run with scripts/sync-dev.sh's Worker on localhost:8787. No real account/data is used.
    @MainActor func testTwoNativeDatabasesMergeConcurrentYjsEdits() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        do { _ = try await session.data(from: URL(string: "http://localhost:8787")!) }
        catch { throw XCTSkip("Start the local sync Worker on port 8787 for native E2E") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let a = try await CoreClient.open(root.appendingPathComponent("a"))
        let b = try await CoreClient.open(root.appendingPathComponent("b"))
        let ka = SyncKeychain(service: "sync.e2e.a.\(UUID().uuidString)")
        let kb = SyncKeychain(service: "sync.e2e.b.\(UUID().uuidString)")
        defer { try? ka.delete(); try? kb.delete() }
        let sa = SyncClient(core: a, session: session, keychain: ka)
        let sb = SyncClient(core: b, session: session, keychain: kb)
        defer { sa.stop(); sb.stop() }
        let email = "native-\(UUID().uuidString)@example.com"
        let server = "http://localhost:8787"
        let start = try await sa.api(server, "/v1/auth/start", method: "POST", body: ["email": email])
        let code = try XCTUnwrap(start["devCode"] as? String)
        let (token, user, _) = try await sa.signIn(server: server, email: email, code: code)
        try await sa.unlock(server: server, email: email, token: token, user: user, passphrase: "native sync test passphrase")
        try await sb.unlock(server: server, email: email, token: token, user: user, passphrase: "native sync test passphrase")
        let module: String = try await a.call("create_module", NameArgs(name: "Native E2E"))
        sa.nudge()
        try await eventually {
            let modules: [NoteModule] = try await b.call("modules", Empty())
            return modules.contains { $0.id == module }
        }
        sa.pause(); sb.pause()
        // Independently generated Yjs clients 1 and 2 insert into the same text.
        let ua: [UInt8] = [1,1,1,0,4,1,4,116,101,120,116,5,97,108,112,104,97,0]
        let ub: [UInt8] = [1,1,2,0,4,1,4,116,101,120,116,4,98,101,116,97,0]
        _ = try await sa.command("add_update", ["moduleId": module, "bytes": ua])
        _ = try await sb.command("add_update", ["moduleId": module, "bytes": ub])
        sa.resume(); sb.resume()
        try await eventually {
            let xa = try await sa.command("sync_snapshot", ["doc": module]) as? [UInt8]
            let xb = try await sb.command("sync_snapshot", ["doc": module]) as? [UInt8]
            let expected: [UInt8] = [2,1,2,0,4,1,4,116,101,120,116,4,98,101,116,97,1,1,0,4,1,4,116,101,120,116,5,97,108,112,104,97,0]
            return xa == expected && xb == expected && sa.pending == 0 && sb.pending == 0
        }
        try await sa.signOut()
        let modules: [NoteModule] = try await a.call("modules", Empty())
        XCTAssertTrue(modules.contains { $0.id == module }, "Signing out retains local notes")
        XCTAssertNil(try ka.load())
    }
    @MainActor private func eventually(_ predicate: () async throws -> Bool) async throws {
        for _ in 0..<100 {
            if try await predicate() { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTFail("Native clients did not converge within 20 seconds")
    }
}
