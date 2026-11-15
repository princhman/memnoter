import SwiftUI
import Observation
import UniformTypeIdentifiers

/// One embedded answer session. No note editor command or legacy canvas save is
/// used here: JavaScript publishes the returned assets into its own Yjs answer.
@MainActor @Observable final class WorksheetDrawingBridge {
    private(set) var request: DrawingRequest?
    private(set) var model: DrawingModel?
    private(set) var awaitingCommit = false
    @ObservationIgnored private var pendingCommits: [String: DrawingModel] = [:]
    private let client: CoreClient
    private let directory: URL
    private let preferences: UserDefaults
    @ObservationIgnored private var closing = false
    @ObservationIgnored private var completion: CheckedContinuation<String, Error>?

    init(client: CoreClient, directory: URL, preferences: UserDefaults) {
        self.client = client; self.directory = directory; self.preferences = preferences
    }

    private func decode(_ args: [String: Any]) throws -> DrawingRequest {
        func identity(_ key: String) throws -> String {
            guard let value = args[key] as? String, !value.isEmpty, value.utf8.count <= 256 else {
                throw CocoaError(.validationMissingMandatoryProperty)
            }
            return value
        }
        let module = NoteModule(id: try identity("moduleId"), name: "Worksheet answer", heading_numbering: false)
        let owner = DrawingAnswerOwner(attemptId: try identity("attemptId"), revisionId: try identity("revisionId"), leafPartId: try identity("leafPartId"))
        let source = args["sourceId"] as? String
        if let value = args["sourceId"], !(value is NSNull), source == nil { throw CocoaError(.coderInvalidValue) }
        return DrawingRequest(module: module, imageId: try identity("imageId"), sourceId: source, isNew: source == nil, answer: owner, answerLabel: (args["displayLabel"] as? String).map { String($0.prefix(128)) })
    }

    func open(_ args: [String: Any]) async throws -> String {
        let next = try decode(args)
        guard completion == nil, request == nil else {
            throw NSError(domain: "WorksheetDrawing", code: 1, userInfo: [NSLocalizedDescriptionKey: "Save or close the current answer drawing first."])
        }
        let enabled: Bool = try await client.call("question_bank_enabled", Empty())
        guard enabled else { throw CocoaError(.fileWriteNoPermission) }
        // Validate the pinned answer against the live core before showing ink.
        let owner = next.answer!
        let _: JSONValue = try await client.call("worksheet_answer_document_load", WorksheetDrawingOwnerArgs(
            moduleId: next.module.id, attemptId: owner.attemptId, revisionId: owner.revisionId, leafPartId: owner.leafPartId))
        // Another open may have arrived while core validation was suspended.
        guard request == nil else { throw DrawingFailure.changed }
        model = DrawingModel(request: next, directory: directory, client: client, preferences: preferences)
        request = next
        awaitingCommit = false
        closing = false
        return try await withCheckedThrowingContinuation { completion = $0 }
    }

    func save(asCopy: Bool) {
        guard let model, !model.saving, completion != nil else { return }
        Task {
            while model.usingTool || model.processingStroke, self.model === model {
                try? await Task.sleep(for: .milliseconds(16))
            }
            guard self.model === model, !model.saving, completion != nil else { return }
            model.saving = true; model.checkpointView(); model.error = nil
            do {
                let result = try await model.prepareWorksheetResult(asCopy: asCopy)
                guard self.model === model, completion != nil, !closing else { return }
                let json = try result.json()
                let callback = completion; completion = nil
                if result.status == "save" {
                    pendingCommits[model.request.storageId] = model
                    // The web answer owns publish errors and Retry. Keep native
                    // recovery ink until its durable acknowledgement arrives.
                    model.canvas.isUserInteractionEnabled = false
                    self.model = nil; request = nil; awaitingCommit = false
                } else {
                    model.saving = false; self.model = nil; request = nil
                }
                callback?.resume(returning: json)
            } catch {
                guard self.model === model else { return }
                model.saving = false; model.error = error.localizedDescription
            }
        }
    }

