import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The route facts of one step read from AX, lazily (docs/computer-protocol.md §24): `planRoutes`
/// asks only for what the verb needs, and what each read found is kept for the route that runs it.
final class LiveRoutes {
    unowned let engine: InputEngine
    let action: ComputerAction
    let target: InputTarget

    /// the combo's menu item and its match (§24.2)
    private(set) var menuItem: (AXUIElement, MenuMatch)?
    /// the hit walk's chain and its choice (§24.3)
    private(set) var chain: AXHit.Chain?
    private(set) var hitChoice: HitChoice?
    /// the screen point of a click or scroll, when it has one
    private(set) var point: ScreenPoint?
    /// the scroll area a scroll acts on (§24.5)
    private(set) var area: AXUIElement?
    /// §25.1: the step acts in a Chromium page, read once
    private var web: Bool?

    init(engine: InputEngine, action: ComputerAction, target: InputTarget) {
        self.engine = engine
        self.action = action
        self.target = target
    }

    var facts: RouteFacts {
        RouteFacts(
            menu: { [self] in readMenu() },
            hit: { [self] in readHit() },
            scrollBar: { [self] in readArea().map { AXTier.hasScrollBar($0, direction: action.scroll_direction ?? .down) } ?? false },
            pageScrolls: { [self] in readArea().map { Set(AX.actions($0).filter { $0.hasPrefix("AXScroll") && $0.hasSuffix("ByPage") }) } ?? [] },
            appActive: { [self] in NSRunningApplication(processIdentifier: target.pid)?.isActive ?? false },
            webContent: { [self] in readWeb() },
            commitExpected: { [self] in target.commitExpected?(action) ?? false }
        )
    }

    /// The named element, or for a scroll the scroll area or the element under its point, lies in an
    /// AXWebArea of a Chromium process; a scroll area holding the page counts too (§25.6).
    private func readWeb() -> Bool {
        if let web { return web }
        var found = false
        if target.chromium {
            if let e = target.element?.element, AX.inWebArea(e) {
                found = true
            } else if action.action == .scroll {
                let under = target.element == nil ? readPoint().flatMap { AXHit.element(at: $0, pid: target.pid, window: target.window) } : nil
                if let under, AX.inWebArea(under) { found = true }
                else if let area = readArea() { found = AX.inWebArea(area) || AXTier.webAreaChild(area) != nil }
                else if let e = target.element?.element { found = AXTier.webAreaChild(e) != nil }
            }
        }
        web = found
        return found
    }

    /// What `scroll-into-view` scans and measures against (§25.6): an overflow box inside the page is its
    /// own root, else the page's web area; the visible rect is the root's frame clipped to the scroll area
    /// around it and to the window.
    func intoViewRoot() -> (root: AXUIElement, visible: ComputerProtocol.Rect)? {
        let named = target.element?.element
        let area = readArea()
        let root: AXUIElement?
        if let area, AX.inWebArea(area) {
            root = area
        } else {
            let start = named ?? readPoint().flatMap { AXHit.element(at: $0, pid: target.pid, window: target.window) }
            root = start.flatMap { AX.ancestor($0, role: "AXWebArea", maxDepth: 256) } ?? area.flatMap(AXTier.webAreaChild) ?? named.flatMap(AXTier.webAreaChild)
        }
        guard let root, var visible = AX.frame(root) else { return nil }
        AX.setTimeout(root, seconds: InputTiming.axTimeoutS)
        if let area, !AX.same(area, root), let f = AX.frame(area) { visible = intersect(visible, f) ?? visible }
        guard let shown = intersect(visible, target.windowFrame) else { return nil }
        return (root, shown)
    }

    private func readMenu() -> MenuMatch? {
        guard let combo = try? parseKeyCombo(action.text ?? "") else { return nil }
        menuItem = engine.menuItem(combo, pid: target.pid)
        return menuItem?.1
    }

    private func readPoint() -> ScreenPoint? {
        if point == nil { point = try? engine.point(.end, action, target, fresh: false) }
        return point
    }

    private func readHit() -> HitChoice? {
        let start: AXUIElement?
        if let e = target.element?.element {
            start = e
            _ = readPoint()
        } else {
            start = readPoint().flatMap { AXHit.element(at: $0, pid: target.pid, window: target.window) }
        }
        guard let start else { return nil }
        let chain = AXHit.chain(from: start, window: target.window)
        self.chain = chain
        hitChoice = chooseHit(chain: chain.facts, verb: action.action, point: point)
        return hitChoice
    }

    private func readArea() -> AXUIElement? {
        if area == nil {
            let p = target.element == nil ? readPoint() : nil
            area = AXHit.scrollArea(element: target.element?.element, point: p, pid: target.pid, window: target.window)
            if let area { AX.setTimeout(area, seconds: InputTiming.axTimeoutS) }
        }
        return area
    }
}

extension InputTarget {
    /// The same target under another cancel flag: a `front` hold's, which also stops at its cap and the person's touch.
    func within(cancelled: @escaping @Sendable () -> Bool) -> InputTarget {
        var t = InputTarget(pid: pid, windowID: windowID, windowFrame: windowFrame, window: window, space: space, element: element, startElement: startElement,
                            cursor: cursor, cancelled: cancelled, pasteQuietMs: pasteQuietMs, ignored: ignored, callToken: callToken, personIdleMs: personIdleMs,
                            chromium: chromium, expectFocus: expectFocus, briefOf: briefOf)
        t.changedSince = changedSince
        t.commitExpected = commitExpected
        t.keepFrontOpen = keepFrontOpen
        return t
    }
}

extension InputEngine {
    /// A combo's menu item in the app's bar, through the pid's index (§24.2).
    func menuItem(_ combo: KeyCombo, pid: pid_t) -> (AXUIElement, MenuMatch)? {
        var cache = menuCache.take(pid)
        let found = lookUpMenu(combo, source: LiveMenuSource(app: AX.app(pid)), layout: layout, cache: &cache, now: { self.clock.seconds() })
        menuCache.put(pid, cache)
        return found
    }
}
