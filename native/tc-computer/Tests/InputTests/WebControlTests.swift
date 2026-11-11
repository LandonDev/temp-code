import ComputerCore
import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// Web content's pure rules (docs/computer-protocol.md §25.6 to §25.9). Foundation only: the box runs
// this file from scripts/computer-text-test.sh, the Mac in InputTests.

@Suite struct PickPlanTests {
    let plans = ["Choose a plan", "Starter", "Team", "Team Plus", "Enterprise"]

    @Test func exactThenCaseBlindThenAUniquePrefix() {
        #expect(PickPlan.match("Team", titles: plans) == .item(2))
        #expect(PickPlan.match("team plus", titles: plans) == .item(3))
        #expect(PickPlan.match("  Enterprise ", titles: plans) == .item(4))
        #expect(PickPlan.match("ent", titles: plans) == .item(4))
        #expect(PickPlan.match("Star", titles: plans) == .item(1))
    }

    @Test func anExactTitleBeatsTheItemsItPrefixes() {
        // "Team" is exact though "Team Plus" begins with it
        #expect(PickPlan.match("Team", titles: plans) == .item(2))
        #expect(PickPlan.match("TEAM", titles: plans) == .item(2))
    }

    @Test func aPrefixOfSeveralNamesThemAndNothingMatchesNothing() {
        #expect(PickPlan.match("Te", titles: plans) == .ambiguous(["Team", "Team Plus"]))
        #expect(PickPlan.match("Gold", titles: plans) == PickPlan.Match.none)
        #expect(PickPlan.match("", titles: plans) == PickPlan.Match.none)
        #expect(PickPlan.match("x", titles: []) == PickPlan.Match.none)
        // an untitled item (a separator) is never a prefix match
        #expect(PickPlan.match("a", titles: ["", "Apple"]) == .item(1))
    }
}

@Suite struct IntoViewPlanTests {
    // a page whose visible rect is 600 points tall at y 100; rows 30 points apart
    let visible = Rect(x: 0, y: 100, w: 800, h: 600)
    func row(_ y: Double, x: Double = 20, w: Double = 700) -> Rect? { Rect(x: x, y: y, w: w, h: 24) }

    @Test func theBandIsTheWheelsDistancePastTheEdge() {
        let down = IntoViewPlan.band(visible: visible, direction: .down, clicks: 5)!
        #expect(down.distance == 200)
        #expect(down.span == (700, 900))
        let up = IntoViewPlan.band(visible: visible, direction: .up, clicks: 1, pointsPerClick: 40)!
        #expect(up.span == (60, 100))
        #expect(IntoViewPlan.band(visible: Rect(x: 0, y: 0, w: 0, h: 0), direction: .down, clicks: 3) == nil)
    }

    @Test func downTakesTheLastElementStartingInTheBand() {
        let band = IntoViewPlan.band(visible: visible, direction: .down, clicks: 5)!
        // on screen, past the band, and three in it: the last of them
        let frames = [row(400), row(690), row(700), row(760), row(880), row(910), nil]
        #expect(IntoViewPlan.choose(frames, in: band) == 4)
    }

    @Test func upTakesTheElementFurthestAbove() {
        let band = IntoViewPlan.band(visible: visible, direction: .up, clicks: 2)!
        // band [20, 100): rows at 10 (past it), 30, 60, 90 and one on screen at 120
        #expect(IntoViewPlan.choose([row(10), row(30), row(60), row(90), row(120)], in: band) == 1)
    }

    @Test func elementsBesideTheColumnOrWithNoSizeNeverCount() {
        let band = IntoViewPlan.band(visible: visible, direction: .down, clicks: 5)!
        let beside = row(750, x: 900, w: 100)
        let empty = Rect(x: 20, y: 750, w: 0, h: 0)
        #expect(IntoViewPlan.choose([beside, empty], in: band) == nil)
        #expect(IntoViewPlan.choose([], in: band) == nil)
    }

    @Test func sidewaysUsesTheLeftEdges() {
        let band = IntoViewPlan.band(visible: Rect(x: 0, y: 0, w: 400, h: 300), direction: .right, clicks: 2)!
        let cells = [Rect(x: 380, y: 10, w: 50, h: 20), Rect(x: 410, y: 10, w: 50, h: 20), Rect(x: 470, y: 10, w: 50, h: 20), Rect(x: 490, y: 10, w: 50, h: 20)]
        #expect(IntoViewPlan.choose(cells, in: band) == 2)
    }

