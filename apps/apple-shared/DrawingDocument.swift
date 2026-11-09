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
