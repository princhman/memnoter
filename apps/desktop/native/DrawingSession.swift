import SwiftUI
import AppKit
import PencilKit

struct EditorRequest: Codable, Sendable {
    let moduleId: String
    let imageId: String
    let sourceId: String?
    let sourcePath: String?
    let draftPath: String
    let resultPath: String
    let maximumBytes: Int
    let preferencesScope: String

    // The existing Rust wire request and draft paths remain unchanged.
    var sessionRequest: DrawingSessionRequest {
        DrawingSessionRequest(owner: .note(moduleId: moduleId, imageId: imageId), sourceId: sourceId,
            sourcePath: sourcePath, draftPath: draftPath, resultPath: resultPath,
            maximumBytes: maximumBytes, preferencesScope: preferencesScope)
    }
}

struct LocalDraft: Codable, Sendable {
    let document: DrawingDocument
    let baseSourceId: String?
}

struct EditorResult: Codable {
    let status: String
    var sourcePath: String?
    var previewPath: String?
    var expectedSourceId: String?
    var asCopy = false
    var hasChanges = false
    var message: String?
}

// A host supplies paths and a revision; neither a note embed nor a window is
// required to load/checkpoint/publish a canvas. Answer persistence comes later.
struct DrawingSessionRequest: Sendable {
    let owner: DrawingOwner
    let sourceId: String?
    let sourcePath: String?
    let draftPath: String
    let resultPath: String
    let maximumBytes: Int
    let preferencesScope: String
}

actor DrawingStorage {
    let request: DrawingSessionRequest
    private var revision = -1
    private var discarded = false
    init(_ request: DrawingSessionRequest) { self.request = request }

    func load() throws -> (PKDrawing, Double, Double, String?, Bool) {
        let draftURL = URL(fileURLWithPath: request.draftPath)
        if FileManager.default.fileExists(atPath: draftURL.path) {
            let draft = try JSONDecoder().decode(LocalDraft.self, from: Data(contentsOf: draftURL))
            try draft.document.validate()
            return (try draft.document.drawing(), draft.document.width, draft.document.height, draft.baseSourceId, true)
        }
        if let sourcePath = request.sourcePath {
            let document = try JSONDecoder().decode(DrawingDocument.self, from: Data(contentsOf: URL(fileURLWithPath: sourcePath)))
            try document.validate()
            return (try document.drawing(), document.width, document.height, request.sourceId, false)
        }
        guard request.sourceId == nil else { throw NSError(domain: "Drawing", code: 1, userInfo: [NSLocalizedDescriptionKey: "The drawing source has not downloaded yet. Close and try again after sync finishes."]) }
        return (PKDrawing(), 1024, 1440, nil, false)
    }

    func checkpoint(_ drawing: PKDrawing, width: Double, height: Double, base: String?, revision: Int) throws {
        guard !discarded, revision >= self.revision else { return }
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: width, height: height, geometry: nil)
        try document.validate()
        let url = URL(fileURLWithPath: request.draftPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(LocalDraft(document: document, baseSourceId: base)).write(to: url, options: .atomic)
        self.revision = revision
    }

    func discard() throws {
        let url = URL(fileURLWithPath: request.draftPath)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        discarded = true // Queued autosaves must not recreate an abandoned draft.
    }

    func publication(_ drawing: PKDrawing, width: Double, height: Double, paperStyle: DrawingPaperStyle) throws -> (String, String) {
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: width, height: height, geometry: nil, portable: PortableInk.exporting(drawing))
        try document.validate()
        guard drawing.requiredContentVersion.rawValue <= PKContentVersion.version2.rawValue else {
            throw NSError(domain: "Drawing", code: 2, userInfo: [NSLocalizedDescriptionKey: "This ink requires a newer iPad version. Your Mac draft is safe."])
        }
        let source = try JSONEncoder().encode(document)
        guard source.count <= request.maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        let bounds = drawing.bounds
        // Keep page width so the image host does not magnify a small sketch.
        let top = bounds.isNull || bounds.isEmpty ? 0 : max(0, bounds.minY - 24)
        let rect = CGRect(x: 0, y: top, width: width,
                          height: bounds.isNull || bounds.isEmpty ? 240 : bounds.maxY + 24 - top)
        let scale: CGFloat = 2
        let pixelSize = CGSize(width: max(1, ceil(rect.width * scale)), height: max(1, ceil(rect.height * scale)))
        // Retain retina resolution rather than silently reducing ink quality.
        // Bound allocation for the document format's very large page limits.
        guard pixelSize.width * pixelSize.height <= 64 * 1024 * 1024 else { throw CocoaError(.fileWriteOutOfSpace) }
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(pixelSize.width), pixelsHigh: Int(pixelSize.height), bitsPerSample: 8,
                                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw CocoaError(.fileWriteUnknown) }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor.white.setFill(); CGRect(origin: .zero, size: pixelSize).fill()
        NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
            // Rules and ink use the same top-down page coordinates.
            NSGraphicsContext.saveGraphicsState()
            let transform = NSAffineTransform()
            transform.scale(by: scale)
            transform.translateX(by: 0, yBy: rect.height)
            transform.scaleX(by: 1, yBy: -1)
            transform.concat()
            paperStyle.draw(in: rect, export: true)
            NSGraphicsContext.restoreGraphicsState()
            drawing.image(from: rect, scale: scale)
                .draw(in: CGRect(origin: .zero, size: pixelSize))
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let preview = bitmap.representation(using: .png, properties: [:]), preview.count <= request.maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        let folder = URL(fileURLWithPath: request.resultPath).deletingLastPathComponent()
        let sourceURL = folder.appendingPathComponent("source.json")
        let previewURL = folder.appendingPathComponent("preview.png")
        try source.write(to: sourceURL, options: .atomic)
        try preview.write(to: previewURL, options: .atomic)
        return (sourceURL.path, previewURL.path)
    }
}

