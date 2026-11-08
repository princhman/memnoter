import SwiftUI

struct ReviewView: View {
    let client: CoreClient
    let directory: URL
    let moduleId: String?
    let preferences: UserDefaults
    let editCard: (String, String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var toolbarWidth: CGFloat = 0
    @State private var controlsWidth: CGFloat = 0
    @AppStorage("skipCardsCreatedToday") private var skipCardsCreatedToday = false
    @State private var session: WebSession?
    private var state: ReviewState { session?.reviewState ?? ReviewState() }
    private var revealed: Bool { state.revealed }
    private var busy: Bool { state.busy || state.loading }
    private var intervals: [String] { state.intervals }
    var body: some View {
        VStack {
            if let error = session?.error { Text(error).foregroundStyle(.red).padding() }
            if let session {
                WebSurface(session: session)
                if state.hasCard { ratingControls }
                else if state.canShowNow {
                    Button("Show now") { command(.showNow) }.keyboardShortcut(.space, modifiers: [])
                }
            }

        }
        .background(Color(uiColor: .systemBackground))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { toolbarWidth = $0 }
        .toolbar {
            // Break the shared glass background after RootView's sidebar control.
            if #available(iOS 26.0, *), horizontalSizeClass != .compact {
                ToolbarSpacer(.fixed, placement: .topBarLeading)
            }
            ToolbarItemGroup(placement: horizontalSizeClass == .compact ? .topBarTrailing : .topBarLeading) {
                Button("Undo", systemImage: "arrow.uturn.backward") { undo() }
                    .disabled(!state.canUndo || busy).keyboardShortcut("z")
                    .padding(.leading, legacyToolbarSpacing)
                Button("Redo", systemImage: "arrow.uturn.forward") { redo() }
                    .disabled(!state.canRedo || busy).keyboardShortcut("z", modifiers: [.command, .shift])
                if toolbarWidth < 700 {
                    Menu { cardActions } label: { Label("Card actions", systemImage: "ellipsis") }
                        .disabled(!state.hasCard || busy)
                } else {
                    cardActions
                }
            }
            if #available(iOS 26.0, *), horizontalSizeClass == .compact {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
            if #available(iOS 26.0, *) {
                // Plain numbers, without the glass capsule toolbar items get by default.
                ToolbarItem(placement: .topBarTrailing) { countsLabel }
                    .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarTrailing) { countsLabel }
            }
        }
        .task {
            let web = WebSession(client: client, directory: directory, entry: BridgeProtocol.reviewEntry, preferences: preferences)
            web.onReady = { command(.load, ["scope": moduleId as Any? ?? NSNull()], parameters: ["scope"]) }
            session = web
        }
        .onChange(of: skipCardsCreatedToday) { _, _ in Task { await session?.updateCardPreference() } }
        .onChange(of: moduleId) { _, _ in command(.load, ["scope": moduleId as Any? ?? NSNull()], parameters: ["scope"]) }
        .onDisappear { session?.dispose() }
    }
    private var legacyToolbarSpacing: CGFloat {
        if #available(iOS 26.0, *) { return 0 }
        return 16 // Older navigation bars have no shared glass; leave a visible gap.
    }
    @ViewBuilder private var cardActions: some View {
        Button("Edit card", systemImage: "pencil", action: editCurrentCard).disabled(!state.hasCard || busy)
        Button("Go to card in note", systemImage: "scope", action: editCurrentCard).disabled(!state.hasCard || busy)
    }
    private func editCurrentCard() {
        if let moduleId = state.moduleId, let cardId = state.cardId { editCard(moduleId, cardId) }
    }
    private var countsLabel: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            countLabel(state.counts.new, later: state.laterToday.new, current: state.currentKind == "new", index: 0)
            countLabel(state.counts.learning, later: state.laterToday.learning, current: state.currentKind == "learning", index: 1)
            countLabel(state.counts.review, later: state.laterToday.review, current: state.currentKind == "review", index: 2)
        }
        .font(.system(size: 14)).monospacedDigit()
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.countsLabel)
        .accessibilityIdentifier("review.counts")
    }
    private func countLabel(_ count: Int, later: Int, current: Bool, index: Int) -> some View {
        let rgb = (colorScheme == .dark ? ReviewPalette.countsDark : ReviewPalette.countsLight)[index]
        return HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text(count.formatted(.number.grouping(.never)))
                .fontWeight(current ? .bold : .regular).underline(current)
                .opacity(count > 0 ? 1 : 0.4)
            if later > 0 {
                Text("+\(later)").font(.system(size: 9)).baselineOffset(5).opacity(0.7)
            }
        }
        .foregroundStyle(Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255))
    }
    private let gradeTitles = ["Again", "Hard", "Good", "Easy"]
    private func color(_ rgb: Int) -> Color {
        Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
    private func gradeText(_ index: Int) -> Color {
        color((colorScheme == .dark ? ReviewPalette.gradesDark : ReviewPalette.gradesLight)[index])
    }
    private var ratingControls: some View {
        GeometryReader { geometry in
            let columns = geometry.size.width < 640 ? 2 : 4
            if revealed {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
                    ForEach(0..<4) { index in
                        Button { rate(index + 1) } label: {
                            HStack(spacing: 6) {
                                Text(gradeTitles[index])
                                if intervals.count == 4 { Text("(\(intervals[index]))").fontWeight(.regular).opacity(0.7).monospacedDigit() }
                            }
                            .font(.system(size: 14, weight: .medium))
                            .frame(maxWidth: .infinity).frame(height: 48)
                            .foregroundStyle(gradeText(index))
                            .background(color(ReviewPalette.gradesTint[index]).opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                            .contentShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [])
                    }
                }
            } else {
                Button { reveal() } label: {
                    Text("Show answer").font(.system(size: 14, weight: .medium))
                        .frame(maxWidth: .infinity).frame(height: 48)
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .background(Color.primary, in: RoundedRectangle(cornerRadius: 12))
                }.keyboardShortcut(.space, modifiers: [])
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { controlsWidth = $0 }
        .frame(height: revealed && controlsWidth < 640 ? 104 : 48)
        .buttonStyle(.plain).disabled(busy)
        .padding(.horizontal, 16).padding(.vertical, 8)
    }
    func reveal() { command(.reveal) }
    func rate(_ rating: Int) { command(.rate, ["grade": rating], parameters: ["grade"]) }
    func undo() { command(.undo) }
    func redo() { command(.redo) }
    private func command(_ method: ReviewApiMethod, _ args: [String: Any] = [:], parameters: [String] = []) {
        guard let session, session.ready else { return }
        Task {
            do { _ = try await session.callReview(method, args, parameters: parameters) }
            catch { session.error = String(describing: error) }
        }
    }
}