    func committed(_ args: [String: Any]) async throws -> String {
        let owner = try decode(args)
        let discarded = args["discarded"] as? Bool == true
        if let pending = pendingCommits[owner.storageId], request?.storageId != owner.storageId {
            if discarded { try await pending.discardLocalChanges() }
            else {
                guard let source = args["publishedSourceId"] as? String, let preview = args["publishedPreviewId"] as? String else { throw DrawingFailure.changed }
                try await pending.acknowledgeWorksheet(sourceId: source, previewId: preview)
            }
            pendingCommits.removeValue(forKey: owner.storageId)
        } else if let request, request.storageId == owner.storageId, let model {
            // A deletion can arrive while native open is still pending. Disable
            // checkpoints before removing its scoped recovery file (#33).
            if discarded {
                guard !model.saving || awaitingCommit else { throw DrawingFailure.inputChanged }
                model.saving = true
                try await model.discardLocalChanges()
            } else {
                guard awaitingCommit, let source = args["publishedSourceId"] as? String,
                      let preview = args["publishedPreviewId"] as? String else { throw DrawingFailure.changed }
                try await model.acknowledgeWorksheet(sourceId: source, previewId: preview)
            }
            let callback = completion; completion = nil
            self.model = nil; self.request = nil; awaitingCommit = false
            callback?.resume(returning: try WorksheetDrawingResult(status: "discarded").json())
        } else {
            // Retry after web reload or a closed pane. Identity remains answer
            // scoped, so cleanup cannot affect a drawing in another answer.
            guard request == nil || request?.storageId != owner.storageId else { throw DrawingFailure.changed }
            let drafts = DrawingDraftStore(directory: directory, moduleId: owner.storageId)
            try await drafts.remove(through: Int.max)
        }
        return "null"
    }

    func hasUnsavedDraft(_ args: [String: Any]) async throws -> String {
        let owner = try decode(args)
        let drafts = DrawingDraftStore(directory: directory, moduleId: owner.storageId)
        var saved: DrawingDocument?
        if let source = owner.sourceId {
            let file: DrawingFileContents = try await client.call("read_file", DrawingFileArgs(moduleId: owner.module.id, fileId: source))
            saved = try await drafts.decodeDocument(Data(file.bytes))
        }
        return try await drafts.worksheetDraft(sourceId: owner.sourceId, saved: saved) == nil ? "false" : "true"
    }

    func cancel() async throws {
        guard let model, !closing else { return }
        closing = true
        defer { closing = false }
        model.saving = true
        await model.freezeWorksheetInput()
        model.checkpointView()
        do {
            try await model.suspendWorksheet()
            guard self.model === model else { return }
            let callback = completion; completion = nil
            self.model = nil; request = nil; awaitingCommit = false
            callback?.resume(returning: try WorksheetDrawingResult(status: "cancel", hasChanges: model.hasLocalEdits).json())
        } catch {
            model.saving = false; model.error = error.localizedDescription
            throw error
        }
    }

    func discardUnreadableDraft() async {
        guard let model, model.loadFailed, let request else { return }
        do {
            try await model.discardUnreadableDraft()
            let replacement = DrawingModel(request: request, directory: directory, client: client, preferences: preferences)
            self.model = replacement
            await replacement.load()
        } catch { model.error = error.localizedDescription }
    }

}

private struct WorksheetDrawingOwnerArgs: Encodable, Sendable {
    let moduleId, attemptId, revisionId, leafPartId: String
}

/// The shell places this below the real WebSurface in a resizable drawer.
/// This view never presents a sheet or substitutes a question preview.
struct WorksheetDrawingPane: View {
    @Bindable var bridge: WorksheetDrawingBridge
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @State private var exportDocument: DrawingJSONDocument?
    @State private var exporting = false
    var paletteOffset: CGFloat = 0