    @Test func theScanSkipsSubtreesWhollyBeforeOrPastTheBand() {
        let band = IntoViewPlan.band(visible: visible, direction: .down, clicks: 5)!
        #expect(!IntoViewPlan.mayHold(Rect(x: 0, y: 100, w: 800, h: 500), in: band))
        #expect(IntoViewPlan.mayHold(Rect(x: 0, y: 100, w: 800, h: 2000), in: band))
        #expect(!IntoViewPlan.mayHold(Rect(x: 0, y: 950, w: 800, h: 100), in: band))
        #expect(IntoViewPlan.mayHold(nil, in: band))
    }

    @Test func movedIsTheFrameReadBackAlongTheAxis() {
        #expect(IntoViewPlan.moved(before: Rect(x: 0, y: 880, w: 10, h: 10), after: Rect(x: 0, y: 676, w: 10, h: 10), direction: .down))
        #expect(!IntoViewPlan.moved(before: Rect(x: 0, y: 880, w: 10, h: 10), after: Rect(x: 0, y: 880.2, w: 10, h: 10), direction: .down))
        #expect(!IntoViewPlan.moved(before: Rect(x: 0, y: 880, w: 10, h: 10), after: nil, direction: .down))
    }
}

private let us = USANSILayout()

@Suite struct FocusCheckTests {
    let omnibox = FocusedFacts(role: "input", inWebArea: false, brief: ElementBrief(index: 9, line: "input \"Address and search bar\""))
    let pageField = FocusedFacts(role: "input", inWebArea: true, brief: ElementBrief(index: 21, line: "input \"Name\""))
    let openLocation = { MenuMatch(path: ["File", "Open Location…"], indexPath: [2, 4], enabled: true) }
    let paste = { MenuMatch(path: ["Edit", "Paste"], indexPath: [3, 5], enabled: true) }

    func verdict(_ a: ComputerAction, _ f: FocusedFacts?, _ e: FocusExpectation = .none, chromium: Bool = true, menu: @escaping () -> MenuMatch? = { nil }) -> FocusVerdict {
        FocusCheck.verdict(a, chromium: chromium, focused: f, expectation: e, menu: menu)
    }

    func kind(_ v: FocusVerdict) -> ErrorReason? {
        guard case .refuse(let e) = v, e.kind == .focusMoved else { return nil }
        return e.reason
    }

    @Test func aFreshReadWithTheOmniboxFocusedRefusesAnUnnamedType() {
        // the expectation held (the read showed the omnibox focused): the browser-field rule still refuses
        let v = verdict(ComputerAction(action: .type, text: "hello"), omnibox, .held)
        #expect(v == .refuse(ComputerError(kind: .focusMoved, message: "The keys would go to [9] input \"Address and search bar\", not the page; name the element they are for.", element: 9, reason: .browserField, focused: omnibox.brief)))
        #expect(kind(verdict(ComputerAction(action: .paste, text: "x"), omnibox)) == .browserField)
        #expect(kind(verdict(ComputerAction(action: .key, text: "Return"), omnibox)) == .browserField)
    }

    @Test func aShortcutOutsideTheEditMenuPasses() {
        #expect(verdict(ComputerAction(action: .key, text: "super+l"), omnibox, menu: openLocation) == .go)
        #expect(verdict(ComputerAction(action: .key, text: "ctrl+t"), omnibox, menu: { MenuMatch(path: ["File", "New Tab"], indexPath: [2, 0], enabled: true) }) == .go)
        // a disabled item, or no item at all, is checked like text
        #expect(kind(verdict(ComputerAction(action: .key, text: "super+l"), omnibox, menu: { MenuMatch(path: ["File", "Open Location…"], indexPath: [2, 4], enabled: false) })) == .browserField)
        #expect(kind(verdict(ComputerAction(action: .key, text: "super+k"), omnibox)) == .browserField)
    }

    @Test func anUnnamedPasteShortcutAndAHoldKeyAreRefused() {
        #expect(kind(verdict(ComputerAction(action: .key, text: "super+v"), omnibox, menu: paste)) == .browserField)
        // ⌘V refused even if a menu says otherwise: the edit keys are text
        #expect(kind(verdict(ComputerAction(action: .key, text: "super+v"), omnibox, menu: openLocation)) == .browserField)
        #expect(kind(verdict(ComputerAction(action: .key, text: "super+z"), omnibox, menu: { MenuMatch(path: ["Edit", "Undo"], indexPath: [3, 0], enabled: true) })) == .browserField)
        #expect(kind(verdict(ComputerAction(action: .holdKey, text: "super", duration: 1), omnibox, menu: openLocation)) == .browserField)
    }

