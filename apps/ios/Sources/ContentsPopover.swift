import SwiftUI

// Document-order headings form a tree even when levels are skipped. Build it
// once per browser update; each level then reads only its immediate children.
struct ContentsHierarchy {
    let headings: [Heading]
    var byID: [String: Heading] = [:]
    var roots: [Heading] = []
    var children: [String: [Heading]] = [:]
    var parents: [String: String] = [:]

    init(_ headings: [Heading]) {
        self.headings = headings
        var stack: [Heading] = []
        for heading in headings {
            while let last = stack.last, last.level >= heading.level { stack.removeLast() }
            byID[heading.id] = heading
            if let parent = stack.last {
                children[parent.id, default: []].append(heading)
                parents[heading.id] = parent.id
            } else { roots.append(heading) }
            stack.append(heading)
        }
    }

    func ancestors(of id: String) -> [Heading] {
        var result: [Heading] = []
        var next = parents[id]
        while let id = next, let heading = byID[id] {
            result.append(heading)
            next = parents[id]
        }
        return result.reversed()
    }

    func containsReadingSection(_ heading: Heading, current: String?) -> Bool {
        guard let current else { return false }
        return current == heading.id || ancestors(of: current).contains { $0.id == heading.id }
    }
}

struct ContentsPopover: View {
    let session: WebSession
    let moduleName: String
    let close: () -> Void
    var body: some View {
        ContentsBrowser(session: session, moduleName: moduleName, close: close)
            .frame(width: 380, height: 520)
            .presentationCompactAdaptation(.sheet)
    }
}

struct ContentsSheet: View {
    let session: WebSession
    let moduleName: String
    let close: () -> Void
    var body: some View {
        ContentsBrowser(session: session, moduleName: moduleName, close: close)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
    }
}

private struct ContentsBrowser: View {
    let session: WebSession
    let moduleName: String
    let close: () -> Void
    @State private var path: [String] = []
    @State private var search = ""

    var body: some View {
        let tree = ContentsHierarchy(session.allHeadings)
        NavigationStack(path: $path) {
            level(nil, tree: tree)
                .navigationDestination(for: String.self) { id in level(tree.byID[id], tree: tree) }
        }
        .tint(Color("BrandAccent"))
        .onAppear { session.trackOutline(true) }
        .onDisappear { session.trackOutline(false) }
        .onChange(of: session.allHeadings.map(\.id)) { _, ids in
            let valid = Set(ids)
            path = Array(path.prefix { valid.contains($0) })
        }
    }

