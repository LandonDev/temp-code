import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

private func posting(_ plan: [SyntheticEvent]) -> [SyntheticEvent] { plan.filter(\.posts) }

private func clickStates(_ plan: [SyntheticEvent]) -> [Int] {
    plan.compactMap { if case .down(_, _, let s, _) = $0 { s } else { nil } }
}

@Suite struct EventPlanTests {
    let p = pt(10, 20)

    @Test func clicksCountTheirPresses() {
        #expect(clickStates(EventPlans.click(.left, at: p, count: 1, modifiers: [], holdMs: nil, moveFirst: false)) == [1])
        #expect(clickStates(EventPlans.click(.left, at: p, count: 2, modifiers: [], holdMs: nil, moveFirst: false)) == [1, 2])
        #expect(clickStates(EventPlans.click(.left, at: p, count: 3, modifiers: [], holdMs: nil, moveFirst: false)) == [1, 2, 3])
        let double = EventPlans.click(.left, at: p, count: 2, modifiers: [], holdMs: nil, moveFirst: false)
        #expect(double.contains(.pause(ms: InputTiming.multiClickGapMs)))
    }

    @Test func eachButton() {
        for b in [MouseButton.left, .right, .middle] {
            let plan = posting(EventPlans.click(b, at: p, count: 1, modifiers: [], holdMs: nil, moveFirst: false))
            #expect(plan == [.down(b, p, clickState: 1, flags: []), .up(b, p, clickState: 1, flags: [])])
        }
    }

    @Test func aHeldClickPausesItsDuration() {
        let plan = EventPlans.click(.left, at: p, count: 1, modifiers: [], holdMs: 2_500, moveFirst: false)
        #expect(plan == [.down(.left, p, clickState: 1, flags: []), .pause(ms: 2_500), .up(.left, p, clickState: 1, flags: [])])
        #expect(EventPlans.click(.left, at: p, count: 1, modifiers: [], holdMs: nil, moveFirst: false).contains(.pause(ms: InputTiming.clickHoldMs)))
    }

    @Test func modifiersWrapDownBeforeAndUpAfter() {
        let plan = posting(EventPlans.click(.left, at: p, count: 1, modifiers: [.shift, .command], holdMs: nil, moveFirst: false))
        #expect(plan == [
            .modifier(56, down: true, flags: .shift),
            .modifier(55, down: true, flags: [.shift, .command]),
            .down(.left, p, clickState: 1, flags: [.shift, .command]),
            .up(.left, p, clickState: 1, flags: [.shift, .command]),
            .modifier(55, down: false, flags: .shift),
            .modifier(56, down: false, flags: [])
        ])
    }

    @Test func aSessionClickMovesFirst() {
        let plan = EventPlans.click(.left, at: p, count: 1, modifiers: [], holdMs: nil, moveFirst: true)
        #expect(plan.first == .move(p, dragging: nil))
    }

    @Test func aDragGoesStraightFromEndToEnd() {
        let a = pt(0, 0), b = pt(120, 60)
        let plan = EventPlans.drag(from: a, to: b, modifiers: [])
        #expect(plan.first == .down(.left, a, clickState: 1, flags: []))
        #expect(plan.last == .up(.left, b, clickState: 1, flags: []))
        let moves = plan.compactMap { if case .move(let q, .left?) = $0 { q } else { nil } }
        #expect(moves.count == InputTiming.dragSteps)
        #expect(moves.last == b)
        #expect(zip(moves, moves.dropFirst()).allSatisfy { $0.x < $1.x && $0.y < $1.y })
    }

    @Test func scrollSignsAndAxes() {
        func first(_ d: ScrollDirection) -> SyntheticEvent? { EventPlans.scroll(d, clicks: 1, at: p, modifiers: []).first }
        #expect(first(.up) == .scroll(lines: 1, axis: .vertical, at: p, flags: []))
        #expect(first(.down) == .scroll(lines: -1, axis: .vertical, at: p, flags: []))
        #expect(first(.left) == .scroll(lines: 1, axis: .horizontal, at: p, flags: []))
        #expect(first(.right) == .scroll(lines: -1, axis: .horizontal, at: p, flags: []))
        let three = EventPlans.scroll(.down, clicks: 3, at: p, modifiers: [])
        #expect(posting(three).count == 3)
        #expect(three.filter { $0 == .pause(ms: InputTiming.scrollGapMs) }.count == 2)
    }

    @Test func aChordRepeats() throws {
        let plan = try EventPlans.chord(parseKeyCombo("ctrl+s"), layout: USANSILayout(), repeat: 2)
        #expect(plan == [
            .modifier(59, down: true, flags: .control),
            .key(1, down: true, flags: .control), .key(1, down: false, flags: .control),
            .key(1, down: true, flags: .control), .key(1, down: false, flags: .control),
            .modifier(59, down: false, flags: [])
        ])
    }

    @Test func aChordAddsTheShiftItsCharacterNeeds() throws {
        let plan = try EventPlans.chord(parseKeyCombo("super+?"), layout: USANSILayout(), repeat: 1)
        #expect(plan.contains(.key(44, down: true, flags: [.shift, .command])))
    }

    @Test func aBareCharacterWithNoKeyIsUnicodeAndRefusedWithModifiers() throws {
        let plan = try EventPlans.chord(parseKeyCombo("é"), layout: USANSILayout(), repeat: 1)
        #expect(plan == [.unicode("é", down: true), .unicode("é", down: false)])
        #expect(throws: ComputerFailure.self) { try EventPlans.chord(parseKeyCombo("ctrl+é"), layout: USANSILayout(), repeat: 1) }
    }

    @Test func aModifierAloneIsItsOwnKey() throws {
        let plan = try EventPlans.chord(parseKeyCombo("shift"), layout: USANSILayout(), repeat: 1)
        #expect(plan == [.modifier(56, down: true, flags: .shift), .modifier(56, down: false, flags: [])])
    }

    @Test func aHoldSplitsItsDownsAndUps() throws {
        let (downs, ups) = try EventPlans.hold(parseKeyCombo("ctrl+a"), layout: USANSILayout())
        #expect(downs == [.modifier(59, down: true, flags: .control), .key(0, down: true, flags: .control)])
        #expect(ups == [.key(0, down: false, flags: .control), .modifier(59, down: false, flags: [])])
        let shift = try EventPlans.hold(parseKeyCombo("shift"), layout: USANSILayout())
        #expect(shift.downs == [.modifier(56, down: true, flags: .shift)])
    }

    @Test func typingChunksAtTwentyUnits() {
        let text = String(repeating: "abcde", count: 9) // 45
        let chunks = EventPlans.typing(text).compactMap { if case .unicode(let s, true) = $0 { s } else { nil } }
        #expect(chunks.map(\.utf16.count) == [20, 20, 5])
        #expect(chunks.joined() == text)
    }

    @Test func typingNeverSplitsAGraphemeCluster() {
        let family = "👨‍👩‍👧‍👦" // 11 UTF-16 units, one cluster
        let text = "abcdefghij" + family + family
        let chunks = EventPlans.typing(text).compactMap { if case .unicode(let s, true) = $0 { s } else { nil } }
        #expect(chunks.joined() == text)
        #expect(chunks.allSatisfy { $0.utf16.count <= 20 })
        #expect(chunks.allSatisfy { !$0.unicodeScalars.contains("\u{200D}") || $0.contains(family) })
    }

    @Test func lineBreaksAndTabsAreRealKeys() {
        let downs = { (t: String) in EventPlans.typing(t).filter { if case .key(_, true, _) = $0 { true } else if case .unicode(_, true) = $0 { true } else { false } } }
        #expect(downs("a\nb") == [.unicode("a", down: true), .key(36, down: true, flags: []), .unicode("b", down: true)])
        #expect(downs("a\r\nb") == [.unicode("a", down: true), .key(36, down: true, flags: []), .unicode("b", down: true)])
        #expect(downs("\t") == [.key(48, down: true, flags: [])])
    }
}

