import SwiftUI

struct ContentsPopover: View {
    let session: WebSession
    let select: (Heading) -> Void
    @ScaledMetric(relativeTo: .body) private var rowHeight = 44
    private var minLevel: Int { session.headings.map(\.level).min() ?? 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Contents")
                .font(.headline)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 10)
            if session.headings.isEmpty {
                ContentUnavailableView("No headings", systemImage: "text.alignleft", description: Text("Add headings to navigate this note."))
                    .frame(height: 210)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(session.headings) { heading in
                                let current = heading.id == session.currentHeadingId
                                Button { select(heading) } label: {
                                    HStack(spacing: 10) {
                                        if let number = heading.number {
                                            Text(number).monospacedDigit().foregroundStyle(.secondary)
                                        }
                                        Text(heading.text.isEmpty ? "Untitled section" : heading.text)
                                            .fontWeight(heading.level == 1 ? .medium : .regular)
                                            .foregroundStyle(current ? Color.accentColor : heading.level == 1 ? Color.primary : Color.secondary)
                                            .lineLimit(1).truncationMode(.tail)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        if heading.folded {
                                            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                                        }
                                    }
                                    .font(.body)
                                    .padding(.leading, 12 + CGFloat(heading.level - minLevel) * 12)
                                    .padding(.trailing, 12)
                                    .frame(minHeight: rowHeight)
                                    .contentShape(Rectangle())
                                    .background(current ? Color.accentColor.opacity(0.07) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(current ? .isSelected : [])
                                .id(heading.id)
                            }
                        }
                        .padding(.horizontal, 8)
                    }
                    .frame(height: min(CGFloat(session.headings.count) * rowHeight, 440))
                    .onAppear { if let id = session.currentHeadingId { proxy.scrollTo(id, anchor: .center) } }
                    .onChange(of: session.currentHeadingId) { _, id in
                        if let id { proxy.scrollTo(id, anchor: .center) }
                    }
                }
            }
        }
        .padding(.bottom, 10)
        .frame(idealWidth: 340, maxWidth: 360)
        .presentationBackground(.regularMaterial)
        .presentationCompactAdaptation(.sheet)
        .presentationDetents([.medium, .large])
        .onAppear { session.trackOutline(true) }
        .onDisappear { session.trackOutline(false) }
    }
}