@MainActor final class DrawingSession: NSObject, ObservableObject {
    let request: DrawingSessionRequest
    let storage: DrawingStorage
    let preferences: UserDefaults
    @Published var drawing = PKDrawing()
    @Published var revision = 0
    @Published var loaded = false
    @Published var saving = false
    @Published var usingTool = false {
        didSet { if !usingTool && closeRequested { closeRequested = false; close() } }
    }
    @Published var error: String?
    @Published var tool: InkTool = .pen { didSet { preferences.set(tool.rawValue, forKey: "tool") } }
    @Published var color: InkColor = .black { didSet { preferences.set(color.rawValue, forKey: "color") } }
    @Published var paperStyle: DrawingPaperStyle = .blank {
        didSet {
            preferences.set(paperStyle.rawValue, forKey: "drawing.paper")
            if loaded && paperStyle != oldValue { changed() }
        }
    }
    @Published var width: Double = 3 { didSet { preferences.set(width, forKey: "width") } }
    @Published var undoStack: [PKDrawing] = []
    @Published var redoStack: [PKDrawing] = []
    var paperWidth = 1024.0
    var paperHeight = 1440.0
    var baseSourceId: String?
    var hasChanges = false
    var finished = false
    var onFinish: (() -> Void)?
    var scrollTop = 0.0
    private var closeRequested = false
    private var pendingSave: Task<Void, Never>?
    var viewKey: String { request.owner.viewportKey }
    var requiresCopy: Bool { baseSourceId != request.sourceId }
    var ink: PKInk {
        switch tool {
        case .pencil: PKInk(.pencil, color: color.value)
        case .marker: PKInk(.marker, color: color.value)
        default: PKInk(.monoline, color: color.value)
        }
    }
    var strokeWidth: CGFloat { width * (tool == .marker ? 5 : 1) }

    convenience init(_ request: EditorRequest) { self.init(request.sessionRequest) }

