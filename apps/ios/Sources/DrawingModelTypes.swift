import PencilKit

// PKDrawing is Sendable. Copy its value on the main actor, then encode and
// render that fixed revision away from the canvas/input thread.
struct DrawingSnapshot: Sendable {
    let drawing: PKDrawing
    let size: CGSize
    var paperStyle = "blank"

    func document(includeGeometry: Bool) throws -> DrawingDocument {
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: size.width, height: size.height,
                                       geometry: includeGeometry ? try JSONEncoder().encode(DrawingStrokeExport(drawing: drawing, page: size)) : nil)
        try document.validate()
        return document
    }

    func preview() throws -> (bytes: Data, pixelSize: CGSize) {
        let bounds = drawing.bounds
        let rect = bounds.isNull || bounds.isEmpty ? CGRect(x: 0, y: 0, width: 640, height: 240) : bounds.insetBy(dx: -24, dy: -24)
        guard rect.width.isFinite, rect.height.isFinite else { throw CocoaError(.coderInvalidValue) }
        let scale = min(2, 2048 / max(rect.width, rect.height))
        var image: UIImage!
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            let ink = drawing.image(from: rect, scale: scale)
            let format = UIGraphicsImageRendererFormat(); format.scale = scale; format.opaque = true
            image = UIGraphicsImageRenderer(size: rect.size, format: format).image { context in
                UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: rect.size))
                drawPaper(in: rect)
                ink.draw(in: CGRect(origin: .zero, size: rect.size))
            }
        }
        guard let bytes = image.pngData(), let bitmap = image.cgImage else { throw CocoaError(.fileWriteUnknown) }
        return (bytes, CGSize(width: bitmap.width, height: bitmap.height))
    }

    /// The same ruling the canvas shows (every 28 pt in page coordinates), so the image matches what was drawn on.
    private func drawPaper(in rect: CGRect) {
        guard paperStyle == "lined" || paperStyle == "grid" else { return }
        let spacing: CGFloat = 28
        // The editor turns the white page transparent before showing it, which erases
        // hairlines; a 1 pt mid-gray rule stays visible in light and dark mode.
        let path = UIBezierPath(); path.lineWidth = 1
        var y = (rect.minY / spacing).rounded(.up) * spacing
        while y <= rect.maxY { path.move(to: CGPoint(x: 0, y: y - rect.minY)); path.addLine(to: CGPoint(x: rect.width, y: y - rect.minY)); y += spacing }
        if paperStyle == "grid" {
            var x = (rect.minX / spacing).rounded(.up) * spacing
            while x <= rect.maxX { path.move(to: CGPoint(x: x - rect.minX, y: 0)); path.addLine(to: CGPoint(x: x - rect.minX, y: rect.height)); x += spacing }
        }
        UIColor(white: 0.6, alpha: 1).setStroke()
        path.stroke()
    }
}

struct DrawingLocalDraft: Codable, Sendable {
    let document: DrawingDocument
    let baseSourceId: String?
}

struct DrawingViewState: Codable {
    let top: Double
    let height: Double

    var isValid: Bool {
        top.isFinite && height.isFinite && top >= 0 && height > top && height <= 1_000_000
    }
}

struct DrawingRequest: Identifiable {
    let id = UUID()
    let module: NoteModule
    let imageId: String
    let sourceId: String?
    var importPrototype = false
    var isNew = false
    // Answer canvases never publish through the note editor bridge. The native
    // worksheet host must provide the complete pinned answer identity.
    var answer: DrawingAnswerOwner? = nil
    var answerLabel: String? = nil

    var storageId: String {
        guard let answer else { return "\(module.id)/\(imageId)" }
        let components = [module.id, answer.attemptId, answer.revisionId, answer.leafPartId, imageId]
        return "worksheet:" + components.map { Data($0.utf8).base64EncodedString() }.joined(separator: ".")
    }
}

struct DrawingAnswerOwner: Sendable {
    let attemptId: String
    let revisionId: String
    let leafPartId: String

    // Match the Rust/shared-ui answer key, including JSON escaping of IDs.
    var key: String {
        get throws {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            return String(decoding: try encoder.encode([attemptId, revisionId, leafPartId]), as: UTF8.self)
        }
    }
}

struct DrawingAnswerSaveArgs: Encodable, Sendable {
    let moduleId, attemptId, revisionId, leafPartId, canvasId: String
    let sourceId, previewId: String
    let expectedSourceId: String?
    let width, height: Double
    let asCopy: Bool
}

// Decode only the ownership/reference receipt; text remains owned by the shared
// answer document editor and must never be rewritten by the native ink surface.
struct DrawingAnswerBank: Decodable, Sendable {
    struct Ink: Decodable, Sendable { let sourceId, previewId: String }
    struct Canvas: Decodable, Sendable { let revision: Ink?; let copies: [Ink] }
    struct Answer: Decodable, Sendable { let canvases: [String: Canvas] }
    let answers: [String: Answer]
}
struct DrawingAnswerReceipt: Decodable, Sendable { let bank: DrawingAnswerBank }

struct DrawingOpenEvent: Decodable, Equatable {
    let moduleId: String
    let imageId: String
    let sourceId: String?
}

struct DrawingFileArgs: Encodable, Sendable { let moduleId: String; let fileId: String }
struct DrawingFileContents: Decodable, Sendable { let bytes: [UInt8] }

enum DrawingFailure: LocalizedError {
    case unavailable, changed, inputChanged, tooLarge
    var errorDescription: String? {
        switch self {
        case .unavailable: "The drawing source is unavailable or still downloading. Your saved drawing has not been replaced. Try again after sync finishes."
        case .changed: "This drawing changed elsewhere. Save a copy to keep both versions."
        case .inputChanged: "The last stroke was updated while saving. Your draft is safe; tap Done again to save the final version."
        case .tooLarge: "This drawing exceeds the size that can be saved and synced. Your local draft is safe. Export the strokes to keep a separate copy."
        }
    }
}

// Wire shape shared with the desktop DrawingResult. Optional assets are present
// only for a save; ownership always travels separately in the bridge request.
struct WorksheetDrawingResult: Encodable {
    let status: String
    var source: SavedFile? = nil
    var preview: SavedFile? = nil
    var width: Double? = nil
    var height: Double? = nil
    var expectedSourceId: String? = nil
    var asCopy = false
    var hasChanges = false

    func json() throws -> String {
        String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
    }
}
