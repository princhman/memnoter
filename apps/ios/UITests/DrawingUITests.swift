import XCTest

final class DrawingUITests: XCTestCase {
    @MainActor func testDrawingReturnsWithoutImageSelectionAfterDoneAndClose() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let create = app.buttons["New module"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        create.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Drawing save regression")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.webViews.textViews.firstMatch.waitForExistence(timeout: 15))
        let actions = app.buttons["Note actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 5))
        actions.tap()
        let insert = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Insert drawing")).firstMatch
        XCTAssertTrue(insert.waitForExistence(timeout: 5)); insert.tap()
        let canvas = app.scrollViews["Drawing canvas"].firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 10))
        app.buttons["Blue ink"].tap()
        let options = app.buttons["Drawing options"]
        options.tap()
        let finger = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Draw with finger")).firstMatch
        XCTAssertTrue(finger.waitForExistence(timeout: 5)); finger.tap()
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.25))
            .press(forDuration: 0.1, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)))
        options.tap()
        XCTAssertTrue(finger.waitForExistence(timeout: 5)); finger.tap()
        canvas.swipeUp()
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.waitForExistence(timeout: 10), "Done must finish and return to the note")
        let drawing = app.webViews.images["Drawing"].firstMatch
        XCTAssertTrue(drawing.waitForExistence(timeout: 10), "The saved drawing must be embedded")
        drawing.tap()
        let edit = app.webViews.buttons["Edit drawing"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5), "The first tap must select the drawing and expose its pencil action")
        XCTAssertFalse(canvas.exists, "Selecting a drawing must leave the note open")
        edit.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10), "Saved strokes must reopen")
        XCTAssertTrue(app.buttons["Blue ink"].isSelected, "Reopening must retain the selected ink")
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.waitForExistence(timeout: 10), "Done without edits must also dismiss without a responder cycle")
        XCTAssertFalse(edit.exists, "Returning from drawing editing must not leave the image toolbar selected")
        drawing.tap()
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        XCTAssertFalse(canvas.exists, "The first tap after returning must select the drawing again")
        edit.tap()
        XCTAssertTrue(app.buttons["Close drawing"].waitForExistence(timeout: 10))
        app.buttons["Close drawing"].tap()
        XCTAssertTrue(actions.waitForExistence(timeout: 10))
        XCTAssertFalse(edit.exists, "Close must also return without an image selection")
        app.terminate(); app.launch()
        XCTAssertTrue(drawing.waitForExistence(timeout: 15))
        drawing.tap()
        XCTAssertTrue(edit.waitForExistence(timeout: 5)); edit.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Blue ink"].isSelected, "Ink preference must survive app relaunch")
        app.buttons["Done"].tap()
        XCTAssertTrue(actions.waitForExistence(timeout: 10))
    }
}
