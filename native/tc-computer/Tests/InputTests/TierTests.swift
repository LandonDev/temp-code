import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

private let all: [Tier] = [.ax, .process, .session]
private let button = ElementFacts(role: "button", actions: ["AXPress", "AXShowMenu"])

@Suite struct TierPlanTests {
    @Test func aPlainClickOnAPressableElementIsAX() {
        let click = ComputerAction(action: .leftClick, element: 3)
        #expect(chooseTier(click, element: button, tiers: all, held: nil) == .run(.ax, exact: true))
        #expect(chooseTier(click, element: ElementFacts(role: "group"), tiers: all, held: nil) == .run(.process, exact: true))
        // modifiers or a hold take the click off AX
        #expect(chooseTier(ComputerAction(action: .leftClick, element: 3, text: "shift"), element: button, tiers: all, held: nil) == .run(.process, exact: true))
        #expect(chooseTier(ComputerAction(action: .leftClick, element: 3, duration: 1), element: button, tiers: all, held: nil) == .run(.process, exact: true))
        // a row without AXPress selects through its table
        let row = ElementFacts(role: "row", selectableRow: true)
        #expect(chooseTier(click, element: row, tiers: all, held: nil) == .run(.ax, exact: true))
    }

    @Test func rightAndDoubleClicksNeedTheirAXActions() {
        #expect(chooseTier(ComputerAction(action: .rightClick, element: 1), element: button, tiers: all, held: nil) == .run(.ax, exact: true))
        #expect(chooseTier(ComputerAction(action: .rightClick, element: 1), element: ElementFacts(role: "button", actions: ["AXPress"]), tiers: all, held: nil) == .run(.process, exact: true))
        let file = ElementFacts(role: "row", actions: ["AXOpen"])
        #expect(chooseTier(ComputerAction(action: .doubleClick, element: 1), element: file, tiers: all, held: nil) == .run(.ax, exact: true))
        #expect(chooseTier(ComputerAction(action: .doubleClick, element: 1), element: button, tiers: all, held: nil) == .run(.process, exact: true))
    }

    @Test func pointerOnlyVerbsStartAtProcess() {
        for a in [ComputerActionName.middleClick, .tripleClick, .mouseMove, .leftMouseDown, .leftMouseUp, .key, .holdKey, .paste] {
            #expect(chooseTier(ComputerAction(action: a, element: 1, text: "a"), element: button, tiers: all, held: nil) == .run(.process, exact: true), "\(a)")
            #expect(chooseTier(ComputerAction(action: a, text: "a"), element: nil, tiers: [.ax], held: nil) == .needs(.process), "\(a)")
        }
        let drag = ComputerAction(action: .leftClickDrag, coordinate: [5, 5], start_coordinate: [1, 1])
        #expect(chooseTier(drag, element: nil, tiers: [.session], held: nil) == .run(.session, exact: true))
    }

    @Test func pageScrollsAreTakenOnlyWhenNoExactTierIs() {
        let area = ElementFacts(role: "scroll area", pageScrolls: ["AXScrollDownByPage"])
        let down = ComputerAction(action: .scroll, element: 2, scroll_direction: .down, scroll_amount: 10)
        #expect(chooseTier(down, element: area, tiers: all, held: nil) == .run(.process, exact: true))
        #expect(chooseTier(down, element: area, tiers: [.ax], held: nil) == .run(.ax, exact: false))
        #expect(chooseTier(down, element: area, tiers: [.ax, .session], held: nil) == .run(.session, exact: true))
        let up = ComputerAction(action: .scroll, element: 2, scroll_direction: .up, scroll_amount: 1)
        #expect(chooseTier(up, element: area, tiers: [.ax], held: nil) == .needs(.process))
        #expect(pagesFor(amount: 1) == 1)
        #expect(pagesFor(amount: 10) == 2)
        #expect(pagesFor(amount: 12) == 2)
    }

    @Test func typeIsAXWhenTheElementTakesInsertOrAWholeValue() {
        let type = ComputerAction(action: .type, element: 4, text: "hi")
        #expect(chooseTier(type, element: ElementFacts(role: "input", settable: ["AXSelectedText"]), tiers: all, held: nil) == .run(.ax, exact: true))
        #expect(chooseTier(type, element: ElementFacts(role: "input", settable: ["AXValue"], valueEmptyOrAllSelected: true), tiers: all, held: nil) == .run(.ax, exact: true))
        #expect(chooseTier(type, element: ElementFacts(role: "input", settable: ["AXValue"]), tiers: all, held: nil) == .run(.process, exact: true))
        #expect(chooseTier(type, element: nil, tiers: [.ax], held: nil) == .needs(.process))
    }

    @Test func theAXVerbsAreAXOnly() {
        for a in [ComputerAction(action: .setValue, element: 1, value: "x"), ComputerAction(action: .perform, element: 1, name: "press"), ComputerAction(action: .selectText, element: 1, text: "x")] {
            #expect(chooseTier(a, element: button, tiers: all, held: nil) == .run(.ax, exact: true))
            #expect(chooseTier(a, element: button, tiers: [.process, .session], held: nil) == .needs(.ax))
        }
    }

