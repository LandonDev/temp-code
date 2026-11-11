import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

/// The `pick` route (docs/computer-protocol.md §25.7): `set_value` on a pop up in a web page. Chrome
/// takes a pop up's AXValue and ignores it, so the route opens the menu (AXPress, else AXShowMenu),
/// waits up to `pickMenuMs` for an AXMenu, presses the item `PickPlan` names and reads the pop up back.
/// Any menu it opened is closed again whatever happened (AXCancel on the menu, else Escape posted to the
/// pid): an open menu left behind hung Finder in the field test.
enum AXPick {
    struct Picked: Equatable {
        /// the title of the item pressed, or the value the pop up already showed
        var item: String
        /// false when the pop up already read the value and nothing was opened
        var changed: Bool
    }

    /// What a pop up shows: its AXValue, and the title of its menu's marked item when it has a menu child.
    struct Shown {
        var value: String?
        var selected: String?
        var any: String? { value ?? selected }
    }

    /// the press that opens a menu may not answer until the menu is up: a short timeout, its timeout no failure
    static let openTimeoutS: Float = 0.5
    static let pollMs = 20
    /// after the item's press the menu closes itself; it is closed by hand only past this
    static let closeGraceMs = 100

    static func pick(_ e: ResolvedElement, value: String, pid: pid_t, clock: InputClock) throws -> Picked {
        let popUp = e.element
        AX.setTimeout(popUp, seconds: InputTiming.axTimeoutS)
        let before = shown(popUp)
        // already showing it: nothing to open
        if let now = before.any, ReadBack.same(value, now) { return Picked(item: now, changed: false) }
        let item = try choose(e, value: value, pid: pid, before: before, clock: clock)
        try AXTier.confirmValue(e, clock: clock) {
            let s = shown(popUp)
            return ReadBack.popUp(item: item, value: s.value, selectedTitle: s.selected)
        }
        return Picked(item: item, changed: true)
    }

