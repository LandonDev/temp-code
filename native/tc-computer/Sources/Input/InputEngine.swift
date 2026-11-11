import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

/// Input: performs the spec's actions on one window and says which tier it used. The
/// pure InputCore posts the events and keeps held input and the session ledger; this reads
/// what it needs from AX (element facts, points, the key window, focus) and dispatches.
/// Every call is synchronous and runs off main (the shell's per-app action queue).
public final class InputEngine: InputPerforming, @unchecked Sendable {
    let core: InputCore<LiveSessionHost>
    let host: LiveSessionHost
    let clipboardLock: MacLock
    let pasteboard: PasteboardStore
    let sink: EventSink
    let clock: InputClock
    let layout: KeyLayoutSource
    /// each pid's index of menu key equivalents (§24.2)
    let menuCache = MenuIndexCache()
    /// the shell's pasteboard watch, asked right before a paste with the call's `pasteQuietMs`
    let recentForeignCopy: @Sendable (_ withinMs: Int) -> Bool
    /// the `front` tier's hold (§26.2)
    let frontTier: FrontTier
    /// the listen-only key monitor its quiet wait reads (§26.5), on while any computer session is open
    let keys = KeyMonitor()
    private let sweeper: DispatchSourceTimer

    public init(clipboardLock: MacLock, sessionLock: MacLock,
                recentForeignCopy: @escaping @Sendable (_ withinMs: Int) -> Bool = { _ in false },
                onPersonInput: @escaping @Sendable (pid_t, [Int]) -> Void,
                onHeld: @escaping @Sendable (HeldEvent) -> Void,
                sink: EventSink = LiveEventSink(),
                pasteboard: PasteboardStore = SystemPasteboard(),
                layout: KeyLayoutSource = CurrentKeyLayout.shared,
                watch: PersonWatching = PersonWatch(tap: LivePersonTap()),
                frontTap: PersonTapping? = LivePersonTap(),
                clock: InputClock = SystemClock()) {
        let host = LiveSessionHost()
        self.host = host
        self.clipboardLock = clipboardLock
        self.recentForeignCopy = recentForeignCopy
        self.pasteboard = pasteboard
        self.sink = sink
        self.clock = clock
        self.layout = layout
        let core = InputCore(host: host, watch: watch, sessionLock: sessionLock, sink: sink, clock: clock, layout: layout, onPersonInput: onPersonInput, onHeld: onHeld)
        self.core = core
        core.driver.trace = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
        frontTier = FrontTier(host: host, sessionLock: sessionLock, clock: clock, keyboard: keys, tap: frontTap)
        host.onActivation = { [weak core] pid in core?.driver.noteActivation(pid: pid) }
        host.observeActivations()
        // the 30 s auto-release of a held button, and the person guard's end (§14.9.2)
        sweeper = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        sweeper.schedule(deadline: .now() + 1, repeating: 1)
        sweeper.setEventHandler { [weak core] in
            core?.held.sweep()
            core?.driver.sweepGuard()
        }
        sweeper.resume()
    }

    deinit {
        sweeper.cancel()
    }

    // MARK: InputPerforming

