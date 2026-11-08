import Foundation
import Security
import MemnoterCore

@MainActor enum SyncConfiguration {
    static let contract = (try! JSONSerialization.jsonObject(with: Data(syncContract().utf8))) as! [String: Any]
    static func integer(_ key: String) -> Int { contract[key] as! Int }
    static func text(_ key: String) -> String { contract[key] as! String }
    static func path(_ key: String) -> String { (contract["paths"] as! [String: String])[key]! }
    static func server(_ value: String) -> String {
        var value = value
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
    static var defaultServer: String { Bundle.main.object(forInfoDictionaryKey: "SyncServerURL") as? String ?? text("defaultServer") }
}

struct SyncAccount: Codable, Sendable {
    let server: String
    let email: String
    let userId: String
    let token: String
    let key: [UInt8]
}
struct SyncFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct SyncHTTPFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}
struct SyncKeychain {
    var service = "com.memnoter.sync"
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "account"] }
    func load() throws -> SyncAccount? {
        var q = query
        q[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw SyncFailure(message: "Keychain read failed (\(status))") }
        return try JSONDecoder().decode(SyncAccount.self, from: data)
    }
    func save(_ account: SyncAccount) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(account), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw SyncFailure(message: "Keychain write failed (\(status))") }
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SyncFailure(message: "Keychain delete failed (\(status))") }
    }
}

/// Debouncing never owns a transfer. Wakes during a pass coalesce into one
/// follow-up pass; only lifecycle cancellation interrupts active work.
@MainActor final class SyncTransferWorker {
    private let pass: @MainActor () async throws -> Void
    private let onError: @MainActor (Error) -> Void
    private var debounce: Task<Void, Never>?
    private var worker: Task<Void, Never>?
    private var again = false
    private var generation = UUID()

    init(pass: @escaping @MainActor () async throws -> Void,
         onError: @escaping @MainActor (Error) -> Void) {
        self.pass = pass; self.onError = onError
    }
    func nudge() {
        if worker != nil { again = true; return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard let self else { return }
            debounce = nil
            let owner = generation
            worker = Task {
                repeat {
                    again = false
                    do { try await pass() }
                    catch { if !Task.isCancelled, owner == generation { onError(error) } }
                } while again && !Task.isCancelled && owner == generation
                if owner == generation { worker = nil }
            }
        }
    }
    func cancel() {
        generation = UUID()
        debounce?.cancel(); debounce = nil
        worker?.cancel(); worker = nil; again = false
    }
}

