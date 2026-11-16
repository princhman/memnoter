import Foundation

// Shared on-disk contract for the iPad canvas and the Mac drawing editor.
struct DrawingDocument: Codable, Sendable {
    let version: Int
    let nativeData: Data
    let width: Double
    let height: Double
    let geometry: Data?
    var portable: PortableInk? = nil

    func validate() throws {
        guard (version == 1 || version == 2), (version != 2 || portable != nil), width.isFinite, height.isFinite,
              width > 0, height > 0, width <= 100_000, height <= 1_000_000,
              nativeData.count <= 64 * 1024 * 1024,
              (version != 2 || (width <= 4096 && height <= 16384 && width * height <= 16_777_216)) else { throw CocoaError(.fileReadCorruptFile) }
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
    struct Point: Codable, Sendable { let x, y, pressure: Double }
    struct Stroke: Codable, Sendable {
        let tool, color: String
        let width: Double
        let points: [Point]
    }
    let version: Int
    let strokes: [Stroke]
    func validate() throws {
        guard version == 1, strokes.count <= 20_000,
              strokes.reduce(0, { $0 + $1.points.count }) <= 500_000 else { throw CocoaError(.fileReadCorruptFile) }
        for s in strokes {
            guard ["pen", "marker"].contains(s.tool), s.width.isFinite, (0.1...100).contains(s.width),
                  s.color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
                  !s.points.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
            for p in s.points {
                guard p.x.isFinite, p.y.isFinite, p.pressure.isFinite,
                      (0...4096).contains(p.x), (0...16384).contains(p.y), (0...1).contains(p.pressure) else { throw CocoaError(.fileReadCorruptFile) }
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

extension DrawingDocument {
    func drawing() throws -> PKDrawing {
        try validate()
        // Never use the archived native sidecar after a portable edit.
        guard version == 2 else { return try PKDrawing(data: nativeData) }
        guard let portable else { throw CocoaError(.fileReadCorruptFile) }
        try portable.validate()
        let strokes = portable.strokes.map { s in
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
            return PKStroke(ink: PKInk(s.tool == "marker" ? .marker : .pen, color: color),
                path: PKStrokePath(controlPoints: points, creationDate: Date()), transform: .identity, mask: nil)
        }
        return PKDrawing(strokes: strokes)
    }
}

extension PortableInk {
    // Native control points are splines, not raw pointer samples. Sample the
    // on-curve path. Masks/unsupported tools are protected as native-only ink.
    static func exporting(_ drawing: PKDrawing) -> PortableInk? {
        var strokes: [Stroke] = []
        var pointCount = 0
        for s in drawing.strokes {
            guard s.mask == nil, s.transform == .identity,
                  s.ink.inkType == .pen || s.ink.inkType == .monoline || s.ink.inkType == .marker,
                  !s.path.isEmpty else { return nil }
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            #if canImport(UIKit)
            guard s.ink.color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
            #else
            guard let color = s.ink.color.usingColorSpace(.deviceRGB) else { return nil }
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            #endif
            guard a >= 0.999 else { return nil }
            let samples = Array(s.path.interpolatedPoints(by: .distance(1)).prefix(500_001))
            pointCount += samples.count
            guard pointCount <= 500_000 else { return nil }
            let width = samples.map { Double($0.size.width) }.max() ?? 1
            guard width >= 0.1, width <= 100,
                  samples.allSatisfy({ abs($0.size.width - $0.size.height) < 0.01 && $0.opacity >= 0.999 }) else { return nil }
            let points = samples.map { p in Point(x: p.location.x, y: p.location.y,
                pressure: max(0, min(1, (Double(p.size.width)/width - 0.25)/0.75))) }
            strokes.append(Stroke(tool: s.ink.inkType == .marker ? "marker" : "pen",
                color: String(format: "#%02x%02x%02x", Int(r*255), Int(g*255), Int(b*255)), width: width, points: points))
        }
        let ink = PortableInk(version: 1, strokes: strokes)
        guard (try? ink.validate()) != nil else { return nil }
        return ink
    }
}
#endif
