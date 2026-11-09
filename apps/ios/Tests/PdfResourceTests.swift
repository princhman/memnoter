import XCTest
import WebKit
@testable import Memnoter

@MainActor private final class SchemeProbe: NSObject, @preconcurrency WKURLSchemeTask {
    let request: URLRequest
    let completion: XCTestExpectation
    var response: URLResponse?
    var data = Data()
    var error: Error?
    init(url: URL, completion: XCTestExpectation) {
        request = URLRequest(url: url)
        self.completion = completion
    }
    func didReceive(_ response: URLResponse) { self.response = response }
    func didReceive(_ data: Data) { self.data.append(data) }
    func didFinish() { completion.fulfill() }
    func didFailWithError(_ error: Error) { self.error = error; completion.fulfill() }
}

final class PdfResourceTests: XCTestCase {
    @MainActor func testReaderResourcesHaveUsableTypesWithinTheExistingFileBoundary() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("files"), withIntermediateDirectories: true)
        let pdf = Data("%PDF-1.7\nreader resource".utf8)
        try pdf.write(to: root.appendingPathComponent("files/7934d37b-5681-423e-98e2-2ac76d656629"))
        try Data("export const WorkerMessageHandler = {};".utf8).write(to: root.appendingPathComponent("pdf.worker.mjs"))
        try Data([0, 97, 115, 109]).write(to: root.appendingPathComponent("decoder.wasm"))
        let web = WKWebView(frame: .zero)
        let files = ResourceHandler(root: root, images: true)
        let bundle = ResourceHandler(root: root, images: false)
        for (handler, path, mime) in [
            (files, "files/7934d37b-5681-423e-98e2-2ac76d656629", "application/pdf"),
            (bundle, "pdf.worker.mjs", "text/javascript"),
            (bundle, "decoder.wasm", "application/wasm"),
        ] {
            let completed = expectation(description: "Load \(path)")
            let scheme = handler === files ? BridgeProtocol.fileScheme : BridgeProtocol.appScheme
            let probe = SchemeProbe(url: URL(string: "\(scheme)://localhost/\(path)")!, completion: completed)
            handler.webView(web, start: probe)
            await fulfillment(of: [completed], timeout: 3)
            XCTAssertNil(probe.error)
            XCTAssertEqual(probe.response?.mimeType, mime)
            XCTAssertFalse(probe.data.isEmpty)
            if mime == "application/pdf" { XCTAssertEqual(probe.data, pdf) }
        }
        for url in ["memnoter-file://localhost/main.db", "memnoter-file://localhost/files/%2e%2e/main.db", "memnoter-file://elsewhere/files/7934d37b-5681-423e-98e2-2ac76d656629"] {
            let blocked = expectation(description: "Reject \(url)")
            let probe = SchemeProbe(url: URL(string: url)!, completion: blocked)
            files.webView(web, start: probe)
            await fulfillment(of: [blocked], timeout: 3)
            XCTAssertNotNil(probe.error)
            XCTAssertNil(probe.response)
            XCTAssertTrue(probe.data.isEmpty)
        }
    }
}
