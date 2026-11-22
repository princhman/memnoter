import Foundation

enum DrawingPaperStyle: String, Codable, CaseIterable, Sendable {
    case blank, lined, grid
}

// Shared on-disk contract for the iPad canvas and the Mac drawing editor.
struct DrawingDocument: Codable, Sendable {
    let version: Int
    let nativeData: Data
    let width: Double
    let height: Double
    let geometry: Data?
    var portable: PortableInk? = nil
    var paperStyle: DrawingPaperStyle? = nil

    private enum CodingKeys: String, CodingKey {
        case version, nativeData, width, height, geometry, portable, paperStyle
    }


    func validate() throws {
        guard (version == 1 || version == 2), (version != 2 || portable != nil), width.isFinite, height.isFinite,
              width > 0, height > 0, width <= 100_000, height <= 1_000_000,
              nativeData.count <= 64 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
    }
}

extension DrawingDocument {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        nativeData = try values.decode(Data.self, forKey: .nativeData)
        width = try values.decode(Double.self, forKey: .width)
        height = try values.decode(Double.self, forKey: .height)
        geometry = try values.decodeIfPresent(Data.self, forKey: .geometry)
        portable = try values.decodeIfPresent(PortableInk.self, forKey: .portable)
        paperStyle = try? values.decode(DrawingPaperStyle.self, forKey: .paperStyle)
    }
}

// Session identity only: deliberately excluded from the version-1 document.
struct DrawingOwner: Hashable, Sendable {
    let moduleId: String
    var answerId: String? = nil
    let canvasId: String

    static func note(moduleId: String, imageId: String) -> DrawingOwner {
        DrawingOwner(moduleId: moduleId, canvasId: imageId)
    }

    var viewportKey: String {
        // Preserve existing note viewport preferences, without migration.
        guard let answerId else { return "viewport.\(moduleId)/\(canvasId)" }
        return "viewport.answer.\(moduleId.utf8.count):\(moduleId)\(answerId.utf8.count):\(answerId)\(canvasId.utf8.count):\(canvasId)"
    }
}

// Version 2 makes portable ink authoritative. Version 1 native archives remain
// authoritative; optional portable ink is a bounded approximation for other OSes.
struct PortableInk: Codable, Sendable {
    struct Point: Codable, Sendable { let x, y, pressure: Double
        var width: Double? = nil
        var height: Double? = nil
        var opacity: Double? = nil
        var azimuth: Double? = nil
    }
    struct Stroke: Codable, Sendable {
        let tool, color: String
        let width: Double
        let points: [Point]
        var kind: String? = nil
        var nativeIndex: Int? = nil
        var alpha: Double? = nil
        var transform: [Double]? = nil
        var mask: [MaskElement]? = nil
        var maskUsesEvenOddFillRule: Bool? = nil
        var cuts: [[MaskElement]]? = nil
    }
    struct MaskElement: Codable, Sendable {
        let command: String
        let coordinates: [Double]
    }
    let version: Int
    let strokes: [Stroke]
    func validate() throws {
        func bounded(_ n: Double, _ low: Double, _ high: Double) -> Bool { n.isFinite && n >= low && n <= high }
        guard (version == 1 || version == 2), strokes.count <= 20_000,
              strokes.reduce(0, { $0 + $1.points.count }) <= 500_000,
              strokes.reduce(0, { $0 + ($1.mask?.count ?? 0) + ($1.cuts?.reduce(0, { $0 + $1.count }) ?? 0) }) <= 500_000 else { throw CocoaError(.fileReadCorruptFile) }
        for s in strokes {
            guard s.color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
                  bounded(s.width, 0.1, 1000), !s.points.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
            if s.kind == "native" {
                guard version == 2, let index = s.nativeIndex, (0..<20_000).contains(index),
                      let alpha = s.alpha, bounded(alpha, 0, 1),
                      let t = s.transform, t.count == 6, t.allSatisfy({ bounded($0, -1_000_000, 1_000_000) }),
                      s.maskUsesEvenOddFillRule != nil, !s.tool.isEmpty, s.tool.count <= 100 else { throw CocoaError(.fileReadCorruptFile) }
                guard s.cuts?.allSatisfy({ !$0.isEmpty }) ?? true else { throw CocoaError(.fileReadCorruptFile) }
                for e in (s.mask ?? []) + (s.cuts ?? []).joined() {
                    let counts = ["move": 2, "line": 2, "quadratic": 4, "cubic": 6, "close": 0]
                    guard counts[e.command] == e.coordinates.count,
                          e.coordinates.allSatisfy({ bounded($0, -1_000_000, 1_000_000) }) else { throw CocoaError(.fileReadCorruptFile) }
                }
            } else {
                guard s.kind == nil, s.nativeIndex == nil, ["pen", "marker", "pencil"].contains(s.tool),
                      s.width <= 100, s.transform == nil, s.mask == nil, s.cuts == nil, s.alpha == nil else { throw CocoaError(.fileReadCorruptFile) }
            }
            for p in s.points {
                guard bounded(p.x, -1_000_000, 1_000_000), bounded(p.y, -1_000_000, 1_000_000),
                      bounded(p.pressure, 0, 1) else { throw CocoaError(.fileReadCorruptFile) }
                if s.kind == "native" {
                    guard let w = p.width, let h = p.height, let o = p.opacity, let a = p.azimuth,
                          bounded(w, 0, 1000), bounded(h, 0, 1000), bounded(o, 0, 1),
                          bounded(a, -1000, 1000) else { throw CocoaError(.fileReadCorruptFile) }
                }
            }
        }
    }
}

