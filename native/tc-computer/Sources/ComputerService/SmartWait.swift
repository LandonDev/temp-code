import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// The reader's change monitor, read from the request task (its `lastChange` is in memory).
struct ChangeBox: @unchecked Sendable {
    let signal: any ChangeSignal
}

/// What one wait watches.
struct WaitWatch: Sendable {
    let worker: Worker
    let pid: pid_t
    let change: ChangeBox?
    /// capture's watch on the window; nil without Screen Recording or when it never went live
    let pixel: (any PixelChangeSignal)?
}

/// The smart wait's runner (shell §5.3): it feeds `WaitRule` until the rule is done. Every 25 ms it reads
/// the AX change stamp and the pixel watch (both in memory), every 100 ms the signature and every 200 ms
/// the busy indicator on the worker, which stays free between samples.
enum SmartWait {
    static let signatureEveryMs = 100
    static let busyEveryMs = 200

    static func run(_ options: WaitOptions, from t0: UInt64, signature0: UInt64, thin: Bool, watch: WaitWatch,
                    cancel: CancelFlag, isRunning: @Sendable (pid_t) -> Bool, tick: Duration, trace: Trace?) async -> WaitOutcome {
        var rule = WaitRule(options: options, signature0: signature0, thin: thin, pixels: watch.pixel?.live ?? false)
        var lastSignature = Int.min / 2
        var lastBusy = Int.min / 2
        while true {
            let at = MachTime.ms(from: t0, to: MachTime.now())
            if cancel.isSet || Task.isCancelled { return finish(rule.cancelled(at: at), trace) }
            if !isRunning(watch.pid) { return finish(rule.appGone(at: at), trace) }
            var sample = WaitSample(at: at)
            if let stamp = watch.change?.signal.lastChange, stamp > t0 { sample.axLastChange = MachTime.ms(from: t0, to: stamp) }
            if let pixel = watch.pixel, pixel.live, pixel.lastChange > t0 { sample.pixelLastChange = MachTime.ms(from: t0, to: pixel.lastChange) }
            if at - lastSignature >= signatureEveryMs, let change = watch.change {
                lastSignature = at
                sample.signature = try? await watch.worker.run { _ in change.signal.signature() }
            }
            if at - lastBusy >= busyEveryMs, let change = watch.change {
                lastBusy = at
                sample.busy = try? await watch.worker.run { _ in change.signal.busyIndicatorShowing() }
            }
            // a worker read can take a while (a slow app answers within its 2 s timeout): judge the sample
            // at the time it ended, and let a cancel that came meanwhile win
            sample.at = MachTime.ms(from: t0, to: MachTime.now())
            if cancel.isSet || Task.isCancelled { return finish(rule.cancelled(at: sample.at), trace) }
            if case .done(let outcome) = rule.take(sample) { return finish(outcome, trace) }
            try? await Task.sleep(for: tick)
        }
    }

    private static func finish(_ outcome: WaitOutcome, _ trace: Trace?) -> WaitOutcome {
        trace?.wait(outcome.report, ax: outcome.counts.ax, sig: outcome.counts.sig, px: outcome.counts.px)
        return outcome
    }
}