    public func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome {
        dispatchPrecondition(condition: .notOnQueue(.main))
        if core.takeInterruption(pid: target.pid) { throw interruptedByPerson() }
        switch action.action {
        case .screenshot, .zoom, .wait, .unknown:
            throw ComputerFailure(.actionUnsupported, "\(action.action.rawValue) is not an input action.")
        case .cursorPosition:
            return InputOutcome(tier: nil, via: nil, clipboard: nil, cursor: cursorNow(target))
        default:
            break
        }
        try requireAccessibility()
        if target.cancelled() { throw cancelledFailure() }
        // decision 23: a path typed into a save panel's name field is saved as a file named with colons
        if [.setValue, .type, .paste].contains(action.action), let e = target.element?.element,
           let refusal = nameFieldRefusal(identifier: AX.string(e, "AXIdentifier"), text: action.value ?? action.text ?? "") {
            throw ComputerFailure(refusal)
        }
        let facts = elementFacts(action, target)
        let held = core.held.heldTier(pid: target.pid)
        let live = LiveRoutes(engine: self, action: action, target: target)
        // §25.9: keys with no element in a Chromium window go where the read said, or nowhere
        try checkFocus(action, target: target)
        switch planRoutes(action, element: facts, facts: live.facts, tiers: tiers, held: held, ignored: target.ignored) {
        case .needs(let t, let menu):
            throw needsTier(action, t, menu: menu, pid: target.pid)
        case .disabledMenu(let path):
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(path.joined(separator: " › ")) is disabled.", menu: path))
        case .noInput:
            return InputOutcome(tier: nil, via: nil, clipboard: nil, cursor: target.cursor)
        case .runs(let steps, let needed, let menu):
            // §24.1: the next try only when one did nothing it could tell; a web checkbox tells by its value alone (§25.7)
            let toggle = togglesInPage(action, facts: facts, live: live) ? target.element?.element : nil
            for (i, step) in steps.enumerated() {
                if step.tier != .ax || action.action == .type { try requirePosting() }
                let before = toggle.flatMap(AX.valueText)
                let rest = Array(steps.dropFirst(i + 1))
                do {
                    var outcome = try run(action, step: step, rest: rest, target: target, tiers: tiers, facts: facts, held: held, live: live)
                    if let toggle {
                        let effect = toggleEffect(toggle, before: before, cancelled: target.cancelled)
                        if effect == .none, i < steps.count - 1 { continue }
                        outcome.effect = effect
                    }
                    return outcome
                } catch is RouteFellThrough {
                    continue
                } catch let failure as ComputerFailure where Self.retriesForKeyWindow(failure, action: action, at: step) {
                    // §5.2, decision 10: a key or paste the background window refused goes to `front`, which makes it key
                    guard let retry = keyWindowRetry(rest) else { throw failure }
                    return try run(action, step: retry, rest: [], target: target, tiers: tiers, facts: facts, held: held, live: live)
                }
            }
            throw needsTier(action, needed ?? .session, menu: menu, pid: target.pid)
        }
    }

    /// A `key` or `paste` refused `key_window_unavailable` at `process`.
    private static func retriesForKeyWindow(_ failure: ComputerFailure, action: ComputerAction, at step: RouteStep) -> Bool {
        failure.error.kind == .keyWindowUnavailable && step.tier == .process && (action.action == .key || action.action == .paste)
    }

    /// `needs_tier`; a disabled menu item names itself and why (§24.2).
    private func needsTier(_ action: ComputerAction, _ t: Tier, menu: [String]?, pid: pid_t) -> ComputerFailure {
        if let menu {
            let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the app"
            return ComputerFailure(ComputerError(kind: .needsTier, message: "\(menu.joined(separator: " › ")) is disabled while \(app) is in the background.", needed: t, menu: menu))
        }
        return ComputerFailure(ComputerError(kind: .needsTier, message: "\(action.action.rawValue) needs the \(t.rawValue) tier, which is not allowed now.", needed: t))
    }

    /// A menu item's title path (`["File", "Save"]`), nil for anything else: what the commit check
    /// names a pressed item by (§26.9).
    public static func menuItemPath(_ e: AXUIElement) -> [String]? {
        AX.string(e, "AXRole") == "AXMenuItem" ? AXTier.menuPath(e) : nil
    }

    public func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport {
        dispatchPrecondition(condition: .notOnQueue(.main))
        try requireAccessibility()
        try requirePosting()
        let access = LiveProbeAccess(target: target, sink: sink, clock: clock)
        return ProbeRun(access: access, clock: clock).run(classes: classes.isEmpty ? [.scroll, .key, .click] : classes)
    }

    public func restoreSession(afterInterrupt: Bool) throws -> SessionRestore {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try core.restoreSession(afterInterrupt: afterInterrupt)
    }

    public func watchKeys(_ on: Bool) {
        if on { keys.start() } else { keys.stop() }
    }

    public func closeFrontHold(pid: pid_t) {
        frontTier.closeOpen(pid: pid)
    }

    public func takeFrontReport(pid: pid_t) -> FrontHold? {
        frontTier.takeReport(pid: pid)
    }

