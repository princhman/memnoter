import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct RootView: View {
    @Bindable var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var session: WebSession?
    @State private var backgroundWork: Task<Void, Never>?
    @State private var previewColumnVisibility: NavigationSplitViewVisibility?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @AppStorage("selectedDestination") private var savedDestination = "home"
    private var selected: String? {
        get { savedDestination }
        nonmutating set { savedDestination = newValue ?? "home" }
    }
    @AppStorage("skipCardsCreatedToday") private var skipCardsCreatedToday = false
    @AppStorage("sidebarVisible") private var sidebarVisible = true
    @State private var reviewModule: String?
    @State private var search = ""
    @State private var hits: [SearchHit] = []
    @State private var showSearch = false
    @State private var showSettings = false
    @State private var editingName = false
    @State private var rename: NoteModule?
    @State private var name = ""
    @State private var busy = false
    @State private var image: PhotosPickerItem?
    @State private var showingPdfImporter = false
    @State private var pdfImportModuleId: String?
    @State private var find = ""
    @State private var showingContents = false
    @State private var showingFind = false
    @FocusState private var findFocused: Bool
    @State private var keyboardDocked = false
    @State private var keyboardTop: CGFloat = 0
    @State private var deleting: NoteModule?
    @State private var detailWidth: CGFloat = 0
    var module: NoteModule? { store.modules.first { $0.id == selected } }
    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: Binding(get: { selected }, set: { if let destination = $0 { if destination == "review" { reviewModule = nil }; navigate(destination) } })) {
                NavigationLink(value: "home") { Label("Home", systemImage: "house") }
                NavigationLink(value: "review") {
                    Label("Review", systemImage: "rectangle.stack").badge(store.counts.reduce(0) { $0 + $1.count })
                }
                Section("Modules") {
                    ForEach(store.modules) { module in
                        NavigationLink(value: module.id) {
                            Text(module.name).badge(store.counts.first { $0.moduleId == module.id }?.count ?? 0)
                        }
                        .contextMenu { moduleActions(module) }
                        .swipeActions { Button("Delete", role: .destructive) { deleting = module }; Button("Rename") { rename = module; name = module.name; editingName = true } }
                    }
                }
                if !search.isEmpty {
                    Section("Search results") {
                        ForEach(hits, id: \.module_id) { hit in
                            NavigationLink(value: hit.module_id) { VStack(alignment: .leading) { Text(hit.name); Text(hit.snippet.filter { !$0.isASCII || !$0.isNewline && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }).font(.caption).lineLimit(2) } }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $search, isPresented: $showSearch, prompt: "Search notes")
            .background {
                Button("Search modules") { columnVisibility = .all; showSearch = true }
                    .keyboardShortcut("k").hidden().accessibilityHidden(true)
            }
            .task(id: search) {
                guard let client = store.client else { return }
                do { let results: [SearchHit] = try await client.call("search_notes", SearchArgs(query: search)); if !Task.isCancelled { hits = results } }
                catch { store.error = String(describing: error) }
            }
            .navigationTitle("Memnoter")
            .toolbar(removing: .sidebarToggle)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button(action: newModule) { Image(systemName: "plus") }.keyboardShortcut("n")
                    Button {
                        withAnimation { columnVisibility = .detailOnly }
                    } label: { Image(systemName: "sidebar.left") }
                    .accessibilityLabel("Hide Sidebar")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    Button { showSettings = true } label: { Label("Settings", systemImage: "gear") }.disabled(busy)
                }
            }
            .disabled(busy)
        } detail: {
            VStack(spacing: 0) {
                if selected == "review", let client = store.client {
                    ReviewView(client: client, directory: store.directory, moduleId: reviewModule, preferences: store.preferences, editCard: editReviewCard)
                        .id(reviewModule ?? "all")
                } else if module != nil, let session {
                    if showingFind { TextField("Find in note", text: $find).focused($findFocused).textFieldStyle(.roundedBorder).padding().onChange(of: find) { _, value in session.exec(.find, ["text": value]) } }
                    WebSurface(session: session)
                        .background(Color(uiColor: .systemBackground))
                        .overlay {
                            GeometryReader { geometry in
                            let showBar = keyboardDocked && session.state.suppressKeyboard != true && !session.pdfCoveringNote && !session.pdfFocused
                            let keyboardInset = keyboardDocked ? max(0, geometry.frame(in: .global).maxY - keyboardTop) : 0
                            Color.clear
                                .onChange(of: keyboardInset + (showBar ? 60 : 0), initial: true) { _, overlap in
                                    session.bottomInset = overlap
                                }
                            if showBar {
                                FormattingBar(session: session, maximumWidth: max(0, geometry.size.width - 32), image: $image, busy: busy)
                                    .padding(16)
                                    .padding(.bottom, keyboardInset)
                                    .disabled(!session.state.editable)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                            }
                            }
                        }

                } else {
                    HomeView(modules: store.modules, recentModules: store.recentModules, newModule: newModule, openModule: navigate)
                        .disabled(busy)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth = $0 }
            .ignoresSafeArea(.keyboard)
            .ignoresSafeArea(.container, edges: session?.imagePreviewOpen == true ? .all : [])
            .toolbar(session?.imagePreviewOpen == true ? .hidden : .automatic, for: .navigationBar)
            .statusBarHidden(session?.imagePreviewOpen == true)
            .navigationTitle(selected == "review" && detailWidth < 500 ? "" : (module?.name ?? (selected == "review" ? "Review" : "Home")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Reserve narrow-window space for review history and counts.
                if selected != "review" || detailWidth >= 500 {
                    ToolbarItem(placement: .principal) {
                        Text(module?.name ?? (selected == "review" ? "Review" : "Home"))
                            .lineLimit(1).truncationMode(.tail)
                            .accessibilityIdentifier("module.title")
                    }
                }
            }
            .toolbar {
                if columnVisibility == .detailOnly && (selected != "review" || horizontalSizeClass != .compact) {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { withAnimation { columnVisibility = .all } } label: { Image(systemName: "sidebar.left") }
                            .accessibilityLabel("Show Sidebar")
                    }
                }
                if let session, module != nil {
                    ToolbarItemGroup(placement: .topBarLeading) {
                        Button { session.exec(.undo) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!session.state.canUndo).keyboardShortcut("z")
                        Button { session.exec(.redo) } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift])
                    }
                    if session.state.focusedSectionId != nil || session.state.focusableSection != nil {
                        if #available(iOS 26.0, *) {
                            ToolbarSpacer(.fixed, placement: .topBarLeading)
                        }
                        ToolbarItem(placement: .topBarLeading) {
                            SectionFocusControl(session: session, moduleName: module?.name ?? "", compact: detailWidth < 600)
                        }
                    }

                    // The open PDF's tools sit in their own glass group, above the pane.
                    if let reader = session.pdfReader {
                        ToolbarItem(placement: .primaryAction) {
                            PdfFileMenu(session: session, reader: reader) { if let id = module?.id { beginPdfImport(id) } }
                        }
                        if reader.activeId != nil {
                            ToolbarItem(placement: .primaryAction) { PdfPageButton(session: session, reader: reader) }
                            ToolbarItem(placement: .primaryAction) {
                                Toggle(isOn: Binding(get: { reader.selecting }, set: { _ in session.pdfCommand(.toggleSelect) })) {
                                    Label("Select region", systemImage: "rectangle.dashed")
                                }
                                .disabled(!reader.canSelect && !reader.selecting)
                            }
                            ToolbarItem(placement: .primaryAction) {
                                Toggle(isOn: Binding(get: { reader.annotating }, set: { _ in session.pdfCommand(.toggleAnnotate) })) {
                                    Label("Annotate area", systemImage: "highlighter")
                                }
                                .disabled(!reader.canAnnotate && !reader.annotating)
                            }
                            ToolbarItem(placement: .primaryAction) { PdfViewMenu(session: session, reader: reader) }
                            if reader.fullscreen {
                                ToolbarItem(placement: .primaryAction) {
                                    Button { session.pdfCommand(.openBeside) } label: { Label("Exit full screen", systemImage: "arrow.down.right.and.arrow.up.left") }
                                }
                            }
                        }
                        if #available(iOS 26.0, *) {
                            ToolbarSpacer(.fixed, placement: .primaryAction)
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button { showingContents.toggle() } label: { Label("Contents", systemImage: "list.bullet.indent") }
                            .accessibilityLabel("Contents")
                            .popover(isPresented: $showingContents) {
                                ContentsPopover(session: session) { heading in
                                    session.exec(.scrollToHeading, ["id": heading.id])
                                    showingContents = false
                                }
                            }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            PhotosPicker(selection: $image, matching: .images) { Label("Insert photo", systemImage: "photo.badge.plus") }.disabled(busy)
                            Button { if let id = module?.id { beginPdfImport(id) } } label: { Label("Add PDF", systemImage: "doc.badge.plus") }.disabled(busy || !session.ready)
                            Button { showingFind = true; findFocused = true } label: { Label("Find in note", systemImage: "magnifyingglass") }.keyboardShortcut("f")
                            Button { reviewModule = selected; navigate("review") } label: { Label("Review", systemImage: "rectangle.stack") }
                            if !session.saveStatus.isEmpty { Text(session.saveStatus) }
                        } label: { Image(systemName: "ellipsis") }
                        .accessibilityLabel("Note actions")
                        .accessibilityValue(session.saveStatus)
                    }
                    // Far right, mirroring the sidebar toggle at the far left.
                    ToolbarItem(placement: .primaryAction) {
                        Button { session.toggleFiles() } label: { Label("Files", systemImage: "sidebar.right") }
                            .accessibilityLabel(session.filesOpen ? "Hide files" : "Show files")
                            .accessibilityValue(session.filesOpen ? "Open" : "Closed")
                            .keyboardShortcut("d", modifiers: [.command, .shift])
                            .disabled(busy || !session.ready)
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { notification in
            guard let result = notification.object as? SyncApplyResult else { return }
            Task {
                do {
                    if let session, session.ready {
                        _ = try await session.callEditor(.applyRemote, ["result": try JSONSerialization.jsonObject(with: Data(result.json.utf8))], parameters: ["result"])
                    }
                    await store.refresh()
                    if let selected, selected != "home", selected != "review", !store.modules.contains(where: { $0.id == selected }) { self.selected = "home" }
                } catch { store.error = error.localizedDescription }
            }
        }
        .task(id: store.sync != nil) {
            if let client = store.client, session == nil {
                await store.refresh()
                columnVisibility = sidebarVisible ? .all : .detailOnly
                let restored = WebSession(client: client, directory: store.directory, preferences: store.preferences)
                session = restored
                store.sync?.onFile = { module, json in
                    if let session, session.ready {
                        _ = try await session.callEditor(.fileStored, ["module": module, "file": try JSONSerialization.jsonObject(with: Data(json.utf8))], parameters: ["module", "file"])
                    }
                    await store.refresh()
                }
                restored.onReady = { [weak restored] in
                    guard let restored, let selected, store.modules.contains(where: { $0.id == selected }) else { return }
                    Task { do { try await restored.open(selected) } catch { store.error = String(describing: error) } }
                }
            }
        }
        .alert(rename == nil ? "New module" : "Rename module", isPresented: $editingName) {
            TextField("Name", text: $name)
            Button("Save") {
                Task { await store.perform {
                    guard let client = store.client else { return }
                    if let rename { try await client.write("rename_module", RenameArgs(moduleId: rename.id, name: name)) }
                    else { let id: String = try await client.call("create_module", NameArgs(name: name)); await store.refresh(); navigate(id) }
                } }
            }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete module and its notes?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) {
                if let deleting { Task {
                    await store.perform {
                        try await session?.flush()
                        if selected == deleting.id { selected = "home" }
                        try await store.client?.write("delete_module", ModuleArgs(moduleId: deleting.id))
                    }
                    self.deleting = nil
                } }
            }
        }
        .sheet(isPresented: $showSettings) { if let client = store.client { SettingsView(sync: store.sync, client: client, modules: store.modules, setChapterNumbering: setChapterNumbering, beforeRestore: { try await session?.flush(); store.sync?.pause() }, restored: { session?.dispose(); session = WebSession(client: client, directory: store.directory, preferences: store.preferences); selected = "home"; await store.refresh(); await store.sync?.start() }) } }
        .fileImporter(isPresented: $showingPdfImporter, allowedContentTypes: [.pdf], allowsMultipleSelection: true, onCompletion: importPdfs)
        .alert("Memnoter", isPresented: Binding(get: { store.error != nil || session?.error != nil }, set: { if !$0 { store.error = nil; session?.error = nil } })) { Button("OK") { store.error = nil; session?.error = nil } } message: { Text(store.error ?? session?.error ?? "") }
        .onChange(of: session?.requestedModule) { _, _ in handleModuleRequest() }
        .onChange(of: session?.requestedPdfImport) { _, _ in handlePdfImportRequest() }
        .onChange(of: showingPdfImporter) { _, shown in
            if !shown { handleModuleRequest(); handlePdfImportRequest() }
        }
        .onChange(of: busy) { _, value in
            if !value { handleModuleRequest(); handlePdfImportRequest() }
        }
        .onChange(of: session?.imagePreviewOpen) { _, open in
            if open == true {
                previewColumnVisibility = columnVisibility
                columnVisibility = .detailOnly
            } else if let previous = previewColumnVisibility {
                columnVisibility = previous
                previewColumnVisibility = nil
            }
        }
        .onChange(of: columnVisibility) { _, visibility in
            if session?.imagePreviewOpen == true { return }
            if visibility == .all { sidebarVisible = true }
            else if visibility == .detailOnly { sidebarVisible = false }
        }
        .onChange(of: showingFind) { _, shown in findFocused = shown }
        .onChange(of: image) { _, item in
            guard let item, let id = module?.id, let client = store.client else { return }
            busy = true
            Task {
                defer { busy = false; image = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw URLError(.cannotDecodeContentData) }
                    let file: SavedFile = try await client.call("save_file", FileArgs(moduleId: id, bytes: Array(data), mimeType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"))
                    let inserted = try await session?.execute(.insertImage, ["fileId": file.id, "alt": "Photo"]) as? Bool
                    if inserted != true { throw URLError(.cannotCreateFile) }
                    try await session?.flush()
                } catch { store.error = String(describing: error) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { updateKeyboard($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { updateKeyboard($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { updateKeyboard($0, hiding: true) }
        .onReceive(NotificationCenter.default.publisher(for: .cardsDidChange)) { _ in Task { await store.refresh() } }
        .onReceive(NotificationCenter.default.publisher(for: .coreDidWrite)) { _ in store.sync?.nudge() }
        .onChange(of: skipCardsCreatedToday) { _, _ in Task { await store.refresh(); await session?.updateCardPreference() } }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                backgroundWork?.cancel()
                let task = UIApplication.shared.beginBackgroundTask(withName: "Save note") {
                    Task { @MainActor in backgroundWork?.cancel(); store.sync?.pause() }
                }
                backgroundWork = Task {
                    defer {
                        if scenePhase != .active { store.sync?.pause() }
                        UIApplication.shared.endBackgroundTask(task)
                    }
                    do {
                        try await session?.flush()
                        store.sync?.nudge()
                        try await Task.sleep(for: .seconds(3))
                    } catch is CancellationError { }
                    catch { store.error = String(describing: error) }
                }
            } else { backgroundWork?.cancel(); store.sync?.resume(); Task { await store.refresh() } }
        }
    }
    private func handleModuleRequest() {
        guard !busy, !showingPdfImporter, let destination = session?.requestedModule else { return }
        session?.requestedModule = nil
        // A request from a web surface that is no longer displayed must not
        // navigate away from Home or Review after an asynchronous source lookup.
        guard module != nil else { return }
        guard store.modules.contains(where: { $0.id == destination }) else {
            store.error = "This note is no longer available."
            return
        }
        navigate(destination)
    }
    private func handlePdfImportRequest() {
        guard !busy, !showingPdfImporter, let destination = session?.requestedPdfImport else { return }
        session?.requestedPdfImport = nil
        guard module?.id == destination else { return }
        beginPdfImport(destination)
    }
    private func beginPdfImport(_ moduleId: String) {
        guard !busy, store.modules.contains(where: { $0.id == moduleId }) else { return }
        pdfImportModuleId = moduleId
        showingPdfImporter = true
    }
    private func importPdfs(_ result: Result<[URL], Error>) {
        let destination = pdfImportModuleId
        pdfImportModuleId = nil
        switch result {
        case .failure(let error):
            if let cancellation = error as? CocoaError, cancellation.code == .userCancelled { return }
            store.error = String(describing: error)
        case .success(let urls):
            guard !urls.isEmpty, let destination, let client = store.client else { return }
            busy = true
            Task {
                defer { busy = false }
                var failures: [String] = []
                var imported = false
                for url in urls {
                    do {
                        guard url.isFileURL else { throw URLError(.badURL) }
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        // Rust reads and bounds the file while the security grant
                        // is live; PDF bytes never expand into a JSON number array.
                        try await client.write("add_document", DocumentPathArgs(moduleId: destination, path: url.path))
                        imported = true
                    } catch { failures.append("\(url.lastPathComponent): \(error)") }
                }
                if imported, let session, session.ready {
                    do { _ = try await session.callEditor(.refreshDocuments, ["moduleId": destination], parameters: ["moduleId"]) }
                    catch { failures.append("PDFs were imported, but the files list could not be refreshed: \(error)") }
                }
                await store.refresh()
                if !failures.isEmpty { store.error = failures.joined(separator: "\n") }
            }
        }
    }
    private func updateKeyboard(_ notification: Notification, hiding: Bool = false) {
        guard let window = session?.web.window,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let localFrame = window.convert(frame, from: window.screen.coordinateSpace)
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? 0
        let animation: Animation = switch curve {
        case 1: .easeIn(duration: duration)
        case 2: .easeOut(duration: duration)
        case 3: .linear(duration: duration)
        default: .timingCurve(0.42, 0, 0.58, 1, duration: duration)
        }
        if !hiding { session?.hideEditorInputAssistant() }
        // One destination frame drives visibility and placement, including the
        // hardware shortcut strip. Floating keyboards do not obscure the bottom.
        withAnimation(animation) {
            let docked = localFrame.minY < window.bounds.maxY
                && localFrame.maxY >= window.bounds.maxY && localFrame.width >= window.bounds.width * 0.9
            // Without the hardware assistant, its frame can be below the window.
            // Keep our row at the bottom while the editor is first responder.
            let hardware = localFrame.minY >= window.bounds.maxY && session?.editorFirstResponder != nil
            keyboardDocked = !hiding && (docked || hardware)
            keyboardTop = hiding ? window.bounds.maxY : min(localFrame.minY, window.bounds.maxY)
        }
    }
    func newModule() {
        rename = nil
        name = ""
        editingName = true
    }
    @ViewBuilder func moduleActions(_ module: NoteModule) -> some View {
        Button("Rename") { rename = module; name = module.name; editingName = true }
        Button("Review") { reviewModule = module.id; navigate("review") }
        Button("Delete", role: .destructive) { deleting = module }
    }
    private func setChapterNumbering(_ moduleId: String, _ enabled: Bool) async throws {
        guard let client = store.client else { throw URLError(.cannotConnectToHost) }
        try await session?.flush()
        do {
            try await client.write("set_module_numbering", NumberingArgs(moduleId: moduleId, enabled: enabled))
            store.modules = try await client.call("modules", Empty())
            // Refresh the displayed editor and its live Contents without replacing the web view.
            _ = try await session?.callEditor(.refreshModules)
        } catch {
            // A write may have succeeded before a refresh failed; show persisted state on retry.
            if let modules: [NoteModule] = try? await client.call("modules", Empty()) { store.modules = modules }
            throw error
        }
    }
    func editReviewCard(_ moduleId: String, _ cardId: String) {
        guard !busy, let session else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await session.flush()
                // Queue the shared reveal before opening, so it waits for note restoration.
                _ = try await session.callEditor(.revealCard, ["moduleId": moduleId, "cardId": cardId], parameters: ["moduleId", "cardId"])
                try await session.open(moduleId)
                store.recordOpenedModule(moduleId)
                selected = moduleId
            } catch { store.error = String(describing: error) }
        }
    }
    func navigate(_ destination: String) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await session?.flush()
                if store.modules.contains(where: { $0.id == destination }), let session {
                    if session.ready { try await session.open(destination) }
                    else { session.onReady = { [weak session] in
                        guard let session else { return }
                        Task { do { try await session.open(destination) } catch { store.error = String(describing: error) } } } }
                }
                if store.modules.contains(where: { $0.id == destination }) {
                    store.recordOpenedModule(destination)
                }
                selected = destination
                await store.refresh()
            } catch { store.error = String(describing: error) }
        }
    }
}

