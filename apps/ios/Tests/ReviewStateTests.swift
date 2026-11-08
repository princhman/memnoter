import XCTest
@testable import Memnoter

final class ReviewStateTests: XCTestCase {
    func testPostedSessionStateDecodesForNativeControls() throws {
        let json = #"{"counts":{"new":1,"learning":2,"review":3},"laterToday":{"new":0,"learning":4,"review":5},"countsLabel":"1 new, 2 learning (+4 later today), 3 to review (+5 later today), reviewing learning","currentKind":"learning","intervals":["1m","5m","1d","4d"],"canUndo":true,"canRedo":false,"revealed":true,"busy":false,"hasCard":true,"canShowNow":false,"loading":false,"reviewed":2,"moduleId":"a","cardId":"b","error":null}"#
        let state = try JSONDecoder().decode(ReviewState.self, from: Data(json.utf8))
        XCTAssertEqual(state.counts.new, 1)
        XCTAssertEqual(state.laterToday.learning, 4)
        XCTAssertEqual(state.currentKind, "learning")
        XCTAssertEqual(state.intervals, ["1m", "5m", "1d", "4d"])
        XCTAssertTrue(state.canUndo)
        XCTAssertFalse(state.canRedo)
        XCTAssertEqual(state.cardId, "b")
    }
}
