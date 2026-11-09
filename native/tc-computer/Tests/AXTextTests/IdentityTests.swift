@testable import AXText
import ComputerProtocol
import Testing

/// A page of items under a web area, built in its own id space: a fresh `Tree` per call is a rebuild.
/// Twenty paragraphs after the items keep one change a small share of the text, as on a real page.
func page(_ t: Tree, _ items: [(name: String, dom: String?)], window: NodeID = 900, area: NodeID? = 901, value: String? = nil) -> AXSnapshot {
    var kids = items.enumerated().map { i, item in t.node("AXButton", title: item.name, dom: item.dom, frame: r(Double(i) * 30), actions: ["AXPress"]) }
    if let value { kids.append(t.node("AXTextField", title: "Field", value: .string(value), dom: "field", frame: r(400), settable: ["AXValue"])) }
    return snapshot([t.window(id: window, [t.node("AXWebArea", id: area, title: "Page", frame: windowFrame, kids + filler())])])
}

/// Twenty paragraphs with ids of their own, the same in every call.
func filler() -> [AXNode] {
    (0..<20).map { i in Tree(start: 100_000 + NodeID(i)).node("AXStaticText", value: .string("Paragraph \(i) of the scratch page, long enough to read like one."), frame: r(420)) }
}

/// index → the line after it, from a full text.
func numbers(_ text: String) -> [String: Int] {
    var out: [String: Int] = [:]
    for line in text.split(separator: "\n") {
        let s = line.drop { $0 == " " }
        guard s.hasPrefix("["), let close = s.firstIndex(of: "]"), let n = Int(s.dropFirst().prefix { $0.isNumber }) else { continue }
        out[String(s[s.index(close, offsetBy: 2)...])] = n
    }
    return out
}

@Suite struct IdentityTests {
    @Test func theSameElementKeepsItsNumberAcrossReads() {
        let t = Tree()
        let a = t.node("AXButton", title: "A", frame: r(0), actions: ["AXPress"])
        let s = snapshot([t.window(id: 900_000, [a, t.node("AXButton", title: "B", frame: r(30), actions: ["AXPress"])])])
        let reader = Reader()
        #expect(reader.read(s).kind == .full)
        #expect(reader.read(s).kind == .unchanged)
        #expect(reader.book.index(of: a.id) == 2)
    }

    @Test func aRemovedNumberNeverComesBackForAnotherElement() {
        let reader = Reader()
        let first = numbers(reader.read(page(Tree(), [("A", nil), ("B", nil)])).text)
        #expect(first["button \"B\""] == 4)
        reader.read(page(Tree(start: 1000), [("A", nil)]))
        let third = reader.read(page(Tree(start: 2000), [("A", nil), ("B", nil)]))
        #expect(third.text.hasSuffix("\n+ in [2]:\n  [25] button \"B\""))
    }

    @Test func aRebuiltElementKeepsItsNumberByDOMIdOrByRoleNameAndPlace() {
        let reader = Reader()
        let items: [(name: String, dom: String?)] = [("One", "one"), ("Two", "two"), ("Three", nil), ("Four", nil)]
        let first = reader.read(page(Tree(), items))
        let again = reader.read(page(Tree(start: 1000), items))
        #expect(again.kind == .unchanged)
        #expect(numbers(first.text) == numbers(reader.read(page(Tree(start: 2000), items), mode: .full).text))
    }

    @Test func aDOMIdOnOneSideAloneIsNoMatch() {
        let reader = Reader()
        let before = numbers(reader.read(page(Tree(), [("One", "one")])).text)["button \"One\""]!
        let built = reader.read(page(Tree(start: 1000), [("One", nil)]))
        #expect(built.kind == .diff)
        #expect(built.text.contains("- [\(before)] button \"One\"\n+ in [2]:\n  [24] button \"One\""))
    }

    @Test func aRepeatedDOMIdOnEitherSideMatchesNothing() {
        let reader = Reader()
        let first = numbers(reader.read(page(Tree(), [("A", "dup"), ("B", "dup")])).text)
        let after = numbers(reader.read(page(Tree(start: 1000), [("A", "dup"), ("B", "dup")]), mode: .full).text)
        #expect(Set(first.values).isDisjoint(with: [after["button \"A\""]!, after["button \"B\""]!]))

        let solo = Reader()
        let one = numbers(solo.read(page(Tree(), [("A", "x")])).text)["button \"A\""]!
        let two = numbers(solo.read(page(Tree(start: 1000), [("A", "x"), ("A2", "x")]), mode: .full).text)
        #expect(two["button \"A\""] != one && two["button \"A2\""] != one)
    }

    @Test func aSurvivorUnderARebuiltParentKeepsItsNumberAndTheReadIsUnchanged() {
        let reader = Reader()
        let kept = Tree(start: 5000).node("AXButton", title: "Keep", frame: r(0), actions: ["AXPress"])
        func read(_ t: Tree) -> Built { reader.read(snapshot([t.window(id: 900_000, [t.node("AXGroup", title: "Panel", frame: r(0), [kept])])])) }
        _ = read(Tree())
        #expect(read(Tree(start: 1000)).kind == .unchanged)
    }

