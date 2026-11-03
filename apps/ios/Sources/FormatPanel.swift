import SwiftUI

/// Nonmodal anchored popover: presenting a separate controller can resign the
/// WKWebView first responder. These buttons leave its selection and keyboard intact.
struct FormatPanel: View {
    @Bindable var session: WebSession
    let maximumHeight: CGFloat
    let width: CGFloat
    let close: () -> Void
    @State private var editingLink = false
    @State private var link = ""
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Format").font(.headline)
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }
                    .buttonStyle(FormatButtonStyle()).accessibilityLabel("Close text styles")
            }
            HStack(spacing: 4) {
                paragraph("Title", level: 1)
                paragraph("Heading", level: 2)
                paragraph("Subheading", level: 3)
                paragraph("Body", level: nil)
            }
            Divider()
            HStack(spacing: 12) {
                action("Bold", "bold", "bold", active: mark("bold"))
                action("Italic", "italic", "italic", active: mark("italic"))
                action("Underline", "underline", "underline", active: mark("underline"))
                action("Strikethrough", "strikethrough", "strike", active: mark("strike"))
                action("Code", "chevron.left.forwardslash.chevron.right", "code", active: mark("code"))
            }
            Divider()
            HStack(spacing: 8) {
                action("Bullets", "list.bullet", "bulletList", active: session.state.bulletList, caption: true)
                action("Numbers", "list.number", "orderedList", active: session.state.orderedList, caption: true)
                action("Quote", "text.quote", "blockquote", active: session.state.blockquote, caption: true)
            }
            HStack(spacing: 8) {
                action("Inline math", "function", "inlineMath", active: session.state.blockType == "inlineMath", caption: true)
                action("Math block", "x.squareroot", "mathBlock", active: session.state.blockType == "mathBlock", caption: true)
                Button { editingLink.toggle() } label: {
                    VStack(spacing: 4) { Image(systemName: "link"); Text("Link").font(.caption) }.frame(maxWidth: .infinity)
                }.buttonStyle(FormatButtonStyle(active: mark("link"))).accessibilityLabel("Edit link")
            }
            if editingLink {
                HStack {
                    TextField("https://example.com", text: $link)
                        .textFieldStyle(.roundedBorder).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Link URL")
                    Button("Apply") {
                        // The editor retains its ProseMirror selection while entering a URL.
                        Task {
                            _ = try? await session.run("window.memnoterEditor.exec('link', {href}); return window.memnoterEditor.focus()", ["href": link])
                            editingLink = false
                        }
                    }.disabled(!link.isEmpty && URL(string: link)?.scheme == nil)
                }
                Text("Leave empty to remove the link.").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            Button { session.exec("makeCard") } label: { Label("Make card from selection", systemImage: "rectangle.stack.badge.plus") }
                .font(.subheadline).foregroundStyle(.primary).buttonStyle(.plain).frame(minHeight: 44)
        }
        .padding(12)
        }
        .frame(width: width, height: min(350, maximumHeight))
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
        .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(.primary.opacity(0.08)) }
        .shadow(color: .black.opacity(0.18), radius: 20, y: 6)
        .accessibilityElement(children: .contain)
    }
    private func mark(_ name: String) -> Bool { session.state.marks.contains(name) }
    private func paragraph(_ title: String, level: Int?) -> some View {
        let active = level == nil ? session.state.blockType == "paragraph" : session.state.headingLevel == level
        return Button { session.exec(level == nil ? "paragraph" : "heading", level.map { ["level": $0] } ?? [:]) } label: {
            Text(title).font(.system(size: 13, weight: .semibold))
                .lineLimit(1).minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity, minHeight: 44)
        }.buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
    }
    private func action(_ title: String, _ symbol: String, _ command: String, active: Bool, caption: Bool = false) -> some View {
        Button { session.exec(command) } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                if caption { Text(title).font(.caption) }
            }.frame(maxWidth: .infinity)
        }.buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : [])
    }
}
