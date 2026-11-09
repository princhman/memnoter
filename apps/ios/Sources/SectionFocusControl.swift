import SwiftUI

// The phone title owns scope without adding another row above the editor.
struct PhoneNoteTitle: View {
    let session: WebSession
    let moduleName: String
    let showContents: () -> Void

    private var focused: Bool { session.state.focusedSectionId != nil }
    private var title: String {
        guard focused else { return moduleName }
        return session.state.focusedSectionPath.last?.title
            ?? session.headings.first { $0.id == session.state.focusedSectionId }?.text
            ?? "Section"
    }

    private var titleLabel: some View {
        HStack(spacing: 4) {
            Text(title).font(.headline).lineLimit(1).truncationMode(.tail)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: showContents) { titleLabel }
            .accessibilityHint("Open contents")
            .buttonStyle(.plain)
            .accessibilityIdentifier("module.title")
            .accessibilityLabel(title)
            .accessibilityValue(focused ? "Focused section" : "Whole note")
            if focused {
                Button { session.exec(.showDocument) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sectionFocus.clear")
                .accessibilityLabel("Show whole note")
            }
        }
        .foregroundStyle(.primary)
    }
}
