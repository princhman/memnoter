import SwiftUI
import PencilKit
import UniformTypeIdentifiers
import CryptoKit

// Local recovery checkpoints; published drawing documents use managed assets.
actor DrawingDraftStore {
    let url: URL
    private var writtenRevision = -1
    private var publishedRevision = -1

    private let legacyURLs: [URL]
    init(directory: URL, moduleId: String) {
        let folder = directory.appendingPathComponent("drawing-prototypes", isDirectory: true)
        let digest = SHA256.hash(data: Data(moduleId.utf8)).map { String(format: "%02x", $0) }.joined()
        url = folder.appendingPathComponent("sha256-" + digest).appendingPathExtension("drawing")
        var keys = [moduleId]
        if moduleId.hasPrefix("worksheet:") { keys.append(digest) }
        legacyURLs = keys.compactMap { key in
            let name = Data(key.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
            return name.utf8.count <= 240 ? folder.appendingPathComponent(name).appendingPathExtension("drawing") : nil
        }
    }

    func load() throws -> Data? {
        if FileManager.default.fileExists(atPath: url.path) { return try Data(contentsOf: url) }
        for legacy in legacyURLs where FileManager.default.fileExists(atPath: legacy.path) {
            let data = try Data(contentsOf: legacy)
            try data.write(to: url, options: .atomic)
            try FileManager.default.removeItem(at: legacy)
            return data
        }
        return nil
    }

    func save(_ data: Data, revision: Int) throws {
        guard revision >= writtenRevision, revision > publishedRevision else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        writtenRevision = revision
    }
    func remove(through revision: Int) throws {
        if writtenRevision <= revision, FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        if writtenRevision <= revision {
            for legacy in legacyURLs where FileManager.default.fileExists(atPath: legacy.path) { try FileManager.default.removeItem(at: legacy) }
        }
        publishedRevision = max(publishedRevision, revision)
    }
    func checkpoint(_ snapshot: DrawingSnapshot, baseSourceId: String?, revision: Int) throws {
        guard revision >= writtenRevision, revision > publishedRevision else { return }
        let draft = DrawingLocalDraft(document: try snapshot.document(includeGeometry: false), baseSourceId: baseSourceId)
        try save(JSONEncoder().encode(draft), revision: revision)
    }
    func publication(_ snapshot: DrawingSnapshot, maximumBytes: Int) throws -> (source: Data, preview: Data) {
        let source = try JSONEncoder().encode(snapshot.document(includeGeometry: true))
        guard source.count <= maximumBytes else { throw DrawingFailure.tooLarge }
        let preview = try snapshot.preview()
        guard preview.count <= maximumBytes else { throw DrawingFailure.tooLarge }
        return (source, preview)
    }
    func export(_ snapshot: DrawingSnapshot) throws -> Data {
        try JSONEncoder().encode(DrawingStrokeExport(drawing: snapshot.drawing, page: snapshot.size))
    }
    func loadDraft() throws -> DrawingLocalDraft? {
        try load().map { try JSONDecoder().decode(DrawingLocalDraft.self, from: $0) }
    }
    // Matching the current immutable source is causal freshness: this draft
    // was made after that saved revision, rather than before a newer sync/save.
    func worksheetDraft(sourceId: String?, saved: DrawingDocument?) throws -> DrawingLocalDraft? {
        guard let draft = try loadDraft(), draft.baseSourceId == sourceId else { return nil }
        let ink = try decodeDrawing(draft.document)
        // Old close/appearance checkpoints could contain an empty canvas.
        // Never recover those over ink (or offer an empty new draft to resume).
        guard !ink.strokes.isEmpty else { return nil }
        if let saved, try worksheetInkFingerprint(ink) == worksheetInkFingerprint(decodeDrawing(saved)) { return nil }
        return draft
    }
    func decodeDocument(_ bytes: Data) throws -> DrawingDocument {
        try JSONDecoder().decode(DrawingDocument.self, from: bytes)
    }
    func decodeDrawing(_ document: DrawingDocument) throws -> PKDrawing {
        try document.validate()
        return try PKDrawing(data: document.nativeData)
    }
}

// Versioned inspection export, not yet the canonical shared drawing format.
// Keeping spline control points (rather than treating them as touch samples)
// lets the next renderer experiment decide its interpolation explicitly.
struct DrawingStrokeExport: Codable {
    struct Point: Codable {
        let x, y, time, width, height, opacity, force, azimuth, altitude: Double
    }
    struct Stroke: Codable {
        let ink: String
        let rgba: [Double]
        let transform: [Double]
        let mask: [MaskElement]?
        let maskUsesEvenOddFillRule: Bool?
        let randomSeed: UInt32
        let createdAt: Double
        let points: [Point]
    }
    struct MaskElement: Codable {
        let command: String
        let coordinates: [Double]
    }
    let version: Int
    let coordinateSpace: String
    let pageWidth, pageHeight: Double
    let strokes: [Stroke]

    init(drawing: PKDrawing, page: CGSize) throws {
        version = 1
        coordinateSpace = "pencilkit-spline-control-points"
        pageWidth = page.width; pageHeight = page.height
        strokes = try drawing.strokes.map { stroke in
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            guard stroke.ink.color.getRed(&r, green: &g, blue: &b, alpha: &a) else {
                throw CocoaError(.coderInvalidValue)
            }
            let t = stroke.transform
            var mask: [MaskElement]?
            if let path = stroke.mask {
                var elements: [MaskElement] = []
                path.cgPath.applyWithBlock { pointer in
                    let element = pointer.pointee
                    let command: String
                    let count: Int
                    switch element.type {
                    case .moveToPoint: command = "move"; count = 1
                    case .addLineToPoint: command = "line"; count = 1
                    case .addQuadCurveToPoint: command = "quadratic"; count = 2
                    case .addCurveToPoint: command = "cubic"; count = 3
                    case .closeSubpath: command = "close"; count = 0
                    @unknown default: command = "unsupported"; count = 0
                    }
                    elements.append(MaskElement(command: command, coordinates: (0..<count).flatMap {
                        [Double(element.points[$0].x), Double(element.points[$0].y)]
                    }))
                }
                guard elements.allSatisfy({ $0.command != "unsupported" }) else { throw CocoaError(.featureUnsupported) }
                mask = elements
            }
            return Stroke(ink: stroke.ink.inkType.rawValue, rgba: [r, g, b, a],
                          transform: [t.a, t.b, t.c, t.d, t.tx, t.ty],
                          mask: mask,
                          maskUsesEvenOddFillRule: stroke.mask?.usesEvenOddFillRule,
                          randomSeed: stroke.randomSeed,
                          createdAt: stroke.path.creationDate.timeIntervalSince1970,
                          points: stroke.path.map { p in
                Point(x: p.location.x, y: p.location.y, time: p.timeOffset,
                      width: p.size.width, height: p.size.height, opacity: p.opacity,
                      force: p.force, azimuth: p.azimuth, altitude: p.altitude)
            })
        }
    }
}

struct DrawingJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

final class DrawingCanvas: PKCanvasView {
    var toolOverlayFrameInViewport = CGRect.null
    var worksheetHeaderHeight: CGFloat = 0
    var adaptiveWorksheetInk = false
    private func overToolPalette(_ point: CGPoint) -> Bool {
        (worksheetHeaderHeight > 0 && point.y - bounds.minY < worksheetHeaderHeight) || toolOverlayFrameInViewport.contains(CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY))
    }
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        !overToolPalette(point) && super.point(inside: point, with: event)
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        overToolPalette(point) ? nil : super.hitTest(point, with: event)
    }
    private let history = UndoManager()
    private var updatingViewport = false
    private var pendingTop: CGFloat?
    private(set) var documentSize = DrawingModel.page
    var paperStyle = "blank" { didSet { updatePaper() } }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        updatePaper()

    }
    func updatePaper() {
        guard paperStyle != "blank" else { backgroundColor = .systemBackground; return }
        let spacing = max(8, 28 * zoomScale)
        let phase = (-contentOffset.y).truncatingRemainder(dividingBy: spacing)
        let lineY = phase < 0 ? phase + spacing : phase
        let tile = UIGraphicsImageRenderer(size: CGSize(width: spacing, height: spacing)).image { context in
            UIColor.systemBackground.resolvedColor(with: traitCollection).setFill()
            context.fill(CGRect(x: 0, y: 0, width: spacing, height: spacing))
            UIColor.label.resolvedColor(with: traitCollection).withAlphaComponent(0.22).setStroke()
            let path = UIBezierPath(); path.lineWidth = 0.5
            path.move(to: CGPoint(x: 0, y: lineY)); path.addLine(to: CGPoint(x: spacing, y: lineY))
            if paperStyle == "grid" { path.move(to: CGPoint(x: spacing - 0.5, y: 0)); path.addLine(to: CGPoint(x: spacing - 0.5, y: spacing)) }
            path.stroke()
        }
        backgroundColor = UIColor(patternImage: tile)
    }
    var toolsEnabled = false { didSet { updateTools() } }
    override init(frame: CGRect) { super.init(frame: frame); configureViewport() }
    required init?(coder: NSCoder) { super.init(coder: coder); configureViewport() }
    private func configureViewport() {
        contentSize = documentSize
        pinchGestureRecognizer?.isEnabled = false
        bouncesZoom = false
        alwaysBounceHorizontal = false
        alwaysBounceVertical = true
        showsHorizontalScrollIndicator = false
        isDirectionalLockEnabled = true
        contentInsetAdjustmentBehavior = .never
    }
    override var undoManager: UndoManager? { history }
    override func didMoveToWindow() { super.didMoveToWindow(); updateTools() }
    private func updateTools() {
        // SwiftUI can attach/dismantle this view while updating its responder
        // graph. Re-entering that graph synchronously can deadlock the update.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.toolsEnabled, self.window != nil {
                if !self.isFirstResponder { self.becomeFirstResponder() }
            } else if self.isFirstResponder { self.resignFirstResponder() }
        }
    }
    func restoreSize(_ size: CGSize) {
        // Earlier free canvases could contain a very wide, unused area. Keep
        // all existing ink, but do not fit that unused space onto the screen.
        let ink = drawing.bounds
        let usedWidth = !ink.isNull && !ink.isInfinite && ink.maxX.isFinite ? ink.maxX + 24 : 0
        documentSize.width = max(DrawingModel.page.width, usedWidth)
        documentSize.height = max(documentSize.height, size.height)
        setNeedsLayout()
    }
    func keepWritingRoom() {
        guard bounds.height > 0, zoomScale > 0 else { return }
        if abs(contentOffset.x) > 0.01 { contentOffset.x = 0 }
        let screenHeight = bounds.height / zoomScale
        let ink = drawing.bounds
        let inkBottom = !ink.isNull && !ink.isInfinite && ink.maxY.isFinite ? ink.maxY : 0
        let bottom = max((max(0, contentOffset.y) + bounds.height) / zoomScale, inkBottom)
        if bottom > documentSize.height - screenHeight * 0.5 {
            documentSize.height = bottom + max(800, screenHeight)
            setNeedsLayout()
        }
    }
    func restoreView(_ state: DrawingViewState) {
        guard state.isValid else { return }
        documentSize.height = max(documentSize.height, state.height)
        pendingTop = state.top
        setNeedsLayout()
    }
    override func layoutSubviews() {
        guard !updatingViewport, bounds.width > 0, bounds.height > 0 else { super.layoutSubviews(); return }
        updatingViewport = true
        defer { updatingViewport = false }
        // Fit the same document coordinates to each real viewport, including
        // rotation. Only the viewing scale changes; stored strokes never move.
        let top = pendingTop ?? max(0, contentOffset.y) / max(zoomScale, 0.001)
        let fit = bounds.width / documentSize.width
        if abs(zoomScale - fit) > 0.0001 {
            minimumZoomScale = min(zoomScale, fit)
            maximumZoomScale = max(zoomScale, fit)
            setZoomScale(fit, animated: false)
            contentOffset = CGPoint(x: 0, y: top * fit)
        }
        minimumZoomScale = fit; maximumZoomScale = fit
        if pendingTop != nil { documentSize.height = max(documentSize.height, top + bounds.height / fit + 800) }
        keepWritingRoom()
        let size = CGSize(width: bounds.width, height: documentSize.height * fit)
        if contentSize != size { contentSize = size }
        super.layoutSubviews()
        if pendingTop != nil {
            pendingTop = nil
            contentOffset = CGPoint(x: 0, y: min(top * fit, max(0, contentSize.height - bounds.height)))
        }
        if contentOffset.x != 0 { contentOffset.x = 0 }
        updatePaper()
    }
}

