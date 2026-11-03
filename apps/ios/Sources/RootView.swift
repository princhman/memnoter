import SwiftUI
import PhotosUI

struct RootView: View {
    @Bindable var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var session: WebSession?
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
    @State private var deleting: NoteModule?
    var module: NoteModule? { store.modules.first { $0.id == selected } }
    var body: some View {
        NavigationSplitView {
            List {
                Button { navigate("home") } label: { Label("Home", systemImage: "house") }
                Button { reviewModule = nil; navigate("review") } label: {
                    Label("Review", systemImage: "rectangle.stack").badge(store.counts.reduce(0) { $0 + $1.count })
                }
                Section("Modules") {
                    ForEach(store.modules) { module in
                        Button { navigate(module.id) } label: {
                            HStack { Text(module.name); Spacer(); Text("\(store.counts.first { $0.moduleId == module.id }?.count ?? 0)").foregroundStyle(.secondary) }
                        }
                        .listRowBackground(selected == module.id ? Color.accentColor.opacity(0.15) : Color.clear)
                        .contextMenu { moduleActions(module) }
                        .swipeActions { Button("Delete", role: .destructive) { deleting = module }; Button("Rename") { rename = module; name = module.name; editingName = true } }
                    }
                }
                if !search.isEmpty {
                    Section("Search results") {
                        ForEach(hits, id: \.module_id) { hit in
                            Button { navigate(hit.module_id) } label: { VStack(alignment: .leading) { Text(hit.name); Text(hit.snippet.filter { !$0.isASCII || !$0.isNewline && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }).font(.caption).lineLimit(2) } }
                        }
                    }
                }
            }
            .searchable(text: $search, isPresented: $showSearch, prompt: "Search notes")
            .task(id: search) {
                guard let client = store.client else { return }
                do { let results: [SearchHit] = try await client.call("search_notes", SearchArgs(query: search)); if !Task.isCancelled { hits = results } }
                catch { store.error = String(describing: error) }
            }
            .navigationTitle("Memnoter")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { rename = nil; name = ""; editingName = true } label: { Image(systemName: "plus") }.keyboardShortcut("n") }
                ToolbarItem(placement: .bottomBar) { Button { showSettings = true } label: { Label("Settings", systemImage: "gear") }.disabled(busy) }
            }
            .disabled(busy)
        } detail: {
            VStack(spacing: 0) {
                if selected == "review", let client = store.client {
                    ReviewView(client: client, directory: store.directory, moduleId: reviewModule)
                        .id(reviewModule ?? "all")
                } else if module != nil, let session {
                    if showingFind { TextField("Find in note", text: $find).textFieldStyle(.roundedBorder).padding().onChange(of: find) { _, value in session.exec("find", ["text": value]) } }
                    WebSurface(session: session)
                    HStack {
                        ForEach([("bold", "B"), ("italic", "I"), ("underline", "U"), ("heading", "H1"), ("bulletList", "List"), ("makeCard", "Card")], id: \.0) { command, title in
                            Button(title) { session.exec(command, command == "heading" ? ["level": 1] : [:]) }
                                .tint(session.state.marks.contains(command) ? .accentColor : .secondary)
                        }
                        Menu {
                            ForEach(1...3, id: \.self) { level in Button("Heading \(level)") { session.exec("heading", ["level": level]) } }
                            ForEach(["paragraph", "orderedList", "blockquote", "code", "strike", "inlineMath", "mathBlock"], id: \.self) { command in Button(command) { session.exec(command) } }
                        } label: { Image(systemName: "textformat") }.accessibilityLabel("More formatting")
                        Spacer()
                        PhotosPicker(selection: $image, matching: .images) { Image(systemName: "photo.badge.plus") }.disabled(busy)
                        Text(session.saveStatus).font(.caption).foregroundStyle(.secondary)
                    }.padding(10).background(.bar).disabled(!session.state.editable)
                } else {
                    ContentUnavailableView("Your knowledge, connected", systemImage: "note.text", description: Text("Create a module to start writing. Use Q :: A to make a flashcard."))
                }
            }
            .navigationTitle(module?.name ?? (selected == "review" ? "Review" : "Home"))
            .toolbar {
                if let session, module != nil {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button { session.exec("undo") } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!session.state.canUndo).keyboardShortcut("z")
                        Button { session.exec("redo") } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift])
                        Button { showingFind.toggle() } label: { Image(systemName: "magnifyingglass") }.keyboardShortcut("f")
                        Button { showOutline = true } label: { Image(systemName: "list.bullet.indent") }
                        Button("Review") { reviewModule = selected; navigate("review") }
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
                        Button { session?.exec(heading.folded ? "unfold" : "fold", ["id": heading.id]) } label: { Image(systemName: heading.folded ? "chevron.right" : "chevron.down") }
                    }
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
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                let task = UIApplication.shared.beginBackgroundTask(withName: "Save note")
                Task { defer { UIApplication.shared.endBackgroundTask(task) }; do { try await session?.flush() } catch { store.error = String(describing: error) } }
            } else { Task { await store.refresh() } }
        }
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
                selected = destination
                await store.refresh()
            } catch { store.error = String(describing: error) }
        }
    }
}
