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
            // Expand the hit target without enlarging the visible 30pt control.
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

    private var rowWidth: CGFloat { max(36, maximumWidth - 8) }

    var body: some View {
        TouchScrollingRow {
            buttons.fixedSize(horizontal: true, vertical: false)
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

    private var buttons: some View {
        HStack(spacing: 0) {
            // Keep cloze creation visible without scrolling, including in a narrow window.
            Button { session.exec(session.state.inCloze ? "removeCard" : "makeCard") } label: {
                Label("Cloze",
                      systemImage: session.state.inCloze ? "rectangle.stack.badge.minus" : "rectangle.stack.badge.plus")
                    .labelStyle(.titleAndIcon)
                    .fixedSize()
                    .padding(.horizontal, 4)
            }
            .buttonStyle(FormatButtonStyle(active: session.state.inCloze))
            .disabled(!session.state.inCloze && !session.state.canMakeCard)
            .accessibilityLabel(session.state.inCloze ? "Remove cloze" : "Make cloze from selection")
            .accessibilityAddTraits(session.state.inCloze ? .isSelected : [])
            divider
            formatButton("Bold", "bold", "bold", active: mark("bold"))
            formatButton("Italic", "italic", "italic", active: mark("italic"))
            formatButton("Underline", "underline", "underline", active: mark("underline"))
            formatButton("Bullet list", "list.bullet", "bulletList", active: session.state.bulletList)
            formatButton("Inline math", "function", "inlineMath", active: session.state.blockType == "inlineMath")
            divider
            Button { session.clipboard(#selector(UIResponderStandardEditActions.paste(_:))) } label: { Image(systemName: "doc.on.clipboard") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Paste")
            Button { session.clipboard(#selector(UIResponderStandardEditActions.copy(_:))) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Copy")
            Button { session.clipboard(#selector(UIResponderStandardEditActions.cut(_:))) } label: { Image(systemName: "scissors") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Cut")
            divider
            ForEach(1...6, id: \.self) { level in paragraph("H\(level)", level: level) }
            paragraph("Text", level: nil)
            divider
            formatButton("Strikethrough", "strikethrough", "strike", active: mark("strike"))
            formatButton("Code", "chevron.left.forwardslash.chevron.right", "code", active: mark("code"))
            divider
            formatButton("Numbered list", "list.number", "orderedList", active: session.state.orderedList)
            formatButton("Quote", "text.quote", "blockquote", active: session.state.blockquote)
            Button { session.exec("codeBlock") } label: {
                Label("Code block", systemImage: "chevron.left.forwardslash.chevron.right")
                    .labelStyle(.titleAndIcon)
                    .fixedSize()
                    .padding(.horizontal, 4)
            }
            .buttonStyle(FormatButtonStyle(active: session.state.blockType == "codeBlock"))
            .accessibilityLabel("Code block")
            .accessibilityAddTraits(session.state.blockType == "codeBlock" ? .isSelected : [])
            divider
            formatButton("Math block", "x.squareroot", "mathBlock", active: session.state.blockType == "mathBlock")
            Button { editingLink = true } label: { Image(systemName: "link") }
                .buttonStyle(FormatButtonStyle(active: mark("link")))
                .accessibilityLabel("Edit link").accessibilityAddTraits(mark("link") ? .isSelected : [])
                .popover(isPresented: $editingLink) {
                    linkEditor.padding().presentationCompactAdaptation(.popover)
                }
            PhotosPicker(selection: $image, matching: .images) { Image(systemName: "photo.badge.plus") }
                .buttonStyle(FormatButtonStyle()).disabled(busy).accessibilityLabel("Insert image")
            divider
            Button { session.exec("insertSection", ["kind": "sibling"]) } label: { Image(systemName: "text.badge.plus") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("New section")
            Button { session.exec("insertSection", ["kind": "subsection"]) } label: { Image(systemName: "text.insert") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Subsection")
            formatButton("Indent list item", "increase.indent", "indent").disabled(!session.state.canIndent)
            formatButton("Outdent list item", "decrease.indent", "outdent").disabled(!session.state.canOutdent)
            formatButton(session.state.folded ? "Unfold current section" : "Fold current section",
                         session.state.folded ? "chevron.right" : "chevron.down",
                         session.state.folded ? "unfoldCurrentSection" : "foldCurrentSection", active: session.state.folded)
                .disabled(!session.state.folded && !session.state.canFold)
            divider
            // Offer joining only when the selection spans separate clozes.
            if session.state.canJoinClozes {
                formatButton("Join clozes", "rectangle.stack", "joinClozes")
            }
            divider
            Button { session.web.endEditing(true) } label: { Image(systemName: "keyboard.chevron.compact.down") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Hide keyboard")
        }
    }

    private var linkEditor: some View {
        HStack {
            // Merely opening this popover leaves the editor's selection intact.
            TextField("Link URL", text: $link)
                .textFieldStyle(.roundedBorder).keyboardType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .frame(width: 200, height: 44).accessibilityLabel("Link URL")
            Button("Apply") {
                Task {
                    _ = try? await session.run("window.memnoterEditor.exec('link', {href}); return window.memnoterEditor.focus()", ["href": link])
                    editingLink = false
                }
            }
            .buttonStyle(FormatButtonStyle())
            .accessibilityLabel(link.isEmpty ? "Remove link" : "Apply link")
            .disabled(!link.isEmpty && URL(string: link)?.scheme == nil)
        }
    }

    private var divider: some View { Divider().frame(height: 16).padding(.horizontal, 3) }
    private func mark(_ name: String) -> Bool { session.state.marks.contains(name) }

    private func paragraph(_ title: String, level: Int?) -> some View {
        let active = level == nil ? session.state.blockType == "paragraph" : session.state.headingLevel == level
        return Button { session.exec(level == nil ? "paragraph" : "heading", level.map { ["level": $0] } ?? [:]) } label: {
            Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1).padding(.horizontal, 4)
        }
        .buttonStyle(FormatButtonStyle(active: active))
        .accessibilityLabel(level.map { "Heading \($0)" } ?? "Text").accessibilityAddTraits(active ? .isSelected : [])
    }

    private func formatButton(_ title: String, _ symbol: String, _ command: String, active: Bool = false) -> some View {
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
