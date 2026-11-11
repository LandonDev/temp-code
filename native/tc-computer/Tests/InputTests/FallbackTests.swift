import ComputerCore
import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// The background fallbacks' pure rules (docs/computer-protocol.md §24). Foundation only: the box
// runs this file from scripts/computer-text-test.sh, the Mac in InputTests.

private let us = USANSILayout()
private func combo(_ s: String) -> KeyCombo { try! parseKeyCombo(s) }

@Suite struct MenuShortcutTests {
    @Test func commandAloneIsMaskZero() {
        let close = MenuItemShortcut(cmdChar: "W", modifiers: 0)
        #expect(close.matches(combo("super+w"), layout: us))
        #expect(!close.matches(combo("super+shift+w"), layout: us))
        #expect(!close.matches(combo("ctrl+w"), layout: us))
        #expect(!close.matches(combo("w"), layout: us))
    }

    @Test func shiftAsTheMaskOrAsAnUpperCaseCharacter() {
        // AppKit reports a letter upper-cased; Save As carries its shift in the mask
        let saveAs = MenuItemShortcut(cmdChar: "S", modifiers: MenuItemShortcut.shiftBit)
        #expect(saveAs.matches(combo("super+shift+s"), layout: us))
        #expect(saveAs.matches(combo("super+S"), layout: us))
        #expect(!saveAs.matches(combo("super+s"), layout: us))
        #expect(MenuItemShortcut(cmdChar: "s").matches(combo("super+s"), layout: us))
    }

    @Test func optionControlAndTheNoCommandBit() {
        let opt = MenuItemShortcut(cmdChar: "M", modifiers: MenuItemShortcut.optionBit)
        #expect(opt.matches(combo("super+alt+m"), layout: us))
        let ctrlCmd = MenuItemShortcut(cmdChar: "F", modifiers: MenuItemShortcut.controlBit)
        #expect(ctrlCmd.matches(combo("ctrl+super+f"), layout: us))
        let ctrlOnly = MenuItemShortcut(cmdChar: "A", modifiers: MenuItemShortcut.controlBit | MenuItemShortcut.noCommandBit)
        #expect(ctrlOnly.matches(combo("ctrl+a"), layout: us))
        #expect(!ctrlOnly.matches(combo("ctrl+super+a"), layout: us))
    }

    @Test func glyphKeysAndFunctionKeys() {
        // Move to Trash: Command-Delete, the Delete glyph
        let trash = MenuItemShortcut(cmdChar: "\u{8}", glyph: 0x17, modifiers: 0)
        #expect(trash.matches(combo("super+BackSpace"), layout: us))
        #expect(!trash.matches(combo("super+Delete"), layout: us))
        let left = MenuItemShortcut(glyph: 0x64, modifiers: MenuItemShortcut.optionBit)
        #expect(left.matches(combo("super+alt+Left"), layout: us))
        // an F-key by its virtual key, its character a private-use one
        let f5 = MenuItemShortcut(cmdChar: "\u{F708}", virtualKey: 96, modifiers: 0)
        #expect(f5.matches(combo("super+F5"), layout: us))
    }

    @Test func aLayoutShiftedCharacter() {
        let help = MenuItemShortcut(cmdChar: "?", modifiers: 0)
        #expect(help.matches(combo("super+shift+/"), layout: us))
        #expect(help.matches(combo("super+?"), layout: us))
        #expect(!help.matches(combo("super+/"), layout: us))
        #expect(MenuItemShortcut(cmdChar: "+").matches(combo("super++"), layout: us))
    }

    @Test func onlyCommandOrControlCombosAreLookedUp() {
        #expect(hasMenuModifier(combo("super+w")))
        #expect(hasMenuModifier(combo("ctrl+a")))
        #expect(!hasMenuModifier(combo("alt+e")))
        #expect(!hasMenuModifier(combo("shift+Tab")))
        #expect(!hasMenuModifier(combo("Return")))
    }
}

/// A menu bar in memory: each node a title, its facts and its items.
private final class TreeMenu: MenuSource {
    final class Node {
        let facts: MenuItemFacts
        var items: [Node]
        init(_ title: String, enabled: Bool = true, shortcut: MenuItemShortcut? = nil, separator: Bool = false, _ items: [Node] = []) {
            facts = MenuItemFacts(title: title, enabled: enabled, shortcut: shortcut, isSeparator: separator, hasSubmenu: false)
            self.items = items
        }
    }

