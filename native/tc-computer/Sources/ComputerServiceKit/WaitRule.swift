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
    /// the general pasteboard's last change that was not the service's own (§24.10); nil = none after t0
    public var pasteboardLastChange: Int?

    public init(at: Int, axLastChange: Int? = nil, signature: UInt64? = nil, busy: Bool? = nil, pixelLastChange: Int? = nil, pasteboardLastChange: Int? = nil) {
        self.at = at
        self.axLastChange = axLastChange
        self.signature = signature
        self.busy = busy
        self.pixelLastChange = pixelLastChange
        self.pasteboardLastChange = pasteboardLastChange
    }
}

public struct WaitOutcome: Sendable, Equatable {
    public var report: WaitReport
    /// an AX notification or a signature change came after t0
    public var axChanged: Bool
    /// a pixel change that counted came after t0
    public var pixelChanged: Bool
    /// a copy or cut step saw the pasteboard change (§24.10)
    public var pasteboardChanged: Bool
    /// what moved the quiet clock, for the trace
    public var counts: Counts
    /// the app quit during the wait (§22.6)
    public var appLeft: Bool

    public struct Counts: Sendable, Equatable {
        public var ax = 0
        public var sig = 0
        public var px = 0
        public var pb = 0

        public init(ax: Int = 0, sig: Int = 0, px: Int = 0, pb: Int = 0) {
            self.ax = ax
            self.sig = sig
            self.px = px
            self.pb = pb
        }
    }

    public init(report: WaitReport, axChanged: Bool, pixelChanged: Bool, pasteboardChanged: Bool = false, counts: Counts = Counts(), appLeft: Bool = false) {
        self.report = report
        self.axChanged = axChanged
        self.pixelChanged = pixelChanged
        self.pasteboardChanged = pasteboardChanged
        self.counts = counts
        self.appLeft = appLeft
    }

    /// The step's `effect`: changed when anything counted moved (a copy or cut's pasteboard among them,
    /// §24.10), the app quit, the target window closed (§22.6), or the call's record saw a menu open or a window
    /// or sheet made during the step (`opened`, §27.4); else unknown on a thin tree; else none.
    public func effect(thin: Bool, windowGone: Bool = false, opened: Bool = false) -> StepEffect {
        if axChanged || pixelChanged || pasteboardChanged || appLeft || windowGone || opened { return .changed }
        return thin ? .unknown : .none
    }
}

public enum WaitDecision: Sendable, Equatable {
    /// take another sample no later than this
    case sampleAgain(atOrBefore: Int)
    case done(WaitOutcome)
}

/// The buckets a wait counts the gaps between adjacent changes into (§27.2, protocol.ts `WAIT_GAP_EDGES_MS`): each edge
/// is a bucket's upper bound, inclusive, and one bucket above the last counts the rest.
public enum WaitGaps {
    public static let edgesMs = ComputerDefaults.Wait.gapEdgesMs

    public static func bucket(_ gapMs: Int) -> Int {
        edgesMs.firstIndex { gapMs <= $0 } ?? edgesMs.count
    }
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
/// 6. On a copy or cut step (`pasteboard`), a pasteboard change that is not the service's own counts
///    and restarts the clock (§24.10); no other step reads the pasteboard, so the person copying
///    meanwhile never makes another step read `changed`.
///
/// It also records when the window changed (§27.2): the first sample that counted a change (an AX
/// notification, a signature, pixels or the pasteboard; a busy indicator is not one), and the gaps between
/// adjacent changes, one change per counting sample at its latest stamp, counted into `WaitGaps`.
public struct WaitRule: Sendable {
    public let options: WaitOptions
    public let thin: Bool
    /// a live pixel watch feeds the samples
    public let pixels: Bool
    /// the step is a copy or cut: the pasteboard counts (`readsPasteboard`)
    public let pasteboard: Bool

    private var lastSignature: UInt64
    private var lastChangeAt = 0
    private var firstAxChangeAt: Int?
    private var lastAx: Int?
    private var lastPixel: Int?
    private var busyNow = false
    private var everBusy = false
    private var pixelChanged = false
    private var lastPasteboard: Int?
    private var pasteboardChanged = false
    private var counts = WaitOutcome.Counts()
    private var firstChangeSample: Int?
    private var samples = 0
    private var lastChangePoint: Int?
    private var gapCounts = [Int](repeating: 0, count: WaitGaps.edgesMs.count + 1)
    private var done: WaitOutcome?

    public init(options: WaitOptions, signature0: UInt64, thin: Bool, pixels: Bool, pasteboard: Bool = false) {
        self.options = options
        self.lastSignature = signature0
        self.thin = thin
        self.pixels = pixels
        self.pasteboard = pasteboard
    }