/// URLSession owns transport; Rust owns transactions and wire-compatible crypto.
/// One connection task serializes receive/apply/ack. Reconnect always reads the durable cursor.
@MainActor @Observable final class SyncClient {
    let core: CoreClient
    private let session: URLSession
    private let keychain: SyncKeychain
    var account: SyncAccount?
    var status = "Not running."
    var error: String?
    var pending = 0
    var lastSynced: Date?
    var onFile: ((String, String) async throws -> Void)?
    private var connection: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    @ObservationIgnored private var transfers: SyncTransferWorker!
    @ObservationIgnored private var fileTransfers: SyncFileTransfers!
    private var socket: URLSessionWebSocketTask?
    private var ready = false
    private var engine: SyncSession?
    private var databaseGeneration = ""
    private var pushing = false
    private var generation = UUID()
    private var suspended = false
    private var fatal = false
    init(core: CoreClient, session: URLSession = .shared, keychain: SyncKeychain = SyncKeychain()) {
        self.core = core; self.session = session; self.keychain = keychain
        transfers = SyncTransferWorker(pass: { [weak self] in
            guard let self else { return }
            try await push()
            guard ready, let account else { return }
            do { try await fileTransfers.run(account: account, owner: generation) }
            catch let failure as SyncHTTPFailure where failure.status == 401 {
                fatal = true; self.error = failure.localizedDescription; stop(); status = "Sync stopped."
                throw failure
            }
        }, onError: { [weak self] in self?.error = $0.localizedDescription })
        fileTransfers = SyncFileTransfers(command: { [unowned self] in
            try await command($0, $1)
        }, object: { [unowned self] id, account, data in
            try await object("files", id, account: account, put: data)
        }, isCurrent: { [unowned self] in $0 == generation }, onFile: { [unowned self] in
            try await onFile?($0, $1)
        }, onError: { [weak self] in self?.error = $0.localizedDescription })
    }
    func command(_ name: String, _ args: [String: Any] = [:]) async throws -> Any {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)
        return try JSONSerialization.jsonObject(with: Data(try await core.raw(name, json: json).utf8), options: .fragmentsAllowed)
    }
    func request(server: String, path: String, token: String? = nil, method: String = "GET", body: Data? = nil, binary: Bool = false) async throws -> Data {
        guard let url = URL(string: SyncConfiguration.server(server) + path), ["https", "http"].contains(url.scheme) else { throw SyncFailure(message: "Invalid sync server") }
        var req = URLRequest(url: url); req.httpMethod = method; req.httpBody = body; req.timeoutInterval = 20
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if body != nil { req.setValue(binary ? "application/octet-stream" : "application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: req)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw SyncHTTPFailure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: message ?? "Sync server refused the request. Sign in again if your session expired.")
        }
        return data
    }
    func api(_ server: String, _ path: String, token: String? = nil, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try await request(server: server, path: path, token: token, method: method, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
    private func identity(_ account: SyncAccount) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: ["server": SyncConfiguration.server(account.server), "userId": account.userId], options: .sortedKeys), as: UTF8.self)
    }
    func start() async {
        do {
            account = try keychain.load()
            if let account {
                let state = try await command("sync_status") as? [String: Any] ?? [:]
                let storedIdentity = try identity(account)
                if let old = state["account"] as? String, old != account.userId && old != storedIdentity { _ = try await command("sync_disable") }
                _ = try await command("sync_enable", ["account": try identity(account)])
                let current = try await command("sync_status") as? [String: Any] ?? [:]
                let result = try await command("sync_reconcile", ["generation": current["generation"] ?? ""])
                try await deliver(result)
                resume()
            } else { _ = try await command("sync_disable") }
        } catch { self.error = error.localizedDescription }
    }
    func signIn(server: String, email: String, code: String) async throws -> (String, String, Bool) {
        let auth = try await api(server, SyncConfiguration.path("authVerify"), method: "POST", body: ["email": email, "code": code])
        guard let token = auth["token"] as? String, let user = auth["userId"] as? String else { throw SyncFailure(message: "Invalid sign-in response") }
        let info = try await api(server, SyncConfiguration.path("key"), token: token)
        return (token, user, info["key"] is NSNull)
    }
    func unlock(server: String, email: String, token: String, user: String, passphrase: String) async throws {
        var info = try await api(server, SyncConfiguration.path("key"), token: token)["key"] as? [String: String]
        var freshKey: (salt: String, key: [UInt8])?
        if info == nil {
            let salt = Array(syncNewSalt())
            let key = await Task.detached { nativeDeriveKey(passphrase: passphrase, salt: salt) }.value
            let check = try syncKeyCheck(key: Data(key), check: nil)
            freshKey = (Data(salt).base64EncodedString(), key)
            info = try await api(server, SyncConfiguration.path("key"), token: token, method: "PUT", body: ["salt": Data(salt).base64EncodedString(), "check": Data(check).base64EncodedString()])["key"] as? [String: String]
        }
        guard let info, let salt = Data(base64Encoded: info["salt"] ?? ""), let check = Data(base64Encoded: info["check"] ?? "") else { throw SyncFailure(message: "Invalid encryption parameters") }
        let key: [UInt8]
        if let freshKey, freshKey.salt == info["salt"] { key = freshKey.key }
        else { key = await Task.detached { nativeDeriveKey(passphrase: passphrase, salt: Array(salt)) }.value }
        _ = try syncKeyCheck(key: Data(key), check: check)
        stop()
        // Switching accounts must reset the old cursor/outbox before seeding.
        if let old = try keychain.load(), old.userId != user || SyncConfiguration.server(old.server) != SyncConfiguration.server(server) { _ = try await command("sync_disable") }
        let account = SyncAccount(server: SyncConfiguration.server(server), email: email, userId: user, token: token, key: key)
        try keychain.save(account)
        _ = try await command("sync_enable", ["account": try identity(account)])
        self.account = account; fatal = false; resume()
    }
    func signOut() async throws {
        stop(); try keychain.delete(); account = nil
        _ = try await command("sync_disable"); pending = 0; lastSynced = nil; status = "Not running."
    }
    func stop() {
        generation = UUID(); connection?.cancel(); ticker?.cancel(); transfers.cancel()
        connection = nil; ticker = nil; socket?.cancel(with: .goingAway, reason: nil); socket = nil
        ready = false; engine = nil; fileTransfers.reset()
    }
    func pause() { suspended = true; stop() }
    func resume() {
        suspended = false
        guard !fatal else { return }
        guard account != nil, connection == nil else { nudge(); return }
        let owner = generation
        connection = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && owner == generation {
                do { try await connect(owner) }
                catch {
                    guard !Task.isCancelled, owner == generation else { return }
                    if socket?.closeCode.rawValue == SyncConfiguration.integer("closeSignedOut") {
                        try? await signOut(); self.error = "Signed out because the cloud data was deleted."; return
                    }
                    if !fatal {
                        do {
                            guard let current = account else { return }
                            _ = try await api(current.server, SyncConfiguration.path("key"), token: current.token)
                        }
                        catch let auth as SyncHTTPFailure where auth.status == 401 { fatal = true }
                        catch { }
                    }
                    if fatal || socket?.closeCode == .policyViolation {
                        stop(); self.error = error.localizedDescription; status = "Sync stopped."; return
                    }
                    self.error = error.localizedDescription
                    status = "Offline. Changes are kept on this device and sync when you're back online."
                    ready = false; socket?.cancel(with: .goingAway, reason: nil)
                    let actions = try? drive("closed", ["code": socket?.closeCode.rawValue ?? 1006, "reason": error.localizedDescription])
                    let delay = actions?.first?["delay_ms"] as? Int ?? 1000
                    try? await Task.sleep(for: .milliseconds(delay))
                }
            }
        }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(SyncConfiguration.integer("PING_EVERY_MS")))
                guard !Task.isCancelled, let self else { return }
                if socket != nil {
                    do { try await execute(drive("tick", [:]), owner: generation) }
                    catch { socket?.cancel(with: .goingAway, reason: nil) }
                }
                nudge()
            }
        }
    }
    func syncNow() {
        fatal = false
        if connection == nil { resume() } else { nudge() }
    }
    func nudge() {
        guard !suspended else { return }
        transfers.nudge()
    }

    private func drive(_ event: String, _ payload: Any) throws -> [[String: Any]] {
        guard let engine else { return [] }
        let data = try JSONSerialization.data(withJSONObject: payload, options: .fragmentsAllowed)
        let result = try engine.drive(event: event, payload: String(decoding: data, as: UTF8.self))
        return try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [[String: Any]] ?? []
    }
    private func execute(_ actions: [[String: Any]], owner: UUID, frame: String? = nil) async throws {
        for action in actions {
            guard owner == generation, !Task.isCancelled else { throw CancellationError() }
            switch action["action"] as? String {
            case "send":
                guard let socket, let text = action["text"] as? String else { throw URLError(.networkConnectionLost) }
                try await socket.send(.string(text))
            case "apply":
                let result = try await command("sync_apply", ["entries": action["entries"] ?? [], "cursor": action["cursor"] ?? 0, "generation": databaseGeneration])
                try await deliver(result)
            case "ack": _ = try await command("sync_ack", ["maxId": action["max_id"] ?? 0, "generation": databaseGeneration])
            case "cursor": _ = try await command("sync_set_cursor", ["cursor": action["cursor"] ?? 0, "generation": databaseGeneration])
            case "upload":
                guard let account, let id = action["id"] as? String, let bytes = action["bytes"] as? [UInt8] else { throw SyncFailure(message: "Invalid upload") }
                _ = try await object("blobs", id, account: account, put: Data(bytes))
            case "download":
                guard let account, let id = action["id"] as? String, let frame else { throw SyncFailure(message: "Invalid download") }
                let bytes = try await object("blobs", id, account: account)
                guard owner == generation, !Task.isCancelled else { throw CancellationError() }
                _ = try drive("blob", ["id": id, "bytes": Array(bytes)])
                try await execute(drive("frame", frame), owner: owner, frame: frame)
            case "snapshot":
                guard let doc = action["doc"] as? String else { continue }
                let bytes = try await command("sync_snapshot", ["doc": doc, "generation": databaseGeneration])
                try await execute(drive("compact", ["doc": doc, "cursor": action["cursor"] ?? 0, "bytes": bytes]), owner: owner)
            case "ready": ready = true; lastSynced = Date(); status = "Up to date"; nudge()
            case "close":
                if action["code"] as? Int == SyncConfiguration.integer("closePolicy") { fatal = true }
                socket?.cancel(with: .init(rawValue: action["code"] as? Int ?? 4000) ?? .goingAway, reason: nil)
                throw SyncFailure(message: action["reason"] as? String ?? "Sync stopped")
            case "signedOut": try await signOut()
            default: break
            }
        }
    }
    private func connect(_ owner: UUID) async throws {
        guard let account, var url = URLComponents(string: SyncConfiguration.server(account.server) + SyncConfiguration.path("sync")) else { return }
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        let ws = session.webSocketTask(with: url.url!, protocols: [SyncConfiguration.text("protocol"), SyncConfiguration.text("authPrefix") + account.token])
        ws.maximumMessageSize = SyncConfiguration.integer("MAX_FRAME_BYTES"); socket = ws; ws.resume()
        status = "Syncing…"; error = nil
        let state = try await command("sync_status") as? [String: Any] ?? [:]
        databaseGeneration = state["generation"] as? String ?? ""
        if engine == nil { engine = try SyncSession(key: Data(account.key), cursor: Int64(state["cursor"] as? Int ?? 0)) }
        try await execute(drive("hello", ["cursor": state["cursor"] ?? 0]), owner: owner)
        while !Task.isCancelled && owner == generation {
            let frame = try await ws.receive()
            guard owner == generation else { return }
            let text: String
            switch frame { case .string(let s): text = s; case .data(let d): text = String(decoding: d, as: UTF8.self); @unknown default: continue }
            try await execute(drive("frame", text), owner: owner, frame: text)
        }
    }
    private func deliver(_ result: Any) async throws {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        NotificationCenter.default.post(name: .syncDidApply, object: SyncApplyResult(json: json))
    }
    private func object(_ kind: String, _ id: String, account: SyncAccount, put: Data? = nil) async throws -> Data {
        return try await request(server: account.server, path: SyncConfiguration.path(kind) + id, token: account.token, method: put == nil ? "GET" : "PUT", body: put, binary: true)
    }
    private func push() async throws {
        let state = try await command("sync_status") as? [String: Any] ?? [:]; pending = state["pending"] as? Int ?? 0
        guard ready, !pushing, engine != nil else { return }
        pushing = true; defer { pushing = false }
        let owner = generation
        let rows = try await command("sync_outbox", ["limitBytes": SyncConfiguration.integer("PUSH_BATCH_BYTES"), "generation": databaseGeneration])
        do { try await execute(drive("push", rows), owner: owner) }
        catch { socket?.cancel(with: .goingAway, reason: nil); throw error }
    }

}