    var bar: [Node]
    var reads = 0
    init(_ bar: [Node]) { self.bar = bar }
    func barItems() -> [Node] { bar }
    func items(_ node: Node) -> [Node] { node.items }
    func facts(_ node: Node) -> MenuItemFacts {
        reads += 1
        var f = node.facts
        // an item of a menu holding items is a submenu; a bar item is the menu itself
        f.hasSubmenu = !node.items.isEmpty && !bar.contains { $0 === node }
        return f
    }
}

private func item(_ title: String, _ char: String, mask: Int = 0, enabled: Bool = true) -> TreeMenu.Node {
    TreeMenu.Node(title, enabled: enabled, shortcut: MenuItemShortcut(cmdChar: char, modifiers: mask))
}

private func textEditBar() -> TreeMenu {
    TreeMenu([
        TreeMenu.Node("Apple", [item("Force Quit", "Q", mask: MenuItemShortcut.optionBit)]),
        TreeMenu.Node("TextEdit", [
            item("Settings…", ","),
            TreeMenu.Node("Services", [item("Make Sticky", "Y", mask: MenuItemShortcut.shiftBit)]),
            item("Quit TextEdit", "Q")
        ]),
        TreeMenu.Node("File", [
            item("New", "N"),
            TreeMenu.Node("-", separator: true),
            item("Close", "W", enabled: false),
            item("Close All", "W", enabled: true),
            TreeMenu.Node("Export", [item("Export as PDF…", "E", mask: MenuItemShortcut.optionBit)])
        ]),
        TreeMenu.Node("Edit", [item("Select All", "A", enabled: false)])
    ])
}

@Suite struct MenuSearchTests {
    @Test func skipsTheAppleMenuAndServicesAndFindsSubmenus() {
        let index = buildMenuIndex(textEditBar(), now: { 0 })
        #expect(index.find(combo("super+alt+q"), layout: us) == nil)
        #expect(index.find(combo("super+shift+y"), layout: us) == nil)
        #expect(index.find(combo("super+q"), layout: us)?.path == ["TextEdit", "Quit TextEdit"])
        let pdf = index.find(combo("super+alt+e"), layout: us)
        #expect(pdf == MenuMatch(path: ["File", "Export", "Export as PDF…"], indexPath: [2, 4, 0], enabled: true))
        #expect(pdf?.line == "File › Export › Export as PDF…")
    }

    @Test func theFirstEnabledMatchWinsOverADisabledOne() {
        let index = buildMenuIndex(textEditBar(), now: { 0 })
        #expect(index.find(combo("super+w"), layout: us) == MenuMatch(path: ["File", "Close All"], indexPath: [2, 3], enabled: true))
        #expect(index.find(combo("super+a"), layout: us) == MenuMatch(path: ["Edit", "Select All"], indexPath: [3, 0], enabled: false))
    }

    @Test func capsTheItemsAndTheTime() {
        let many = TreeMenu([TreeMenu.Node("Apple"), TreeMenu.Node("App"), TreeMenu.Node("Big", (0 ..< 4_000).map { item("I\($0)", "x") })])
        let capped = buildMenuIndex(many, now: { 0 })
        #expect(capped.truncated)
        #expect(capped.entries.count == InputTiming.menuMaxItems)
        var t = 0.0
        let slow = buildMenuIndex(textEditBar(), now: { t += 0.1; return t })
        #expect(slow.truncated)
        #expect(slow.entries.count < buildMenuIndex(textEditBar(), now: { 0 }).entries.count)
    }

    @Test func theIndexAgesOutAndIsReadAgainOnAMismatch() {
        let bar = textEditBar()
        var cache: MenuIndex?
        var now = 0.0
        #expect(lookUpMenu(combo("super+n"), source: bar, layout: us, cache: &cache, now: { now })?.1.path == ["File", "New"])
        let built = cache?.builtAt
        // fresh: a combo with no item does not walk the bar again
        bar.reads = 0
        #expect(lookUpMenu(combo("super+k"), source: bar, layout: us, cache: &cache, now: { now }) == nil)
        #expect(bar.reads == 0)
        // the item moved: the index's path finds another, so the bar is read again
        bar.bar[2].items.insert(item("Open…", "O"), at: 0)
        now = 1
        #expect(lookUpMenu(combo("super+n"), source: bar, layout: us, cache: &cache, now: { now })?.1.indexPath == [2, 1])
        #expect(cache?.builtAt == 1)
        // aged out: read again
        now = 1 + InputTiming.menuIndexMaxAgeS
        _ = lookUpMenu(combo("super+n"), source: bar, layout: us, cache: &cache, now: { now })
        #expect(cache?.builtAt == now)
        #expect(built == 0)
    }
}

