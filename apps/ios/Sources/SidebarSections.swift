import SwiftUI

struct SidebarSection: Decodable, Identifiable, Equatable {
    enum Target: Decodable, Equatable {
        case heading(String)
        case legacy(client: UInt32, clock: Int)

        private enum CodingKeys: String, CodingKey { case kind, id, itemId, client, clock }
        private enum Kind: String, Decodable { case heading, legacy = "legacy-heading" }

        init(from decoder: Decoder) throws {
            let value = try decoder.container(keyedBy: CodingKeys.self)
            switch try value.decode(Kind.self, forKey: .kind) {
            case .heading: self = .heading(try value.decode(String.self, forKey: .id))
            case .legacy:
                let item = try value.nestedContainer(keyedBy: CodingKeys.self, forKey: .itemId)
                self = .legacy(client: try item.decode(UInt32.self, forKey: .client), clock: try item.decode(Int.self, forKey: .clock))
            }
        }

        var arguments: [String: Any] {
            switch self {
            case .heading(let id): ["kind": "heading", "id": id]
            case .legacy(let client, let clock): ["kind": "legacy-heading", "itemId": ["client": Int(client), "clock": clock]]
            }
        }
    }

    let key: String
    let title: String
    let number: String
    let target: Target
    var id: String { key }

    func label(numbered: Bool) -> String {
        numbered && !number.isEmpty ? "\(number) \(title)" : title
    }
}

struct SidebarSectionSnapshot: Decodable, Equatable {
    let sections: [SidebarSection]
    var focusedKey: String? = nil
    var error: String? = nil

    static let readFailure = Self(sections: [], error: "Sections could not be loaded.")
}

enum SidebarNoteDestination {
    case document
    case section(SidebarSection.Target)
    case add

    var arguments: [String: Any] {
        switch self {
        case .document: ["kind": "document"]
        case .section(let target): target.arguments
        case .add: ["kind": "add"]
        }
    }
}

enum SidebarNavigationResult: String {
    case applied, unavailable
    case readOnly = "read-only"
}

struct SidebarModuleDisclosure: View {
    let name: String
    let count: Int
    let inFolder: Bool
    let compact: Bool
    let expanded: Bool
    let selected: Bool
    let open: () -> Void
    let toggle: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: open) {
                HStack {
                    Text(name)
                        .lineLimit(compact ? 1 : nil)
                        .fixedSize(horizontal: false, vertical: !compact)
                        .padding(.leading, inFolder ? 20 : 0)
                    Spacer(minLength: 4)
                    if count > 0 { Text(count, format: .number).font(.caption).foregroundStyle(.secondary) }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityAddTraits(selected ? .isSelected : [])
            Button(action: toggle) {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 44, height: 44, alignment: .trailing)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Sections in \(name)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        }
        .buttonStyle(.plain)
        .selectionDisabled()
        .listRowBackground(selected ? Color("BrandAccent").opacity(0.15) : nil)
    }
}

struct SidebarSectionRows: View {
    let module: NoteModule
    let snapshot: SidebarSectionSnapshot?
    let focusedKey: String?
    let inFolder: Bool
    let open: (SidebarSection.Target) -> Void

    var body: some View {
        let inset: CGFloat = inFolder ? 40 : 20
        if let snapshot, snapshot.error == nil, !snapshot.sections.isEmpty {
            ForEach(snapshot.sections) { section in
                let focused = focusedKey == section.key
                Button { open(section.target) } label: {
                    Text(section.label(numbered: module.heading_numbering))
                        .lineLimit(1)
                        .padding(.leading, inset)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .selectionDisabled()
                .listRowBackground(focused ? Color("BrandAccent").opacity(0.15) : nil)
                .accessibilityAddTraits(focused ? .isSelected : [])
                .accessibilityIdentifier("sidebar.section.\(module.id).\(section.key)")
            }
        } else {
            Text(snapshot?.error ?? (snapshot == nil ? "Loading sections…" : "No sections"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.leading, inset)
                .frame(minHeight: 44)
                .selectionDisabled()
        }
    }
}
