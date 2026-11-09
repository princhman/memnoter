import XCTest
import PencilKit
@testable import Memnoter

final class DrawingTests: XCTestCase {
    func testMacCanvasArchiveOpensAsEditableNativeInkOnIPad() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "mac-drawing", withExtension: "json"))
        let document = try JSONDecoder().decode(DrawingDocument.self, from: Data(contentsOf: url))
        try document.validate()
        let drawing = try PKDrawing(data: document.nativeData)
        let stroke = try XCTUnwrap(drawing.strokes.first)
        XCTAssertEqual(drawing.strokes.count, 1)
        // Older PencilKit readers normalize Mac monoline archives to pen ink;
        // native control points and their constant widths remain editable.
        XCTAssertTrue([PKInk.InkType.monoline, .pen].contains(stroke.ink.inkType))
        XCTAssertEqual(stroke.path.first?.location, CGPoint(x: 30, y: 40))
        XCTAssertEqual(stroke.path.last?.location, CGPoint(x: 70, y: 80))
        XCTAssertEqual(stroke.path.first?.size, CGSize(width: 4, height: 4))
    }
    private func preferences(in directory: URL) -> UserDefaults {
        let domain = "com.memnoter.tests.drawings.\(directory.lastPathComponent)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: domain) }
        return UserDefaults(suiteName: domain)!
    }
    @MainActor func testSelectedInkAndPreviewKeepTheirColorInDarkAppearance() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let request = DrawingRequest(module: NoteModule(id: UUID().uuidString, name: "Color", heading_numbering: false), imageId: UUID().uuidString, sourceId: nil)
        let model = DrawingModel(request: request, directory: directory, client: client, preferences: preferences(in: directory))
        model.ink = .blue
        let tool = try XCTUnwrap(model.canvas.tool as? PKInkingTool)
        let points = [CGFloat(30), 130].map { x in
            PKStrokePoint(location: CGPoint(x: x, y: 50), timeOffset: Double(x) / 100,
                          size: CGSize(width: 20, height: 20), opacity: 1, force: 1, azimuth: 0, altitude: 1)
        }
        model.canvas.drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(tool.inkType, color: tool.color), path: PKStrokePath(controlPoints: points, creationDate: Date()))])
        for appearance in [UIUserInterfaceStyle.light, .dark] {
            var data: Data?
            UITraitCollection(userInterfaceStyle: appearance).performAsCurrent {
                data = try? DrawingSnapshot(drawing: model.canvas.drawing, size: model.canvas.documentSize).preview()
            }
            let image = try XCTUnwrap(UIImage(data: try XCTUnwrap(data))?.cgImage)
            var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let context = try XCTUnwrap(CGContext(data: &pixels, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            // Locate solid ink rather than assuming the native renderer's
            // padded bounds put a stroke at a particular raster pixel.
            let pixelOffsets = stride(from: 0, to: pixels.count, by: 4)
            let bluestOffset: Int? = pixelOffsets.max { (left: Int, right: Int) -> Bool in
                let leftBlue = Int(pixels[left + 2]) - Int(pixels[left])
                let rightBlue = Int(pixels[right + 2]) - Int(pixels[right])
                return leftBlue < rightBlue
            }
            let ink = try XCTUnwrap(bluestOffset)
            for (index, expected) in [36, 85, 218].enumerated() {
                XCTAssertEqual(Int(pixels[ink + index]), expected, accuracy: 3, "Preview must use the selected blue in either appearance")
            }
        }
        model.tool = .eraser
        XCTAssertTrue(model.canvas.tool is PKEraserTool)
        model.tool = .lasso
        XCTAssertTrue(model.canvas.tool is PKLassoTool)
    }

    @MainActor func testMissingSourceStaysReadOnlyAndOffersRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let request = DrawingRequest(module: NoteModule(id: UUID().uuidString, name: "Missing", heading_numbering: false),
                                     imageId: UUID().uuidString, sourceId: UUID().uuidString)
        let model = DrawingModel(request: request, directory: directory, client: client, preferences: preferences(in: directory))
        await model.load()
        XCTAssertFalse(model.loaded, "Missing source data must never become a writable empty drawing")
        XCTAssertFalse(model.canvas.toolsEnabled)
        XCTAssertTrue(model.loadFailed)
        XCTAssertNotNil(model.error)
    }

    // The paper fits each viewport while keeping document coordinates stable.
    @MainActor func testPaperFitsWidthAndGrowsVerticallyAcrossViewportChanges() {
        let canvas = DrawingCanvas()
        for size in [CGSize(width: 300, height: 300), CGSize(width: 1180, height: 700), CGSize(width: 820, height: 1100)] {
            canvas.frame = CGRect(origin: .zero, size: size)
            canvas.setNeedsLayout(); canvas.layoutIfNeeded()
            XCTAssertEqual(canvas.contentSize.width, size.width, accuracy: 0.01)
            XCTAssertEqual(canvas.zoomScale * canvas.documentSize.width, size.width, accuracy: 0.01)
            XCTAssertGreaterThan(canvas.contentSize.height, size.height)
            XCTAssertEqual(canvas.contentOffset.x, 0, accuracy: 0.01)
        }
        let previousHeight = canvas.contentSize.height
        canvas.contentOffset = CGPoint(x: 0, y: previousHeight - canvas.bounds.height - 10)
        canvas.keepWritingRoom(); canvas.setNeedsLayout(); canvas.layoutIfNeeded()
        XCTAssertGreaterThan(canvas.contentSize.height, previousHeight, "Approaching the bottom should add room automatically")
        XCTAssertEqual(canvas.contentSize.width, 820, accuracy: 0.01)
        let point = PKStrokePoint(location: CGPoint(x: 1300, y: 50), timeOffset: 0,
                                  size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: 1)
        canvas.drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        canvas.restoreSize(CGSize(width: 5000, height: 4000))
        canvas.setNeedsLayout(); canvas.layoutIfNeeded()
        XCTAssertGreaterThan(canvas.documentSize.width, 1300, "Older ink beyond the original paper width must remain visible")
        XCTAssertLessThan(canvas.documentSize.width, 5000, "Unused horizontal space must not shrink the handwriting")
        XCTAssertEqual(canvas.contentSize.width, 820, accuracy: 0.01)
        XCTAssertEqual(canvas.drawing.strokes[0].path[0].location.x, 1300, accuracy: 0.01)
    }

    @MainActor func testEditableSourceReopensThroughManagedStorageAfterDraftRemoval() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let client = try await CoreClient.open(directory)
        let moduleId: String = try await client.call("create_module", NameArgs(name: "Drawing test"))
        let module = NoteModule(id: moduleId, name: "Drawing test", heading_numbering: false)
        let imageId = UUID().uuidString
        let settings = preferences(in: directory)
        let model = DrawingModel(request: DrawingRequest(module: module, imageId: imageId, sourceId: nil), directory: directory, client: client, preferences: settings)
        await model.load()
        let path = PKStrokePath(controlPoints: [
            PKStrokePoint(location: CGPoint(x: 40, y: 60), timeOffset: 0, size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: 1)
        ], creationDate: Date())
        model.canvas.drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .blue), path: path)])
        var sourceId: String?
        do {
            try await model.save(asCopy: false) { _, source, _, _, _ in
                sourceId = source
                throw CocoaError(.fileWriteUnknown)
            }
            XCTFail("A failed note acknowledgement must fail the save")
        } catch { XCTAssertEqual((error as? CocoaError)?.code, .fileWriteUnknown) }
        let pendingDraft = try await DrawingDraftStore(directory: directory, moduleId: "\(moduleId)/\(imageId)").load()
        XCTAssertNotNil(pendingDraft, "Failed publication must retain recovery data")
        let uploadedSource = try XCTUnwrap(sourceId)
        try await model.save(asCopy: false) { target, source, preview, expected, copy in
            XCTAssertEqual(target, imageId); XCTAssertNil(expected); XCTAssertFalse(copy)
            XCTAssertEqual(source, uploadedSource, "A retry must reuse the uploaded revision")
            let stored: DrawingFileContents = try await client.call("read_file", DrawingFileArgs(moduleId: moduleId, fileId: preview))
            XCTAssertEqual(Array(stored.bytes.prefix(4)), [137, 80, 78, 71])
            sourceId = source
        }
        let draft = try await DrawingDraftStore(directory: directory, moduleId: "\(moduleId)/\(imageId)").load()
        XCTAssertNil(draft, "Only the acknowledged managed revision is needed after publication")
        let reopened = DrawingModel(request: DrawingRequest(module: module, imageId: imageId, sourceId: try XCTUnwrap(sourceId)), directory: directory, client: client, preferences: settings)
        await reopened.load()
        XCTAssertTrue(reopened.loaded)
        XCTAssertEqual(reopened.canvas.drawing.strokes.count, 1)
        XCTAssertEqual(try XCTUnwrap(reopened.canvas.drawing.strokes.first).path[0].location.x, 40, accuracy: 0.01)
        XCTAssertFalse(reopened.hasLocalEdits)
        try await reopened.flush()
        let uneditedDraft = try await DrawingDraftStore(directory: directory, moduleId: "\(moduleId)/\(imageId)").load()
        XCTAssertNil(uneditedDraft, "Backgrounding an unedited drawing must not manufacture an unsaved draft")
        let drafts = DrawingDraftStore(directory: directory, moduleId: "\(moduleId)/\(imageId)")
        let published: DrawingFileContents = try await client.call("read_file", DrawingFileArgs(moduleId: moduleId, fileId: try XCTUnwrap(sourceId)))
        try await drafts.checkpoint(DrawingSnapshot(drawing: PKDrawing(), size: CGSize(width: 1024, height: 1440)), baseSourceId: "older-source", revision: 1)
        let stale = DrawingModel(request: DrawingRequest(module: module, imageId: imageId, sourceId: try XCTUnwrap(sourceId)), directory: directory, client: client, preferences: settings)
        await stale.load()
        XCTAssertTrue(stale.requiresCopy)
        XCTAssertTrue(stale.hasLocalEdits)
        XCTAssertTrue(stale.canvas.drawing.strokes.isEmpty)
        try await stale.discardLocalChanges()
        try await stale.flush()
        let removedDraft = try await drafts.load()
        XCTAssertNil(removedDraft)
        let stillPublished: DrawingFileContents = try await client.call("read_file", DrawingFileArgs(moduleId: moduleId, fileId: try XCTUnwrap(sourceId)))
        XCTAssertEqual(stillPublished.bytes, published.bytes)
        let restored = DrawingModel(request: DrawingRequest(module: module, imageId: imageId, sourceId: try XCTUnwrap(sourceId)), directory: directory, client: client, preferences: settings)
        await restored.load()
        XCTAssertFalse(restored.requiresCopy)
        XCTAssertFalse(restored.hasLocalEdits)
        XCTAssertEqual(restored.canvas.drawing.strokes.count, 1)

    }

    // The real file boundary guards crash recovery and a late autosave replacing
    // a newer explicit save. No fake persistence or implementation assertions.
    func testDraftReopensNewestRevisionAndSeparatesModules() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DrawingDraftStore(directory: directory, moduleId: "note-a")
        try await store.save(Data([1]), revision: 1)
        try await store.save(Data([3]), revision: 3)
        try await store.save(Data([2]), revision: 2)
        let reopened = try await DrawingDraftStore(directory: directory, moduleId: "note-a").load()
        XCTAssertEqual(reopened, Data([3]))
        try await store.remove(through: 3)
        try await store.save(Data([3]), revision: 3)
        let published = try await store.load()
        XCTAssertNil(published, "A late autosave must not resurrect the published draft")
        try await store.save(Data([4]), revision: 4)
        try await store.remove(through: 3)
        let newer = try await store.load()
        XCTAssertEqual(newer, Data([4]), "An older publication must not delete a newer recovery checkpoint")
        let other = try await DrawingDraftStore(directory: directory, moduleId: "note-b").load()
        XCTAssertNil(other)
    }

    @MainActor func testToolsAndPerDrawingViewRestoreAcrossViewportChanges() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = preferences(in: directory)
        let client = try await CoreClient.open(directory)
        let module = NoteModule(id: UUID().uuidString, name: "Preferences", heading_numbering: false)
        let request = DrawingRequest(module: module, imageId: UUID().uuidString, sourceId: nil)
        let model = DrawingModel(request: request, directory: directory, client: client, preferences: settings)
        await model.load()
        model.tool = .marker; model.ink = .purple; model.inkWidth = 6.5; model.fingerDrawing = true
        model.canvas.frame = CGRect(x: 0, y: 0, width: 820, height: 1000)
        model.canvas.restoreSize(CGSize(width: 1024, height: 20_000)); model.canvas.layoutIfNeeded()
        model.canvas.contentOffset = CGPoint(x: 0, y: 6400 * model.canvas.zoomScale)
        model.checkpointView()
        let reopened = DrawingModel(request: request, directory: directory, client: client, preferences: settings)
        await reopened.load()
        reopened.canvas.frame = CGRect(x: 0, y: 0, width: 1180, height: 700)
        reopened.canvas.layoutIfNeeded()
        let tool = try XCTUnwrap(reopened.canvas.tool as? PKInkingTool)
        XCTAssertEqual(tool.inkType, .marker)
        XCTAssertEqual(tool.color, DrawingInk.purple.color)
        XCTAssertEqual(tool.width, 32.5, accuracy: 0.01)
        XCTAssertEqual(reopened.canvas.drawingPolicy, .anyInput)
        XCTAssertEqual(reopened.canvas.contentOffset.y / reopened.canvas.zoomScale, 6400, accuracy: 0.01)
        let other = DrawingModel(request: DrawingRequest(module: module, imageId: UUID().uuidString, sourceId: nil), directory: directory, client: client, preferences: settings)
        await other.load()
        other.canvas.frame = CGRect(x: 0, y: 0, width: 820, height: 1000); other.canvas.layoutIfNeeded()
        XCTAssertEqual(other.tool, .marker, "Tool preferences apply to new drawings")
        XCTAssertEqual(other.canvas.contentOffset.y, 0, "Another drawing must have its own scroll position")
    }

    @MainActor func testLargeDrawingRecoversAnImmutableCheckpointAndPublishesAfterReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = preferences(in: directory)
        let client = try await CoreClient.open(directory)
        let moduleId: String = try await client.call("create_module", NameArgs(name: "Large drawing"))
        let module = NoteModule(id: moduleId, name: "Large drawing", heading_numbering: false)
        let request = DrawingRequest(module: module, imageId: UUID().uuidString, sourceId: nil)
        var strokes: [PKStroke] = []
        for index in 0..<5000 {
            var points: [PKStrokePoint] = []
            for point in 0..<20 {
                let location = CGPoint(x: 30 + point * 10, y: index * 4 + point % 3)
                points.append(PKStrokePoint(location: location, timeOffset: Double(point) / 120,
                                            size: CGSize(width: 3, height: 3), opacity: 1, force: 0.5, azimuth: 0, altitude: 1))
            }
            let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: Double(index)))
            strokes.append(PKStroke(ink: PKInk(.monoline, color: .black), path: path))
        }
        let snapshot = DrawingSnapshot(drawing: PKDrawing(strokes: strokes), size: CGSize(width: 1024, height: 21_000))
        let store = DrawingDraftStore(directory: directory, moduleId: "\(moduleId)/\(request.imageId)")
        let start = ContinuousClock.now
        try await store.checkpoint(snapshot, baseSourceId: nil, revision: 1)
        let reopened = DrawingModel(request: request, directory: directory, client: client, preferences: settings)
        await reopened.load()
        XCTAssertTrue(reopened.loaded)
        XCTAssertTrue(reopened.hasLocalEdits)
        XCTAssertEqual(reopened.canvas.drawing.strokes.count, 5000)
        XCTAssertEqual(reopened.canvas.drawing.strokes.last?.path.last?.location.y, 19_997)
        var sourceId: String?
        try await reopened.save(asCopy: false) { _, source, _, _, _ in sourceId = source }
        let saved = DrawingModel(request: DrawingRequest(module: module, imageId: request.imageId, sourceId: try XCTUnwrap(sourceId)), directory: directory, client: client, preferences: settings)
        await saved.load()
        XCTAssertEqual(saved.canvas.drawing.strokes.count, 5000)
        XCTAssertEqual(saved.canvas.drawing.strokes.first?.path.first?.location, CGPoint(x: 30, y: 0))
        XCTAssertFalse(saved.hasLocalEdits)
        print("Large drawing: 5000 strokes / 100000 control points, checkpoint + recover + publish + reopen: \(start.duration(to: .now))")
    }

    // Independent fixture values verify the interchange output. A renderer
    // consuming this JSON needs transformed control points and pressure intact.
    @MainActor func testStrokeExportPreservesGeometryAndClipping() throws {
        let path = PKStrokePath(controlPoints: [
            PKStrokePoint(location: CGPoint(x: 10, y: 20), timeOffset: 0,
                          size: CGSize(width: 4, height: 6), opacity: 0.8, force: 0.5, azimuth: 1, altitude: 0.7),
            PKStrokePoint(location: CGPoint(x: 50, y: 60), timeOffset: 0.2,
                          size: CGSize(width: 5, height: 7), opacity: 1, force: 0.7, azimuth: 1.2, altitude: 0.8)
        ], creationDate: Date(timeIntervalSince1970: 0))
        let ink = PKInk(.monoline, color: .red)
        let stroke = PKStroke(ink: ink, path: path, transform: CGAffineTransform(translationX: 30, y: 40), mask: nil)
        let exported = try DrawingStrokeExport(drawing: PKDrawing(strokes: [stroke]), page: CGSize(width: 1024, height: 1440))
        let bytes = try JSONEncoder().encode(exported)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 1)
        let strokes = try XCTUnwrap(json["strokes"] as? [[String: Any]])
        XCTAssertEqual(strokes.count, 1)
        XCTAssertEqual(strokes[0]["transform"] as? [Double], [1, 0, 0, 1, 30, 40])
        XCTAssertEqual(strokes[0]["rgba"] as? [Double], [1, 0, 0, 1])
        let points = try XCTUnwrap(strokes[0]["points"] as? [[String: Double]])
        XCTAssertEqual(points.count, 2)
        XCTAssertEqual(try XCTUnwrap(points[0]["x"]), 10, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(points[1]["y"]), 60, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(points[0]["force"]), 0.5, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(points[1]["time"]), 0.2, accuracy: 0.01)
        let clipped = PKStroke(ink: ink, path: path, transform: .identity,
                               mask: UIBezierPath(rect: CGRect(x: 0, y: 0, width: 20, height: 20)))
        let maskedExport = try DrawingStrokeExport(drawing: PKDrawing(strokes: [clipped]), page: CGSize(width: 1024, height: 1440))
        let mask = try XCTUnwrap(maskedExport.strokes.first?.mask)
        XCTAssertEqual(mask.first?.command, "move")
        // PencilKit can normalize which rectangle corner begins the path.
        let corners = mask.filter { $0.command != "close" }.map(\.coordinates)
        for corner: [Double] in [[0, 0], [20, 0], [20, 20], [0, 20]] {
            XCTAssertTrue(corners.contains(corner))
        }
        XCTAssertEqual(mask.filter { $0.command == "line" }.count, 3)
        XCTAssertEqual(mask.last?.command, "close")
    }
}
