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
    private let onPersonInput: @Sendable (pid_t) -> Void
    private let state = NSLock()
    private var interruptedOnce: Set<Int32> = []

    init(host: Host, watch: PersonWatching, sessionLock: MacLock, sink: EventSink, clock: InputClock, layout: KeyLayoutSource, onPersonInput: @escaping @Sendable (pid_t) -> Void, onHeld: @escaping @Sendable (HeldEvent) -> Void) {
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
        driver.onTripBetweenCalls = { [weak self] in
            guard let core = self else { return }
            // the watch calls on main; the release posts events and takes locks, never there
            DispatchQueue.global(qos: .userInitiated).async { core.personBetweenCalls() }
        }
    }

    /// A trip while session input is held between calls: let it go, tell the shell, fail the pid's next call once.
    func personBetweenCalls() {
        let pids = held.sessionPids()
        driver.notePersonBetweenCalls()
        for pid in pids {
            held.releaseAll(pid: pid)
            state.withLock { _ = interruptedOnce.insert(pid) }
            onPersonInput(pid)
        }
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
    func step<T>(tier: Tier, pid: Int32, windowID: UInt32, window: Host.Window, keys: Bool, activate: Bool = true, cancelled: @escaping @Sendable () -> Bool, body: (inout StepContext) throws -> T) throws -> (T, SessionChange?, UInt64?) {
        do {
            switch tier {
            case .session:
                var last: UInt64?
                let (value, change) = try driver.run(pid: pid, window: window, keys: keys, activate: activate, cancelled: cancelled, holding: { held.holdsSession }) { check in
                    var ctx = StepContext(tier: .session, pid: pid, route: .hid, poster: Poster(sink: sink, clock: clock, route: .hid, check: check))
                    defer { last = ctx.poster.lastInputAt }
                    return try body(&ctx)
                }
                return (value, change, last)
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

    /// `input.restoreSession`: every held input let go first (so restore never waits on its own hold), then the driver's restore.
    func restoreSession() throws -> SessionRestore {
        held.releaseEverything()
        driver.settle(holding: false)
        return try driver.restore()
    }
}

extension HeldInput {
    /// The pids holding session-tier input.
    func sessionPids() -> [Int32] {
        allHolds().filter { $0.value.tier == .session }.map(\.key)
    }
}
