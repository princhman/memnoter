import UIKit
import XCTest

final class SidebarSectionsUITests: XCTestCase {
    @MainActor func testClosedModuleDisclosureFocusAndWholeNote() {
        continueAfterFailure = false
        let app = launch()
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        let module = "Chapters"
        let sidebar = phone ? app.collectionViews.firstMatch : app.collectionViews["Sidebar"]
        let disclosure = sidebar.buttons["Sections in \(module)"]

        createModule(module, in: app)
        let editor = app.webViews.textViews.firstMatch
        editor.tap()
        for (typed, displayed) in [
            ("# First", "First"), ("First body", "First body"),
            ("# Second", "Second"), ("Second body", "Second body")
        ] {
            editor.typeText(typed + "\n")
            XCTAssertTrue(app.webViews.staticTexts[displayed].existsOrWait(timeout: 10))
        }
        dismissKeyboard(in: app)
        showSidebar(in: app, phone: phone)
        XCTAssertFalse(disclosure.exists, "A fresh device starts with the existing sidebar.")
        setSidebarSections(in: app, numberedModule: module)

        createModule("Other note", in: app)
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(disclosure.existsOrWait(timeout: 5))
        disclosure.tap()
        let second = sidebar.buttons["2 Second"]
        XCTAssertTrue(second.existsOrWait(timeout: 10))
        XCTAssertTrue(sidebar.buttons["1 First"].exists)
        XCTAssertFalse(app.webViews.staticTexts["First body"].exists, "Disclosure must leave the current note in place.")

        second.tap()
        XCTAssertTrue(app.webViews.staticTexts["Second body"].existsOrWait(timeout: 10))
        // Compact navigation attaches the editor before it can apply focus.
        XCTAssertTrue(app.webViews.staticTexts["First body"].waitForNonExistence(timeout: 5))
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(second.existsOrWait(timeout: 5))
        XCTAssertTrue(second.isSelected)

        app.buttons["Edit modules"].tap()
        XCTAssertFalse(second.exists)
        app.buttons["Done editing"].tap()
        XCTAssertTrue(second.existsOrWait(timeout: 5))

        sidebar.buttons[module].tap()
        XCTAssertTrue(app.webViews.staticTexts["First body"].existsOrWait(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Second body"].exists)
    }

    @MainActor func testModuleMenuAddsAnEmptySectionWithTheKeyboardReady() {
        continueAfterFailure = false
        let app = launch()
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        let module = "New chapters"
        let sidebar = phone ? app.collectionViews.firstMatch : app.collectionViews["Sidebar"]
        setSidebarSections(in: app)
        createModule(module, in: app)
        showSidebar(in: app, phone: phone)
        let disclosure = sidebar.buttons["Sections in \(module)"]
        XCTAssertTrue(disclosure.existsOrWait(timeout: 5))
        disclosure.tap()

        let row = sidebar.buttons[module]
        XCTAssertTrue(row.existsOrWait(timeout: 5))
        row.press(forDuration: 1)
        let add = app.buttons["Add section"]
        XCTAssertTrue(add.existsOrWait(timeout: 5))
        add.tap()

        let editor = app.webViews.textViews.firstMatch
        XCTAssertTrue(editor.existsOrWait(timeout: 10))
        // Without tapping the editor, XCTest requires the text view to already
        // have keyboard focus before it delivers this input.
        editor.typeText("New title")
        XCTAssertTrue(app.webViews.staticTexts["New title"].existsOrWait(timeout: 10))
        dismissKeyboard(in: app)
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(sidebar.buttons["New title"].existsOrWait(timeout: 5), "The sidebar follows edits to the focused title.")
    }

    @MainActor private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        if UIDevice.current.userInterfaceIdiom == .phone {
            showSidebar(in: app, phone: true)
        }
        return app
    }

    @MainActor private func setSidebarSections(in app: XCUIApplication, numberedModule: String? = nil) {
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.existsOrWait(timeout: 10))
        settings.tap()
        let toggle = app.switches["Sections in the sidebar"]
        XCTAssertTrue(toggle.existsOrWait(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "0")
        enable(toggle)
        if let numberedModule {
            // On iPad the list can expose a clipped switch at the bottom of
            // the sheet as hittable. Scroll the numbering section into view.
            app.collectionViews.firstMatch.swipeUp()
            let numbering = app.switches[numberedModule]
            XCTAssertTrue(numbering.existsOrWait(timeout: 5))
            enable(numbering)
        }
        app.buttons["Done"].tap()
    }

    @MainActor private func enable(_ toggle: XCUIElement) {
        // SwiftUI exposes the whole labeled row as a switch. Its midpoint
        // can land on the label instead of the actual switch at the trailing edge.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
            .withOffset(CGVector(dx: -30, dy: 0)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "1"), object: toggle
        )], timeout: 5), .completed)
    }

    @MainActor private func createModule(_ name: String, in app: XCUIApplication) {
        let add = app.buttons["Add"]
        XCTAssertTrue(add.existsOrWait(timeout: 10))
        add.tap()
        app.buttons["New module"].firstMatch.tap()
        let field = app.textFields["Name"]
        XCTAssertTrue(field.existsOrWait(timeout: 5))
        field.tap()
        field.typeText(name)
        app.buttons["Save"].tap()
        let editor = app.webViews.textViews.firstMatch
        let ready = NSPredicate(format: "exists == true AND enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: editor)], timeout: 20), .completed)
    }

    @MainActor private func showSidebar(in app: XCUIApplication, phone: Bool) {
        let reveal = phone ? app.navigationBars.buttons["Memnoter"] : app.buttons["Toggle Sidebar"]
        if reveal.exists && reveal.isHittable { reveal.tap() }
        if phone {
            // The compact sidebar is an unlabeled list on iOS 26.
            XCTAssertTrue(app.buttons["Settings"].existsOrWait(timeout: 5))
            return
        }
        // The list is the sidebar. The floating Settings toolbar can report
        // temporarily unhittable while the keyboard is dismissing.
        XCTAssertTrue(app.collectionViews["Sidebar"].existsOrWait(timeout: 5))
    }

    @MainActor private func dismissKeyboard(in app: XCUIApplication) {
        let hide = app.buttons["Hide keyboard"].firstMatch
        if hide.exists { hide.tap() }
    }
}
