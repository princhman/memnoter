import SwiftUI

struct HomeView: View {
    let modules: [NoteModule]
    let recentModules: [NoteModule]
    let newModule: () -> Void
    let openModule: (String) -> Void

    private let shortcuts = BridgeProtocol.homeShortcuts

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                VStack(spacing: 12) {
                    Image("BrandMark")
                        .resizable()
                        .frame(width: 64, height: 64)
                        .clipShape(.rect(cornerRadius: 16))
                        .accessibilityHidden(true)
                    VStack(spacing: 4) {
                        Text("Memnoter")
                            .font(.title2.weight(.semibold))
                        Text(modules.isEmpty
                             ? "Create your first module to start taking notes."
                             : "Pick up where you left off, or start something new.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Button(action: newModule) {
                        Label("New module", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                }

                if !recentModules.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        sectionTitle("Recent")
                        ForEach(recentModules) { module in
                            Button { openModule(module.id) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "doc.text")
                                        .foregroundStyle(.secondary)
                                    Text(module.name)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .font(.subheadline)
                                .padding(.horizontal, 8)
                                .frame(minHeight: 44)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .hoverEffect(.highlight)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    sectionTitle("Shortcuts")
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        ForEach(shortcuts, id: \.action) { shortcut in
                            GridRow(alignment: .firstTextBaseline) {
                                Text(shortcut.keys).font(.caption).fixedSize()
                                Text(shortcut.action).font(.subheadline)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                }
            }
            .frame(maxWidth: 448)
            .padding(.horizontal, 24)
            .padding(.vertical, 48)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .accessibilityAddTraits(.isHeader)
    }
}
