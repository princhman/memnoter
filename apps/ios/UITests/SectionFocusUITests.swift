import XCTest

final class SectionFocusUITests: XCTestCase {
    @MainActor func testFocusUnfocusKeepsTitleAndRestoresContent() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Reuse this namespace on relaunch to test persistence, but never reuse
        // another run's notes, navigation preferences, or sync account.
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        let home = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Home")).firstMatch
        if !home.waitForExistence(timeout: 2) {
            XCTAssertTrue(app.buttons["Show Sidebar"].waitForExistence(timeout: 15))
            app.buttons["Show Sidebar"].tap()
        }
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
        XCTAssertTrue(waitUntilEnabled(editor))
        editor.tap()
        tapFormat("Heading 1", in: app)
        editor.typeText("Parent heading\n")
        tapFormat("Text", in: app)
        editor.typeText("Outside sentinel\n")
        tapFormat("Heading 2", in: app)
        editor.typeText("Child section\n")
        tapFormat("Text", in: app)
        editor.typeText("Inside sentinel\n")
        let outside = app.webViews.staticTexts["Outside sentinel"].firstMatch
        let inside = app.webViews.staticTexts["Inside sentinel"].firstMatch
        XCTAssertTrue(outside.waitForExistence(timeout: 10))
        XCTAssertTrue(inside.waitForExistence(timeout: 10))
        let title = app.staticTexts["module.title"]
        XCTAssertTrue(title.exists && title.isHittable, "Module title must survive toolbar crowding")
        let enter = app.buttons["sectionFocus.enter"]
        let chip = app.buttons["sectionFocus.menu"]
        let clear = app.buttons["sectionFocus.clear"]
        XCTAssertTrue(enter.waitForExistence(timeout: 5))
        XCTAssertEqual(enter.label, "Focus on this section")
        enter.tap()
        XCTAssertTrue(app.buttons["sectionFocus.clear"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sectionFocus.menu"].exists, "Focused section must retain its title/menu at iPad Air width")
        XCTAssertFalse(enter.exists, "Focus action must be replaced by the focused chip")
        XCTAssertTrue(chip.label.contains("Child section"), "Chip must name the focused section: \(chip.label)")
        XCTAssertNotEqual(chip.label, "Focus on this section")
        XCTAssertFalse(outside.exists, "Content outside the focused H2 must leave the accessibility tree")
        XCTAssertTrue(inside.exists)
        XCTAssertTrue(title.exists && title.isHittable)
        if app.buttons["Show Sidebar"].waitForExistence(timeout: 2) { app.buttons["Show Sidebar"].tap() }
        home.tap()
        app.buttons["New module"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Other \(name)")
        app.buttons["Save"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertFalse(clear.exists, "Focus must not leak into the other module")
        if app.buttons["Show Sidebar"].waitForExistence(timeout: 2) { app.buttons["Show Sidebar"].tap() }
        let module = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        // SwiftUI lazily exposes sidebar rows, so reveal the module if needed.
        let sidebar = app.collectionViews.firstMatch
        for _ in 0..<30 {
            if module.exists && module.isHittable { break }
            sidebar.swipeUp()
        }
        XCTAssertTrue(module.waitForExistence(timeout: 5))
        XCTAssertTrue(module.isHittable)
        module.tap()
        XCTAssertTrue(clear.waitForExistence(timeout: 10))
        XCTAssertTrue(chip.label.contains("Child section"))
        XCTAssertFalse(enter.exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(clear.waitForExistence(timeout: 15))
        XCTAssertTrue(chip.label.contains("Child section"))
        XCTAssertFalse(enter.exists)
        clear.tap()
        XCTAssertTrue(enter.waitForExistence(timeout: 5))
        XCTAssertEqual(enter.label, "Focus on this section")
        XCTAssertFalse(chip.exists)
        XCTAssertFalse(clear.exists)
        app.webViews.staticTexts["Child section"].firstMatch.tap()
        enter.tap()
        XCTAssertTrue(clear.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("Child section"))
        XCTAssertFalse(enter.exists)
        clear.tap()
        XCTAssertTrue(enter.waitForExistence(timeout: 5))
        XCTAssertFalse(chip.exists)
        XCTAssertTrue(outside.waitForExistence(timeout: 5))
        XCTAssertTrue(inside.exists)
        XCTAssertTrue(title.exists && title.isHittable)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Outside sentinel"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["sectionFocus.clear"].exists, "Unfocus must survive relaunch")
    }

    @MainActor private func waitUntilEnabled(_ element: XCUIElement) -> Bool {
        let ready = NSPredicate(format: "exists == true AND enabled == true")
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: element)], timeout: 15) == .completed
    }

    @MainActor private func tapFormat(_ label: String, in app: XCUIApplication) {
        let button = app.buttons[label]
        // tap() scrolls an offscreen action into view in the horizontal row;
        // requiring isHittable before that would deadlock on narrower iPads.
        XCTAssertTrue(waitUntilEnabled(button), "Formatting action \(label) must be ready. Alerts: \(app.alerts.debugDescription)")
        button.tap()
    }
}
