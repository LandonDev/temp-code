import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// Web content's live routes and checks (docs/computer-protocol.md §25.6 to §25.9): the read-back of a
/// value, `scroll-into-view`, a checkbox's evidence, and the focus check before keys.
extension AXTier {
    /// A value or a label quoted as an observation line quotes it.
    static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// `value_not_taken`: `[19] pop up "Plan" still reads "Choose a plan".`
    static func valueNotTaken(_ e: ResolvedElement, reads shown: String?, available: [String]? = nil, note: String? = nil) -> ComputerFailure {
        let reads = shown.map { "still reads \(quote($0))" } ?? "did not take the value"
        let message = "[\(e.index)] \(e.brief.line) \(note.map { "\($0); it " } ?? "")\(reads)."
        return ComputerFailure(ComputerError(kind: .valueNotTaken, message: message, element: e.index, available: available, value: shown))
    }

    /// §25.8: the verdict polled for up to `readBackMs`; still not taken fails `value_not_taken`, unreadable keeps the write's answer.
    static func confirmValue(_ e: ResolvedElement, clock: InputClock, read: () -> ReadBack.Verdict) throws {
        let deadline = clock.seconds() + Double(ComputerDefaults.ActionLimits.readBackMs) / 1000
        var last = read()
        while case .notTaken = last, clock.seconds() < deadline {
            clock.sleep(ms: 10)
            last = read()
        }
        if case .notTaken(let shown) = last { throw valueNotTaken(e, reads: shown) }
    }

    /// A scroll area's own AXWebArea child: Chrome's page sits in one.
    static func webAreaChild(_ e: AXUIElement) -> AXUIElement? {
        AX.elements(e, "AXChildren").first { AX.string($0, "AXRole") == "AXWebArea" }
    }

    /// the roles `scroll-into-view` may aim at: what a page's reader keeps as a line of its own
    static let intoViewRoles: Set<String> = [
        "AXRow", "AXCell", "AXStaticText", "AXLink", "AXHeading", "AXButton", "AXImage", "AXTextField", "AXTextArea",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider", "AXDisclosureTriangle"
    ]
    /// roles aimed at whole: their children start where they do
    static let intoViewLeaves: Set<String> = ["AXRow", "AXLink", "AXHeading", "AXButton", "AXCell"]
    static let intoViewMaxMs = 25.0

    /// `scroll-into-view` (§25.6): the element `IntoViewPlan` picks among the root's kept elements, in
    /// reading order within `intoViewMaxNodes` nodes and 25 ms, scrolled to with AXScrollToVisible and its
    /// frame read back for up to `readBackMs`. The element's line when it moved; nil when nothing was found,
    /// the action is not there or nothing moved, so the step goes on to the next route.
    static func scrollIntoView(root: AXUIElement, visible: ComputerProtocol.Rect, direction: ScrollDirection, clicks: Int, clock: InputClock) -> String? {
        guard let band = IntoViewPlan.band(visible: visible, direction: direction, clicks: clicks) else { return nil }
        let started = clock.seconds()
        var kept: [(AXUIElement, ComputerProtocol.Rect)] = []
        var stack = AX.elements(root, "AXChildren").reversed().map { $0 }
        var read = 0
        while let e = stack.popLast(), read < ComputerDefaults.AXWalk.intoViewMaxNodes, (clock.seconds() - started) * 1000 < intoViewMaxMs {
            read += 1
            AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
            let v = AX.many(e, ["AXRole", "AXPosition", "AXSize", "AXChildren"])
            let role = v[0] as? String ?? ""
            let frame = rect(position: v[1], size: v[2])
            guard IntoViewPlan.mayHold(frame, in: band) else { continue }
            if intoViewRoles.contains(role), let frame, IntoViewPlan.starts(frame, in: band) {
                kept.append((e, frame))
                if intoViewLeaves.contains(role) { continue }
            }
            let children = (v[3] as? [AnyObject] ?? []).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
            stack += children.reversed()
        }
        guard let i = IntoViewPlan.choose(kept.map(\.1), in: band) else { return nil }
        let (target, before) = kept[i]
        guard AX.actions(target).contains("AXScrollToVisible"), AX.perform(target, "AXScrollToVisible") == .success else { return nil }
        let deadline = clock.seconds() + Double(ComputerDefaults.ActionLimits.readBackMs) / 1000
        repeat {
            if IntoViewPlan.moved(before: before, after: AX.frame(target), direction: direction) { return webLine(target) }
            clock.sleep(ms: 10)
        } while clock.seconds() < deadline
        return nil
    }

    /// AXPosition and AXSize from a batched read.
    static func rect(position: CFTypeRef?, size: CFTypeRef?) -> ComputerProtocol.Rect? {
        guard let p = position, let s = size, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, sz = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
        return ComputerProtocol.Rect(x: point.x, y: point.y, w: sz.width, h: sz.height)
    }