@MainActor @Observable final class DrawingModel: NSObject, PKCanvasViewDelegate, UIPencilInteractionDelegate {
    static let page = CGSize(width: 1024, height: 1440)
    let canvas = DrawingCanvas()
    let request: DrawingRequest
    private let client: CoreClient
    private let drafts: DrawingDraftStore
    private let prototype: DrawingDraftStore
    private let preferences: UserDefaults
    private var viewKey: String { "drawing.viewport.\(request.storageId)" }
    private var pendingSave: Task<Void, Never>?
    private var retired = false
    private var revision = 0
    private var baseSourceId: String?
    private var savedInkFingerprint: Data?
    private var savedHadInk = false
    private var worksheetToolUsed = false
    private var loading = false
    private var uploaded: (revision: Int, source: SavedFile, preview: SavedFile, size: CGSize)?
    private var copyId: String?
    private let pencilInteraction = UIPencilInteraction()
    private var strokeStart: PKDrawing?
    private var previousTool: DrawingTool = .pen
    var tool: DrawingTool = .pen {
        didSet { if tool != oldValue { previousTool = oldValue }; updateTool(); preferences.set(tool.rawValue, forKey: "drawing.tool") }
    }
    var ink: DrawingInk = .black { didSet { updateTool(); preferences.set(ink.rawValue, forKey: "drawing.ink") } }
    var inkWidth: CGFloat = 3 { didSet { updateTool(); preferences.set(Double(inkWidth), forKey: "drawing.width") } }
    var eraserWidth: CGFloat = 20 { didSet { updateTool(); preferences.set(Double(eraserWidth), forKey: "drawing.eraserWidth") } }
    /// The width control sizes whichever tool is active: ink strokes or the pixel eraser.
    var activeWidth: CGFloat {
        get { tool == .eraser ? eraserWidth : inkWidth }
        set { if tool == .eraser { eraserWidth = newValue } else { inkWidth = newValue } }
    }
    var activeWidthRange: ClosedRange<CGFloat> { tool == .eraser ? 4...80 : 1...10 }
    var paperStyle = "blank" {
        didSet { canvas.paperStyle = paperStyle; preferences.set(paperStyle, forKey: "drawing.paper") }
    }
    var showInkOptions = false
    var loaded = false
    var loadFailed = false
    var saving = false
    var status = "Opening drawing…"
    var error: String?
    var canUndo = false
    var canRedo = false
    private(set) var processingStroke = false
    var usingTool = false
    var hasLocalEdits = false
    var requiresCopy = false
    var fingerDrawing = false {
        didSet { canvas.drawingPolicy = fingerDrawing ? .anyInput : .pencilOnly; preferences.set(fingerDrawing, forKey: "drawing.finger") }
    }

