import SwiftUI

struct SectionBreadcrumb: View {
    let module: String
    let path: [SectionCrumb]
    let select: (String?) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            trail(compact: false).fixedSize(horizontal: true, vertical: false)
            trail(compact: true)
        }
        .font(.subheadline)
        .frame(maxWidth: 440)
        .accessibilityElement(children: .contain)
    }

    private func trail(compact: Bool) -> some View {
        HStack(spacing: 5) {
            Button(module) { select(nil) }
                .lineLimit(1).truncationMode(.middle).layoutPriority(1)
                .accessibilityLabel("Show whole note: \(module)")
            if compact && path.count > 1 {
                separator
                Menu {
                    ForEach(path.dropLast()) { crumb in
                        Button(crumb.title) { select(crumb.id) }
                    }
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("Ancestor sections")
            }
            ForEach(compact ? Array(path.suffix(1)) : path) { crumb in
                separator
                Button(crumb.title) { select(crumb.id) }
                    .lineLimit(1).truncationMode(.middle)
                    .layoutPriority(crumb.id == path.last?.id ? 2 : 0)
                    .fontWeight(crumb.id == path.last?.id ? .semibold : .regular)
            }
        }
        .buttonStyle(.plain)
    }

    private var separator: some View {
        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
    }
}
