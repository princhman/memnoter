import XCTest

extension XCUIElement {
    @MainActor func existsOrWait(timeout: TimeInterval) -> Bool {
        exists || waitForExistence(timeout: timeout)
    }
}