    init(request: DrawingRequest, directory: URL, client: CoreClient, preferences: UserDefaults) {
        self.request = request; self.client = client
        self.preferences = preferences
        tool = DrawingTool(rawValue: preferences.string(forKey: "drawing.tool") ?? "") ?? .pen
        ink = DrawingInk(rawValue: preferences.string(forKey: "drawing.ink") ?? "") ?? .black
        let width = preferences.object(forKey: "drawing.width") as? Double ?? 3
        inkWidth = width.isFinite ? min(10, max(1, width)) : 3
        let eraser = preferences.object(forKey: "drawing.eraserWidth") as? Double ?? 20
        eraserWidth = eraser.isFinite ? min(80, max(4, eraser)) : 20
        fingerDrawing = preferences.object(forKey: "drawing.finger") == nil
            ? UIDevice.current.userInterfaceIdiom == .phone
            : preferences.bool(forKey: "drawing.finger")
        baseSourceId = request.sourceId
        drafts = DrawingDraftStore(directory: directory, moduleId: request.storageId)
        prototype = DrawingDraftStore(directory: directory, moduleId: request.module.id)
        super.init()
        paperStyle = preferences.string(forKey: "drawing.paper") ?? "blank"
        canvas.paperStyle = paperStyle
        canvas.adaptiveWorksheetInk = true
        canvas.isOpaque = true
        canvas.contentSize = Self.page
        canvas.maximumSupportedContentVersion = .version2
        canvas.drawingPolicy = fingerDrawing ? .anyInput : .pencilOnly
        updateTool()
        pencilInteraction.delegate = self
        canvas.addInteraction(pencilInteraction)
        let undoTap = UITapGestureRecognizer(target: self, action: #selector(undoGesture))
        undoTap.numberOfTouchesRequired = 2
        undoTap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        canvas.addGestureRecognizer(undoTap)
        let redoTap = UITapGestureRecognizer(target: self, action: #selector(redoGesture))
        redoTap.numberOfTouchesRequired = 3
        redoTap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        canvas.addGestureRecognizer(redoTap)
        undoTap.require(toFail: redoTap)
        canvas.accessibilityLabel = "Drawing canvas"
    }

    func load() async {
        guard !loaded, !loading else { return }
        loading = true
        defer { loading = false }
        loadFailed = false; error = nil; status = "Opening drawing…"
        do {
            let document: DrawingDocument?
            if request.answer != nil {
                // Always read the durable source first. A stale/broken local
                // checkpoint must not hide a valid saved drawing, including Mac ink.
                var saved: DrawingDocument?
                if let source = request.sourceId {
                    let file: DrawingFileContents
                    do { file = try await client.call("read_file", DrawingFileArgs(moduleId: request.module.id, fileId: source)) }
                    catch { throw DrawingFailure.unavailable }
                    saved = try await drafts.decodeDocument(Data(file.bytes))
                }
                let savedInk: PKDrawing
                if let saved { savedInk = try await drafts.decodeDrawing(saved) }
                else { savedInk = PKDrawing() }
                savedInkFingerprint = try worksheetInkFingerprint(savedInk)
                savedHadInk = !savedInk.strokes.isEmpty
                let recovered = try? await drafts.worksheetDraft(sourceId: request.sourceId, saved: saved)
                document = recovered?.document ?? saved
                hasLocalEdits = recovered != nil
            } else if let draft = try await drafts.loadDraft() {
                document = draft.document
                requiresCopy = draft.baseSourceId != request.sourceId
                hasLocalEdits = true
            } else if let source = request.sourceId {
                let file: DrawingFileContents
                do { file = try await client.call("read_file", DrawingFileArgs(moduleId: request.module.id, fileId: source)) }
                catch { throw DrawingFailure.unavailable }
                document = try await drafts.decodeDocument(Data(file.bytes))
            } else if request.importPrototype && request.answer == nil {
                guard let data = try await prototype.load() else { throw DrawingFailure.unavailable }
                document = DrawingDocument(version: 1, nativeData: data, width: Self.page.width, height: Self.page.height, geometry: nil)
                hasLocalEdits = true
            } else { document = nil }
            guard !retired else { return }
            if let document {
                let drawing = try await drafts.decodeDrawing(document)
                guard !retired else { return }
                canvas.drawing = worksheetInk(drawing, dark: false)
                canvas.restoreSize(CGSize(width: document.width, height: document.height))
            }
            if request.answer != nil {
                // Reopening ink must reveal it, not an old empty writing area
                // left at the bottom of the auto-growing canvas.
                let bounds = canvas.drawing.bounds
                let top = bounds.isNull ? 0 : max(0, bounds.minY - 100)
                canvas.restoreView(DrawingViewState(top: top, height: max(canvas.documentSize.height, top + 1440)))
            } else if let data = preferences.data(forKey: viewKey),
               let state = try? JSONDecoder().decode(DrawingViewState.self, from: data) { canvas.restoreView(state) }
            canvas.delegate = self
            loaded = true
            status = hasLocalEdits ? "Recovered unsaved changes" : savedStatus
            canvas.toolsEnabled = true
            refreshHistory()
        } catch {
            loadFailed = true
            self.error = error.localizedDescription
            status = "Could not open drawing"
        }
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        if request.answer != nil, loaded, !saving { worksheetToolUsed = true }
        strokeStart = request.answer != nil && tool.usesInk ? canvasView.drawing : nil
        usingTool = true; pendingSave?.cancel()
    }
    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        usingTool = false; processingStroke = true
        let before = strokeStart; strokeStart = nil
        Task { [weak self] in
            await Task.yield()
            guard let self else { return }
            defer { self.processingStroke = false; self.scheduleSave() }
            guard !self.retired, !self.usingTool, let before else { return }
            self.eraseScribbledStrokes(before: before)
        }
    }
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        canvas.keepWritingRoom()
        revision += 1; hasLocalEdits = true
        refreshHistory(); status = "Unsaved changes"
        if !usingTool { scheduleSave() }
    }
    private func refreshHistory() {
        let undo = canvas.undoManager?.canUndo == true, redo = canvas.undoManager?.canRedo == true
        if canUndo != undo { canUndo = undo }; if canRedo != redo { canRedo = redo }
    }
    private func eraseScribbledStrokes(before: PKDrawing) {
        let current = canvas.drawing.strokes
        guard current.count == before.strokes.count + 1, let scratch = current.last,
              let region = ScribbleDeletion.region(for: scratch) else { return }
        let original = before.strokes
        let remaining = original.filter { !ScribbleDeletion.intersects($0, region: region, bounds: scratch.renderBounds.insetBy(dx: -12, dy: -12)) }
        guard remaining.count < original.count else { return }
        replaceDrawing(PKDrawing(strokes: remaining), undoTo: before)
        canvas.undoManager?.setActionName("Delete scribbled strokes")
    }
    private func replaceDrawing(_ drawing: PKDrawing, undoTo: PKDrawing? = nil) {
        let previous = undoTo ?? canvas.drawing
        canvas.undoManager?.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated { target.replaceDrawing(previous) }
        }
        canvas.drawing = drawing
        canvasViewDrawingDidChange(canvas)
        refreshHistory()
    }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { canvas.keepWritingRoom(); canvas.updatePaper() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { checkpointView() }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { checkpointView() }
    func checkpointView() {
        guard loaded, canvas.bounds.height > 0 else { return }
        let state = DrawingViewState(top: max(0, canvas.contentOffset.y) / max(canvas.zoomScale, 0.001), height: canvas.documentSize.height)
        if state.isValid, let data = try? JSONEncoder().encode(state) { preferences.set(data, forKey: viewKey) }
    }
    private func scheduleSave() {
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(700)) } catch { return }
            guard let self else { return }
            do { try await self.flush() } catch { self.error = error.localizedDescription }
        }
    }
    private var snapshot: DrawingSnapshot { DrawingSnapshot(drawing: worksheetInk(canvas.drawing, dark: false), size: canvas.documentSize, paperStyle: canvas.paperStyle) }
    func flush() async throws {
        guard loaded, hasLocalEdits, !retired else { return }
        if request.answer != nil {
            hasLocalEdits = try worksheetInkFingerprint(canvas.drawing) != savedInkFingerprint
            guard hasLocalEdits else { return }
            // Programmatic canvas/appearance callbacks are not an intentional
            // erase. Refuse to checkpoint an unexplained empty saved canvas.
            guard !canvas.drawing.strokes.isEmpty || !savedHadInk || worksheetToolUsed else { return }
        }
        let captured = revision
        try await drafts.checkpoint(snapshot, baseSourceId: baseSourceId, revision: captured)
        if captured == revision, hasLocalEdits { status = "Draft saved on this iPad" }
    }
    @objc private func undoGesture() { guard loaded, !saving, !usingTool else { return }; undo() }
    @objc private func redoGesture() { guard loaded, !saving, !usingTool else { return }; redo() }
    func undo() { canvas.undoManager?.undo(); refreshWorksheetInk(); refreshHistory() }
    func redo() { canvas.undoManager?.redo(); refreshWorksheetInk(); refreshHistory() }

    func worksheetAppearanceChanged(dark: Bool) {
        let delegate = canvas.delegate
        canvas.delegate = nil
        canvas.drawing = worksheetInk(canvas.drawing, dark: false)
        canvas.delegate = delegate
        if ink == .black, tool.usesInk {
            let type: PKInkingTool.InkType = tool == .marker ? .marker : tool == .pencil ? .pencil : .monoline
            canvas.tool = PKInkingTool(type, color: .black, width: tool == .marker ? inkWidth * 5 : inkWidth)
        }
    }

    private func refreshWorksheetInk() {
        let delegate = canvas.delegate
        canvas.delegate = nil
        canvas.drawing = worksheetInk(canvas.drawing, dark: false)
        canvas.delegate = delegate
    }

    private func updateTool() {
        let color: UIColor = ink.color
        canvas.tool = switch tool {
        case .pen: PKInkingTool(.monoline, color: color, width: inkWidth)
        case .pencil: PKInkingTool(.pencil, color: color, width: inkWidth)
        case .marker: PKInkingTool(.marker, color: color, width: inkWidth * 5)
        case .eraser: PKEraserTool(.bitmap, width: eraserWidth)
        case .objectEraser: PKEraserTool(.vector)
        case .lasso: PKLassoTool()
        }
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) { pencilAction(UIPencilInteraction.preferredTapAction) }
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) { pencilAction(UIPencilInteraction.preferredTapAction) }
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        if squeeze.phase == .ended { pencilAction(UIPencilInteraction.preferredSqueezeAction) }
    }
    private func pencilAction(_ action: UIPencilPreferredAction) {
        guard loaded, !saving, !usingTool else { return }
        switch action {
        case .switchEraser: tool = tool == .eraser ? previousTool : .eraser
        case .switchPrevious: tool = previousTool
        case .showColorPalette, .showInkAttributes: showInkOptions = true
        default: break
        }
    }

    func export() async throws -> Data { try await drafts.export(snapshot) }

    private var savedStatus: String { request.answer == nil ? "Saved in note" : "Saved in answer" }

    // Uploaded receipts survive a failed note flush. Retrying the same revision
    // uses the same asset IDs, making publication idempotent.
    func discardLocalChanges() async throws {
        retired = true
        canvas.delegate = nil
        canvas.toolsEnabled = false
        pendingSave?.cancel()
        try await drafts.remove(through: revision)
        uploaded = nil
        hasLocalEdits = false
    }

    func save(asCopy: Bool, publish: (String, String, String, String?, Bool) async throws -> Void) async throws {
        // A worksheet cannot accidentally reach RootView's note publication
        // callback, even if a host presents the wrong editor for the request.
        guard request.answer == nil else { throw CocoaError(.validationMissingMandatoryProperty) }
        try await saveRevision(asCopy: asCopy, publish: publish)
    }

    // Entry for a future anchored worksheet surface using this same model and
    // PKCanvasView. No note commands or note flush participate in publication.
    // Keep the existing offline-development admission checks in Rust intact.
    func saveAnswer(asCopy: Bool) async throws {
        guard let answer = request.answer else { throw CocoaError(.validationMissingMandatoryProperty) }
        let enabled: Bool = try await client.call("question_bank_enabled", Empty())
        guard enabled else { throw CocoaError(.fileWriteNoPermission) }
        let key = try answer.key
        let bank: DrawingAnswerBank? = try await client.call("question_bank_get", ModuleArgs(moduleId: request.module.id))
        // A removed published canvas is not a new canvas, including Save a copy.
        // Never recreate a deliberately deleted answer owner during recovery.
        guard let bank, request.sourceId == nil || bank.answers[key]?.canvases[request.imageId] != nil else {
            throw DrawingFailure.changed
        }
        try await saveRevision(asCopy: asCopy) { _, sourceId, previewId, expected, makingCopy in
            guard let uploaded = self.uploaded else { throw CocoaError(.fileWriteUnknown) }
            let receipt: DrawingAnswerReceipt = try await self.client.call("worksheet_canvas_save", DrawingAnswerSaveArgs(
                moduleId: self.request.module.id, attemptId: answer.attemptId, revisionId: answer.revisionId,
                leafPartId: answer.leafPartId, canvasId: self.request.imageId,
                sourceId: sourceId, previewId: previewId, expectedSourceId: expected,
                width: Double(uploaded.size.width), height: Double(uploaded.size.height), asCopy: makingCopy))
            guard let canvas = receipt.bank.answers[key]?.canvases[self.request.imageId],
                  ([canvas.revision].compactMap { $0 } + canvas.copies).contains(where: { $0.sourceId == sourceId && $0.previewId == previewId }) else {
                throw DrawingFailure.changed
            }
        }
    }

    private func prepareUpload() async throws {
        if uploaded?.revision != revision {
            let capturedRevision = revision
            let captured = snapshot
            // AES-GCM stores a version byte, 12-byte nonce and 16-byte tag.
            let encoded = try await drafts.publication(captured, maximumBytes: SyncConfiguration.integer("MAX_FILE_BYTES") - 29)
            let source: SavedFile = try await client.call("save_file", FileArgs(moduleId: request.module.id, bytes: Array(encoded.source), mimeType: "application/vnd.memnoter.drawing+json"))
            let preview: SavedFile = try await client.call("save_file", FileArgs(moduleId: request.module.id, bytes: Array(encoded.preview), mimeType: "image/png"))
            uploaded = (capturedRevision, source, preview, captured.size)
        }
        guard let uploaded else { throw CocoaError(.fileWriteUnknown) }
        guard uploaded.revision == revision else { throw DrawingFailure.inputChanged }
    }

    // Prepare assets only. The rich answer editor owns conflict checking and
    // publication; its durable acknowledgement is the only draft cleanup gate.
    func prepareWorksheetResult(asCopy: Bool) async throws -> WorksheetDrawingResult {
        guard request.answer != nil, loaded else { throw DrawingFailure.unavailable }
        if requiresCopy && !asCopy { throw DrawingFailure.changed }
        if savedHadInk && canvas.drawing.strokes.isEmpty && !worksheetToolUsed {
            throw DrawingFailure.unavailable
        }
        pendingSave?.cancel()
        try await flush()
        if !hasLocalEdits && !asCopy {
            return WorksheetDrawingResult(status: request.sourceId == nil ? "empty" : "unchanged", hasChanges: false)
        }
        try await prepareUpload()
        guard let uploaded else { throw CocoaError(.fileWriteUnknown) }
        return WorksheetDrawingResult(status: "save", source: uploaded.source, preview: uploaded.preview,
                                      expectedSourceId: baseSourceId, asCopy: asCopy && (request.sourceId != nil || requiresCopy),
                                      hasChanges: hasLocalEdits)
    }

    func discardUnreadableDraft() async throws { try await drafts.remove(through: Int.max) }

    func freezeWorksheetInput() async {
        canvas.drawingGestureRecognizer.isEnabled = false
        canvas.isUserInteractionEnabled = false
        await Task.yield()
        while processingStroke { await Task.yield() }
        usingTool = false
    }

    func suspendWorksheet() async throws {
        pendingSave?.cancel()
        canvas.toolsEnabled = false
        do { try await flush() }
        catch {
            canvas.isUserInteractionEnabled = true
            canvas.drawingGestureRecognizer.isEnabled = true
            canvas.toolsEnabled = true
            throw error
        }
        canvas.delegate = nil
        retired = true
    }

    func acknowledgeWorksheet(sourceId: String, previewId: String) async throws {
        guard request.answer != nil, let uploaded,
              uploaded.source.id == sourceId, uploaded.preview.id == previewId,
              uploaded.revision == revision else { throw DrawingFailure.inputChanged }
        pendingSave?.cancel()
        try await drafts.remove(through: uploaded.revision)
        retired = true
        canvas.delegate = nil
        canvas.toolsEnabled = false
        hasLocalEdits = false; status = savedStatus
    }

    private func saveRevision(asCopy: Bool, publish: (String, String, String, String?, Bool) async throws -> Void) async throws {
        guard loaded else { throw DrawingFailure.unavailable }
        if requiresCopy && !asCopy { throw DrawingFailure.changed }
        pendingSave?.cancel()
        try await flush()
        try await prepareUpload()
        guard let uploaded else { throw CocoaError(.fileWriteUnknown) }
        let makingCopy = asCopy && (request.sourceId != nil || requiresCopy)
        if makingCopy && copyId == nil { copyId = UUID().uuidString }
        // Answer copies belong to the same canvas's copies collection. Note
        // copies keep the existing behavior of inserting a new image node.
        let imageId = makingCopy && request.answer == nil ? copyId! : request.imageId
        try await publish(imageId, uploaded.source.id, uploaded.preview.id, makingCopy ? nil : baseSourceId, makingCopy)
        if !makingCopy { baseSourceId = uploaded.source.id }
        guard uploaded.revision == revision else { try await flush(); throw DrawingFailure.inputChanged }
        // A draft is expendable only after its owner acknowledges a durable save.
        try await drafts.remove(through: uploaded.revision)
        guard uploaded.revision == revision else { try await flush(); throw DrawingFailure.inputChanged }
        hasLocalEdits = false; status = savedStatus
    }
}

