import Foundation

/// A sidebar row as stored by memnoter-core: a folder has a name; a module row
/// carries only its id. Mirrors `apps/shared-ui/src/lib/sidebar-layout.ts`.
struct SidebarItem: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var name: String?
    var folder_id: String?
    var sort_order: Int64
    var collapsed: Bool
    var deleted: Bool
    var isFolder: Bool { name != nil }
}
struct SidebarItemsArgs: Encodable, Sendable { let items: [SidebarItem] }

enum SidebarRow: Identifiable {
    case folder(SidebarItem)
    case module(SidebarItem, NoteModule)
    var id: String { item.id }
    var item: SidebarItem {
        switch self { case .folder(let item), .module(let item, _): item }
    }
}

enum SidebarLayout {
    private static func ordered(_ a: SidebarItem, _ b: SidebarItem) -> Bool {
        a.sort_order != b.sort_order ? a.sort_order < b.sort_order : a.id < b.id
    }

    /// Live folders plus one row per module. A module without a saved row goes
    /// last; a module in a missing or deleted folder returns to the top level.
    static func items(modules: [NoteModule], saved: [SidebarItem]) -> [SidebarItem] {
        let folders = saved.filter { $0.isFolder && !$0.deleted }
        let folderIds = Set(folders.map(\.id))
        let max = saved.map(\.sort_order).max() ?? -1
        let notes = modules.enumerated().map { index, module -> SidebarItem in
            if var item = saved.first(where: { $0.id == module.id && !$0.isFolder }) {
                if let parent = item.folder_id, !folderIds.contains(parent) { item.folder_id = nil }
                return item
            }
            return SidebarItem(id: module.id, name: nil, folder_id: nil, sort_order: max + Int64(index) + 1, collapsed: false, deleted: false)
        }
        return (folders + notes).sorted(by: ordered)
    }

    /// Top-level items in order, each folder followed by its modules when expanded.
    static func rows(items: [SidebarItem], modules: [NoteModule]) -> [SidebarRow] {
        let byId = Dictionary(modules.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func row(_ item: SidebarItem) -> SidebarRow? {
            item.isFolder ? .folder(item) : byId[item.id].map { .module(item, $0) }
        }
        let sorted = items.sorted(by: ordered)
        return sorted.filter { $0.folder_id == nil }.flatMap { item -> [SidebarRow] in
            guard item.isFolder, !item.collapsed else { return [row(item)].compactMap { $0 } }
            return [row(item)].compactMap { $0 } + sorted.filter { $0.folder_id == item.id }.compactMap(row)
        }
    }

    /// Applies a drag in the visible rows. A dragged module joins the expanded
    /// folder whose rows it lands in, otherwise the top level; folders stay top-level.
    static func move(items: [SidebarItem], rows: [SidebarRow], from source: IndexSet, to destination: Int) -> [SidebarItem] {
        var order = rows.map(\.item)
        let moved = Set(source.map { order[$0].id })
        order.move(fromOffsets: source, toOffset: destination)
        var parents: [String: String?] = [:]
        var current: String?
        for item in order {
            if item.isFolder {
                parents[item.id] = .some(nil)
                current = item.collapsed ? nil : item.id
            } else if moved.contains(item.id) {
                parents[item.id] = .some(current)
            } else {
                parents[item.id] = .some(item.folder_id)
                current = item.folder_id
            }
        }
        // Renumber each visible list in its new order; hidden rows keep theirs.
        var positions: [String: (String?, Int64)] = [:]
        var counters: [String: Int64] = [:]
        for item in order {
            let parent = parents[item.id] ?? nil
            let key = parent ?? ""
            let index = counters[key, default: 0]
            counters[key] = index + 1
            positions[item.id] = (parent, index)
        }
        return items.map { item in
            guard let (parent, index) = positions[item.id] else { return item }
            var next = item
            next.folder_id = parent
            next.sort_order = index
            return next
        }
    }

    /// Moves a module to the end of a folder, or of the top level when `folder` is nil.
    static func move(items: [SidebarItem], module id: String, into folder: String?) -> [SidebarItem] {
        let last = items.filter { $0.folder_id == folder && $0.id != id }.map(\.sort_order).max() ?? -1
        return items.map { item in
            guard item.id == id, !item.isFolder else { return item }
            var next = item
            next.folder_id = folder
            next.sort_order = last + 1
            return next
        }
    }

    static func changed(_ next: [SidebarItem], from saved: [SidebarItem]) -> [SidebarItem] {
        next.filter { item in saved.first { $0.id == item.id } != item }
    }
}
