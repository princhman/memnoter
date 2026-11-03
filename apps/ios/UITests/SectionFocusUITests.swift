import XCTest

final class SectionFocusUITests: XCTestCase {
    @MainActor func testFocusUnfocusKeepsTitleAndRestoresContent() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        if app.buttons["Show Sidebar"].exists { app.buttons["Show Sidebar"].tap() }
        let home = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Home")).firstMatch
        XCTAssertTrue(home.waitForExistence(timeout: 15))
        home.tap()
        app.buttons["New module"].tap()
        let name = "Focus UI \(UUID().uuidString.prefix(6))"
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(name)
        app.buttons["Save"].tap()
        let editor = app.webViews.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        editor.tap()
        app.buttons["Heading 1"].tap()
        app.typeText("Parent heading\n")
        app.buttons["Text"].tap()
        app.typeText("Outside sentinel\n")
        app.buttons["Heading 2"].tap()
        app.typeText("Child section\n")
        app.buttons["Text"].tap()
        app.typeText("Inside sentinel\n")
        let outside = app.webViews.staticTexts["Outside sentinel"].firstMatch
        let inside = app.webViews.staticTexts["Inside sentinel"].firstMatch
        XCTAssertTrue(outside.exists)
        XCTAssertTrue(inside.exists)
        let title = app.staticTexts["module.title"]
        XCTAssertTrue(title.exists && title.isHittable, "Module title must survive toolbar crowding")
        app.buttons["sectionFocus.enter"].tap()
        XCTAssertTrue(app.buttons["sectionFocus.clear"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sectionFocus.menu"].exists, "Focused section must retain its title/menu at iPad Air width")
        XCTAssertFalse(outside.exists, "Content outside the focused H2 must leave the accessibility tree")
        XCTAssertTrue(inside.exists)
        XCTAssertTrue(title.exists && title.isHittable)
        app.buttons["sectionFocus.clear"].tap()
        XCTAssertTrue(outside.waitForExistence(timeout: 5))
        XCTAssertTrue(inside.exists)
        XCTAssertTrue(title.exists && title.isHittable)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Outside sentinel"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["sectionFocus.clear"].exists, "Unfocus must survive relaunch")
    }
}
