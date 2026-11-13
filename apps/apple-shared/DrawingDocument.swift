import Foundation

// Shared on-disk contract for the iPad canvas and the Mac drawing editor.
struct DrawingDocument: Codable, Sendable {
    let version: Int
    let nativeData: Data
    let width: Double
    let height: Double
    let geometry: Data?

    func validate() throws {
        guard version == 1, width.isFinite, height.isFinite,
              width > 0, height > 0, width <= 100_000, height <= 1_000_000,
              nativeData.count <= 64 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
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