    @Test func rebuiltRowsThatSwapPlacesForceAFullRead() {
        let reader = Reader()
        reader.read(page(Tree(), [("A", "a"), ("B", "b")]))
        let swapped = reader.read(page(Tree(start: 1000), [("B", "b"), ("A", "a")]))
        #expect(swapped.kind == .full && swapped.fullReason == .reordered)
    }

    @Test func aShiftedPositionOrAnotherParentGetsANewNumber() {
        let reader = Reader()
        let first = numbers(reader.read(page(Tree(), [("A", nil), ("B", nil)])).text)
        let shifted = numbers(reader.read(page(Tree(start: 1000), [("New", nil), ("A", nil), ("B", nil)]), mode: .full).text)
        #expect(shifted["button \"A\""] != first["button \"A\""] && shifted["button \"B\""] != first["button \"B\""])

        let other = Reader()
        let t = Tree()
        let one = numbers(other.read(snapshot([t.window(id: 900_000, [t.node("AXGroup", title: "G1", frame: r(0), [t.node("AXButton", title: "X", frame: r(0), actions: ["AXPress"])]), t.node("AXGroup", title: "G2", frame: r(30))])])).text)
        let u = Tree(start: 1000)
        let two = numbers(other.read(snapshot([u.window(id: 900_000, [u.node("AXGroup", title: "G1", frame: r(0)), u.node("AXGroup", title: "G2", frame: r(30), [u.node("AXButton", title: "X", frame: r(30), actions: ["AXPress"])])])]), mode: .full).text)
        #expect(two["button \"X\""] != one["button \"X\""])
    }

    @Test func anIdenticalControlPutInFrontNeverTakesTheSurvivorsNumber() {
        let reader = Reader()
        let t = Tree()
        let survivor = t.node("AXButton", frame: r(0), actions: ["AXPress"])
        reader.read(snapshot([t.window(id: 900_000, [survivor] + filler())]))
        let twin = Tree(start: 1000).node("AXButton", frame: r(0), actions: ["AXPress"])
        let built = reader.read(snapshot([t.window(id: 900_000, [twin, survivor] + filler())]))
        #expect(reader.book.index(of: survivor.id) == 2)
        #expect(reader.book.index(of: twin.id) == 23)
        #expect(built.kind == .diff && built.text.hasSuffix("\n+ in [1]:\n  [23] button"))
    }

    @Test func aMatchedElementWithANewValueIsAChangeOnItsNumber() {
        let reader = Reader()
        let first = numbers(reader.read(page(Tree(), [("A", "a")], value: "old")).text)
        let n = first.first { $0.key.hasPrefix("input") }!.value
        let built = reader.read(page(Tree(start: 1000), [("A", "a")], value: "new"))
        #expect(built.kind == .diff)
        #expect(built.text.hasSuffix("\n~ [\(n)] input \"Field\" = \"new\""))
    }

    @Test func aMoveOrANewOrderOfTheSameElementsForcesAFullRead() {
        let t = Tree()
        let a = t.node("AXButton", title: "A", frame: r(0), actions: ["AXPress"])
        let b = t.node("AXButton", title: "B", frame: r(30), actions: ["AXPress"])
        let g = t.node("AXGroup", id: 50, title: "G", frame: r(60))
        let moved = Reader()
        moved.read(snapshot([t.window(id: 900_000, [a, b, g])]))
        var gWithA = g
        gWithA.children = [a]
        #expect(moved.read(snapshot([t.window(id: 900_000, [b, gWithA])])).fullReason == .moved)
        let order = Reader()
        order.read(snapshot([t.window(id: 900_000, [a, b])]))
        #expect(order.read(snapshot([t.window(id: 900_000, [b, a])])).fullReason == .reordered)
    }

    @Test func theAllocatorCountsOnAcrossAPidChange() {
        let shared = IndexAllocator()
        let first = numbers(Reader(allocator: shared).read(page(Tree(), [("A", nil)])).text).values.max()!
        let next = numbers(Reader(allocator: shared).read(page(Tree(start: 1000), [("A", nil)])).text)
        #expect(next["window \"Untitled\""] == first + 1)
        #expect(shared.issued(first) && !shared.issued(2 * first + 2))
    }

    @Test func pastCapacityTheEntriesSeenLongestAgoGo() {
        let reader = Reader(capacity: 4)
        let t = Tree()
        reader.read(snapshot([t.window(id: 900, [t.node("AXButton", title: "A", frame: r(0), actions: ["AXPress"]), t.node("AXButton", title: "B", frame: r(30), actions: ["AXPress"])])]))
        let u = Tree(start: 1000)
        reader.read(snapshot([u.window(id: 900, [u.node("AXButton", title: "C", frame: r(0), actions: ["AXPress"]), u.node("AXButton", title: "D", frame: r(30), actions: ["AXPress"])])]), mode: .full)
        #expect(reader.book.count == 4)
        let gone = (1...5).filter { reader.book.id(of: $0) == nil }
        #expect(gone.count == 1 && [2, 3].contains(gone[0]))
        #expect(reader.book.issued(gone[0]))
    }
}