/// The PDF's name; its menu switches files, returns to the list or adds one.
private struct PdfFileMenu: View {
    let session: WebSession
    let reader: PdfReaderState
    let addPdf: () -> Void

    var body: some View {
        Menu {
            if reader.fullscreen {
                Button { session.pdfCommand(.backToNote) } label: { Label("Back to note", systemImage: "chevron.backward") }
            }
            Section {
                ForEach(reader.files) { file in
                    Button { session.pdfCommand(.openFile, file.id) } label: {
                        if file.id == reader.activeId { Label(file.name, systemImage: "checkmark") } else { Text(file.name) }
                    }
                }
            }
            if reader.activeId != nil {
                Button { session.pdfCommand(.showFiles) } label: { Label("All files", systemImage: "list.bullet") }
            }
            Button(action: addPdf) { Label("Add PDF", systemImage: "doc.badge.plus") }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                Text(reader.title).lineLimit(1).truncationMode(.middle).frame(maxWidth: 200)
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .accessibilityHidden(true)
        }
        .accessibilityLabel("PDF file")
        .accessibilityValue(reader.title)
    }
}

/// "3 / 12"; tapping asks for a page to jump to.
private struct PdfPageButton: View {
    let session: WebSession
    let reader: PdfReaderState
    @State private var asking = false
    @State private var text = ""

