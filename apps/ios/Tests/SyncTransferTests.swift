import XCTest
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
