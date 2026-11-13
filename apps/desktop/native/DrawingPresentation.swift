import AppKit
import SwiftUI

// This view lives above the note's WKWebView in the same NSWindow. The window,
// its delegate, and the app lifecycle continue to belong to Tauri.
@MainActor private final class DrawingPresentation {
    static var current: DrawingPresentation?
    let model: DrawingSession
    let host: DrawingHostingView
    weak var window: NSWindow?
    weak var previousResponder: NSResponder?
    private var coveredViews: [(NSView, Bool)] = []
    let completion: () -> Void

    init(window: NSWindow, request: EditorRequest, completion: @escaping () -> Void) {
        self.window = window
        self.completion = completion
        previousResponder = window.firstResponder
        model = DrawingSession(request)
        host = DrawingHostingView(model: model)
        model.onFinish = { [weak self] in self?.finish() }
    }

    func show() {
        guard let window, let container = window.contentView else { return }
        coveredViews = container.subviews.map { ($0, $0.isHidden) }
        for (view, _) in coveredViews { view.isHidden = true }
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host, positioned: .above, relativeTo: nil)
        window.makeFirstResponder(host)
    }

    func focus() {
        guard let window else { return }
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(host)
    }

    private func finish() {
        host.removeFromSuperview()
        for (view, hidden) in coveredViews { view.isHidden = hidden }
        window?.makeFirstResponder(previousResponder)
        DrawingPresentation.current = nil
        completion()
    }
}

@MainActor private final class DrawingHostingView: NSHostingView<DrawingScreen> {
    let model: DrawingSession
    override var acceptsFirstResponder: Bool { true }
    init(model: DrawingSession) {
        self.model = model
        super.init(rootView: DrawingScreen(model: model))
    }
    @available(*, unavailable) required init(rootView: DrawingScreen) { fatalError() }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    @objc func undo(_ sender: Any?) { model.undo() }
    @objc func redo(_ sender: Any?) { model.redo() }
    override func cancelOperation(_ sender: Any?) { model.close() }
}

// Called only on the AppKit main thread. Rust owns the context until this
// completion fires exactly once; no Swift objects or strings cross the ABI.
@_cdecl("memnoter_present_drawing") @MainActor
public func presentDrawing(_ pointer: UnsafeMutableRawPointer?, _ path: UnsafePointer<CChar>?,
                    _ context: UInt64, _ callback: @escaping @convention(c) (UInt64, Int32) -> Void) {
    guard let pointer, let path else { callback(context, 1); return }
    if let current = DrawingPresentation.current {
        current.focus()
        callback(context, 2)
        return
    }
    do {
        let request = try JSONDecoder().decode(EditorRequest.self, from: Data(contentsOf: URL(fileURLWithPath: String(cString: path))))
        let window = Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
        guard window.contentView != nil else { callback(context, 1); return }
        let presentation = DrawingPresentation(window: window, request: request) { callback(context, 0) }
        DrawingPresentation.current = presentation
        presentation.show()
    } catch {
        callback(context, 1)
    }
}

@_cdecl("memnoter_focus_drawing") @MainActor
public func focusDrawing() { DrawingPresentation.current?.focus() }

@_cdecl("memnoter_close_drawing") @MainActor
public func closeDrawing() { DrawingPresentation.current?.model.close() }

@_cdecl("memnoter_drawing_history") @MainActor
public func drawingHistory(_ redo: Bool) {
    guard let model = DrawingPresentation.current?.model else { return }
    if redo { model.redo() } else { model.undo() }
}
