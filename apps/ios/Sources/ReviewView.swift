import SwiftUI

// Rich segments, KaTeX and image masks share the desktop renderer and scheduler.
// Native models validate scheduling fields; rich face segments use Codable JSON.
struct ReviewView: View {
    let client: CoreClient
    let directory: URL
    let moduleId: String?
    @State private var session: WebSession?
    @State private var cards: [StoredCard] = []
    @State private var revealed = false
    @State private var busy = false
    @State private var error: String?
    @State private var last: (card: StoredCard, result: ReviewResult)?
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
            } else { ContentUnavailableView("All caught up", systemImage: "checkmark.circle", description: Text("No cards are due. Open older notes once to check them for cards.")) }
        }
        .toolbar { Button("Undo rating") { undo() }.disabled(last == nil || busy).keyboardShortcut("z") }
        .task {
            let web = WebSession(client: client, directory: directory, entry: "review-native.html")
            web.onReady = { show() }
            session = web
            await load()
        }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if cards.isEmpty && !busy { await load() }
            }
        }
        .onDisappear { session?.dispose() }
    }
    func load() async {
        do {
            cards = try await client.call("due_cards", DueArgs(moduleId: moduleId, now: Int64(Date().timeIntervalSince1970 * 1000)))
            revealed = false; show()
        } catch { self.error = String(describing: error) }
    }
    func show() {
        guard let card = cards.first, let session, session.ready else { return }
        Task { do { _ = try await session.run("window.memnoterReview.show(card, revealed)", ["card": try object(card), "revealed": revealed]) } catch { self.error = String(describing: error) } }
    }
    func rate(_ rating: Int) {
        guard !busy, let card = cards.first, let session else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let value = try await session.run("return await window.memnoterReview.rate(card, rating)", ["card": try object(card), "rating": rating])
                let result = try JSONDecoder().decode(ReviewResult.self, from: JSONSerialization.data(withJSONObject: value ?? [:]))
                try await client.write("review_card", ReviewArgs(cardId: card.id, expectedReps: card.reps, card: result.card, log: result.log))
                last = (card, result)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                await load()
            } catch { self.error = String(describing: error) }
        }
    }
    func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
    func undo() {
        guard let last else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await client.write("undo_review", UndoArgs(cardId: last.card.id, expectedReps: last.result.card.reps, previous: last.card.previous, previousFsrsModel: last.card.fsrsModel, reviewTime: last.result.log.reviewTime)); self.last = nil; await load() }
            catch { self.error = String(describing: error) }
        }
    }
}
