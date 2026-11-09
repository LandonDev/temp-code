import ComputerCore
import ComputerProtocol

/// Where a posted event goes.
public enum EventRoute: Equatable, Sendable {
    /// the process tier: to the app's pid, mouse events carrying the target window (fields 91 and 92)
    case pid(Int32, windowID: UInt32)
    /// the session tier: the HID tap, so it moves the real pointer and types at the focused field
    case hid
}

/// What posts Input's events; LiveEventSink makes CGEvents, the tests record.
public protocol EventSink: AnyObject, Sendable {
    /// Posts one event; `pause` never reaches a sink.
    func post(_ event: SyntheticEvent, route: EventRoute)
}

/// Runs an event plan on a sink: a check before every event and inside every pause,
/// the gap between events, the last input time, and the ups for whatever the plan
/// left down when the check throws.
struct Poster {
    let sink: EventSink
    let clock: InputClock
    let route: EventRoute
    /// throws `cancelled` or `interrupted`
    let check: () throws -> Void
    private(set) var lastInputAt: UInt64?
    private var buttons: [(MouseButton, ScreenPoint)] = []
    private var keys: [UInt16] = []
    private var modifiers: [UInt16] = []

    init(sink: EventSink, clock: InputClock, route: EventRoute, check: @escaping () throws -> Void) {
        self.sink = sink
        self.clock = clock
        self.route = route
        self.check = check
    }

    /// Runs the plan; on a throw, posts the ups of what it pressed and rethrows.
    mutating func run(_ events: [SyntheticEvent]) throws {
        do {
            for (i, e) in events.enumerated() {
                if case .pause(let ms) = e {
                    try pause(ms)
                    continue
                }
                try check()
                sink.post(e, route: route)
                lastInputAt = clock.ticks()
                track(e)
                if i < events.count - 1, events[i + 1].posts { clock.sleep(ms: InputTiming.eventGapMs) }
            }
        } catch {
            releasePressed()
            throw error
        }
    }

    /// A pause in slices, checking between them.
    func pause(_ ms: Int) throws {
        var left = ms
        while left > 0 {
            try check()
            let slice = min(left, InputTiming.watchSliceMs)
            clock.sleep(ms: slice)
            left -= slice
        }
        try check()
    }

    /// Posts the ups for every button and key still down, last pressed first.
    mutating func releasePressed() {
        for (b, p) in buttons.reversed() { sink.post(.up(b, p, clickState: 1, flags: []), route: route) }
        for k in keys.reversed() { sink.post(.key(k, down: false, flags: []), route: route) }
        for m in modifiers.reversed() { sink.post(.modifier(m, down: false, flags: []), route: route) }
        if !buttons.isEmpty || !keys.isEmpty || !modifiers.isEmpty { lastInputAt = clock.ticks() }
        buttons = []
        keys = []
        modifiers = []
    }

    /// Whether the plan so far left anything down.
    var pressing: Bool { !buttons.isEmpty || !keys.isEmpty || !modifiers.isEmpty }

    /// Forgets what is down without posting ups: a hold that outlives the plan is HeldInput's now.
    mutating func handOver() {
        buttons = []
        keys = []
        modifiers = []
    }

    private mutating func track(_ e: SyntheticEvent) {
        switch e {
        case .down(let b, let p, _, _): buttons.append((b, p))
        case .up(let b, _, _, _): if let i = buttons.lastIndex(where: { $0.0 == b }) { buttons.remove(at: i) }
        case .move(let p, let dragging?): if let i = buttons.lastIndex(where: { $0.0 == dragging }) { buttons[i].1 = p }
        case .key(let k, true, _): keys.append(k)
        case .key(let k, false, _): if let i = keys.lastIndex(of: k) { keys.remove(at: i) }
        case .modifier(let m, true, _): modifiers.append(m)
        case .modifier(let m, false, _): if let i = modifiers.lastIndex(of: m) { modifiers.remove(at: i) }
        default: break
        }
    }
}
