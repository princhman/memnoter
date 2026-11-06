import SwiftUI

// Rich segments, KaTeX and image masks share the desktop renderer and scheduler.
// Native models validate scheduling fields; rich face segments use Codable JSON.
struct ReviewView: View {
    let client: CoreClient
    let directory: URL
    let moduleId: String?
    let editCard: (StoredCard) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var toolbarWidth: CGFloat = 0
    @State private var reviewCounts = ReviewCounts()
    @State private var controlsWidth: CGFloat = 0
    @State private var intervals: [String] = []
    @AppStorage("skipCardsCreatedToday") private var skipCardsCreatedToday = false
    @State private var loadedCutoff: Int64?
    private var createdAtCutoff: Int64? {
        skipCardsCreatedToday ? Int64(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000) : nil
    }
    @State private var session: WebSession?
    @State private var cards: [StoredCard] = []
    @State private var revealed = false
    @State private var busy = false
    @State private var error: String?
    struct GradeStep {
        let card: StoredCard
        let result: ReviewResult
        let queueBefore: [StoredCard]
        let queueAfter: [StoredCard]
    }
    @State private var undoSteps: [GradeStep] = []
    @State private var redoSteps: [GradeStep] = []
    @State private var syncPending = false
    var body: some View {
        VStack {
            if let error { Text(error).foregroundStyle(.red).padding() }
            if let card = cards.first, let session {
                Text(card.moduleName).font(.caption).foregroundStyle(.secondary)
                WebSurface(session: session)
                ratingControls

            } else { ContentUnavailableView("All caught up", systemImage: "checkmark.circle", description: Text("No cards are due.")) }
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
                    .disabled(undoSteps.isEmpty || busy).keyboardShortcut("z")
                    .padding(.leading, legacyToolbarSpacing)
                Button("Redo", systemImage: "arrow.uturn.forward") { redo() }
                    .disabled(redoSteps.isEmpty || busy).keyboardShortcut("z", modifiers: [.command, .shift])
                if toolbarWidth < 700 {
                    Menu { cardActions } label: { Label("Card actions", systemImage: "ellipsis") }
                        .disabled(cards.isEmpty || busy)
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
            let web = WebSession(client: client, directory: directory, entry: "review-native.html")
            web.onReady = { show() }
            session = web
            await load()
        }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if !busy {
                    if cards.isEmpty || loadedCutoff != createdAtCutoff { await load() }
                    else { await refreshCounts() }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { _ in
            syncPending = true
            if !busy { Task { await applyPendingSync() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .cardsDidChange)) { _ in
            // Keep the card being answered; each rating reloads the queue anyway.
            if !busy { Task { if cards.isEmpty { await load() } else { await refreshCounts() } } }
        }
        .onChange(of: skipCardsCreatedToday) { _, _ in Task { if !busy { await load() } } }
        .onDisappear { session?.dispose() }
    }
    private var legacyToolbarSpacing: CGFloat {
        if #available(iOS 26.0, *) { return 0 }
        return 16 // Older navigation bars have no shared glass; leave a visible gap.
    }
    @ViewBuilder private var cardActions: some View {
        Button("Edit card", systemImage: "pencil") { if let card = cards.first { editCard(card) } }
            .disabled(cards.isEmpty || busy)
        Button("Go to card in note", systemImage: "scope") { if let card = cards.first { editCard(card) } }
            .disabled(cards.isEmpty || busy)
    }
    // The queue the card on screen came from, emphasised in the counts.
    private var currentKind: ReviewCountKind? { cards.first.map { ReviewCountKind(state: $0.state) } }
    private var countsLabel: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            countLabel(reviewCounts.new, later: reviewCounts.laterNew, current: currentKind == .new, light: 0x0284c7, dark: 0x38bdf8)
            countLabel(reviewCounts.learning, later: reviewCounts.laterLearning, current: currentKind == .learning, light: 0xdc2626, dark: 0xf87171)
            countLabel(reviewCounts.review, later: reviewCounts.laterReview, current: currentKind == .review, light: 0x059669, dark: 0x34d399)
        }
        .font(.system(size: 14)).monospacedDigit()
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(reviewCounts.accessibilityLabel + (currentKind.map { ", reviewing \($0.rawValue)" } ?? ""))
        .accessibilityIdentifier("review.counts")
    }
    private func countLabel(_ count: Int, later: Int, current: Bool, light: Int, dark: Int) -> some View {
        let rgb = colorScheme == .dark ? dark : light
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
    func refreshCounts() async {
        do {
            let now = Date()
            let dayEnd = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))!
            let rows: [ReviewCountRow] = try await client.call("due_counts", CountArgs(
                now: Int64(now.timeIntervalSince1970 * 1000), dayEnd: Int64(dayEnd.timeIntervalSince1970 * 1000), createdAtCutoff: createdAtCutoff))
            reviewCounts = ReviewCounts(rows: rows, moduleId: moduleId)
        } catch { self.error = String(describing: error) }
    }
    private let gradeTitles = ["Again", "Hard", "Good", "Easy"]
    private let gradeTints: [Color] = [
        Color(red: 0.937, green: 0.267, blue: 0.267),
        Color(red: 0.961, green: 0.620, blue: 0.043),
        Color(red: 0.063, green: 0.725, blue: 0.506),
        Color(red: 0.055, green: 0.647, blue: 0.914)
    ]
    private func gradeText(_ index: Int) -> Color {
        let light = [0xdc2626, 0xb45309, 0x047857, 0x0369a1]
        let dark = [0xf87171, 0xfbbf24, 0x34d399, 0x38bdf8]
        let rgb = (colorScheme == .dark ? dark : light)[index]
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
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
                            .background(gradeTints[index].opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
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
    func reveal() {
        guard !busy, let card = cards.first, let session else { return }
        revealed = true; show()
        Task {
            do {
                let value = try await session.run("return await window.memnoterReview.preview(card)", ["card": try object(card)])
                if cards.first?.id == card.id, cards.first?.reps == card.reps { intervals = value as? [String] ?? [] }
            } catch { self.error = String(describing: error) }
        }
    }
    func applyPendingSync() async {
        guard syncPending else { return }
        syncPending = false
        busy = true
        defer { busy = false }
        undoSteps = []; redoSteps = []
        await load()
    }
    func load() async {
        do {
            let cutoff = createdAtCutoff
            cards = try await client.call("due_cards", DueArgs(moduleId: moduleId, now: Int64(Date().timeIntervalSince1970 * 1000), createdAtCutoff: cutoff))
            loadedCutoff = cutoff
            error = nil; intervals = []; revealed = false; show()
            await refreshCounts()
        } catch { self.error = String(describing: error) }
    }
    func show() {
        guard let card = cards.first, let session, session.ready else { return }
        Task { do { _ = try await session.run("window.memnoterReview.show(card, revealed)", ["card": try object(card), "revealed": revealed]) } catch { self.error = String(describing: error) } }
    }
    func rate(_ rating: Int) {
        guard !busy, revealed, let card = cards.first, let session else { return }
        busy = true
        Task {
            defer { busy = false; if syncPending { Task { await applyPendingSync() } } }
            do {
                let value = try await session.run("return await window.memnoterReview.rate(card, rating)", ["card": try object(card), "rating": rating])
                let result = try JSONDecoder().decode(ReviewResult.self, from: JSONSerialization.data(withJSONObject: value ?? [:]))
                try await client.write("review_card", ReviewArgs(cardId: card.id, expectedReps: card.reps, card: result.card, log: result.log))
                let queueBefore = cards
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                cards.removeAll { $0.id == card.id }
                await load()
                undoSteps.append(GradeStep(card: card, result: result, queueBefore: queueBefore, queueAfter: cards))
                redoSteps = []
            } catch { self.error = String(describing: error) }
        }
    }
    func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
    func undo() {
        guard !busy, let step = undoSteps.last else { return }
        busy = true
        Task {
            defer { busy = false; if syncPending { Task { await applyPendingSync() } } }
            do {
                try await client.write("undo_review", UndoArgs(cardId: step.card.id, expectedReps: step.result.card.reps, previous: step.card.previous, previousFsrsModel: step.card.fsrsModel, reviewTime: step.result.log.reviewTime))
                undoSteps.removeLast(); redoSteps.append(step)
                cards = step.queueBefore; revealed = false; error = nil; show()
                await refreshCounts()
            } catch { self.error = String(describing: error) }
        }
    }
    func redo() {
        guard !busy, let step = redoSteps.last else { return }
        busy = true
        Task {
            defer { busy = false; if syncPending { Task { await applyPendingSync() } } }
            do {
                try await client.write("review_card", ReviewArgs(cardId: step.card.id, expectedReps: step.card.reps, card: step.result.card, log: step.result.log))
                redoSteps.removeLast(); undoSteps.append(step)
                cards = step.queueAfter; revealed = false; error = nil; show()
                await refreshCounts()
            } catch { self.error = String(describing: error) }
        }
    }
}

// The core owns due-time, sibling-delay and created-today rules. Swift only
// selects/sums its per-module rows, exactly as desktop useDueCounts does.
struct ReviewCountRow: Decodable, Sendable {
    let moduleId: String
    let new: Int
    let learning: Int
    let review: Int
    let laterNew: Int
    let laterLearning: Int
    let laterReview: Int
}
enum ReviewCountKind: String {
    case new, learning, review = "to review"
    // FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
    init(state: Int) {
        switch state {
        case 0: self = .new
        case 2: self = .review
        default: self = .learning
        }
    }
}
struct ReviewCounts: Equatable {
    var new = 0
    var learning = 0
    var review = 0
    var laterNew = 0
    var laterLearning = 0
    var laterReview = 0
    init(rows: [ReviewCountRow] = [], moduleId: String? = nil) {
        for row in rows where moduleId == nil || row.moduleId == moduleId {
            new += row.new; learning += row.learning; review += row.review
            laterNew += row.laterNew; laterLearning += row.laterLearning; laterReview += row.laterReview
        }
    }
    var accessibilityLabel: String {
        [(new, laterNew, "new"), (learning, laterLearning, "learning"), (review, laterReview, "to review")]
            .map { count, later, label in "\(count) \(label)" + (later > 0 ? " (+\(later) later today)" : "") }
            .joined(separator: ", ")
    }
}
