import XCTest
@testable import Memnoter

final class ReviewCountsTests: XCTestCase {
    // The native boundary must decode the core's camelCase fields, sum all
    // modules globally, and isolate a selected module without mixing splits.
    func testCoreRowsKeepScopeAndDueNowSeparateFromLaterToday() throws {
        let json = #"[{"moduleId":"a","count":6,"new":1,"learning":2,"review":3,"laterNew":4,"laterLearning":5,"laterReview":6},{"moduleId":"b","count":60,"new":10,"learning":20,"review":30,"laterNew":40,"laterLearning":50,"laterReview":60}]"#
        let rows = try JSONDecoder().decode([ReviewCountRow].self, from: Data(json.utf8))
        let all = ReviewCounts(rows: rows)
        XCTAssertEqual([all.new, all.learning, all.review, all.laterNew, all.laterLearning, all.laterReview], [11, 22, 33, 44, 55, 66])
        let scoped = ReviewCounts(rows: rows, moduleId: "a")
        XCTAssertEqual([scoped.new, scoped.learning, scoped.review, scoped.laterNew, scoped.laterLearning, scoped.laterReview], [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(scoped.accessibilityLabel, "1 new (+4 later today), 2 learning (+5 later today), 3 to review (+6 later today)")
        XCTAssertEqual(ReviewCounts(rows: rows, moduleId: "missing"), ReviewCounts())
        XCTAssertEqual(ReviewCounts().accessibilityLabel, "0 new, 0 learning, 0 to review")
    }

    func testRelearningCountsAsLearning() {
        XCTAssertEqual([0, 1, 2, 3].map(ReviewCountKind.init(state:)), [.new, .learning, .review, .learning])
    }
}
