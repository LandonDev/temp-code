import ComputerProtocol
import Foundation

/// One look at the app during a wait. Every time is milliseconds since `t0`, the action's last input.
public struct WaitSample: Sendable, Equatable {
    public var at: Int
    /// the last AX notification; nil = none after t0
    public var axLastChange: Int?
    /// nil = not sampled this time
    public var signature: UInt64?
    /// nil = not sampled this time
    public var busy: Bool?
    /// the last counted pixel change; nil = none, or no live watch
    public var pixelLastChange: Int?

    public init(at: Int, axLastChange: Int? = nil, signature: UInt64? = nil, busy: Bool? = nil, pixelLastChange: Int? = nil) {
        self.at = at
        self.axLastChange = axLastChange
        self.signature = signature
        self.busy = busy
        self.pixelLastChange = pixelLastChange
    }
}

public struct WaitOutcome: Sendable, Equatable {
    public var report: WaitReport
    /// an AX notification or a signature change came after t0
    public var axChanged: Bool
    /// a pixel change that counted came after t0
    public var pixelChanged: Bool
    /// what moved the quiet clock, for the trace
    public var counts: Counts

    public struct Counts: Sendable, Equatable {
        public var ax = 0
        public var sig = 0
        public var px = 0

        public init(ax: Int = 0, sig: Int = 0, px: Int = 0) {
            self.ax = ax
            self.sig = sig
            self.px = px
        }
    }

    public init(report: WaitReport, axChanged: Bool, pixelChanged: Bool, counts: Counts = Counts()) {
        self.report = report
        self.axChanged = axChanged
        self.pixelChanged = pixelChanged
        self.counts = counts
    }

    /// The step's `effect`: changed when anything counted moved; else unknown on a thin tree; else none.
    public func effect(thin: Bool) -> StepEffect {
        if axChanged || pixelChanged { return .changed }
        return thin ? .unknown : .none
    }
}

public enum WaitDecision: Sendable, Equatable {
    /// take another sample no later than this
    case sampleAgain(atOrBefore: Int)
    case done(WaitOutcome)
}

/// The smart wait (docs/computer-protocol.md §7, shell A1 and A2), as a pure rule over samples.
///
/// 1. Nothing ends before `minMs`.
/// 2. The quiet clock starts at `minMs` and restarts at every change: an AX notification after t0, a
///    signature different from the last one sampled (the first compares with `signature0`), a busy
///    indicator coming or going, or a pixel change that counts.
/// 3. A pixel change counts only while the last read of the app was thin, or no AX notification and no
///    signature change has been seen since t0; it restarts the clock and never moves the cap.
/// 4. While a busy indicator shows, quiet does not end the wait. Once one has shown, the cap is
///    `busyMaxMs`: the wait ends there, or once the indicator is gone and the window is quiet.
/// 5. Else the wait ends `quiet` when the clock reaches `quietMs`, `max` at `maxMs`.
public struct WaitRule: Sendable {
    public let options: WaitOptions
    public let thin: Bool
    /// a live pixel watch feeds the samples
    public let pixels: Bool

    private var lastSignature: UInt64
    private var lastChangeAt = 0
    private var firstAxChangeAt: Int?
    private var lastAx: Int?
    private var lastPixel: Int?
    private var busyNow = false
    private var everBusy = false
    private var pixelChanged = false
    private var counts = WaitOutcome.Counts()
    private var done: WaitOutcome?

    public init(options: WaitOptions, signature0: UInt64, thin: Bool, pixels: Bool) {
        self.options = options
        self.lastSignature = signature0
        self.thin = thin
        self.pixels = pixels
    }

    public mutating func take(_ sample: WaitSample) -> WaitDecision {
        if let done { return .done(done) }
        let at = sample.at

        if let ax = sample.axLastChange, ax >= 0, ax != lastAx {
            lastAx = ax
            counts.ax += 1
            firstAxChangeAt = min(firstAxChangeAt ?? ax, ax)
            lastChangeAt = max(lastChangeAt, ax)
        }
        if let signature = sample.signature, signature != lastSignature {
            lastSignature = signature
            counts.sig += 1
            firstAxChangeAt = min(firstAxChangeAt ?? at, at)
            lastChangeAt = max(lastChangeAt, at)
        }
        if let busy = sample.busy, busy != busyNow {
            busyNow = busy
            lastChangeAt = max(lastChangeAt, at)
        }
        everBusy = everBusy || busyNow
        if pixels, let px = sample.pixelLastChange, px >= 0, px != lastPixel {
            lastPixel = px
            if thin || firstAxChangeAt.map({ px < $0 }) ?? true {
                pixelChanged = true
                counts.px += 1
                lastChangeAt = max(lastChangeAt, px)
            }
        }

        let quietFrom = max(options.minMs, lastChangeAt)
        let cap = everBusy ? options.busyMaxMs : options.maxMs
        if at >= options.minMs && !busyNow && at - quietFrom >= options.quietMs {
            return finish(at: at, reason: .quiet)
        }
        if at >= cap {
            return finish(at: at, reason: busyNow ? .busyMax : .max)
        }
        let quietAt = busyNow ? cap : quietFrom + options.quietMs
        return .sampleAgain(atOrBefore: min(max(quietAt, options.minMs), cap))
    }

    /// `$/cancel` during the wait.
    public func cancelled(at: Int) -> WaitOutcome {
        outcome(at: at, reason: .cancelled, settled: false)
    }

    /// The app quit during the wait: it ends quiet at once.
    public func appGone(at: Int) -> WaitOutcome {
        outcome(at: at, reason: .quiet, settled: true)
    }

    /// Actions that post no input skip the wait.
    public static func skipped() -> WaitOutcome {
        WaitOutcome(report: WaitReport(waitedMs: 0, settled: true, busy: false, reason: .skipped), axChanged: false, pixelChanged: false)
    }

    private mutating func finish(at: Int, reason: WaitReason) -> WaitDecision {
        let result = outcome(at: at, reason: reason, settled: reason == .quiet)
        done = result
        return .done(result)
    }

    private func outcome(at: Int, reason: WaitReason, settled: Bool) -> WaitOutcome {
        WaitOutcome(
            report: WaitReport(waitedMs: max(0, at), settled: settled, busy: busyNow, reason: reason),
            axChanged: firstAxChangeAt != nil,
            pixelChanged: pixelChanged,
            counts: counts
        )
    }
}
