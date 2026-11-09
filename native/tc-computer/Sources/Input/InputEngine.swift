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
    private let sweeper: DispatchSourceTimer

    public init(clipboardLock: MacLock, sessionLock: MacLock,
                onPersonInput: @escaping @Sendable (pid_t) -> Void,
                onHeld: @escaping @Sendable (HeldEvent) -> Void,
                sink: EventSink = LiveEventSink(),
                pasteboard: PasteboardStore = SystemPasteboard(),
                layout: KeyLayoutSource = CurrentKeyLayout.shared,
                watch: PersonWatching = PersonWatch(),
                clock: InputClock = SystemClock()) {
        let host = LiveSessionHost()
        self.host = host
        self.clipboardLock = clipboardLock
        self.pasteboard = pasteboard
        self.sink = sink
        self.clock = clock
        self.layout = layout
        let core = InputCore(host: host, watch: watch, sessionLock: sessionLock, sink: sink, clock: clock, layout: layout, onPersonInput: onPersonInput, onHeld: onHeld)
        self.core = core
        host.onActivation = { [weak core] pid in core?.driver.noteActivation(pid: pid) }
        host.observeActivations()
        // the 30 s auto-release of a held button
        sweeper = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        sweeper.schedule(deadline: .now() + 1, repeating: 1)
        sweeper.setEventHandler { [weak core] in core?.held.sweep() }
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
        let facts = elementFacts(action, target)
        let held = core.held.heldTier(pid: target.pid)
        switch chooseTier(action, element: facts, tiers: tiers, held: held) {
        case .needs(let t):
            throw ComputerFailure(ComputerError(kind: .needsTier, message: "\(action.action.rawValue) needs the \(t.rawValue) tier, which is not allowed now.", needed: t))
        case .noInput:
            return InputOutcome(tier: nil, via: nil, clipboard: nil, cursor: target.cursor)
        case .run(let tier, _):
            if tier != .ax || action.action == .type { try requirePosting() }
            return try run(action, tier: tier, target: target, tiers: tiers, facts: facts, held: held)
        }
    }

    public func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport {
        dispatchPrecondition(condition: .notOnQueue(.main))
        try requireAccessibility()
        try requirePosting()
        let access = LiveProbeAccess(target: target, sink: sink, clock: clock)
        return ProbeRun(access: access, clock: clock).run(classes: classes.isEmpty ? [.scroll, .key, .click] : classes)
    }

    public func restoreSession() throws -> SessionRestore {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try core.restoreSession()
    }

    public func releaseHeld(pid: pid_t) {
        core.releaseHeld(pid: pid)
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

    /// What the tier choice reads: the named element, or for `type` and `paste` without one, the app's focused element.
    private func elementFacts(_ action: ComputerAction, _ target: InputTarget) -> ElementFacts? {
        if let e = target.element {
            AX.setTimeout(e.element, seconds: InputTiming.axTimeoutS)
            return AXTier.facts(e.element, role: e.role, actions: e.actions)
        }
        if action.action == .type, let focused = AX.element(AX.app(target.pid), "AXFocusedUIElement") {
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

    private func run(_ action: ComputerAction, tier: Tier, target: InputTarget, tiers: [Tier], facts: ElementFacts?, held: Tier?) throws -> InputOutcome {
        let axDone = { (clickAt: [Int]?) in
            InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: target.cursor, lastInputAt: self.clock.ticks(), clickAt: clickAt)
        }
        switch action.action {
        case .setValue:
            try AXTier.setValue(element(target, action), action.value ?? "")
            return axDone(nil)
        case .selectText:
            try AXTier.selectText(element(target, action), text: action.text, range: action.range, prefix: action.prefix, suffix: action.suffix, place: action.place)
            return axDone(nil)
        case .perform where isRaise(action):
            return try raise(action, target: target)
        case .perform:
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.perform(e, word: action.name ?? "", facts: facts ?? ElementFacts(role: e.role))
            return axDone(at)
        case .leftClick where tier == .ax:
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.press(e, facts: facts ?? ElementFacts(role: e.role))
            return axDone(at)
        case .rightClick where tier == .ax:
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.action(e, raw: "AXShowMenu", what: "show a menu")
            return axDone(at)
        case .doubleClick where tier == .ax:
            let e = try element(target, action)
            let at = axClickAt(e, target)
            try AXTier.action(e, raw: "AXOpen", what: "open")
            return axDone(at)
        case .scroll where tier == .ax:
            try AXTier.scrollPages(element(target, action), direction: action.scroll_direction ?? .down, pages: pagesFor(amount: action.scroll_amount ?? 1))
            return axDone(nil)
        case .type:
            return try type(action, target: target, tiers: tiers, chosen: tier, held: held)
        case .paste:
            let content = PasteContent.make(action.text ?? "", format: action.format)
            return try paste(content, tier: tier, target: target)
        default:
            return try events(action, tier: tier, target: target)
        }
    }

    /// `perform raise`: the AX call, as a session step with no activation of its own (A12).
    private func raise(_ action: ComputerAction, target: InputTarget) throws -> InputOutcome {
        let e = try element(target, action)
        let at = axClickAt(e, target)
        let (_, change, _) = try core.step(tier: .session, pid: target.pid, windowID: target.windowID, window: target.window, keys: false, activate: false, cancelled: target.cancelled) { _ in
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

    /// The event-posting verbs at `process` or `session`.
    private func events(_ action: ComputerAction, tier: Tier, target: InputTarget) throws -> InputOutcome {
        let name = action.action
        let modifiers = Self.isPointerVerb(name) ? try parseModifiers((action.text ?? "").isEmpty ? nil : action.text) : []
        let combo = Self.isKeyVerb(name) ? try parseKeyCombo(action.text ?? "") : nil
        if tier == .process {
            if Self.isPointerVerb(name) { try ProcessTier.requireNotMinimized(target.window) }
            if Self.isKeyVerb(name) { try ProcessTier.requireKeyWindow(pid: target.pid, window: target.window) }
        }
        let fresh = tier == .session
        let (at, change, last) = try core.step(tier: tier, pid: target.pid, windowID: target.windowID, window: target.window, keys: Self.isKeyVerb(name), cancelled: target.cancelled) { ctx -> ScreenPoint? in
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
