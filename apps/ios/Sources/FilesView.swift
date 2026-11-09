import SwiftUI

struct LibraryDocument: Decodable, Identifiable, Sendable {
    let id: String
    let moduleId: String
    let moduleName: String
    let name: String
    let size: Int64
    let pageCount: Int?
    let createdAt: Int64
    let available: Bool

    var displayName: String {
        name.lowercased().hasSuffix(".pdf") ? String(name.dropLast(4)) : name
    }
    var metadata: String {
        guard available else { return "Downloading" }
        return pageCount.map { "\($0) pages" } ?? "PDF"
    }
}

private struct LibraryDocumentArgs: Encodable, Sendable { let id: String }
private struct RenameDocumentArgs: Encodable, Sendable { let id: String; let name: String }

struct FilesView: View {
    let client: CoreClient
    let modules: [NoteModule]
    @Binding var moduleFilter: String?
    let busy: Bool
    let open: (LibraryDocument) -> Void
    let addPdf: (String) -> Void
    @State private var documents: [LibraryDocument] = []
    @State private var loading = true
    @State private var error: String?
    @State private var renaming: LibraryDocument?
    @State private var name = ""
    @State private var deleting: LibraryDocument?
    @State private var saving = false
    @State private var revision = 0

    private var visible: [LibraryDocument] {
        documents.filter { moduleFilter == nil || $0.moduleId == moduleFilter }
    }

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loading && documents.isEmpty { ProgressView("Loading PDFs…") }
            ForEach(modules.filter { moduleFilter == nil || $0.id == moduleFilter }) { module in
                let files = visible.filter { $0.moduleId == module.id }
                if !files.isEmpty {
                    Section(module.name) {
                        ForEach(files) { document in
                            Button { open(document) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(document.displayName).foregroundStyle(.primary).lineLimit(2)
                                        Text(document.moduleName).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(document.metadata).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .contextMenu {
                                Button("Open", systemImage: "doc.text") { open(document) }
                                Button("Rename", systemImage: "pencil") { beginRename(document) }
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = document }
                            }
                            .swipeActions {
                                Button("Delete", role: .destructive) { deleting = document }
                                Button("Rename") { beginRename(document) }
                            }
                        }
                    }
                }
            }
            if !loading && visible.isEmpty && error == nil {
                ContentUnavailableView {
                    Label("No PDFs", systemImage: "doc.text")
                } description: {
                    Text(modules.isEmpty ? "Create a module to add PDFs." : "Choose PDFs to add to your library.")
                } actions: {
                    importButton
                }
                .listRowBackground(Color.clear)
            }
        }
        .disabled(busy || saving)
        .task(id: revision) { await reload() }
        .refreshable { await reload() }
        .onReceive(NotificationCenter.default.publisher(for: .coreDidWrite)) { _ in revision += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { _ in revision += 1 }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button("All modules") { moduleFilter = nil }
                    ForEach(modules) { module in
                        Button { moduleFilter = module.id } label: {
                            if moduleFilter == module.id { Label(module.name, systemImage: "checkmark") }
                            else { Text(module.name) }
                        }
                    }
                } label: {
                    Label(moduleFilter.flatMap { id in modules.first { $0.id == id }?.name } ?? "All modules", systemImage: "line.3.horizontal.decrease")
                }
                importButton
            }
        }
        .alert("Rename PDF", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $name)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                guard let document = renaming else { return }
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                let base = trimmed.lowercased().hasSuffix(".pdf") ? String(trimmed.dropLast(4)) : trimmed
                mutate("rename_document", RenameDocumentArgs(id: document.id, name: base + ".pdf"))
                renaming = nil
            }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Delete PDF?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete PDF", role: .destructive) {
                guard let document = deleting else { return }
                mutate("delete_document", LibraryDocumentArgs(id: document.id))
                deleting = nil
            }
        } message: {
            Text("“\(deleting?.displayName ?? "PDF")” will be removed from every device. This cannot be undone.")
        }
    }

    @ViewBuilder private var importButton: some View {
        if let id = moduleFilter ?? (modules.count == 1 ? modules.first?.id : nil) {
            Button("Add PDF", systemImage: "doc.badge.plus") { addPdf(id) }
        } else {
            Menu {
                ForEach(modules) { module in Button(module.name) { addPdf(module.id) } }
            } label: { Label("Add PDF", systemImage: "doc.badge.plus") }
            .disabled(modules.isEmpty)
        }
    }
    private func beginRename(_ document: LibraryDocument) {
        name = document.displayName
        renaming = document
    }
    private func reload() async {
        do {
            let result: [LibraryDocument] = try await client.call("list_documents", Empty())
            try Task.checkCancellation()
            documents = result
            error = nil
        } catch is CancellationError { return }
        catch { self.error = error.localizedDescription }
        loading = false
    }
    private func mutate<A: Encodable & Sendable>(_ command: String, _ args: A) {
        saving = true
        Task {
            defer { saving = false }
            do {
                try await client.write(command, args)
                await reload()
            } catch { self.error = error.localizedDescription }
        }
    }
}