#if canImport(PencilKit)
import PencilKit
#if canImport(UIKit)
import UIKit
private typealias PortableInkColor = UIColor
#else
import AppKit
private typealias PortableInkColor = NSColor
#endif

private extension Array where Element == PortableInk.MaskElement {
    var maskPath: CGPath {
        let path = CGMutablePath()
        for element in self {
            let c = element.coordinates
            func point(_ i: Int) -> CGPoint { CGPoint(x: c[i], y: c[i + 1]) }
            switch element.command {
            case "move": path.move(to: point(0))
            case "line": path.addLine(to: point(0))
            case "quadratic": path.addQuadCurve(to: point(2), control: point(0))
            case "cubic": path.addCurve(to: point(4), control1: point(0), control2: point(2))
            case "close": path.closeSubpath()
            default: break // Commands are validated before reconstruction.
            }
        }
        return path
    }
}

extension DrawingDocument {
    func drawing() throws -> PKDrawing {
        try validate()
        // Never use the archived native sidecar after a portable edit.
        guard version == 2 else { return try PKDrawing(data: nativeData) }
        guard let portable else { throw CocoaError(.fileReadCorruptFile) }
        try portable.validate()
        let indexed = portable.strokes.contains { $0.kind == "native" }
        // The immutable basis is consulted only for explicitly selected indices.
        let basis: [PKStroke]
        if indexed { basis = try PKDrawing(data: nativeData).strokes } else { basis = [] }
        guard basis.count <= 20_000 else { throw CocoaError(.fileReadCorruptFile) }
        let strokes = try portable.strokes.compactMap { s -> PKStroke? in
            if s.kind == "native" {
                guard let index = s.nativeIndex, basis.indices.contains(index) else { throw CocoaError(.fileReadCorruptFile) }
                let original = basis[index]
                let t = s.transform!
                let transform = CGAffineTransform(a: t[0], b: t[1], c: t[2], d: t[3], tx: t[4], ty: t[5])
                var clip = s.mask?.maskPath
                var evenOdd = s.maskUsesEvenOddFillRule!
                if let cuts = s.cuts, !cuts.isEmpty {
                    guard transform.a * transform.d != transform.b * transform.c else { return nil }
                    var inverse = transform.inverted()
                    let full = PKStroke(ink: original.ink, path: original.path, transform: .identity,
                        mask: nil, randomSeed: original.randomSeed)
                    var remaining = clip?.normalized(using: evenOdd ? .evenOdd : .winding)
                        ?? CGPath(rect: full.renderBounds.insetBy(dx: -1, dy: -1), transform: nil)
                    for cut in cuts {
                        guard let localCut = cut.maskPath.copy(using: &inverse) else { throw CocoaError(.fileReadCorruptFile) }
                        remaining = remaining.subtracting(localCut, using: .evenOdd)
                        if remaining.isEmpty { return nil }
                    }
                    clip = remaining
                    evenOdd = true
                }
                if clip?.isEmpty == true { return nil }
                #if canImport(UIKit)
                let mask = clip.map { UIBezierPath(cgPath: $0) }
                mask?.usesEvenOddFillRule = evenOdd
                #else
                let mask = clip.map { NSBezierPath(cgPath: $0) }
                mask?.windingRule = evenOdd ? .evenOdd : .nonZero
                #endif
                return PKStroke(ink: original.ink, path: original.path, transform: transform,
                    mask: mask, randomSeed: original.randomSeed)
            }
            let rgb = UInt32(s.color.dropFirst(), radix: 16)!
            let color = PortableInkColor(red: CGFloat((rgb >> 16) & 255)/255,
                                 green: CGFloat((rgb >> 8) & 255)/255,
                                 blue: CGFloat(rgb & 255)/255, alpha: 1)
            let points = s.points.enumerated().map { i, p in
                let size = s.width * (0.25 + 0.75 * p.pressure)
                return PKStrokePoint(location: CGPoint(x: p.x, y: p.y), timeOffset: Double(i)/120,
                    size: CGSize(width: size, height: size), opacity: 1, force: p.pressure,
                    azimuth: 0, altitude: .pi/2)
            }
            let tool: PKInk.InkType = switch s.tool {
            case "marker": .marker
            case "pencil": .pencil
            default: .pen
            }
            #if canImport(AppKit)
            let path = PKStrokePath.macInputPath(points, creationDate: Date())
            #else
            let path = PKStrokePath(controlPoints: points, creationDate: Date())
            #endif
            return PKStroke(ink: PKInk(tool, color: color), path: path, transform: .identity, mask: nil)
        }
        return PKDrawing(strokes: strokes)
    }
}

