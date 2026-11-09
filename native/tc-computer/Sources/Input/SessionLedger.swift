import ComputerProtocol

/// What the session tier took from the person since the last restore: the app in front and
/// the pointer before the first session step, where the last one left them, and whatever
/// says the person came back in between. One per service process: the Mac has one pointer.
public struct SessionRecord: Equatable, Sendable {
    public var firstFrontmost: AppBrief?
    public var firstPointer: ScreenPoint
    public var lastFrontmost: AppBrief?
    public var lastPointer: ScreenPoint
    /// monotonic seconds the last step ended
    public var lastStepEnded: Double?
    /// the person tripped the watch during a session step or while session input was held
    public var personTookOver = false
    /// the person used the keyboard or mouse between two session steps
    public var personSeen = false
    /// activations of an app Input did not cause, while the record existed and no step ran
    public var foreignActivations = 0
}

/// What a restore will do, half by half.
public struct RestorePlan: Equatable, Sendable {
    public var frontmost: RestoreOutcome
    public var pointer: RestoreOutcome
    /// the app to bring back in front, when `frontmost` is restored
    public var activate: AppBrief?
    /// where to put the pointer back, when `pointer` is restored
    public var movePointer: ScreenPoint?
}

/// The session tier's ledger, pure: the engine feeds it what it reads and asks it what to put back.
public struct SessionLedger: Sendable {
    public private(set) var record: SessionRecord?
    /// a session step is running: activations then are Input's own
    public private(set) var stepRunning = false
    /// a person's input this many seconds or less after the step's own end counts as the step's
    static let ownInputSlackS = 0.05

    public init() {}

    /// A session step starts changing the Mac. The first since the last restore makes the record;
    /// a later one notes whether the person used the Mac since the step before it ended.
    public mutating func stepBegan(frontmost: AppBrief?, pointer: ScreenPoint, now: Double, secondsSinceInput: Double) {
        stepRunning = true
        if var r = record {
            if Self.inputSince(r.lastStepEnded, now: now, secondsSinceInput: secondsSinceInput) { r.personSeen = true }
            record = r
        } else {
            record = SessionRecord(firstFrontmost: frontmost, firstPointer: pointer, lastFrontmost: frontmost, lastPointer: pointer)
        }
    }

    /// Every exit of a session step, failed or not: where it left the Mac.
    public mutating func stepEnded(frontmost: AppBrief?, pointer: ScreenPoint, now: Double, interrupted: Bool) {
        stepRunning = false
        guard var r = record else { return }
        r.lastFrontmost = frontmost
        r.lastPointer = pointer
        r.lastStepEnded = now
        if interrupted { r.personTookOver = true }
        record = r
    }

    /// The person tripped the watch while session input was held between calls.
    public mutating func personTripped() {
        record?.personTookOver = true
    }

    /// An app came forward; Input's own come only while a step runs.
    public mutating func activation() {
        guard record != nil, !stepRunning else { return }
        record?.foreignActivations += 1
    }

    public mutating func clear() {
        record = nil
    }

    /// What a step changed, for its result.
    public static func change(before: (AppBrief?, ScreenPoint), after: (AppBrief?, ScreenPoint), restorable: Bool) -> SessionChange {
        SessionChange(
            frontmost: SessionChange.Frontmost(before: before.0, after: after.0),
            pointer: SessionChange.Pointer(before: before.1.pair, after: after.1.pair),
            restorable: restorable
        )
    }

    static func inputSince(_ ended: Double?, now: Double, secondsSinceInput: Double) -> Bool {
        guard let ended else { return false }
        return secondsSinceInput < (now - ended) - ownInputSlackS
    }

    /// What a restore would put back now. Both halves give way to the person when they
    /// tripped the watch or used the Mac since the last step; the app half when the app in
    /// front is not the one the step left there or another app came forward meanwhile; the
    /// pointer half when the pointer is more than 2 pt from where the step left it.
    public func plan(now: Double, secondsSinceInput: Double, frontmost: AppBrief?, pointer: ScreenPoint, isRunning: (Int) -> Bool) -> RestorePlan {
        guard let r = record else { return RestorePlan(frontmost: .nothing, pointer: .nothing) }
        let personBack = r.personTookOver || r.personSeen || Self.inputSince(r.lastStepEnded, now: now, secondsSinceInput: secondsSinceInput)
        var plan = RestorePlan(frontmost: .nothing, pointer: .nothing)

        if let first = r.firstFrontmost, first.pid != r.lastFrontmost?.pid {
            if personBack || frontmost?.pid != r.lastFrontmost?.pid || r.foreignActivations > 0 {
                plan.frontmost = .personMoved
            } else if !isRunning(first.pid) {
                plan.frontmost = .appGone
            } else {
                plan.frontmost = .restored
                plan.activate = first
            }
        }
        if r.firstPointer.distance(to: r.lastPointer) > InputTiming.pointerSlackPt {
            if personBack || pointer.distance(to: r.lastPointer) > InputTiming.pointerSlackPt {
                plan.pointer = .personMoved
            } else {
                plan.pointer = .restored
                plan.movePointer = r.firstPointer
            }
        }
        return plan
    }
}