    @Test func raiseNeedsTheSessionTier() {
        let raise = ComputerAction(action: .perform, element: 1, name: "raise")
        let window = ElementFacts(role: "window", actions: ["AXRaise"])
        #expect(chooseTier(raise, element: window, tiers: [.ax, .process], held: nil) == .needs(.session))
        #expect(chooseTier(raise, element: window, tiers: all, held: nil) == .run(.session, exact: true))
    }

    @Test func aHeldButtonForcesItsTier() {
        let move = ComputerAction(action: .mouseMove, coordinate: [3, 3])
        #expect(chooseTier(move, element: nil, tiers: all, held: .session) == .run(.session, exact: true))
        #expect(chooseTier(move, element: nil, tiers: [.ax, .process], held: .session) == .needs(.session))
        // AX verbs are not events: a held button leaves them alone
        #expect(chooseTier(ComputerAction(action: .setValue, element: 1, value: "x"), element: button, tiers: [.ax], held: .process) == .run(.ax, exact: true))
        #expect(chooseTier(ComputerAction(action: .leftClick, element: 3), element: button, tiers: all, held: .process) == .run(.process, exact: true))
    }

    @Test func actionsWithoutInputHaveNoTier() {
        for a in [ComputerActionName.screenshot, .zoom, .cursorPosition, .wait] {
            #expect(chooseTier(ComputerAction(action: a), element: nil, tiers: all, held: nil) == .noInput)
        }
    }

    @Test func unknownTiersAreSkipped() {
        #expect(chooseTier(ComputerAction(action: .key, text: "a"), element: nil, tiers: [.unknown("remote"), .session], held: nil) == .run(.session, exact: true))
    }
}

@Suite struct GeometryTests {
    let space = CoordinateSpace(width: 1600, height: 1340, scale: 2)
    let frame = Rect(x: 3700, y: -244, w: 800, h: 670)

    @Test func mapsAPointAtScaleTwoOnAWindowOffTheMainDisplay() throws {
        #expect(try toScreen([0, 0], frame: frame, space: space) == ScreenPoint(x: 3700, y: -244))
        #expect(try toScreen([400, 100], frame: frame, space: space) == ScreenPoint(x: 3900, y: -194))
        for p in [[0, 0], [1599, 1339], [811, 7]] { #expect(try toSpace(toScreen(p, frame: frame, space: space), frame: frame, space: space) == p) }
    }

    @Test func refusesEveryEdge() {
        for p in [[-1, 0], [0, -1], [1600, 0], [0, 1340], [5]] {
            do {
                _ = try toScreen(p, frame: frame, space: space)
                Issue.record("\(p) was taken")
            } catch {
                #expect(kind(error) == .outOfBounds)
                if p.count == 2 { #expect((error as? ComputerFailure)?.error.coordinate == p) }
                #expect((error as? ComputerFailure)?.error.space == space)
            }
        }
    }

    @Test func clipsAnElementToItsScrollArea() {
        let window = Rect(x: 0, y: 0, w: 800, h: 600)
        let row = Rect(x: 10, y: 550, w: 200, h: 100) // half below the area
        let visible = Rect(x: 0, y: 40, w: 800, h: 560)
        #expect(pointIn(row, visible: visible, window: window) == ScreenPoint(x: 110, y: 575))
        #expect(pointIn(Rect(x: 10, y: 700, w: 20, h: 20), visible: visible, window: window) == nil)
        #expect(pointIn(row, visible: nil, window: window) == ScreenPoint(x: 110, y: 575))
    }
}

@Suite struct TextMatchTests {
    @Test func findsTheFirstOccurrence() {
        #expect(findText("ab", in: "xxabyyab") == TextRange(location: 2, length: 2))
        #expect(findText("zz", in: "xxab") == nil)
    }

    @Test func prefixAndSuffixPickTheOccurrence() {
        let v = "Total: 1, Subtotal: 2, Total: 3"
        #expect(findText("total", in: v, prefix: "Sub") == TextRange(location: 13, length: 5))
        #expect(findText("Total", in: v, suffix: ": 3") == TextRange(location: 23, length: 5))
        #expect(findText("Total", in: v, prefix: ", ", suffix: ": 3") == TextRange(location: 23, length: 5))
        #expect(findText("Total", in: v, prefix: "Grand ") == nil)
    }

    @Test func countsInUTF16AcrossEmoji() {
        let v = "🙂 hello 🙂 hello"
        #expect(findText("hello", in: v) == TextRange(location: 3, length: 5))
        #expect(findText("hello", in: v, prefix: "🙂 ") == TextRange(location: 3, length: 5))
        #expect(findText("hello", in: v, prefix: "o 🙂 ") == TextRange(location: 12, length: 5))
    }

    @Test func placesTheCaret() {
        let m = TextRange(location: 4, length: 3)
        #expect(selection(for: m, place: nil) == m)
        #expect(selection(for: m, place: .select) == m)
        #expect(selection(for: m, place: .before) == TextRange(location: 4, length: 0))
        #expect(selection(for: m, place: .after) == TextRange(location: 7, length: 0))
        #expect(textRange([2, 5]) == TextRange(location: 2, length: 3))
        #expect(textRange([5, 2]) == nil)
    }
}