    /// The steps whose wait reads the pasteboard (§24.10): `key super+c` and `key super+x`, posted or
    /// through the menu route, which presses the item the same key would.
    public static func readsPasteboard(_ action: ComputerAction) -> Bool {
        guard action.action == .key, let text = action.text?.lowercased() else { return false }
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let key = parts.last, key == "c" || key == "x", parts.count == 2 else { return false }
        return ["super", "cmd", "command"].contains(parts[0])
    }

    public mutating func take(_ sample: WaitSample) -> WaitDecision {
        if let done { return .done(done) }
        let at = sample.at
        let firstLook = samples == 0
        samples += 1
        // this sample's change for §27.2, at the latest stamp it counted (and the earliest, for a first look)
        var changeAt: Int?
        var earliest: Int?
        func counted(_ t: Int) {
            changeAt = max(changeAt ?? t, t)
            earliest = min(earliest ?? t, t)
        }

        if let ax = sample.axLastChange, ax >= 0, ax != lastAx {
            lastAx = ax
            counts.ax += 1
            firstAxChangeAt = min(firstAxChangeAt ?? ax, ax)
            lastChangeAt = max(lastChangeAt, ax)
            counted(ax)
        }
        if let signature = sample.signature, signature != lastSignature {
            lastSignature = signature
            counts.sig += 1
            firstAxChangeAt = min(firstAxChangeAt ?? at, at)
            lastChangeAt = max(lastChangeAt, at)
            counted(at)
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
                counted(px)
            }
        }

        if pasteboard, let pb = sample.pasteboardLastChange, pb >= 0, pb != lastPasteboard {
            lastPasteboard = pb
            pasteboardChanged = true
            counts.pb += 1
            lastChangeAt = max(lastChangeAt, pb)
            counted(pb)
        }
        if let changeAt {
            // a change the wait's first look already finds came before it began (a `front` step's wait starts after
            // the hold's settle and restore, §26.2): it counts at its own stamp, not at the late first sample
            if firstChangeSample == nil { firstChangeSample = firstLook ? (earliest ?? at) : at }
            if let last = lastChangePoint { gapCounts[WaitGaps.bucket(max(0, changeAt - last))] += 1 }
            lastChangePoint = max(lastChangePoint ?? changeAt, changeAt)
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

    /// The app quit during the wait: it ends quiet at once, and the step changed something (§22.6).
    public func appGone(at: Int) -> WaitOutcome {
        var gone = outcome(at: at, reason: .quiet, settled: true)
        gone.appLeft = true
        return gone
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
            // the change times only when something counted (§27.2)
            report: WaitReport(waitedMs: max(0, at), settled: settled, busy: busyNow, reason: reason,
                               firstChangeMs: firstChangeSample.map { max(0, $0) }, gapCounts: firstChangeSample == nil ? nil : gapCounts),
            axChanged: firstAxChangeAt != nil,
            pixelChanged: pixelChanged,
            pasteboardChanged: pasteboardChanged,
            counts: counts
        )
    }
}

/// §27.3: the wait after each step, by the route it went in at. Between steps `axStep` after one that went in at `ax`,
/// else `step`; after a segment's last step `axAction` when every step that sent input went in at `ax`, else `action`.
public struct WaitRows: Sendable, Equatable {
    public var step: WaitOptions
    public var action: WaitOptions
    public var axStep: WaitOptions
    public var axAction: WaitOptions

    /// The call's rows, each defaulted as `COMPUTER_WAIT` ships it.
    public init(stepWait: WaitOptions?, wait: WaitOptions?, axStepWait: WaitOptions?, axWait: WaitOptions?) {
        step = stepWait ?? ComputerDefaults.Wait.step
        action = wait ?? ComputerDefaults.Wait.action
        axStep = axStepWait ?? ComputerDefaults.Wait.axStep
        axAction = axWait ?? ComputerDefaults.Wait.axAction
    }

    /// After a step that is not the last: its own tier decides.
    public func between(tier: Tier?) -> WaitOptions { tier == .ax ? axStep : step }

    /// After the last step that ran: the tiers of every step that sent input (nil for one that sent none).
    public func last(tiers: [Tier?]) -> WaitOptions {
        let sent = tiers.compactMap { $0 }
        return !sent.isEmpty && sent.allSatisfy { $0 == .ax } ? axAction : action
    }
}

/// §27.5: the window a step opened, which the call then follows: the app's focused window after the step's wait, when
/// it was not among the windows before the step. A sheet is in its window's tree and opens nothing here.
public enum WindowFollow {
    public static func opened(before: [Int], focusedAfter: Int?) -> Int? {
        guard let id = focusedAfter, !before.contains(id) else { return nil }
        return id
    }

    /// The window the call goes back to when the one it acts in is gone after a step (a followed window closed): the
    /// call's original target when it is live, else the app's focused window; nil while the window is live, or when
    /// the app's focused window is not another live one.
    public static func back(current: Int, original: Int, live: [Int], focusedAfter: Int?) -> Int? {
        guard !live.contains(current), let focused = focusedAfter, focused != current, live.contains(focused) else { return nil }
        return live.contains(original) ? original : focused
    }
}
