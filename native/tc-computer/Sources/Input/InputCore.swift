import ComputerCore
import ComputerProtocol
import Foundation

/// One event-posting step's context: the tier, where its events go, and the poster that checks the person and the cancel.
struct StepContext {
    let tier: Tier
    let pid: Int32
    let route: EventRoute
    var poster: Poster
    /// the cursor the step leaves, screen points
    var at: ScreenPoint?
}

/// Input without AX: the event-posting verbs at the process and session tiers, held input,
/// the session driver, the person's trip between calls, restore and the stale release.
/// Generic over the session host, so the tests drive it on a fake; InputEngine wraps it
/// with what it reads from AX (points, element facts, the key window, focus).
final class InputCore<Host: SessionHost>: @unchecked Sendable {
    let sink: EventSink
    let clock: InputClock
    let layout: KeyLayoutSource
    let held: HeldInput
    let driver: SessionDriver<Host>
    /// the person tripped the guard between calls: the pid, and the tokens of the calls it is for
    private let onPersonInput: @Sendable (pid_t, [Int]) -> Void
    private let state = NSLock()
    private var interruptedOnce: Set<Int32> = []

    init(host: Host, watch: PersonWatching, sessionLock: MacLock, sink: EventSink, clock: InputClock, layout: KeyLayoutSource, onPersonInput: @escaping @Sendable (pid_t, [Int]) -> Void, onHeld: @escaping @Sendable (HeldEvent) -> Void) {
        self.sink = sink
        self.clock = clock
        self.layout = layout
        self.onPersonInput = onPersonInput
        held = HeldInput(sink: sink, clock: clock, onHeld: onHeld)
        driver = SessionDriver(host: host, watch: watch, sessionLock: sessionLock, clock: clock)
        held.onSessionReleased = { [weak self] in
            guard let self else { return }
            self.driver.settle(holding: self.held.holdsSession)
        }
        driver.onTripBetweenCalls = { [weak self] tokens, stopped in
            guard let core = self else { return }
            // the watch calls on main; the release posts events and takes locks, never there
            DispatchQueue.global(qos: .userInitiated).async { core.personBetweenCalls(tokens: tokens, stoppedPid: stopped) }
        }
    }

    /// A trip with no step running, or one a step met (§14.9.5): let go of the held session input
    /// and fail each such pid's next call once; tell the shell, with the tokens of the calls the trip
    /// is for, for those pids or else for the guard's owner. `stoppedPid`: the step that stopped
    /// for the person lets go of its own pid's input, and its call fails, not the next.
    func personBetweenCalls(tokens: [Int] = [], stoppedPid: Int32? = nil) {
        let pids = held.sessionPids().filter { $0 != stoppedPid }
        driver.notePersonBetweenCalls()
        var left = tokens
        for pid in pids {
            held.releaseAll(pid: pid)
            state.withLock { _ = interruptedOnce.insert(pid) }
            onPersonInput(pid, left)
            left = []
        }
        if !left.isEmpty, let owner = driver.guardOwners.first(where: { !pids.contains($0) }) { onPersonInput(owner, left) }
        driver.settle(holding: held.holdsSession)
    }

    /// The pid's next call answers `interrupted` once after a trip between calls.
    func takeInterruption(pid: Int32) -> Bool {
        state.withLock { interruptedOnce.remove(pid) != nil }
    }

    /// Runs an event-posting step at `tier`: posted to the pid at `process`, inside the session
    /// driver at the HID tap at `session`. The body resolves its points itself (at the session
    /// tier, after activation moved things). Returns the body's value, the session change and
    /// the last input time.
    func step<T>(tier: Tier, pid: Int32, windowID: UInt32, window: Host.Window, keys: Bool, activate: Bool = true, call: SessionCall = SessionCall(), cancelled: @escaping @Sendable () -> Bool, body: (inout StepContext) throws -> T) throws -> (T, SessionChange?, UInt64?) {
        do {
            switch tier {
            case .session:
                let last = LastInput()
                let (value, change) = try driver.run(pid: pid, window: window, keys: keys, activate: activate, call: call, cancelled: cancelled, holding: { held.holdsSession }, lastInput: { last.ticks }) { check in
                    var ctx = StepContext(tier: .session, pid: pid, route: .hid, poster: Poster(sink: sink, clock: clock, route: .hid, check: check))
                    defer { last.ticks = ctx.poster.lastInputAt }
                    return try body(&ctx)
                }
                return (value, change, last.ticks)
            default:
                let check: () throws -> Void = { if cancelled() { throw cancelledFailure() } }
                let route = EventRoute.pid(pid, windowID: windowID)
                var ctx = StepContext(tier: tier, pid: pid, route: route, poster: Poster(sink: sink, clock: clock, route: route, check: check))
                let v = try body(&ctx)
                return (v, nil, ctx.poster.lastInputAt)
            }
        } catch {
            // a cancel or the person lets go of everything the pid holds, from earlier calls too
            if let kind = (error as? ComputerFailure)?.error.kind, kind == .cancelled || kind == .interrupted { held.releaseAll(pid: pid) }
            throw error
        }
    }

