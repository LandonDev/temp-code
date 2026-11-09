import ComputerProtocol

/// A value the probe will put back: readable now and settable through AX, or the class is not tried.
public struct RestoreFact: Equatable, Sendable {
    public var name: String
    public var readable: Bool
    public var settable: Bool

    public init(_ name: String, readable: Bool, settable: Bool) {
        self.name = name
        self.readable = readable
        self.settable = settable
    }
}

/// The probe's verdicts, pure.
public enum ProbeJudge {
    /// A scroll bar's value moved.
    public static func outcome(before: Double, after: Double?) -> ProbeOutcome {
        guard let after else { return .ignored }
        return abs(after - before) > 1e-6 ? .honoured : .ignored
    }

    /// A caret moved (the key class).
    public static func outcome(before: TextRange, after: TextRange?) -> ProbeOutcome {
        guard let after else { return .ignored }
        return after != before ? .honoured : .ignored
    }

    /// The caret landed where the click or drag aimed.
    public static func outcome(after: TextRange?, expected: TextRange) -> ProbeOutcome {
        after == expected ? .honoured : .ignored
    }

    /// The probe acts only where it can put everything back.
    public static func canRestore(_ facts: [RestoreFact]) -> Bool {
        facts.allSatisfy { $0.readable && $0.settable }
    }

    /// The first refused fact, for the `untested` reason.
    public static func refusal(_ facts: [RestoreFact]) -> String? {
        facts.first { !($0.readable && $0.settable) }.map { "its \($0.name) can't be put back" }
    }
}

/// A scroll bar the scroll class can move and set back.
public struct ProbeScroll<Element> {
    public var bar: Element
    public var value: Double
    /// the scroll area's centre, where the wheel click goes
    public var point: ScreenPoint
    public var facts: [RestoreFact]

    public init(bar: Element, value: Double, point: ScreenPoint, facts: [RestoreFact]) {
        self.bar = bar
        self.value = value
        self.point = point
        self.facts = facts
    }
}

/// A text element whose caret the key or click class moves and sets back.
public struct ProbeText<Element> {
    public var element: Element
    public var range: TextRange
    public var length: Int
    /// the scroll bar of the scroll area it sits in, with its value, when it sits in one
    public var bar: Element?
    public var barValue: Double?
    /// the click class: where to click and the caret it should land; the drag class: where to drag to
    public var clickAt: ScreenPoint?
    public var clickExpect: TextRange?
    public var dragTo: ScreenPoint?
    public var dragExpect: TextRange?
    /// the element that had focus, to put back after a click
    public var focused: Element?
    public var facts: [RestoreFact]

    public init(element: Element, range: TextRange, length: Int, bar: Element? = nil, barValue: Double? = nil, clickAt: ScreenPoint? = nil, clickExpect: TextRange? = nil, dragTo: ScreenPoint? = nil, dragExpect: TextRange? = nil, focused: Element? = nil, facts: [RestoreFact]) {
        self.element = element
        self.range = range
        self.length = length
        self.bar = bar
        self.barValue = barValue
        self.clickAt = clickAt
        self.clickExpect = clickExpect
        self.dragTo = dragTo
        self.dragExpect = dragExpect
        self.focused = focused
        self.facts = facts
    }
}

/// What the probe reads, writes and posts; LiveProbeAccess does it over AX and the event sink.
/// Every read is bounded by the element's messaging timeout, which the live access sets.
public protocol ProbeAccess {
    associatedtype Element
    var pid: Int32 { get }
    var bundleId: String? { get }
    func keyWindow() -> KeyWindowState
    /// a scroll area in the target window whose vertical bar's value can be set back
    func scrollCandidate() -> ProbeScroll<Element>?
    /// the app's focused element in the target window: text, a settable range, its bar settable
    func focusedText() -> ProbeText<Element>?
    /// a text element in the window with two characters or more and AXBoundsForRange, for click and drag
    func clickCandidate() -> ProbeText<Element>?
    func number(_ e: Element) -> Double?
    func range(_ e: Element) -> TextRange?
    func setNumber(_ e: Element, _ value: Double) -> Bool
    func setRange(_ e: Element, _ range: TextRange) -> Bool
    func setFocused(_ e: Element) -> Bool
    /// posts a plan to the app's pid
    func post(_ plan: [SyntheticEvent])
}

/// The probe of §6, generic over its access: each class acts only where its state can be put
/// back, judges through AX, and restores on every exit; no class starts past 1.5 s, and
/// restoring runs to its end.
public struct ProbeRun<Access: ProbeAccess> {
    public let access: Access
    public let clock: InputClock

    public init(access: Access, clock: InputClock) {
        self.access = access
        self.clock = clock
    }

