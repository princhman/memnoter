import SwiftUI
import WebKit
import UniformTypeIdentifiers
import ImageIO

/// Paths are decoded once by URLComponents and confined to one bundle/data child.
@MainActor final class ResourceHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    let images: Bool
    init(root: URL, images: Bool) { self.root = root; self.images = images }
    private var pending: [ObjectIdentifier: Task<Void, Never>] = [:]
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "localhost" else {
            task.didFailWithError(URLError(.badURL)); return
        }
        let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        let parts = encoded.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map { String($0).removingPercentEncoding ?? ".." }
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\\") }),
              !images || (parts.count == 2 && parts[0] == "files") else {
            task.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        let file = parts.reduce(root) { $0.appendingPathComponent($1) }
        // Core image files have UUID names, so determine image type from bytes.
        let key = ObjectIdentifier(task)
        pending[key] = Task {
          defer { pending[key] = nil }
          do {
            let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file) }.value
            guard !Task.isCancelled else { return }
            let mime: String
            if images {
                if let source = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(source), let detected = UTType(type as String)?.preferredMIMEType { mime = detected }
                else if data.starts(with: [0x89, 0x50, 0x4e, 0x47]) { mime = "image/png" }
                else if data.starts(with: [0xff, 0xd8]) { mime = "image/jpeg" }
                else if data.starts(with: Array("GIF".utf8)) { mime = "image/gif" }
                else if data.count > 12 && String(decoding: data[8..<12], as: UTF8.self) == "WEBP" { mime = "image/webp" }
                else { mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream" }
            } else {
                mime = ["js": "text/javascript", "css": "text/css", "html": "text/html" ][file.pathExtension] ?? UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            }
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data); task.didFinish()
          } catch { if !Task.isCancelled { task.didFailWithError(error) } }
        }
    }
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        pending.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }
}
struct Heading: Decodable, Identifiable { let id: String; let level: Int; let text: String; let folded: Bool }
struct SectionCrumb: Decodable, Identifiable { let id: String; let level: Int; let title: String }
struct FocusableSection: Decodable { let pos: Int; let id: String?; let title: String; let level: Int }
struct EditorState: Decodable {
    var focusableSection: FocusableSection?
    var focusedSectionPath: [SectionCrumb] = []
    var focusedSectionId: String?; var headingId: String?
    var blockType = "paragraph"; var headingLevel: Int?
    var canIndent = false; var canOutdent = false
    var canMakeCard = false; var inCloze = false; var canJoinClozes = false
    var folded = false; var canFold = false
    var bulletList = false; var orderedList = false; var blockquote = false
    var marks: [String] = []; var canUndo = false; var canRedo = false; var editable = false
}
@MainActor @Observable final class WebSession: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    var web: WKWebView!
    var ready = false
    var headings: [Heading] = []
    var state = EditorState()
    var error: String?
    var saveStatus = ""
    var onReady: (() -> Void)?
    let client: CoreClient
    private var moduleId: String?
    private var generation = UUID()
    private var barrier: Task<Void, Error>?
    init(client: CoreClient, directory: URL, entry: String = "editor.html") {
        self.client = client
        super.init()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "memnoter")
        // Inject decoded JSON before the shared store mounts, independent of
        // Web Storage support for our custom scheme origin.
        let savedView = UserDefaults.standard.string(forKey: "editorViewState") ?? "{}"
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__memnoterViewState = \(savedView);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.setURLSchemeHandler(ResourceHandler(root: directory, images: true), forURLScheme: "memnoter-file")
        config.setURLSchemeHandler(ResourceHandler(root: Bundle.main.resourceURL!.appendingPathComponent("Web"), images: false), forURLScheme: "memnoter-app")
        web = WKWebView(frame: .zero, configuration: config)
        // Clear before loading so even the initial page paint uses the native surface.
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.underPageBackgroundColor = .clear
        web.uiDelegate = self
        web.navigationDelegate = self
        #if DEBUG
        web.isInspectable = true
        #endif
        web.load(URLRequest(url: URL(string: "memnoter-app://localhost/\(entry)")!))
    }
    func run(_ script: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: .page)
    }
    func exec(_ command: String, _ args: [String: Any] = [:]) {
        let target = moduleId
        Task {
            guard target == moduleId else { return }
            do {
                #if DEBUG
                print("[editor exec] \(command) \(args)")
                #endif
                let reply = try await run("return window.memnoterEditor.exec(command, args)", ["command": command, "args": args])
                #if DEBUG
                print("[editor reply] \(command): \(String(describing: reply))")
                #endif
                if reply as? Bool == false { self.error = "Editor could not perform \(command)." }
            } catch { self.error = String(describing: error) }
        }
    }
    private func serialized(_ script: String, _ arguments: [String: Any] = [:]) async throws {
        let previous = barrier
        let next = Task { @MainActor in
            // A failed flush can be retried; open itself also drains pending writes.
            _ = try? await previous?.value
            _ = try await run(script, arguments)
        }
        barrier = next
        try await next.value
    }
    func flush() async throws { guard ready else { return }; try await serialized("await window.memnoterEditor.flush()") }
    func open(_ id: String) async throws {
        if moduleId != id {
            moduleId = id
            state = EditorState(); headings = []
        }
        try await serialized("await window.memnoterEditor.open(id)", ["id": id])
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        generation = UUID(); ready = false
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "memnoter-app" { return .allow }
        if ["https", "http", "mailto"].contains(url.scheme ?? "") { await UIApplication.shared.open(url) }
        return .cancel
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["kind"] as? String == "call", let id = body["id"] as? String, let command = body["command"] as? String {
            let token = generation
            Task {
                do {
                    let bytes = try JSONSerialization.data(withJSONObject: body["args"] ?? [:])
                    let result = try await client.raw(command, json: String(decoding: bytes, as: UTF8.self))
                    guard token == generation else { return }
                    let value = try JSONSerialization.jsonObject(with: Data(result.utf8), options: [.fragmentsAllowed])
                    _ = try await run("window.__memnoterBridge.resolve(id, value)", ["id": id, "value": value])
                } catch {
                    guard token == generation else { return }
                    do { _ = try await run("window.__memnoterBridge.reject(id, error)", ["id": id, "error": String(describing: error)]) }
                    catch { self.error = String(describing: error) }
                }
            }
        } else if body["kind"] as? String == "event", let event = body["event"] as? String {
            let payload = body["payload"] as? [String: Any] ?? [:]
            switch event {
            case "viewState":
                if let data = try? JSONSerialization.data(withJSONObject: payload),
                   let json = String(data: data, encoding: .utf8) {
                    UserDefaults.standard.set(json, forKey: "editorViewState")
                }
            case "ready": ready = true; onReady?()
            case "outline":
                guard payload["moduleId"] as? String == moduleId else { return }
                if let data = try? JSONSerialization.data(withJSONObject: payload["headings"] ?? []) { headings = (try? JSONDecoder().decode([Heading].self, from: data)) ?? [] }
            case "state":
                #if DEBUG
                print("[editor state] \(payload)")
                #endif
                guard payload["moduleId"] as? String == moduleId else {
                    #if DEBUG
                    print("[editor state ignored] expected module \(String(describing: moduleId))")
                    #endif
                    return
                }
                do {
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    state = try JSONDecoder().decode(EditorState.self, from: data)
                } catch {
                    #if DEBUG
                    print("[editor state decode failed] \(error)")
                    #endif
                }
            case "error": error = payload["message"] as? String
            case "saveStatus": saveStatus = payload["failing"] as? Bool == true ? "Save failed" : (payload["pending"] as? Int ?? 0) > 0 ? "Saving…" : ""
            default: break
            }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { self.error = String(describing: error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { error = "The editor process stopped. Reopen the app to recover saved notes." }
    func dispose() { generation = UUID(); web.configuration.userContentController.removeScriptMessageHandler(forName: "memnoter") }
}
struct WebSurface: UIViewRepresentable {
    let session: WebSession
    func makeUIView(context: Context) -> WKWebView { session.web }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
