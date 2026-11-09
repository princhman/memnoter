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

enum InkTool: String, CaseIterable {
    case pen, pencil, marker, eraser
    var symbol: String {
        switch self {
        case .pen: "pencil.tip"
        case .pencil: "pencil"
        case .marker: "highlighter"
        case .eraser: "eraser"
        }
    }
}

enum InkColor: String, CaseIterable {
    case black, blue, red, green, purple, orange
    var value: NSColor {
        let rgb: UInt32 = switch self {
        case .black: 0x171717
        case .blue: 0x2455DA
        case .red: 0xD32F40
        case .green: 0x14804A
        case .purple: 0x713AC7
        case .orange: 0xDA7817
        }
        return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255,
                       green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }
}

actor DrawingStorage {
    let request: EditorRequest
    private var revision = -1
    private var discarded = false
    init(_ request: EditorRequest) { self.request = request }

    func load() throws -> (PKDrawing, Double, Double, String?, Bool) {
        let draftURL = URL(fileURLWithPath: request.draftPath)
        if FileManager.default.fileExists(atPath: draftURL.path) {
            let draft = try JSONDecoder().decode(LocalDraft.self, from: Data(contentsOf: draftURL))
            try draft.document.validate()
            return (try PKDrawing(data: draft.document.nativeData), draft.document.width, draft.document.height, draft.baseSourceId, true)
        }
        if let sourcePath = request.sourcePath {
            let document = try JSONDecoder().decode(DrawingDocument.self, from: Data(contentsOf: URL(fileURLWithPath: sourcePath)))
            try document.validate()
            return (try PKDrawing(data: document.nativeData), document.width, document.height, request.sourceId, false)
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

    func publication(_ drawing: PKDrawing, width: Double, height: Double) throws -> (String, String) {
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: width, height: height, geometry: nil)
        try document.validate()
        guard drawing.requiredContentVersion.rawValue <= PKContentVersion.version2.rawValue else {
            throw NSError(domain: "Drawing", code: 2, userInfo: [NSLocalizedDescriptionKey: "This ink requires a newer iPad version. Your Mac draft is safe."])
        }
        let source = try JSONEncoder().encode(document)
        guard source.count <= request.maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        let bounds = drawing.bounds
        let rect = bounds.isNull || bounds.isEmpty ? CGRect(x: 0, y: 0, width: 640, height: 240) : bounds.insetBy(dx: -24, dy: -24)
        let scale = min(2, 2048 / max(rect.width, rect.height))
        let pixelSize = CGSize(width: max(1, ceil(rect.width * scale)), height: max(1, ceil(rect.height * scale)))
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(pixelSize.width), pixelsHigh: Int(pixelSize.height), bitsPerSample: 8,
                                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw CocoaError(.fileWriteUnknown) }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor.white.setFill(); CGRect(origin: .zero, size: pixelSize).fill()
        NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
            drawing.image(from: rect, scale: scale).draw(in: CGRect(origin: .zero, size: pixelSize))
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

@MainActor final class DrawingModel: NSObject, ObservableObject {
    let request: EditorRequest
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
    var viewKey: String { "viewport.\(request.moduleId)/\(request.imageId)" }
    var requiresCopy: Bool { baseSourceId != request.sourceId }
    var ink: PKInk {
        switch tool {
        case .pencil: PKInk(.pencil, color: color.value)
        case .marker: PKInk(.marker, color: color.value)
        default: PKInk(.monoline, color: color.value)
        }
    }
    var strokeWidth: CGFloat { width * (tool == .marker ? 5 : 1) }

    init(_ request: EditorRequest) {
        self.request = request; storage = DrawingStorage(request)
        preferences = UserDefaults(suiteName: "com.memnoter.mac.drawing.\(request.preferencesScope)")!
        super.init()
        tool = InkTool(rawValue: preferences.string(forKey: "tool") ?? "") ?? .pen
        color = InkColor(rawValue: preferences.string(forKey: "color") ?? "") ?? .black
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
                let files = try await storage.publication(drawing, width: paperWidth, height: paperHeight)
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

final class PaperView: NSView {
    let model: DrawingModel
    var drawing = PKDrawing()
    var points: [PKStrokePoint] = []
    var livePath = NSBezierPath()
    private var started = 0.0
    private var revision = -1
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    init(_ model: DrawingModel) { self.model = model; super.init(frame: .zero); appearance = NSAppearance(named: .aqua) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    func refresh() {
        if revision != model.revision { drawing = model.drawing; revision = model.revision; needsDisplay = true }
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); dirtyRect.fill()
        let visible = dirtyRect.intersection(visibleRect).intersection(bounds)
        if !drawing.strokes.isEmpty, !visible.isEmpty {
            NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
                drawing.image(from: visible, scale: window?.backingScaleFactor ?? 2)
                    .draw(in: visible, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        if !points.isEmpty {
            model.color.value.withAlphaComponent(model.tool == .marker ? 0.35 : 1).setStroke()
            livePath.lineWidth = model.strokeWidth; livePath.lineCapStyle = .round; livePath.lineJoinStyle = .round; livePath.stroke()
        }
    }
    override func mouseDown(with event: NSEvent) {
        guard model.loaded, !model.saving else { return }
        window?.makeFirstResponder(self)
        model.usingTool = true
        points.removeAll(); livePath = NSBezierPath(); started = event.timestamp
        sample(event)
    }
    override func mouseDragged(with event: NSEvent) { if model.loaded && !model.saving { sample(event) } }
    override func mouseUp(with event: NSEvent) {
        guard model.loaded, !model.saving else { return }
        sample(event)
        if model.tool != .eraser, !points.isEmpty {
            let stroke = PKStroke(ink: model.ink, path: PKStrokePath(controlPoints: points, creationDate: Date()))
            drawing = drawing.appending(PKDrawing(strokes: [stroke]))
        }
        points.removeAll(); livePath = NSBezierPath(); model.commit(drawing); model.usingTool = false; needsDisplay = true
    }
    private func sample(_ event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard p.x >= 0, p.x <= model.paperWidth, p.y >= 0, p.y < 1_000_000 else { return }
        if model.tool == .eraser {
            let kept = drawing.strokes.filter { stroke in
                guard stroke.renderBounds.insetBy(dx: -12, dy: -12).contains(p) else { return true }
                if let mask = stroke.mask, !mask.contains(p.applying(stroke.transform.inverted())) { return true }
                for point in stroke.path.interpolatedPoints(by: .distance(3)) {
                    let location = point.location.applying(stroke.transform)
                    if hypot(location.x - p.x, location.y - p.y) <= max(12, max(point.size.width, point.size.height) / 2) { return false }
                }
                return true
            }
            if kept.count != drawing.strokes.count { drawing = PKDrawing(strokes: kept); needsDisplay = true }
            return
        }
        let size = CGSize(width: model.strokeWidth, height: model.strokeWidth)
        let elapsed = max(0, event.timestamp - started)
        points.append(PKStrokePoint(location: p, timeOffset: elapsed, size: size, opacity: 1,
                                    force: event.pressure > 0 ? CGFloat(event.pressure) : 1, azimuth: 0, altitude: .pi / 2))
        if points.count == 1 { livePath.move(to: p); livePath.line(to: CGPoint(x: p.x + 0.01, y: p.y)) }
        else { livePath.line(to: p) }
        if p.y > model.paperHeight - 500 { model.paperHeight = min(1_000_000, p.y + 1440); enclosingScrollView?.needsLayout = true }
        needsDisplay = true
    }
}

final class PaperScroll: NSScrollView {
    let paper: PaperView
    private var restored = false
    init(_ model: DrawingModel) {
        paper = PaperView(model); super.init(frame: .zero)
        documentView = paper; hasVerticalScroller = true; hasHorizontalScroller = false
        drawsBackground = true; backgroundColor = .white
        contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: contentView)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    deinit { NotificationCenter.default.removeObserver(self) }
    override func layout() {
        let top = restored ? paper.visibleRect.minY : paper.model.scrollTop
        super.layout()
        guard contentSize.width > 0, paper.model.loaded else { return }
        let fit = contentSize.width / paper.model.paperWidth
        let size = CGSize(width: contentSize.width, height: paper.model.paperHeight * fit)
        if paper.frame.size != size {
            paper.setFrameSize(size); paper.setBoundsSize(CGSize(width: paper.model.paperWidth, height: paper.model.paperHeight))
            contentView.scroll(to: CGPoint(x: 0, y: top * fit)); reflectScrolledClipView(contentView)
        }
        if !restored { contentView.scroll(to: CGPoint(x: 0, y: top * fit)); reflectScrolledClipView(contentView); restored = true }
    }
    @objc private func scrolled() {
        guard restored else { return }
        paper.model.scrollTop = max(0, paper.visibleRect.minY)
        paper.model.preferences.set(paper.model.scrollTop, forKey: paper.model.viewKey)
        if paper.visibleRect.maxY > paper.model.paperHeight - 400 {
            paper.model.paperHeight = min(1_000_000, paper.visibleRect.maxY + 1440); needsLayout = true
        }
    }
}

struct Canvas: NSViewRepresentable {
    @ObservedObject var model: DrawingModel
    func makeNSView(context: Context) -> PaperScroll { PaperScroll(model) }
    func updateNSView(_ scroll: PaperScroll, context: Context) { scroll.paper.refresh(); scroll.needsLayout = true }
}

struct DrawingScreen: View {
    @ObservedObject var model: DrawingModel
    @State private var widths = false
    @State private var confirmingDiscard = false
    private let purple = Color(red: 67 / 255, green: 47 / 255, blue: 200 / 255)
    var body: some View {
        ZStack {
            Color.white
            Canvas(model: model)
            VStack {
                HStack {
                    Button { model.close() } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }.accessibilityLabel("Close drawing")
                    Spacer()
                    if model.requiresCopy {
                        Text("This drawing changed elsewhere.").font(.caption)
                        Button("Discard local changes", role: .destructive) { confirmingDiscard = true }
                    }
                    Menu {
                        Button("Save a copy") { model.done(copy: true) }
                        if model.hasChanges {
                            Divider()
                            Button("Discard local changes", role: .destructive) { confirmingDiscard = true }
                        }
                    } label: { Image(systemName: "ellipsis").frame(width: 40, height: 40) }
                    Button { model.done(copy: model.requiresCopy) } label: {
                        Group { if model.saving { ProgressView().controlSize(.small) } else { Text(model.requiresCopy ? "Save a copy" : "Done").fontWeight(.semibold) } }
                            .foregroundStyle(.white).frame(width: model.requiresCopy ? 110 : 76, height: 40).background(purple, in: Capsule())
                    }.accessibilityLabel("Done").disabled(!model.loaded || model.saving)
                }.buttonStyle(.plain).padding(14)
                    .allowsHitTesting(!model.usingTool)
                Spacer()
                HStack(spacing: 5) {
                    icon("Undo", "arrow.uturn.backward", enabled: !model.undoStack.isEmpty) { model.undo() }
                    icon("Redo", "arrow.uturn.forward", enabled: !model.redoStack.isEmpty) { model.redo() }
                    Divider().frame(height: 25)
                    ForEach(InkTool.allCases, id: \.self) { tool in icon(tool.rawValue.capitalized, tool.symbol, selected: model.tool == tool) { model.tool = tool } }
                    Divider().frame(height: 25)
                    ForEach(InkColor.allCases, id: \.self) { color in
                        Button { model.color = color; if model.tool == .eraser { model.tool = .pen } } label: {
                            Circle().fill(Color(nsColor: color.value)).frame(width: 21, height: 21)
                                .overlay { if model.color == color { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white) } }
                                .frame(width: 34, height: 40)
                        }.accessibilityLabel("\(color.rawValue.capitalized) ink")
                    }
                    Divider().frame(height: 25)
                    Button { widths = true } label: {
                        Circle().fill(Color(nsColor: model.color.value)).frame(width: max(3, model.width * 1.5), height: max(3, model.width * 1.5)).frame(width: 40, height: 40)
                    }.accessibilityLabel("Stroke width").popover(isPresented: $widths) {
                        VStack(alignment: .leading, spacing: 18) {
                            Text("Stroke width").font(.headline)
                            Slider(value: $model.width, in: 1...10, step: 0.5).accessibilityLabel("Stroke width")
                            HStack { ForEach([1.5, 3.0, 6.0], id: \.self) { width in
                                Button { model.width = width } label: { Capsule().fill(Color(nsColor: model.color.value)).frame(width: 50, height: width).frame(width: 64, height: 40) }
                                    .accessibilityLabel("\(width.formatted()) point stroke")
                            } }
                        }.padding(24).frame(width: 250)
                    }
                }.buttonStyle(.plain).padding(10).background(.white, in: Capsule()).shadow(color: .black.opacity(0.12), radius: 16, y: 4)
                    .padding(.bottom, 18).disabled(!model.loaded || model.saving)
                    .allowsHitTesting(!model.usingTool)
            }
            if !model.loaded { VStack { ProgressView(); Text("Opening drawing…") }.padding(20).background(.white, in: RoundedRectangle(cornerRadius: 12)) }
        }.background(.white).foregroundStyle(.black).preferredColorScheme(.light).tint(purple)
            .frame(minWidth: 720, minHeight: 520)
            .task { await model.load() }
            .confirmationDialog("Discard local changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard local changes", role: .destructive) { model.discardLocalChanges() }
                Button("Cancel", role: .cancel) { }
            } message: { Text("This removes the local draft and returns to the note. The drawing saved in the note is kept.") }
            .alert("Drawing", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("OK") { model.error = nil }
            } message: { Text(model.error ?? "") }
    }
    private func icon(_ title: String, _ symbol: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(selected ? purple : .black.opacity(0.7))
                .frame(width: 40, height: 40).background(selected ? purple.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 10))
        }.accessibilityLabel(title).disabled(!enabled)
    }
}
