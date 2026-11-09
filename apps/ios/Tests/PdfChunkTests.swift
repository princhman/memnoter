import XCTest
@testable import Memnoter

private struct ImportedPdfId: Decodable, Sendable { let id: String }
private struct PdfIdArgs: Encodable, Sendable { let id: String }

private func chunkTestPdf() -> Data {
    var data = Data("%PDF-1.4\n".utf8)
    data.append(Data(String(repeating: "% padding\n", count: BridgeProtocol.pdfChunkBytes / 10 + 20).utf8))
    let objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> >>"]
    var offsets = [0]
    for (index, object) in objects.enumerated() {
        offsets.append(data.count)
        data.append(Data("\(index + 1) 0 obj\n\(object)\nendobj\n".utf8))
    }
    let xref = data.count
    data.append(Data("xref\n0 4\n0000000000 65535 f \n".utf8))
    for offset in offsets.dropFirst() { data.append(Data(String(format: "%010d 00000 n \n", offset).utf8)) }
    data.append(Data("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n".utf8))
    return data
}

final class PdfChunkTests: XCTestCase {
    func testNativePdfChunksResolveLiveDocumentsAndStayBounded() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let moduleId: String = try await client.call("create_module", NameArgs(name: "Chunk reader"))
        let original = chunkTestPdf()
        let source = directory.appendingPathComponent("Source 文字.pdf")
        try original.write(to: source)
        let pdf: ImportedPdfId = try await client.call("add_document", DocumentPathArgs(moduleId: moduleId, path: source.path))
        let first = try await client.readPdfChunk(PdfChunkArgs(documentId: pdf.id, offset: 0, length: BridgeProtocol.pdfChunkBytes))
        XCTAssertEqual(first.offset, 0)
        XCTAssertEqual(first.total, original.count)
        XCTAssertEqual(Data(base64Encoded: first.data), original.prefix(BridgeProtocol.pdfChunkBytes))
        let tail = try await client.readPdfChunk(PdfChunkArgs(documentId: pdf.id, offset: BridgeProtocol.pdfChunkBytes, length: BridgeProtocol.pdfChunkBytes))
        XCTAssertEqual(tail.offset, BridgeProtocol.pdfChunkBytes)
        XCTAssertEqual(tail.total, original.count)
        XCTAssertEqual(Data(base64Encoded: tail.data), original.dropFirst(BridgeProtocol.pdfChunkBytes))
        let eof = try await client.readPdfChunk(PdfChunkArgs(documentId: pdf.id, offset: original.count, length: 1))
        XCTAssertEqual(eof.data, "")
        XCTAssertEqual(eof.total, original.count)
        for args in [
            PdfChunkArgs(documentId: pdf.id, offset: -1, length: 1),
            PdfChunkArgs(documentId: pdf.id, offset: original.count + 1, length: 1),
            PdfChunkArgs(documentId: pdf.id, offset: 0, length: 0),
            PdfChunkArgs(documentId: pdf.id, offset: 0, length: BridgeProtocol.pdfChunkBytes + 1),
            PdfChunkArgs(documentId: " ", offset: 0, length: 1),
            PdfChunkArgs(documentId: source.path, offset: 0, length: 1),
        ] {
            do { _ = try await client.readPdfChunk(args); XCTFail("Invalid chunk request must reject: \(args)") }
            catch { }
        }
        let image: SavedFile = try await client.call("save_file", FileArgs(moduleId: moduleId, bytes: [1, 2, 3], mimeType: "image/png"))
        do { _ = try await client.readPdfChunk(PdfChunkArgs(documentId: image.id, offset: 0, length: 1)); XCTFail("An image ID must not expose a PDF read path") }
        catch { }
        let ownedPath: String = try await client.call("document_path", PdfIdArgs(id: pdf.id))
        do {
            let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: ownedPath))
            defer { try? handle.close() }
            for size in [0, BridgeProtocol.maxPdfBytes + 1] {
                try handle.truncate(atOffset: UInt64(size))
                do { _ = try await client.readPdfChunk(PdfChunkArgs(documentId: pdf.id, offset: 0, length: 1)); XCTFail("Actual file size must be checked independently of metadata") }
                catch { }
            }
        }
        try original.write(to: URL(fileURLWithPath: ownedPath))
        try await client.write("delete_document", PdfIdArgs(id: pdf.id))
        do { _ = try await client.readPdfChunk(PdfChunkArgs(documentId: pdf.id, offset: 0, length: 1)); XCTFail("Deleted PDFs must not be read") }
        catch { }
    }
}
