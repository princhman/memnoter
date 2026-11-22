import XCTest

final class DrawingUITests: XCTestCase {
    @MainActor func testDrawingReturnsWithoutImageSelectionAfterDoneAndClose() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let create = app.buttons["New module"]
        XCTAssertTrue(create.existsOrWait(timeout: 15))
        create.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.existsOrWait(timeout: 5))
        field.tap(); field.typeText("Drawing save regression")
        app.buttons["Save"].tap()
        let editor = app.webViews.textViews.firstMatch
        let editable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: editor)
        // A cold WebKit process can take longer to mount the editor on CI.
        XCTAssertEqual(XCTWaiter.wait(for: [editable], timeout: 60), .completed, "The new note's editor must become ready")
        let actions = app.buttons["Note actions"]
        XCTAssertTrue(actions.existsOrWait(timeout: 5))
        actions.tap()
        let insert = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Insert drawing")).firstMatch
        XCTAssertTrue(insert.existsOrWait(timeout: 5)); insert.tap()
        let canvas = app.scrollViews["Drawing canvas"].firstMatch
        XCTAssertTrue(canvas.existsOrWait(timeout: 10))
        app.buttons["Blue ink"].tap()
        let options = app.buttons["Drawing options"]
        options.tap()
        let finger = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Draw with finger")).firstMatch
        XCTAssertTrue(finger.existsOrWait(timeout: 5)); finger.tap()
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.25))
            .press(forDuration: 0.1, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)))
        options.tap()
        XCTAssertTrue(finger.existsOrWait(timeout: 5)); finger.tap()
        canvas.swipeUp()
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.existsOrWait(timeout: 10), "Done must finish and return to the note")
        let drawing = waitForDrawingPreview(in: app, timeout: 30, message: "The saved drawing preview must be ready to tap")
        drawing.tap()
        let imageActions = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Image actions")).firstMatch
        let edit = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Edit drawing")).firstMatch
        XCTAssertTrue(imageActions.existsOrWait(timeout: 5), "The first tap must select the drawing and expose its actions")
        XCTAssertFalse(canvas.exists, "Selecting a drawing must leave the note open")
        imageActions.tap()
        XCTAssertTrue(edit.existsOrWait(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.buttons["Done"].existsOrWait(timeout: 10), "Saved strokes must reopen")
        XCTAssertTrue(app.buttons["Blue ink"].isSelected, "Reopening must retain the selected ink")
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.existsOrWait(timeout: 10), "Done without edits must also dismiss without a responder cycle")
        XCTAssertFalse(imageActions.exists, "Returning from drawing editing must not leave the image toolbar selected")
        drawing.tap()
        XCTAssertTrue(imageActions.existsOrWait(timeout: 5))
        XCTAssertFalse(canvas.exists, "The first tap after returning must select the drawing again")
        imageActions.tap()
        XCTAssertTrue(edit.existsOrWait(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.buttons["Close drawing"].existsOrWait(timeout: 10))
        app.buttons["Close drawing"].tap()
        XCTAssertTrue(actions.existsOrWait(timeout: 10))
        XCTAssertFalse(imageActions.exists, "Close must also return without an image selection")
        app.terminate(); app.launch()
        // A relaunch replaces the WebKit process and its accessibility elements.
        let restoredDrawing = waitForDrawingPreview(in: app, timeout: 60, message: "Relaunch must restore the note and its drawing preview")
        restoredDrawing.tap()
        let restoredActions = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Image actions")).firstMatch
        XCTAssertTrue(restoredActions.existsOrWait(timeout: 5)); restoredActions.tap()
        let restoredEdit = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Edit drawing")).firstMatch
        XCTAssertTrue(restoredEdit.existsOrWait(timeout: 5)); restoredEdit.tap()
        XCTAssertTrue(app.buttons["Done"].existsOrWait(timeout: 10))
        XCTAssertTrue(app.buttons["Blue ink"].isSelected, "Ink preference must survive app relaunch")
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.existsOrWait(timeout: 10))
    }

    @MainActor private func waitForDrawingPreview(in app: XCUIApplication, timeout: TimeInterval, message: String,
                                                  file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let drawing = app.webViews.images["Drawing"].firstMatch
        let updating = app.webViews.staticTexts["Updating drawing…"].firstMatch
        let ready = NSPredicate { _, _ in drawing.exists && !updating.exists && drawing.isHittable }
        let preview = XCTNSPredicateExpectation(predicate: ready, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [preview], timeout: timeout), .completed, message, file: file, line: line)
        return drawing
    }
}
