import Foundation
import XCTest
@testable import Memnoter

final class SidebarSectionsTests: XCTestCase {
    func testClosedSectionTargetsRoundTripToNativeNavigation() throws {
        let data = Data("""
        {"sections":[
          {"key":"intro","title":"Introduction","number":"1","target":{"kind":"heading","id":"intro"}},
          {"key":"chapter-4294967295-27","title":"Untitled section","number":"2",
           "target":{"kind":"legacy-heading","itemId":{"client":4294967295,"clock":27}}}
        ]}
        """.utf8)
        let snapshot = try JSONDecoder().decode(SidebarSectionSnapshot.self, from: data)
        XCTAssertNil(snapshot.error)
        XCTAssertNil(snapshot.focusedKey)
        XCTAssertEqual(snapshot.sections.map { $0.label(numbered: true) }, ["1 Introduction", "2 Untitled section"])
        XCTAssertEqual(snapshot.sections.map { $0.label(numbered: false) }, ["Introduction", "Untitled section"])

        let ordinary = try XCTUnwrap(snapshot.sections.first)
        XCTAssertEqual(SidebarNoteDestination.section(ordinary.target).arguments as? [String: String],
                       ["kind": "heading", "id": "intro"])
        let legacy = try XCTUnwrap(snapshot.sections.last)
        let request = SidebarNoteDestination.section(legacy.target).arguments
        XCTAssertEqual(request["kind"] as? String, "legacy-heading")
        XCTAssertEqual(request["itemId"] as? [String: Int], ["client": 4_294_967_295, "clock": 27])
    }

    func testAnIncompleteLegacyIdentityCannotBeUsedAsADestination() {
        let partial = Data("""
        {"key":"partial","title":"Chapter","number":"1","target":{"kind":"legacy-heading","itemId":{"client":12}}}
        """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SidebarSection.self, from: partial))
    }
}