    /// `perform raise` (§5.2, §22.5): one session step with no activation of its own; a window in
    /// the Dock comes out first (`AXMinimized` false orders it over the person's front window, the
    /// reason this is the session tier's), then `raise` makes the AX call.
    func raiseWindow(pid: Int32, windowID: UInt32, window: Host.Window, element: Host.Window, call: SessionCall = SessionCall(), cancelled: @escaping @Sendable () -> Bool, raise: () throws -> Void) throws -> SessionChange? {
        let (_, change, _) = try step(tier: .session, pid: pid, windowID: windowID, window: window, keys: false, activate: false, call: call, cancelled: cancelled) { _ in
            if driver.host.minimized(element) { try driver.host.unminimize(element) }
            try raise()
        }
        return change
    }

    // MARK: the verbs

    /// A pointer verb at the session tier moves the real pointer there first.
    private func lead(_ ctx: StepContext, _ p: ScreenPoint) -> [SyntheticEvent] {
        ctx.tier == .session ? [.move(p, dragging: nil), .pause(ms: InputTiming.moveSettleMs)] : []
    }

    func click(_ ctx: inout StepContext, _ b: MouseButton, count: Int, at p: ScreenPoint, modifiers: Modifiers, duration: Double?) throws {
        let holdMs = duration.map { Int(($0 * 1000).rounded()) }
        let plan = EventPlans.click(b, at: p, count: count, modifiers: modifiers, holdMs: holdMs, moveFirst: ctx.tier == .session)
        try heldAround(ctx, button: b, modifiers: modifiers, at: p, recorded: holdMs != nil) { try ctx.poster.run(plan) }
        ctx.at = p
    }

    func drag(_ ctx: inout StepContext, from a: ScreenPoint, to b: ScreenPoint, modifiers: Modifiers) throws {
        let plan = lead(ctx, a) + EventPlans.drag(from: a, to: b, modifiers: modifiers)
        try heldAround(ctx, button: .left, modifiers: modifiers, at: a, recorded: true) { try ctx.poster.run(plan) }
        ctx.at = b
    }

    func move(_ ctx: inout StepContext, to p: ScreenPoint) throws {
        let dragging = held.hold(pid: ctx.pid) != nil
        try ctx.poster.run([.move(p, dragging: dragging ? .left : nil)])
        if dragging { held.moved(pid: ctx.pid, to: p) }
        ctx.at = p
    }

    /// `left_mouse_down`: the button stays down past the call, until `left_mouse_up` or a release.
    func mouseDown(_ ctx: inout StepContext, at p: ScreenPoint) throws {
        if held.hold(pid: ctx.pid) != nil {
            throw ComputerFailure(.actionUnsupported, "The left button is already down; send left_mouse_up first.")
        }
        held.pressing(held.record(pid: ctx.pid, tier: ctx.tier, kind: .button, at: p))
        do {
            try ctx.poster.run(lead(ctx, p) + [.down(.left, p, clickState: 1, flags: [])])
        } catch {
            held.released(pid: ctx.pid, kind: .button)
            throw error
        }
        ctx.poster.handOver()
        held.keep(pid: ctx.pid, Hold(tier: ctx.tier, route: ctx.route, at: p, since: clock.seconds()))
        ctx.at = p
    }

    /// `left_mouse_up`: at the point given, else where the button is.
    func mouseUp(_ ctx: inout StepContext, at p: ScreenPoint?) throws {
        let h = held.take(pid: ctx.pid)
        guard let at = p ?? h?.at else {
            throw ComputerFailure(ComputerError(kind: .outOfBounds, message: "No pointer position yet; give an element or a coordinate."))
        }
        defer { if h != nil { held.released(pid: ctx.pid, kind: .button) } }
        let up = SyntheticEvent.up(.left, at, clickState: 1, flags: [])
        do { try ctx.poster.run([up]) } catch {
            // the up is the release: a cancel or the person never leaves the button down
            if h != nil { sink.post(up, route: ctx.route) }
            throw error
        }
        ctx.at = at
    }