    var body: some View {
        Button {
            text = ""
            asking = true
        } label: {
            HStack(spacing: 3) {
                Text("\(reader.page)").fontWeight(.semibold)
                Text("/ \(reader.pageCount)").foregroundStyle(.secondary)
            }
            .monospacedDigit()
            .padding(.horizontal, 4)
            .accessibilityHidden(true)
        }
        .disabled(reader.pageCount == 0)
        .accessibilityLabel("Page \(reader.page) of \(reader.pageCount)")
        .accessibilityHint("Go to page")
        .alert("Go to Page", isPresented: $asking) {
            TextField("Page", text: $text).keyboardType(.numberPad)
            Button("Cancel", role: .cancel) { }
            Button("Go") {
                guard let page = Int(text) else { return }
                session.pdfCommand(.goToPage, max(1, min(reader.pageCount, page)))
            }
            .keyboardShortcut(.defaultAction)
        } message: {
            Text("1 to \(reader.pageCount)")
        }
    }
}

/// Zoom and where the PDF is shown; pinching still zooms too.
private struct PdfViewMenu: View {
    let session: WebSession
    let reader: PdfReaderState

    var body: some View {
        Menu {
            Section("Zoom \(reader.zoom)%") {
                Button { session.pdfCommand(.zoomIn) } label: { Label("Zoom in", systemImage: "plus.magnifyingglass") }
                    .disabled(!reader.canZoomIn)
                    .menuActionDismissBehavior(.disabled)
                Button { session.pdfCommand(.zoomOut) } label: { Label("Zoom out", systemImage: "minus.magnifyingglass") }
                    .disabled(!reader.canZoomOut)
                    .menuActionDismissBehavior(.disabled)
            }
            if !reader.fullscreen {
                Button { session.pdfCommand(.openFullscreen) } label: { Label("Open full screen", systemImage: "arrow.up.left.and.arrow.down.right") }
            }
        } label: {
            Label("More PDF actions", systemImage: "ellipsis")
        }
    }
}