    public func run(classes: [ActionClass]) -> ProbeReport {
        let start = clock.seconds()
        let keyWindow = access.keyWindow()
        var results: [ProbeReport.Result] = []
        for c in classes {
            let t0 = clock.seconds()
            var r: (ProbeOutcome, String?, Bool)
            if (t0 - start) * 1000 >= Double(InputTiming.probeLastStartMs) {
                r = (.untested, "the probe ran out of time", true)
            } else {
                let deadline = start + Double(InputTiming.probeCapMs) / 1000
                switch c {
                case .scroll: r = scroll(deadline: deadline)
                case .key: r = keyWindow == .target ? key(deadline: deadline) : (.untested, "the window is not key", true)
                case .click: r = click(deadline: deadline, drag: false)
                case .drag: r = click(deadline: deadline, drag: true)
                default: r = (.untested, "not probed", true)
                }
            }
            results.append(ProbeReport.Result(class: c, outcome: r.0, reason: r.1, restored: r.2, ms: Int(((clock.seconds() - t0) * 1000).rounded())))
        }
        return ProbeReport(pid: Int(access.pid), bundleId: access.bundleId, keyWindow: keyWindow, results: results)
    }

    /// Polls `read` every 10 ms until `moved` says yes, for at most `probeCheckMs` and never past the deadline.
    private func waitFor<T>(_ read: () -> T?, deadline: Double, moved: (T?) -> Bool) -> T? {
        let until = min(clock.seconds() + Double(InputTiming.probeCheckMs) / 1000, deadline)
        var last = read()
        while !moved(last), clock.seconds() < until {
            clock.sleep(ms: 10)
            last = read()
        }
        return last
    }

    private func scroll(deadline: Double) -> (ProbeOutcome, String?, Bool) {
        guard let c = access.scrollCandidate() else { return (.untested, "nothing to scroll", true) }
        if let why = ProbeJudge.refusal(c.facts) { return (.untested, why, true) }
        access.post(EventPlans.scroll(c.value < 1 ? .down : .up, clicks: 1, at: c.point, modifiers: []))
        let after = waitFor({ access.number(c.bar) }, deadline: deadline) { ($0 ?? c.value) != c.value }
        // restoring runs to its end, past the deadline if it must
        let restored = access.setNumber(c.bar, c.value) && readsBack { access.number(c.bar).map { abs($0 - c.value) < 1e-6 } == true }
        return (ProbeJudge.outcome(before: c.value, after: after), nil, restored)
    }

    /// Puts a text candidate's caret and scroll back; true when both read back as before.
    /// Reads until `matches` holds, for at most the call timeout: a web view answers an AX write
    /// asynchronously, so the first read may still show the moved value.
    private func readsBack(_ matches: () -> Bool) -> Bool {
        let until = clock.seconds() + InputTiming.probeCallTimeoutS
        while !matches() {
            if clock.seconds() >= until { return false }
            clock.sleep(ms: 10)
        }
        return true
    }

    private func restoreText(_ c: ProbeText<Access.Element>) -> Bool {
        var ok = access.setRange(c.element, c.range) && readsBack { access.range(c.element) == c.range }
        if let bar = c.bar, let v = c.barValue {
            ok = access.setNumber(bar, v) && ok
        }
        return ok
    }

    private func key(deadline: Double) -> (ProbeOutcome, String?, Bool) {
        guard let c = access.focusedText() else { return (.untested, "no text field has focus", true) }
        if let why = ProbeJudge.refusal(c.facts) { return (.untested, why, true) }
        let atEnd = c.range.end >= c.length
        let code = atEnd ? KeyCodes.code("Left")! : KeyCodes.code("Right")!
        access.post([.key(code, down: true, flags: []), .key(code, down: false, flags: [])])
        let after = waitFor({ access.range(c.element) }, deadline: deadline) { $0 != nil && $0 != c.range }
        let restored = restoreText(c)
        return (ProbeJudge.outcome(before: c.range, after: after), nil, restored)
    }

    private func click(deadline: Double, drag: Bool) -> (ProbeOutcome, String?, Bool) {
        guard let c = access.clickCandidate() else { return (.untested, "no text element to click", true) }
        if let why = ProbeJudge.refusal(c.facts) { return (.untested, why, true) }
        guard let at = c.clickAt, let expect = drag ? c.dragExpect : c.clickExpect, !drag || c.dragTo != nil else {
            return (.untested, "no character to aim at", true)
        }
        access.post(drag ? EventPlans.drag(from: at, to: c.dragTo!, modifiers: []) : EventPlans.click(.left, at: at, count: 1, modifiers: [], holdMs: nil, moveFirst: false))
        let after = waitFor({ access.range(c.element) }, deadline: deadline) { $0 == expect }
        var restored = restoreText(c)
        if let f = c.focused { restored = access.setFocused(f) && restored }
        return (ProbeJudge.outcome(after: after, expected: expect), nil, restored)
    }
}
