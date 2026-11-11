import ComputerProtocol

// The `front` tier's hold as values (docs/computer-protocol.md §25.2–§25.5): what the live layer
// asks before each move and what it does with the answer. Every time is monotonic milliseconds
// from the live layer's clock; nothing here reads a clock, the screen or AX.

/// The keyboard-quiet wait before a hold (§25.5): the person's last key down is `frontQuietMs`
/// old and nothing is held, waited for at most `frontQuietMaxMs`; past that the hold goes anyway
/// and the person guard covers the rest.
public enum QuietWait {
    public enum Decision: Equatable, Sendable {
        case go
        /// look again after this long
        case wait(ms: Int)
        /// the cap passed with the person still typing: go, the guard covers it
        case goAnyway
    }

    /// `lastKeyDownAt` nil: no key since the monitor started. `held`: a key or modifier is down.
    public static func decide(now: Int, startedAt: Int, lastKeyDownAt: Int?, held: Bool) -> Decision {
        let quietFor = lastKeyDownAt.map { now - $0 } ?? Int.max
        if !held, quietFor >= InputTiming.frontQuietMs { return .go }
        let left = InputTiming.frontQuietMaxMs - (now - startedAt)
        if left <= 0 { return .goAnyway }
        let untilQuiet = held ? InputTiming.frontPollMs : InputTiming.frontQuietMs - quietFor
        return .wait(ms: max(1, min(untilQuiet, left)))
    }
}

/// What the person did during a hold, as Input's watch sees it.
public enum PersonTouch: Equatable, Sendable {
    case escape, key, click, wheel, pointerMove
}

/// What the front app is while the restore polls.
public enum FrontNow: Equatable, Sendable {
    /// the app that was in front when the hold began
    case personApp
    /// still the agent's app
    case agentApp
    /// an app that is neither: the person chose it
    case thirdApp
    /// the app that was in front has quit
    case personAppGone
}

