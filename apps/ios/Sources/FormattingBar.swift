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
    private let isPhone = UIDevice.current.userInterfaceIdiom == .phone

    private var rowWidth: CGFloat { max(36, maximumWidth - 8) }

    var body: some View {
        HStack(spacing: 0) {
            TouchScrollingRow {
                buttons.fixedSize(horizontal: true, vertical: false)
            }
            divider
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

    // Left to right: cards, inline style, block type, lists, insertions, note
    // sections, clipboard. Hide keyboard stays pinned outside the scrolling row.
    private var buttons: some View {
        HStack(spacing: 0) {
            if isPhone {
                paragraphMenu
                divider
            }
            cardGroup
            divider
            styleGroup
            divider
            blockGroup
            divider
            listGroup
            divider
            insertGroup
            divider
            sectionGroup
            divider
            clipboardGroup
        }
    }

    @ViewBuilder private var cardGroup: some View {
        Button { session.exec(session.state.inCloze ? .removeCard : .makeCard) } label: {
            Label("Cloze", systemImage: "curlybraces")
                .labelStyle(.titleAndIcon)
                .fixedSize()
                .padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: session.state.inCloze))
        .disabled(!session.state.inCloze && !session.state.canMakeCard)
        .accessibilityLabel(session.state.inCloze ? "Remove cloze" : "Make cloze from selection")
        .accessibilityAddTraits(session.state.inCloze ? .isSelected : [])
        if session.state.canJoinClozes {
            formatButton("Join clozes", "rectangle.stack", .joinClozes)
        }
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

    @ViewBuilder private var blockGroup: some View {
        if !isPhone {
            paragraph("Text", level: nil)
            ForEach(1...6, id: \.self) { level in paragraph("H\(level)", level: level) }
        }
        formatButton("Quote", "text.quote", .blockquote, active: session.state.blockquote)
    }

    private var paragraphMenu: some View {
        Menu {
            paragraphChoice("Text", level: nil)
            ForEach(1...6, id: \.self) { level in paragraphChoice("Heading \(level)", level: level) }
        } label: {
            HStack(spacing: 4) {
                Text(session.state.headingLevel.map { "H\($0)" } ?? "Text")
                    .font(.system(size: 12, weight: .semibold))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: session.state.headingLevel != nil))
        .accessibilityLabel("Paragraph style")
        .accessibilityValue(session.state.headingLevel.map { "Heading \($0)" } ?? "Text")
    }

    private func paragraphChoice(_ title: String, level: Int?) -> some View {
        let active = level == nil ? session.state.blockType == "paragraph" : session.state.headingLevel == level
        return Button { session.exec(level == nil ? .paragraph : .heading, level.map { ["level": $0] } ?? [:]) } label: {
            if active { Label(title, systemImage: "checkmark") }
            else { Text(title) }
        }
    }

    @ViewBuilder private var listGroup: some View {
        formatButton("Bullet list", "list.bullet", .bulletList, active: session.state.bulletList)
        formatButton("Numbered list", "list.number", .orderedList, active: session.state.orderedList)
        formatButton("Outdent list item", "decrease.indent", .outdent).disabled(!session.state.canOutdent)
        formatButton("Indent list item", "increase.indent", .indent).disabled(!session.state.canIndent)
    }

    @ViewBuilder private var insertGroup: some View {
        formatButton("Inline math", "function", .inlineMath, active: session.state.blockType == "inlineMath")
        formatButton("Math block", "x.squareroot", .mathBlock, active: session.state.blockType == "mathBlock")
        Button { session.exec(.codeBlock) } label: {
            Label("Code block", systemImage: "chevron.left.forwardslash.chevron.right")
                .labelStyle(.titleAndIcon)
                .fixedSize()
                .padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: session.state.blockType == "codeBlock"))
        .accessibilityLabel("Code block")
        .accessibilityAddTraits(session.state.blockType == "codeBlock" ? .isSelected : [])
        Button { editingLink = true } label: { Image(systemName: "link") }
            .buttonStyle(FormatButtonStyle(active: mark("link")))
            .accessibilityLabel("Edit link").accessibilityAddTraits(mark("link") ? .isSelected : [])
            .popover(isPresented: $editingLink) {
                linkEditor.padding().presentationCompactAdaptation(.popover)
            }
        Menu {
            if session.state.inTable {
                Button("Add row above") { session.exec(.addRowBefore) }
                Button("Add row below") { session.exec(.addRowAfter) }
                Button("Add column left") { session.exec(.addColumnBefore) }
                Button("Add column right") { session.exec(.addColumnAfter) }
                Button("Toggle header row") { session.exec(.toggleHeaderRow) }
                Button("Merge cells") { session.exec(.mergeCells) }.disabled(!session.state.canMergeCells)
                Button("Split cell") { session.exec(.splitCell) }.disabled(!session.state.canSplitCell)
                Button("Delete row", role: .destructive) { session.exec(.deleteRow) }
                Button("Delete column", role: .destructive) { session.exec(.deleteColumn) }
                Button("Delete table", role: .destructive) { session.exec(.deleteTable) }
            } else {
                Button("Insert table") { session.exec(.insertTable) }
            }
        } label: { Image(systemName: "tablecells") }
            .buttonStyle(FormatButtonStyle(active: session.state.inTable))
            .accessibilityLabel("Table")
        PhotosPicker(selection: $image, matching: .images) { Image(systemName: "photo.badge.plus") }
            .buttonStyle(FormatButtonStyle()).disabled(busy).accessibilityLabel("Insert image")
    }

    @ViewBuilder private var sectionGroup: some View {
        Button { session.exec(.insertSection, ["kind": "sibling"]) } label: { Image(systemName: "text.badge.plus") }
            .buttonStyle(FormatButtonStyle()).accessibilityLabel("New section")
        Button { session.exec(.insertSection, ["kind": "subsection"]) } label: { Image(systemName: "text.insert") }
            .buttonStyle(FormatButtonStyle()).accessibilityLabel("Subsection")
        formatButton(session.state.folded ? "Unfold current section" : "Fold current section",
                     session.state.folded ? "chevron.right" : "chevron.down",
                     session.state.folded ? .unfoldCurrentSection : .foldCurrentSection, active: session.state.folded)
            .disabled(!session.state.folded && !session.state.canFold)
    }

    @ViewBuilder private var clipboardGroup: some View {
        Button { session.clipboard(#selector(UIResponderStandardEditActions.cut(_:))) } label: { Image(systemName: "scissors") }
            .buttonStyle(FormatButtonStyle()).accessibilityLabel("Cut")
        Button { session.clipboard(#selector(UIResponderStandardEditActions.copy(_:))) } label: { Image(systemName: "doc.on.doc") }
            .buttonStyle(FormatButtonStyle()).accessibilityLabel("Copy")
        Button { session.clipboard(#selector(UIResponderStandardEditActions.paste(_:))) } label: { Image(systemName: "doc.on.clipboard") }
            .buttonStyle(FormatButtonStyle()).accessibilityLabel("Paste")
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

    private func paragraph(_ title: String, level: Int?) -> some View {
        let active = level == nil ? session.state.blockType == "paragraph" : session.state.headingLevel == level
        return Button { session.exec(level == nil ? .paragraph : .heading, level.map { ["level": $0] } ?? [:]) } label: {
            Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1).padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: active))
        .accessibilityLabel(level.map { "Heading \($0)" } ?? "Text").accessibilityAddTraits(active ? .isSelected : [])
    }

    private func formatButton(_ title: String, _ symbol: String, _ command: ExecCommand, active: Bool = false) -> some View {
        Button { session.exec(command) } label: { Image(systemName: symbol) }
            .buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
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