struct SyncApplyResult: Sendable { let json: String }

extension Notification.Name { static let syncDidApply = Notification.Name("memnoter.syncDidApply") }

private func nativeDeriveKey(passphrase: String, salt: [UInt8]) -> [UInt8] {
    Array(syncDeriveKey(passphrase: passphrase, salt: Data(salt)))
}
private func nativeCrypt(key: [UInt8], doc: String, bytes: [UInt8], decrypt: Bool) throws -> [UInt8] {
    Array(try syncCrypt(key: Data(key), doc: doc, bytes: Data(bytes), decrypt: decrypt))
}

/// Each image retains its own retry deadline, so a missing or broken image
/// cannot block unrelated work. Pending rows remain durable in the Rust core.
@MainActor final class SyncFileTransfers {
    private let command: @MainActor (String, [String: Any]) async throws -> Any
    private let object: @MainActor (String, SyncAccount, Data?) async throws -> Data
    private let isCurrent: @MainActor (UUID) -> Bool
    private let onFile: @MainActor (String, String) async throws -> Void
    private let onError: @MainActor (Error) -> Void
    private var retryAfter: [String: Date] = [:]
    init(command: @escaping @MainActor (String, [String: Any]) async throws -> Any,
         object: @escaping @MainActor (String, SyncAccount, Data?) async throws -> Data,
         isCurrent: @escaping @MainActor (UUID) -> Bool,
         onFile: @escaping @MainActor (String, String) async throws -> Void,
         onError: @escaping @MainActor (Error) -> Void) {
        self.command = command; self.object = object; self.isCurrent = isCurrent
        self.onFile = onFile; self.onError = onError
    }
    func reset() { retryAfter.removeAll() }
    private func attempt(_ id: String, transfer: () async throws -> Void) async throws {
        if let deadline = retryAfter[id], deadline > Date() { return }
        do {
            try await transfer()
            retryAfter[id] = nil
        } catch {
            try Task.checkCancellation()
            if let failure = error as? SyncHTTPFailure, failure.status == 401 { throw failure }
            retryAfter[id] = Date().addingTimeInterval(30)
            // A 404 means the announcing device has not uploaded the image yet.
            if (error as? SyncHTTPFailure)?.status != 404 { onError(error) }
        }
    }
    func run(account: SyncAccount, owner: UUID) async throws {
        let state = try await command("sync_status", [:]) as? [String: Any] ?? [:]
        let databaseGeneration = state["generation"] as? String ?? ""
        let uploads = try await command("sync_pending_uploads", ["generation": databaseGeneration]) as? [String] ?? []
        let downloads = try await command("sync_missing_files", ["generation": databaseGeneration]) as? [[String: String]] ?? []
        guard isCurrent(owner) && !Task.isCancelled else { return }
        let pending = Set(uploads.map { "upload:" + $0 } + downloads.compactMap { file in
            file["fileId"].map { "download:" + $0 }
        })
        retryAfter = retryAfter.filter { pending.contains($0.key) }
        for id in uploads {
            guard isCurrent(owner) && !Task.isCancelled else { return }
            try await attempt("upload:" + id) {
                let file = try await command("read_file", ["moduleId": "", "fileId": id]) as? [String: Any] ?? [:]
                guard let bytes = file["bytes"] as? [UInt8] else { return }
                _ = try await object(id, account, Data(nativeCrypt(key: account.key, doc: SyncConfiguration.text("fileAadPrefix") + id, bytes: bytes, decrypt: false)))
                guard isCurrent(owner) && !Task.isCancelled else { return }
                _ = try await command("sync_upload_done", ["fileId": id, "generation": databaseGeneration])
            }
        }
        for file in downloads {
            guard isCurrent(owner) && !Task.isCancelled, let id = file["fileId"], let module = file["moduleId"] else { return }
            try await attempt("download:" + id) {
                let blob = try await object(id, account, nil)
                let bytes = try nativeCrypt(key: account.key, doc: SyncConfiguration.text("fileAadPrefix") + id, bytes: Array(blob), decrypt: true)
                guard isCurrent(owner) && !Task.isCancelled else { return }
                let stored = try await command("sync_store_file", ["generation": databaseGeneration, "fileId": id, "moduleId": module, "fileType": file["fileType"] ?? "", "bytes": bytes])
                let json = String(decoding: try JSONSerialization.data(withJSONObject: stored), as: UTF8.self)
                try await onFile(module, json)
            }
        }
    }
}
