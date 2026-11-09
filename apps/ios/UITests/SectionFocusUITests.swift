import XCTest

final class SectionFocusUITests: XCTestCase {
    @MainActor func testContentsHierarchyFocusAndUnfocusRestoreWholeNote() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let home = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Home")).firstMatch
        if !app.buttons["New module"].firstMatch.waitForExistence(timeout: 2) {
            if app.buttons["Show Sidebar"].exists { app.buttons["Show Sidebar"].tap() }
            XCTAssertTrue(home.waitForExistence(timeout: 15))
            home.tap()
        }
        XCTAssertTrue(app.buttons["New module"].firstMatch.waitForExistence(timeout: 15))
        app.buttons["New module"].firstMatch.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Contents navigation")
        app.buttons["Save"].tap()
        let editor = app.webViews.textViews.firstMatch
        let ready = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: editor)], timeout: 20), .completed)
        editor.tap()
        // XCTest can finish injecting a long string before WebKit consumes its
        // keyboard events on CI. Let each paragraph render before sending more.
        let paragraphs = [
            ("# Parent", "Parent"), ("Outside sentinel", "Outside sentinel"),
            ("## Child", "Child"), ("Inside sentinel", "Inside sentinel"),
            ("### Grandchild", "Grandchild"), ("Deep sentinel", "Deep sentinel"),
            ("# Other", "Other"), ("Other sentinel", "Other sentinel"),
        ]
        for (input, rendered) in paragraphs {
            editor.typeText(input + "\n")
            XCTAssertTrue(app.webViews.staticTexts[rendered].waitForExistence(timeout: 10), "Finish typing \(rendered) before continuing")
        }
        // iPad exposes both the system key and the formatting-bar dismiss button.
        let dismissKeyboard = app.buttons["Hide keyboard"].firstMatch
        if dismissKeyboard.exists { dismissKeyboard.tap() }

        openContents(app)
        XCTAssertTrue(app.collectionViews.buttons["Parent"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.collectionViews.buttons["Other"].exists)
        XCTAssertFalse(app.collectionViews.buttons["Child"].exists, "Only immediate sections belong on the first level")
        app.collectionViews.buttons["Parent"].tap()
        XCTAssertTrue(app.collectionViews.buttons["Child"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.collectionViews.buttons["Grandchild"].exists)
        app.collectionViews.buttons["Focus on Child"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Inside sentinel"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.webViews.staticTexts["Outside sentinel"].exists)
        XCTAssertFalse(app.webViews.staticTexts["Other sentinel"].exists)

        // Browsing retains the whole hierarchy while the editor is focused.
        openContents(app)
        XCTAssertTrue(app.collectionViews.buttons["Other"].waitForExistence(timeout: 5))
        let selected = NSPredicate(format: "selected == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: selected, object: app.collectionViews.buttons["Parent"])], timeout: 5), .completed, "Highlight the reading section's branch")
        app.collectionViews.buttons["Parent"].tap()
        app.collectionViews.buttons["Child"].tap()
        XCTAssertTrue(app.collectionViews.buttons["Grandchild"].waitForExistence(timeout: 5))
        app.collectionViews.buttons["Focus on Grandchild"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Deep sentinel"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.webViews.staticTexts["Inside sentinel"].exists)

        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Deep sentinel"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.webViews.staticTexts["Inside sentinel"].exists)
        openContents(app)
        app.collectionViews.buttons["Parent"].tap()
        app.collectionViews.buttons["Child"].tap()
        XCTAssertTrue(app.collectionViews.buttons["Unfocus Grandchild"].waitForExistence(timeout: 5))
        app.collectionViews.buttons["Unfocus Grandchild"].tap()

        // Search can focus an unrelated section without placing a caret there.
        openContents(app)
        let search = app.searchFields["Find a section"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Other")
        XCTAssertTrue(app.collectionViews.buttons["Focus on Other"].waitForExistence(timeout: 5))
        app.collectionViews.buttons["Focus on Other"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Other sentinel"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.webViews.staticTexts["Deep sentinel"].exists)
        openContents(app)
        let wholeNote = app.buttons["contents.wholeNote"]
        XCTAssertTrue(wholeNote.waitForExistence(timeout: 5))
        wholeNote.tap()

        app.terminate()
        app.launch()
        XCTAssertTrue(editor.waitForExistence(timeout: 20))
        openContents(app)
        XCTAssertTrue(app.collectionViews.buttons["Parent"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.collectionViews.buttons["Other"].exists)
        XCTAssertFalse(app.collectionViews.buttons["Unfocus Other"].exists, "Exiting focus must persist")
        XCTAssertFalse(app.collectionViews.buttons["Go to section Other"].exists, "Leaf titles already navigate directly")
        app.collectionViews.buttons["Go to section Parent"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Outside sentinel"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Outside sentinel"].isHittable, "Jump scrolls to the parent section")
        XCTAssertFalse(app.buttons["Done"].exists, "Jump closes Contents instead of browsing children")
        XCTAssertFalse(app.buttons["sectionFocus.clear"].exists, "Jump does not focus the section")
        openContents(app)
        app.collectionViews.buttons["Other"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Other sentinel"].waitForExistence(timeout: 10))
    }

    @MainActor private func openContents(_ app: XCUIApplication) {
        let contents = app.buttons["Contents"]
        if contents.exists && contents.isHittable { contents.tap() }
        else {
            let title = app.buttons["module.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 10))
            title.tap()
        }
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
    }
}