    var body: some View {
        if let model = bridge.model, let request = bridge.request {
            GeometryReader { geometry in
            ZStack {
                DrawingSurface(model: model)
                    .allowsHitTesting(model.loaded && !model.saving)
                VStack(spacing: 0) {
                HStack {
                    Button { Task { try? await bridge.cancel() } } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .buttonStyle(.plain).modifier(DrawingGlass()).accessibilityLabel("Cancel")
                    Text(request.answerLabel ?? "Drawing").font(.headline).padding(.horizontal, 12).padding(.vertical, 10).modifier(DrawingGlass())
                    Spacer()
                    Menu {
                        Toggle("Draw with finger", isOn: Binding(get: { model.fingerDrawing }, set: { model.fingerDrawing = $0 }))
                        DrawingPaperPicker(model: model)
                        Button("Save a copy", systemImage: "doc.on.doc") { bridge.save(asCopy: true) }
                            .disabled(!model.loaded || model.saving)
                        Button("Export strokes", systemImage: "square.and.arrow.up") {
                            Task {
                                do { exportDocument = DrawingJSONDocument(data: try await model.export()); exporting = true }
                                catch { model.error = error.localizedDescription }
                            }
                        }.disabled(!model.loaded || model.saving || model.usingTool)
                    } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .buttonStyle(.plain).modifier(DrawingGlass()).disabled(!model.loaded || model.saving)
                    Button("Done") { bridge.save(asCopy: model.requiresCopy) }
                        .padding(.horizontal, 16).padding(.vertical, 12).buttonStyle(.plain).background(DrawingStyle.accent, in: Capsule()).foregroundStyle(.white)
                        .disabled(!model.loaded)
                }.padding(.horizontal, 12).padding(.top, 12)
                ZStack {
                    Color.clear
                    if !model.loaded {
                        VStack {
                            Text(model.status)
                            if model.loadFailed {
                                Button("Retry") { Task { await model.load() } }
                                Button("Discard draft", role: .destructive) { Task { await bridge.discardUnreadableDraft() } }
                            }
                            else { ProgressView() }
                        }.padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                if let error = model.error {
                    HStack {
                        Text(error).font(.caption)
                        Button("Retry") {
                            if model.loaded { bridge.save(asCopy: model.requiresCopy) }
                            else { Task { await model.load() } }
                        }
                    }.padding(.horizontal, 12)
                }
                
                }
            }
            .overlay { WorksheetToolPalette(model: model, viewport: CGSize(width: geometry.size.width, height: max(180, geometry.size.height - paletteOffset))) }
            .coordinateSpace(name: "WorksheetDrawingCanvas")
            }
            .background(Color(uiColor: .systemBackground)).clipShape(RoundedRectangle(cornerRadius: 20)).tint(Color("BrandAccent"))
            .task(id: request.id) { model.canvas.worksheetHeaderHeight = 68; await model.load(); model.worksheetAppearanceChanged(dark: colorScheme == .dark) }
            .onChange(of: colorScheme) { _, scheme in model.worksheetAppearanceChanged(dark: scheme == .dark) }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "drawing-strokes") { result in
                if case .failure(let error) = result { model.error = error.localizedDescription }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase != .active else { return }
                model.checkpointView()
                let token = UIApplication.shared.beginBackgroundTask(withName: "Save worksheet drawing")
                Task {
                    defer { UIApplication.shared.endBackgroundTask(token) }
                    do { try await model.flush() } catch { model.error = error.localizedDescription }
                }
            }
            .onDisappear {
                model.checkpointView()
                Task { do { try await model.flush() } catch { model.error = error.localizedDescription } }
            }
        }
    }
}

/// A single UIKit pan owns drawer movement. Its fixed-size hosting view and
/// PencilKit canvas are translated, never relaid out by gesture samples.
/// Status bar plus the navigation bar's glass buttons, which the sheet must not reach under.
let worksheetDrawerTopReserve: CGFloat = 88
func worksheetDrawerMaximum(_ height: CGFloat) -> CGFloat { max(0, min(height * 0.92, height - worksheetDrawerTopReserve)) }

struct WorksheetDrawerHost: UIViewControllerRepresentable {
    @Binding var fraction: Double
    let session: WebSession
    let content: AnyView

