import Foundation
import Security
import MemnoterCore

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
    var onRemote: ((String) async throws -> Void)?
    var onFile: ((String, String) async throws -> Void)?
    private var connection: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    @ObservationIgnored private var transfers: SyncTransferWorker!
    @ObservationIgnored private var fileTransfers: SyncFileTransfers!
    private var socket: URLSessionWebSocketTask?
    private var ready = false
    private var inflight: (id: Int, max: Int)?
    private var pushing = false
    private var nextId = 0
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
        guard let url = URL(string: server + path), ["https", "http"].contains(url.scheme) else { throw SyncFailure(message: "Invalid sync server") }
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
    func start() async {
        do {
            account = try keychain.load()
            if let account {
                let state = try await command("sync_status") as? [String: Any] ?? [:]
                if let old = state["account"] as? String, old != account.userId { _ = try await command("sync_disable") }
                _ = try await command("sync_enable", ["account": account.userId])
                let result = try await command("sync_reconcile")
                try await deliver(result)
                resume()
            } else { _ = try await command("sync_disable") }
        } catch { self.error = error.localizedDescription }
    }
    func signIn(server: String, email: String, code: String) async throws -> (String, String, Bool) {
        let auth = try await api(server, "/v1/auth/verify", method: "POST", body: ["email": email, "code": code])
        guard let token = auth["token"] as? String, let user = auth["userId"] as? String else { throw SyncFailure(message: "Invalid sign-in response") }
        let info = try await api(server, "/v1/key", token: token)
        return (token, user, info["key"] is NSNull)
    }
    func unlock(server: String, email: String, token: String, user: String, passphrase: String) async throws {
        var info = try await api(server, "/v1/key", token: token)["key"] as? [String: String]
        if info == nil {
            var salt = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, salt.count, &salt) == errSecSuccess else { throw SyncFailure(message: "Could not generate encryption salt") }
            let key = await Task.detached { nativeDeriveKey(passphrase: passphrase, salt: salt) }.value
            let check = try nativeCrypt(key: key, doc: "key-check", bytes: Array("memnoter-key-check".utf8), decrypt: false)
            info = try await api(server, "/v1/key", token: token, method: "PUT", body: ["salt": Data(salt).base64EncodedString(), "check": Data(check).base64EncodedString()])["key"] as? [String: String]
        }
        guard let info, let salt = Data(base64Encoded: info["salt"] ?? ""), let check = Data(base64Encoded: info["check"] ?? "") else { throw SyncFailure(message: "Invalid encryption parameters") }
        let key = await Task.detached { nativeDeriveKey(passphrase: passphrase, salt: Array(salt)) }.value
        guard (try? nativeCrypt(key: key, doc: "key-check", bytes: Array(check), decrypt: true)) == Array("memnoter-key-check".utf8) else { throw SyncFailure(message: "That passphrase doesn't match the one set for this account.") }
        stop()
        // Switching accounts must reset the old cursor/outbox before seeding.
        if let old = try keychain.load(), old.userId != user || old.server != server { _ = try await command("sync_disable") }
        let account = SyncAccount(server: server, email: email, userId: user, token: token, key: key)
        try keychain.save(account)
        _ = try await command("sync_enable", ["account": user])
        self.account = account; fatal = false; resume()
    }
    func signOut() async throws {
        stop(); try keychain.delete(); account = nil
        _ = try await command("sync_disable"); pending = 0; lastSynced = nil; status = "Not running."
    }
    func stop() {
        generation = UUID(); connection?.cancel(); ticker?.cancel(); transfers.cancel()
        connection = nil; ticker = nil; socket?.cancel(with: .goingAway, reason: nil); socket = nil
        ready = false; inflight = nil; fileTransfers.reset()
    }
    func pause() { suspended = true; stop() }
    func resume() {
        suspended = false
        guard !fatal else { return }
        guard account != nil, connection == nil else { nudge(); return }
        let owner = generation
        connection = Task { [weak self] in
            guard let self else { return }
            var attempts = 0
            while !Task.isCancelled && owner == generation {
                do { try await connect(owner); attempts = 0 }
                catch {
                    guard !Task.isCancelled, owner == generation else { return }
                    if socket?.closeCode.rawValue == 4003 {
                        try? await signOut(); self.error = "Signed out because the cloud data was deleted."; return
                    }
                    if !fatal {
                        do {
                            guard let current = account else { return }
                            _ = try await api(current.server, "/v1/key", token: current.token)
                        }
                        catch let auth as SyncHTTPFailure where auth.status == 401 { fatal = true }
                        catch { }
                    }
                    if fatal || socket?.closeCode == .policyViolation {
                        stop(); self.error = error.localizedDescription; status = "Sync stopped."; return
                    }
                    self.error = error.localizedDescription
                    status = "Offline. Changes are kept on this device and sync when you're back online."
                    ready = false; inflight = nil; socket?.cancel(with: .goingAway, reason: nil)
                    attempts = min(attempts + 1, 5)
                    try? await Task.sleep(for: .seconds(min(30, pow(2, Double(attempts)))))
                }
            }
        }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self else { return }
                if let ws = socket, ready {
                    ws.sendPing { error in
                        if error != nil { ws.cancel(with: .goingAway, reason: nil) }
                    }
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

    private func send(_ value: [String: Any]) async throws {
        guard let socket else { throw URLError(.networkConnectionLost) }
        try await socket.send(.string(String(decoding: JSONSerialization.data(withJSONObject: value), as: UTF8.self)))
    }
    private func connect(_ owner: UUID) async throws {
        guard let account, var url = URLComponents(string: account.server + "/v1/sync") else { return }
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        let ws = session.webSocketTask(with: url.url!, protocols: ["memnoter.v1", "auth." + account.token])
        ws.maximumMessageSize = 16 * 1024 * 1024; socket = ws; ws.resume()
        status = "Syncing…"; error = nil
        let state = try await command("sync_status") as? [String: Any] ?? [:]
        try await send(["t": "hello", "cursor": state["cursor"] ?? 0, "v": 1])
        while !Task.isCancelled && owner == generation {
            let frame = try await ws.receive()
            guard owner == generation else { return }
            let data: Data
            switch frame { case .string(let s): data = Data(s.utf8); case .data(let d): data = d; @unknown default: continue }
            if data == Data("pong".utf8) { continue }
            guard let msg = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            switch msg["t"] as? String {
            case "entries":
                var entries: [[String: Any]] = []
                for entry in msg["entries"] as? [[String: Any]] ?? [] {
                    guard let doc = entry["doc"] as? String, let encoded = entry["data"] as? String, var blob = Data(base64Encoded: encoded) else { throw SyncFailure(message: "Invalid sync entry") }
                    if blob.count == 33 && blob.first == 2 { blob = try await object("blobs", String(decoding: blob.dropFirst(), as: UTF8.self), account: account) }
                    let bytes: [UInt8]
                    do { bytes = try nativeCrypt(key: account.key, doc: doc, bytes: Array(blob), decrypt: true) }
                    catch { fatal = true; throw SyncFailure(message: "Synced data could not be decrypted. Check your sync passphrase.") }
                    entries.append(["seq": entry["seq"] ?? 0, "doc": doc, "bytes": bytes])
                }
                let cursor = (entries.compactMap { $0["seq"] as? Int }).max() ?? 0
                guard owner == generation else { return }
                if !entries.isEmpty { let result = try await command("sync_apply", ["entries": entries, "cursor": cursor]); try await deliver(result) }
            case "ready":
                _ = try await command("sync_set_cursor", ["cursor": msg["head"] ?? 0])
                guard owner == generation else { return }
                ready = true
                lastSynced = Date(); status = "Up to date"; nudge()
            case "ack":
                if let inflight, msg["id"] as? Int == inflight.id {
                    _ = try await command("sync_ack", ["maxId": inflight.max])
                    guard owner == generation else { return }
                    _ = try await command("sync_set_cursor", ["cursor": msg["seq"] ?? 0])
                    self.inflight = nil; lastSynced = Date(); status = "Up to date"; nudge()
                }
            case "compact-hint":
                if let doc = msg["doc"] as? String, let upTo = msg["upTo"] as? Int {
                    let state = try await command("sync_status") as? [String: Any] ?? [:]
                    if let cursor = state["cursor"] as? Int, cursor >= upTo {
                        if let bytes = try await command("sync_snapshot", ["doc": doc]) as? [UInt8] {
                            let data = try await storable(Data(nativeCrypt(key: account.key, doc: doc, bytes: bytes, decrypt: false)), account: account)
                            guard owner == generation else { return }
                            try await send(["t": "compact", "doc": doc, "upTo": cursor, "data": data.base64EncodedString()])
                        } else { try await send(["t": "drop", "doc": doc]) }
                    }
                }
            case "error": fatal = msg["fatal"] as? Bool ?? false; throw SyncFailure(message: msg["message"] as? String ?? "Sync stopped.")
            default: break
            }
        }
    }
    private func deliver(_ result: Any) async throws {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        try await onRemote?(json)
        NotificationCenter.default.post(name: .syncDidApply, object: nil)
    }
    private func object(_ kind: String, _ id: String, account: SyncAccount, put: Data? = nil) async throws -> Data {
        return try await request(server: account.server, path: "/v1/\(kind)/\(id)", token: account.token, method: put == nil ? "GET" : "PUT", body: put, binary: true)
    }
    private func storable(_ blob: Data, account: SyncAccount) async throws -> Data {
        if blob.count <= 1_900_000 { return blob }
        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        _ = try await object("blobs", id, account: account, put: blob)
        return Data([2]) + Data(id.utf8)
    }
    private func push() async throws {
        let state = try await command("sync_status") as? [String: Any] ?? [:]; pending = state["pending"] as? Int ?? 0
        guard ready, inflight == nil, !pushing, let account else { return }
        pushing = true; defer { pushing = false }
        let owner = generation
        let rows = try await command("sync_outbox", ["limitBytes": 1_048_576]) as? [[String: Any]] ?? []
        guard let max = rows.last?["id"] as? Int else { return }
        guard owner == generation else { return }
        let dropped = Set(rows.filter { ($0["bytes"] as? [UInt8])?.isEmpty == true }.compactMap { $0["doc"] as? String })
        var entries: [[String: Any]] = []
        for row in rows {
            guard owner == generation else { return }
            guard let doc = row["doc"] as? String, let bytes = row["bytes"] as? [UInt8] else { continue }
            if dropped.contains(doc) { entries.append(["doc": doc, "drop": true]); continue }
            let blob = try await storable(Data(nativeCrypt(key: account.key, doc: doc, bytes: bytes, decrypt: false)), account: account)
            entries.append(["doc": doc, "data": blob.base64EncodedString()])
        }
        guard owner == generation, ready else { return }
        nextId += 1; inflight = (nextId, max); status = "Syncing…"
        do { try await send(["t": "push", "id": nextId, "entries": entries]) }
        catch { inflight = nil; socket?.cancel(with: .goingAway, reason: nil); throw error }
    }

}

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
        for id in try await command("sync_pending_uploads", [:]) as? [String] ?? [] {
            guard isCurrent(owner) && !Task.isCancelled else { return }
            try await attempt("upload:" + id) {
                let file = try await command("read_file", ["moduleId": "", "fileId": id]) as? [String: Any] ?? [:]
                guard let bytes = file["bytes"] as? [UInt8] else { return }
                _ = try await object(id, account, Data(nativeCrypt(key: account.key, doc: "file:" + id, bytes: bytes, decrypt: false)))
                guard isCurrent(owner) && !Task.isCancelled else { return }
                _ = try await command("sync_upload_done", ["fileId": id])
            }
        }
        for file in try await command("sync_missing_files", [:]) as? [[String: String]] ?? [] {
            guard isCurrent(owner) && !Task.isCancelled, let id = file["fileId"], let module = file["moduleId"] else { return }
            try await attempt("download:" + id) {
                let blob = try await object(id, account, nil)
                let bytes = try nativeCrypt(key: account.key, doc: "file:" + id, bytes: Array(blob), decrypt: true)
                guard isCurrent(owner) && !Task.isCancelled else { return }
                let stored = try await command("sync_store_file", ["fileId": id, "moduleId": module, "fileType": file["fileType"] ?? "", "bytes": bytes])
                let json = String(decoding: try JSONSerialization.data(withJSONObject: stored), as: UTF8.self)
                try await onFile(module, json)
            }
        }
    }
}
