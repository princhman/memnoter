import SwiftUI

/// One navigation slot for entering focus and returning to the whole note.
struct SectionFocusControl: View {
    @Bindable var session: WebSession
    let moduleName: String
    let compact: Bool

    private var title: String {
        session.state.focusedSectionPath.last?.title
            ?? session.headings.first { $0.id == session.state.focusedSectionId }?.text
            ?? "Focused section"
    }

    var body: some View {
        Group {
            if session.state.focusedSectionId != nil {
                HStack(spacing: 0) {
                    if !compact {
                        Menu {
                            Button(moduleName, systemImage: "doc.text") { session.exec("showDocument") }
                            ForEach(session.state.focusedSectionPath.dropLast()) { crumb in
                                Button(crumb.title) { session.exec("focusSection", ["id": crumb.id]) }
                            }
                        } label: {
                            Text(title)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .frame(maxWidth: 140)
                                .padding(.leading, 12)
                                .frame(minHeight: 44)
                        }
                        .accessibilityLabel("Focused section: \(title). Ancestor sections")
                    }
                    Button { session.exec("showDocument") } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Show whole note")
                    .help("Show whole note")
                }
            } else if session.state.focusableSection != nil {
                Button { session.exec("focusCurrentSection") } label: {
                    if compact {
                        Image(systemName: "scope").frame(width: 44, height: 44)
                    } else {
                        Label("Focus", systemImage: "scope")
                            .labelStyle(.titleAndIcon)
                            .font(.subheadline)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                    }
                }
                .accessibilityLabel("Focus on this section")
            }
        }
        .foregroundStyle(.primary)
        .tint(.primary)
    }
}
