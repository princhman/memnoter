import PencilKit

// PKDrawing is Sendable. Copy its value on the main actor, then encode and
// render that fixed revision away from the canvas/input thread.
struct DrawingSnapshot: Sendable {
    let drawing: PKDrawing
    let size: CGSize

    func document(includeGeometry: Bool) throws -> DrawingDocument {
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: size.width, height: size.height,
                                       geometry: includeGeometry ? try JSONEncoder().encode(DrawingStrokeExport(drawing: drawing, page: size)) : nil)
        try document.validate()
        return document
    }

    func preview() throws -> Data {
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
                ink.draw(in: CGRect(origin: .zero, size: rect.size))
            }
        }
        guard let bytes = image.pngData() else { throw CocoaError(.fileWriteUnknown) }
        return bytes
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
}

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
