import SwiftUI

/// Shared module navigation, with an item only when it adds a distinct name.
struct TabletBreadcrumb: View {
    let modules: [NoteModule]
    let scope: String?
    let section: String
    let item: String?
    let questionsEnabled: Bool
    let maximumWidth: CGFloat
    var wrapsTitles = false
    let changeScope: (String?) -> Void
    let changeSection: (String) -> Void

    private var moduleTitle: String { modules.first { $0.id == scope }?.name ?? "All modules" }
    private var distinctItem: String? {
        guard let item else { return nil }
        let name = item.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty,
              name.localizedCaseInsensitiveCompare(moduleTitle) != .orderedSame,
              name.localizedCaseInsensitiveCompare(section) != .orderedSame else { return nil }
        return item
    }

    /// Toolbar items are laid out at their ideal size, so a cap on the row alone lets long
    /// names draw past it. Give each label a measured width that already fits the row.
    static func textWidth(_ text: String) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: UIFont.preferredFont(forTextStyle: .subheadline)]).width) + 1
    }
    /// Natural widths unless the row really overflows. Then the shorter name keeps its full
    /// width (up to half) and the longer one takes the rest, so nothing truncates needlessly.
    private var labelWidths: (module: CGFloat, section: CGFloat, item: CGFloat) {
        let section = Self.textWidth(section.capitalized)
        let itemChrome: CGFloat = distinctItem == nil ? 0 : 24
        let chrome: CGFloat = 78 + itemChrome
        let available = max(40, maximumWidth - chrome - section)
        let module = Self.textWidth(moduleTitle)
        guard let item = distinctItem else { return (min(module, available), section, 0) }
        let itemWidth = Self.textWidth(item)
        if module + itemWidth <= available { return (module, section, itemWidth) }
        let half = available / 2
        if module <= half { return (module, section, max(30, available - module)) }
        if itemWidth <= half { return (max(40, available - itemWidth), section, itemWidth) }
        return (max(40, half), section, max(30, half))
    }

    var body: some View {
        let widths = labelWidths
        HStack(spacing: 8) {
            Menu {
                Button("All modules") { changeScope(nil) }
                ForEach(modules) { module in
                    Button { changeScope(module.id) } label: { Text(module.name).lineLimit(1) }
                }
            } label: {
                breadcrumbLabel(moduleTitle, width: widths.module)
            }.accessibilityLabel("Module scope")
            Text("/").foregroundStyle(.secondary)
            Menu {
                Button("Notes") { changeSection("notes") }
                Button("Files") { changeSection("files") }
                if questionsEnabled { Button("Questions") { changeSection("questions") } }
                Button("Review") { changeSection("review") }
            } label: {
                breadcrumbLabel(section.capitalized, width: widths.section)
            }.accessibilityLabel("Select module section")
            if let item = distinctItem {
                Text("›").foregroundStyle(.secondary)
                fittedText(item, width: widths.item, wraps: wrapsTitles)
            }
        }
        .font(.subheadline)
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .frame(maxWidth: maximumWidth, minHeight: 44)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func breadcrumbLabel(_ title: String, width: CGFloat) -> some View {
        HStack(spacing: 5) {
            fittedText(title, width: width, wraps: wrapsTitles)
            Image(systemName: "chevron.down").font(.caption)
        }.frame(minHeight: 44)
    }
}

/// A label clamps only when its measured width was actually reduced. Otherwise it keeps its
/// own size: a hard frame at the measured width truncates whenever SwiftUI's text is a hair wider.
@ViewBuilder func fittedText(_ text: String, width: CGFloat, wraps: Bool = false) -> some View {
    if width >= TabletBreadcrumb.textWidth(text) {
        Text(text).lineLimit(1).fixedSize()
    } else {
        Text(text).lineLimit(wraps ? 2 : 1).truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: wraps)
            .frame(width: width, alignment: .leading)
    }
}

struct TabletBackControls: View {
    let showSidebar: Bool
    let back: (() -> Void)?
    let toggleSidebar: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            if showSidebar {
                Button(action: toggleSidebar) { Image(systemName: "sidebar.left") }
                    .accessibilityLabel("Toggle Sidebar")
            }
            if let back {
                Button(action: back) { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Back to questions")
            }
        }
    }
}

/// Worksheets keep their own name without module navigation menus.
struct TabletWorksheetTitle: View {
    let title: String
    let maximumWidth: CGFloat

    var body: some View {
        fittedText(title, width: max(0, maximumWidth - 20), wraps: true)
            .font(.subheadline)
            .padding(.horizontal, 10)
            .frame(minHeight: 44)
            .layoutPriority(1)
            .accessibilityIdentifier("worksheet.title")
    }
}

/// Reserve a separate, stable trailing item for opening and closing the files pane.
struct TabletFilesToggle: View {
    @Bindable var session: WebSession
    let busy: Bool

