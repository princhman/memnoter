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
        let style = app.buttons["Block style"]
        XCTAssertTrue(style.existsOrWait(timeout: 5))
        style.tap()
        app.buttons["H1"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Heading 1"), object: style)], timeout: 5), .completed)
        style.tap()
        app.buttons["Text"].tap()
        editor.typeText("Saved from iPhone\nQuestion :: Answer")
        let title = app.navigationBars.staticTexts[name]
        let scope = app.navigationBars.buttons["Module scope"]
        XCTAssertTrue(title.exists, "The current module name must remain in the breadcrumb")
        XCTAssertTrue(scope.isHittable, "Module scope must remain reachable beside note actions")
        XCTAssertTrue(title.frame.intersects(scope.frame), "Module title must remain visible within its menu control")
        let actions = app.navigationBars.buttons["Note actions"]
        XCTAssertTrue(actions.isHittable, "Note actions must remain reachable beside the module title")
        actions.tap()
        let undo = app.buttons["Undo"]
        let redo = app.buttons["Redo"]
        XCTAssertTrue(undo.existsOrWait(timeout: 5))
        XCTAssertTrue(undo.isHittable, "Editor undo must be reachable in Note actions")
        undo.tap()
        let canRedo = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: canRedo, object: redo)], timeout: 5), .completed)
        XCTAssertTrue(redo.isHittable, "Editor redo must be reachable in Note actions")
        redo.tap()
        // The open menu covers its trigger; dismiss through the uncovered left margin.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.4)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: undo)], timeout: 5), .completed)
        XCTAssertTrue(app.webViews.staticTexts["Saved from iPhone"].existsOrWait(timeout: 10), "Redo must restore the text before navigating away")
        let dismissKeyboard = app.buttons["Hide keyboard"]
        XCTAssertTrue(dismissKeyboard.existsOrWait(timeout: 5))
        dismissKeyboard.tap()

        back(in: app)
        let note = app.buttons[name]
        XCTAssertTrue(note.existsOrWait(timeout: 5))
        note.tap()
        XCTAssertTrue(app.webViews.staticTexts["Saved from iPhone"].existsOrWait(timeout: 10))

        // Reopening the currently selected row must still navigate after Back.
        back(in: app)
        XCTAssertTrue(note.existsOrWait(timeout: 5))
        note.tap()
        XCTAssertTrue(editor.existsOrWait(timeout: 10))

        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Saved from iPhone"].existsOrWait(timeout: 20))
        back(in: app)
        let review = app.buttons.containing(.staticText, identifier: "Review").firstMatch
        XCTAssertTrue(review.existsOrWait(timeout: 5))
        review.tap()
        XCTAssertTrue(app.descendants(matching: .any)["review.counts"].existsOrWait(timeout: 10))
        let reveal = app.buttons["Show answer"]
        XCTAssertTrue(reveal.existsOrWait(timeout: 10))
        reveal.tap()
        let good = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Good")).firstMatch
        XCTAssertTrue(good.existsOrWait(timeout: 5))
        XCTAssertTrue(good.isHittable, "Rating must fit on a small phone")
        good.tap()
        app.buttons["Review actions"].tap()
        XCTAssertTrue(app.buttons["Undo"].isEnabled, "A phone rating must be persisted and undoable")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.4)).tap()
        back(in: app)
        XCTAssertTrue(note.existsOrWait(timeout: 5))
    }

    @MainActor private func launchNote(_ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let add = app.buttons["New module"]
        XCTAssertTrue(add.existsOrWait(timeout: 15))
        add.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.existsOrWait(timeout: 5))
        field.tap()
        field.typeText(name)
        app.buttons["Save"].tap()
        let ready = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: app.webViews.textViews.firstMatch)], timeout: 20), .completed)
        return app
    }

    @MainActor private func back(in app: XCUIApplication) {
        let back = app.navigationBars.buttons["Memnoter"]
        XCTAssertTrue(back.existsOrWait(timeout: 5), "Native Back must remain accessible")
        back.tap()
    }
}
