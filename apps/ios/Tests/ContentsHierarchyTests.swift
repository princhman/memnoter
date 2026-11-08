import XCTest
@testable import Memnoter

final class ContentsHierarchyTests: XCTestCase {
    func testImmediateLevelsAndReadingBranchUseIDsWithSkippedLevelsAndRepeatedTitles() {
        let tree = ContentsHierarchy([
            Heading(id: "a", level: 1, text: "Same title"),
            Heading(id: "b", level: 3, text: "Same title"),
            Heading(id: "c", level: 5, text: "Deep"),
            Heading(id: "d", level: 2, text: "Sibling"),
            Heading(id: "e", level: 1, text: "Other")
        ])
        XCTAssertEqual(tree.roots.map(\.id), ["a", "e"])
        XCTAssertEqual(tree.children["a"]?.map(\.id), ["b", "d"])
        XCTAssertEqual(tree.children["b"]?.map(\.id), ["c"])
        XCTAssertEqual(tree.ancestors(of: "c").map(\.id), ["a", "b"])
        XCTAssertTrue(tree.containsReadingSection(tree.byID["a"]!, current: "c"))
        XCTAssertTrue(tree.containsReadingSection(tree.byID["b"]!, current: "c"))
        XCTAssertFalse(tree.containsReadingSection(tree.byID["d"]!, current: "c"))
    }

    func testLargeOutlineKeepsEachLevelBoundedToImmediateChildren() {
        let headings = (0..<3_000).flatMap { index in
            [Heading(id: "root-\(index)", level: 1, text: "Chapter \(index)"),
             Heading(id: "child-\(index)", level: 2, text: "Section"),
             Heading(id: "leaf-\(index)", level: 3, text: "Details")]
        }
        let tree = ContentsHierarchy(headings)
        XCTAssertEqual(tree.roots.count, 3_000)
        XCTAssertEqual(tree.children["root-2800"]?.map(\.id), ["child-2800"])
        XCTAssertEqual(tree.children["child-2800"]?.map(\.id), ["leaf-2800"])
        XCTAssertEqual(tree.ancestors(of: "leaf-2800").map(\.id), ["root-2800", "child-2800"])
    }
}
