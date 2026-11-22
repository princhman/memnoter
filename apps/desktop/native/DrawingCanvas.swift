import SwiftUI
import AppKit
import PencilKit

enum InkTool: String, CaseIterable {
    case pen, pencil, marker, eraser, lasso
    var usesInk: Bool { self != .eraser && self != .lasso }
    var symbol: String {
        switch self {
        case .pen: "pencil.tip"
        case .pencil: "pencil"
        case .marker: "highlighter"
        case .eraser: "eraser"
        case .lasso: "lasso"
        }
    }
}

enum EraserMode: String, CaseIterable {
    case object, pixel
    var title: String { self == .object ? "Object eraser" : "Pixel eraser" }
}

enum InkColor: String, CaseIterable {
    case black, blue, red, green, purple, orange
    var value: NSColor {
        let rgb: UInt32 = switch self {
        case .black: 0x000000
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

// Match the iPad preference values and page-coordinate ruling.
extension DrawingPaperStyle {
    func draw(in rect: CGRect, export: Bool = false) {
        guard self != .blank else { return }
        let spacing: CGFloat = 28
        let path = NSBezierPath()
        path.lineWidth = export ? 1 : 0.5
        var y = (rect.minY / spacing).rounded(.up) * spacing
        while y <= rect.maxY {
            path.move(to: CGPoint(x: 0, y: y - rect.minY))
            path.line(to: CGPoint(x: rect.width, y: y - rect.minY))
            y += spacing
        }
        if self == .grid {
            var x = (rect.minX / spacing).rounded(.up) * spacing
            while x <= rect.maxX {
                path.move(to: CGPoint(x: x - rect.minX, y: 0))
                path.line(to: CGPoint(x: x - rect.minX, y: rect.height))
                x += spacing
            }
        }
        (export ? NSColor(white: 0.6, alpha: 1) : NSColor.labelColor.withAlphaComponent(0.22)).setStroke()
        path.stroke()
    }
}

final class PaperView: NSView {
    let model: DrawingSession
    var drawing = PKDrawing()
    var points: [PKStrokePoint] = []
    private var strokeSeed: UInt32 = 0
    private var strokeDate = Date()
    private var eraserPoint: CGPoint?
    private var lassoPoints: [CGPoint] = []
    private var selection: Set<Int> = []
    private var moveStart: CGPoint?
    private var moveSource: PKDrawing?
    private var started = 0.0
    private var revision = -1
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    init(_ model: DrawingSession) { self.model = model; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    func refresh() {
        if revision != model.revision {
            if drawing != model.drawing { selection.removeAll() }
            drawing = model.drawing
            revision = model.revision
        }
        if model.tool != .lasso { selection.removeAll() }
        needsDisplay = true
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill(); dirtyRect.fill()
        NSGraphicsContext.saveGraphicsState()
        let translation = NSAffineTransform()
        translation.translateX(by: dirtyRect.minX, yBy: dirtyRect.minY)
        translation.concat()
        model.paperStyle.draw(in: dirtyRect)
        NSGraphicsContext.restoreGraphicsState()
        let visible = dirtyRect.intersection(visibleRect).intersection(bounds)
        let displayed = liveStroke.map { drawing.appending(PKDrawing(strokes: [$0])) } ?? drawing
        if !displayed.strokes.isEmpty, !visible.isEmpty {
            effectiveAppearance.performAsCurrentDrawingAppearance {
                displayed.image(from: visible, scale: window?.backingScaleFactor ?? 2)
                    .draw(in: visible, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        if let selectedBounds {
            NSColor.controlAccentColor.withAlphaComponent(0.12).setFill()
            selectedBounds.fill()
            drawSelection(NSBezierPath(rect: selectedBounds))
        }
        if let loop = lassoLoop { drawSelection(loop) }
    }

    private var liveStroke: PKStroke? {
        guard !points.isEmpty else { return nil }
        return PKStroke(ink: model.ink, path: .macInputPath(points, creationDate: strokeDate),
                        transform: .identity, mask: nil, randomSeed: strokeSeed)
    }

    override func mouseDown(with event: NSEvent) {
        guard model.loaded, !model.saving else { return }
        refresh()
        window?.makeFirstResponder(self)
        model.usingTool = true
        started = event.timestamp
        strokeDate = Date()
        strokeSeed = UInt32.random(in: .min ... .max)
        eraserPoint = nil
        let point = convert(event.locationInWindow, from: nil)
        if model.tool == .lasso {
            if selectedBounds?.contains(point) == true {
                moveStart = point
                moveSource = drawing
            } else {
                selection.removeAll()
                lassoPoints = [point]
            }
        }
        sample(event)
    }
    override func mouseDragged(with event: NSEvent) {
        if model.usingTool { sample(event) }
    }
    override func mouseUp(with event: NSEvent) {
        guard model.usingTool else { return }
        sample(event)
        if let stroke = liveStroke {
            drawing = drawing.appending(PKDrawing(strokes: [stroke]))
        }
        if lassoPoints.count >= 3, let loop = lassoLoop {
            selection = Set(drawing.strokes.indices.filter { index in
                let stroke = drawing.strokes[index]
                guard loop.bounds.intersects(stroke.renderBounds) else { return false }
                let samples = stroke.path.interpolatedPoints(by: .distance(3)).filter {
                    stroke.mask?.contains($0.location.applying(stroke.transform)) ?? true
                }
                let inside = samples.filter { loop.contains($0.location.applying(stroke.transform)) }.count
                return inside > samples.count / 2
            })
        }
        points.removeAll()
        lassoPoints.removeAll()
        moveStart = nil
        moveSource = nil
        model.commit(drawing)
        model.usingTool = false
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        guard model.tool == .lasso, !model.usingTool, !model.saving else {
            super.keyDown(with: event)
            return
        }
        refresh()
        switch event.keyCode {
        case 53 where !selection.isEmpty: // Escape
            selection.removeAll()
        case 51, 117: // Backspace and forward Delete
            guard !selection.isEmpty else { super.keyDown(with: event); return }
            drawing = PKDrawing(strokes: drawing.strokes.enumerated().compactMap {
                selection.contains($0.offset) ? nil : $0.element
            })
            selection.removeAll()
            model.commit(drawing)
        default:
            super.keyDown(with: event)
        }
        needsDisplay = true
    }

    private var selectedBounds: CGRect? {
        guard !selection.isEmpty else { return nil }
        let strokes = drawing.strokes
        let bounds = selection.reduce(CGRect.null) { $0.union(strokes[$1].renderBounds) }
        return bounds.insetBy(dx: -5, dy: -5)
    }

    private var lassoLoop: NSBezierPath? {
        guard let first = lassoPoints.first else { return nil }
        let loop = NSBezierPath()
        loop.windingRule = .evenOdd
        loop.move(to: first)
        for point in lassoPoints.dropFirst() { loop.line(to: point) }
        if lassoPoints.count >= 3 { loop.close() }
        return loop
    }

    private func drawSelection(_ path: NSBezierPath) {
        NSColor.controlAccentColor.setStroke()
        path.lineWidth = 2
        path.setLineDash([5, 4], count: 2, phase: 0)
        path.stroke()
    }

    private func sample(_ event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if model.tool == .lasso {
            if let start = moveStart, let source = moveSource {
                let translation = CGAffineTransform(translationX: p.x - start.x, y: p.y - start.y)
                drawing = translation.isIdentity ? source : PKDrawing(strokes: source.strokes.enumerated().map { index, stroke in
                    guard selection.contains(index) else { return stroke }
                    let mask = stroke.mask.map { original in
                        let moved = original.copy() as! NSBezierPath
                        moved.transform(using: AffineTransform(translationByX: translation.tx, byY: translation.ty))
                        return moved
                    }
                    return PKStroke(ink: stroke.ink, path: stroke.path,
                                    transform: stroke.transform.concatenating(translation), mask: mask,
                                    randomSeed: stroke.randomSeed)
                })
            } else if lassoPoints.last != p {
                lassoPoints.append(p)
            }
        } else {
            guard p.x >= 0, p.x <= model.paperWidth, p.y >= 0, p.y < 1_000_000 else { return }
            if model.tool == .eraser {
                erase(from: eraserPoint ?? p, to: p)
                eraserPoint = p
            } else {
                let size = CGSize(width: model.strokeWidth, height: model.strokeWidth)
                let elapsed = max(0, event.timestamp - started)
                points.append(PKStrokePoint(location: p, timeOffset: elapsed, size: size, opacity: 1,
                                            force: event.pressure > 0 ? CGFloat(event.pressure) : 1, azimuth: 0, altitude: .pi / 2))
            }
        }
        if p.y > model.paperHeight - 500 { model.paperHeight = min(1_000_000, p.y + 1440); enclosingScrollView?.needsLayout = true }
        needsDisplay = true
    }

    private func erase(from start: CGPoint, to end: CGPoint) {
        let pixel = model.eraserMode == .pixel
        let radius = pixel ? model.eraserSize / 2 : 12
        let sweep = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                           width: abs(end.x - start.x), height: abs(end.y - start.y))
            .insetBy(dx: -radius, dy: -radius)
        let dx = end.x - start.x, dy = end.y - start.y
        let lengthSquared = dx * dx + dy * dy
        let eraser = CGMutablePath()
        if lengthSquared == 0 {
            eraser.addEllipse(in: sweep)
        } else {
            let segment = CGMutablePath()
            segment.move(to: start)
            segment.addLine(to: end)
            eraser.addPath(segment.copy(strokingWithWidth: radius * 2, lineCap: .round, lineJoin: .round, miterLimit: 1))
        }
        drawing = PKDrawing(strokes: drawing.strokes.flatMap { stroke -> [PKStroke] in
            guard stroke.renderBounds.intersects(sweep) else { return [stroke] }
            let transform = stroke.transform
            let originalMask = stroke.mask
            let spacing = pixel ? max(0.5, min(2, radius / 3)) : 3
            var hit = false
            var runs: [[PKStrokePoint]] = []
            var kept: [PKStrokePoint] = []
            for point in stroke.path.interpolatedPoints(by: .distance(spacing)) {
                let location = point.location.applying(transform)
                let projection = lengthSquared == 0 ? 0 :
                    min(1, max(0, ((location.x - start.x) * dx + (location.y - start.y) * dy) / lengthSquared))
                let closest = CGPoint(x: start.x + dx * projection, y: start.y + dy * projection)
                let distance = hypot(location.x - closest.x, location.y - closest.y)
                // Project the transformed elliptical nib onto the direction of the eraser.
                let angle = point.azimuth
                let ux = cos(angle) * point.size.width / 2, uy = sin(angle) * point.size.width / 2
                let vx = -sin(angle) * point.size.height / 2, vy = cos(angle) * point.size.height / 2
                let nx = distance == 0 ? 0 : (closest.x - location.x) / distance
                let ny = distance == 0 ? 0 : (closest.y - location.y) / distance
                let nibRadius = hypot(nx * (transform.a * ux + transform.c * uy) + ny * (transform.b * ux + transform.d * uy),
                                      nx * (transform.a * vx + transform.c * vy) + ny * (transform.b * vx + transform.d * vy))
                let insideMask = originalMask?.contains(location) ?? true
                if distance <= radius + nibRadius {
                    if !pixel && insideMask { return [] }
                    hit = pixel
                }
                guard pixel else { continue }
                // Split only where the whole nib fits inside the eraser. The clip
                // handles partial overlap along the sides and at the cut ends.
                let maxNibRadius = hypot(hypot(transform.a * ux + transform.c * uy, transform.b * ux + transform.d * uy),
                                         hypot(transform.a * vx + transform.c * vy, transform.b * vx + transform.d * vy))
                if distance + maxNibRadius <= radius {
                    if !kept.isEmpty { runs.append(kept); kept = [] }
                } else {
                    kept.append(point)
                }
            }
            guard hit else { return [stroke] }
            let evenOdd = originalMask?.windingRule == .evenOdd
            let base = originalMask?.cgPath ?? CGPath(rect: stroke.renderBounds.insetBy(dx: -1, dy: -1), transform: nil)
            let rule: CGPathFillRule = evenOdd ? .evenOdd : .winding
            guard !base.intersection(eraser, using: rule).isEmpty else { return [stroke] }
            let remainder = base.subtracting(eraser, using: rule)
            guard !remainder.isEmpty else { return [] }
            let mask = NSBezierPath(cgPath: remainder)
            mask.windingRule = evenOdd ? .evenOdd : .nonZero
            if runs.isEmpty && !kept.isEmpty {
                return [PKStroke(ink: stroke.ink, path: stroke.path, transform: transform,
                                 mask: mask, randomSeed: stroke.randomSeed)]
            }
            if !kept.isEmpty { runs.append(kept) }
            return runs.map {
                PKStroke(ink: stroke.ink, path: PKStrokePath(controlPoints: $0, creationDate: stroke.path.creationDate),
                         transform: transform, mask: mask, randomSeed: stroke.randomSeed)
            }
        })
    }

}

final class PaperScroll: NSScrollView {
    let paper: PaperView
    private var restored = false
    init(_ model: DrawingSession) {
        paper = PaperView(model); super.init(frame: .zero)
        documentView = paper; hasVerticalScroller = true; hasHorizontalScroller = false
        drawsBackground = true; backgroundColor = .textBackgroundColor
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
