import XCTest
import WebKit
@testable import Memnoter

@MainActor final class JavaScriptBridgeTests: XCTestCase {
    func testAsyncAndVoidResultsDoNotBecomeUserErrors() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let session = WebSession(client: client, directory: directory)
        defer { session.dispose() }
        session.web.stopLoading()
        session.web.loadHTMLString("""
            <script>
            window.memnoterEditor = {
                setOutlineTracking() {}, setTopInset() {}, setBottomInset() {},
                async open() { await Promise.resolve(); },
                async exec() { return true; },
                focus() { return document.body; }
            };
            window.__memnoterBridge = { emit() {} };
            window.webkit.messageHandlers.memnoter.postMessage({ kind: 'event', event: 'ready', payload: { protocolVersion: \(BridgeProtocol.version) } });
            </script>
            """, baseURL: URL(string: "memnoter-app://localhost/editor.html"))
        for _ in 0..<100 {
            if session.ready { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(session.ready)
        try await session.open("startup")
        let executed = try await session.execute(.undo)
        XCTAssertTrue(executed as? Bool == true)
        // A future accidental DOM return is diagnostic only; actual JavaScript
        // exceptions still propagate to the caller.
        _ = try await session.callEditor(.focus)
        do {
            _ = try await session.run("throw new Error('real failure')")
            XCTFail("JavaScript exceptions must propagate")
        } catch let error as WKError {
            XCTAssertEqual(error.code, .javaScriptExceptionOccurred)
        }
        XCTAssertNil(session.error)
    }
}
