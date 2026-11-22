import SwiftUI
import PhotosUI

struct FormatButtonStyle: ButtonStyle {
    var active = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .frame(minWidth: 30, minHeight: 30)
            .foregroundStyle(Color.primary)
            .background(Color(uiColor: .tertiarySystemFill).opacity(active || configuration.isPressed ? 1 : 0), in: RoundedRectangle(cornerRadius: 8))
            .opacity(isEnabled ? (configuration.isPressed ? 0.65 : 1) : 0.35)
            .padding(.horizontal, 3)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
    }
}

struct FormattingBar: View {
    @Bindable var session: WebSession
    let maximumWidth: CGFloat
    @Binding var image: PhotosPickerItem?
    let busy: Bool
    @State private var editingLink = false
    @State private var link = ""
    @State private var pickingImage = false

    private var rowWidth: CGFloat { max(36, maximumWidth - 8) }
    private var pinnedWidth: CGFloat { session.state.inTable ? 94 : 44 }

    var body: some View {
        HStack(spacing: 0) {
            TouchScrollingRow {
                buttons.fixedSize(horizontal: true, vertical: false)
            }
            .frame(width: max(0, rowWidth - pinnedWidth))
            divider
            // Keep table editing visible even on a narrow phone, independently
            // of the formatting row's current horizontal scroll position.
            if session.state.inTable {
                tableMenu
                divider
            }
            Button { session.web.endEditing(true) } label: { Image(systemName: "keyboard.chevron.compact.down") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Hide keyboard")
        }
        .frame(width: rowWidth, height: 44)
        .padding(.horizontal, 4)
        .background {
            Capsule().fill(.regularMaterial).frame(height: 38)
                .allowsHitTesting(false)
        }
        // The decorative shape covers the scroll viewport. It must not become
        // the hit-test target ahead of the row's pan recognizer and buttons.
        .overlay { Capsule().strokeBorder(.primary.opacity(0.08)).frame(height: 38).allowsHitTesting(false) }
        .shadow(color: .black.opacity(0.10), radius: 5, y: 2)
        .accessibilityElement(children: .contain)
    }

    /// One row for iPad and iPhone: direct style buttons, everything else in menus.
    private var buttons: some View {
        HStack(spacing: 0) {
            if !session.questionsOpen { cardGroup; divider }
            styleGroup.disabled(!session.state.editable)
            divider
            FormatBlockStyleMenu(session: session)
            FormatListMenu(session: session)
            divider
            FormatInsertMenu(session: session, busy: busy,
                             editingLink: $editingLink, pickingImage: $pickingImage)
                .popover(isPresented: $editingLink) {
                    linkEditor.padding().presentationCompactAdaptation(.popover)
                }
                .photosPicker(isPresented: $pickingImage, selection: $image, matching: .images)
            if !session.questionsOpen {
                FormatSectionMenu(session: session)
            }
            divider
            FormatClipboardMenu(session: session)
        }
        .tint(Color("BrandAccent"))
    }

    /// Cloze and every card action in one icon dropdown.
    private var cardGroup: some View {
        Menu {
            if session.state.inCloze {
                Button("Remove cloze", systemImage: "curlybraces") { session.exec(.removeCard) }
            } else {
                Button("Make cloze", systemImage: "curlybraces") { session.exec(.makeCard) }
                    .disabled(!session.state.canMakeCard)
            }
            if session.state.canJoinClozes {
                Button("Join clozes", systemImage: "rectangle.stack") { session.exec(.joinClozes) }
            }
            if session.state.canMakeClozeNote {
                Button("Make one note", systemImage: "square.dashed") { session.exec(.makeClozeNote) }
            }
            Divider()
            Button("List card", systemImage: "list.bullet") { session.exec(.insertListCard, focusAfter: true) }
                .disabled(!session.state.canInsertListCard)
            Button("Block card", systemImage: "text.alignleft") { session.exec(.insertBlockCard, focusAfter: true) }
                .disabled(!session.state.canInsertBlockCard)
            if session.state.canMakeListCard {
                Button("Make list card", systemImage: "list.bullet") { session.exec(.makeListCard, focusAfter: true) }
            }
            if session.state.canMakeBlockCard {
                Button("Make block card", systemImage: "text.alignleft") { session.exec(.makeBlockCard, focusAfter: true) }
            }
            if session.state.inListCard {
                Button("Remove list card", systemImage: "list.bullet") { session.exec(.removeListCard, focusAfter: true) }
            }
            if session.state.inBlockCard {
                Button("Remove block card", systemImage: "text.alignleft") { session.exec(.removeBlockCard, focusAfter: true) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "rectangle.on.rectangle")
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
        }
        .buttonStyle(FormatButtonStyle(active: session.state.inCloze || session.state.inListCard || session.state.inBlockCard))
        .accessibilityLabel("Cards")
    }

    @ViewBuilder private var styleGroup: some View {
        formatButton("Bold", "bold", .bold, active: mark("bold"))
        formatButton("Italic", "italic", .italic, active: mark("italic"))
        formatButton("Underline", "underline", .underline, active: mark("underline"))
        formatButton("Strikethrough", "strikethrough", .strike, active: mark("strike"))
        Menu {
            ForEach(BridgeProtocol.highlightColors, id: \.self) { color in
                Button { session.exec(.setHighlight, ["color": color]) } label: {
                    if session.state.highlightColor == color {
                        Label(color.capitalized, systemImage: "checkmark")
                    } else { Text(color.capitalized) }
                }
            }
            Button("Remove highlight") { session.exec(.removeHighlight) }
        } label: {
            Image(systemName: "highlighter")
                .foregroundStyle(highlightTint)
        } primaryAction: { session.exec(.highlight) }
        .buttonStyle(FormatButtonStyle(active: mark("highlight")))
        .accessibilityLabel("Highlight")
        .accessibilityValue(session.state.highlightColor ?? "Off")
        formatButton("Code", "chevron.left.forwardslash.chevron.right", .code, active: mark("code"))
    }

    private var tableMenu: some View {
        Menu {
            if session.state.inTable {
                TableEditingActions(session: session)
            } else {
                Button("Insert table") { session.exec(.insertTable) }
            }
        } label: { Image(systemName: "tablecells").frame(minWidth: 38, minHeight: 30) }
        .buttonStyle(FormatButtonStyle(active: session.state.inTable))
        .accessibilityLabel(session.state.inTable ? "Table actions" : "Insert table")
    }

    private var linkEditor: some View {
        HStack {
            TextField("Link URL", text: $link)
                .textFieldStyle(.roundedBorder).keyboardType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .frame(width: 200, height: 44).accessibilityLabel("Link URL")
            Button("Apply") {
                session.exec(.link, ["href": link], focusAfter: true)
                editingLink = false
            }
            .buttonStyle(FormatButtonStyle())
            .accessibilityLabel(link.isEmpty ? "Remove link" : "Apply link")
            .disabled(!link.isEmpty && URL(string: link)?.scheme == nil)
        }
    }

    private var highlightTint: Color {
        switch session.state.highlightColor {
        case "yellow": .yellow
        case "green": .green
        case "blue": .blue
        case "pink": .pink
        case "purple": .purple
        default: .primary
        }
    }

    private var divider: some View { Divider().frame(height: 16).padding(.horizontal, 3) }
    private func mark(_ name: String) -> Bool { session.state.marks.contains(name) }

    private func formatButton(_ title: String, _ symbol: String, _ command: ExecCommand, active: Bool = false) -> some View {
        Button { session.exec(command) } label: { Image(systemName: symbol) }
            .buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
    }
}

// Keep menu bodies in separate view types: large nested SwiftUI bodies can
// exhaust the main-thread stack on physical devices.
private struct FormatBlockStyleMenu: View {
    @Bindable var session: WebSession

    private var selection: Binding<Int> {
        Binding {
            session.state.headingLevel ?? (session.state.blockType == "paragraph" ? 0 : -1)
        } set: { level in
            session.exec(level == 0 ? .paragraph : .heading, level == 0 ? [:] : ["level": level])
        }
    }

    var body: some View {
        Menu {
            Picker("Block style", selection: selection) {
                Text("Text").tag(0)
                ForEach(1...6, id: \.self) { level in
                    Text("H\(level)").tag(level)
                }
            }
            Toggle("Quote", systemImage: "text.quote", isOn: Binding(
                get: { session.state.blockquote },
                set: { _ in session.exec(.blockquote) }))
        } label: {
            HStack(spacing: 4) {
                Text(session.state.headingLevel.map { "H\($0)" } ?? (session.state.blockquote ? "Quote" : "Text"))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: session.state.headingLevel != nil || session.state.blockquote))
        .disabled(!session.state.editable)
        .accessibilityLabel("Block style")
        .accessibilityValue(session.state.headingLevel.map { "Heading \($0)" } ?? (session.state.blockquote ? "Quote" : "Text"))
    }
}

private struct FormatListMenu: View {
    @Bindable var session: WebSession

    var body: some View {
        Menu {
            Toggle("Bullet list", systemImage: "list.bullet", isOn: Binding(
                get: { session.state.bulletList }, set: { _ in session.exec(.bulletList) }))
            Toggle("Numbered list", systemImage: "list.number", isOn: Binding(
                get: { session.state.orderedList }, set: { _ in session.exec(.orderedList) }))
            Divider()
            Button("Outdent", systemImage: "decrease.indent") { session.exec(.outdent) }
                .disabled(!session.state.canOutdent)
            Button("Indent", systemImage: "increase.indent") { session.exec(.indent) }
                .disabled(!session.state.canIndent)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: session.state.orderedList ? "list.number" : "list.bullet")
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
        }
        .buttonStyle(FormatButtonStyle(active: session.state.bulletList || session.state.orderedList))
        .disabled(!session.state.editable)
        .accessibilityLabel("Lists")
        .accessibilityValue(session.state.orderedList ? "Numbered list" : (session.state.bulletList ? "Bullet list" : "No list"))
    }
}

private struct FormatInsertMenu: View {
    @Bindable var session: WebSession
    let busy: Bool
    @Binding var editingLink: Bool
    @Binding var pickingImage: Bool

