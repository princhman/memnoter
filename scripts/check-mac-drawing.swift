// Run check-mac-drawing.sh on macOS. An optional output filename captures the
// actual canvas-authored archive for the iPad compatibility test.
import Foundation
import AppKit
import PencilKit
import WebKit

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
        let model = DrawingSession(request); await model.load()
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
        let recovered = DrawingSession(request); await recovered.load()
        precondition(recovered.loaded && recovered.hasChanges && recovered.drawing.strokes.count == 1)
        let files = try await model.storage.publication(model.drawing, width: model.paperWidth, height: model.paperHeight, paperStyle: model.paperStyle)
        let source = try Data(contentsOf: URL(fileURLWithPath: files.0))
        let preview = try Data(contentsOf: URL(fileURLWithPath: files.1))
        precondition(Array(preview.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10])
        try source.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
        try await checkPortableSelection(folder: folder, scope: scope)
        try await checkEmbeddedPresentation(folder: folder, scope: scope)
        try await checkAnswerSession(folder: folder, scope: scope, drawing: model.drawing)
        print("Mac canvas: mouse stroke, undo/redo, stroke erasing, local recovery and PNG/source publication passed. Archive written for the iPad test.")
    }

    // Real PKDrawing archives, masks and sampled descriptors: the v2 selection
    // must win over the old full archive, without rebuilding selected native ink.
    @MainActor private static func checkPortableSelection(folder: URL, scope: String) async throws {
        let points = [CGFloat(-10), 80].enumerated().map { i, x in
            PKStrokePoint(location: CGPoint(x: x, y: 50), timeOffset: Double(i)/10,
                size: CGSize(width: 16, height: 5), opacity: 0.4, force: 0.7, azimuth: 0.6, altitude: 0.8)
        }
        let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 123))
        let mask = NSBezierPath(rect: CGRect(x: -20, y: 0, width: 65, height: 100))
        mask.windingRule = .evenOdd
        let original = PKDrawing(strokes: [PKInk.InkType.pen, .pencil, .marker].map { tool in
            PKStroke(ink: PKInk(tool, color: (tool == .marker ? NSColor.white : NSColor.red).withAlphaComponent(0.6)), path: path,
                transform: CGAffineTransform(translationX: 30, y: 40), mask: mask)
        })
        let archive = original.dataRepresentation()
        let basis = try PKDrawing(data: archive)
        let exported = PortableInk.exporting(basis)!
        precondition(exported.version == 2 && exported.strokes.count == 3)
        precondition(exported.strokes[1].tool == PKInk.InkType.pencil.rawValue)
        precondition(exported.strokes[1].mask != nil && exported.strokes[1].maskUsesEvenOddFillRule == true)
        let web = PortableInk.Stroke(tool: "pen", color: "#202020", width: 4,
            points: [.init(x: 100, y: 120, pressure: 0.8), .init(x: 140, y: 160, pressure: 1)])
        // Reorder and erase: index zero must never return from the full archive.
        let selection = PortableInk(version: 2, strokes: [exported.strokes[2], exported.strokes[1], web])
        let document = DrawingDocument(version: 2, nativeData: archive, width: 1024, height: 40_000, geometry: nil, portable: selection)
        let decoded = try JSONDecoder().decode(DrawingDocument.self, from: JSONEncoder().encode(document))
        let restored = try decoded.drawing()
        precondition(restored.strokes.count == 3)
        for (output, input) in [(0, 2), (1, 1)] {
            let got = restored.strokes[output], expected = basis.strokes[input]
            precondition(got.ink == expected.ink && got.transform == expected.transform)
            precondition(got.randomSeed == expected.randomSeed && got.mask?.cgPath == expected.mask?.cgPath)
            precondition(got.path.first?.size == expected.path.first?.size)
            precondition(got.path.first?.opacity == expected.path.first?.opacity)
        }
        precondition(restored.strokes[2].path.first?.location == CGPoint(x: 100, y: 120))
        let sourcePath = folder.appendingPathComponent("indexed-source.json")
        try JSONEncoder().encode(document).write(to: sourcePath)
        let request = DrawingSessionRequest(owner: .note(moduleId: "portable", imageId: "indexed"), sourceId: "source",
            sourcePath: sourcePath.path, draftPath: folder.appendingPathComponent("indexed-draft.json").path,
            resultPath: folder.appendingPathComponent("indexed-result.json").path,
            maximumBytes: 50 * 1024 * 1024 - 29, preferencesScope: scope)
        let storage = DrawingStorage(request)
        let loadedState = try await storage.load()
        let loaded = loadedState.0
        precondition(loaded.strokes[0].ink == basis.strokes[2].ink, "Native load must preserve white ink")
        let files = try await storage.publication(loaded, width: 1024, height: 40_000, paperStyle: .blank)
        let published = try JSONDecoder().decode(DrawingDocument.self, from: Data(contentsOf: URL(fileURLWithPath: files.0)))
        precondition(published.version == 1 && published.portable?.strokes.map(\.nativeIndex) == [0, 1, 2])
        let publishedDrawing = try published.drawing()
        precondition(publishedDrawing.strokes[0].ink == basis.strokes[2].ink)
        let next = PortableInk.exporting(restored)!
        precondition(next.strokes.map(\.nativeIndex) == [0, 1, 2])
        let nextDocument = DrawingDocument(version: 2, nativeData: restored.dataRepresentation(), width: 1024, height: 40_000,
            geometry: nil, portable: PortableInk(version: 2, strokes: [next.strokes[1]]))
        let final = try nextDocument.drawing()
        precondition(final.strokes.count == 1 && final.strokes[0].ink.inkType == .pencil)
        var invalid = exported.strokes[0]; invalid.nativeIndex = 10
        for data in [archive, Data()] {
            let bad = DrawingDocument(version: 2, nativeData: data, width: 1024, height: 1440,
                geometry: nil, portable: PortableInk(version: 2, strokes: [invalid]))
            do { _ = try bad.drawing(); preconditionFailure("Invalid native basis must be rejected") }
            catch { }
        }
        print("Portable v2: indexed masked/pencil/elliptical/translucent selection, reorder, web append, re-export and invalid basis rejection passed.")
    }

    // Independent session contract: an answer owner has no image/embed/window.
    @MainActor private static func checkAnswerSession(folder: URL, scope: String, drawing: PKDrawing) async throws {
        let owner = DrawingOwner(moduleId: "module", answerId: "leaf-answer", canvasId: "canvas")
        precondition(owner != DrawingOwner(moduleId: "module", answerId: "other-answer", canvasId: "canvas"))
        precondition(DrawingOwner.note(moduleId: "module", imageId: "image").viewportKey == "viewport.module/image")
        let request = DrawingSessionRequest(owner: owner, sourceId: "synced-source", sourcePath: folder.appendingPathComponent("source.json").path,
            draftPath: folder.appendingPathComponent("answer-draft.json").path,
            resultPath: folder.appendingPathComponent("answer-result.json").path,
            maximumBytes: 50 * 1024 * 1024 - 29, preferencesScope: scope)
        let document = DrawingDocument(version: 1, nativeData: drawing.dataRepresentation(), width: 1024, height: 1440, geometry: nil)
        try JSONEncoder().encode(document).write(to: URL(fileURLWithPath: request.sourcePath!))
        let session = DrawingSession(request); await session.load()
        precondition(session.loaded && !session.hasChanges && !session.requiresCopy)
        session.commit(PKDrawing()); precondition(session.hasChanges)
        session.undo(); precondition(session.drawing.strokes.count == 1)
        session.redo(); precondition(session.drawing.strokes.isEmpty)
        try await session.flush()
        // Out-of-order checkpoints must not replace a newer snapshot.
        try await session.storage.checkpoint(drawing, width: 1024, height: 1440, base: "wrong", revision: 0)
        let recovered = DrawingSession(request); await recovered.load()
        precondition(recovered.hasChanges && !recovered.requiresCopy && recovered.drawing.strokes.isEmpty)
        let newer = DrawingSessionRequest(owner: owner, sourceId: "newer-source", sourcePath: request.sourcePath,
            draftPath: request.draftPath, resultPath: request.resultPath, maximumBytes: request.maximumBytes, preferencesScope: scope)
        let conflict = DrawingSession(newer); await conflict.load()
        precondition(conflict.requiresCopy && conflict.baseSourceId == "synced-source")
        conflict.done(copy: true)
        for _ in 0..<150 {
            if conflict.finished { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        precondition(conflict.finished)
        let result = try JSONDecoder().decode(EditorResult.self, from: Data(contentsOf: URL(fileURLWithPath: request.resultPath)))
        precondition(result.status == "save" && result.asCopy && result.expectedSourceId == "synced-source")
        precondition(FileManager.default.fileExists(atPath: request.draftPath), "Publishing must retain recovery until the host acknowledges durable references")
        let missing = DrawingSession(DrawingSessionRequest(owner: owner, sourceId: "missing", sourcePath: nil,
            draftPath: folder.appendingPathComponent("missing.json").path, resultPath: request.resultPath,
            maximumBytes: request.maximumBytes, preferencesScope: scope))
        await missing.load()
        precondition(!missing.loaded && missing.error != nil, "An unavailable source must never open as empty ink")
        try await checkScrollingHost(session: session)
        print("Answer session: revision, undo/redo, ordered recovery, conflict copy and missing-source safety passed.")
    }

    @MainActor private static func checkScrollingHost(session: DrawingSession) async throws {
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let container = window.contentView!
        let web = WKWebView(frame: container.bounds)
        container.addSubview(web)
        web.loadHTMLString("""
            <body style="margin:0"><div style="height:400px">Question above the answer</div>
            <div id="canvas" style="margin-left:50px;width:700px;height:984px"></div>
            <div style="height:800px">Following question</div></body>
            """, baseURL: nil)
        for _ in 0..<200 {
            if !web.isLoading, (try? await web.evaluateJavaScript("!!document.getElementById('canvas')")) as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let host = EmbeddedDrawingHost(session: session, scrollTarget: web)
        container.addSubview(host)
        func update(_ scroll: Int) async throws -> CGRect {
            let values = try await web.evaluateJavaScript("window.scrollTo(0, \(scroll)); (() => { const r = document.getElementById('canvas').getBoundingClientRect(); return [r.x,r.y,r.width,r.height,window.scrollY]; })()") as! [Double]
            precondition(values[4] == Double(scroll))
            let frame = CGRect(x: values[0], y: web.bounds.height - values[1] - values[3], width: values[2], height: values[3])
            host.updateGeometry(canvasFrame: frame, visibleFrame: web.frame)
            return frame
        }
        let before = try await update(0)
        precondition(!web.isHidden && host.frame.height == 300 && host.paper.window === window)
        precondition(container.hitTest(CGPoint(x: 10, y: 650)) !== host.paper, "Prompt input must not hit the canvas")
        let originalInk = session.drawing.dataRepresentation()
        let after = try await update(550)
        precondition(after.minY - before.minY == 550 && host.frame.height == 700)
        precondition(!web.isHidden && session.drawing.dataRepresentation() == originalInk)
        // Native input still maps to logical coordinates after scroll + clipping.
        session.tool = .pen
        let location = host.paper.convert(CGPoint(x: 100, y: 500), to: nil)
        func event(_ type: NSEvent.EventType, _ time: Double) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: time,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        }
        host.paper.mouseDown(with: event(.leftMouseDown, 1))
        host.paper.mouseUp(with: event(.leftMouseUp, 1.1))
        precondition(session.drawing.strokes.last!.path[0].location == CGPoint(x: 100, y: 500))
        _ = try await update(1450)
        precondition(host.isHidden && !web.isHidden)
        host.removeFromSuperview()
        precondition(container.subviews == [web] && !window.isVisible)
        print("Scrolling WKWebView: clipped canvas, prompt hit testing, logical input after scrolling and offscreen removal passed.")
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
