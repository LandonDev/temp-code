import ComputerServiceKit
import Foundation

/// Every exit the service decides on, through one path (shell §8.2, the host's contract §8.4).
///
/// - 0: stdin EOF, `shutdown`, SIGTERM, SIGINT, SIGHUP, a failed write to stdout, the parent gone
/// - 70: the host left 64 MiB unread, or an internal fault the service caught
/// - 75: a restart to take a new Screen Recording grant
///
/// The first call wins and fixes the code. The wind-down runs, the outbox drains until 500 ms of the
/// 2 s deadline are left, and the process ends; a timer ends it at 2 s whatever is unfinished.
final class Lifecycle: @unchecked Sendable {
    /// The exit codes of the host's contract.
    enum Code {
        static let clean: Int32 = 0
        static let usage: Int32 = 64
        static let unsupported: Int32 = 69
        static let fault: Int32 = 70
        static let restart: Int32 = 75
    }

    private let env: ServiceEnvironment
    private let trace: Trace?
    private let lock = NSLock()
    private var code: Int32?
    private var sources: [any DispatchSourceProtocol] = []
    /// the service's steps; set once the service exists
    var windDown: @Sendable () async -> Void = {}
    /// the outbox to drain; set by the service
    var drain: @Sendable (ContinuousClock.Instant) async -> Void = { _ in }

    init(env: ServiceEnvironment, trace: Trace?) {
        self.env = env
        self.trace = trace
    }

    /// The code the first exit fixed, for the tests.
    var exitCode: Int32? { lock.withLock { code } }

    /// SIGTERM, SIGINT and SIGHUP through dispatch sources, and the parent watch every 5 s.
    func start() {
        var made: [any DispatchSourceProtocol] = []
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { [weak self] in self?.exit(Code.clean, why: "signal \(sig)") }
            source.resume()
            made.append(source)
        }
        let parent = DispatchSource.makeTimerSource(queue: .global())
        parent.schedule(deadline: .now() + env.timing.parentPoll.timeInterval, repeating: env.timing.parentPoll.timeInterval)
        parent.setEventHandler { [weak self] in
            guard let self, env.parentGone() else { return }
            exit(Code.clean, why: "the parent process is gone")
        }
        parent.resume()
        made.append(parent)
        lock.withLock { sources = made }
    }

    func exit(_ code: Int32, why: String) {
        let first: Bool = lock.withLock {
            guard self.code == nil else { return false }
            self.code = code
            return true
        }
        guard first else { return }
        trace?.note("exit \(code): \(why)")
        let deadline = ContinuousClock.now + env.timing.exitDeadline
        let env = env
        DispatchQueue.global().asyncAfter(deadline: .now() + env.timing.exitDeadline.timeInterval) { env.exit(code) }
        Task { [self] in
            await windDown()
            await drain(deadline - env.timing.exitDrainLeave)
            env.exit(code)
        }
    }
}

extension Duration {
    /// As a `TimeInterval`, for dispatch.
    var timeInterval: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}
