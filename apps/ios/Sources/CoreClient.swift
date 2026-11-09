import Foundation
import MemnoterCore

struct NoteModule: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    let heading_numbering: Bool
}
struct SearchHit: Codable, Sendable { let module_id: String; let name: String; let snippet: String }
struct DueCount: Codable, Sendable { let moduleId: String; let count: Int }
struct Backup: Codable, Identifiable, Sendable { let id: String; let created_at: Int64 }
struct SavedFile: Codable, Sendable { let id: String; let path: String; let file_type: String }
struct Empty: Encodable, Sendable {}
struct NameArgs: Encodable, Sendable { let name: String }
struct ModuleArgs: Encodable, Sendable { let moduleId: String }
struct RenameArgs: Encodable, Sendable { let moduleId: String; let name: String }
struct NumberingArgs: Encodable, Sendable { let moduleId: String; let enabled: Bool }
struct SearchArgs: Encodable, Sendable { let query: String; let limit: Int = 50 }
struct CountArgs: Encodable, Sendable { let now: Int64; let dayEnd: Int64; var createdAtCutoff: Int64? = nil }
struct FileArgs: Encodable, Sendable { let moduleId: String; let bytes: [UInt8]; let mimeType: String }
struct DocumentPathArgs: Encodable, Sendable { let moduleId: String; let path: String }
struct BackupArgs: Encodable, Sendable { let id: String }

private final class SyncOutboxObserver: OutboxObserver, @unchecked Sendable {
    func outboxChanged() {
        Task { @MainActor in NotificationCenter.default.post(name: .coreDidWrite, object: nil) }
    }
}

/// Actor isolation keeps synchronous Rust work on the cooperative background executor.
actor CoreClient {
    private let core: MemnoterCore
    init(dataDirectory: URL) throws {
        core = try MemnoterCore.open(dataDir: dataDirectory.path)
        core.setOutboxObserver(observer: SyncOutboxObserver())
    }
    static func open(_ directory: URL) async throws -> CoreClient {
        try await Task.detached { try CoreClient(dataDirectory: directory) }.value
    }
    func raw(_ command: String, json: String = "{}") throws -> String {
        try core.dispatch(command: command, argsJson: json)
    }
    func call<A: Encodable & Sendable, R: Decodable & Sendable>(_ command: String, _ args: A, as: R.Type = R.self) throws -> R {
        let json = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        return try JSONDecoder().decode(R.self, from: Data(try raw(command, json: json).utf8))
    }
    func write<A: Encodable & Sendable>(_ command: String, _ args: A) throws {
        _ = try raw(command, json: String(decoding: JSONEncoder().encode(args), as: UTF8.self))
    }
    func dailyBackup() throws { try core.dailyBackup() }
}

indirect enum JSONValue: Codable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}
struct StoredCard: Codable, Sendable, Identifiable {
    let id: String
    let moduleId: String
    let moduleName: String
    let section: [String]
    let kind: String
    let front: JSONValue
    let back: JSONValue
    let fsrsModel: String?
    let dueAt: Int64
    let stability: Double
    let stabilityFast: Double
    let difficulty: Double
    let scheduledDays: Double
    let learningStep: Int
    let state: Int
    let scheduleStatus: String
    let lastReviewAt: Int64?
    let reps: Int
    let lapses: Int
    var previous: ReviewedCard {
        ReviewedCard(dueAt: dueAt, stability: stability, stabilityFast: stabilityFast, difficulty: difficulty, scheduledDays: scheduledDays, learningStep: learningStep, state: state, scheduleStatus: scheduleStatus, lastReviewAt: lastReviewAt, reps: reps, lapses: lapses)
    }
}
struct ReviewedCard: Codable, Sendable {
    let dueAt: Int64
    let stability: Double
    let stabilityFast: Double
    let difficulty: Double
    let scheduledDays: Double
    let learningStep: Int
    let state: Int
    let scheduleStatus: String
    let lastReviewAt: Int64?
    let reps: Int
    let lapses: Int
}
struct ReviewLog: Codable, Sendable {
    let dueAt: Int64
    let stability: Double
    let stabilityFast: Double
    let difficulty: Double
    let scheduledDays: Double
    let learningStep: Int
    let state: Int
    let scheduleStatus: String
    let lastReviewAt: Int64?
    let rating: Int
    let reviewTime: Int64
    let durationMs: Int64?
    let fsrsModel: String
}
struct ReviewResult: Codable, Sendable { let card: ReviewedCard; let log: ReviewLog }
struct DueArgs: Encodable, Sendable { let moduleId: String?; let now: Int64; var createdAtCutoff: Int64? = nil }
struct ReviewArgs: Encodable, Sendable { let cardId: String; let expectedReps: Int; let card: ReviewedCard; let log: ReviewLog }
struct UndoArgs: Encodable, Sendable { let cardId: String; let expectedReps: Int; let previous: ReviewedCard; let previousFsrsModel: String?; let reviewTime: Int64 }

extension Notification.Name { static let coreDidWrite = Notification.Name("memnoter.coreDidWrite") }
