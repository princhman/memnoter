import SwiftUI
import AppKit
import PencilKit

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

final class PaperView: NSView {
    let model: DrawingSession
    var drawing = PKDrawing()
    var points: [PKStrokePoint] = []
    var livePath = NSBezierPath()
    private var started = 0.0
    private var revision = -1
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    init(_ model: DrawingSession) { self.model = model; super.init(frame: .zero); appearance = NSAppearance(named: .aqua) }
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
    init(_ model: DrawingSession) {
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
    @ObservedObject var model: DrawingSession
    func makeNSView(context: Context) -> PaperScroll { PaperScroll(model) }
    func updateNSView(_ scroll: PaperScroll, context: Context) { scroll.paper.refresh(); scroll.needsLayout = true }
}
