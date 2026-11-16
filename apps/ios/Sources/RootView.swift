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
    @State private var phoneColumn: NavigationSplitViewColumn = .sidebar
    private let isPhone = UIDevice.current.userInterfaceIdiom == .phone
    private var phoneSplitLayout: Bool { isPhone && horizontalSizeClass == .regular }
    private var canToggleSidebar: Bool { !isPhone || horizontalSizeClass == .regular }
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// Whether the sidebar column is really on screen; overlay and swipe presentation don't always update `columnVisibility`.
    @State private var sidebarOnScreen = true
    @AppStorage("selectedDestination") private var savedDestination = "home"
    private var selected: String? {
        get { savedDestination }
        nonmutating set { savedDestination = newValue ?? "home" }
    }
    @AppStorage("skipCardsCreatedToday") private var skipCardsCreatedToday = false
    @AppStorage("sidebarVisible") private var sidebarVisible = true
    @AppStorage("questionsModuleScope") private var savedQuestionsScope = ""
    private var questionsModule: String? {
        get { savedQuestionsScope.isEmpty ? nil : savedQuestionsScope }
        nonmutating set { savedQuestionsScope = newValue ?? "" }
    }
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
    @State private var drawingRequest: DrawingRequest?
    @State private var prototypeDrawingAvailable = false
    @State private var showingPdfImporter = false
    @State private var pdfImportModuleId: String?
    @State private var filesModuleFilter: String?
    @State private var find = ""
    @State private var showingContents = false
    @State private var showingFind = false
    @FocusState private var findFocused: Bool
    @State private var keyboardDocked = false
    @State private var keyboardFrame: CGRect = .null
    @State private var deleting: NoteModule?
    @State private var editingFolder = false
    @State private var folder: SidebarItem?
    @State private var folderName = ""
    @State private var deletingFolder: SidebarItem?
    @State private var sidebarEditMode: EditMode = .inactive
    @State private var detailWidth: CGFloat = 0
    @State private var primaryLibraryDocumentId: String?
    var module: NoteModule? { store.modules.first { $0.id == selected } }
    private var sectionScope: String? {
        switch selected {
        case "questions": questionsModule
        case "files": filesModuleFilter
        case "review": reviewModule
        default: module?.id
        }
    }
    // A PDF beside the note does not become the primary navigation destination.
    private var primaryFileContent: Bool {
        if isPhone { return session?.pdfReader != nil }
        guard let reader = session?.pdfReader else { return false }
        return reader.fullscreen || (reader.activeId != nil && reader.activeId == primaryLibraryDocumentId)
    }
    private var tabletBreadcrumbWidth: CGFloat {
        max(100, min(session?.pdfReader != nil ? 240 : 360, detailWidth - 420))
    }
    private var currentSection: String {
        if selected == "questions" { return primaryFileContent ? "files" : "questions" }
        if module != nil { return primaryFileContent ? "files" : "notes" }
        return selected ?? "home"
    }
    private var breadcrumbItem: String? {
        guard module != nil || selected == "questions" else { return nil }
        if primaryFileContent { return session?.pdfReader?.activeId != nil ? session?.pdfReader?.title : nil }
        if selected == "questions" { return session?.worksheetChrome?.title }
        return session?.state.focusedSectionPath.last?.title ?? module?.name
    }
    private var sectionTitle: String {
        if selected == "questions" { return "Questions" }
        return module?.name ?? (selected == "review" ? "Review" : selected == "files" ? "Files" : "Home")
    }
    private var sidebarDestination: String? {
        if ["questions", "files", "review"].contains(selected ?? ""), let sectionScope { return sectionScope }
        return selected
    }
    private var navigationWithPresentations: AnyView {
        navigation
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { notification in
            guard let result = notification.object as? SyncApplyResult else { return }
            Task {
                do {
                    if let session, session.ready {
                        _ = try await session.callEditor(.applyRemote, ["result": try JSONSerialization.jsonObject(with: Data(result.json.utf8))], parameters: ["result"])
                    }
                    await store.refresh()
                    if let selected, selected != "home", selected != "review", selected != "files", selected != "questions", !store.modules.contains(where: { $0.id == selected }) { self.selected = "home" }
                } catch { store.error = error.localizedDescription }
            }
        }
        .task(id: store.client != nil) {
            if let client = store.client, session == nil {
                await store.refresh()
                columnVisibility = sidebarVisible ? .all : .detailOnly
                if isPhone, selected != "home" { phoneColumn = .detail }
                let restored = WebSession(client: client, directory: store.directory, preferences: store.preferences)
                if let questionsModule, !store.modules.contains(where: { $0.id == questionsModule }) { self.questionsModule = nil }
                session = restored
                store.sync?.onFile = { module, json in
                    if let session, session.ready {
                        _ = try await session.callEditor(.fileStored, ["module": module, "file": try JSONSerialization.jsonObject(with: Data(json.utf8))], parameters: ["module", "file"])
                    }
                    await store.refresh()
                    NotificationCenter.default.post(name: .coreDidWrite, object: nil)
                }
                let restoreNavigation: () -> Void = { [weak restored] in
                    guard let restored else { return }
                    Task {
                        do {
                            if selected == "questions" { try await restored.openQuestions(questionsModule) }
                            else if let selected, store.modules.contains(where: { $0.id == selected }) { try await restored.open(selected) }
                        } catch { store.error = String(describing: error) }
                    }
                }
                if restored.ready { restoreNavigation() }
                else { restored.onReady = restoreNavigation }
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
        .alert(folder == nil ? "New folder" : "Rename folder", isPresented: $editingFolder) {
            TextField("Name", text: $folderName)
            Button("Save") {
                let trimmed = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
                let items = store.sidebarItems
                let next = folder.map { [SidebarItem(id: $0.id, name: trimmed, folder_id: nil, sort_order: $0.sort_order, collapsed: $0.collapsed, deleted: false)] }
                    ?? [SidebarItem(id: "folder-\(UUID().uuidString.lowercased())", name: trimmed, folder_id: nil,
                                    sort_order: (items.map(\.sort_order).max() ?? -1) + 1, collapsed: false, deleted: false)]
                Task { await store.saveSidebar(next) }
            }.disabled(folderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete folder?", isPresented: Binding(get: { deletingFolder != nil }, set: { if !$0 { deletingFolder = nil } })) {
            Button("Delete folder", role: .destructive) {
                if var item = deletingFolder { item.deleted = true; Task { await store.saveSidebar([item]) } }
                deletingFolder = nil
            }
            Button("Cancel", role: .cancel) { deletingFolder = nil }
        } message: { Text("Its modules move to the top level. No notes are deleted.") }
        // Keep phone Contents presentation above the title's Button/Menu
        // branches so it has a stable presenter across focus changes.
        .sheet(isPresented: Binding(get: { isPhone && showingContents }, set: { if isPhone { showingContents = $0 } })) {
            if let session {
                ContentsSheet(session: session, moduleName: module?.name ?? "Note") { showingContents = false }
            }
        }
        .rootViewBoundary()
        .fullScreenCover(item: $drawingRequest) { target in
            if let client = store.client {
                DrawingEditor(request: target, directory: store.directory, client: client, preferences: store.preferences) { imageId, sourceId, previewId, expected, asCopy in
                    guard selected == target.module.id, let session,
                          store.modules.contains(where: { $0.id == target.module.id }) else { throw CocoaError(.userCancelled) }
                    if asCopy {
                        guard try await session.execute(.beginDrawing, ["imageId": imageId]) as? Bool == true else { throw CocoaError(.fileWriteUnknown) }
                    }
                    guard try await session.execute(.commitDrawing, ["imageId": imageId, "sourceId": sourceId, "previewId": previewId,
                                                                    "expectedSourceId": expected as Any? ?? NSNull()]) as? Bool == true else { throw DrawingFailure.changed }
                    try await session.flush()
                } discard: {
                    guard selected == target.module.id, let session else { return }
                    _ = try await session.execute(.discardEmptyDrawing, ["imageId": target.imageId])
                    try await session.flush()
                }
            }
        }
        .task(id: module?.id) {
            prototypeDrawingAvailable = false
            guard let id = module?.id else { return }
            let draft = try? await DrawingDraftStore(directory: store.directory, moduleId: id).load()
            if module?.id == id { prototypeDrawingAvailable = draft != nil }
        }
        .onChange(of: session?.drawingToEdit) { _, event in
            guard let event, let target = module, event.moduleId == target.id, drawingRequest == nil else { return }
            session?.drawingToEdit = nil
            Task {
                do {
                    try await session?.worksheetDrawing.cancel()
                    try await session?.flush()
                    guard selected == target.id, let session else { return }
                    session.web.endEditing(true)
                    _ = try await session.execute(.clearImageSelection)
                    guard selected == target.id else { return }
                    drawingRequest = DrawingRequest(module: target, imageId: event.imageId, sourceId: event.sourceId)
                } catch { store.error = error.localizedDescription }
            }
        }
        .sheet(isPresented: $showSettings) { if let client = store.client { SettingsView(sync: store.sync, client: client, modules: store.modules, setChapterNumbering: setChapterNumbering, beforeRestore: { try await session?.flush(); store.sync?.pause() }, restored: { session?.dispose(); session = WebSession(client: client, directory: store.directory, preferences: store.preferences); selected = "home"; await store.refresh(); await store.sync?.start() }) } }
        .fileImporter(isPresented: $showingPdfImporter, allowedContentTypes: [.pdf], allowsMultipleSelection: true, onCompletion: importPdfs)
        .rootViewBoundary()
    }

    private var navigationWithAlerts: AnyView {
        navigationWithPresentations
            .background { UpdateNoticeView(required: store.sync?.updateRequired == true) }
        .alert("Memnoter", isPresented: Binding(get: { store.error != nil || session?.error != nil }, set: { if !$0 { store.error = nil; session?.error = nil } })) { Button("OK") { store.error = nil; session?.error = nil } } message: { Text(store.error ?? session?.error ?? "") }
        .rootViewBoundary()
    }

    private var navigationWithRequests: AnyView {
        navigationWithAlerts
        .onChange(of: session?.questionsOpen) { _, _ in synchronizeQuestions() }
        .onChange(of: session?.questionsModuleId) { _, _ in synchronizeQuestions() }
        .onChange(of: session?.requestedModule) { _, _ in handleModuleRequest() }
        .onChange(of: session?.requestedPdfImport) { _, _ in handlePdfImportRequest() }
        .onChange(of: showingPdfImporter) { _, shown in
            if !shown { handleModuleRequest(); handlePdfImportRequest() }
        }
        .onChange(of: busy) { _, value in
            if !value { handleModuleRequest(); handlePdfImportRequest() }
        }
        .rootViewBoundary()
    }

    var body: AnyView {
        navigationWithRequests
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
            if isPhone || session?.imagePreviewOpen == true { return }
            if visibility == .all { sidebarVisible = true }
            else if visibility == .detailOnly { sidebarVisible = false }
        }
        .onChange(of: showingFind) { _, shown in findFocused = shown }
        .onChange(of: image) { _, item in
            guard let item, let id = session?.questionsOpen == true ? session?.worksheetAnswerModule : module?.id, let client = store.client else { return }
            let answerTarget = session?.worksheetAnswerID
            busy = true
            Task {
                defer { busy = false; image = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw URLError(.cannotDecodeContentData) }
                    let file: SavedFile = try await client.call("save_file", FileArgs(moduleId: id, bytes: Array(data), mimeType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"))
                    guard answerTarget == session?.worksheetAnswerID,
                          (answerTarget != nil ? session?.worksheetAnswerModule == id && session?.questionsOpen == true : module?.id == id) else { throw DrawingFailure.changed }
                    let inserted = try await session?.execute(.insertImage, ["fileId": file.id, "alt": "Photo"]) as? Bool
                    if inserted != true { throw URLError(.cannotCreateFile) }
                    try await session?.flush()
                } catch { store.error = String(describing: error) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { updateKeyboard($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { updateKeyboard($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { updateKeyboard($0, hiding: true) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { updateKeyboard($0) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { updateKeyboard($0, hiding: true) }
        .onReceive(NotificationCenter.default.publisher(for: .cardsDidChange)) { _ in Task { await store.refresh() } }
        .onReceive(NotificationCenter.default.publisher(for: .coreDidWrite)) { _ in store.sync?.nudge() }
        .onChange(of: skipCardsCreatedToday) { _, _ in Task { await store.refresh(); await session?.updateCardPreference() } }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                backgroundWork?.cancel()
                let task = UIApplication.shared.beginBackgroundTask(withName: "Save note") {
                    Task { @MainActor in
                        guard scenePhase != .active else { return }
                        backgroundWork?.cancel(); store.sync?.pause()
                    }
                }
                backgroundWork = Task {
                    defer {
                        if scenePhase != .active { store.sync?.pause() }
                        UIApplication.shared.endBackgroundTask(task)
                    }
                    do {
                        try await session?.worksheetDrawing.cancel()
                        try await session?.flush()
                        _ = try await store.sync?.pushAndWait()
                    } catch is CancellationError { }
                    catch { store.error = String(describing: error) }
                }
            } else { backgroundWork?.cancel(); store.sync?.resume(); Task { await store.refresh() } }
        }
        .rootViewBoundary()
    }
    @ViewBuilder private var navigation: some View {
        if isPhone {
            NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $phoneColumn) {
                sidebar
            } detail: {
                detail
            }
            .onChange(of: horizontalSizeClass) { previous, current in
                // Keep the selected destination visible when the two-column phone layout
                // collapses. Do not rebuild the split view or the editor on rotation.
                if isPhone, previous == .regular, current == .compact,
                   selected != "home" || columnVisibility == .detailOnly {
                    phoneColumn = .detail
                }
            }
        } else {
            NavigationSplitView(columnVisibility: $columnVisibility) {
                sidebar
            } detail: {
                detail
            }
        }
    }

    private var sidebar: AnyView {
        RootSidebarList(selection: Binding(get: { sidebarDestination }, set: { if let destination = $0, isDestination(destination) { if destination == "review" { reviewModule = nil }; if destination == "files" { filesModuleFilter = nil }; navigate(destination) } }), destinations: sidebarDestinations, modules: sidebarModules, results: sidebarResults)
        .listStyle(.sidebar)
        .background { SidebarPresenceProbe(onScreen: $sidebarOnScreen) }
        .refreshable { await manualSync() }
        .environment(\.editMode, $sidebarEditMode)
        .searchable(text: $search, isPresented: $showSearch, prompt: "Search notes")
        .background {
            Button("Search modules") { if isPhone { phoneColumn = .sidebar }; columnVisibility = .all; showSearch = true }
                .keyboardShortcut("k").hidden().accessibilityHidden(true)
            Button("New module", action: newModule).keyboardShortcut("n").hidden().accessibilityHidden(true)
        }
        .task(id: search) {
            guard let client = store.client else { return }
            do { let results: [SearchHit] = try await client.call("search_notes", SearchArgs(query: search)); if !Task.isCancelled { hits = results } }
            catch { store.error = String(describing: error) }
        }
        .rootViewBoundary()
        .navigationTitle("Memnoter")
        .navigationBarTitleDisplayMode(isPhone ? .inline : .automatic)
        .toolbar(removing: .sidebarToggle)
        .toolbar {
            // Keep separate native items for sidebar transitions. Inset the glyphs toward
            // each other because the system toolbar retains its minimum item spacing.
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button("New module", systemImage: "doc.badge.plus", action: newModule)
                    Button("New folder", systemImage: "folder.badge.plus") { folder = nil; folderName = ""; editingFolder = true }
                } label: { Image(systemName: "plus").offset(x: isPhone ? 0 : 6) }
                    .accessibilityLabel("Add")
                if canToggleSidebar {
                    Button {
                        withAnimation {
                            if isPhone { phoneColumn = .detail }
                            columnVisibility = .detailOnly
                        }
                    } label: { Image(systemName: "sidebar.left").offset(x: -6) }
                    .accessibilityLabel("Hide Sidebar")
                }
            }
            if !phoneSplitLayout {
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    sidebarBottomControls
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if phoneSplitLayout {
                // The short, regular-width phone sidebar lets the floating native
                // toolbar cover rows. Reserve a footer outside the scrollable list.
                HStack {
                    Spacer()
                    HStack(spacing: 20) { sidebarBottomControls }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .padding(.horizontal, 20)
                        .frame(height: 44)
                        .background(.regularMaterial, in: Capsule())
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground))
            }
        }
        .disabled(busy)
        .rootViewBoundary()
    }

    private var sidebarDestinations: AnyView {
        AnyView(Group {
            destinationLink("home") { Label("Home", systemImage: "house") }
            destinationLink("review") {
                HStack {
                    Label("Review", systemImage: "rectangle.stack")
                    Spacer()
                    Text("\(store.counts.reduce(0) { $0 + $1.learning }) / \(store.counts.reduce(0) { $0 + $1.review }) / \(store.counts.reduce(0) { $0 + $1.new })")
                        .monospacedDigit().foregroundStyle(.secondary)
                        .accessibilityLabel("\(store.counts.reduce(0) { $0 + $1.learning }) learn, \(store.counts.reduce(0) { $0 + $1.review }) due, \(store.counts.reduce(0) { $0 + $1.new }) new")
                }
            }
            destinationLink("files") { Label("Files", systemImage: "doc.text") }
            if session != nil {
                destinationLink("questions") { Label("Questions", systemImage: "questionmark.circle") }
            }
        })
    }
    private var sidebarModules: AnyView {
        AnyView(Group {
            Section {
                let rows = SidebarLayout.rows(items: store.sidebarItems, modules: store.modules)
                ForEach(rows) { row in
                    switch row {
                    case .folder(let item): folderRow(item)
                    case .module(let item, let module): moduleRow(module, inFolder: item.folder_id != nil)
                    }
                }
                .onMove { source, destination in
                    let items = store.sidebarItems
                    Task { await store.saveSidebar(SidebarLayout.move(items: items, rows: rows, from: source, to: destination)) }
                }
            } header: {
                HStack {
                    Text("Modules")
                    Spacer()
                    Button {
                        withAnimation { sidebarEditMode = sidebarEditMode.isEditing ? .inactive : .active }
                    } label: {
                        Image(systemName: sidebarEditMode.isEditing ? "checkmark" : "pencil")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            // Trailing-aligned so the glyph lines up with the row badges and chevrons.
                            .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(sidebarEditMode.isEditing ? "Done editing" : "Edit modules")
                    .disabled(store.modules.isEmpty)
                }
            }
        })
    }
    private var sidebarResults: AnyView {
        AnyView(Group {
            if !search.isEmpty {
                Section("Search results") {
                    ForEach(hits, id: \.module_id) { hit in
                        destinationLink(hit.module_id) { VStack(alignment: .leading) { Text(hit.name); Text(hit.snippet.filter { !$0.isASCII || !$0.isNewline && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }).font(.caption).lineLimit(2) } }
                    }
                }
            }
        })
    }

    @ViewBuilder private var sidebarBottomControls: some View {
        if let sync = store.sync, sync.account != nil {
            Button { Task { await manualSync() } } label: {
                if sync.isSyncingNow { ProgressView().offset(x: phoneSplitLayout ? 0 : 6).accessibilityLabel("Syncing") }
                else { Label("Sync now", systemImage: "arrow.triangle.2.circlepath").offset(x: phoneSplitLayout ? 0 : 6) }
            }
            .disabled(sync.isSyncingNow)
            .accessibilityLabel("Sync now")
            .accessibilityValue(sync.accessibilityStatus)
        }
        Button { showSettings = true } label: {
            Label("Settings", systemImage: "gear").offset(x: !phoneSplitLayout && store.sync?.account != nil ? -6 : 0)
        }.disabled(busy)
    }

    @AppStorage("worksheet.drawing.height") private var worksheetDrawingHeight = 0.55

    private var detail: AnyView {
        VStack(spacing: 0) {
            if selected == "review", let client = store.client {
                ReviewView(client: client, directory: store.directory, moduleId: reviewModule, preferences: store.preferences, editCard: editReviewCard)
                    .id(reviewModule ?? "all")
            } else if selected == "files", let client = store.client {
                FilesView(client: client, modules: store.modules, moduleFilter: $filesModuleFilter, busy: busy, open: openLibraryDocument, addPdf: beginPdfImport)
            } else if (module != nil || selected == "questions"), let session {
                if showingFind && selected != "questions" {
                    if isPhone {
                        HStack {
                            TextField("Find in note", text: $find).focused($findFocused).textFieldStyle(.roundedBorder)
                                .onChange(of: find) { _, value in session.exec(.find, ["text": value]) }
                            Button("Done") { showingFind = false; find = ""; session.exec(.find, ["text": ""]) }
                        }.padding()
                    } else {
                        TextField("Find in note", text: $find).focused($findFocused).textFieldStyle(.roundedBorder).padding()
                            .onChange(of: find) { _, value in session.exec(.find, ["text": value]) }
                    }
                }
                GeometryReader { available in
                    ZStack(alignment: .bottom) {
                        WebSurface(session: session)
                            .background(Color(uiColor: .systemBackground))
                            .overlay {
                                GeometryReader { geometry in
                                // WebKit can hide the keyboard while selecting text. Keep
                                // formatting available for the retained selection, also
                                // when an iPad hardware keyboard has no onscreen frame.
                                let showBar = ((selected != "questions" && !session.questionsOpen) || session.worksheetAnswerFocused) && session.worksheetDrawing.request == nil && (keyboardDocked || session.state.hasSelection) && session.state.suppressKeyboard != true && !session.pdfCoveringNote && !session.pdfFocused
                                let editorFrame = geometry.frame(in: .global)
                                // Also keep the caret above an undocked/floating keyboard
                                // when it overlaps this editor column.
                                let keyboardInset = editorFrame.intersects(keyboardFrame) ? max(0, editorFrame.maxY - keyboardFrame.minY) : 0
                                Color.clear
                                    .onChange(of: keyboardInset + (showBar ? 76 : 0) + (session.worksheetDrawing.request != nil ? available.size.height * min(worksheetDrawerMaximum(available.size.height) / max(1, available.size.height), max(max(0.18, 420 / max(1, available.size.height)), worksheetDrawingHeight)) : 0), initial: true) { _, overlap in
                                        if !session.drawerGestureActive { session.bottomInset = overlap }
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
                        if session.worksheetDrawing.request != nil {
                            let maximum = worksheetDrawerMaximum(available.size.height)
                            let minimum = min(worksheetDrawerMaximum(available.size.height) / max(1, available.size.height), max(0.18, 420 / max(1, available.size.height)))
                            let settled = available.size.height * min(worksheetDrawerMaximum(available.size.height) / max(1, available.size.height), max(minimum, worksheetDrawingHeight))
                            WorksheetDrawerHost(fraction: $worksheetDrawingHeight, session: session,
                                content: AnyView(WorksheetDrawingPane(bridge: session.worksheetDrawing, paletteOffset: maximum - settled)))

                        }
                    }.clipped()
                }
                .ignoresSafeArea(.container, edges: questionsUnderBar ? .top : [])

            } else {
                HomeView(modules: store.modules, recentModules: store.recentModules, newModule: newModule, openModule: { navigate($0) })
                    .disabled(busy)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth = $0 }
        .onChange(of: session?.filesOpen) { _, open in
            if open != true { primaryLibraryDocumentId = nil }
        }
        .ignoresSafeArea(.keyboard)
        .ignoresSafeArea(.container, edges: session?.imagePreviewOpen == true ? .all : (questionsUnderBar ? .top : []))
        .toolbar(session?.imagePreviewOpen == true ? .hidden : .automatic, for: .navigationBar)
        .statusBarHidden(session?.imagePreviewOpen == true)
        .toolbar(removing: .sidebarToggle)
        // The worksheet's own chevron returns to questions; the stack's back would leave the module.
        .navigationBarBackButtonHidden(isPhone && selected == "questions" && session?.worksheetChrome != nil)
        // PDF controls own the iPad bar; a competing title can collapse to just an ellipsis.
        .modifier(QuestionScrollEdge(hidden: questionsUnderBar))
        .toolbarBackground(questionsUnderBar ? .hidden : .automatic, for: .navigationBar)
        .navigationTitle(!isPhone || selected == "questions" || phoneSplitLayout || module != nil || ["files", "review"].contains(selected ?? "") ? "" : sectionTitle)
        .navigationBarTitleDisplayMode(.inline)
        .rootViewBoundary()
        .toolbar {
            if !isPhone {
                // An empty item still draws a blank glass circle, so add it only with content.
                if tabletShowsSidebarButton || tabletBackAction != nil {
                ToolbarItem(placement: .topBarLeading) {
                    TabletBackControls(showSidebar: tabletShowsSidebarButton, back: tabletBackAction) {
                        if columnVisibility == .detailOnly {
                            withAnimation { columnVisibility = .all }
                        } else {
                            // The binding still says "shown" after an overlay was dismissed; re-assert it.
                            columnVisibility = .detailOnly
                            DispatchQueue.main.async { withAnimation { columnVisibility = .all } }
                        }
                    }
                }
                }
                if #available(iOS 26.0, *) { ToolbarSpacer(.fixed, placement: .topBarLeading) }
                ToolbarItem(placement: .topBarLeading) { tabletBreadcrumb }
            }
            if selected == "questions" {
                if !isPhone, session?.pdfReader == nil, let chrome = session?.worksheetChrome {
                    if session?.worksheetAnswerFocused == true, session?.worksheetDrawing.request == nil {
                        ToolbarItemGroup(placement: .topBarLeading) {
                            Button { session?.exec(.undo) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(session?.state.canUndo != true).accessibilityLabel("Undo")
                            Button { session?.exec(.redo) } label: { Image(systemName: "arrow.uturn.forward") }.disabled(session?.state.canRedo != true).accessibilityLabel("Redo")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        HStack(spacing: 8) {
                            Button { session?.worksheetQuestion(chrome.index - 1) } label: { Image(systemName: "chevron.left") }
                                .disabled(chrome.index <= 0).accessibilityLabel("Previous question")
                            if chrome.count <= 3 && detailWidth >= 650 {
                                ForEach(0..<chrome.count, id: \.self) { index in
                                    Button { session?.worksheetQuestion(index) } label: {
                                        Text("\(index + 1)").font(.subheadline.weight(.medium)).frame(width: 30, height: 30)
                                            .foregroundStyle(index == chrome.index ? Color.white : Color.primary)
                                            .background(index == chrome.index ? DrawingStyle.accent : .clear, in: RoundedRectangle(cornerRadius: 8))
                                    }.buttonStyle(.plain).accessibilityLabel("Question \(index + 1)")
                                }
                            } else {
                                Menu {
                                    ForEach(0..<chrome.count, id: \.self) { index in
                                        Button("Question \(index + 1)") { session?.worksheetQuestion(index) }
                                    }
                                } label: { Text("\(chrome.index + 1) of \(chrome.count)") }
                            }
                            Button { session?.worksheetQuestion(chrome.index + 1) } label: { Image(systemName: "chevron.right") }
                                .disabled(chrome.index + 1 >= chrome.count).accessibilityLabel("Next question")
                            if chrome.status == "Save failed" {
                                Button { session?.worksheetAction("worksheet-retry") } label: { Image(systemName: "exclamationmark.triangle") }.accessibilityLabel("Save failed. Retry")
                            }
                        }.padding(.horizontal, 6).fixedSize()
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if chrome.finished == true {
                            Button { session?.worksheetAction() } label: { Image(systemName: "xmark") }
                                .accessibilityLabel("Close worksheet")
                        } else {
                            Button("Finish") { session?.worksheetAction("worksheet-finish") }
                                .buttonStyle(.plain).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 14).frame(height: 34)
                                .background(DrawingStyle.accent, in: Capsule())
                        }
                    }

                }
            }
            if isPhone && (selected != "questions" || session?.worksheetChrome == nil) {
                ToolbarItem(placement: phoneSplitLayout || session?.pdfReader == nil ? .topBarLeading : .principal) {
                    if isPhone, module != nil, let reader = session?.pdfReader {
                        Text(reader.title).lineLimit(1).truncationMode(.middle)
                            .accessibilityIdentifier("module.title")
                    } else if isPhone, module != nil || ["files", "review", "questions"].contains(selected ?? "") {
                        // Same glass breadcrumb as iPad: module ⌄ / section ⌄.
                        phoneBreadcrumb
                    } else {
                        Text(module != nil && session?.state.focusedSectionId != nil
                             ? session?.state.focusedSectionPath.last?.title ?? module?.name ?? "Section"
                             : sectionTitle)
                            .lineLimit(1).truncationMode(.tail)
                            .accessibilityIdentifier("module.title")
                    }
                }
            }
        }
        .rootViewBoundary()
        .toolbar {
            if isPhone && canToggleSidebar && columnVisibility == .detailOnly && (selected != "review" || horizontalSizeClass != .compact) {
                ToolbarItem(placement: .topBarLeading) {
                    Button { withAnimation { columnVisibility = .all } } label: { Image(systemName: "sidebar.left") }
                        .accessibilityLabel("Show Sidebar")
                }
            }
            if let session, module != nil || selected == "questions", !session.questionsOpen || session.questionsModuleId != nil || session.pdfReader != nil, session.worksheetDrawing.request == nil {
                // The open PDF's tools sit in their own glass group, above the pane.
                if isPhone, let reader = session.pdfReader {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { session.pdfCommand(.backToNote) } label: {
                            Label("Note", systemImage: "xmark")
                        }
                        .labelStyle(.titleAndIcon)
                        .accessibilityLabel("Back to note")
                    }
                    if reader.activeId != nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            PdfPageButton(session: session, reader: reader)
                                .font(.subheadline)
                                .fixedSize()
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            compactPdfActions(session, reader: reader)
                        } label: { Label("PDF actions", systemImage: "ellipsis.circle") }
                        .accessibilityLabel("PDF actions")
                    }
                } else if primaryFileContent, let reader = session.pdfReader {
                    ToolbarItem(placement: .primaryAction) {
                        TabletPdfTools(session: session, reader: reader, expanded: detailWidth >= 760) {
                            if let id = module?.id { beginPdfImport(id) }
                        }
                    }

                }

                if !isPhone && !primaryFileContent && session.worksheetChrome == nil {
                    // One stable item prevents native glass groups from morphing when a PDF opens.
                    if #available(iOS 26.0, *) {
                        ToolbarItem(placement: .topBarTrailing) { tabletTrailingControls(session) }
                            .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .topBarTrailing) { tabletTrailingControls(session) }
                    }
                } else if isPhone && session.pdfReader == nil {
                    if selected == "questions", let chrome = session.worksheetChrome {
                        // Worksheet: the same native controls as iPad, so the web header stays hidden.
                        ToolbarItem(placement: .topBarLeading) {
                            Button { session.worksheetAction() } label: { Image(systemName: "chevron.left") }
                                .accessibilityLabel("Back to questions")
                        }
                        ToolbarItem(placement: .principal) {
                            Menu {
                                ForEach(0..<chrome.count, id: \.self) { index in
                                    Button("Question \(index + 1)") { session.worksheetQuestion(index) }
                                }
                            } label: {
                                Text("\(chrome.index + 1) of \(chrome.count)").font(.subheadline.weight(.medium))
                            }
                            .accessibilityLabel("Question \(chrome.index + 1) of \(chrome.count)")
                        }
                        if session.worksheetAnswerFocused, session.worksheetDrawing.request == nil {
                            ToolbarItemGroup(placement: .topBarTrailing) {
                                Button { session.exec(.undo) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!session.state.canUndo).keyboardShortcut("z")
                                    .accessibilityLabel("Undo")
                                Button { session.exec(.redo) } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift])
                                    .accessibilityLabel("Redo")
                            }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            if chrome.status == "Save failed" {
                                Button { session.worksheetAction("worksheet-retry") } label: { Image(systemName: "exclamationmark.triangle") }
                                    .accessibilityLabel("Save failed. Retry")
                            } else if chrome.finished == true {
                                Button { session.worksheetAction() } label: { Image(systemName: "xmark") }
                                    .accessibilityLabel("Close worksheet")
                            } else {
                                Button("Finish") { session.worksheetAction("worksheet-finish") }
                                    .font(.subheadline.weight(.semibold))
                            }
                        }
                    } else if selected == "questions" {
                        ToolbarItem(placement: .topBarTrailing) { phoneFilesToggle(session) }
                    } else {
                        // One menu beside the breadcrumb instead of a row the system folds into its own "…".
                        ToolbarItem(placement: .topBarTrailing) {
                            Menu { phoneNoteMenu(session) } label: { Image(systemName: "ellipsis") }
                                .accessibilityLabel("Note actions")
                                .accessibilityValue(session.saveStatus)
                        }
                    }
                }
            }
        }
        .rootViewBoundary()
    }

    private func tabletTrailingControls(_ session: WebSession) -> some View {
        TabletTrailingControls(session: session, busy: busy,
            noteTools: AnyView(Group {
                if session.questionsOpen { TabletQuestionTools(session: session) }
                else { tabletNoteTools(session) }
            }),
            pdfTools: AnyView(Group {
                if let reader = session.pdfReader {
                    TabletPdfTools(session: session, reader: reader, expanded: detailWidth >= 760) {
                        if let id = module?.id { beginPdfImport(id) }
                    }
                    .padding(.horizontal, 12)
                }
            }))
    }

    private func tabletNoteTools(_ session: WebSession) -> some View {
        TabletNoteTools(session: session,
                        showingContents: $showingContents,
                        actions: AnyView(noteActions(session)),
                        contents: AnyView(ContentsPopover(session: session, moduleName: module?.name ?? "Note") { showingContents = false }),
                        hasPdf: session.pdfReader != nil)
    }

    /// UIKit moves the sidebar column without SwiftUI geometry always noticing, so trust either signal that says hidden.
    /// Questions scroll under the glass bar, except beside a PDF: the pane starts below the bar,
    /// so the list does too and no column edge shows behind the buttons.
    private var questionsUnderBar: Bool {
        !isPhone && selected == "questions" && !(session?.filesOpen == true && session?.worksheetChrome == nil)
    }
    private var tabletShowsSidebarButton: Bool {
        canToggleSidebar && (columnVisibility == .detailOnly || !sidebarOnScreen)
    }
    private var tabletBackAction: (() -> Void)? {
        guard selected == "questions" else { return nil }
        if primaryFileContent { return { session?.pdfCommand(.backToNote) } }
        if session?.worksheetChrome != nil { return { session?.worksheetAction() } }
        return nil
    }
    @ViewBuilder private var tabletBreadcrumb: some View {
        if selected == "questions", !primaryFileContent, let worksheet = session?.worksheetChrome {
            TabletWorksheetTitle(title: worksheet.title ?? "Worksheet", maximumWidth: max(140, min(500, detailWidth - 500)))
        } else {
            TabletBreadcrumb(modules: store.modules, scope: sectionScope, section: currentSection,
                             item: breadcrumbItem,
                             questionsEnabled: session != nil,
                             maximumWidth: tabletBreadcrumbWidth,
                             changeScope: changeSectionScope, changeSection: selectSection)
                .disabled(busy)
        }
    }
    /// Room the trailing bar item needs, so the breadcrumb truncates instead of evicting it.
    private var phoneBarTrailingWidth: CGFloat {
        if selected == "review" { return 230 }
        return module != nil && selected != "questions" ? 165 : 120
    }
    private var phoneBreadcrumb: some View {
        TabletBreadcrumb(modules: store.modules, scope: sectionScope, section: currentSection,
                         item: breadcrumbItem,
                         questionsEnabled: session != nil,
                         maximumWidth: max(120, detailWidth - phoneBarTrailingWidth),
                         changeScope: changeSectionScope, changeSection: selectSection, compact: true)
            .disabled(busy)
    }
    private var sectionNavigation: some View {
        HStack {
            Menu {
                Picker("Module section", selection: Binding(get: { currentSection }, set: { selectSection($0) })) {
                    Text("Notes").tag("notes")
                    Text("Files").tag("files")
                    if session != nil { Text("Questions").tag("questions") }
                    Text("Review").tag("review")
                }
            } label: {
                Label(currentSection.capitalized, systemImage: "chevron.down")
            }
            .accessibilityLabel("Select module section")
            Spacer()
            if module == nil {
                Menu {
                    Picker("Module", selection: Binding(get: { sectionScope ?? "" }, set: { changeSectionScope($0.isEmpty ? nil : $0) })) {
                        Text("All modules").tag("")
                        ForEach(store.modules) { Text($0.name).tag($0.id) }
                    }
                } label: {
                    Label(store.modules.first { $0.id == sectionScope }?.name ?? "All modules", systemImage: "line.3.horizontal.decrease")
                        .lineLimit(1)
                }
                .accessibilityLabel("Module scope")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
        .disabled(busy)
    }
    private func selectSection(_ section: String) {
        guard !busy else { return }
        let scope = sectionScope
        switch section {
        case "notes":
            if let id = scope ?? store.recentModules.first?.id ?? store.modules.first?.id { navigate(id) }
            else { navigate("home") }
        case "questions": navigate("questions", questionScope: scope)
        case "files": filesModuleFilter = scope; navigate("files")
        case "review": reviewModule = scope; navigate("review")
        default: break
        }
    }
    private func changeSectionScope(_ scope: String?) {
        guard !busy else { return }
        if (module != nil || selected == "questions"), primaryFileContent {
            filesModuleFilter = scope
            navigate("files")
            return
        }
        switch selected {
        case "questions": navigate("questions", questionScope: scope)
        case "files": filesModuleFilter = scope
        case "review": reviewModule = scope
        default:
            if let scope { navigate(scope) } else { navigate("home") }
        }
    }
    private func synchronizeQuestions() {
        guard !busy, let session, session.ready, module != nil || selected == "questions" else { return }
        if session.questionsOpen {
            questionsModule = session.questionsModuleId
            selected = "questions"
            showingFind = false
            showingContents = false
        } else if selected == "questions" {
            let scope = questionsModule
            selected = scope.flatMap { id in store.modules.contains { $0.id == id } ? id : nil } ?? "home"
        }
    }

    private func manualSync() async {
        guard let sync = store.sync, sync.account != nil else { return }
        do { try await session?.flush(); try await sync.syncNow(); await store.refresh() }
        catch { store.error = error.localizedDescription }
    }

    @ViewBuilder private func compactPdfActions(_ session: WebSession, reader: PdfReaderState) -> some View {
        Section("Document") {
            PdfFileMenu(session: session, reader: reader) { if let id = module?.id { beginPdfImport(id) } }.actions
        }
        if reader.activeId != nil {
            Section("Tools") {
                Button { session.pdfCommand(.toggleSelect) } label: {
                    Label("Quote region", image: "Pdf-square-dashed-mouse-pointer")
                }.disabled(!reader.canSelect && !reader.selecting)
                PdfQuestionCropToggle(session: session, reader: reader)
                Button { session.pdfCommand(.toggleAnnotate) } label: {
                    Label("Annotate area", image: "Pdf-highlighter")
                }.disabled(!reader.canAnnotate && !reader.annotating)
            }
            PdfViewMenu(session: session, reader: reader).actions
        }
        // With a file open, the menu is only about that file; "× Note" leads back to the note.
        if reader.activeId == nil {
            Menu {
                Button { session.exec(.undo) } label: { Label("Undo", systemImage: "arrow.uturn.backward") }.disabled(!session.state.canUndo)
                Button { session.exec(.redo) } label: { Label("Redo", systemImage: "arrow.uturn.forward") }.disabled(!session.state.canRedo)
                noteActions(session, includePdf: false)
            } label: { Label("Note actions", systemImage: "square.and.pencil") }
            Button { session.toggleFiles() } label: { Label("Files", systemImage: "sidebar.right") }
                .accessibilityLabel(session.filesOpen ? "Hide files" : "Show files")
                .disabled(busy || !session.ready)
        }
    }

    private func phoneFilesToggle(_ session: WebSession) -> some View {
        Button { session.toggleFiles() } label: { Label("Files", systemImage: "sidebar.right") }
            .accessibilityLabel(session.filesOpen ? "Hide files" : "Show files")
            .accessibilityValue(session.filesOpen ? "Open" : "Closed")
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .disabled(busy || !session.ready)
    }

    /// iPhone note menu: edit history, navigation, inserts, then the PDF pane.
    @ViewBuilder private func phoneNoteMenu(_ session: WebSession) -> some View {
        Section {
            Button { session.exec(.undo) } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                .disabled(!session.state.canUndo).menuActionDismissBehavior(.disabled)
            Button { session.exec(.redo) } label: { Label("Redo", systemImage: "arrow.uturn.forward") }
                .disabled(!session.state.canRedo).menuActionDismissBehavior(.disabled)
        }
        Section {
            Button { showingContents = true } label: { Label("Contents", systemImage: "list.bullet.indent") }
            Button { showingFind = true; findFocused = true } label: { Label("Find in note", systemImage: "magnifyingglass") }
        }
        Section {
            if session.state.inTable {
                Menu { TableEditingActions(session: session) } label: { Label("Table actions", systemImage: "tablecells") }
                    .disabled(!session.state.editable)
            }
            Button { newDrawing() } label: { Label("Insert drawing", systemImage: "pencil.tip.crop.circle") }
                .disabled(busy || !session.state.editable)
            if prototypeDrawingAvailable {
                Button { newDrawing(importPrototype: true) } label: { Label("Import scratchpad", systemImage: "square.and.arrow.down") }
                    .disabled(busy || !session.state.editable)
            }
            PhotosPicker(selection: $image, matching: .images) { Label("Insert photo", systemImage: "photo.badge.plus") }.disabled(busy)
            Button { if let id = module?.id { beginPdfImport(id) } } label: { Label("Add PDF", systemImage: "doc.badge.plus") }.disabled(busy || !session.ready)
        }
        Section {
            Button { session.toggleFiles() } label: { Label(session.filesOpen ? "Hide files" : "Show files", systemImage: "sidebar.right") }
                .disabled(busy || !session.ready)
        }
        if !session.saveStatus.isEmpty { Section { Text(session.saveStatus) } }
    }

    @ViewBuilder private func noteActions(_ session: WebSession, includePdf: Bool = true) -> some View {
        if session.state.inTable {
            Menu {
                TableEditingActions(session: session)
            } label: { Label("Table actions", systemImage: "tablecells") }
            .disabled(!session.state.editable)
        }
        Button { newDrawing() } label: { Label("Insert drawing", systemImage: "pencil.tip.crop.circle") }
            .disabled(busy || !session.state.editable)
        if prototypeDrawingAvailable {
            Button { newDrawing(importPrototype: true) } label: { Label("Import scratchpad", systemImage: "square.and.arrow.down") }
                .disabled(busy || !session.state.editable)
        }
        PhotosPicker(selection: $image, matching: .images) { Label("Insert photo", systemImage: "photo.badge.plus") }.disabled(busy)
        if includePdf {
            Button { if let id = module?.id { beginPdfImport(id) } } label: { Label("Add PDF", systemImage: "doc.badge.plus") }.disabled(busy || !session.ready)
        }
        Button { showingFind = true; findFocused = true } label: { Label("Find in note", systemImage: "magnifyingglass") }.keyboardShortcut("f")
        Button { reviewModule = selected; navigate("review") } label: { Label("Review", systemImage: "rectangle.stack") }
        if !session.saveStatus.isEmpty { Text(session.saveStatus) }
    }

    // Phone rows commit navigation only after the shared save/open barrier succeeds.
    // iPad keeps its existing selection-driven NavigationLinks.
    @ViewBuilder private func destinationLink<Content: View>(_ destination: String, @ViewBuilder label: () -> Content) -> some View {
        if isPhone {
            Button { if destination == "review" { reviewModule = nil }; if destination == "files" { filesModuleFilter = nil }; navigate(destination) } label: { label() }
                .foregroundStyle(.primary)
        } else {
            NavigationLink(value: destination, label: label)
        }
    }

    private func newDrawing(importPrototype: Bool = false) {
        guard let target = module, let session else { return }
        let imageId = UUID().uuidString
        Task {
            do {
                guard try await session.execute(.beginDrawing, ["imageId": imageId]) as? Bool == true else { throw CocoaError(.fileWriteUnknown) }
                try await session.flush()
                guard selected == target.id else { return }
                session.web.endEditing(true)
                drawingRequest = DrawingRequest(module: target, imageId: imageId, sourceId: nil, importPrototype: importPrototype, isNew: true)
            } catch { store.error = error.localizedDescription }
        }
    }

    private func handleModuleRequest() {
        guard !busy, !showingPdfImporter, let destination = session?.requestedModule else { return }
        session?.requestedModule = nil
        // A request from a web surface that is no longer displayed must not
        // navigate away from Home or Review after an asynchronous source lookup.
        guard module != nil || selected == "questions" else { return }
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
                if imported { NotificationCenter.default.post(name: .coreDidWrite, object: nil) }
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
        // hardware shortcut strip, with a separate occlusion frame for floating keyboards.
        withAnimation(animation) {
            let docked = localFrame.minY < window.bounds.maxY
                && localFrame.maxY >= window.bounds.maxY && localFrame.width >= window.bounds.width * 0.9
            // Without the hardware assistant, its frame can be below the window.
            // Keep our row at the bottom while the editor is first responder.
            let hardware = localFrame.minY >= window.bounds.maxY && session?.editorFirstResponder != nil
            keyboardDocked = !hiding && (docked || hardware)
            keyboardFrame = hiding ? .null : localFrame
        }
    }
    func newModule() {
        rename = nil
        name = ""
        editingName = true
    }
    /// Folder rows are tagged by the List's ForEach too; only pages and modules navigate.
    private func isDestination(_ id: String) -> Bool {
        ["home", "review", "files", "questions"].contains(id) || store.modules.contains { $0.id == id }
    }
    @ViewBuilder private func folderRow(_ item: SidebarItem) -> some View {
        Button {
            var next = item
            next.collapsed.toggle()
            Task { await store.saveSidebar([next]) }
        } label: {
            Label {
                Text(item.name ?? "")
            } icon: {
                Image(systemName: item.collapsed ? "folder" : "folder.fill")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .trailing) {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .rotationEffect(.degrees(item.collapsed ? 0 : 90))
            }
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .accessibilityValue(item.collapsed ? "Collapsed" : "Expanded")
        .selectionDisabled()
        .contextMenu {
            Button("Rename") { folder = item; folderName = item.name ?? ""; editingFolder = true }
            Button("Delete folder", role: .destructive) { deletingFolder = item }
        }
        .swipeActions {
            Button("Delete") { deletingFolder = item }.tint(.red)
            Button("Rename") { folder = item; folderName = item.name ?? ""; editingFolder = true }
        }
    }
    @ViewBuilder private func moduleRow(_ module: NoteModule, inFolder: Bool) -> some View {
        destinationLink(module.id) {
            Text(module.name).badge(store.counts.first { $0.moduleId == module.id }?.count ?? 0)
                .padding(.leading, inFolder ? 20 : 0)
        }
        .contextMenu { moduleActions(module) }
        // A destructive swipe removes the row before confirmation, losing its presenter.
        .swipeActions { Button("Delete") { deleting = module }.tint(.red); Button("Rename") { rename = module; name = module.name; editingName = true } }
        .alert("Delete module and its notes?", isPresented: Binding(get: { isPhone && deleting?.id == module.id }, set: { if !$0 && deleting?.id == module.id { deleting = nil } })) {
            Button("Delete", role: .destructive) { deleteModule(module) }
            Button("Cancel", role: .cancel) { deleting = nil }
        }
        .confirmationDialog("Delete module and its notes?", isPresented: Binding(get: { !isPhone && deleting?.id == module.id }, set: { if !$0 && deleting?.id == module.id { deleting = nil } })) {
            Button("Delete", role: .destructive) { deleteModule(module) }
        }
    }
    private func deleteModule(_ module: NoteModule) {
        Task {
            await store.perform {
                try await session?.flush()
                if selected == module.id { selected = "home" }
                try await store.client?.write("delete_module", ModuleArgs(moduleId: module.id))
            }
            deleting = nil
        }
    }
    @ViewBuilder func moduleActions(_ module: NoteModule) -> some View {
        Button("Rename") { rename = module; name = module.name; editingName = true }
        Button("Review") { reviewModule = module.id; navigate("review") }
        Button("Files", systemImage: "doc.text") { filesModuleFilter = module.id; navigate("files") }
        if session != nil {
            Button("Questions", systemImage: "questionmark.circle") { navigate("questions", questionScope: module.id) }
        }
        Button("Add PDF…", systemImage: "doc.badge.plus") { beginPdfImport(module.id) }
        let items = store.sidebarItems
        let folders = items.filter(\.isFolder)
        let current = items.first { $0.id == module.id }?.folder_id
        if !folders.isEmpty {
            Menu("Move to") {
                if current != nil {
                    Button("Top level", systemImage: "arrow.up.to.line") {
                        Task { await store.saveSidebar(SidebarLayout.move(items: items, module: module.id, into: nil)) }
                    }
                }
                ForEach(folders.filter { $0.id != current }) { folder in
                    Button(folder.name ?? "", systemImage: "folder") {
                        Task { await store.saveSidebar(SidebarLayout.move(items: items, module: module.id, into: folder.id)) }
                    }
                }
            }
        }
        Button("Delete", role: .destructive) { deleting = module }
    }
    private func setChapterNumbering(_ moduleId: String, _ enabled: Bool) async throws {
        guard let client = store.client else { throw URLError(.cannotConnectToHost) }
        try await session?.flush()
        do {
            try await client.write("set_module_numbering", NumberingArgs(moduleId: moduleId, enabled: enabled))
            store.modules = try await client.call("modules", Empty())
            _ = try await session?.callEditor(.refreshModules)
        } catch {
            // A write may have succeeded before a refresh failed; show persisted state on retry.
            do { store.modules = try await client.call("modules", Empty()) }
            catch { NSLog("Reloading modules after numbering failure: %@", String(describing: error)) }
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
                if isPhone { phoneColumn = .detail }
            } catch { store.error = String(describing: error) }
        }
    }
    private func openLibraryDocument(_ document: LibraryDocument) {
        guard !busy, let session, store.modules.contains(where: { $0.id == document.moduleId }) else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await session.flush()
                if session.ready {
                    try await revealLibraryDocument(document, in: session)
                } else {
                    session.onReady = { [weak session] in
                        guard let session else { return }
                        Task {
                            do { try await revealLibraryDocument(document, in: session) }
                            catch { store.error = error.localizedDescription }
                        }
                    }
                }
                store.recordOpenedModule(document.moduleId)
                selected = document.moduleId
                primaryLibraryDocumentId = document.id
                if isPhone { phoneColumn = .detail }
            } catch { store.error = error.localizedDescription }
        }
    }
    private func revealLibraryDocument(_ document: LibraryDocument, in session: WebSession) async throws {
        try await session.open(document.moduleId)
        _ = try await session.callEditor(.refreshDocuments, ["moduleId": document.moduleId], parameters: ["moduleId"])
        _ = try await session.callEditor(.pdfCommand, ["command": PdfCommand.openFile.rawValue, "value": document.id], parameters: ["command", "value"])
    }
    func navigate(_ destination: String, questionScope: String? = nil) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await session?.worksheetDrawing.cancel()
                try await session?.flush()
                showingFind = false
                showingContents = false
                primaryLibraryDocumentId = nil
                if destination == "questions", let session {
                    if session.ready { try await session.openQuestions(questionScope) }
                    else {
                        session.onReady = { [weak session] in
                            guard let session else { return }
                            Task { do { try await session.openQuestions(questionScope) } catch { store.error = String(describing: error) } }
                        }
                    }
                    questionsModule = questionScope
                } else {
                    try await session?.closeQuestions()
                    // A deferred Questions open must not replace a newer destination.
                    session?.onReady = nil
                }
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
                if isPhone { phoneColumn = .detail }
                await store.refresh()
            } catch { store.error = String(describing: error) }
        }
    }
}

/// The PDF's name; its menu switches files, returns to the list or adds one.
private struct PdfFileMenu: View {
    let session: WebSession
    let reader: PdfReaderState
    var iconOnly = false
    let addPdf: () -> Void

    var body: some View {
        Menu {
            actions
        } label: {
            HStack(spacing: 6) {
                Image("Pdf-file-text")
                if !iconOnly {
                    Text(reader.title).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180)
                }
                Image("Pdf-chevron-down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: iconOnly ? nil : 220)
            .accessibilityHidden(true)
        }
        .accessibilityLabel("PDF file")
        .accessibilityValue(reader.title)
    }
    @ViewBuilder var actions: some View {
            if reader.fullscreen {
                Button { session.pdfCommand(.backToNote) } label: { Label("Back to note", systemImage: "chevron.backward") }
            }
            Section {
                ForEach(reader.files) { file in
                    Button { session.pdfCommand(.openFile, file.id) } label: {
                        Label(file.name, systemImage: file.id == reader.activeId ? "checkmark" : "doc.text")
                    }
                }
            }
            if reader.activeId != nil {
                Button { session.pdfCommand(.showFiles) } label: { Label("All files", systemImage: "list.bullet") }
            }
            Button(action: addPdf) { Label("Add PDF", systemImage: "doc.badge.plus") }
    }
}

/// "3 / 12"; tapping asks for a page to jump to.
private struct PdfPageButton: View {
    let session: WebSession
    let reader: PdfReaderState
    var compact = false
    @State private var asking = false
    @State private var text = ""

    var body: some View {
        Button {
            text = ""
            asking = true
        } label: {
            if compact {
                Label("Page \(reader.page) of \(reader.pageCount) · Go to page", image: "Pdf-file-text")
            } else {
                HStack(spacing: 3) {
                    Text("\(reader.page)").fontWeight(.semibold)
                    Text("/ \(reader.pageCount)").foregroundStyle(.secondary)
                }
                .monospacedDigit()
                .padding(.horizontal, 4)
                .accessibilityHidden(true)
            }
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

private struct PdfQuestionCropToggle: View {
    let session: WebSession
    let reader: PdfReaderState

    var body: some View {
        Button { session.pdfCommand(.toggleQuestionCrop) } label: {
            Label("Crop question", image: "Pdf-question-crop")
        }
        .foregroundStyle(reader.questionCropping ? Color("BrandAccent") : Color.primary)
        .padding(6)
        .background(reader.questionCropping ? Color("BrandAccent").opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityValue(reader.questionCropping ? "On" : "Off")
        .disabled(!reader.canCropQuestion && !reader.questionCropping)
        .help("Crop question")
    }
}

/// Zoom and where the PDF is shown; pinching still zooms too.
private struct PdfViewMenu: View {
    let session: WebSession
    let reader: PdfReaderState
    var compactTools = false
    var addPdf: () -> Void = {}

    var body: some View {
        Menu {
            actions
        } label: {
            Label("More PDF actions", image: "Pdf-ellipsis")
        }
    }
    @ViewBuilder var actions: some View {
            if compactTools {
                // Only the tools a narrow bar drops; everything else stays visible.
                Section("Tools") {
                    Button { session.pdfCommand(.toggleAnnotate) } label: {
                        Label("Annotate area", image: "Pdf-highlighter")
                    }.disabled(!reader.canAnnotate && !reader.annotating)
                    Button { session.pdfCommand(.toggleFind) } label: {
                        Label("Find in PDF", image: "Pdf-search")
                    }
                }
            }
            Section("Zoom \(reader.zoom)%") {
                Button { session.pdfCommand(.zoomIn) } label: { Label("Zoom in", image: "Pdf-zoom-in") }
                    .disabled(!reader.canZoomIn)
                    .menuActionDismissBehavior(.disabled)
                Button { session.pdfCommand(.zoomOut) } label: { Label("Zoom out", image: "Pdf-zoom-out") }
                    .disabled(!reader.canZoomOut)
                    .menuActionDismissBehavior(.disabled)
            }
            if UIDevice.current.userInterfaceIdiom != .phone, !reader.fullscreen {
                Button { session.pdfCommand(.openFullscreen) } label: { Label("Open full screen", image: "Pdf-maximize-2") }
            }
    }
}

private struct QuestionScrollEdge: ViewModifier {
    let hidden: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) { content.scrollEdgeEffectHidden(hidden, for: .top) }
        else { content }
    }
}

// Stable type boundaries keep Debug metadata instantiation within the device's
// main-thread stack. Parent navigation never embeds the complete list type.
private struct RootSidebarList: View {
    let selection: Binding<String?>
    let destinations: AnyView
    let modules: AnyView
    let results: AnyView
    var body: some View {
        List(selection: selection) {
            destinations
            modules
            results
        }
    }
}
private extension View {
    func rootViewBoundary() -> AnyView { AnyView(self) }
}

/// Reports whether the sidebar column is inside the window, however it was shown or hidden.
private struct SidebarPresenceProbe: View {
    @Binding var onScreen: Bool
    var body: some View {
        GeometryReader { proxy in
            let visible = Self.visible(proxy.frame(in: .global))
            Color.clear
                .onAppear { onScreen = visible }
                .onChange(of: visible) { _, value in onScreen = value }
                .onDisappear { onScreen = false }
        }
    }
    private static func visible(_ frame: CGRect) -> Bool { frame.width > 0 && frame.maxX > frame.width / 2 }
}


/// The reader tools people reach for most stay in the bar; zoom and full screen live in the menu.
/// A narrow bar moves only annotate and find into the menu.
private struct TabletPdfTools: View {
    let session: WebSession
    let reader: PdfReaderState
    let expanded: Bool
    let addPdf: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            PdfFileMenu(session: session, reader: reader, iconOnly: true, addPdf: addPdf)
            if reader.activeId != nil {
                PdfPageButton(session: session, reader: reader)
                PdfModeButton(title: "Quote region", image: "Pdf-square-dashed-mouse-pointer", active: reader.selecting,
                              enabled: reader.canSelect || reader.selecting) { session.pdfCommand(.toggleSelect) }
                PdfQuestionCropToggle(session: session, reader: reader)
                if expanded {
                    PdfModeButton(title: "Annotate area", image: "Pdf-highlighter", active: reader.annotating,
                                  enabled: reader.canAnnotate || reader.annotating) { session.pdfCommand(.toggleAnnotate) }
                    PdfModeButton(title: "Find in PDF", image: "Pdf-search", active: false, enabled: true) { session.pdfCommand(.toggleFind) }
                }
                PdfViewMenu(session: session, reader: reader, compactTools: !expanded, addPdf: addPdf)
                if reader.fullscreen {
                    PdfModeButton(title: "Exit full screen", image: "Pdf-open-beside", active: false, enabled: true) { session.pdfCommand(.openBeside) }
                }
            }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.plain)
        .fixedSize()
    }
}

/// Tap to turn a reader mode on or off; the on state is a tinted highlight, as on desktop.
private struct PdfModeButton: View {
    let title: String
    let image: String
    let active: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) { Label(title, image: image) }
            .foregroundStyle(active ? Color("BrandAccent") : Color.primary)
            .padding(6)
            .background(active ? Color("BrandAccent").opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityValue(active ? "On" : "Off")
            .disabled(!enabled)
    }
}