    var body: some View {
        Menu {
            Toggle("Inline math", systemImage: "function", isOn: Binding(
                get: { session.state.blockType == "inlineMath" }, set: { _ in session.exec(.inlineMath) }))
            Toggle("Math block", systemImage: "x.squareroot", isOn: Binding(
                get: { session.state.blockType == "mathBlock" }, set: { _ in session.exec(.mathBlock) }))
            Toggle("Code block", systemImage: "chevron.left.forwardslash.chevron.right", isOn: Binding(
                get: { session.state.blockType == "codeBlock" }, set: { _ in session.exec(.codeBlock) }))
            Divider()
            Button(session.state.marks.contains("link") ? "Edit link" : "Link", systemImage: "link") { editingLink = true }
            Button("Table", systemImage: "tablecells") { session.exec(.insertTable) }
            Button("Foldable block", systemImage: "rectangle.expand.vertical") { session.exec(.insertFoldableBlock) }
            Button("Photo", systemImage: "photo.badge.plus") { pickingImage = true }
                .disabled(busy)
            if session.worksheetAnswerFocused && UIDevice.current.userInterfaceIdiom != .pad {
                Button("Drawing", systemImage: "pencil.tip.crop.circle") { session.insertWorksheetDrawing() }
                    .disabled(busy)
            }
        } label: {
            Label("Insert", systemImage: "plus").fixedSize().padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle())
        .disabled(!session.state.editable)
    }
}

private struct FormatSectionMenu: View {
    @Bindable var session: WebSession