private let win = Rect(x: 0, y: 0, w: 400, h: 300)

@Suite struct HitWalkTests {
    /// a node of a window's tree: its frame (nil for one AX gives none) and its children, back to front
    final class N {
        let name: String
        let frame: Rect?
        var kids: [N]
        init(_ name: String, _ frame: Rect?, _ kids: [N] = []) { self.name = name; self.frame = frame; self.kids = kids }
    }
    func walk(_ root: N, _ x: Double, _ y: Double, budget: Int = InputTiming.hitWalkNodes) -> String? {
        walkHit(root: root, point: ScreenPoint(x: x, y: y), budget: budget, children: { $0.kids }, frame: { $0.frame })?.name
    }

    // the fallbacks window: the Hit Target button over its label, a field beside it, all under a frameless view
    let tree = N("window", Rect(x: 560, y: 900, w: 420, h: 520), [
        N("content", nil, [
            N("button", Rect(x: 576, y: 936, w: 160, h: 28), [N("label", Rect(x: 584, y: 940, w: 140, h: 20))]),
            N("field", Rect(x: 576, y: 1000, w: 320, h: 22)),
        ]),
    ])

    @Test func aPointOnTheLabelFindsTheLabelUnderItsButton() {
        #expect(walk(tree, 616, 950) == "label")
        #expect(walk(tree, 578, 950) == "button")
        #expect(walk(tree, 600, 1010) == "field")
    }

    @Test func theBackgroundIsTheWindowAndAPointOutsideIsNone() {
        #expect(walk(tree, 970, 1410) == "window")
        #expect(walk(tree, 10, 10) == nil)
    }

    @Test func theLastOfOverlappingSiblingsIsOnTop() {
        let stacked = N("window", Rect(x: 0, y: 0, w: 100, h: 100), [N("under", Rect(x: 0, y: 0, w: 50, h: 50)), N("over", Rect(x: 25, y: 25, w: 50, h: 50))])
        #expect(walk(stacked, 30, 30) == "over")
        #expect(walk(stacked, 10, 10) == "under")
    }

    @Test func theWalkStopsAtItsBudget() {
        // the window and two nodes read: the content (no frame) and the button; the label is never reached
        #expect(walk(tree, 616, 950, budget: 3) == "button")
    }
}

@Suite struct TakesCaretTests {
    @Test func aFieldNobodyIsEditingTakesTheCaretByItsFocus() {
        // TC Probe's Digits field in the background: the range settable only once focused
        #expect(takesCaret(axRole: "AXTextField", rangeSettable: false, focusSettable: true))
        #expect(takesCaret(axRole: "AXTextArea", rangeSettable: true, focusSettable: true))
        #expect(!takesCaret(axRole: "AXTextField", rangeSettable: false, focusSettable: false))
        #expect(!takesCaret(axRole: "AXStaticText", rangeSettable: true, focusSettable: true))
    }
}

@Suite struct CaretWriteTests {
    let want = TextRange(location: 4, length: 0)

    @Test func theCaretIsWrittenAgainUntilItHolds() {
        // the field editor's select-all over the first write
        #expect(CaretWrite.next(range: TextRange(location: 0, length: 10), want: want, writes: 1) == .write)
        #expect(CaretWrite.next(range: want, want: want, writes: 1) == .done)
        #expect(CaretWrite.next(range: nil, want: want, writes: 0) == .write)
    }

    @Test func atMostThreeWrites() {
        #expect(CaretWrite.next(range: TextRange(location: 0, length: 10), want: want, writes: CaretWrite.caretWrites) == .wait)
    }
}

@Suite struct HitPlanTests {
    @Test func aLabelInAButtonPressesTheButton() {
        let chain = [HitFacts(role: "text"), HitFacts(role: "button", actions: ["AXPress"])]
        #expect(chooseHit(chain: chain, verb: .leftClick, point: nil) == HitChoice(.press, level: 1))
    }