    public func releaseHeld(pid: pid_t) {
        core.releaseHeld(pid: pid)
    }

    public func callBegan(pid: pid_t) -> Int {
        core.driver.callBegan(pid: pid)
    }

    public func callEnded(_ token: Int) {
        core.driver.callEnded(token)
    }

    public func endGuard() {
        core.driver.endGuard()
    }

    public func releaseStale(_ record: HeldRecord) {
        core.releaseStale(record) { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
    }

    // MARK: checks

    private func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw ComputerFailure(ComputerError(kind: .permissionMissing, message: "TempCode needs the Accessibility permission to act in apps.", which: .accessibility))
        }
    }

    private func requirePosting() throws {
        guard CGPreflightPostEventAccess() else {
            throw ComputerFailure(ComputerError(kind: .permissionMissing, message: "TempCode needs the Accessibility permission to send input.", which: .accessibility))
        }
    }

    /// The agent cursor; while a session-tier button is held, the real pointer in the space.
    private func cursorNow(_ target: InputTarget) -> [Int]? {
        if core.held.heldTier(pid: target.pid) == .session {
            return toSpace(host.pointer(), frame: target.windowFrame, space: target.space)
        }
        return target.cursor
    }

    /// What the route choice reads: the named element, or for `type` and `paste` without one, the app's focused element.
    private func elementFacts(_ action: ComputerAction, _ target: InputTarget) -> ElementFacts? {
        if let e = target.element {
            AX.setTimeout(e.element, seconds: InputTiming.axTimeoutS)
            return AXTier.facts(e.element, role: e.role, actions: e.actions)
        }
        if action.action == .type || action.action == .paste, let focused = AX.element(AX.app(target.pid), "AXFocusedUIElement") {
            AX.setTimeout(focused, seconds: InputTiming.axTimeoutS)
            return AXTier.facts(focused, role: nil, actions: AX.actions(focused))
        }
        return nil
    }

    private func element(_ target: InputTarget, _ action: ComputerAction) throws -> ResolvedElement {
        guard let e = target.element else {
            throw ComputerFailure(.noSuchElement, "\(action.action.rawValue) needs an element.")
        }
        return e
    }

    // MARK: dispatch

    private func run(_ action: ComputerAction, step: RouteStep, rest: [RouteStep], target: InputTarget, tiers: [Tier], facts: ElementFacts?, held: Tier?, live: LiveRoutes) throws -> InputOutcome {
        if step.route == .panel {
            // the panel flow keeps its own holds, one per part that needs the app in front
            return try saveAs(action, target: target, tiers: tiers, at: step.tier)
        }
        // decision 4: a hold left open for this step is joined only by a `front` step; anything else runs after the restore
        // (any app's hold before a session step, which needs the session lock the hold keeps)
        if step.tier == .session { frontTier.closeOpen() } else if step.tier != .front { frontTier.closeOpen(pid: target.pid) }
        if step.tier == .front, step.route == .events, action.action == .paste {
            // decision 3: the paste's pasteboard work stays outside the hold, which it enters for the press alone
            let content = PasteContent.make(action.text ?? "", format: action.format)
            return try paste(content, tier: .front, target: target)
        }
        if step.tier == .front {
            return try runFront(action, step: step, rest: rest, target: target, tiers: tiers, facts: facts, live: live)
        }
        if step.tier == .session, step.route == .element, let item = facts?.menuItem {
            return try menuItemAtSession(action, item: item, target: target, facts: facts)
        }
        return try dispatch(action, step: step, rest: rest, target: target, tiers: tiers, facts: facts, held: held, live: live)
    }

    /// One `front` step: its route inside a hold (§26.2, §26.3), `step.front` on the outcome.
    private func runFront(_ action: ComputerAction, step: RouteStep, rest: [RouteStep], target: InputTarget, tiers: [Tier], facts: ElementFacts?, live: LiveRoutes) throws -> InputOutcome {
        let app = NSRunningApplication(processIdentifier: target.pid)?.localizedName ?? "The app"
        let (out, report) = try frontTier.hold(pid: target.pid, window: target.window, app: app, cancelled: target.cancelled, changedSince: target.changedSince, keepOpen: target.keepFrontOpen) { ctx in
            let inner = target.within(cancelled: ctx.cancelled)
            var out: InputOutcome
            switch (step.route, action.action) {
            case (.menu, _):
                // the shortcut's item, read again now the app is active; still disabled: action_unsupported
                guard let (item, match) = live.menuItem else { throw RouteFellThrough() }
                try enabledInHold(item, path: match.path, ctx: ctx)
                try ctx.check()
                try AXTier.pressMenu(item, match: match, count: action.repeat ?? 1)
                out = InputOutcome(tier: .front, via: .menu, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: match.line)
            case (.element, _) where facts?.menuItem != nil:
                let path = facts!.menuItem!.path
                let e = try element(inner, action)
                try enabledInHold(e.element, path: path, ctx: ctx)
                try ctx.check()
                AX.setTimeout(e.element, seconds: ctx.axTimeout)
                try pressMenuItem(e, action: action, facts: facts!)
                out = InputOutcome(tier: .front, via: .menu, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: path.joined(separator: " › "))
            case (.element, .setValue), (.element, .selectText), (.element, .perform):
                if let e = inner.element?.element { AX.setTimeout(e, seconds: ctx.axTimeout) }
                out = try dispatch(action, step: RouteStep(.ax, .element), rest: [], target: inner, tiers: tiers, facts: facts, held: nil, live: live)
            default:
                out = try dispatch(action, step: step, rest: rest, target: inner, tiers: tiers, facts: facts, held: nil, live: live)
            }
            out.tier = .front
            return out
        }
        return out.with(front: report)
    }

    /// A named menu item's AXEnabled, read again inside the hold: AppKit re-validates it once the app is
    /// active, so it is polled for a moment before it counts as disabled.
    func enabledInHold(_ item: AXUIElement, path: [String], ctx: FrontHoldContext) throws {
        let deadline = clock.seconds() + Double(InputTiming.frontSettleMs) / 1000
        while AX.bool(item, "AXEnabled") != true {
            try ctx.check()
            if clock.seconds() >= deadline {
                throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(path.joined(separator: " › ")) is disabled.", menu: path))
            }
            clock.sleep(ms: InputTiming.frontPollMs)
        }
    }

    /// `perform pick`/`press` or a click on a menu item: AXPress (or the named word).
    private func pressMenuItem(_ e: ResolvedElement, action: ComputerAction, facts: ElementFacts) throws {
        if action.action == .perform { try AXTier.perform(e, word: action.name ?? "", facts: facts) } else { try AXTier.press(e, facts: facts) }
    }

    /// A menu item the background disables, with `front` not allowed: pressed inside a session step,
    /// which activates the app first (§24.2, decision 10).
    private func menuItemAtSession(_ action: ComputerAction, item: NamedMenuItem, target: InputTarget, facts: ElementFacts?) throws -> InputOutcome {
        let e = try element(target, action)
        let (_, change, _) = try core.step(tier: .session, pid: target.pid, windowID: target.windowID, window: target.window, keys: false, cancelled: target.cancelled) { _ in
            try pressMenuItem(e, action: action, facts: facts ?? ElementFacts(role: e.role))
        }
        return InputOutcome(tier: .session, via: .menu, clipboard: nil, cursor: target.cursor, session: change, lastInputAt: clock.ticks(), on: item.path.joined(separator: " › "))
    }

    private func dispatch(_ action: ComputerAction, step: RouteStep, rest: [RouteStep], target: InputTarget, tiers: [Tier], facts: ElementFacts?, held: Tier?, live: LiveRoutes) throws -> InputOutcome {
        let tier = step.tier
        let axDone = { (clickAt: [Int]?) in
            InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: target.cursor, lastInputAt: self.clock.ticks(), clickAt: clickAt)
        }
        switch (step.route, action.action) {
        case (.element, .setValue):
            // §25.8: in a page the value is read back
            try AXTier.setValue(element(target, action), action.value ?? "", readBack: live.facts.webContent(), clock: clock)
            return axDone(nil)
        case (.pick, _):
            let picked = try AXPick.pick(element(target, action), value: action.value ?? "", pid: target.pid, clock: clock)
            return InputOutcome(tier: .ax, via: .pick, clipboard: nil, cursor: target.cursor, lastInputAt: picked.changed ? clock.ticks() : nil, on: picked.item)
        case (.scrollIntoView, _):
            guard let (root, visible) = live.intoViewRoot(),
                  let on = AXTier.scrollIntoView(root: root, visible: visible, direction: action.scroll_direction ?? .down, clicks: action.scroll_amount ?? 1, clock: clock) else { throw RouteFellThrough() }
            return InputOutcome(tier: .ax, via: .scrollIntoView, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: on)
        case (.element, .selectText):
            try AXTier.selectText(element(target, action), text: action.text, range: action.range, prefix: action.prefix, suffix: action.suffix, place: action.place)
            return axDone(nil)
        case (.element, .perform) where isRaise(action):
            return try raise(action, target: target)
        case (.element, .perform):
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.perform(e, word: action.name ?? "", facts: facts ?? ElementFacts(role: e.role))
            return axDone(at)
        case (.element, .leftClick):
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.press(e, facts: facts ?? ElementFacts(role: e.role))
            return axDone(at)
        case (.element, .rightClick):
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.action(e, raw: "AXShowMenu", what: "show a menu")
            return axDone(at)
        case (.element, .doubleClick):
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.action(e, raw: "AXOpen", what: "open")
            return axDone(at)
        case (.element, .type), (.events, .type):
            return try type(action, target: target, tiers: tiers, chosen: tier, held: held)
        case (.menu, _):
            return try menu(action, target: target, live: live)
        case (.hit, _), (.caret, _):
            return try hit(action, route: step.route, target: target, live: live)
        case (.scrollBar, _):
            guard let area = live.area, let move = try AXTier.moveScrollBar(area, direction: action.scroll_direction ?? .down, clicks: action.scroll_amount ?? 1) else { throw RouteFellThrough() }
            // a bar already at the end changes nothing: the step reads `none`, no other route tried
            return InputOutcome(tier: .ax, via: .scrollBar, clipboard: nil, cursor: target.cursor, lastInputAt: move == .atEnd ? nil : clock.ticks())
        case (.scrollPage, _):
            guard let e = target.element?.element ?? live.area else { throw RouteFellThrough() }
            try AXTier.scrollPages(e, index: target.element?.index, direction: action.scroll_direction ?? .down, pages: pagesFor(amount: action.scroll_amount ?? 1))
            return InputOutcome(tier: .ax, via: .scrollPage, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks())
        case (.insert, _):
            let content = PasteContent.make(action.text ?? "", format: action.format)
            // with an event tier after it, the insert is the paste flow's first rung; alone, it is the step
            if let next = rest.first(where: { $0.route == .events }) {
                try requirePosting()
                return try paste(content, tier: next.tier, target: target, insertFirst: true, recheck: { try self.checkFocus(action, target: target) })
            }
            guard let effect = try insertOnly(content.plain, target: target), effect != .none else { throw RouteFellThrough() }
            return InputOutcome(tier: .ax, via: .axInsert, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks())
        case (.events, .paste):
            let content = PasteContent.make(action.text ?? "", format: action.format)
            return try paste(content, tier: tier, target: target, recheck: { try self.checkFocus(action, target: target) })
        default:
            return try events(action, tier: tier, target: target)
        }
    }

    /// `menu`: the combo's item, enabled, pressed through AX on the app's focused window (§24.2).
    private func menu(_ action: ComputerAction, target: InputTarget, live: LiveRoutes) throws -> InputOutcome {
        guard let (item, match) = live.menuItem, match.enabled else { throw RouteFellThrough() }
        // a menu item acts on the app's focused window: the key-window rule holds
        try ProcessTier.requireKeyWindow(pid: target.pid, window: target.window)
        // a key with an element: the item acts on the focus, which goes there first (§25.9)
        if let e = target.element { try ProcessTier.confirmFocus(e, pid: target.pid, clock: clock) }
        try AXTier.pressMenu(item, match: match, count: action.repeat ?? 1)
        return InputOutcome(tier: .ax, via: .menu, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: match.line)
    }

    /// `hit` and `caret`: the element under the click given its action, or the caret at the clicked character (§24.3, §24.4).
    private func hit(_ action: ComputerAction, route: Route, target: InputTarget, live: LiveRoutes) throws -> InputOutcome {
        guard let choice = live.hitChoice, let chain = live.chain, chain.elements.indices.contains(choice.level) else { throw RouteFellThrough() }
        let e = chain.elements[choice.level]
        let on = AXHit.line(e)
        let clickAt = live.point.map { toSpace($0, frame: target.windowFrame, space: target.space) }
            ?? AX.frame(e).flatMap { ClickMark.axPoint(frame: $0, visible: AX.ancestor(e, role: "AXScrollArea").flatMap(AX.frame), window: target.windowFrame, space: target.space) }
        let cursor = action.coordinate ?? target.cursor
        if route == .caret {
            guard let point = live.point, try AXTier.placeCaret(e, at: point, clock: clock) != .none else { throw RouteFellThrough() }
            return InputOutcome(tier: .ax, via: .caret, clipboard: nil, cursor: cursor, lastInputAt: clock.ticks(), clickAt: clickAt, on: on)
        }
        try AXTier.pressHit(e, action: choice.action)
        return InputOutcome(tier: .ax, via: .hit, clipboard: nil, cursor: cursor, lastInputAt: clock.ticks(), clickAt: clickAt, on: on)
    }

    /// `perform raise`: the AX call, as a session step with no activation of its own (A12); out of the Dock first (§22.5).
    private func raise(_ action: ComputerAction, target: InputTarget) throws -> InputOutcome {
        let e = try element(target, action)
        let at = axClickAt(e, target)
        let change = try core.raiseWindow(pid: target.pid, windowID: target.windowID, window: target.window, element: e.element, call: target.sessionCall, cancelled: target.cancelled) {
            let err = AX.perform(e.element, "AXRaise")
            if err != .success { throw AX.failure(err, element: e.index, what: "be raised") }
        }
        return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: target.cursor, session: change, lastInputAt: clock.ticks(), clickAt: at)
    }

    private static func isKeyVerb(_ a: ComputerActionName) -> Bool {
        a == .key || a == .holdKey
    }

    private static func isPointerVerb(_ a: ComputerActionName) -> Bool {
        switch a {
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftClickDrag, .mouseMove, .leftMouseDown, .leftMouseUp, .scroll: true
        default: false
        }
    }

    /// The event-posting verbs at `process`, `front` (posted to the pid inside a hold) or `session`.
    private func events(_ action: ComputerAction, tier: Tier, target: InputTarget) throws -> InputOutcome {
        let name = action.action
        let modifiers = Self.isPointerVerb(name) ? try parseModifiers((action.text ?? "").isEmpty ? nil : action.text) : []
        let combo = Self.isKeyVerb(name) ? try parseKeyCombo(action.text ?? "") : nil
        if tier == .process {
            if Self.isPointerVerb(name) { try ProcessTier.requireNotMinimized(target.window) }
            if Self.isKeyVerb(name) {
                // §25.9: a key with an element focuses it first
                if let e = target.element { try ProcessTier.confirmFocus(e, pid: target.pid, clock: clock) }
                try ProcessTier.requireKeyWindow(pid: target.pid, window: target.window)
            }
        }
        let fresh = tier == .session
        let (at, change, last) = try core.step(tier: tier, pid: target.pid, windowID: target.windowID, window: target.window, keys: Self.isKeyVerb(name), call: target.sessionCall, cancelled: target.cancelled) { ctx -> ScreenPoint? in
            // activation may move the focus: the element taken again, or the keys checked again, before any event
            if fresh, Self.isKeyVerb(name) {
                if let e = target.element { try ProcessTier.confirmFocus(e, pid: target.pid, clock: clock) } else { try checkFocus(action, target: target) }
            }
            switch name {
            case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick:
                let button: MouseButton = name == .rightClick ? .right : name == .middleClick ? .middle : .left
                let count = name == .doubleClick ? 2 : name == .tripleClick ? 3 : 1
                try core.click(&ctx, button, count: count, at: point(.end, action, target, fresh: fresh), modifiers: modifiers, duration: action.duration)
            case .leftClickDrag:
                try core.drag(&ctx, from: point(.start, action, target, fresh: fresh), to: point(.end, action, target, fresh: fresh), modifiers: modifiers)
            case .mouseMove:
                try core.move(&ctx, to: point(.end, action, target, fresh: fresh))
            case .leftMouseDown:
                try core.mouseDown(&ctx, at: point(.end, action, target, fresh: fresh))
            case .leftMouseUp:
                // at the agent cursor when there is one, else where the button is
                let p: ScreenPoint? = try target.cursor == nil ? nil : point(.end, action, target, fresh: fresh)
                try core.mouseUp(&ctx, at: p)
            case .scroll:
                try core.scroll(&ctx, action.scroll_direction ?? .down, clicks: action.scroll_amount ?? 1, at: point(.end, action, target, fresh: fresh), modifiers: modifiers)
            case .key:
                try core.key(&ctx, combo!, repeat: action.repeat ?? 1)
            case .holdKey:
                try core.holdKey(&ctx, combo!, seconds: action.duration ?? 0)
            default:
                throw ComputerFailure(.actionUnsupported, "\(name.rawValue) has no \(tier.rawValue)-tier form.")
            }
            return ctx.at
        }
        let frame = fresh ? (AX.frame(target.window) ?? target.windowFrame) : target.windowFrame
        let cursor = at.map { toSpace($0, frame: frame, space: target.space) } ?? target.cursor
        let clickAt = ClickMark.eventPoint(name, at: at, frame: frame, space: target.space)
        return InputOutcome(tier: tier, via: nil, clipboard: nil, cursor: cursor, session: change, lastInputAt: last, clickAt: clickAt)
    }

    /// An `ax` click's mark: the element's frame from the tree, clipped to its scroll area's visible frame
    /// (read before the action, which may take the element away). It moves no pointer.
    private func axClickAt(_ e: ResolvedElement, _ target: InputTarget) -> [Int]? {
        let visible = AX.ancestor(e.element, role: "AXScrollArea").flatMap(AX.frame)
        return ClickMark.axPoint(frame: e.frame, visible: visible, window: target.windowFrame, space: target.space)
    }

    // MARK: points

    enum End { case start, end }

    /// The screen point an action aims at: its element's visible centre, its coordinate, or the
    /// agent cursor. At the session tier the frames are read again, since activation can move them.
    func point(_ which: End, _ action: ComputerAction, _ target: InputTarget, fresh: Bool) throws -> ScreenPoint {
        let window = fresh ? (AX.frame(target.window) ?? target.windowFrame) : target.windowFrame
        if let e = which == .start ? target.startElement : target.element {
            var frame = fresh ? (AX.frame(e.element) ?? e.frame) : e.frame
            let area = AX.ancestor(e.element, role: "AXScrollArea")
            if let p = pointIn(frame, visible: area.flatMap(AX.frame), window: window) { return p }
            if AX.actions(e.element).contains("AXScrollToVisible"), AX.perform(e.element, "AXScrollToVisible") == .success {
                frame = AX.frame(e.element) ?? frame
                if let p = pointIn(frame, visible: area.flatMap(AX.frame), window: window) { return p }
            }
            throw notShowing(frame, index: e.index, window: window, space: target.space)
        }
        if let c = which == .start ? action.start_coordinate : action.coordinate {
            return try toScreen(c, frame: window, space: target.space)
        }
        if which == .end, let cursor = target.cursor {
            return try toScreen(cursor, frame: window, space: target.space)
        }
        throw ComputerFailure(ComputerError(kind: .outOfBounds, message: "No pointer position yet; give an element or a coordinate.", space: target.space))
    }
}

extension InputTarget {
    /// The call a session step is in, as the person guard reads it.
    var sessionCall: SessionCall { SessionCall(token: callToken, personIdleMs: personIdleMs) }
}