@Suite struct EvidenceTests {
    let r = TextRange(location: 3, length: 0)

    @Test func anEqualLengthReplacementIsChangedByTheHashOrTheRange() {
        #expect(Evidence.compare(before: Evidence(value: "abc", range: r, count: 3), after: Evidence(value: "abd", range: r, count: 3)) == .changed)
        #expect(Evidence.compare(before: Evidence(valueHash: nil, range: r, count: 3), after: Evidence(valueHash: nil, range: TextRange(location: 4, length: 0), count: 3)) == .changed)
    }

    @Test func noneNeedsTheValueReadable() {
        #expect(Evidence.compare(before: Evidence(value: "abc", range: r, count: 3), after: Evidence(value: "abc", range: r, count: 3)) == .none)
        #expect(Evidence.compare(before: Evidence(value: "abc", range: nil, count: nil), after: Evidence(value: "abc", range: nil, count: nil)) == .none)
        // a count-only element with an unchanged count proves nothing
        #expect(Evidence.compare(before: Evidence(count: 3), after: Evidence(count: 3)) == .unknown)
        #expect(Evidence.compare(before: Evidence(), after: Evidence()) == .unknown)
    }

    @Test func onlyNoneLeadsToThePasteRung() {
        #expect(TypingRoute.pasteAfterKeys(.none))
        #expect(!TypingRoute.pasteAfterKeys(.unknown))
        #expect(!TypingRoute.pasteAfterKeys(.changed))
    }

    @Test func longTextAndLongClustersGoStraightToPaste() {
        #expect(TypingRoute.route("hello") == .keys)
        #expect(TypingRoute.route(String(repeating: "a", count: 2_000)) == .keys)
        #expect(TypingRoute.route(String(repeating: "a", count: 2_001)) == .paste)
        let long = "e" + String(repeating: "\u{0301}", count: 25) // one cluster of 26 units
        #expect(long.count == 1)
        #expect(TypingRoute.route("hi " + long) == .paste)
    }
}

@Suite struct PersonWatchTests {
    @Test func tellsThePersonFromUs() {
        for t in WatchedEventType.allCases {
            #expect(isPersonEvent(userData: 0, type: t.rawValue))
            #expect(isPersonEvent(userData: 42, type: t.rawValue))
            #expect(!isPersonEvent(userData: TC_EVENT_MARK, type: t.rawValue))
        }
        // a key-up or a mouse-up is not watched
        #expect(!isPersonEvent(userData: 0, type: 11))
        #expect(!isPersonEvent(userData: 0, type: 2))
        #expect(TC_EVENT_MARK == 0x7463_6370)
    }
}