    @Test func aLinksTextPressesTheLink() {
        let chain = [HitFacts(role: "text"), HitFacts(role: "link", actions: ["AXPress", "AXShowMenu"]), HitFacts(role: "web area", actions: ["AXPress"])]
        #expect(chooseHit(chain: chain, verb: .leftClick, point: nil) == HitChoice(.press, level: 1))
        #expect(chooseHit(chain: chain, verb: .rightClick, point: nil) == HitChoice(.showMenu, level: 1))
        #expect(chooseHit(chain: chain, verb: .doubleClick, point: nil) == nil)
    }

    @Test func aStepperTakesTheHalfUnderThePoint() {
        let stepper = HitFacts(role: "stepper", actions: ["AXIncrement", "AXDecrement"], isIncrementor: true, frame: Rect(x: 10, y: 10, w: 20, h: 40))
        #expect(chooseHit(chain: [stepper], verb: .leftClick, point: ScreenPoint(x: 20, y: 15)) == HitChoice(.increment, level: 0))
        #expect(chooseHit(chain: [stepper], verb: .leftClick, point: ScreenPoint(x: 20, y: 45)) == HitChoice(.decrement, level: 0))
    }

    @Test func aRowsCellSelectsTheRow() {
        let chain = [HitFacts(role: "text"), HitFacts(role: "cell", selectableRow: true), HitFacts(role: "row", selectableRow: true), HitFacts(role: "table")]
        #expect(chooseHit(chain: chain, verb: .leftClick, point: nil) == HitChoice(.selectRow, level: 1))
    }

    @Test func theWalkStopsBeforeAContainerAndAfterThreeAncestors() {
        let inScroll = [HitFacts(role: "image"), HitFacts(role: "scroll area"), HitFacts(role: "window", actions: ["AXPress"])]
        #expect(chooseHit(chain: inScroll, verb: .leftClick, point: nil) == nil)
        let deep = [HitFacts(role: "text"), HitFacts(role: "group"), HitFacts(role: "group"), HitFacts(role: "group"), HitFacts(role: "button", actions: ["AXPress"])]
        #expect(chooseHit(chain: deep, verb: .leftClick, point: nil) == nil)
        #expect(chooseHit(chain: Array(deep.dropFirst()), verb: .leftClick, point: nil) == HitChoice(.press, level: 3))
        // a click on a web area's background presses nothing
        #expect(chooseHit(chain: [HitFacts(role: "web area", actions: ["AXPress"])], verb: .leftClick, point: nil) == nil)
    }

    @Test func aHitOutsideTheTargetWindowIsNone() {
        let other = [HitFacts(role: "button", actions: ["AXPress"], inTargetWindow: false)]
        #expect(chooseHit(chain: other, verb: .leftClick, point: nil) == nil)
    }

    @Test func textWithNoActionTakesTheCaretAndACanvasNothing() {
        let field = [HitFacts(role: "input", isText: true), HitFacts(role: "group")]
        #expect(chooseHit(chain: field, verb: .leftClick, point: nil) == HitChoice(.caret, level: 0))
        let area = [HitFacts(role: "text area", isText: true), HitFacts(role: "scroll area")]
        #expect(chooseHit(chain: area, verb: .leftClick, point: nil) == HitChoice(.caret, level: 0))
        #expect(chooseHit(chain: area, verb: .doubleClick, point: nil) == nil)
        #expect(chooseHit(chain: [HitFacts(role: "image"), HitFacts(role: "group")], verb: .leftClick, point: nil) == nil)
    }
}

@Suite struct ScrollPlanTests {
    @Test func theDeltaIsTheWheelsDistanceOverTheScrollableRange() {
        #expect(barDelta(clicks: 5, content: 1200, visible: 400, pointsPerClick: 40) == 0.25)
        #expect(scrollBar(for: .down)! == (.vertical, 1))
        #expect(scrollBar(for: .left)! == (.horizontal, -1))
        #expect(scrollBarMove(value: 0.5, direction: .down, clicks: 5, content: 1200, visible: 400, pointsPerClick: 40) == .set(0.75))
        #expect(scrollBarMove(value: 0.5, direction: .up, clicks: 5, content: 1200, visible: 400, pointsPerClick: 40) == .set(0.25))
    }

