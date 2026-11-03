import SwiftUI
import PhotosUI

struct FormatButtonStyle: ButtonStyle {
    var active = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(Color.primary)
            .background(Color(uiColor: .tertiarySystemFill).opacity(active || configuration.isPressed ? 1 : 0), in: RoundedRectangle(cornerRadius: 12))
            .opacity(isEnabled ? (configuration.isPressed ? 0.65 : 1) : 0.35)
            .contentShape(Rectangle())
    }
}

struct FormattingBar: View {
    @Bindable var session: WebSession
    let maximumWidth: CGFloat
    @Binding var image: PhotosPickerItem?
    let busy: Bool
    @State private var contentWidth: CGFloat = 0
    @State private var scrollOffset: CGFloat = 0
    @State private var editingLink = false
    @State private var link = ""

    private var rowWidth: CGFloat { max(44, maximumWidth - 12) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            buttons
                .fixedSize(horizontal: true, vertical: false)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("formattingRow")) } action: { frame in
                    contentWidth = frame.width
                    scrollOffset = max(0, -frame.minX)
                }
        }
        .coordinateSpace(name: "formattingRow")
        .scrollIndicators(.visible)
        .frame(width: rowWidth, height: 50)
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [scrollOffset > 1 ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing).frame(width: 14)
                Rectangle()
                LinearGradient(colors: [.black, scrollOffset + rowWidth < contentWidth - 1 ? .clear : .black], startPoint: .leading, endPoint: .trailing).frame(width: 14)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: Capsule())
        // The decorative shape covers the scroll viewport. It must not become
        // the hit-test target ahead of the row's pan recognizer and buttons.
        .overlay { Capsule().strokeBorder(.primary.opacity(0.08)).allowsHitTesting(false) }
        .shadow(color: .black.opacity(0.14), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
    }

    private var buttons: some View {
        HStack(spacing: 2) {
            // Keep frequent actions within the first 230pt, even in a narrow window.
            formatButton("Bold", "bold", "bold", active: mark("bold"))
            formatButton("Italic", "italic", "italic", active: mark("italic"))
            formatButton("Underline", "underline", "underline", active: mark("underline"))
            formatButton("Bullet list", "list.bullet", "bulletList", active: session.state.bulletList)
            formatButton("Inline math", "function", "inlineMath", active: session.state.blockType == "inlineMath")
            divider
            ForEach(1...6, id: \.self) { level in paragraph("H\(level)", level: level) }
            paragraph("Text", level: nil)
            divider
            formatButton("Strikethrough", "strikethrough", "strike", active: mark("strike"))
            formatButton("Code", "chevron.left.forwardslash.chevron.right", "code", active: mark("code"))
            divider
            formatButton("Numbered list", "list.number", "orderedList", active: session.state.orderedList)
            formatButton("Quote", "text.quote", "blockquote", active: session.state.blockquote)
            formatButton("Code block", "curlybraces", "codeBlock", active: session.state.blockType == "codeBlock")
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
            // Only this trailing group is contextual; earlier action positions stay fixed.
            if session.state.inCloze {
                formatButton("Remove card", "rectangle.stack.badge.minus", "removeCard", active: true)
            } else {
                formatButton("Make card from selection", "rectangle.stack.badge.plus", "makeCard")
                    .disabled(!session.state.canMakeCard)
            }
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

    private var divider: some View { Divider().frame(height: 24).padding(.horizontal, 4) }
    private func mark(_ name: String) -> Bool { session.state.marks.contains(name) }

    private func paragraph(_ title: String, level: Int?) -> some View {
        let active = level == nil ? session.state.blockType == "paragraph" : session.state.headingLevel == level
        return Button { session.exec(level == nil ? "paragraph" : "heading", level.map { ["level": $0] } ?? [:]) } label: {
            Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1).padding(.horizontal, 8)
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
