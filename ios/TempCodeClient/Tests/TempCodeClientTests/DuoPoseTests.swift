import Foundation
import Testing
@testable import TempCodeClient

/// The pose table docs/IOS-DESIGN.md "iPhone Duo" prints, inverted and back.
@Suite struct DuoPoseTests {
    @Test(arguments: DuoPose.allCases)
    func `every row round-trips through classify`(pose: DuoPose) {
        let e = pose.expected
        let hinge: DuoPose.HingeState? = pose == .halfOpen ? .partiallyOpen : (e.width > 700 || e.height > 700 ? .fullyOpen : .closed)
        #expect(DuoPose.classify(width: e.width, height: e.height, horizontal: e.horizontal, vertical: e.vertical, hinge: hinge) == pose)
        #expect(DuoPose(tag: pose.rawValue) == pose)
        #expect(DuoPose(tag: pose.alias) == pose)
        #expect(DuoPose.isDuoWindow(width: e.width, height: e.height))
    }

    @Test func `the aliases are plan 3's shot vocabulary`() {
        #expect(DuoPose.allCases.map(\.alias) == ["fp", "fl", "ul", "up", "ho"])
        #expect(DuoPose(tag: "fp") == .folded)
        #expect(DuoPose(tag: "up") == .unfoldedPortrait)
    }

    @Test func `a 27.0-linked window loses the 80 pt rail and classifies as nothing`() {
        #expect(DuoPose.classify(width: 871, height: 669, horizontal: .regular, vertical: .regular, hinge: .fullyOpen) == nil)
        #expect(DuoPose.classify(width: 386, height: 678, horizontal: .compact, vertical: .regular, hinge: .closed) == nil)
        #expect(!DuoPose.isDuoWindow(width: 871, height: 669))
        // An ordinary iPhone 17 Pro.
        #expect(DuoPose.classify(width: 402, height: 874, horizontal: .compact, vertical: .regular, hinge: nil) == nil)
    }

    @Test func `half-open needs the hinge; the open window alone is unfolded`() {
        #expect(DuoPose.classify(width: 951, height: 669, horizontal: .regular, vertical: .regular, hinge: nil) == .unfolded)
        #expect(DuoPose.classify(width: 951, height: 669, horizontal: .regular, vertical: .regular, hinge: .fullyOpen) == .unfolded)
        #expect(DuoPose.classify(width: 951, height: 669, horizontal: .regular, vertical: .regular, hinge: .partiallyOpen) == .halfOpen)
        // Turned while half open: the inner panel's portrait window, not a pose of the table.
        #expect(DuoPose.classify(width: 669, height: 951, horizontal: .regular, vertical: .regular, hinge: .partiallyOpen) == .unfoldedPortrait)
    }

    @Test func `the size classes must agree with the window`() {
        #expect(DuoPose.classify(width: 466, height: 678, horizontal: .regular, vertical: .regular, hinge: .closed) == nil)
        #expect(DuoPose.classify(width: 678, height: 466, horizontal: .compact, vertical: .regular, hinge: .closed) == nil)
    }

    @Test func `an unknown tag is nil`() {
        #expect(DuoPose(tag: "sideways") == nil)
        #expect(DuoPose(tag: "") == nil)
        #expect(DuoPose(tag: "Folded") == nil)
    }

    @Test func `the lit panel follows the hinge, the capture size the window`() {
        #expect(DuoPose.folded.expected.panel == "LCD" && DuoPose.folded.expected.displayId == 1)
        #expect(DuoPose.halfOpen.expected.panel == "LCD-1" && DuoPose.halfOpen.expected.displayId == 3)
        for pose in DuoPose.allCases {
            let e = pose.expected
            #expect((e.width * 3).rounded() == e.width * 3 && (e.height * 3).rounded() == e.height * 3)
        }
    }
}