    init(_ request: DrawingSessionRequest) {
        self.request = request; storage = DrawingStorage(request)
        preferences = UserDefaults(suiteName: "com.memnoter.mac.drawing.\(request.preferencesScope)")!
        super.init()
        tool = InkTool(rawValue: preferences.string(forKey: "tool") ?? "") ?? .pen
        color = InkColor(rawValue: preferences.string(forKey: "color") ?? "") ?? .black
        paperStyle = DrawingPaperStyle(rawValue: preferences.string(forKey: "drawing.paper") ?? "") ?? .blank
        let savedWidth = preferences.object(forKey: "width") as? Double ?? 3
        width = savedWidth.isFinite ? max(1, min(10, savedWidth)) : 3
        scrollTop = max(0, preferences.double(forKey: viewKey))
        if !scrollTop.isFinite || scrollTop > 1_000_000 { scrollTop = 0 }
    }
    func load() async {
        do {
            let result = try await storage.load()
            drawing = result.0; paperWidth = result.1; paperHeight = max(result.2, scrollTop + 1440)
            baseSourceId = result.3; hasChanges = result.4
            revision += 1 // Invalidate the surface's initial empty snapshot after loading.
            loaded = true
        } catch { self.error = error.localizedDescription }
    }
    func commit(_ drawing: PKDrawing) {
        guard drawing != self.drawing else { return }
        undoStack.append(self.drawing); if undoStack.count > 50 { undoStack.removeFirst() }
        redoStack.removeAll(); self.drawing = drawing; changed()
    }
    func undo() {
        guard !usingTool, !saving else { return }
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(drawing); drawing = previous; changed()
    }
    func redo() {
        guard !usingTool, !saving else { return }
        guard let next = redoStack.popLast() else { return }
        undoStack.append(drawing); drawing = next; changed()
    }
    private func changed() {
        revision += 1; hasChanges = true; pendingSave?.cancel()
        pendingSave = Task {
            do { try await Task.sleep(for: .milliseconds(700)); try await flush() }
            catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
    }
    func flush() async throws {
        preferences.set(scrollTop, forKey: viewKey)
        if hasChanges { try await storage.checkpoint(drawing, width: paperWidth, height: paperHeight, base: baseSourceId, revision: revision) }
    }
    func done(copy: Bool = false) {
        guard loaded, !saving, !usingTool else { return }
        saving = true; pendingSave?.cancel()
        Task {
            do {
                try await flush()
                let makingCopy = copy && (request.sourceId != nil || requiresCopy)
                if !hasChanges && !makingCopy { finish(EditorResult(status: request.sourceId == nil ? "empty" : "unchanged")); return }
                let files = try await storage.publication(drawing, width: paperWidth, height: paperHeight, paperStyle: paperStyle)
                finish(EditorResult(status: "save", sourcePath: files.0, previewPath: files.1, expectedSourceId: baseSourceId, asCopy: makingCopy, hasChanges: true))
            } catch { saving = false; self.error = error.localizedDescription }
        }
    }
    func discardLocalChanges() {
        guard loaded, !saving, !usingTool, !finished else { return }
        saving = true; pendingSave?.cancel()
        Task {
            do {
                try await storage.discard()
                hasChanges = false
                finish(EditorResult(status: "discarded"))
            } catch { saving = false; self.error = error.localizedDescription }
        }
    }

    func close() {
        if usingTool { closeRequested = true; return }
        guard !saving, !finished else { return }
        saving = true; pendingSave?.cancel()
        Task {
            do { try await flush(); finish(EditorResult(status: "cancel", hasChanges: hasChanges)) }
            catch { saving = false; self.error = error.localizedDescription }
        }
    }
    private func finish(_ result: EditorResult) {
        guard !finished else { return }
        do {
            try JSONEncoder().encode(result).write(to: URL(fileURLWithPath: request.resultPath), options: .atomic)
            finished = true
            onFinish?()
        } catch { saving = false; self.error = error.localizedDescription }
    }
}