    @Test func clampsAtTheEnds() {
        #expect(scrollBarMove(value: 0.9, direction: .down, clicks: 50, content: 1200, visible: 400) == .set(1))
        #expect(scrollBarMove(value: 0.1, direction: .up, clicks: 50, content: 1200, visible: 400) == .set(0))
    }

    @Test func aBarAtTheEndIsNoneAtOnce() {
        #expect(scrollBarMove(value: 1, direction: .down, clicks: 1, content: 1200, visible: 400) == .atEnd)
        #expect(scrollBarMove(value: 0, direction: .up, clicks: 1, content: 1200, visible: 400) == .atEnd)
    }

    @Test func contentNoTallerThanTheViewHasNothingToMove() {
        #expect(barDelta(clicks: 3, content: 400, visible: 400) == nil)
        #expect(scrollBarMove(value: 0, direction: .down, clicks: 3, content: 300, visible: 400) == ScrollBarMove.none)
    }
}

private let everyTier: [Tier] = [.ax, .process, .session]

private func runs(_ plan: RoutePlan) -> [String] {
    guard case .runs(let steps, _, _) = plan else { return [] }
    return steps.map { "\($0.route) \($0.tier.rawValue)\($0.exact ? "" : "~")" }
}

@Suite struct RouteTests {
    let enabledClose = RouteFacts(menu: { MenuMatch(path: ["File", "Close"], indexPath: [2, 2], enabled: true) })
    let disabledClose = RouteFacts(menu: { MenuMatch(path: ["File", "Close"], indexPath: [2, 2], enabled: false) })

    @Test func aShortcutTriesItsMenuItemFirst() {
        let key = ComputerAction(action: .key, text: "super+w")
        #expect(runs(planRoutes(key, element: nil, facts: enabledClose, tiers: everyTier, held: nil)) == ["menu ax", "events process", "events session"])
        #expect(chooseRoute(key, element: nil, facts: enabledClose, tiers: [.ax], held: nil) == .run(.ax, .menu, exact: true))
        // no item: the keys, and with ax alone the process tier is needed
        #expect(chooseRoute(key, element: nil, tiers: [.ax], held: nil) == .needs(.process, menu: nil))
        // a combo with no Command or Control never looks
        var looked = false
        let alt = ComputerAction(action: .key, text: "alt+e")
        _ = planRoutes(alt, element: nil, facts: RouteFacts(menu: { looked = true; return nil }), tiers: everyTier, held: nil)
        #expect(!looked)
    }

    @Test func aDisabledItemInTheBackgroundSkipsTheProcessKeys() {
        let key = ComputerAction(action: .key, text: "super+w")
        #expect(chooseRoute(key, element: nil, facts: disabledClose, tiers: everyTier, held: nil) == .run(.session, .events, exact: true))
        #expect(chooseRoute(key, element: nil, facts: disabledClose, tiers: [.ax, .process], held: nil) == .needs(.front, menu: ["File", "Close"]))
        var active = disabledClose
        active.appActive = { true }
        #expect(chooseRoute(key, element: nil, facts: active, tiers: everyTier, held: nil) == .disabledMenu(["File", "Close"]))
    }

    @Test func aClickTriesTheElementThenTheHitThenTheCaret() {
        let click = ComputerAction(action: .leftClick, coordinate: [10, 10])
        let button = RouteFacts(hit: { HitChoice(.press, level: 1) })
        #expect(runs(planRoutes(click, element: nil, facts: button, tiers: everyTier, held: nil)) == ["hit ax", "events process", "events session"])
        let field = RouteFacts(hit: { HitChoice(.caret, level: 0) })
        #expect(runs(planRoutes(click, element: nil, facts: field, tiers: everyTier, held: nil)) == ["caret ax", "events process", "events session"])
        #expect(chooseRoute(click, element: nil, tiers: [.ax], held: nil) == .needs(.process, menu: nil))
        // a named element with its own AXPress never hit-tests
        var tested = false
        let pressable = ElementFacts(role: "button", actions: ["AXPress"])
        let named = ComputerAction(action: .leftClick, element: 4)
        #expect(chooseRoute(named, element: pressable, facts: RouteFacts(hit: { tested = true; return nil }), tiers: everyTier, held: nil) == .run(.ax, .element, exact: true))
        #expect(!tested)
        // a modified click has no AX route
        #expect(runs(planRoutes(ComputerAction(action: .leftClick, coordinate: [1, 1], text: "shift"), element: nil, facts: button, tiers: everyTier, held: nil)) == ["events process", "events session"])
        #expect(runs(planRoutes(ComputerAction(action: .rightClick, coordinate: [1, 1]), element: nil, facts: RouteFacts(hit: { HitChoice(.showMenu, level: 0) }), tiers: everyTier, held: nil)) == ["hit ax", "events process", "events session"])
        #expect(runs(planRoutes(ComputerAction(action: .doubleClick, coordinate: [1, 1]), element: nil, facts: button, tiers: everyTier, held: nil)) == ["events process", "events session"])
    }