    func makeUIViewController(context: Context) -> WorksheetDrawerController {
        WorksheetDrawerController(fraction: fraction, content: content, session: session) { fraction = $0 }
    }
    func updateUIViewController(_ controller: WorksheetDrawerController, context: Context) {
        controller.update(fraction: fraction, content: content)
    }
}

private final class DrawerPassthroughView: UIView {
    weak var drawer: UIView?
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        drawer?.frame.contains(point) == true
    }
}

final class WorksheetDrawerController: UIViewController, UIGestureRecognizerDelegate {
    private let drawer = UIView()
    private let handle = UIView()
    private let grabber = UIView()
    private let hosting: UIHostingController<AnyView>
    private let session: WebSession
    private let settled: (Double) -> Void
    private var fraction: Double
    private var startTop: CGFloat = 0
    private var dragging = false
    /// Set while a drag-to-dismiss slides the sheet away, so layout updates can't pull it back up (a one-frame blink).
    private var dismissing = false
    private var animator: UIViewPropertyAnimator?
    private var previousSize = CGSize.zero
    private weak var frozenCanvas: DrawingCanvas?
    private let handleHeight: CGFloat = 44

    init(fraction: Double, content: AnyView, session: WebSession, settled: @escaping (Double) -> Void) {
        self.fraction = fraction; self.session = session; self.settled = settled
        hosting = UIHostingController(rootView: content)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func loadView() {
        let container = DrawerPassthroughView()
        container.backgroundColor = .clear; container.drawer = drawer
        view = container
        drawer.backgroundColor = .systemBackground
        drawer.layer.cornerRadius = 20; drawer.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        drawer.clipsToBounds = true
        container.addSubview(drawer)
        addChild(hosting); drawer.addSubview(hosting.view); hosting.didMove(toParent: self)
        hosting.view.backgroundColor = .clear
        hosting.safeAreaRegions = []
        hosting.view.insetsLayoutMarginsFromSafeArea = false
        handle.backgroundColor = .systemBackground; handle.isExclusiveTouch = true
        handle.isAccessibilityElement = true; handle.accessibilityLabel = "Resize drawing pane"
        drawer.addSubview(handle)
        grabber.backgroundColor = .secondaryLabel; grabber.layer.cornerRadius = 2.5
        handle.addSubview(grabber)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(resize(_:)))
        pan.minimumNumberOfTouches = 1; pan.maximumNumberOfTouches = 1
        // Finger or Pencil: people often grab the handle with the Pencil they are drawing with.
        pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        pan.delegate = self; pan.cancelsTouchesInView = true
        handle.addGestureRecognizer(pan)
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        animator?.stopAnimation(true); animator = nil; dragging = false
        frozenCanvas?.drawingGestureRecognizer.isEnabled = true
        frozenCanvas?.panGestureRecognizer.isEnabled = true
        frozenCanvas = nil; session.drawerGestureActive = false
    }
    /// Full height stops below the top bar, so its buttons never sit over the handle and steal the drag.
    private var maximum: CGFloat { worksheetDrawerMaximum(view.bounds.height) }
    private var minimum: CGFloat { min(maximum, max(420, view.bounds.height * 0.18)) }
    private func height(for fraction: Double) -> CGFloat { min(maximum, max(minimum, view.bounds.height * fraction)) }
    func update(fraction: Double, content: AnyView) {
        self.fraction = fraction
        guard !dragging, !dismissing, animator == nil else { return }
        hosting.rootView = content
        if isViewLoaded { drawer.transform = CGAffineTransform(translationX: 0, y: view.bounds.height - height(for: fraction)) }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !dragging, !dismissing, animator == nil, previousSize != view.bounds.size else { return }
        previousSize = view.bounds.size
        drawer.bounds = CGRect(x: 0, y: 0, width: view.bounds.width, height: maximum)
        drawer.center = CGPoint(x: view.bounds.width / 2, y: maximum / 2)
        hosting.view.frame = CGRect(x: 0, y: handleHeight, width: view.bounds.width, height: maximum - handleHeight)
        handle.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: handleHeight)
        grabber.frame = CGRect(x: (view.bounds.width - 40) / 2, y: 14, width: 40, height: 5)
        drawer.transform = CGAffineTransform(translationX: 0, y: view.bounds.height - height(for: fraction))
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    @objc private func resize(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            let top = drawer.layer.presentation()?.frame.minY ?? drawer.frame.minY
            animator?.stopAnimation(true); animator = nil
            drawer.transform = CGAffineTransform(translationX: 0, y: top)
            startTop = top; dragging = true; session.drawerGestureActive = true
            frozenCanvas = session.worksheetDrawing.model?.canvas
            frozenCanvas?.drawingGestureRecognizer.isEnabled = false
            frozenCanvas?.panGestureRecognizer.isEnabled = false
        case .changed:
            let top = min(view.bounds.height, max(view.bounds.height - maximum, startTop + pan.translation(in: view).y))
            drawer.transform = CGAffineTransform(translationX: 0, y: top)
        case .ended, .cancelled, .failed:
            let visible = view.bounds.height - drawer.frame.minY
            let dismiss = pan.state == .ended && (
                visible < minimum * 0.55 ||
                (pan.velocity(in: view).y > 1000 && pan.translation(in: view).y > 40))
            if dismiss {
                dragging = false; dismissing = true
                frozenCanvas?.drawingGestureRecognizer.isEnabled = true
                frozenCanvas?.panGestureRecognizer.isEnabled = true
                frozenCanvas = nil; session.drawerGestureActive = false
                // Slide the sheet off screen first, then use the close-X path: flush the
                // native draft before removing the pane; if that fails, bring it back.
                let close = { [weak self] in
                    guard let self else { return }
                    Task { @MainActor in
                        try? await self.session.worksheetDrawing.cancel()
                        guard self.session.worksheetDrawing.model != nil else { return }
                        self.dismissing = false
                        UIView.animate(withDuration: 0.22) {
                            self.drawer.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height - self.height(for: self.fraction))
                        }
                    }
                }
                if UIAccessibility.isReduceMotionEnabled {
                    drawer.transform = CGAffineTransform(translationX: 0, y: view.bounds.height); close()
                } else {
                    let slide = UIViewPropertyAnimator(duration: 0.2, curve: .easeIn) {
                        self.drawer.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height)
                    }
                    slide.addCompletion { _ in close() }
                    slide.startAnimation()
                }
                return
            }
            // Small, middle and full always exist; a fling carries on to the next stop in its direction.
            let snaps = [minimum, (minimum + maximum) / 2, maximum]
            let projected = visible - pan.velocity(in: view).y * 0.12
            let target = snaps.min { abs($0 - projected) < abs($1 - projected) } ?? minimum
            let next = target / max(1, view.bounds.height)
            dragging = false
            let finish = { [weak self] in
                guard let self else { return }
                self.animator = nil; self.fraction = next
                self.frozenCanvas?.drawingGestureRecognizer.isEnabled = true
                self.frozenCanvas?.panGestureRecognizer.isEnabled = true
                self.frozenCanvas = nil; self.session.drawerGestureActive = false
                self.settled(next)
            }
            if UIAccessibility.isReduceMotionEnabled {
                drawer.transform = CGAffineTransform(translationX: 0, y: view.bounds.height - target); finish()
            } else {
                let settle = UIViewPropertyAnimator(duration: 0.22, dampingRatio: 1) {
                    self.drawer.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height - target)
                }
                animator = settle; settle.addCompletion { _ in finish() }; settle.startAnimation()
            }
        default: break
        }
    }
}
