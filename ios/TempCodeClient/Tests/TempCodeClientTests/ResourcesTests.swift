import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func row(_ id: String, sessionId: String = "s1", environmentId: String = "env_test", kind: ThreadResourceKind = .worktree, label: String = "ios/home", removeRequestedAt: Int? = nil, removedAt: Int? = nil, note: String? = nil) -> ThreadResource {
    ThreadResource(id: id, sessionId: sessionId, environmentId: environmentId, kind: kind, identifier: "/wt/\(id)", label: label, branch: nil, createdAt: 1, removeRequestedAt: removeRequestedAt, removedAt: removedAt, note: note)
}

private func paired(_ id: String, name: String) -> PairedEnvironment {
    PairedEnvironment(id: id, name: name, origin: URL(string: "https://\(id).example")!, caps: [.read], keyId: "K", keyName: "k", addedAt: 0)
}

@MainActor
@Suite struct ResourceLedgerTests {
    @Test func `a push replaces the thread's rows and live drops the removed ones`() {
        let ledger = ResourceLedger()
        ledger.apply(ResourcesPush(sessionId: "s1", resources: [row("a"), row("b", removedAt: 5)]))
        #expect(ledger.bySession["s1"]?.map(\.id) == ["a", "b"])
        #expect(ledger.live(for: "s1").map(\.id) == ["a"])
        ledger.apply(ResourcesPush(sessionId: "s1", resources: [row("c")]))
        #expect(ledger.live(for: "s1").map(\.id) == ["c"], "the push is the whole ledger of that thread")
        #expect(ledger.live(for: "none").isEmpty)
    }

    @Test func `countHeld sums the live rows of the named threads`() {
        let ledger = ResourceLedger()
        ledger.apply(ResourcesPush(sessionId: "s1", resources: [row("a"), row("b", removedAt: 5)]))
        ledger.apply(ResourcesPush(sessionId: "s2", resources: [row("c", sessionId: "s2"), row("d", sessionId: "s2")]))
        #expect(ledger.countHeld(by: ["s1", "s2", "s3"]) == 3)
        #expect(ledger.countHeld(by: []) == 0)
    }

    @Test func `a push clears the removing mark of the rows it carries`() {
        let ledger = ResourceLedger()
        ledger.markRemoving(["a", "z"])
        #expect(ledger.removing == ["a", "z"])
        ledger.apply(ResourcesPush(sessionId: "s1", resources: [row("a", removedAt: 5)]))
        #expect(ledger.removing == ["z"])
        ledger.unmarkRemoving(["z"])
        #expect(ledger.removing.isEmpty)
    }
}

@Suite struct ResourceWordsTests {
    @Test func `the removal clause names the count and the hosts`() {
        let here = paired("env_test", name: "box")
        let names = { (id: String) in ResourceWords.hostName(id, here: here, paired: [here, paired("env_mac", name: "Landon's Mac")]) }
        #expect(ResourceWords.removalClause([row("a", environmentId: "env_mac"), row("b", environmentId: "env_mac")], hostName: names) == "and remove 2 resources on Landon's Mac")
        #expect(ResourceWords.removalClause([row("a", environmentId: "env_mac"), row("b"), row("c")], hostName: names) == "and remove 3 resources on Landon's Mac and box")
        #expect(ResourceWords.removalClause([row("a")], hostName: names) == "and remove 1 resource on box")
        #expect(ResourceWords.removalClause([], hostName: names) == "")
    }

    @Test func `a host heading is capitalized, the unknown host too`() {
        let here = paired("env_test", name: "box")
        #expect(ResourceWords.hostHeading("env_test", here: here, paired: [here]) == "Box")
        #expect(ResourceWords.hostHeading("env_gone", here: here, paired: [here]) == "The Mac")
        #expect(ResourceWords.hostName("env_gone", here: here, paired: [here]) == "the Mac", "mid-sentence it stays lower case")
    }

    @Test func `a row's state word`() {
        #expect(ResourceWords.rowState(row("a", removeRequestedAt: 1, removedAt: 2)) == "removed")
        #expect(ResourceWords.rowState(row("a", removeRequestedAt: 1, removedAt: 2, note: "branch ios/home kept: 2 commits ahead of its upstream")) == "branch ios/home kept: 2 commits ahead of its upstream")
        #expect(ResourceWords.rowState(row("a", removeRequestedAt: 1)) == "removing…")
        #expect(ResourceWords.rowState(row("a", removeRequestedAt: 1, note: "host offline, waiting for its link")) == "host offline, waiting for its link")
        #expect(ResourceWords.rowState(row("a", note: "a note")) == "a note")
        #expect(ResourceWords.rowState(row("a")) == nil)
    }

    @Test func `a row waits when removal was asked for and has not landed`() {
        #expect(ResourceWords.isWaiting(row("a", removeRequestedAt: 1)))
        #expect(ResourceWords.isWaiting(row("a", removeRequestedAt: 1, removedAt: 2)) == false)
        #expect(ResourceWords.isWaiting(row("a")) == false)
    }

    @Test func `the host's name: this host, a paired host, else the Mac`() {
        let here = paired("env_test", name: "box")
        let mac = paired("env_mac", name: "Landon's Mac")
        #expect(ResourceWords.hostName("env_test", here: here, paired: [here, mac]) == "box")
        #expect(ResourceWords.hostName("env_mac", here: here, paired: [here, mac]) == "Landon's Mac")
        #expect(ResourceWords.hostName("env_other", here: here, paired: [here, mac]) == "the Mac")
    }

    @Test func `every kind has a label and a symbol`() {
        #expect(ResourceWords.kindLabel(.worktree) == "worktree")
        #expect(ResourceWords.kindLabel(.simulator) == "simulator")
        #expect(ResourceWords.kindLabel(.devInstance) == "dev instance")
        #expect(ResourceWords.kindLabel(.port) == "dev server")
        #expect(ResourceWords.kindLabel(.unknown("vm")) == "vm")
        #expect(ResourceWords.symbol(.worktree) == "arrow.triangle.pull")
        #expect(ResourceWords.symbol(.simulator) == "iphone")
        #expect(ResourceWords.symbol(.devInstance) == "macwindow")
        #expect(ResourceWords.symbol(.unknown("vm")) == "shippingbox")
    }
}
