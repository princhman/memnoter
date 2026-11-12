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
        // An off-screen web view's content process gets suspended on a busy
        // runner, stalling every JavaScript call. Host it like the app does.
        let frame = CGRect(x: 0, y: 0, width: 400, height: 600)
        let window = (UIApplication.shared.connectedScenes.first as? UIWindowScene).map { UIWindow(windowScene: $0) } ?? UIWindow(frame: frame)
        window.frame = frame
        session.web.frame = window.bounds
        window.addSubview(session.web)
        window.isHidden = false
        defer { window.isHidden = true; session.web.removeFromSuperview() }
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
        // `ready` is set when the stub's ready event arrives; onReady would also
        // wait for an extra JavaScript round trip this test doesn't need.
        let deadline = ContinuousClock.now + .seconds(30)
        while !session.ready && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        try XCTUnwrap(session.ready ? true : nil, "Editor did not emit its ready event")
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
