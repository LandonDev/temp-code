@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// §27.9: a target by its name.
@Suite struct NamedTargetTests {
    func c(_ id: NodeID, _ name: String, actionable: Bool = true, appeared: Bool = false) -> NamedTarget.Candidate {
        NamedTarget.Candidate(id: id, name: name, actionable: actionable, madeAppear: appeared)
    }

    @Test func whatTheCallMadeAppearComesFirst() {
        let all = [c(1, "Team"), c(2, "Team", appeared: true)]
        #expect(NamedTarget.match("Team", among: all) == .one(all[1]))
    }

    @Test func exactBeforeCaseBlind() {
        let all = [c(1, "team"), c(2, "Team")]
        #expect(NamedTarget.match("Team", among: all) == .one(all[1]))
        #expect(NamedTarget.match("TEAM", among: all) == .several(all))
        #expect(NamedTarget.match("TEAM", among: [all[0]]) == .one(all[0]))
    }

    @Test func anActionableElementWinsOverItsLabel() {
        let all = [c(1, "Name", actionable: false), c(2, "Name")]
        #expect(NamedTarget.match("Name", among: all) == .one(all[1]))
    }

    @Test func severalOfEqualRankRefuseWithAtMostFive() {
        let all = (1...7).map { c(NodeID($0), "Delete") }
        #expect(NamedTarget.match("Delete", among: all) == .several(Array(all.prefix(5))))
    }

    @Test func noneIsNone() {
        #expect(NamedTarget.match("Missing", among: [c(1, "Team")]) == .none)
        #expect(NamedTarget.match("  ", among: [c(1, " ")]) == .none)
    }

    @Test func threeDotsFindAnEllipsis() {
        let all = [c(1, "Save…")]
        #expect(NamedTarget.match("Save...", among: all) == .one(all[0]))
        #expect(NamedTarget.match(" save… ", among: all) == .one(all[0]))
    }

    /// The recorded chrome/menu-open: the Size pop up's menu is open; its items are named, the pop up's own copies are values.
    @Test func theRecordedOpenMenusItemsResolveByName() throws {
        let s = try Goldens.snapshot("chrome/menu-open", ids: NodeIDSource())
        let window = s.roots[0]
        let menu = try #require(first(window) { $0.role == "AXMenu" && $0.children.contains { ($0.title ?? $0.description) == "Large" } })
        let candidates = NamedTarget.candidates(menu, madeAppear: true) + NamedTarget.candidates(window, madeAppear: false)
        guard case .one(let large) = NamedTarget.match("large", among: candidates) else { Issue.record("one Large"); return }
        #expect(large.madeAppear && large.name == "Large")
        guard case .one(let size) = NamedTarget.match("Size", among: candidates) else { Issue.record("one Size"); return }
        #expect(!size.madeAppear)
        #expect(NamedTarget.match("Extra large", among: candidates) == .none)
    }

    @Test func aPasswordFieldIsMarkedAndAClosedMenusItemsAreNoCandidates() {
        let t = Tree()
        let closed = t.node("AXMenu", frame: Rect(x: 0, y: 0, w: 0, h: 0), [t.node("AXMenuItem", title: "Hidden", frame: Rect(x: 0, y: 0, w: 0, h: 0), actions: ["AXPress"])])
        let window = t.window([
            t.node("AXTextField", "AXSecureTextField", description: "Password", frame: Rect(x: 10, y: 40, w: 100, h: 20)),
            t.node("AXPopUpButton", description: "Plan", frame: Rect(x: 10, y: 70, w: 100, h: 20), actions: ["AXPress"], [closed])
        ])
        let candidates = NamedTarget.candidates(window, madeAppear: false)
        #expect(candidates.map(\.name) == ["Untitled", "Password", "Plan"])
        #expect(candidates.first { $0.name == "Password" }?.secure == true)
    }
}