    /// Opens the menu, presses the item and closes what it opened; the item's title.
    private static func choose(_ e: ResolvedElement, value: String, pid: pid_t, before: Shown, clock: InputClock) throws -> String {
        let popUp = e.element
        let app = AX.app(pid)
        let actions = AX.actions(popUp)
        guard let raw = ["AXPress", "AXShowMenu"].first(where: { actions.contains($0) }) else {
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "[\(e.index)] can't open its menu.", element: e.index, available: actions.compactMap(AXTier.actionWord)))
        }
        let already = menus(of: popUp, app: app)
        let wasExpanded = AX.bool(popUp, "AXExpanded")
        AXUIElementSetMessagingTimeout(popUp, openTimeoutS)
        let err = AX.perform(popUp, raw)
        AX.setTimeout(popUp, seconds: InputTiming.axTimeoutS)
        if err != .success, err != .cannotComplete { throw AX.failure(err, element: e.index, what: "open its menu") }

        let opened = waitForMenu(popUp, app: app, already: already, wasExpanded: wasExpanded, clock: clock)
        defer { if let opened { close(opened, popUp: popUp, pid: pid, clock: clock) } }
        guard let menu = opened else { throw AXTier.valueNotTaken(e, reads: before.any, note: "opened no menu") }

        let items = AX.elements(menu, "AXChildren").filter { AX.string($0, "AXRole") == "AXMenuItem" }
        let titles = items.map { PickPlan.itemName(title: AX.string($0, "AXTitle"), value: AX.string($0, "AXValue"), description: AX.string($0, "AXDescription")) }
        let i: Int
        switch PickPlan.match(value, titles: titles) {
        case .item(let at):
            i = at
        case .none:
            throw AXTier.valueNotTaken(e, reads: before.any, available: Array(titles.filter { !$0.isEmpty }.prefix(30)), note: "has no item \(AXTier.quote(value))")
        case .ambiguous(let names):
            throw AXTier.valueNotTaken(e, reads: before.any, available: names, note: "has several items starting \(AXTier.quote(value))")
        }
        let target = items[i]
        AX.setTimeout(target, seconds: InputTiming.axTimeoutS)
        let press = AX.actions(target).contains("AXPress") ? "AXPress" : "AXPick"
        let pressed = AX.perform(target, press)
        if pressed != .success, pressed != .cannotComplete { throw AX.failure(pressed, element: e.index, what: "pick \(AXTier.quote(titles[i]))") }
        return titles[i]
    }

    /// What the pop up shows now.
    static func shown(_ popUp: AXUIElement) -> Shown {
        var selected: String?
        if let menu = AX.elements(popUp, "AXChildren").first(where: { AX.string($0, "AXRole") == "AXMenu" }) {
            let marked = AX.elements(menu, "AXChildren").first {
                !(AX.string($0, "AXMenuItemMarkChar") ?? "").isEmpty || AX.bool($0, "AXSelected") == true
            }
            selected = marked.map { PickPlan.itemName(title: AX.string($0, "AXTitle"), value: AX.string($0, "AXValue"), description: AX.string($0, "AXDescription")) }.flatMap { $0.isEmpty ? nil : $0 }
        }
        return Shown(value: AX.valueText(popUp), selected: selected)
    }

    /// The menus open on the pop up or the app: the pop up's AXMenu child, the app's own AXMenu children
    /// (where a context or pop up menu shows), and the menu around the app's focused element.
    static func menus(of popUp: AXUIElement, app: AXUIElement) -> [AXUIElement] {
        var out = AX.elements(popUp, "AXChildren").filter { AX.string($0, "AXRole") == "AXMenu" }
        out += AX.elements(app, "AXChildren").filter { AX.string($0, "AXRole") == "AXMenu" }
        if let focused = AX.element(app, "AXFocusedUIElement"), let menu = AX.ancestor(focused, role: "AXMenu", maxDepth: 4) { out.append(menu) }
        var unique: [AXUIElement] = []
        for m in out where !unique.contains(where: { AX.same($0, m) }) { unique.append(m) }
        return unique
    }

    /// The menu the press opened, waited for up to `pickMenuMs`: one that was not there before, or the pop up's
    /// own child once the pop up reads expanded (Chrome may keep a closed select's menu in the tree).
    static func waitForMenu(_ popUp: AXUIElement, app: AXUIElement, already: [AXUIElement], wasExpanded: Bool?, clock: InputClock) -> AXUIElement? {
        let deadline = clock.seconds() + Double(ComputerDefaults.ActionLimits.pickMenuMs) / 1000
        repeat {
            let now = menus(of: popUp, app: app)
            if let fresh = now.first(where: { m in !already.contains(where: { AX.same($0, m) }) && !AX.elements(m, "AXChildren").isEmpty }) {
                AX.setTimeout(fresh, seconds: InputTiming.axTimeoutS)
                return fresh
            }
            if wasExpanded == false, AX.bool(popUp, "AXExpanded") == true, let own = now.first(where: { m in already.contains(where: { AX.same($0, m) }) }) {
                return own
            }
            clock.sleep(ms: pollMs)
        } while clock.seconds() < deadline
        return nil
    }

    /// Whether the menu is still up: it answers its role, has items, and its pop up does not read collapsed.
    static func isOpen(_ menu: AXUIElement, popUp: AXUIElement) -> Bool {
        guard AX.string(menu, "AXRole") != nil, !AX.elements(menu, "AXChildren").isEmpty else { return false }
        return AX.bool(popUp, "AXExpanded") != false
    }

    /// Closes a menu the route opened: a grace for it to close itself, then AXCancel, then Escape to the pid.
    static func close(_ menu: AXUIElement, popUp: AXUIElement, pid: pid_t, clock: InputClock) {
        if !waitClosed(menu, popUp: popUp, ms: closeGraceMs, clock: clock) { return }
        if AX.actions(menu).contains("AXCancel"), AX.perform(menu, "AXCancel") == .success,
           !waitClosed(menu, popUp: popUp, ms: closeGraceMs, clock: clock) { return }
        postEscape(pid: pid)
        _ = waitClosed(menu, popUp: popUp, ms: closeGraceMs, clock: clock)
    }

    /// Waits up to `ms` for the menu to close; true while it is still open.
    private static func waitClosed(_ menu: AXUIElement, popUp: AXUIElement, ms: Int, clock: InputClock) -> Bool {
        let deadline = clock.seconds() + Double(ms) / 1000
        repeat {
            if !isOpen(menu, popUp: popUp) { return false }
            clock.sleep(ms: 10)
        } while clock.seconds() < deadline
        return isOpen(menu, popUp: popUp)
    }

    /// An Escape down and up posted to the pid alone: no other app hears it.
    static func postEscape(pid: pid_t) {
        let source = CGEventSource(stateID: .privateState)
        for down in [true, false] {
            CGEvent(keyboardEventSource: source, virtualKey: KeyCodes.escape, keyDown: down)?.postToPid(pid)
        }
    }
}
