import Foundation

/// Pause, resume and stop ordering for one SCStream (docs/computer-protocol.md §6). Pure; driven
/// on the stream's serial queue.
///
/// `stopCapture` and `startCapture` complete asynchronously, so one transition waits for the
/// last to complete before the next starts: an ack while pausing resumes once the pause is done,
/// a starvation while resuming pauses once the resume is done. `stop()` wins over everything, and
/// a pause or resume completing after it changes nothing. `finish` is returned exactly once.
public struct StreamLifecycle: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case running, pausing, paused, resuming, stopping, stopped
    }

    /// What the stream must do next.
    public enum Command: Equatable, Sendable {
        case stopCapture
        case startCapture
        /// The stream has ended: resolve `ended()`.
        case finish
    }

    public private(set) var state: State = .running

    /// Stopping or stopped: no frame goes out any more, and an ack changes nothing.
    public var isEnding: Bool { state == .stopping || state == .stopped }
    private var resumeWanted = false
    private var pauseWanted = false
    /// The capture call in flight while stopping, if any.
    private var stoppingAfterStart = false

    public init() {}

    /// The stream starved: stop capturing until an ack.
    public mutating func pause() -> Command? {
        switch state {
        case .running:
            state = .pausing
            return .stopCapture
        case .resuming:
            pauseWanted = true
            return nil
        case .pausing:
            resumeWanted = false
            return nil
        case .paused, .stopping, .stopped:
            return nil
        }
    }

    /// An ack came while starved: capture again.
    public mutating func resume() -> Command? {
        switch state {
        case .paused:
            state = .resuming
            return .startCapture
        case .pausing:
            resumeWanted = true
            return nil
        case .resuming:
            pauseWanted = false
            return nil
        case .running, .stopping, .stopped:
            return nil
        }
    }

    /// `stop()` on the handle: end the stream from any state.
    public mutating func stop() -> Command? {
        switch state {
        case .running:
            state = .stopping
            return .stopCapture
        case .paused:
            state = .stopped
            return .finish
        case .pausing:
            state = .stopping
            return nil
        case .resuming:
            state = .stopping
            stoppingAfterStart = true
            return nil
        case .stopping, .stopped:
            return nil
        }
    }

    /// The last `stopCapture` or `startCapture` completed (with or without an error).
    public mutating func completed() -> Command? {
        switch state {
        case .pausing:
            state = .paused
            if resumeWanted {
                resumeWanted = false
                state = .resuming
                return .startCapture
            }
            return nil
        case .resuming:
            state = .running
            if pauseWanted {
                pauseWanted = false
                state = .pausing
                return .stopCapture
            }
            return nil
        case .stopping:
            if stoppingAfterStart {
                stoppingAfterStart = false
                return .stopCapture
            }
            state = .stopped
            return .finish
        case .running, .paused, .stopped:
            return nil
        }
    }

    /// ScreenCaptureKit ended the stream itself (the window closed, the grant went, the person
    /// stopped it from the menu bar): nothing is capturing any more.
    public mutating func endedBySystem() -> Command? {
        guard state != .stopped else { return nil }
        state = .stopped
        return .finish
    }
}

/// How long a watch stream lives after its last use. Pure, with an injected clock.
public struct Linger: Equatable, Sendable {
    private let afterMs: Double
    private var lastUseMs: Double

    public init(afterMs: Double = CaptureTuning.watchLinger.milliseconds, startMs: Double) {
        self.afterMs = afterMs
        self.lastUseMs = startMs
    }

    /// A `watch` call or a read of the signal.
    public mutating func touch(atMs: Double) {
        lastUseMs = max(lastUseMs, atMs)
    }

    public func expired(atMs: Double) -> Bool {
        atMs - lastUseMs >= afterMs
    }

    /// When it expires, if nothing touches it again.
    public var expiresAtMs: Double { lastUseMs + afterMs }
}

/// `waitLive`'s bookkeeping for one watch stream. Pure: the stream stores the waiters (its
/// continuations) here and resumes the ones each call hands back.
public struct BaselineGate<Waiter> {
    public enum State: Equatable, Sendable { case starting, live, stopped }

    public enum Wait {
        /// Answer the waiter now.
        case now(Bool)
        /// Stored under this id: answered by `baseline`, `stop` or `timeout`.
        case pending(Int)
    }

    public private(set) var state: State = .starting
    private var waiters: [Int: Waiter] = [:]
    private var nextID = 0

    public init() {}

    public mutating func wait(_ waiter: Waiter) -> Wait {
        switch state {
        case .live: return .now(true)
        case .stopped: return .now(false)
        case .starting:
            nextID += 1
            waiters[nextID] = waiter
            return .pending(nextID)
        }
    }

    /// The baseline frame landed: the waiters to answer true.
    public mutating func baseline() -> [Waiter] {
        guard state == .starting else { return [] }
        state = .live
        return drain()
    }

    /// The watch stopped: the waiters to answer false.
    public mutating func stop() -> [Waiter] {
        state = .stopped
        return drain()
    }

    /// The waiter's timeout passed: it, to answer false, if nothing answered it yet.
    public mutating func timeout(_ id: Int) -> Waiter? {
        waiters.removeValue(forKey: id)
    }

    private mutating func drain() -> [Waiter] {
        let all = waiters.sorted { $0.key < $1.key }.map(\.value)
        waiters.removeAll()
        return all
    }
}

extension BaselineGate: Sendable where Waiter: Sendable {}
