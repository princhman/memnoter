import UIKit
import XCTest

final class SidebarSectionsUITests: XCTestCase {
    @MainActor func testClosedModuleDisclosureFocusAndWholeNote() {
        continueAfterFailure = false
        let app = launch()
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        let module = "Sidebar chapters"
        let disclosure = app.buttons["Sections in \(module)"]

        createModule(module, in: app)
        let editor = app.webViews.textViews.firstMatch
        editor.tap()
        for (typed, displayed) in [
            ("# First chapter", "First chapter"), ("First body", "First body"),
            ("# Second chapter", "Second chapter"), ("Second body", "Second body")
        ] {
            editor.typeText(typed + "\n")
            XCTAssertTrue(app.webViews.staticTexts[displayed].existsOrWait(timeout: 10))
        }
        dismissKeyboard(in: app)
        showSidebar(in: app, phone: phone)
        XCTAssertFalse(disclosure.exists, "A fresh device starts with the existing sidebar.")
        setSidebarSections(in: app, numberedModule: module)

        createModule("Another note", in: app)
        XCTAssertTrue(editor.existsOrWait(timeout: 15))
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(disclosure.existsOrWait(timeout: 5))
        disclosure.tap()
        let second = app.buttons["2 Second chapter"]
        XCTAssertTrue(second.existsOrWait(timeout: 10))
        XCTAssertTrue(app.buttons["1 First chapter"].exists)
        XCTAssertFalse(app.webViews.staticTexts["First body"].exists, "Disclosure must leave the current note in place.")

        second.tap()
        XCTAssertTrue(app.webViews.staticTexts["Second body"].existsOrWait(timeout: 10))
        XCTAssertFalse(app.webViews.staticTexts["First body"].exists)
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(second.existsOrWait(timeout: 5))
        XCTAssertTrue(second.isSelected)

        app.buttons["Edit modules"].tap()
        XCTAssertFalse(second.exists)
        app.buttons["Done editing"].tap()
        XCTAssertTrue(second.existsOrWait(timeout: 5))

        app.buttons[module].tap()
        XCTAssertTrue(app.webViews.staticTexts["First body"].existsOrWait(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Second body"].exists)
    }

    @MainActor func testModuleMenuAddsAnEmptySectionWithTheKeyboardReady() {
        continueAfterFailure = false
        let app = launch()
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        let module = "Add a sidebar chapter"
        setSidebarSections(in: app)
        createModule(module, in: app)
        showSidebar(in: app, phone: phone)
        app.buttons["Sections in \(module)"].tap()

        let row = app.buttons[module]
        XCTAssertTrue(row.existsOrWait(timeout: 5))
        row.press(forDuration: 1)
        let add = app.buttons["Add section"]
        XCTAssertTrue(add.existsOrWait(timeout: 5))
        add.tap()

        let editor = app.webViews.textViews.firstMatch
        XCTAssertTrue(editor.existsOrWait(timeout: 10))
        XCTAssertTrue(app.buttons["Hide keyboard"].existsOrWait(timeout: 10), "Add section should activate the editor.")
        editor.typeText("New title")
        XCTAssertTrue(app.webViews.staticTexts["New title"].existsOrWait(timeout: 10))
        dismissKeyboard(in: app)
        showSidebar(in: app, phone: phone)
        XCTAssertTrue(app.buttons["New title"].existsOrWait(timeout: 5), "The sidebar follows edits to the focused title.")
    }

    @MainActor private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-data-id", UUID().uuidString]
        app.launch()
        return app
    }

    @MainActor private func setSidebarSections(in app: XCUIApplication, numberedModule: String? = nil) {
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.existsOrWait(timeout: 10))
        settings.tap()
        let toggle = app.switches["Sections in the sidebar"]
        XCTAssertTrue(toggle.existsOrWait(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "0")
        toggle.tap()
        if let numberedModule {
            let numbering = app.switches[numberedModule]
            XCTAssertTrue(numbering.existsOrWait(timeout: 5))
            numbering.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value == %@", "1"), object: numbering
            )], timeout: 10), .completed)
        }
        app.buttons["Done"].tap()
    }

    @MainActor private func createModule(_ name: String, in app: XCUIApplication) {
        let add = app.buttons["Add"]
        XCTAssertTrue(add.existsOrWait(timeout: 10))
        add.tap()
        app.buttons["New module"].tap()
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
        if app.buttons["Settings"].isHittable { return }
        let button = phone ? app.navigationBars.buttons["Memnoter"] : app.buttons["Show Sidebar"]
        XCTAssertTrue(button.existsOrWait(timeout: 5))
        button.tap()
        XCTAssertTrue(app.buttons["Settings"].existsOrWait(timeout: 5))
    }

    @MainActor private func dismissKeyboard(in app: XCUIApplication) {
        let hide = app.buttons["Hide keyboard"].firstMatch
        if hide.exists { hide.tap() }
    }
}