    @Test func ignoredRoutesRunLastAndSkipLeavesThemOut() {
        let click = ComputerAction(action: .leftClick, coordinate: [10, 10])
        let button = RouteFacts(hit: { HitChoice(.press, level: 1) })
        let ignored = IgnoredRoutes(via: [.hit], process: [.click])
        #expect(runs(planRoutes(click, element: nil, facts: button, tiers: everyTier, held: nil, ignored: ignored)) == ["events session", "hit ax", "events process"])
        let skip = IgnoredRoutes(via: [.hit], skip: true)
        #expect(chooseRoute(click, element: nil, facts: button, tiers: [.ax], held: nil, ignored: skip) == .needs(.process, menu: nil))
        #expect(chooseRoute(click, element: nil, facts: button, tiers: [.ax], held: nil, ignored: IgnoredRoutes(via: [.hit])) == .run(.ax, .hit, exact: true))
    }

    @Test func heldInputForcesItsTier() {
        let click = ComputerAction(action: .leftClick, coordinate: [10, 10])
        let button = RouteFacts(hit: { HitChoice(.press, level: 1) })
        #expect(chooseRoute(click, element: nil, facts: button, tiers: everyTier, held: .session) == .run(.session, .events, exact: true))
        #expect(chooseRoute(click, element: nil, facts: button, tiers: [.ax], held: .process) == .needs(.process, menu: nil))
    }

    @Test func aScrollTriesTheBarThenTheWheelThenThePageBeforeTakingTheMac() {
        let down = ComputerAction(action: .scroll, coordinate: [5, 5], scroll_direction: .down, scroll_amount: 5)
        let native = RouteFacts(scrollBar: { true })
        #expect(runs(planRoutes(down, element: nil, facts: native, tiers: everyTier, held: nil)) == ["scrollBar ax", "events process", "events session"])
        // Chrome's shape: no bar, page actions, the wheel ignored at process
        let chrome = RouteFacts(pageScrolls: { ["AXScrollDownByPage"] })
        #expect(runs(planRoutes(down, element: nil, facts: chrome, tiers: everyTier, held: nil, ignored: IgnoredRoutes(process: [.scroll]))) == ["scrollPage ax~", "events session", "events process"])
        // an approximate ax route now runs before the session wheel
        let area = ElementFacts(role: "scroll area", pageScrolls: ["AXScrollDownByPage"])
        let named = ComputerAction(action: .scroll, element: 2, scroll_direction: .down, scroll_amount: 10)
        #expect(chooseRoute(named, element: area, tiers: [.ax, .session], held: nil) == .run(.ax, .scrollPage, exact: false))
        // a scroll with modifiers keeps the wheel
        #expect(runs(planRoutes(ComputerAction(action: .scroll, coordinate: [5, 5], text: "shift", scroll_direction: .down), element: nil, facts: native, tiers: everyTier, held: nil)) == ["events process", "events session"])
    }

    @Test func aTextPasteTriesTheInsertFirst() {
        let paste = ComputerAction(action: .paste, text: "hi")
        let field = ElementFacts(role: "text area", settable: ["AXSelectedText"])
        #expect(runs(planRoutes(paste, element: field, tiers: everyTier, held: nil)) == ["insert ax", "events process", "events session"])
        // a rich paste keeps the clipboard, but into an input it pastes plain text anyway
        let html = ComputerAction(action: .paste, text: "<b>hi</b>", format: .html)
        #expect(runs(planRoutes(html, element: field, tiers: everyTier, held: nil)) == ["events process", "events session"])
        #expect(runs(planRoutes(html, element: ElementFacts(role: "input", settable: ["AXSelectedText"]), tiers: everyTier, held: nil)).first == "insert ax")
        #expect(chooseRoute(paste, element: ElementFacts(role: "input"), tiers: [.ax], held: nil) == .needs(.process, menu: nil))
    }

