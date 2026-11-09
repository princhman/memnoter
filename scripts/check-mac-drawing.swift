// Run check-mac-drawing.sh on macOS. An optional output filename captures the
// actual canvas-authored archive for the iPad compatibility test.
import Foundation
import AppKit
import PencilKit

@MainActor private enum PresentationReceipts { static var values: [UInt64: Int32] = [:] }
private func presentationFinished(_ context: UInt64, _ status: Int32) {
    MainActor.assumeIsolated { PresentationReceipts.values[context] = status }
}
@MainActor private final class NoteWindowDelegate: NSObject, NSWindowDelegate { }

@main struct CheckMacDrawing {
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let scope = UUID().uuidString
        defer {
            try? FileManager.default.removeItem(at: folder)
            UserDefaults.standard.removePersistentDomain(forName: "com.memnoter.mac.drawing.\(scope)")
        }
        let request = EditorRequest(moduleId: UUID().uuidString, imageId: UUID().uuidString, sourceId: nil, sourcePath: nil,
                                    draftPath: folder.appendingPathComponent("draft.json").path, resultPath: folder.appendingPathComponent("result.json").path,
                                    maximumBytes: 50 * 1024 * 1024 - 29, preferencesScope: scope)
        let model = DrawingModel(request); await model.load()
        precondition(model.loaded)
        model.color = .blue; model.width = 4
        let view = PaperView(model); view.frame = CGRect(x: 0, y: 0, width: 1024, height: 1440)
        func event(_ type: NSEvent.EventType, _ point: CGPoint, _ time: Double) -> NSEvent {
            // Window coordinates start at the bottom; paper coordinates start
            // at the top of this independently sized 1440-point test view.
            NSEvent.mouseEvent(with: type, location: CGPoint(x: point.x, y: 1440 - point.y), modifierFlags: [], timestamp: time, windowNumber: 0,
                               context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        }
        view.mouseDown(with: event(.leftMouseDown, CGPoint(x: 30, y: 40), 1))
        view.mouseDragged(with: event(.leftMouseDragged, CGPoint(x: 70, y: 80), 1.1))
        view.mouseUp(with: event(.leftMouseUp, CGPoint(x: 70, y: 80), 1.2))
        precondition(model.drawing.strokes.count == 1)
        precondition(model.drawing.strokes[0].path.first?.location == CGPoint(x: 30, y: 40))
        model.undo(); precondition(model.drawing.strokes.isEmpty)
        model.redo(); precondition(model.drawing.strokes.count == 1)
        view.refresh(); model.tool = .eraser
        view.mouseDown(with: event(.leftMouseDown, CGPoint(x: 50, y: 60), 2))
        view.mouseUp(with: event(.leftMouseUp, CGPoint(x: 50, y: 60), 2.1))
        precondition(model.drawing.strokes.isEmpty)
        model.undo(); precondition(model.drawing.strokes.count == 1)
        try await model.flush()
        let recovered = DrawingModel(request); await recovered.load()
        precondition(recovered.loaded && recovered.hasChanges && recovered.drawing.strokes.count == 1)
        let files = try await model.storage.publication(model.drawing, width: model.paperWidth, height: model.paperHeight)
        let source = try Data(contentsOf: URL(fileURLWithPath: files.0))
        let preview = try Data(contentsOf: URL(fileURLWithPath: files.1))
        precondition(Array(preview.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10])
        try source.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
        try await checkEmbeddedPresentation(folder: folder, scope: scope)
        print("Mac canvas: mouse stroke, undo/redo, stroke erasing, local recovery and PNG/source publication passed. Archive written for the iPad test.")
    }

