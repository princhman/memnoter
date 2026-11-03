import SwiftUI
import PhotosUI

struct RootView: View {
    @Bindable var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var session: WebSession?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var selected: String? = "home"
    @State private var reviewModule: String?
    @State private var search = ""
    @State private var hits: [SearchHit] = []
    @State private var showSearch = false
    @State private var showSettings = false
    @State private var showOutline = false
    @State private var editingName = false
    @State private var rename: NoteModule?
    @State private var name = ""
    @State private var busy = false
    @State private var image: PhotosPickerItem?
    @State private var find = ""
    @State private var showingFind = false
    @State private var keyboardDocked = false
    @State private var deleting: NoteModule?
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
                    ReviewView(client: client, directory: store.directory, moduleId: reviewModule)
                        .id(reviewModule ?? "all")
                } else if module != nil, let session {
                    if session.state.focusedSectionId != nil {
                        HStack {
                            Label(session.headings.first { $0.id == session.state.focusedSectionId }?.text ?? "Focused section", systemImage: "scope")
                                .font(.subheadline).lineLimit(1)
                            Spacer(minLength: 8)
                            Button("Show whole note") { session.exec("showDocument") }.fixedSize()
                        }.padding(.horizontal).padding(.vertical, 8).background(.bar)
                    }
                    if showingFind { TextField("Find in note", text: $find).textFieldStyle(.roundedBorder).padding().onChange(of: find) { _, value in session.exec("find", ["text": value]) } }
                    WebSurface(session: session)
                        .background(Color(uiColor: .systemBackground))
                        .overlay(alignment: .bottomTrailing) {
                            if keyboardDocked {
                                FormattingBar(session: session)
                                    .background(.regularMaterial, in: Capsule())
                                    .overlay { Capsule().strokeBorder(.primary.opacity(0.08)) }
                                    .shadow(color: .black.opacity(0.14), radius: 12, y: 4)
                                    .padding(16)
                                    .disabled(!session.state.editable)
                            }
                        }

                } else {
                    HomeView(modules: store.modules, recentModules: store.recentModules, newModule: newModule, openModule: navigate)
                        .disabled(busy)
                }
            }
            .navigationTitle(module?.name ?? (selected == "review" ? "Review" : "Home"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if columnVisibility == .detailOnly {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { withAnimation { columnVisibility = .all } } label: { Image(systemName: "sidebar.left") }
                            .accessibilityLabel("Show Sidebar")
                    }
                }
                if let session, module != nil {
                    ToolbarItemGroup(placement: .topBarLeading) {
                        Button { session.exec("undo") } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!session.state.canUndo).keyboardShortcut("z")
                        Button { session.exec("redo") } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift])
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if !session.saveStatus.isEmpty {
                            Label(session.saveStatus, systemImage: session.saveStatus == "Save failed" ? "exclamationmark.icloud" : "icloud.and.arrow.up")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    ToolbarItemGroup(placement: .primaryAction) {
                        PhotosPicker(selection: $image, matching: .images) { Image(systemName: "photo.badge.plus") }.disabled(busy).accessibilityLabel("Insert photo")
                        Button { showingFind.toggle() } label: { Image(systemName: "magnifyingglass") }.keyboardShortcut("f")
                        Button { showOutline = true } label: { Image(systemName: "list.bullet.indent") }
                        Button { reviewModule = selected; navigate("review") } label: { Label("Review", systemImage: "rectangle.stack") }.labelStyle(.iconOnly)
                    }
                }
                ToolbarItem(placement: .automatic) { Button { showSearch = true } label: { Image(systemName: "doc.text.magnifyingglass") }.keyboardShortcut("k") }
            }
        }
        .task(id: store.client != nil) {
            if let client = store.client, session == nil { session = WebSession(client: client, directory: store.directory) }
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
        .sheet(isPresented: $showSettings) { if let client = store.client { SettingsView(client: client, beforeRestore: { try await session?.flush() }, restored: { session?.dispose(); session = WebSession(client: client, directory: store.directory); selected = "home"; await store.refresh() }) } }
        .sheet(isPresented: $showOutline) {
            NavigationStack {
                List(session?.headings ?? []) { heading in
                    HStack {
                        Button(heading.text) { session?.exec("scrollToHeading", ["id": heading.id]); showOutline = false }.padding(.leading, CGFloat(heading.level - 1) * 16)
                        Spacer()
                        if session?.state.focusedSectionId == heading.id {
                            Image(systemName: "scope").foregroundStyle(.tint).accessibilityLabel("Focused section")
                        }
                        Button { focusSection(heading) } label: { Image(systemName: "viewfinder") }
                            .accessibilityLabel("Focus on section: \(heading.text)")
                        Button { session?.exec(heading.folded ? "unfold" : "fold", ["id": heading.id]) } label: { Image(systemName: heading.folded ? "chevron.right" : "chevron.down") }
                    }
                    .buttonStyle(.borderless)
                    .contextMenu { Button("Focus on section", systemImage: "scope") { focusSection(heading) } }
                }.navigationTitle("Outline").toolbar { Button("Done") { showOutline = false } }
            }
        }
        .alert("Memnoter", isPresented: Binding(get: { store.error != nil || session?.error != nil }, set: { if !$0 { store.error = nil; session?.error = nil } })) { Button("OK") { store.error = nil; session?.error = nil } } message: { Text(store.error ?? session?.error ?? "") }
        .onChange(of: image) { _, item in
            guard let item, let id = module?.id, let client = store.client else { return }
            busy = true
            Task {
                defer { busy = false; image = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw URLError(.cannotDecodeContentData) }
                    let file: SavedFile = try await client.call("save_file", FileArgs(moduleId: id, bytes: Array(data), mimeType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"))
                    let inserted = try await session?.run("return window.memnoterEditor.exec('insertImage', {fileId: id, alt: 'Photo'})", ["id": file.id]) as? Bool
                    if inserted != true { throw URLError(.cannotCreateFile) }
                    try await session?.flush()
                } catch { store.error = String(describing: error) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                  let window = session?.web.window else { keyboardDocked = false; return }
            let localFrame = window.convert(frame, from: window.screen.coordinateSpace)
            // The row follows the keyboard safe area, including the hardware shortcut bar.
            // Floating/undocked keyboards must not leave a row at the bottom of the note.
            keyboardDocked = localFrame.minY < window.bounds.maxY && localFrame.maxY >= window.bounds.maxY
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardDocked = false
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                let task = UIApplication.shared.beginBackgroundTask(withName: "Save note")
                Task { defer { UIApplication.shared.endBackgroundTask(task) }; do { try await session?.flush() } catch { store.error = String(describing: error) } }
            } else { Task { await store.refresh() } }
        }
    }
    func newModule() {
        rename = nil
        name = ""
        editingName = true
    }
    func focusSection(_ heading: Heading) {
        session?.exec("focusSection", ["id": heading.id])
        showOutline = false
    }
    @ViewBuilder func moduleActions(_ module: NoteModule) -> some View {
        Button("Rename") { rename = module; name = module.name; editingName = true }
        Button(module.heading_numbering ? "Hide chapter numbers" : "Show chapter numbers") {
            guard !busy else { return }
            busy = true
            Task {
                defer { busy = false }
                await store.perform {
                    try await session?.flush()
                    try await store.client?.write("set_module_numbering", NumberingArgs(moduleId: module.id, enabled: !module.heading_numbering))
                    // Recreate the provider so its cached module preferences refresh.
                    if let client = store.client {
                        session?.dispose()
                        let replacement = WebSession(client: client, directory: store.directory)
                        session = replacement
                        if let selected, store.modules.contains(where: { $0.id == selected }) {
                            replacement.onReady = { Task { do { try await replacement.open(selected) } catch { store.error = String(describing: error) } } }
                        }
                    }
                }
            }
        }
        Button("Review") { reviewModule = module.id; navigate("review") }
        Button("Delete", role: .destructive) { deleting = module }
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
                    else { session.onReady = { Task { do { try await session.open(destination) } catch { store.error = String(describing: error) } } } }
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
