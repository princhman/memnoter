import XCTest
import MemnoterCore
@testable import Memnoter

final class SyncTransferTests: XCTestCase {
    @MainActor func testRepeatedWakesFinishSlowTransfersAndSerializeFollowUpPass() async throws {
        let started = expectation(description: "First transfer started")
        let completed = expectation(description: "Both passes completed")
        completed.expectedFulfillmentCount = 2
        var active = 0
        var maximum = 0
        var passes = 0
        var failures = 0
        var release: CheckedContinuation<Void, Never>?
        let worker = SyncTransferWorker(pass: {
            passes += 1; active += 1; maximum = max(maximum, active)
            defer { active -= 1 }
            if passes == 1 {
                await withCheckedContinuation { continuation in
                    release = continuation
                    started.fulfill()
                }
            }
            try Task.checkCancellation()
            completed.fulfill()
        }, onError: { _ in failures += 1 })
        defer { worker.cancel() }
        worker.nudge()
        await fulfillment(of: [started], timeout: 3)
        for _ in 0..<3 { worker.nudge() }
        release?.resume()
        await fulfillment(of: [completed], timeout: 6)
        XCTAssertEqual(passes, 2, "Wakes during a transfer coalesce into one more pass")
        XCTAssertEqual(maximum, 1, "Transfers must never overlap")
        XCTAssertEqual(failures, 0, "Wakes must not cancel the active response")
    }
}

final class SyncFileTransferTests: XCTestCase {
    @MainActor func testGoneFilesAreRecordedPermanentlyForUploadsAndDownloads() async throws {
        for upload in [false, true] {
            let account = SyncAccount(server: "https://mock.local", email: "a@example.com", userId: "a", token: "token", key: Array(repeating: 17, count: 32))
            var pending = true
            var attempts = 0
            var gone = 0
            let files = SyncFileTransfers(command: { name, args in
                switch name {
                case "sync_status": return ["generation": "epoch"]
                case "sync_pending_deletes": return [String]()
                case "sync_pending_uploads": return upload && pending ? ["image"] : [String]()
                case "sync_missing_files": return !upload && pending ? [["fileId": "image", "moduleId": "note"]] : [[String: String]]()
                case "read_file": return ["bytes": [UInt8](arrayLiteral: 42)]
                case "sync_file_gone":
                    XCTAssertEqual(args["fileId"] as? String, "image")
                    XCTAssertEqual(args["generation"] as? String, "epoch")
                    pending = false; gone += 1; return NSNull()
                default: XCTFail("Unexpected command: \(name)"); return NSNull()
                }
            }, object: { _, _, _ in
                attempts += 1
                throw SyncHTTPFailure(status: 410, message: "Gone")
            }, deleteObject: { _, _ in XCTFail("Unexpected deletion") }, isCurrent: { _ in true }, onFile: { _, _ in XCTFail("Gone image stored") }, onError: { XCTFail("Unexpected error: \($0)") })
            let owner = UUID()
            try await files.run(account: account, owner: owner)
            try await files.run(account: account, owner: owner)
            XCTAssertEqual(gone, 1)
            XCTAssertEqual(attempts, 1)
        }
    }

    @MainActor func testFileCompletionKeepsGenerationCapturedBeforeNetworkWait() async throws {
        let account = SyncAccount(server: "https://mock.local", email: "a@example.com", userId: "a", token: "token", key: Array(repeating: 17, count: 32))
        var epoch = "before-restore"
        var completionEpoch: String?
        let files = SyncFileTransfers(command: { name, args in
            switch name {
            case "sync_status": return ["generation": epoch]
            case "sync_pending_deletes": return [String]()
            case "sync_pending_uploads": return ["image"]
            case "sync_missing_files": return [[String: String]]()
            case "read_file": return ["bytes": [UInt8](arrayLiteral: 42)]
            case "sync_upload_done": completionEpoch = args["generation"] as? String; return NSNull()
            default: XCTFail("Unexpected command: \(name)"); return NSNull()
            }
        }, object: { _, _, _ in
            epoch = "after-restore"
            return Data()
        }, deleteObject: { _, _ in XCTFail("Unexpected deletion") }, isCurrent: { _ in true }, onFile: { _, _ in }, onError: { XCTFail("Unexpected error: \($0)") })
        try await files.run(account: account, owner: UUID())
        XCTAssertEqual(completionEpoch, "before-restore", "Core must see the original generation and reject a stale completion")
    }

    @MainActor func testRemovedImagesLoseBackoffBeforeTheyBecomePendingAgain() async throws {
        let account = SyncAccount(server: "https://mock.local", email: "a@example.com", userId: "a", token: "token", key: Array(repeating: 17, count: 32))
        let ids = (0..<100).map { "image-\($0)" }
        var pending = ids
        var attempted = Set<String>()
        let files = SyncFileTransfers(command: { name, _ in
            switch name {
            case "sync_status": return ["generation": "test-epoch"]
            case "sync_pending_deletes": return [String]()
            case "sync_pending_uploads": return pending
            case "sync_missing_files": return pending.map { ["fileId": $0, "moduleId": "note"] }
            case "read_file": return ["bytes": [UInt8](arrayLiteral: 42)]
            default: XCTFail("Unexpected command: \(name)"); return NSNull()
            }
        }, object: { id, _, _ in
            attempted.insert(id)
            throw SyncHTTPFailure(status: 404, message: "Missing image")
        }, deleteObject: { _, _ in XCTFail("Unexpected deletion") }, isCurrent: { _ in true }, onFile: { _, _ in XCTFail("Failed download was stored") }, onError: { XCTFail("Unexpected error: \($0)") })
        let owner = UUID()
        try await files.run(account: account, owner: owner)
        XCTAssertEqual(attempted, Set(ids))
        attempted.removeAll()
        try await files.run(account: account, owner: owner)
        XCTAssertTrue(attempted.isEmpty, "Images still pending retain backoff")
        pending = []
        try await files.run(account: account, owner: owner)
        pending = ids
        try await files.run(account: account, owner: owner)
        XCTAssertEqual(attempted, Set(ids), "Removed images become eligible again")
    }

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
        }, deleteObject: { _, _ in XCTFail("Unexpected deletion") }, isCurrent: { _ in true }, onFile: { _, json in
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
        XCTAssertEqual(Set(requests), Set([missing, available]))
        XCTAssertEqual(requests.filter { $0 == missing }.count, 1, "Missing image remains in backoff")
    }
}