#if canImport(AppKit)
extension PKStrokePath {
    static func macInputPath(_ samples: [PKStrokePoint], creationDate: Date) -> PKStrokePath {
        var points: [PKStrokePoint] = []
        for sample in samples where points.last?.location != sample.location {
            points.append(sample)
        }
        guard points.count > 2 else { return PKStrokePath(controlPoints: points, creationDate: creationDate) }
        var controls = [points[0]]
        for i in 1..<(points.count - 1) {
            let point = points[i]
            let before = points[i - 1].location, after = points[i + 1].location
            let dx = point.location.x - before.x, dy = point.location.y - before.y
            let nextX = after.x - point.location.x, nextY = after.y - point.location.y
            controls.append(point)
            // Repeated controls pin a sharp turn in PencilKit's spline.
            if dx * nextX + dy * nextY <= 0.5 * hypot(dx, dy) * hypot(nextX, nextY) {
                controls.append(point)
                controls.append(point)
            }
        }
        controls.append(points[points.count - 1])
        return PKStrokePath(controlPoints: controls, creationDate: creationDate)
    }
}
#endif

extension PortableInk {
    // Descriptors are sampled rendering approximations; original PKStrokes are
    // the fidelity basis. Never reconstruct indexed ink from these samples.
    static func exporting(_ drawing: PKDrawing) -> PortableInk? {
        guard drawing.strokes.count <= 20_000 else { return nil }
        var strokes: [Stroke] = []
        var pointCount = 0
        var maskCount = 0
        for (index, s) in drawing.strokes.enumerated() {
            guard !s.path.isEmpty else { return nil }
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            #if canImport(UIKit)
            guard s.ink.color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
            #else
            guard let color = s.ink.color.usingColorSpace(.deviceRGB) else { return nil }
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            #endif
            let samples = Array(s.path.interpolatedPoints(by: .distance(1)).prefix(500_001 - pointCount))
            pointCount += samples.count
            guard pointCount <= 500_000 else { return nil }
            var mask: [MaskElement]? = nil
            if let path = s.mask {
                var elements: [MaskElement] = []
                path.cgPath.applyWithBlock { pointer in
                    guard elements.count <= 500_000 - maskCount else { return }
                    let e = pointer.pointee
                    let command: String
                    let count: Int
                    switch e.type {
                    case .moveToPoint: command = "move"; count = 1
                    case .addLineToPoint: command = "line"; count = 1
                    case .addQuadCurveToPoint: command = "quadratic"; count = 2
                    case .addCurveToPoint: command = "cubic"; count = 3
                    case .closeSubpath: command = "close"; count = 0
                    @unknown default: command = "unsupported"; count = 0
                    }
                    elements.append(MaskElement(command: command, coordinates: (0..<count).flatMap {
                        [Double(e.points[$0].x), Double(e.points[$0].y)]
                    }))
                }
                maskCount += elements.count
                guard maskCount <= 500_000 else { return nil }
                mask = elements
            }
            #if canImport(UIKit)
            let evenOdd = s.mask?.usesEvenOddFillRule ?? false
            #else
            let evenOdd = s.mask?.windingRule == .evenOdd
            #endif
            let t = s.transform
            let points = samples.map { p in Point(x: p.location.x, y: p.location.y,
                pressure: max(0, min(1, p.force)), width: p.size.width, height: p.size.height,
                opacity: p.opacity, azimuth: p.azimuth) }
            strokes.append(Stroke(tool: s.ink.inkType == .pencil ? "pencil" : s.ink.inkType.rawValue,
                color: String(format: "#%02x%02x%02x", Int(r*255), Int(g*255), Int(b*255)),
                width: max(0.1, points.map { $0.width ?? 0 }.max() ?? 1), points: points,
                kind: "native", nativeIndex: index, alpha: a,
                transform: [t.a, t.b, t.c, t.d, t.tx, t.ty], mask: mask,
                maskUsesEvenOddFillRule: evenOdd))
        }
        let ink = PortableInk(version: 2, strokes: strokes)
        guard (try? ink.validate()) != nil else { return nil }
        return ink
    }
}
#endif
