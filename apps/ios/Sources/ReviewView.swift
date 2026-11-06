import SwiftUI

// Rich segments, KaTeX and image masks share the desktop renderer and scheduler.
// Native models validate scheduling fields; rich face segments use Codable JSON.
struct ReviewView: View {
    let client: CoreClient
    let directory: URL
    let moduleId: String?
    let editCard: (StoredCard) -> Void
    @Environment(\.colorScheme) private var colorScheme
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
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                Button("Undo", systemImage: "arrow.uturn.backward") { undo() }
                    .disabled(undoSteps.isEmpty || busy).keyboardShortcut("z")
                Button("Redo", systemImage: "arrow.uturn.forward") { redo() }
                    .disabled(redoSteps.isEmpty || busy).keyboardShortcut("z", modifiers: [.command, .shift])
                Button("Edit card", systemImage: "pencil") { if let card = cards.first { editCard(card) } }
                    .disabled(cards.isEmpty || busy)
                Button("Go to card in note", systemImage: "scope") { if let card = cards.first { editCard(card) } }
                    .disabled(cards.isEmpty || busy)
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
                if !busy && (cards.isEmpty || loadedCutoff != createdAtCutoff) { await load() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .syncDidApply)) { _ in
            syncPending = true
            if !busy { Task { await applyPendingSync() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .cardsDidChange)) { _ in
            // Keep the card being answered; each rating reloads the queue anyway.
            if !busy && cards.isEmpty { Task { await load() } }
        }
        .onChange(of: skipCardsCreatedToday) { _, _ in Task { if !busy { await load() } } }
        .onDisappear { session?.dispose() }
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
            } catch { self.error = String(describing: error) }
        }
    }
}