    @Test func keysForThePageOrNamedOrOutsideChromiumGo() {
        #expect(verdict(ComputerAction(action: .type, text: "hi"), pageField) == .go)
        #expect(verdict(ComputerAction(action: .type, element: 9, text: "hi"), omnibox) == .go)
        #expect(verdict(ComputerAction(action: .type, text: "hi"), omnibox, chromium: false) == .go)
        #expect(verdict(ComputerAction(action: .type, text: "hi"), nil) == .go)
        // a toolbar button outside the page is no field
        #expect(verdict(ComputerAction(action: .key, text: "space"), FocusedFacts(role: "button", inWebArea: false)) == .go)
        #expect(verdict(ComputerAction(action: .leftClick, element: 3), omnibox) == .go)
        // the find bar is a search field
        #expect(kind(verdict(ComputerAction(action: .type, text: "x"), FocusedFacts(role: "search", inWebArea: false, line: "search \"Find\""))) == .browserField)
    }

    @Test func aLostExpectationIsMoved() {
        let v = verdict(ComputerAction(action: .type, text: "x"), pageField, .lost)
        #expect(v == .refuse(ComputerError(kind: .focusMoved, message: "The focus moved to [21] input \"Name\" since your read; name the element the keys are for.", element: 21, reason: .moved, focused: pageField.brief)))
        // focus on an element the read never listed: its line, no index
        let unlisted = FocusedFacts(role: "button", inWebArea: true, line: "button \"Close\"")
        guard case .refuse(let e) = verdict(ComputerAction(action: .key, text: "Return"), unlisted, .lost) else { Issue.record("not refused"); return }
        #expect(e.message.hasPrefix("The focus moved to button \"Close\" since") && e.element == nil && e.focused == nil)
    }

    @Test func theExpectationBindsOnlyTheFirstKeyStep() {
        let tabThenType = [ComputerAction(action: .key, text: "Tab"), ComputerAction(action: .type, text: "Ada")]
        #expect(FocusCheck.bindsExpectation(step: 0, of: tabThenType))
        #expect(!FocusCheck.bindsExpectation(step: 1, of: tabThenType))
        // a batch's Tab then type: the type is checked on the moved focus, the browser-field rule alone
        #expect(verdict(tabThenType[1], pageField, .none) == .go)
        // a click ran first: focus is what it left
        let clickThenType = [ComputerAction(action: .leftClick, element: 4), ComputerAction(action: .type, text: "x")]
        #expect(!FocusCheck.bindsExpectation(step: 1, of: clickThenType))
        // a screenshot or a wait moves nothing: the type is still the first key step
        let lookThenType = [ComputerAction(action: .screenshot), ComputerAction(action: .wait, duration: 1), ComputerAction(action: .paste, text: "x"), ComputerAction(action: .key, text: "Return")]
        #expect(FocusCheck.bindsExpectation(step: 2, of: lookThenType))
        #expect(!FocusCheck.bindsExpectation(step: 3, of: lookThenType))
        #expect(!FocusCheck.bindsExpectation(step: 0, of: lookThenType))
        #expect(!FocusCheck.bindsExpectation(step: 9, of: lookThenType))
    }
}

@Suite struct ReadBackTests {
    @Test func stringsCompareTrimmed() {
        #expect(ReadBack.verdict(asked: "Ada Lovelace", read: " Ada Lovelace\n") == .taken)
        #expect(ReadBack.verdict(asked: "Ada", read: "ada") == .notTaken("ada"))
        #expect(ReadBack.verdict(asked: "Ada", read: "") == .notTaken(""))
        #expect(ReadBack.verdict(asked: "Ada", read: nil) == .unreadable)
    }

    @Test func numbersCompareAsNumbers() {
        #expect(ReadBack.same("42", "42.0"))
        #expect(ReadBack.same("1000", "1,000"))
        #expect(ReadBack.same("-12,345.5", "-12345.50"))
        #expect(!ReadBack.same("1,00", "100"))
        #expect(!ReadBack.same("42", "43"))
        #expect(!ReadBack.same("v1", "v1.0"))
    }

    @Test func aPopUpByItsValueOrItsSelectedItem() {
        #expect(ReadBack.popUp(item: "Team", value: "Team", selectedTitle: nil) == .taken)
        #expect(ReadBack.popUp(item: "Team", value: nil, selectedTitle: "Team") == .taken)
        #expect(ReadBack.popUp(item: "Team", value: "team", selectedTitle: "Team") == .taken)
        #expect(ReadBack.popUp(item: "Team", value: "Choose a plan", selectedTitle: nil) == .notTaken("Choose a plan"))
        #expect(ReadBack.popUp(item: "Team", value: nil, selectedTitle: nil) == .unreadable)
    }
}

