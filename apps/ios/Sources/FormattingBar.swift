import SwiftUI

struct FormatButtonStyle: ButtonStyle {
    var active = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(Color.primary)
            .background(Color(uiColor: .tertiarySystemFill).opacity(active || configuration.isPressed ? 1 : 0), in: RoundedRectangle(cornerRadius: 12))
            .opacity(configuration.isPressed ? 0.65 : 1)
            .contentShape(Rectangle())
    }
}

struct FormattingBar: View {
    @Bindable var session: WebSession
    let maximumWidth: CGFloat
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
            paragraph("Title", level: 1)
            paragraph("Heading", level: 2)
            paragraph("Subheading", level: 3)
            paragraph("Body", level: nil)
            divider
            formatButton("Strikethrough", "strikethrough", "strike", active: mark("strike"))
            formatButton("Code", "chevron.left.forwardslash.chevron.right", "code", active: mark("code"))
            formatButton("Numbered list", "list.number", "orderedList", active: session.state.orderedList)
            formatButton("Quote", "text.quote", "blockquote", active: session.state.blockquote)
            formatButton("Math block", "x.squareroot", "mathBlock", active: session.state.blockType == "mathBlock")
            Button { editingLink.toggle() } label: { Image(systemName: "link") }
                .buttonStyle(FormatButtonStyle(active: mark("link")))
                .accessibilityLabel("Edit link").accessibilityAddTraits(mark("link") ? .isSelected : [])
            formatButton("Make card from selection", "rectangle.stack.badge.plus", "makeCard")
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
        .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
    }

    private func formatButton(_ title: String, _ symbol: String, _ command: String, active: Bool = false) -> some View {
        Button { session.exec(command) } label: { Image(systemName: symbol) }
            .buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
    }
}