    /// `row "Wuhan"`: the role and its name, a row or cell named by its first text when it has none of its own.
    static func webLine(_ e: AXUIElement) -> String {
        let own = [AX.string(e, "AXTitle"), AX.string(e, "AXDescription"), AX.string(e, "AXValue")]
        var names = own
        if own.allSatisfy({ ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { names.append(firstText(e)) }
        return AXHit.line(role: roleWord(e, fallback: nil), names: names)
    }

    /// The first static text under an element, three levels and 20 nodes at most.
    static func firstText(_ e: AXUIElement) -> String? {
        var queue: [(AXUIElement, Int)] = AX.elements(e, "AXChildren").map { ($0, 1) }
        var read = 0
        while !queue.isEmpty, read < 20 {
            let (c, depth) = queue.removeFirst()
            read += 1
            if AX.string(c, "AXRole") == "AXStaticText", let t = AX.string(c, "AXValue") ?? AX.string(c, "AXTitle"), !t.trimmingCharacters(in: .whitespaces).isEmpty { return t }
            if depth < 3 { queue += AX.elements(c, "AXChildren").map { ($0, depth + 1) } }
        }
        return nil
    }
}

extension InputEngine {
    /// §25.7: a web checkbox, radio or switch clicked by name: its value is the step's evidence.
    func togglesInPage(_ action: ComputerAction, facts: ElementFacts?, live: LiveRoutes) -> Bool {
        guard action.action == .leftClick, (action.text ?? "").isEmpty, action.duration == nil, let role = facts?.role else { return false }
        return ["checkbox", "radio", "switch"].contains(role) && live.facts.webContent()
    }

    /// The toggle's value read back for up to `readBackMs` after a route: `changed` once it differs.
    func toggleEffect(_ e: AXUIElement, before: String?, cancelled: () -> Bool) -> StepEffect {
        let deadline = clock.seconds() + Double(ComputerDefaults.ActionLimits.readBackMs) / 1000
        var after = AX.valueText(e)
        while ReadBack.toggle(before: before, after: after) == .none, clock.seconds() < deadline, !cancelled() {
            clock.sleep(ms: 10)
            after = AX.valueText(e)
        }
        return ReadBack.toggle(before: before, after: after)
    }

    /// §25.9's check of a key, `hold_key`, `type` or `paste` with no element in a Chromium window: the
    /// expectation first (AXFocused put back on the element the read showed, confirmed within
    /// `focusConfirmMs`), then the browser-field rule on whatever is focused. Runs before the step's first
    /// route and again inside a session step after its activation; throws `focus_moved`.
    func checkFocus(_ action: ComputerAction, target: InputTarget) throws {
        guard FocusCheck.applies(action, chromium: target.chromium) else { return }
        let app = AX.app(target.pid)
        var expectation: FocusExpectation = .none
        if let expected = target.expectFocus {
            expectation = refocus(expected.element, app: app) ? .held : .lost
        }
        let focused = AX.element(app, "AXFocusedUIElement").map { focusedFacts($0, target: target) }
        let menu = { [self] () -> MenuMatch? in
            guard let combo = try? parseKeyCombo(action.text ?? ""), hasMenuModifier(combo) else { return nil }
            return menuItem(combo, pid: target.pid)?.1
        }
        if case .refuse(let error) = FocusCheck.verdict(action, chromium: true, focused: focused, expectation: expectation, menu: menu) {
            throw ComputerFailure(error)
        }
    }

    /// The expected element focused, now or after AXFocused on it within `focusConfirmMs`.
    private func refocus(_ e: AXUIElement, app: AXUIElement) -> Bool {
        if AX.same(AX.element(app, "AXFocusedUIElement"), e) { return true }
        AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
        AX.set(e, "AXFocused", kCFBooleanTrue)
        let deadline = clock.seconds() + Double(InputTiming.focusConfirmMs) / 1000
        repeat {
            if AX.same(AX.element(app, "AXFocusedUIElement"), e) { return true }
            clock.sleep(ms: 10)
        } while clock.seconds() < deadline
        return false
    }

    private func focusedFacts(_ e: AXUIElement, target: InputTarget) -> FocusedFacts {
        AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
        return FocusedFacts(role: AXTier.roleWord(e, fallback: nil), inWebArea: AX.inWebArea(e), brief: target.briefOf(e), line: AXHit.line(e))
    }
}

/// The web routes for a caller outside the engine (tc-ax's hand run): the same code the steps run.
public enum WebControls {
    /// `pick`: the pop up's item by name, its value read back, any menu it opened closed; the item's title.
    public static func pick(_ e: ResolvedElement, value: String, pid: pid_t) throws -> String {
        try AXPick.pick(e, value: value, pid: pid, clock: SystemClock()).item
    }

    /// `scroll-into-view` from a web area, or an element in one: the line of what it scrolled to, nil when nothing moved.
    public static func scrollIntoView(_ e: ResolvedElement, direction: ScrollDirection, clicks: Int) -> String? {
        let root = AX.string(e.element, "AXRole") == "AXWebArea" ? e.element : (AX.ancestor(e.element, role: "AXWebArea", maxDepth: 256) ?? AXTier.webAreaChild(e.element))
        guard let root, let visible = AX.frame(root) else { return nil }
        return AXTier.scrollIntoView(root: root, visible: visible, direction: direction, clicks: clicks, clock: SystemClock())
    }
}