struct DrawingSurface: UIViewRepresentable {
    let model: DrawingModel
    func makeUIView(context: Context) -> DrawingCanvas { model.canvas }
    // Do not change isUserInteractionEnabled in this render callback. Disabling
    // a first-responder PKCanvasView causes synchronous UIKit -> SwiftUI focus
    // re-entry. A hit-testing overlay below blocks input while saving/loading.
    func updateUIView(_ view: DrawingCanvas, context: Context) { }
    static func dismantleUIView(_ view: DrawingCanvas, coordinator: ()) { view.toolsEnabled = false }
}

struct DrawingEditor: View {
    @State private var confirmingDiscard = false
    @State private var model: DrawingModel
    let publish: (String, String, String, String?, Bool) async throws -> Void
    let discard: () async throws -> Void
    @State private var exportDocument: DrawingJSONDocument?
    @State private var exporting = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    init(request: DrawingRequest, directory: URL, client: CoreClient, preferences: UserDefaults,
         publish: @escaping (String, String, String, String?, Bool) async throws -> Void,
         discard: @escaping () async throws -> Void) {
        _model = State(initialValue: DrawingModel(request: request, directory: directory, client: client, preferences: preferences))
        self.publish = publish; self.discard = discard
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.white.ignoresSafeArea()
                DrawingSurface(model: model)
                    .ignoresSafeArea()
                if !model.loaded || model.saving {
                    Color.white.opacity(0.001).contentShape(Rectangle()).ignoresSafeArea()
                }
                VStack {
                    HStack {
                        Button { closeDrawing() } label: {
                            Image(systemName: "xmark").font(.system(size: 16, weight: .medium))
                                .foregroundStyle(.primary.opacity(0.7)).frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain).modifier(DrawingGlass())
                        .accessibilityLabel("Close drawing")
                        .disabled(model.saving)
                        .allowsHitTesting(!model.usingTool)
                        Spacer()
                        optionsMenu
                        Button { save(asCopy: model.requiresCopy) } label: {
                            Group {
                                if model.saving { ProgressView().tint(.white) }
                                else { Text("Done").font(.system(size: 15, weight: .semibold)) }
                            }.foregroundStyle(.white).frame(width: 76, height: 44)
                        }
                        .buttonStyle(.plain).background(DrawingStyle.accent, in: Capsule())
                        .accessibilityLabel("Done")
                        .disabled(!model.loaded || model.saving)
                        .allowsHitTesting(!model.usingTool)
                    }.padding(.horizontal, 16).padding(.top, 12)
                    Spacer()
                    DrawingToolBar(model: model)
                        .frame(maxWidth: min(780, max(0, geometry.size.width - 24)))
                        .padding(.horizontal, 12).padding(.bottom, 16)
                }
                if !model.loaded {
                    VStack(spacing: 16) {
                        Text(model.status)
                        if model.loadFailed { Button("Retry") { Task { await model.load() } } }
                        else { ProgressView() }
                    }.padding(24).background(.white, in: RoundedRectangle(cornerRadius: 16))
                        .shadow(color: .black.opacity(0.08), radius: 20)
                }
            }
        }
        .background(.white)
        .tint(DrawingStyle.accent)
        .statusBarHidden(true)
        .task { await model.load(); model.worksheetAppearanceChanged(dark: colorScheme == .dark) }
        .onChange(of: colorScheme) { _, scheme in model.worksheetAppearanceChanged(dark: scheme == .dark) }
        .onChange(of: scenePhase) { _, phase in
            guard phase != .active, model.loaded else { return }
            model.checkpointView()
            let token = UIApplication.shared.beginBackgroundTask(withName: "Save drawing draft")
            Task {
                defer { UIApplication.shared.endBackgroundTask(token) }
                do { try await model.flush() } catch { model.error = error.localizedDescription }
            }
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "drawing-strokes") { result in
            if case .failure(let error) = result { model.error = error.localizedDescription }
        }
        .confirmationDialog("Discard local changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard local changes", role: .destructive) {
                perform {
                    try await model.discardLocalChanges()
                    if model.request.isNew { try await discard() }
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: { Text("This removes the local draft and returns to the note. The drawing saved in the note is kept.") }
        .alert("Drawing", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .interactiveDismissDisabled()
    }
    private var optionsMenu: some View {
        Menu {
            Text(model.status)
            Toggle("Draw with finger", isOn: $model.fingerDrawing)
            DrawingPaperPicker(model: model)
            Button("Save a copy", systemImage: "doc.on.doc") { save(asCopy: true) }
            if model.hasLocalEdits {
                Button("Discard local changes", systemImage: "trash", role: .destructive) { confirmingDiscard = true }
            }
            Button("Export strokes", systemImage: "square.and.arrow.up") {
                Task {
                    do { exportDocument = DrawingJSONDocument(data: try await model.export()); exporting = true }
                    catch { model.error = error.localizedDescription }
                }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.primary.opacity(0.7)).frame(width: 44, height: 44)
                .modifier(DrawingGlass())
        }
        .accessibilityLabel("Drawing options")
        .disabled(!model.loaded || model.saving)
        .allowsHitTesting(!model.usingTool)
    }
    private func closeDrawing() {
        perform {
            if !model.loaded { dismiss(); return }
            if model.hasLocalEdits { try await model.flush() }
            else if model.request.isNew { try await discard() }
            dismiss()
        }
    }
    private func save(asCopy: Bool) {
        perform {
            if !model.hasLocalEdits && (model.request.sourceId == nil || !asCopy) {
                if model.request.isNew { try await discard() }
            } else { try await model.save(asCopy: asCopy, publish: publish) }
            dismiss()
        }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !model.saving, !model.usingTool else { return }
        model.checkpointView()
        model.saving = true
        Task {
            defer { model.saving = false }
            do { try await operation() }
            catch { model.error = error.localizedDescription }
        }
    }
}

/// Deliberately conservative: ordinary letters move forward; hatching generally
/// advances monotonically on its other axis. A deletion scratch must rapidly
/// reverse on BOTH axes and revisit the same compact area over existing ink.
private enum ScribbleDeletion {
    static func reversals(_ values: [CGFloat], threshold: CGFloat) -> Int {
        guard let first = values.first else { return 0 }
        var extreme = first, direction: CGFloat = 0, count = 0
        for value in values.dropFirst() {
            if direction == 0 {
                if abs(value - extreme) >= threshold { direction = value > extreme ? 1 : -1; extreme = value }
            } else if (value - extreme) * direction >= 0 { extreme = value }
            else if abs(value - extreme) >= threshold { count += 1; direction = -direction; extreme = value }
        }
        return count
    }
    static func region(for stroke: PKStroke) -> CGPath? {
        let path = stroke.path
        guard path.count >= 14, let first = path.first, let last = path.last else { return nil }
        let duration = last.timeOffset - first.timeOffset
        guard duration > 0, duration <= 1.2 else { return nil }
        let points = path.map { $0.location.applying(stroke.transform) }
        let box = points.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: CGSize(width: 0.01, height: 0.01))) }
        guard box.width >= 24, box.height >= 12, box.width <= 320, box.height <= 320 else { return nil }
        let horizontal = box.width >= box.height
        guard reversals(points.map { horizontal ? $0.x : $0.y }, threshold: 12) >= 6,
              reversals(points.map { horizontal ? $0.y : $0.x }, threshold: 4) >= 2 else { return nil }
        let length = zip(points, points.dropFirst()).reduce(CGFloat.zero) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
        guard length > max(box.width, box.height) * 5, length / duration > 250,
              let start = points.first, let end = points.last,
              hypot(end.x - start.x, end.y - start.y) < max(box.width, box.height) * 0.8 else { return nil }
        let outline = CGMutablePath(); outline.move(to: start)
        for point in points.dropFirst() { outline.addLine(to: point) }
        return outline.copy(strokingWithWidth: 22, lineCap: .round, lineJoin: .round, miterLimit: 1)
    }
    static func intersects(_ stroke: PKStroke, region: CGPath, bounds: CGRect) -> Bool {
        // A bitmap-erased stroke's centreline also traverses invisible regions.
        // Never delete its remaining ink based on an invisible crossing.
        guard stroke.mask == nil else { return false }
        guard bounds.intersects(stroke.renderBounds) else { return false }
        let points = stroke.path.map { $0.location.applying(stroke.transform) }
        if points.contains(where: { region.contains($0) }) { return true }
        for (a, b) in zip(points, points.dropFirst()) {
            let distance = hypot(b.x - a.x, b.y - a.y)
            let count = min(512, max(1, Int(distance / 6)))
            for sample in 1..<count {
                let t = CGFloat(sample) / CGFloat(count)
                if region.contains(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)) { return true }
            }
        }
        return false
    }
}

// PencilKit adapts canonical black ink to white in dark appearance itself.
// Never feed it manually whitened ink: it inverts that back to invisible black.
// Normalize old white drafts on load; preserve paths, masks and seeds.
private func worksheetInk(_ drawing: PKDrawing, dark: Bool) -> PKDrawing {
    PKDrawing(strokes: drawing.strokes.map { original in
        var stroke = original
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        if stroke.ink.color.getRed(&r, green: &g, blue: &b, alpha: &a),
           (r < 0.001 && g < 0.001 && b < 0.001) || (r > 0.999 && g > 0.999 && b > 0.999) {
            stroke.ink = PKInk(stroke.ink.inkType, color: (dark ? UIColor.white : UIColor.black).withAlphaComponent(a))
        }
        return stroke
    })
}

// Compare actual canonical strokes, independent of page growth, appearance,
// PencilKit archive metadata, and whether a Mac file includes geometry.
private func worksheetInkFingerprint(_ drawing: PKDrawing) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(DrawingStrokeExport(drawing: worksheetInk(drawing, dark: false), page: CGSize(width: 1024, height: 1440)).strokes)
}
