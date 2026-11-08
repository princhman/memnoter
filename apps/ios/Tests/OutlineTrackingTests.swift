import XCTest
@testable import Memnoter

@MainActor final class OutlineTrackingTests: XCTestCase {
    func testOutlineRequestBeforeReadyUsesLatestPopoverState() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        for stillOpen in [true, false] {
            let session = WebSession(client: client, directory: directory)
            defer { session.dispose() }
            session.web.stopLoading()
            session.trackOutline(true)
            if !stillOpen { session.trackOutline(false) }
            // Delay host creation, as happens when the editor is being replaced.
            session.web.loadHTMLString("""
                <script>
                setTimeout(() => {
                    window.trackingCalls = [];
                    window.memnoterEditor = {
                        setOutlineTracking(enabled) { window.trackingCalls.push(enabled); },
                        setTopInset() {}, setBottomInset() {}
                    };
                    window.__memnoterBridge = { emit() {} };
                    window.webkit.messageHandlers.memnoter.postMessage({ kind: 'event', event: 'ready', payload: { protocolVersion: \(BridgeProtocol.version) } });
                }, 100);
                </script>
                """, baseURL: URL(string: "memnoter-app://localhost/editor.html"))
            var calls: [Bool] = []
            for _ in 0..<100 {
                try await Task.sleep(for: .milliseconds(50))
                calls = (try? await session.run("return window.trackingCalls || []")) as? [Bool] ?? []
                if !calls.isEmpty { break }
            }
            XCTAssertEqual(calls, [stillOpen])
            XCTAssertNil(session.error)
        }
    }
}