@Suite struct CheckboxEvidenceTests {
    @Test func theValueAloneDecides() {
        #expect(ReadBack.toggle(before: "0", after: "1") == .changed)
        // a posted click that only moved the focus ring: the value stayed
        #expect(ReadBack.toggle(before: "0", after: "0") == StepEffect.none)
        #expect(ReadBack.toggle(before: nil, after: "1") == .unknown)
    }
}

private let everyTier: [Tier] = [.ax, .process, .session]

private func runs(_ plan: RoutePlan) -> [String] {
    guard case .runs(let steps, _, _) = plan else { return [] }
    return steps.map { "\($0.route) \($0.tier.rawValue)\($0.exact ? "" : "~")" }
}

@Suite struct WebRouteTests {
    let web = RouteFacts(webContent: { true })

    @Test func aWebScrollTriesIntoViewBeforeTheWheel() {
        let down = ComputerAction(action: .scroll, element: 4, scroll_direction: .down, scroll_amount: 5)
        let page = ElementFacts(role: "web area")
        #expect(runs(planRoutes(down, element: page, facts: web, tiers: everyTier, held: nil)) == ["scrollIntoView ax~", "events process", "events session"])
        // an overflow box with a bar: the bar first
        var bar = web
        bar.scrollBar = { true }
        #expect(runs(planRoutes(down, element: page, facts: bar, tiers: everyTier, held: nil)) == ["scrollBar ax", "scrollIntoView ax~", "events process", "events session"])
        // page actions, listed or not, are no route in a page
        let listed = ElementFacts(role: "web area", pageScrolls: ["AXScrollDownByPage"])
        #expect(runs(planRoutes(down, element: listed, facts: web, tiers: everyTier, held: nil)) == ["scrollIntoView ax~", "events process", "events session"])
        #expect(chooseRoute(down, element: page, facts: web, tiers: [.ax], held: nil) == .run(.ax, .scrollIntoView, exact: false))
        #expect(Route.scrollIntoView.via == .scrollIntoView)
    }

    @Test func anIgnoredIntoViewRunsLast() {
        let down = ComputerAction(action: .scroll, coordinate: [5, 5], scroll_direction: .down, scroll_amount: 5)
        let ignored = IgnoredRoutes(via: [.scrollIntoView])
        #expect(runs(planRoutes(down, element: nil, facts: web, tiers: everyTier, held: nil, ignored: ignored)) == ["events process", "events session", "scrollIntoView ax~"])
        #expect(chooseRoute(down, element: nil, facts: web, tiers: [.ax], held: nil, ignored: IgnoredRoutes(via: [.scrollIntoView], skip: true)) == .needs(.process, menu: nil))
    }

    @Test func aNativeScrollIsAsBefore() {
        let down = ComputerAction(action: .scroll, coordinate: [5, 5], scroll_direction: .down, scroll_amount: 5)
        #expect(runs(planRoutes(down, element: nil, facts: RouteFacts(pageScrolls: { ["AXScrollDownByPage"] }), tiers: everyTier, held: nil)) == ["events process", "scrollPage ax~", "events session"])
    }

    @Test func aWebPopUpsValueIsPicked() {
        let set = ComputerAction(action: .setValue, element: 19, value: "Team")
        #expect(runs(planRoutes(set, element: ElementFacts(role: "pop up", actions: ["AXPress"], settable: ["AXValue"]), facts: web, tiers: everyTier, held: nil)) == ["pick ax"])
        // a native pop up, and a web input, keep AXValue
        #expect(runs(planRoutes(set, element: ElementFacts(role: "pop up", settable: ["AXValue"]), tiers: everyTier, held: nil)) == ["element ax"])
        #expect(runs(planRoutes(set, element: ElementFacts(role: "input", settable: ["AXValue"]), facts: web, tiers: everyTier, held: nil)) == ["element ax"])
        #expect(Route.pick.via == nil)
    }

    @Test func aWebCheckboxIsPressedThenClicked() {
        let click = ComputerAction(action: .leftClick, element: 7)
        let box = ElementFacts(role: "checkbox", actions: ["AXPress"])
        #expect(runs(planRoutes(click, element: box, facts: web, tiers: everyTier, held: nil)) == ["element ax", "events process", "events session"])
    }

    @Test func aKeyWithAnElementPostsKeys() {
        let key = ComputerAction(action: .key, element: 21, text: "Return")
        #expect(runs(planRoutes(key, element: ElementFacts(role: "input"), facts: web, tiers: everyTier, held: nil)) == ["events process", "events session"])
    }
}