    var body: some View {
        Button { session.toggleFiles() } label: {
            Image(systemName: "sidebar.right")
                .frame(width: 32, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(session.filesOpen ? "Hide files" : "Show files")
        .accessibilityValue(session.filesOpen ? "Open" : "Closed")
        .keyboardShortcut("d", modifiers: [.command, .shift])
        .disabled(busy || !session.ready)
    }
}

/// Constrain optional tools so long titles and side panes cannot evict the close button.
struct TabletNoteTools: View {
    @Bindable var session: WebSession
    @Binding var showingContents: Bool
    let actions: AnyView
    let contents: AnyView
    let hasPdf: Bool

    var body: some View {
        HStack(spacing: 16) {
            if !hasPdf {
                Button { session.exec(.undo) } label: { Image(systemName: "arrow.uturn.backward") }
                    .disabled(!session.state.canUndo).keyboardShortcut("z").accessibilityLabel("Undo")
                Button { session.exec(.redo) } label: { Image(systemName: "arrow.uturn.forward") }
                    .disabled(!session.state.canRedo).keyboardShortcut("z", modifiers: [.command, .shift]).accessibilityLabel("Redo")
                Button { showingContents.toggle() } label: { Image(systemName: "list.bullet.indent") }
                    .accessibilityLabel("Contents")
                    .popover(isPresented: $showingContents) { contents }
            }
            Menu {
                if hasPdf {
                    Button("Undo", systemImage: "arrow.uturn.backward") { session.exec(.undo) }.disabled(!session.state.canUndo)
                    Button("Redo", systemImage: "arrow.uturn.forward") { session.exec(.redo) }.disabled(!session.state.canRedo)
                    Button("Contents", systemImage: "list.bullet.indent") { showingContents = true }
                    Divider()
                }
                actions
            } label: { Image(systemName: "ellipsis").frame(width: 28, height: 44) }
                .accessibilityLabel("Note actions").accessibilityValue(session.saveStatus)
                .popover(isPresented: Binding(get: { hasPdf && showingContents }, set: { showingContents = $0 })) { contents }
        }
        .buttonStyle(.plain)
        .frame(height: 44)
        .padding(.horizontal, 6)
        .fixedSize()
    }
}

/// Keep the close control mounted at the trailing edge while PDF tools change.
struct TabletTrailingControls: View {
    @Bindable var session: WebSession
    let busy: Bool
    let noteTools: AnyView
    let pdfTools: AnyView

    var body: some View {
        TabletGlassRow {
            if !session.questionsOpen || session.bankControls?.visible == true {
                noteTools.modifier(TabletGlassPill())
            }
            if session.pdfReader != nil {
                pdfTools.modifier(TabletGlassPill())
            }
            if !session.questionsOpen || session.questionsModuleId != nil {
                TabletFilesToggle(session: session, busy: busy)
                    .buttonStyle(.plain)
                    .padding(.horizontal, 6)
                    .modifier(TabletGlassPill())
                    .layoutPriority(1)
            }
        }
        .fixedSize()
        .transaction { transaction in
            transaction.animation = nil
            transaction.disablesAnimations = true
        }
    }
}

/// The trailing pills share one container so they read like native toolbar groups without morphing.
struct TabletGlassRow<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) { HStack(spacing: 8) { content } }
        } else {
            HStack(spacing: 8) { content }
        }
    }
}

struct TabletGlassPill: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.frame(height: 44).glassEffect(.regular, in: Capsule())
        } else {
            content.frame(height: 44).background(.bar, in: Capsule())
        }
    }
}

struct BankToolbarState: Decodable, Equatable {
    let visible: Bool
    let reordering: Bool
    let reorderDisabled: Bool
    let newWorksheetVisible: Bool
    let worksheetDisabled: Bool
}

struct TabletQuestionTools: View {
    @Bindable var session: WebSession

    var body: some View {
        if let controls = session.bankControls, controls.visible {
            HStack(spacing: 16) {
                if controls.reordering {
                    // Leaving Reorder stays a labelled Done, like other edit modes.
                    Button("Done") { session.worksheetAction("bank-reorder") }
                        .font(.subheadline.weight(.semibold))
                        .disabled(controls.reorderDisabled)
                } else {
                    Button { session.worksheetAction("bank-reorder") } label: {
                        Image(systemName: "arrow.up.arrow.down").frame(width: 28, height: 44)
                    }
                    .accessibilityLabel("Reorder questions")
                    .disabled(controls.reorderDisabled)
                }
                if controls.newWorksheetVisible {
                    Button { session.worksheetAction("bank-new-worksheet") } label: {
                        Image(systemName: "doc.badge.plus").frame(width: 28, height: 44)
                    }
                    .accessibilityLabel("New worksheet")
                    .disabled(controls.worksheetDisabled)
                }
            }
            .font(.body)
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .frame(height: 44)
            .fixedSize()
        }
    }
}
