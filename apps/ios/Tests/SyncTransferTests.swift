import XCTest
import MemnoterCore
@testable import Memnoter

private final class SlowTransferServer: URLProtocol, @unchecked Sendable {
    private var response: Task<Void, Never>?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        response = Task {
            do { try await Task.sleep(for: .milliseconds(1600)) } catch { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data([42]))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { response?.cancel() }
}

final class SyncTransferTests: XCTestCase {
    @MainActor func testRepeatedWakesFinishSlowTransfersAndSerializeFollowUpPass() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SlowTransferServer.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let started = expectation(description: "First transfer started")
        let completed = expectation(description: "Both passes completed")
        completed.expectedFulfillmentCount = 2
        var active = 0
        var maximum = 0
        var passes = 0
        var failures = 0
        let worker = SyncTransferWorker(pass: {
            passes += 1; active += 1; maximum = max(maximum, active)
            defer { active -= 1 }
            if passes == 1 { started.fulfill() }
            let (data, _) = try await session.data(from: URL(string: "https://mock.local/slow")!)
            XCTAssertEqual(data, Data([42]))
            completed.fulfill()
        }, onError: { _ in failures += 1 })
        defer { worker.cancel() }
        worker.nudge()
        await fulfillment(of: [started], timeout: 3)
        for _ in 0..<3 {
            try await Task.sleep(for: .milliseconds(450))
            worker.nudge()
        }
        await fulfillment(of: [completed], timeout: 6)
        XCTAssertEqual(passes, 2, "Wakes during a transfer coalesce into one more pass")
        XCTAssertEqual(maximum, 1, "Transfers must never overlap")
        XCTAssertEqual(failures, 0, "Wakes must not cancel the active response")
    }
}

final class SyncFileTransferTests: XCTestCase {
    @MainActor func testUnavailableImageDoesNotBlockAvailableImageAndBacksOff() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = try await CoreClient.open(directory)
        let module: String = try await core.call("create_module", NameArgs(name: "Images"))
        let account = SyncAccount(server: "https://mock.local", email: "a@example.com", userId: "a", token: "token", key: Array(repeating: 17, count: 32))
        let missing = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        let available = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        let payload = Data([137, 80, 78, 71])
        var requests: [String] = []
        var stored: [String] = []
        let files = SyncFileTransfers(command: { name, args in
            if name == "sync_pending_uploads" { return [String]() }
            if name == "sync_missing_files" {
                return [missing, available].filter { !stored.contains($0) }.map {
                    ["fileId": $0, "moduleId": module, "fileType": "png"]
                }
            }
            let json = String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)
            return try JSONSerialization.jsonObject(with: Data(try await core.raw(name, json: json).utf8))
        }, object: { id, account, _ in
            requests.append(id)
            if id == missing { throw SyncHTTPFailure(status: 404, message: "Not uploaded yet") }
            return try syncCrypt(key: Data(account.key), doc: "file:" + id, bytes: payload, decrypt: false)
        }, isCurrent: { _ in true }, onFile: { _, json in
            let file = try JSONDecoder().decode(SavedFile.self, from: Data(json.utf8))
            stored.append(file.id)
        }, onError: { XCTFail("404 should remain pending: \($0)") })
        let owner = UUID()
        try await files.run(account: account, owner: owner)
        XCTAssertEqual(stored, [available])
        let result = try await core.raw("read_file", json: "{\"moduleId\":\"\(module)\",\"fileId\":\"\(available)\"}")
        let contents = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any]
        XCTAssertEqual(contents?["bytes"] as? [UInt8], Array(payload))
        try await files.run(account: account, owner: owner)
        XCTAssertEqual(requests, [missing, available], "Pending image retries must respect backoff")
    }
}
