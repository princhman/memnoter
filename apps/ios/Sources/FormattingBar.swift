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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showStyles = false
    @State private var stylesWidth: CGFloat = 650
    @State private var scrollOffset: CGFloat = 0
    @State private var editingLink = false
    @State private var link = ""

    private var availableRowWidth: CGFloat { max(44, maximumWidth - 58) }
    private var rowWidth: CGFloat { min(stylesWidth, availableRowWidth) }
    private var overflowing: Bool { stylesWidth > availableRowWidth + 1 }

    var body: some View {
        Group {
            if showStyles {
                HStack(spacing: 2) {
                    Button { swapStyles() } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(FormatButtonStyle()).accessibilityLabel("Back to basic formatting")
                    ScrollViewReader { scroll in
                        ScrollView(.horizontal) {
                            expandedButtons
                                .fixedSize(horizontal: true, vertical: false)
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("formatStyles")) } action: { frame in
                                    stylesWidth = frame.width
                                    scrollOffset = max(0, -frame.minX)
                                }
                        }
                        .onChange(of: stylesWidth) { _, _ in
                            if editingLink {
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) {
                                    scroll.scrollTo("applyLink", anchor: .trailing)
                                }
                            }
                        }
                        .coordinateSpace(name: "formatStyles")
                        .scrollIndicators(.hidden)
                        .frame(width: rowWidth, height: 44)
                        .mask {
                            HStack(spacing: 0) {
                                LinearGradient(colors: [scrollOffset > 1 ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing).frame(width: 14)
                                Rectangle()
                                LinearGradient(colors: [.black, overflowing && scrollOffset + rowWidth < stylesWidth - 1 ? .clear : .black], startPoint: .leading, endPoint: .trailing).frame(width: 14)
                            }
                        }
                    }
                }
                .transition(.opacity)
            } else {
                HStack(spacing: 2) {
                    Button { swapStyles() } label: { Image(systemName: "textformat") }
                        .buttonStyle(FormatButtonStyle()).accessibilityLabel("Text styles")
                    formatButton("Bold", "bold", "bold", active: mark("bold"))
                    formatButton("Italic", "italic", "italic", active: mark("italic"))
                    formatButton("Underline", "underline", "underline", active: mark("underline"))
                    formatButton("Bullet list", "list.bullet", "bulletList", active: session.state.bulletList)
                    formatButton("Inline math", "function", "inlineMath", active: session.state.blockType == "inlineMath")
                    divider
                    Button { session.web.endEditing(true) } label: { Image(systemName: "keyboard.chevron.compact.down") }
                        .buttonStyle(FormatButtonStyle()).accessibilityLabel("Hide keyboard")
                }
                .fixedSize()
                .transition(.opacity)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: Capsule())
        .overlay { Capsule().strokeBorder(.primary.opacity(0.08)) }
        .shadow(color: .black.opacity(0.14), radius: 12, y: 4)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: showStyles)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: editingLink)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: stylesWidth)
        .accessibilityElement(children: .contain)
    }

    private var expandedButtons: some View {
        HStack(spacing: 2) {
            ForEach(1...6, id: \.self) { level in paragraph("H\(level)", level: level) }
            paragraph("Text", level: nil)
            divider
            formatButton("Strikethrough", "strikethrough", "strike", active: mark("strike"))
            formatButton("Code", "chevron.left.forwardslash.chevron.right", "code", active: mark("code"))
            divider
            formatButton("Code block", "curlybraces", "codeBlock", active: session.state.blockType == "codeBlock")
            formatButton("Numbered list", "list.number", "orderedList", active: session.state.orderedList)
            formatButton("Quote", "text.quote", "blockquote", active: session.state.blockquote)
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
            PhotosPicker(selection: $image, matching: .images) { Image(systemName: "photo.badge.plus") }
                .buttonStyle(FormatButtonStyle()).disabled(busy).accessibilityLabel("Insert image")
            formatButton("Math block", "x.squareroot", "mathBlock", active: session.state.blockType == "mathBlock")
            Button { editingLink.toggle() } label: { Image(systemName: "link") }
                .buttonStyle(FormatButtonStyle(active: mark("link")))
                .accessibilityLabel("Edit link").accessibilityAddTraits(mark("link") ? .isSelected : [])
            if editingLink {
                // Opening URL entry leaves the editor focused. ProseMirror retains
                // its selection if the user then taps the field inside the capsule.
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
                .id("applyLink")
                .accessibilityLabel(link.isEmpty ? "Remove link" : "Apply link")
                .disabled(!link.isEmpty && URL(string: link)?.scheme == nil)
            }
            if session.state.inCloze || session.state.canMakeCard || session.state.canJoinClozes {
                divider
                if session.state.inCloze {
                    formatButton("Remove card", "rectangle.stack.badge.minus", "removeCard", active: true)
                } else if session.state.canMakeCard {
                    formatButton("Make card from selection", "rectangle.stack.badge.plus", "makeCard")
                }
                if session.state.canJoinClozes {
                    formatButton("Join clozes", "rectangle.stack", "joinClozes")
                }
            }
        }
    }

    private var divider: some View { Divider().frame(height: 24).padding(.horizontal, 4) }
    private func mark(_ name: String) -> Bool { session.state.marks.contains(name) }
    private func swapStyles() { showStyles.toggle(); editingLink = false }

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