    private func level(_ parent: Heading?, tree: ContentsHierarchy) -> some View {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let rows = query.isEmpty ? (parent.map { tree.children[$0.id] ?? [] } ?? tree.roots)
            : tree.headings.filter { $0.text.localizedStandardContains(query) }
        return List {
            if let parent, query.isEmpty {
                HStack(spacing: 0) {
                    Button { navigate(parent) } label: {
                        Label("Go to Section", systemImage: ContentsSymbol.jump)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(height: 32)
                            .background(Color("BrandAccent").opacity(0.14), in: Capsule())
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color("BrandAccent"))
                    .accessibilityLabel("Go to section \(parent.text)")
                    Spacer(minLength: 12)
                    ContentsActions { focusButton(parent) }
                }
                .contentsRow(highlighted: false)
                .padding(.bottom, 6)
            }
            ForEach(rows) { heading in
                row(heading, tree: tree, query: query)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 48)
        .overlay {
            if rows.isEmpty && (parent == nil || !query.isEmpty) {
                ContentUnavailableView(query.isEmpty ? "No headings" : "No matching sections", systemImage: "text.alignleft", description: Text(query.isEmpty ? "Add headings to navigate this note." : "Try a different section title."))
            }
        }
        .navigationTitle(parent?.text ?? "Contents")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Find a section")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) }
        }
        .safeAreaInset(edge: .bottom) {
            if session.state.focusedSectionId != nil {
                Button { session.exec(.showDocument); close() } label: {
                    Label("Whole Note", systemImage: ContentsSymbol.unfocus)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 6)
                        .frame(minHeight: 36)
                }
                .modifier(ContentsGlassButton())
                .frame(minHeight: 44)
                .padding(.bottom, 8)
                .accessibilityLabel("Show whole note")
                .accessibilityIdentifier("contents.wholeNote")
            }
        }
    }

    private func row(_ heading: Heading, tree: ContentsHierarchy, query: String) -> some View {
        let hasChildren = !(tree.children[heading.id] ?? []).isEmpty
        let current = tree.containsReadingSection(heading, current: session.currentHeadingId)
        let trail = tree.ancestors(of: heading.id).map(\.text)
        return HStack(spacing: 8) {
            Button {
                if hasChildren {
                    search = ""
                    if query.isEmpty { path.append(heading.id) }
                    else { path = tree.ancestors(of: heading.id).map(\.id) + [heading.id] }
                } else { navigate(heading) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let number = heading.number {
                            Text(number).monospacedDigit()
                                .foregroundStyle(current ? AnyShapeStyle(Color("BrandAccent").opacity(0.75)) : AnyShapeStyle(.secondary))
                        }
                        Text(heading.text).lineLimit(2)
                            .fontWeight(current ? .semibold : .regular)
                            .foregroundStyle(current ? AnyShapeStyle(Color("BrandAccent")) : AnyShapeStyle(.primary))
                    }
                    if !query.isEmpty && !trail.isEmpty {
                        Text(trail.joined(separator: " › "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(heading.text)
            .accessibilityHint(hasChildren ? "Browse subsections" : "Go to section")
            .accessibilityAddTraits(current ? .isSelected : [])
            ContentsActions {
                if hasChildren {
                    ContentsIconButton(symbol: ContentsSymbol.jump) { navigate(heading) }
                        .accessibilityLabel("Go to section \(heading.text)")
                        .help("Go to section")
                }
                focusButton(heading)
            }
        }
        .contentsRow(highlighted: current)
    }

    private func focusButton(_ heading: Heading) -> some View {
        let focused = session.state.focusedSectionId == heading.id
        return ContentsIconButton(symbol: focused ? ContentsSymbol.unfocus : ContentsSymbol.focus, active: focused) {
            if focused { session.exec(.showDocument) }
            else { session.exec(.focusSection, ["id": heading.id, "revealHidden": true]) }
            close()
        }
        .accessibilityLabel(focused ? "Unfocus \(heading.text)" : "Focus on \(heading.text)")
        .help(focused ? "Show whole note" : "Focus on this section")
    }

    private func navigate(_ heading: Heading) {
        session.exec(.scrollToHeading, ["id": heading.id, "revealHidden": true])
        close()
    }
}

private enum ContentsSymbol {
    static let jump = "arrow.right.to.line"
    static let focus = "viewfinder"
    static let unfocus = "arrow.up.left.and.arrow.down.right"
}

private extension View {
    // Inset rounded selection instead of a full-bleed band; the reading branch
    // reads as a quiet brand-tinted card behind the row.
    func contentsRow(highlighted: Bool) -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: 26, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(highlighted ? Color("BrandAccent").opacity(0.13) : .clear)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 2)
            )
    }
}

private struct ContentsGlassButton: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.plain)
                .padding(.horizontal, 12)
                .foregroundStyle(Color("BrandAccent"))
                .glassEffect(.regular.tint(Color("BrandAccent").opacity(0.18)).interactive(), in: Capsule())
        } else {
            content.buttonStyle(.bordered).buttonBorderShape(.capsule)
        }
    }
}

// Row actions share one compact capsule. Each icon keeps a 44pt hit target
// while the visible capsule stays 32pt tall.
private struct ContentsActions<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 0) { content }
            .background { ContentsCapsule().padding(.horizontal, 4).frame(height: 32) }
    }
}

// Rows are content, so their controls use a system fill; Liquid Glass stays on
// the navigation layer (toolbar, search and Whole Note) instead of stacking.
private struct ContentsCapsule: View {
    var body: some View {
        Capsule().fill(Color(uiColor: .tertiarySystemFill))
    }
}

private struct ContentsIconButton: View {
    let symbol: String
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? AnyShapeStyle(Color("BrandAccent")) : AnyShapeStyle(.secondary))
    }
}