    @Test func theRunNamesTheTierAnExhaustedPlanNeeds() {
        let click = ComputerAction(action: .leftClick, coordinate: [10, 10])
        let field = RouteFacts(hit: { HitChoice(.caret, level: 0) })
        #expect(planRoutes(click, element: nil, facts: field, tiers: [.ax], held: nil) == .runs([RouteStep(.ax, .caret)], needed: .process, menu: nil))
    }

    @Test func theVerbsWithNoFallbackAreAsToday() {
        for a in [ComputerAction(action: .leftClickDrag, coordinate: [5, 5], start_coordinate: [1, 1]), ComputerAction(action: .middleClick, coordinate: [1, 1]), ComputerAction(action: .tripleClick, coordinate: [1, 1]), ComputerAction(action: .mouseMove, coordinate: [1, 1]), ComputerAction(action: .holdKey, text: "super", duration: 1)] {
            #expect(runs(planRoutes(a, element: nil, facts: RouteFacts(menu: { MenuMatch(path: ["x"], indexPath: [1], enabled: true) }, hit: { HitChoice(.press, level: 0) }, scrollBar: { true }), tiers: everyTier, held: nil)) == ["events process", "events session"], "\(a.action)")
        }
    }
}

// MARK: the paste's insert rung

private final class StubClock: InputClock, @unchecked Sendable {
    var t = 0.0
    func ticks() -> UInt64 { UInt64(t * 1e9) }
    func seconds() -> Double { t }
    func epochSeconds() -> Double { t }
    func sleep(ms: Int) { t += Double(ms) / 1000 }
}

private final class StubHold: MacLockHold, @unchecked Sendable { func release() {} }
private struct StubLock: MacLock { func acquire(within seconds: Double) -> MacLockHold? { StubHold() } }

private final class StubBoard: PasteboardStore {
    var changeCount = 0
    var snapshots = 0
    var writes = 0
    func snapshot() throws -> PasteboardSnapshot { snapshots += 1; return PasteboardSnapshot(items: [], changeCount: changeCount) }
    func clear() { changeCount += 1 }
    func write(_ content: PasteContent) throws { writes += 1; changeCount += 1 }
    func restore(_ snapshot: PasteboardSnapshot) { changeCount += 1 }
}

@Suite struct PasteInsertTests {
    private func flow(_ board: StubBoard) -> PasteFlow { PasteFlow(store: board, lock: StubLock(), clock: StubClock()) }

    @Test func anInsertWithEvidenceGoesInWithoutTheClipboard() throws {
        let board = StubBoard()
        var delivered = false
        let r = try flow(board).run(PasteContent(plain: "hi"), cancelled: { false }, insert: { .changed }, checks: {}, recheck: {}, deliver: { delivered = true }, evidence: { nil })
        #expect(r == PasteResult(via: .axInsert, clipboard: nil, effect: .changed))
        #expect(board.snapshots == 0 && board.writes == 0 && !delivered)
    }

    @Test func anInsertThatChangedNothingGoesOnToTheClipboard() throws {
        let board = StubBoard()
        var delivered = false
        let r = try flow(board).run(PasteContent(plain: "hi"), cancelled: { false }, insert: { StepEffect.none }, checks: {}, recheck: {}, deliver: { delivered = true }, evidence: { nil })
        #expect(r.via == .paste && r.clipboard == .restored)
        #expect(board.writes == 1 && delivered)
        // no insert to try: straight to the clipboard
        #expect(try flow(StubBoard()).run(PasteContent(plain: "hi"), cancelled: { false }, insert: { nil }, checks: {}, recheck: {}, deliver: {}, evidence: { nil }).via == .paste)
    }

    @Test func aDisabledPasteRefusesBeforeTheWrite() {
        let board = StubBoard()
        let refusal = ComputerFailure(ComputerError(kind: .needsTier, message: "Edit › Paste is disabled while TextEdit is in the background.", needed: .session, menu: ["Edit", "Paste"]))
        #expect(throws: refusal) {
            try flow(board).run(PasteContent(plain: "hi"), cancelled: { false }, insert: { StepEffect.none }, checks: { throw refusal }, recheck: {}, deliver: {}, evidence: { nil })
        }
        #expect(board.snapshots == 0 && board.writes == 0)
    }
}