    // Exercises the production C entry point used by Tauri, without showing a
    // window or posting OS input. Ink-handler coverage above cannot catch an
    // overlay that replaces the note window's delegate or fails to dismiss.
    @MainActor private static func checkEmbeddedPresentation(folder: URL, scope: String) async throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let delegate = NoteWindowDelegate()
        window.delegate = delegate
        let container = window.contentView!
        let note = NSView(frame: container.bounds)
        container.addSubview(note)
        let request = EditorRequest(moduleId: UUID().uuidString, imageId: UUID().uuidString, sourceId: nil, sourcePath: nil,
                                    draftPath: folder.appendingPathComponent("presentation-draft.json").path,
                                    resultPath: folder.appendingPathComponent("presentation-result.json").path,
                                    maximumBytes: 50 * 1024 * 1024 - 29, preferencesScope: scope)
        let requestURL = folder.appendingPathComponent("presentation-request.json")
        try JSONEncoder().encode(request).write(to: requestURL)
        func open(_ context: UInt64) {
            requestURL.path.withCString { presentDrawing(Unmanaged.passUnretained(window).toOpaque(), $0, context, presentationFinished) }
        }
        func paper(in view: NSView) -> PaperView? {
            if let paper = view as? PaperView { return paper }
            return view.subviews.lazy.compactMap { paper(in: $0) }.first
        }
        func wait(_ description: String, until condition: () -> Bool) async throws {
            for _ in 0..<150 {
                container.layoutSubtreeIfNeeded()
                if condition() { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            preconditionFailure(description)
        }
        open(1)
        try await wait("The embedded canvas did not load") { paper(in: container)?.model.loaded == true }
        let canvas = paper(in: container)!
        precondition(canvas.window === window && window.delegate === delegate && note.superview === container && note.isHidden)
        precondition(!window.isVisible, "Presentation must not create or show another window")
        canvas.model.tool = .pen; canvas.model.color = .blue
        func event(_ type: NSEvent.EventType, _ point: CGPoint, _ time: Double) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [], timestamp: time,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        }
        canvas.mouseDown(with: event(.leftMouseDown, CGPoint(x: 30, y: 40), 1))
        canvas.mouseUp(with: event(.leftMouseUp, CGPoint(x: 70, y: 80), 1.2))
        precondition(canvas.model.drawing.strokes.count == 1)
        closeDrawing()
        try await wait("Close did not return to the note") { PresentationReceipts.values[1] == 0 }
        precondition(container.subviews == [note] && !note.isHidden && window.delegate === delegate)
        let cancelled = try JSONDecoder().decode(EditorResult.self, from: Data(contentsOf: URL(fileURLWithPath: request.resultPath)))
        precondition(cancelled.status == "cancel" && cancelled.hasChanges)
        open(2)
        try await wait("The embedded draft did not reopen") { paper(in: container)?.model.loaded == true }
        let reopened = paper(in: container)!
        precondition(reopened.model.drawing.strokes.count == 1)
        try await wait("The reopened ink loaded but was not displayed by the canvas") { reopened.drawing.strokes.count == 1 }
        reopened.model.done(copy: true)
        try await wait("Done did not return to the note") { PresentationReceipts.values[2] == 0 }
        let saved = try JSONDecoder().decode(EditorResult.self, from: Data(contentsOf: URL(fileURLWithPath: request.resultPath)))
        precondition(saved.status == "save" && FileManager.default.fileExists(atPath: saved.sourcePath!))
        precondition(!saved.asCopy, "Save a copy for a new drawing must publish into its existing slot")
        precondition(container.subviews == [note] && !note.isHidden && window.delegate === delegate && !window.isVisible)
        let publishedURL = URL(fileURLWithPath: saved.sourcePath!)
        let publishedBytes = try Data(contentsOf: publishedURL)
        let latest = try JSONDecoder().decode(DrawingDocument.self, from: publishedBytes)
        let staleDocument = DrawingDocument(version: 1, nativeData: PKDrawing().dataRepresentation(), width: 1024, height: 1440, geometry: nil)
        try JSONEncoder().encode(LocalDraft(document: staleDocument, baseSourceId: "old-source")).write(to: URL(fileURLWithPath: request.draftPath))
        let conflict = EditorRequest(moduleId: request.moduleId, imageId: request.imageId, sourceId: "new-source", sourcePath: publishedURL.path,
                                     draftPath: request.draftPath, resultPath: request.resultPath, maximumBytes: request.maximumBytes, preferencesScope: scope)
        try JSONEncoder().encode(conflict).write(to: requestURL)
        open(3)
        try await wait("The recovered draft did not load") { paper(in: container)?.model.loaded == true }
        let stale = paper(in: container)!.model
        precondition(stale.requiresCopy && stale.hasChanges && stale.drawing.strokes.isEmpty)
        stale.discardLocalChanges()
        try await wait("Discard did not return to the note") { PresentationReceipts.values[3] == 0 }
        let discarded = try JSONDecoder().decode(EditorResult.self, from: Data(contentsOf: URL(fileURLWithPath: request.resultPath)))
        precondition(discarded.status == "discarded")
        try await stale.storage.checkpoint(stale.drawing, width: 1024, height: 1440, base: "old-source", revision: 999)
        precondition(!FileManager.default.fileExists(atPath: request.draftPath), "A late checkpoint must not resurrect discarded work")
        let unchangedPublishedBytes = try Data(contentsOf: publishedURL)
        precondition(unchangedPublishedBytes == publishedBytes, "Discard must not change the published drawing")
        open(4)
        try await wait("The synced drawing did not reopen after discard") { paper(in: container)?.drawing.strokes.count == 1 }
        precondition(!paper(in: container)!.model.requiresCopy && !paper(in: container)!.model.hasChanges)
        let expected = try PKDrawing(data: latest.nativeData)
        precondition(paper(in: container)!.model.drawing.strokes.first!.path[0].location == expected.strokes.first!.path[0].location)
        closeDrawing()
        try await wait("Close did not finish after discard") { PresentationReceipts.values[4] == 0 }
        print("Embedded canvas: input, recovery, publication, stale draft discard and synced-source reopening passed.")
    }
}
