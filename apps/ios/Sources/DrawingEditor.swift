import SwiftUI
import PencilKit
import UniformTypeIdentifiers

// Local recovery checkpoints; published drawing documents use managed assets.
actor DrawingDraftStore {
    let url: URL
    private var writtenRevision = -1
    private var publishedRevision = -1

    init(directory: URL, moduleId: String) {
        // Module IDs are UUIDs, but do not let a malformed ID become a path.
        let name = Data(moduleId.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
        url = directory.appendingPathComponent("drawing-prototypes", isDirectory: true)
            .appendingPathComponent(name).appendingPathExtension("drawing")
    }

    func load() throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }

    func save(_ data: Data, revision: Int) throws {
        guard revision >= writtenRevision, revision > publishedRevision else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        writtenRevision = revision
    }
    func remove(through revision: Int) throws {
        if writtenRevision <= revision, FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
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
    private let history = UndoManager()
    private var updatingViewport = false
    private var pendingTop: CGFloat?
    private(set) var documentSize = DrawingModel.page
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
    private var viewKey: String { "drawing.viewport.\(request.module.id)/\(request.imageId)" }
    private var pendingSave: Task<Void, Never>?
    private var revision = 0
    private var baseSourceId: String?
    private var uploaded: (revision: Int, source: SavedFile, preview: SavedFile)?
    private var copyId: String?
    private let pencilInteraction = UIPencilInteraction()
    private var previousTool: DrawingTool = .pen
    var tool: DrawingTool = .pen {
        didSet { if tool != oldValue { previousTool = oldValue }; updateTool(); preferences.set(tool.rawValue, forKey: "drawing.tool") }
    }
    var ink: DrawingInk = .black { didSet { updateTool(); preferences.set(ink.rawValue, forKey: "drawing.ink") } }
    var inkWidth: CGFloat = 3 { didSet { updateTool(); preferences.set(Double(inkWidth), forKey: "drawing.width") } }
    var showInkOptions = false
    var loaded = false
    var loadFailed = false
    var saving = false
    var status = "Opening drawing…"
    var error: String?
    var canUndo = false
    var canRedo = false
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
        fingerDrawing = preferences.bool(forKey: "drawing.finger")
        baseSourceId = request.sourceId
        drafts = DrawingDraftStore(directory: directory, moduleId: "\(request.module.id)/\(request.imageId)")
        prototype = DrawingDraftStore(directory: directory, moduleId: request.module.id)
        super.init()
        canvas.backgroundColor = .white; canvas.isOpaque = true
        canvas.overrideUserInterfaceStyle = .light
        canvas.contentSize = Self.page
        canvas.maximumSupportedContentVersion = .version2
        canvas.drawingPolicy = fingerDrawing ? .anyInput : .pencilOnly
        updateTool()
        pencilInteraction.delegate = self
        canvas.addInteraction(pencilInteraction)
        canvas.accessibilityLabel = "Drawing canvas"
    }

    func load() async {
        guard !loaded else { return }
        loadFailed = false; error = nil; status = "Opening drawing…"
        do {
            let document: DrawingDocument?
            if let draft = try await drafts.loadDraft() {
                document = draft.document
                requiresCopy = draft.baseSourceId != request.sourceId
                hasLocalEdits = true
            } else if let source = request.sourceId {
                let file: DrawingFileContents
                do { file = try await client.call("read_file", DrawingFileArgs(moduleId: request.module.id, fileId: source)) }
                catch { throw DrawingFailure.unavailable }
                document = try await drafts.decodeDocument(Data(file.bytes))
            } else if request.importPrototype {
                guard let data = try await prototype.load() else { throw DrawingFailure.unavailable }
                document = DrawingDocument(version: 1, nativeData: data, width: Self.page.width, height: Self.page.height, geometry: nil)
                hasLocalEdits = true
            } else { document = nil }
            if let document {
                canvas.drawing = try await drafts.decodeDrawing(document)
                canvas.restoreSize(CGSize(width: document.width, height: document.height))
            }
            if let data = preferences.data(forKey: viewKey),
               let state = try? JSONDecoder().decode(DrawingViewState.self, from: data) { canvas.restoreView(state) }
            canvas.delegate = self
            loaded = true
            status = hasLocalEdits ? "Recovered unsaved changes" : "Saved in note"
            canvas.toolsEnabled = true
            refreshHistory()
        } catch {
            loadFailed = true
            self.error = error.localizedDescription
            status = "Could not open drawing"
        }
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { usingTool = true; pendingSave?.cancel() }
    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) { usingTool = false; scheduleSave() }
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        canvas.keepWritingRoom()
        revision += 1; hasLocalEdits = true
        refreshHistory(); status = "Unsaved changes"
        if !usingTool { scheduleSave() }
    }
    private func refreshHistory() { canUndo = canvas.undoManager?.canUndo == true; canRedo = canvas.undoManager?.canRedo == true }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { canvas.keepWritingRoom() }
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
    private var snapshot: DrawingSnapshot { DrawingSnapshot(drawing: canvas.drawing, size: canvas.documentSize) }
    func flush() async throws {
        guard loaded, hasLocalEdits else { return }
        let captured = revision
        try await drafts.checkpoint(snapshot, baseSourceId: baseSourceId, revision: captured)
        if captured == revision, hasLocalEdits { status = "Draft saved on this iPad" }
    }
    func undo() { canvas.undoManager?.undo(); refreshHistory() }
    func redo() { canvas.undoManager?.redo(); refreshHistory() }

    private func updateTool() {
        canvas.tool = switch tool {
        case .pen: PKInkingTool(.monoline, color: ink.color, width: inkWidth)
        case .pencil: PKInkingTool(.pencil, color: ink.color, width: inkWidth)
        case .marker: PKInkingTool(.marker, color: ink.color, width: inkWidth * 5)
        case .eraser: PKEraserTool(.bitmap)
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

    // Uploaded receipts survive a failed note flush. Retrying the same revision
    // uses the same asset IDs, making publication idempotent.
    func discardLocalChanges() async throws {
        pendingSave?.cancel()
        try await drafts.remove(through: revision)
        uploaded = nil
        hasLocalEdits = false
    }

    func save(asCopy: Bool, publish: (String, String, String, String?, Bool) async throws -> Void) async throws {
        guard loaded else { throw DrawingFailure.unavailable }
        if requiresCopy && !asCopy { throw DrawingFailure.changed }
        pendingSave?.cancel()
        try await flush()
        if uploaded?.revision != revision {
            let capturedRevision = revision
            // AES-GCM stores a version byte, 12-byte nonce and 16-byte tag.
            let encoded = try await drafts.publication(snapshot, maximumBytes: SyncConfiguration.integer("MAX_FILE_BYTES") - 29)
            let source: SavedFile = try await client.call("save_file", FileArgs(moduleId: request.module.id, bytes: Array(encoded.source), mimeType: "application/vnd.memnoter.drawing+json"))
            let preview: SavedFile = try await client.call("save_file", FileArgs(moduleId: request.module.id, bytes: Array(encoded.preview), mimeType: "image/png"))
            uploaded = (capturedRevision, source, preview)
        }
        guard let uploaded else { throw CocoaError(.fileWriteUnknown) }
        guard uploaded.revision == revision else { throw DrawingFailure.inputChanged }
        let makingCopy = asCopy && (request.sourceId != nil || requiresCopy)
        if makingCopy && copyId == nil { copyId = UUID().uuidString }
        try await publish(makingCopy ? copyId! : request.imageId, uploaded.source.id, uploaded.preview.id, makingCopy ? nil : baseSourceId, makingCopy)
        if !makingCopy { baseSourceId = uploaded.source.id }
        guard uploaded.revision == revision else { try await flush(); throw DrawingFailure.inputChanged }
        // A draft is expendable only after the note has acknowledged its save.
        try await drafts.remove(through: uploaded.revision)
        guard uploaded.revision == revision else { try await flush(); throw DrawingFailure.inputChanged }
        hasLocalEdits = false; status = "Saved in note"
    }
}

private struct DrawingSurface: UIViewRepresentable {
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
                                .foregroundStyle(.black.opacity(0.7)).frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain).background(.white, in: Circle())
                        .shadow(color: .black.opacity(0.08), radius: 12, y: 3)
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
        .preferredColorScheme(.light)
        .tint(DrawingStyle.accent)
        .statusBarHidden(true)
        .task { await model.load() }
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
                    if model.request.sourceId == nil { try await discard() }
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
                .foregroundStyle(.black.opacity(0.7)).frame(width: 44, height: 44)
                .background(.white, in: Circle())
                .shadow(color: .black.opacity(0.08), radius: 12, y: 3)
        }
        .accessibilityLabel("Drawing options")
        .disabled(!model.loaded || model.saving)
        .allowsHitTesting(!model.usingTool)
    }
    private func closeDrawing() {
        perform {
            if !model.loaded { dismiss(); return }
            if model.hasLocalEdits { try await model.flush() }
            else if model.request.sourceId == nil { try await discard() }
            dismiss()
        }
    }
    private func save(asCopy: Bool) {
        perform {
            if model.request.sourceId != nil && !model.hasLocalEdits && !asCopy { dismiss(); return }
            if model.request.sourceId == nil && !model.hasLocalEdits { try await discard() }
            else { try await model.save(asCopy: asCopy, publish: publish) }
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

