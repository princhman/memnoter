import XCTest
@testable import Memnoter

@MainActor final class ViewportOcclusionTests: XCTestCase {
    func testKeyboardFocusCannotPanOuterWebViewport() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let session = WebSession(client: client, directory: directory)
        defer { session.dispose() }
        session.web.stopLoading()
        session.web.frame = CGRect(x: 0, y: 0, width: 414, height: 896)
        session.web.loadHTMLString("""
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <body style="height:2400px"><script>
            window.memnoterEditor = { setOutlineTracking() {}, setTopInset() {}, setBottomInset() {} };
            window.__memnoterBridge = { emit() {} };
            window.webkit.messageHandlers.memnoter.postMessage({ kind: 'event', event: 'ready', payload: { protocolVersion: \(BridgeProtocol.version) } });
            </script>
            """, baseURL: URL(string: "memnoter-app://localhost/editor.html"))
        for _ in 0..<100 {
            if session.ready { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(session.ready)
        // WK's keyboard-focus pan is programmatic and bypasses isScrollEnabled.
        // Exercise the real scroll view/delegate wiring, not the delegate method.
        session.web.scrollView.setContentOffset(CGPoint(x: 0, y: 290), animated: false)
        XCTAssertEqual(session.web.scrollView.contentOffset, .zero, "Reject the outer pan synchronously, before a frame can draw")
        try await Task.sleep(for: .milliseconds(100))
        let offset = try await session.run("return window.scrollY") as? Double
        XCTAssertEqual(try XCTUnwrap(offset), 0, accuracy: 0.5)
    }

    func testKeyboardVisualViewportDoesNotScaleDownNativeOcclusion() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let session = WebSession(client: client, directory: directory)
        defer { session.dispose() }
        session.web.stopLoading()
        session.web.frame = CGRect(x: 0, y: 0, width: 440, height: 900)
        // WK's visual height can shrink under a keyboard even when the inner
        // HTML container retains its full layout size. Only the bridge is fake;
        // native coalescing, WK evaluation and point conversion are real.
        session.web.loadHTMLString("""
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
            Object.defineProperty(window, 'innerHeight', { get: () => 500 });
            window.insets = [];
            window.memnoterEditor = {
                setOutlineTracking() {}, setTopInset() {},
                setBottomInset(px) { window.insets.push(px); }
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
        session.bottomInset = 336 + 76
        var reported: Double?
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(50))
            reported = try await session.run("return window.insets.at(-1)") as? Double
            if let reported, reported > 0 { break }
        }
        XCTAssertEqual(try XCTUnwrap(reported), 412, accuracy: 1, "Keyboard and formatting bar must retain their layout-pixel height")
        XCTAssertNil(session.error)
    }
}
