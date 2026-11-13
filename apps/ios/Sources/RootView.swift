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
    var module: NoteModule? { store.modules.first { $0.id == selected } }
    private var navigationWithPresentations: some View {
        navigation
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { notification in
            guard let result = notification.object as? SyncApplyResult else { return }
            Task {
                do {
                    if let session, session.ready {
                        _ = try await session.callEditor(.applyRemote, ["result": try JSONSerialization.jsonObject(with: Data(result.json.utf8))], parameters: ["result"])
                    }
                    await store.refresh()
                    if let selected, selected != "home", selected != "review", selected != "files", !store.modules.contains(where: { $0.id == selected }) { self.selected = "home" }
                } catch { store.error = error.localizedDescription }
            }
        }
        .task(id: store.sync != nil) {
            if let client = store.client, session == nil {
                await store.refresh()
                columnVisibility = sidebarVisible ? .all : .detailOnly
                if isPhone, selected != "home" { phoneColumn = .detail }
                let restored = WebSession(client: client, directory: store.directory, preferences: store.preferences)
                session = restored
                store.sync?.onFile = { module, json in
                    if let session, session.ready {
                        _ = try await session.callEditor(.fileStored, ["module": module, "file": try JSONSerialization.jsonObject(with: Data(json.utf8))], parameters: ["module", "file"])
                    }
                    await store.refresh()
                    NotificationCenter.default.post(name: .coreDidWrite, object: nil)
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
    }

    var body: some View {
        navigationWithPresentations
            .background { UpdateNoticeView(required: store.sync?.updateRequired == true) }
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
            if isPhone || session?.imagePreviewOpen == true { return }
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
                        try await session?.flush()
                        _ = try await store.sync?.pushAndWait()
                    } catch is CancellationError { }
                    catch { store.error = String(describing: error) }
                }
            } else { backgroundWork?.cancel(); store.sync?.resume(); Task { await store.refresh() } }
        }
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

    private var sidebar: some View {
        List(selection: Binding(get: { selected }, set: { if let destination = $0, isDestination(destination) { if destination == "review" { reviewModule = nil }; if destination == "files" { filesModuleFilter = nil }; navigate(destination) } })) {
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
            if !search.isEmpty {
                Section("Search results") {
                    ForEach(hits, id: \.module_id) { hit in
                        destinationLink(hit.module_id) { VStack(alignment: .leading) { Text(hit.name); Text(hit.snippet.filter { !$0.isASCII || !$0.isNewline && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }).font(.caption).lineLimit(2) } }
                    }
                }
            }
        }
        .listStyle(.sidebar)
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

    private var detail: some View {
        VStack(spacing: 0) {
            if selected == "review", let client = store.client {
                ReviewView(client: client, directory: store.directory, moduleId: reviewModule, preferences: store.preferences, editCard: editReviewCard)
                    .id(reviewModule ?? "all")
            } else if selected == "files", let client = store.client {
                FilesView(client: client, modules: store.modules, moduleFilter: $filesModuleFilter, busy: busy, open: openLibraryDocument, addPdf: beginPdfImport)
            } else if module != nil, let session {
                if showingFind {
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
                WebSurface(session: session)
                    .background(Color(uiColor: .systemBackground))
                    .overlay {
                        GeometryReader { geometry in
                        // WebKit can hide the keyboard while selecting text. Keep
                        // formatting available for the retained selection, also
                        // when an iPad hardware keyboard has no onscreen frame.
                        let showBar = (keyboardDocked || session.state.hasSelection) && session.state.suppressKeyboard != true && !session.pdfCoveringNote && !session.pdfFocused
                        let editorFrame = geometry.frame(in: .global)
                        // Also keep the caret above an undocked/floating keyboard
                        // when it overlaps this editor column.
                        let keyboardInset = editorFrame.intersects(keyboardFrame) ? max(0, editorFrame.maxY - keyboardFrame.minY) : 0
                        Color.clear
                            .onChange(of: keyboardInset + (showBar ? 76 : 0), initial: true) { _, overlap in
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
        // PDF controls own the iPad bar; a competing title can collapse to just an ellipsis.
        .navigationTitle(phoneSplitLayout || (!isPhone && module != nil && session?.pdfReader != nil) || (selected == "review" && detailWidth < 500) ? "" : (module?.name ?? (selected == "review" ? "Review" : selected == "files" ? "Files" : "Home")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if (isPhone || module == nil || session?.pdfReader == nil) && (selected != "review" || detailWidth >= 500) {
                ToolbarItem(placement: phoneSplitLayout ? .topBarLeading : .principal) {
                    if isPhone, module != nil, let reader = session?.pdfReader {
                        Text(reader.title).lineLimit(1).truncationMode(.middle)
                            .accessibilityIdentifier("module.title")
                    } else if isPhone, let module, let session {
                        PhoneNoteTitle(session: session, moduleName: module.name) { showingContents = true }
                    } else {
                        Text(module != nil && session?.state.focusedSectionId != nil
                             ? session?.state.focusedSectionPath.last?.title ?? module?.name ?? "Section"
                             : module?.name ?? (selected == "review" ? "Review" : selected == "files" ? "Files" : "Home"))
                            .lineLimit(1).truncationMode(.tail)
                            .accessibilityIdentifier("module.title")
                    }
                }
            }
        }
        .toolbar {
            if canToggleSidebar && columnVisibility == .detailOnly && (selected != "review" || horizontalSizeClass != .compact) {
                ToolbarItem(placement: .topBarLeading) {
                    Button { withAnimation { columnVisibility = .all } } label: { Image(systemName: "sidebar.left") }
                        .accessibilityLabel("Show Sidebar")
                }
            }
            if let session, module != nil {
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
                } else if let reader = session.pdfReader {
                    ToolbarItem(placement: .primaryAction) {
                        PdfFileMenu(session: session, reader: reader, iconOnly: detailWidth < 900) { if let id = module?.id { beginPdfImport(id) } }
                    }
                    if reader.activeId != nil {
                        if detailWidth >= 700 {
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
                        }
                        ToolbarItem(placement: .primaryAction) { PdfViewMenu(session: session, reader: reader, compactTools: detailWidth < 700) }
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

                if !isPhone || session.pdfReader == nil {
                    ToolbarItemGroup(placement: isPhone ? .topBarTrailing : .topBarLeading) {
                        Button { session.exec(.undo) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!session.state.canUndo).keyboardShortcut("z")
                            .accessibilityLabel("Undo")
                        Button { session.exec(.redo) } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift])
                            .accessibilityLabel("Redo")
                    }
                    if !isPhone {
                        ToolbarItem(placement: .primaryAction) {
                            Button { showingContents.toggle() } label: { Label("Contents", systemImage: "list.bullet.indent") }
                                .accessibilityLabel("Contents")
                                .popover(isPresented: $showingContents) {
                                    ContentsPopover(session: session, moduleName: module?.name ?? "Note") { showingContents = false }
                                }
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            noteActions(session)
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
                Toggle(isOn: Binding(get: { reader.selecting }, set: { _ in session.pdfCommand(.toggleSelect) })) {
                    Label("Select region", systemImage: "rectangle.dashed")
                }.disabled(!reader.canSelect && !reader.selecting)
                Toggle(isOn: Binding(get: { reader.annotating }, set: { _ in session.pdfCommand(.toggleAnnotate) })) {
                    Label("Annotate area", systemImage: "highlighter")
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
        ["home", "review", "files"].contains(id) || store.modules.contains { $0.id == id }
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
                if isPhone { phoneColumn = .detail }
            } catch { store.error = error.localizedDescription }
        }
    }
    private func revealLibraryDocument(_ document: LibraryDocument, in session: WebSession) async throws {
        try await session.open(document.moduleId)
        _ = try await session.callEditor(.refreshDocuments, ["moduleId": document.moduleId], parameters: ["moduleId"])
        _ = try await session.callEditor(.pdfCommand, ["command": PdfCommand.openFile.rawValue, "value": document.id], parameters: ["command", "value"])
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
                Image(systemName: "doc.text")
                if !iconOnly {
                    Text(reader.title).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180)
                }
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
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
                Label("Page \(reader.page) of \(reader.pageCount) · Go to page", systemImage: "doc.text")
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

/// Zoom and where the PDF is shown; pinching still zooms too.
private struct PdfViewMenu: View {
    let session: WebSession
    let reader: PdfReaderState
    var compactTools = false

    var body: some View {
        Menu {
            actions
        } label: {
            Label("More PDF actions", systemImage: "ellipsis")
        }
    }
    @ViewBuilder var actions: some View {
            if compactTools {
                PdfPageButton(session: session, reader: reader, compact: true)
                Section("Tools") {
                    Toggle(isOn: Binding(get: { reader.selecting }, set: { _ in session.pdfCommand(.toggleSelect) })) {
                        Label("Select region", systemImage: "rectangle.dashed")
                    }.disabled(!reader.canSelect && !reader.selecting)
                    Toggle(isOn: Binding(get: { reader.annotating }, set: { _ in session.pdfCommand(.toggleAnnotate) })) {
                        Label("Annotate area", systemImage: "highlighter")
                    }.disabled(!reader.canAnnotate && !reader.annotating)
                }
            }
            Section("Zoom \(reader.zoom)%") {
                Button { session.pdfCommand(.zoomIn) } label: { Label("Zoom in", systemImage: "plus.magnifyingglass") }
                    .disabled(!reader.canZoomIn)
                    .menuActionDismissBehavior(.disabled)
                Button { session.pdfCommand(.zoomOut) } label: { Label("Zoom out", systemImage: "minus.magnifyingglass") }
                    .disabled(!reader.canZoomOut)
                    .menuActionDismissBehavior(.disabled)
            }
            if UIDevice.current.userInterfaceIdiom != .phone, !reader.fullscreen {
                Button { session.pdfCommand(.openFullscreen) } label: { Label("Open full screen", systemImage: "arrow.up.left.and.arrow.down.right") }
            }
    }
}
