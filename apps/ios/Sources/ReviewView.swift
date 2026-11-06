import SwiftUI

// Rich segments, KaTeX and image masks share the desktop renderer and scheduler.
// Native models validate scheduling fields; rich face segments use Codable JSON.
struct ReviewView: View {
    let client: CoreClient
    let directory: URL
    let moduleId: String?
    let editCard: (StoredCard) -> Void
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
                HStack {
                    if revealed {
                        ForEach(Array(["Again", "Hard", "Good", "Easy"].enumerated()), id: \.offset) { index, title in
                            Button(title) { rate(index + 1) }.buttonStyle(.borderedProminent).keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [])
                        }
                    } else { Button("Show answer") { revealed = true; show() }.buttonStyle(.borderedProminent).keyboardShortcut(.space, modifiers: []) }
                }.padding().disabled(busy)

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
            error = nil; revealed = false; show()
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
