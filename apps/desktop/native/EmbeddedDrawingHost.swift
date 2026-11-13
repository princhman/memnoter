import AppKit
import Combine

// Bounded sibling of a web layout, never a full-window input interceptor.
// The layout bridge supplies canvas and visible clip rectangles in container
// coordinates after scrolling, resizing, or reflow. It owns no persistence.
@MainActor final class EmbeddedDrawingHost: NSView {
    let paper: PaperView
    weak var scrollTarget: NSView?
    private var observation: AnyCancellable?
    override var isFlipped: Bool { true }

    init(session: DrawingSession, scrollTarget: NSView) {
        paper = PaperView(session)
        self.scrollTarget = scrollTarget
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(paper)
        observation = session.objectWillChange.sink { [weak self] in
            // ObservableObject emits before mutation; render the new snapshot.
            Task { @MainActor [weak self] in self?.paper.refresh() }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func updateGeometry(canvasFrame: CGRect, visibleFrame: CGRect) {
        let clip = canvasFrame.intersection(visibleFrame)
        guard canvasFrame.width.isFinite, canvasFrame.height.isFinite,
              canvasFrame.width > 0, canvasFrame.height > 0, !clip.isNull, !clip.isEmpty else {
            isHidden = true
            return
        }
        isHidden = false
        frame = clip
        // Fit in logical document coordinates. Text reflow/scroll only changes
        // the native frame; it never transforms stored stroke points.
        let scale = canvasFrame.width / paper.model.paperWidth
        paper.frame = CGRect(x: canvasFrame.minX - clip.minX, y: clip.maxY - canvasFrame.maxY,
                             width: canvasFrame.width, height: canvasFrame.height)
        paper.setBoundsSize(CGSize(width: paper.model.paperWidth, height: canvasFrame.height / scale))
        paper.refresh()
    }

    override func scrollWheel(with event: NSEvent) { scrollTarget?.scrollWheel(with: event) }
    @objc func undo(_ sender: Any?) { paper.model.undo() }
    @objc func redo(_ sender: Any?) { paper.model.redo() }
}
