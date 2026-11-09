import XCTest
import UIKit

final class PhoneNavigationUITests: XCTestCase {
    // Owns the phone navigation/storage contract. The existing section-focus
    // scenario covers iPad toolbars, not collapsed navigation or native Back.
    @MainActor func testReopeningSameNoteAndRelaunchPreserveEdits() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "Phone navigation scenario")
        continueAfterFailure = false
        let name = "Phone navigation"
        let app = launchNote(name)
        let editor = app.webViews.textViews.firstMatch
        editor.tap()
        let style = app.buttons["Paragraph style"]
        XCTAssertTrue(style.waitForExistence(timeout: 5))
        style.tap()
        app.buttons["Heading 1"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Heading 1"), object: style)], timeout: 5), .completed)
        style.tap()
        app.buttons["Text"].tap()
        editor.typeText("Saved from iPhone\nQuestion :: Answer")
        XCTAssertTrue(app.buttons["module.title"].isHittable, "Module title must remain visible beside undo/redo")
        let undo = app.navigationBars.buttons["Undo"]
        let redo = app.navigationBars.buttons["Redo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        XCTAssertTrue(undo.isHittable, "Editor undo must be visible in the navigation bar")
        undo.tap()
        let canRedo = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: canRedo, object: redo)], timeout: 5), .completed)
        XCTAssertTrue(redo.isHittable, "Editor redo must be visible in the navigation bar")
        redo.tap()
        let dismissKeyboard = app.buttons["Hide keyboard"]
        XCTAssertTrue(dismissKeyboard.waitForExistence(timeout: 5))
        dismissKeyboard.tap()

        back(in: app)
        let note = app.buttons[name]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        note.tap()
        XCTAssertTrue(app.webViews.staticTexts["Saved from iPhone"].waitForExistence(timeout: 10))

        // Reopening the currently selected row must still navigate after Back.
        back(in: app)
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        note.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))

        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Saved from iPhone"].waitForExistence(timeout: 20))
        back(in: app)
        XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 5))
        app.buttons["Review"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["review.counts"].waitForExistence(timeout: 10))
        let reveal = app.buttons["Show answer"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 10))
        reveal.tap()
        let good = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Good")).firstMatch
        XCTAssertTrue(good.waitForExistence(timeout: 5))
        XCTAssertTrue(good.isHittable, "Rating must fit on a small phone")
        good.tap()
        XCTAssertTrue(app.buttons["Undo"].isEnabled, "A phone rating must be persisted and undoable")
        back(in: app)
        XCTAssertTrue(note.waitForExistence(timeout: 5))
    }

    @MainActor private func launchNote(_ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let add = app.buttons["New module"]
        XCTAssertTrue(add.waitForExistence(timeout: 15))
        add.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(name)
        app.buttons["Save"].tap()
        let ready = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: app.webViews.textViews.firstMatch)], timeout: 20), .completed)
        return app
    }

    @MainActor private func back(in app: XCUIApplication) {
        let back = app.navigationBars.buttons["Memnoter"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "Native Back must remain accessible")
        back.tap()
    }
}