    var body: some View {
        Menu {
            Button("New section", systemImage: "text.badge.plus") { session.exec(.insertSection, ["kind": "sibling"]) }
            Button("Subsection", systemImage: "text.insert") { session.exec(.insertSection, ["kind": "subsection"]) }
            Button(session.state.folded ? "Unfold current section" : "Fold current section",
                   systemImage: session.state.folded ? "chevron.right" : "chevron.down") {
                session.exec(session.state.folded ? .unfoldCurrentSection : .foldCurrentSection)
            }
            .disabled(!session.state.folded && !session.state.canFold)
        } label: { Image(systemName: "text.badge.plus") }
        .buttonStyle(FormatButtonStyle(active: session.state.folded))
        .disabled(!session.state.editable)
        .accessibilityLabel("Sections")
    }
}

private struct FormatClipboardMenu: View {
    @Bindable var session: WebSession

    var body: some View {
        Menu {
            Button("Cut", systemImage: "scissors") { session.clipboard(#selector(UIResponderStandardEditActions.cut(_:))) }
                .disabled(!session.state.hasSelection || !session.state.editable)
            Button("Copy", systemImage: "doc.on.doc") { session.clipboard(#selector(UIResponderStandardEditActions.copy(_:))) }
                .disabled(!session.state.hasSelection)
            Button("Paste", systemImage: "doc.on.clipboard") { session.clipboard(#selector(UIResponderStandardEditActions.paste(_:))) }
                .disabled(!session.state.editable)
        } label: { Image(systemName: "doc.on.clipboard") }
        .buttonStyle(FormatButtonStyle())
        .accessibilityLabel("Clipboard")
    }
}

// A UIKit pan recognizer owns the whole row, including drags that begin on
// hosted buttons. Cancel their press once a pan wins, without delaying taps.
private final class FormattingScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

private struct TouchScrollingRow<Content: View>: UIViewControllerRepresentable {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    func makeUIViewController(context: Context) -> RowController<Content> {
        RowController(content: content)
    }
    func updateUIViewController(_ controller: RowController<Content>, context: Context) {
        controller.host.rootView = content
        controller.host.view.invalidateIntrinsicContentSize()
    }
}

private final class RowController<Content: View>: UIViewController {
    let host: UIHostingController<Content>
    init(content: Content) {
        host = UIHostingController(rootView: content)
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }
    override func loadView() {
        let scroll = FormattingScrollView()
        scroll.delaysContentTouches = false
        scroll.canCancelContentTouches = true
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.isDirectionalLockEnabled = true
        view = scroll
        addChild(host)
        host.sizingOptions = .intrinsicContentSize
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            host.view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        host.didMove(toParent: self)
    }
}

// Shared by the keyboard bar and note menu. Commands use the retained web
// selection without focusing the editor, so a hidden keyboard stays hidden.
struct TableEditingActions: View {
    @Bindable var session: WebSession

    var body: some View {
        Group {
            Button("Add row above") { session.exec(.addRowBefore) }
                .disabled(!session.state.canAddRowBefore)
            Button("Add row below") { session.exec(.addRowAfter) }
                .disabled(!session.state.canAddRowAfter)
            Button("Add column left") { session.exec(.addColumnBefore) }
                .disabled(!session.state.canAddColumnBefore)
            Button("Add column right") { session.exec(.addColumnAfter) }
                .disabled(!session.state.canAddColumnAfter)
            Button("Toggle header row") { session.exec(.toggleHeaderRow) }
                .disabled(!session.state.canToggleHeaderRow)
            Button("Merge cells") { session.exec(.mergeCells) }
                .disabled(!session.state.canMergeCells)
            Button("Split cell") { session.exec(.splitCell) }
                .disabled(!session.state.canSplitCell)
            Divider()
            Button("Delete row", role: .destructive) { session.exec(.deleteRow) }
                .disabled(!session.state.canDeleteRow)
            Button("Delete column", role: .destructive) { session.exec(.deleteColumn) }
                .disabled(!session.state.canDeleteColumn)
            Button("Delete table", role: .destructive) { session.exec(.deleteTable) }
                .disabled(!session.state.canDeleteTable)
        }
        .disabled(!session.state.editable)
    }
}