/// One hold: activation, the steps it carries, the settle, the restore. A batch's run of `front`
/// steps shares one hold while `takesAnotherStep` says so; the next step starts a new one.
public struct FrontHoldPlan: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case activating, active, restoring, done
    }

    public enum Activation: Equatable, Sendable {
        case activated
        case poll(afterMs: Int)
        /// `session_unavailable { reason: 'activation-refused' }`; the restore still runs
        case refused
    }

    public enum Post: Equatable, Sendable {
        /// post it; AX calls take this messaging timeout
        case post(axTimeoutMs: Int)
        /// the cap: post nothing more, release every key still down, restore, fail `timeout`
        case cap
    }

    public enum Settle: Equatable, Sendable {
        case hold(afterMs: Int)
        case release
    }

    public enum Restore: Equatable, Sendable {
        case poll(afterMs: Int)
        case done(FrontHoldRestore)
    }

    public enum Touched: Equatable, Sendable {
        /// the guard dropped it, or it moved nothing of the app's
        case ignore
        /// stop the step `interrupted` and restore at once
        case stop
    }

    public private(set) var phase: Phase = .activating
    public let startedAt: Int
    public private(set) var activatedAt: Int?
    public private(set) var lastInputAt: Int?
    public private(set) var restoreStartedAt: Int?
    public private(set) var restoreEndedAt: Int?
    public private(set) var restored: FrontHoldRestore?
    /// the step stopped for the person's input or the cap
    public private(set) var stopped: Bool = false
    /// passed through to `step.front` (§14.5's span)
    public var armedAt: Double?
    public var idleAtArmMs: Double?
    public var person: AppBrief?

    public init(startedAt: Int, person: AppBrief? = nil) {
        self.startedAt = startedAt
        self.person = person
    }

    /// The activation poll: every `frontPollMs` until the app is front and the target window its
    /// focused window, at most `frontActivateMaxMs`.
    public mutating func activation(now: Int, isFront: Bool) -> Activation {
        guard phase == .activating else { return .activated }
        if isFront {
            activatedAt = now
            phase = .active
            return .activated
        }
        if now - startedAt >= InputTiming.frontActivateMaxMs {
            phase = .restoring
            restoreStartedAt = now
            return .refused
        }
        return .poll(afterMs: InputTiming.frontPollMs)
    }

    /// Milliseconds left before the cap; 0 before activation and after it.
    public func timeLeft(now: Int) -> Int {
        guard phase == .active, let a = activatedAt else { return 0 }
        return max(0, InputTiming.frontHoldMaxMs - (now - a))
    }

    /// Checked before every posted event and AX call inside the hold.
    public mutating func beforePost(now: Int) -> Post {
        let left = timeLeft(now: now)
        guard left > 0 else {
            if phase == .active { stopped = true }
            return .cap
        }
        return .post(axTimeoutMs: min(Int(InputTiming.axTimeoutS * 1000), left))
    }

    /// The step's last input went in.
    public mutating func acted(now: Int) {
        lastInputAt = now
    }

    /// After the last input: hold until a change signal (and the app no longer `busy` with events
    /// it has not handled) or `frontSettleMs`, at most `frontSettleMaxMs`, never past the cap.
    public func settle(now: Int, changed: Bool, busy: Bool) -> Settle {
        guard phase == .active else { return .release }
        let since = now - (lastInputAt ?? activatedAt ?? now)
        if timeLeft(now: now) == 0 || since >= InputTiming.frontSettleMaxMs { return .release }
        if !busy, changed || since >= InputTiming.frontSettleMs { return .release }
        let next = busy ? InputTiming.frontSettleMaxMs - since : InputTiming.frontSettleMs - since
        return .hold(afterMs: max(1, min(InputTiming.frontPollMs, next)))
    }

    /// Whether the next `front` step of the batch joins this hold: it must have at least a
    /// settle's time left, else it starts a new hold after this one's restore.
    public func takesAnotherStep(now: Int) -> Bool {
        timeLeft(now: now) >= InputTiming.frontSettleMs
    }

    /// The person's input during the hold (§25.5): Escape always stops it; with the guard every
    /// other touch is dropped and the hold goes on; without it a key, click or wheel stops it.
    public mutating func touched(_ t: PersonTouch, guarded: Bool) -> Touched {
        guard phase == .active || phase == .activating else { return .ignore }
        switch t {
        case .pointerMove: return .ignore
        case .escape: break
        case .key, .click, .wheel: if guarded { return .ignore }
        }
        stopped = true
        return .stop
    }

    /// The restore begins: once per hold.
    public mutating func beginRestore(now: Int) {
        guard phase != .restoring, phase != .done else { return }
        phase = .restoring
        restoreStartedAt = now
    }

    /// The restore poll: the person's app back in front, else their choice of a third app kept,
    /// else a quit app; past `frontRestoreMaxMs` it failed.
    public mutating func restore(now: Int, front: FrontNow) -> Restore {
        guard phase == .restoring, let r0 = restoreStartedAt else { return .done(restored ?? .failed) }
        let outcome: FrontHoldRestore? = switch front {
        case .personApp: .restored
        case .thirdApp: .personMoved
        case .personAppGone: .appGone
        case .agentApp: now - r0 >= InputTiming.frontRestoreMaxMs ? .failed : nil
        }
        guard let outcome else { return .poll(afterMs: InputTiming.frontPollMs) }
        restored = outcome
        restoreEndedAt = now
        phase = .done
        return .done(outcome)
    }

    /// `step.front` once the restore is done.
    public var report: FrontHold? {
        guard phase == .done, let restored, let r0 = restoreStartedAt, let r1 = restoreEndedAt else { return nil }
        let activateMs = (activatedAt ?? r0) - startedAt
        return FrontHold(
            heldMs: activatedAt.map { max(0, r0 - $0) } ?? 0,
            activateMs: max(0, activateMs),
            restoreMs: max(0, r1 - r0),
            restored: restored,
            person: person,
            armedAt: armedAt,
            idleAtArmMs: idleAtArmMs,
            lastInputAt: lastInputAt.map(Double.init)
        )
    }
}

/// The failures a hold ends a step with.
public enum FrontFailure {
    /// the cap cut the step: never replayed
    public static func timeout(app: String) -> ComputerError {
        ComputerError(kind: .timeout, message: "\(app) was in front for \(InputTiming.frontHoldMaxMs / 1000) s and the step may be part done; read the window before acting again.")
    }

    /// the app never came forward
    public static func activationRefused(app: String) -> ComputerError {
        ComputerError(kind: .sessionUnavailable, message: "\(app) did not come forward.", reason: .activationRefused)
    }
}

/// The runs of consecutive `front` steps in a batch, by index; each run starts at least one hold.
public func frontRuns(_ tiers: [Tier?]) -> [Range<Int>] {
    var runs: [Range<Int>] = []
    var start: Int?
    for (i, t) in tiers.enumerated() {
        if t == .front {
            if start == nil { start = i }
        } else if let s = start {
            runs.append(s ..< i)
            start = nil
        }
    }
    if let s = start { runs.append(s ..< tiers.count) }
    return runs
}