    func scroll(_ ctx: inout StepContext, _ d: ScrollDirection, clicks: Int, at p: ScreenPoint, modifiers: Modifiers) throws {
        try ctx.poster.run(lead(ctx, p) + EventPlans.scroll(d, clicks: clicks, at: p, modifiers: modifiers))
        ctx.at = p
    }

    func key(_ ctx: inout StepContext, _ combo: KeyCombo, repeat count: Int) throws {
        try ctx.poster.run(try EventPlans.chord(combo, layout: layout, repeat: count))
    }

    /// `hold_key`: the downs, `duration` slept in 50 ms slices checking the person and the cancel, the ups.
    func holdKey(_ ctx: inout StepContext, _ combo: KeyCombo, seconds: Double) throws {
        let (downs, ups) = try EventPlans.hold(combo, layout: layout)
        let codes = downs.compactMap { e -> UInt16? in
            switch e {
            case .key(let c, _, _), .modifier(let c, _, _): c
            default: nil
            }
        }
        held.pressing(held.record(pid: ctx.pid, tier: ctx.tier, kind: .key, keyCodes: codes))
        defer { held.released(pid: ctx.pid, kind: .key) }
        try ctx.poster.run(downs)
        var left = Int((seconds * 1000).rounded())
        while left > 0 {
            let slice = min(left, InputTiming.holdSliceMs)
            do { try ctx.poster.pause(slice) } catch {
                ctx.poster.releasePressed()
                throw error
            }
            left -= slice
        }
        try ctx.poster.run(ups)
    }

    /// Unicode key events for text, the person and the cancel checked between chunks.
    func typeKeys(_ ctx: inout StepContext, _ text: String) throws {
        try ctx.poster.run(EventPlans.typing(text))
    }

    /// Command-V.
    func commandV(_ ctx: inout StepContext) throws {
        try ctx.poster.run(try EventPlans.chord(KeyCombo(modifiers: .command, key: .character("v")), layout: layout, repeat: 1))
    }

    /// The ledger's word around a down that outlives one event pair (a held click, a drag),
    /// naming the button and the modifiers held with it, so a recovery lets go of all of them.
    private func heldAround(_ ctx: StepContext, button: MouseButton, modifiers: Modifiers, at p: ScreenPoint, recorded: Bool, _ post: () throws -> Void) throws {
        guard recorded else { return try post() }
        let codes = modifiers.each.compactMap { m in Modifiers.canonical.first { $0.0 == m }.flatMap { KeyCodes.modifierCodes[$0.1] } }
        held.pressing(held.record(pid: ctx.pid, tier: ctx.tier, kind: .button, button: button, at: p, keyCodes: codes.isEmpty ? nil : codes))
        defer { held.released(pid: ctx.pid, kind: .button) }
        try post()
    }

    // MARK: type's event rungs and the paste

    /// One change for keys that showed no effect and the paste after them: the keys' arm and the
    /// person's idle time then, the paste's last event and where it left the Mac. The paste's own arm
    /// read the keys as the latest input, so its span alone would hand the keys to the person. No
    /// watch runs between the two, so they merge only when the paste's arm saw nothing newer than
    /// the keys' last event; input in that gap is the person's, and the paste's own span keeps it so.
    func spanAcrossFallback(_ keys: SessionChange?, _ paste: SessionChange?) -> SessionChange? {
        guard let paste else { return keys }
        guard let keys, let armedAt = keys.armedAt, let idle = keys.idleAtArmMs, let keysLast = keys.lastInputAt else { return paste }
        if let pasteArmed = paste.armedAt, let pasteIdle = paste.idleAtArmMs, pasteArmed - pasteIdle > keysLast + Self.fallbackGapSlackMs { return paste }
        return SessionChange(
            frontmost: .init(before: keys.frontmost.before ?? paste.frontmost.before, after: paste.frontmost.after),
            pointer: .init(before: keys.pointer.before, after: paste.pointer.after),
            restorable: paste.restorable || keys.restorable,
            armedAt: armedAt,
            idleAtArmMs: idle,
            lastInputAt: paste.lastInputAt ?? keys.lastInputAt
        )
    }

    /// The idle time and the mach clock read the same event a few ms apart.
    static var fallbackGapSlackMs: Double { 50 }

