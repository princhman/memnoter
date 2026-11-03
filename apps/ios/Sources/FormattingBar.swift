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
    let panelHeight: CGFloat
    let panelWidth: CGFloat
    @State private var showStyles = false
    var body: some View {
        HStack(spacing: 2) {
            Button { showStyles.toggle() } label: { Image(systemName: "textformat") }
                .buttonStyle(FormatButtonStyle(active: showStyles)).accessibilityLabel("Text styles")
            formatButton("Bold", "bold", "bold", active: session.state.marks.contains("bold"))
            formatButton("Italic", "italic", "italic", active: session.state.marks.contains("italic"))
            formatButton("Underline", "underline", "underline", active: session.state.marks.contains("underline"))
            formatButton("Bullet list", "list.bullet", "bulletList", active: session.state.bulletList)
            formatButton("Inline math", "function", "inlineMath", active: session.state.blockType == "inlineMath")
            Divider().frame(height: 24).padding(.horizontal, 4)
            Button { session.web.endEditing(true) } label: { Image(systemName: "keyboard.chevron.compact.down") }
                .buttonStyle(FormatButtonStyle()).accessibilityLabel("Hide keyboard")
        }.padding(6)
        .overlay(alignment: .bottomTrailing) {
            if showStyles {
                FormatPanel(session: session, maximumHeight: panelHeight, width: panelWidth, close: { showStyles = false }).padding(.bottom, 68)
            }
        }

    }

    func formatButton(_ title: String, _ symbol: String, _ command: String, active: Bool = false, args: [String: Any] = [:]) -> some View {
        Button { session.exec(command, args) } label: { Image(systemName: symbol) }
            .buttonStyle(FormatButtonStyle(active: active))
            .accessibilityLabel(title)
            .accessibilityAddTraits(active ? .isSelected : [])
    }
}
