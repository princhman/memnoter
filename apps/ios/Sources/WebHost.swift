import SwiftUI
import WebKit
import UniformTypeIdentifiers
import ImageIO

private func validPdfDocumentId(_ value: String) -> Bool {
    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= 256
}

private struct PdfViewStateRecord: Codable {
    let page: Int
    let zoom: Double
    init?(_ value: Any) {
        guard let object = value as? [String: Any], JSONSerialization.isValidJSONObject(object),
              let bytes = try? JSONSerialization.data(withJSONObject: object),
              let decoded = try? JSONDecoder().decode(Self.self, from: bytes),
              decoded.page > 0, decoded.page <= 9_007_199_254_740_991,
              decoded.zoom.isFinite, (0.25...3).contains(decoded.zoom) else { return nil }
        self = decoded
    }
    var payload: [String: Any] { ["page": page, "zoom": zoom] }
}

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
        // Core assets have UUID names, so determine their type from bytes.
        let key = ObjectIdentifier(task)
        pending[key] = Task {
          defer { pending[key] = nil }
          do {
            let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file) }.value
            guard !Task.isCancelled else { return }
            let mime: String
            if images {
                if data.starts(with: Array("%PDF-".utf8)) { mime = "application/pdf" }
                else if let source = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(source), let detected = UTType(type as String)?.preferredMIMEType { mime = detected }
                else if data.starts(with: [0x89, 0x50, 0x4e, 0x47]) { mime = "image/png" }
                else if data.starts(with: [0xff, 0xd8]) { mime = "image/jpeg" }
                else if data.starts(with: Array("GIF".utf8)) { mime = "image/gif" }
                else if data.count > 12 && String(decoding: data[8..<12], as: UTF8.self) == "WEBP" { mime = "image/webp" }
                else { mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream" }
            } else {
                mime = ["js": "text/javascript", "mjs": "text/javascript", "wasm": "application/wasm", "css": "text/css", "html": "text/html" ][file.pathExtension] ?? UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
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
// Report navigation/safe-area occlusion after UIKit has laid out the web view.
@MainActor final class EditorWebView: WKWebView {
    var viewportChanged: (() -> Void)?
    // WebKit forwards its content responder's accessory lookup here. The
    // phone form-navigation row duplicates our formatting/dismiss controls;
    // inputAssistantItem only controls the separate iPad shortcut groups.
    override var inputAccessoryView: UIView? {
        UIDevice.current.userInterfaceIdiom == .phone ? nil : super.inputAccessoryView
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        viewportChanged?()
    }
}
@MainActor @Observable final class WebSession: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    #if DEBUG
    private var scrollObservations: [NSKeyValueObservation] = []
    #endif
    var web: WKWebView!
    var bottomInset: CGFloat = 0 {
        didSet { if ready { reportBottomInset() } }
    }
    private var reportedViewport: [CGFloat] = []
    private var insetReport: Task<Void, Never>?
    private func reportBottomInset() {
        let viewport = [bottomInset, web.safeAreaInsets.top, web.bounds.height]
        guard viewport != reportedViewport else { return }
        insetReport?.cancel()
        insetReport = Task { @MainActor in
            do {
                guard !Task.isCancelled, ready else { return }
                reportedViewport = viewport
                _ = try await run("window.memnoterEditor?.[topMethod](top * window.innerHeight / height); window.memnoterEditor?.[bottomMethod](inset * window.innerHeight / height)",
                                  ["topMethod": EditorApiMethod.setTopInset.rawValue, "bottomMethod": EditorApiMethod.setBottomInset.rawValue,
                                   "inset": bottomInset, "top": web.safeAreaInsets.top, "height": max(1, web.bounds.height)])
            } catch is CancellationError { }
            catch { self.error = String(describing: error) }
        }
    }
    var reviewState = ReviewState()
    var imagePreviewOpen = false
    var drawingToEdit: DrawingOpenEvent?
    var filesOpen = false
    var pdfCoveringNote = false
    var pdfFocused = false
    var requestedPdfImport: String?
    var requestedModule: String?
    var ready = false
    var headings: [Heading] = []
    var allHeadings: [Heading] = []
    var currentHeadingId: String?
    private var outlineTracking = false
    func trackOutline(_ enabled: Bool) {
        outlineTracking = enabled
        guard ready else { return }
        Task {
            guard ready else { return }
            do { _ = try await run("window.memnoterEditor?.[method](enabled)", ["method": EditorApiMethod.setOutlineTracking.rawValue, "enabled": outlineTracking]) }
            catch { self.error = String(describing: error) }
        }
    }
    var state = EditorState()
    var error: String?
    var saveStatus = ""
    var onReady: (() -> Void)?
    let client: CoreClient
    private let preferences: UserDefaults
    private func storedPdfViewStates() -> [String: PdfViewStateRecord] {
        var result: [String: PdfViewStateRecord] = [:]
        for (id, value) in preferences.dictionary(forKey: "pdfViewState") ?? [:] {
            if validPdfDocumentId(id), let state = PdfViewStateRecord(value) { result[id] = state }
        }
        return result
    }
    private var moduleId: String?
    private var generation = UUID()
    private var barrier: Task<Void, Error>?
    init(client: CoreClient, directory: URL, entry: String = BridgeProtocol.editorEntry, preferences: UserDefaults = .standard) {
        self.client = client
        self.preferences = preferences
        super.init()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "memnoter")
        // Inject decoded JSON before the shared store mounts, independent of
        // Web Storage support for our custom scheme origin.
        let savedView = preferences.string(forKey: "editorViewState") ?? "{}"
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__memnoterViewState = \(savedView);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let pdfViewScript: String
        do {
            let json = try JSONEncoder().encode(storedPdfViewStates())
            let literal = try JSONEncoder().encode(String(decoding: json, as: UTF8.self))
            pdfViewScript = "window.__memnoterPdfViewState = JSON.parse(\(String(decoding: literal, as: UTF8.self)));"
        } catch { pdfViewScript = "window.__memnoterPdfViewState = {};" }
        config.userContentController.addUserScript(WKUserScript(
            source: pdfViewScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.setURLSchemeHandler(ResourceHandler(root: directory, images: true), forURLScheme: BridgeProtocol.fileScheme)
        config.setURLSchemeHandler(ResourceHandler(root: Bundle.main.resourceURL!.appendingPathComponent("Web"), images: false), forURLScheme: BridgeProtocol.appScheme)
        let editorWeb = EditorWebView(frame: .zero, configuration: config)
        web = editorWeb
        // The HTML inner container owns scrolling; UIKit must not pan the page
        // to reveal a caret while JS is revealing it in that container.
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        config.userContentController.addUserScript(WKUserScript(source: "window.__memnoterScrollDebug = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scrollObservations = [
            web.scrollView.observe(\.contentOffset, options: [.old, .new]) { _, change in
                NSLog("[scroll \(Date().timeIntervalSince1970)] native offset \(change)")
            },
            web.scrollView.observe(\.contentInset, options: [.old, .new]) { _, change in
                NSLog("[scroll \(Date().timeIntervalSince1970)] native inset \(change)")
            }
        ]
        #endif
        editorWeb.viewportChanged = { [weak self] in
            guard let self, self.ready else { return }
            self.reportBottomInset()
        }
        // Clear before loading so even the initial page paint uses the native surface.
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.underPageBackgroundColor = .clear
        hideEditorInputAssistant()
        for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange), name: name, object: nil)
        }
        web.uiDelegate = self
        web.navigationDelegate = self
        #if DEBUG
        web.isInspectable = true
        #endif
        web.load(URLRequest(url: URL(string: "\(BridgeProtocol.appScheme)://localhost/\(entry)")!))
    }
    // WKWebView delegates text input to a content subview. Use only public
    // UIView / UIResponder APIs, without private selectors or runtime changes.
    private var editorInputViews: [UIView] {
        func descendants(_ view: UIView) -> [UIView] {
            [view] + view.subviews.flatMap { descendants($0) }
        }
        return descendants(web.scrollView).filter {
            $0.isFirstResponder || String(describing: type(of: $0)).hasPrefix("WKContent")
        }
    }
    var editorFirstResponder: UIView? { editorInputViews.first { $0.isFirstResponder } }

    func hideEditorInputAssistant() {
        for view in [web!] + editorInputViews {
            let item = view.inputAssistantItem
            let changed = !item.leadingBarButtonGroups.isEmpty || !item.trailingBarButtonGroups.isEmpty
            item.leadingBarButtonGroups = []
            item.trailingBarButtonGroups = []
            if changed && view.isFirstResponder { view.reloadInputViews() }
        }
    }
    @objc private func keyboardWillChange(_ notification: Notification) {
        #if DEBUG
        NSLog("[scroll \(Date().timeIntervalSince1970)] keyboard \(notification.name) \(notification.userInfo ?? [:])")
        #endif
        hideEditorInputAssistant()
    }

    // Keep WebKit's native rich clipboard and paste permission handling.
    func clipboard(_ action: Selector) {
        guard let responder = editorFirstResponder,
              responder.canPerformAction(action, withSender: nil) else { return }
        switch action {
        case #selector(UIResponderStandardEditActions.copy(_:)): responder.copy(nil)
        case #selector(UIResponderStandardEditActions.cut(_:)): responder.cut(nil)
        case #selector(UIResponderStandardEditActions.paste(_:)): responder.paste(nil)
        default: break
        }
    }
    func run(_ script: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: .page)
    }
    func exec(_ command: ExecCommand, _ args: [String: Any] = [:], focusAfter: Bool = false) {
        let target = moduleId
        Task {
            guard target == moduleId else { return }
            do {
                #if DEBUG
                print("[editor exec] \(command) \(args)")
                #endif
                // Tiptap also returns false for harmless no-ops, such as setting
                // an existing paragraph. Failures arrive through the error event
                // or the JavaScript exception handled below.
                _ = try await execute(command, args)
                if focusAfter { _ = try await callEditor(.focus) }
            } catch { self.error = String(describing: error) }
        }
    }
    func callEditor(_ method: EditorApiMethod, _ arguments: [String: Any] = [:], parameters: [String] = []) async throws -> Any? {
        try await run("return await window.memnoterEditor.\(method.rawValue)(\(parameters.joined(separator: ",")))", arguments)
    }
    func callReview(_ method: ReviewApiMethod, _ arguments: [String: Any] = [:], parameters: [String] = []) async throws -> Any? {
        try await run("return await window.memnoterReview.\(method.rawValue)(\(parameters.joined(separator: ",")))", arguments)
    }
    func execute(_ command: ExecCommand, _ args: [String: Any] = [:]) async throws -> Any? {
        try await callEditor(.exec, ["command": command.rawValue, "args": args], parameters: ["command", "args"])
    }
    func toggleFiles() {
        guard ready, let target = moduleId else { return }
        Task {
            guard ready, target == moduleId else { return }
            do { _ = try await callEditor(.toggleFiles) }
            catch { self.error = String(describing: error) }
        }
    }
    private func serialized(_ method: EditorApiMethod, _ arguments: [String: Any] = [:], parameters: [String] = []) async throws {
        let previous = barrier
        let next = Task { @MainActor in
            // A failed flush can be retried; open itself also drains pending writes.
            do { _ = try await previous?.value }
            catch { NSLog("Previous editor operation failed; retrying: %@", String(describing: error)) }
            _ = try await callEditor(method, arguments, parameters: parameters)
        }
        barrier = next
        try await next.value
    }
    func flush() async throws { guard ready else { return }; try await serialized(.flush) }
    func open(_ id: String) async throws {
        if moduleId != id {
            moduleId = id
            state = EditorState(); headings = []; allHeadings = []; currentHeadingId = nil
            filesOpen = false; pdfCoveringNote = false; pdfFocused = false
            requestedPdfImport = nil; requestedModule = nil
        }
        try await serialized(.open, ["id": id], parameters: ["id"])
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideEditorInputAssistant()
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        generation = UUID(); ready = false; reportedViewport = []
        filesOpen = false; pdfCoveringNote = false; pdfFocused = false
        requestedPdfImport = nil; requestedModule = nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == BridgeProtocol.appScheme { return .allow }
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
                    let result: String
                    if command == BridgeProtocol.pdfChunkCommand {
                        let args = try JSONDecoder().decode(PdfChunkArgs.self, from: bytes)
                        let reply = try await client.readPdfChunk(args)
                        result = String(decoding: try JSONEncoder().encode(reply), as: UTF8.self)
                    } else {
                        result = try await client.raw(command, json: String(decoding: bytes, as: UTF8.self))
                    }
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
            do {
                guard let event = NativeEventName(rawValue: event) else { throw CocoaError(.coderReadCorrupt) }
                switch event {
                #if DEBUG
                case .scrollDebug: NSLog("[scroll JS] \(payload)")
                #endif
                case .viewState:
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    preferences.set(String(decoding: data, as: UTF8.self), forKey: "editorViewState")
                case .pdfViewState:
                    guard let id = payload["documentId"] as? String, validPdfDocumentId(id),
                          let state = PdfViewStateRecord(payload) else { return }
                    var states = storedPdfViewStates()
                    states[id] = state
                    preferences.set(states.mapValues { $0.payload }, forKey: "pdfViewState")
                case .ready:
                    guard payload["protocolVersion"] as? Int == BridgeProtocol.version else {
                        throw NSError(domain: "BridgeProtocol", code: 1, userInfo: [NSLocalizedDescriptionKey: "Incompatible web bridge protocol version"])
                    }
                    ready = true
                    trackOutline(outlineTracking)
                    reportBottomInset()
                    let token = generation
                    Task {
                        await updateCardPreference()
                        guard token == generation else { return }
                        let callback = onReady
                        onReady = nil
                        callback?()
                    }
                case .reviewState:
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    reviewState = try JSONDecoder().decode(ReviewState.self, from: data)
                case .cardsChanged:
                    NotificationCenter.default.post(name: .cardsDidChange, object: client)
                case .imagePreview:
                    imagePreviewOpen = payload["open"] as? Bool == true
                case .editDrawing:
                    guard payload["moduleId"] as? String == moduleId else { return }
                    drawingToEdit = try JSONDecoder().decode(DrawingOpenEvent.self, from: JSONSerialization.data(withJSONObject: payload))
                case .pickPdfs:
                    guard ready, let destination = payload["moduleId"] as? String, destination == moduleId else { return }
                    requestedPdfImport = destination
                case .openModule:
                    guard ready, moduleId != nil, let destination = payload["moduleId"] as? String, !destination.isEmpty else { return }
                    requestedModule = destination
                case .pdfState:
                    guard ready, let currentModule = moduleId, payload["moduleId"] as? String == currentModule else { return }
                    filesOpen = payload["open"] as? Bool == true
                    pdfCoveringNote = filesOpen && (payload["coveringNote"] as? Bool == true)
                    pdfFocused = filesOpen && (payload["focused"] as? Bool == true)
                case .outlineCurrent:
                    guard payload["moduleId"] as? String == moduleId else { return }
                    currentHeadingId = payload["currentHeadingId"] as? String
                case .outline:
                    guard payload["moduleId"] as? String == moduleId else { return }
                    guard let value = payload["headings"] else { throw CocoaError(.coderValueNotFound) }
                    let data = try JSONSerialization.data(withJSONObject: value)
                    headings = try JSONDecoder().decode([Heading].self, from: data)
                    let complete = try JSONSerialization.data(withJSONObject: payload["allHeadings"] ?? value)
                    allHeadings = try JSONDecoder().decode([Heading].self, from: complete)
                case .state:
                    #if DEBUG
                    print("[editor state] \(payload)")
                    #endif
                    guard payload["moduleId"] as? String == moduleId else {
                        #if DEBUG
                        print("[editor state ignored] expected module \(String(describing: moduleId))")
                        #endif
                        return
                    }
                    let data = try JSONSerialization.data(withJSONObject: payload)
                    state = try JSONDecoder().decode(EditorState.self, from: data)
                case .error: error = payload["message"] as? String
                case .saveStatus: saveStatus = payload["failing"] as? Bool == true ? "Save failed" : (payload["pending"] as? Int ?? 0) > 0 ? "Saving…" : ""
                default: break
                }
            } catch {
                self.error = "Native bridge event \(event) failed: \(error)"
                NSLog("%@", self.error!)
            }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { self.error = String(describing: error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { error = "The editor process stopped. Reopen the app to recover saved notes." }
    func updateCardPreference() async {
        guard ready else { return }
        do { _ = try await run("window.__memnoterBridge.emit(event, enabled)", ["event": NativeEventName.skipCardsCreatedToday.rawValue, "enabled": preferences.bool(forKey: "skipCardsCreatedToday")]) }
        catch { self.error = String(describing: error) }
    }
    func dispose() { onReady = nil; insetReport?.cancel(); insetReport = nil; NotificationCenter.default.removeObserver(self); generation = UUID(); web.configuration.userContentController.removeScriptMessageHandler(forName: "memnoter") }
}
struct WebSurface: UIViewRepresentable {
    let session: WebSession
    func makeUIView(context: Context) -> WKWebView { session.web }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

extension Notification.Name { static let cardsDidChange = Notification.Name("memnoter.cardsDidChange") }