    /// What `type`'s event rungs did.
    enum TypedBy {
        case keys(SessionChange?, UInt64?)
        case paste(ClipboardOutcome, SessionChange?, UInt64?)
    }

    /// `type`'s event rungs: keys when the text goes by keys, then the paste when it goes by
    /// paste (long text, a cluster key events can't carry) or the keys showed no effect.
    func typeByEvents(_ text: String, keys: () throws -> (StepEffect, SessionChange?, UInt64?), paste: () throws -> (ClipboardOutcome, SessionChange?, UInt64?)) throws -> TypedBy {
        var keysChange: SessionChange?
        if TypingRoute.route(text) == .keys {
            let (effect, change, last) = try keys()
            if !TypingRoute.pasteAfterKeys(effect) { return .keys(change, last) }
            keysChange = change
        }
        let (outcome, change, last) = try paste()
        return .paste(outcome, spanAcrossFallback(keysChange, change), last)
    }

    /// The paste flow inside one step at `tier`, Command-V delivered by the step. With `quietMs` the
    /// flow first refuses a recent foreign copy, once it holds the clipboard lock. `insert` is the
    /// AX insert rung (§24.6); `pressPaste` delivers Command-V as the app's Paste item when it
    /// answers true (§24.2), else the step posts the key.
    func paste(_ content: PasteContent, flow: PasteFlow, quietMs: Int?, tier: Tier, pid: Int32, windowID: UInt32, window: Host.Window, call: SessionCall = SessionCall(), cancelled: @escaping @Sendable () -> Bool, insert: (() throws -> StepEffect?)? = nil, pressPaste: (() throws -> Bool)? = nil, checks: () throws -> Void, recheck: () throws -> Void, evidence: () -> Evidence?,
               inside: ((_ part: (_ stopped: () -> Bool) throws -> Void) throws -> Void)? = nil) throws -> (PasteResult, SessionChange?, UInt64?) {
        var result = PasteResult(via: .paste, clipboard: .restored, effect: .unknown)
        let (_, change, last) = try step(tier: tier, pid: pid, windowID: windowID, window: window, keys: true, call: call, cancelled: cancelled) { ctx in
            result = try flow.run(content, quietMs: quietMs, cancelled: cancelled, insert: insert, checks: checks, recheck: recheck, deliver: {
                if let pressPaste, try pressPaste() { return }
                try commandV(&ctx)
            }, evidence: evidence, inside: inside)
        }
        return (result, change, last)
    }

    // MARK: release and restore

    func releaseHeld(pid: Int32) {
        held.releaseAll(pid: pid)
    }

    /// The ups of a record whose writer died, at its tier: to the pid for `process`, at the
    /// HID tap under the session lock for `session` (5 s, else it gives up and says so).
    func releaseStale(_ r: HeldRecord, log: (String) -> Void) {
        var ups: [SyntheticEvent] = []
        if r.kind == .button, let p = r.point, p.count == 2 {
            let b: MouseButton = r.button == 1 ? .right : r.button == 2 ? .middle : .left
            ups.append(.up(b, ScreenPoint(x: Double(p[0]), y: Double(p[1])), clickState: 1, flags: []))
        }
        for code in (r.keyCodes ?? []).reversed() {
            ups.append(KeyCodes.modifierCodes.values.contains(code) ? .modifier(code, down: false, flags: []) : .key(code, down: false, flags: []))
        }
        switch r.tier {
        case .session:
            guard let hold = try? driver.takeLock(cancelled: { false }, watchPerson: false) else {
                log("[input] a held \(r.kind.rawValue) of pid \(r.pid) was left: the session lock stayed taken")
                return
            }
            defer { hold.release() }
            for e in ups { sink.post(e, route: .hid) }
        default:
            for e in ups { sink.post(e, route: .pid(r.pid, windowID: 0)) }
        }
    }

    /// `input.restoreSession`: the held session-tier input let go first (so restore never waits on
    /// its own hold), then the driver's restore. A process-tier hold is another pid's business
    /// (a drag in another session) and stays down.
    func restoreSession(afterInterrupt: Bool = false) throws -> SessionRestore {
        held.releaseSession()
        driver.settle(holding: held.holdsSession)
        return try driver.restore(afterInterrupt: afterInterrupt)
    }
}

/// The session step's last posted event, read after its body returned or threw.
private final class LastInput {
    var ticks: UInt64?
}

extension HeldInput {
    /// The pids holding session-tier input.
    func sessionPids() -> [Int32] {
        allHolds().filter { $0.value.tier == .session }.map(\.key)
    }
}
