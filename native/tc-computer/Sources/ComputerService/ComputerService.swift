import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// The service: one per app instance, every thread a session inside it (docs/computer-protocol.md §1).
/// It routes the host's requests to the AX reader, Input and Capture, runs the smart wait, owns the
/// Mac-wide locks, reads TCC and decides when the process ends.
public final class ComputerService: @unchecked Sendable {
    let modules: Modules
    let env: ServiceEnvironment
    let build: BuildInfo
    let trace: Trace
    let outbox: Outbox
    let router: Router
    let lifecycle: Lifecycle
    let book = SessionBook()
    let workers = Workers()
    let slots = AppSlots()
    let inventory: Inventory
    let locks: MacLocks
    let clipboardLock: ClipboardMacLock
    let sessionLock: SessionMacLock
    let held: HeldInput
    let readers: any ReaderPool
    let capture: any CaptureSource
    let input: any InputPerforming
    let escape: EscapeWatch
    /// a new one per process: every element index from another epoch is stale
    public let epoch = UUID().uuidString

    let lock = NSLock()
    var initResult: (dataDir: String, result: Methods.Initialize.Output)?
    var initializing = false
    var serviceLease: FileLockLease?
    var permissions = Permissions(accessibility: false, screenRecording: false)
    var clipboard: ClipboardWatchRule?
    var streams: [String: StreamEntry] = [:]
    /// the agent's last click per session × window, for a stream that starts after it (P2)
    var clicks = ClickCarry()
    /// per session, the requests that passed its check and have not answered: `session.close` cancels and waits for them
    var sessionRequests: [String: [Int: CancelFlag]] = [:]
    var watchers: [any Stoppable] = []
    var promptedAccessibility = false
    var promptedScreenRecording = false
    private var reading = true

    public init(modules: Modules, environment: ServiceEnvironment, build: BuildInfo, trace: Trace, sink: any LineSink) {
        self.modules = modules
        self.env = environment
        self.build = build
        self.trace = trace
        let relay = Relay()
        self.outbox = Outbox(sink: sink, trace: trace, onClosed: { reason in relay.service?.outboxClosed(reason) })
        self.router = Router(outbox: outbox, trace: trace, mapError: ComputerService.computerError)
        self.lifecycle = Lifecycle(env: environment, trace: trace)
        self.inventory = Inventory(workspace: environment.workspace, timing: environment.timing)
        self.locks = MacLocks(directory: environment.lockDirectory)
        self.clipboardLock = ClipboardMacLock(locks: locks, trace: trace, warn: { relay.service?.log(.warn, $0) }, look: { own in relay.service?.lookAtPasteboard(own: own) })
        self.sessionLock = SessionMacLock(locks: locks, trace: trace)
        self.held = HeldInput(slots: slots, book: book, warn: { relay.service?.log(.warn, $0) })
        self.readers = modules.readers()
        self.capture = modules.capture { relay.service?.log(.warn, $0) }
        self.input = modules.input(InputWiring(
            clipboardLock: clipboardLock,
            sessionLock: sessionLock,
            recentForeignCopy: { ms in relay.service?.recentForeignCopy(withinMs: ms) ?? false },
            onPersonInput: { pid in relay.service?.personInput(pid: pid) },
            onHeld: { event in relay.service?.held.handle(event) }
        ))
        self.escape = EscapeWatch(
            makeTap: modules.escapeTap,
            now: { [system = environment.system] in system.now() },
            onPress: { at in relay.service?.notify("escape/pressed", EscapePressedNotification.Params(at: at)) },
            warn: { relay.service?.log(.warn, $0) }
        )
        relay.service = self
        lifecycle.windDown = { [weak self] in await self?.windDown() }
        let outbox = self.outbox
        lifecycle.drain = { deadline in await outbox.drain(until: deadline) }
        register()
    }

    /// Starts the outbox's writer, the stdin reader on `input`, the signal handlers and the parent watch.
    public func start(input fd: Int32) {
        outbox.start()
        lifecycle.start()
        let thread = Thread { [self] in readLoop(fd) }
        thread.name = "tc-computer.stdin"
        thread.start()
    }

    /// One stdin line, as the reader thread hands it on; the tests call it directly.
    public func receive(_ line: Data) {
        guard lock.withLock({ reading }) else { return }
        router.receive(line)
    }

    private func readLoop(_ fd: Int32) {
        var splitter = LineSplitter(maxBytes: ComputerDefaults.Service.lineMaxBytes)
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { break }
            for item in splitter.feed(Data(buffer[0..<count])) {
                switch item {
                case .line(let line): receive(line)
                case .overlong(let bytes): router.receiveOverlong(bytes)
                }
            }
        }
        lifecycle.exit(0, why: "stdin closed")
    }

    /// A blocking module call on a dispatch queue, never on Swift's cooperative pool, so a hung app
    /// cannot starve the tasks that answer the liveness ping and `shutdown`.
    func blocking<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try body()) } catch { continuation.resume(throwing: error) }
            }
        }
    }

    // MARK: Notifications and log

    func notify<P: Encodable>(_ method: String, _ params: P, kind: Outbox.Kind = .plain) {
        outbox.notify(notificationLine(method: method, params: params), kind: kind)
    }

    func log(_ level: LogNotification.Params.Level, _ message: String) {
        switch level {
        case .warn: trace.warn(message)
        case .error: trace.error(message)
        default: trace.note(message)
        }
        guard router.isInitialized else { return }
        notify("log", LogNotification.Params(level: level, message: message), kind: .log)
    }

    // MARK: Errors

    /// What a thrown error means on the wire: a `ComputerError` as it is, ComputerCore's `ComputerFailure` unwrapped.
    static func computerError(_ error: any Error) -> ComputerError? {
        if let error = error as? ComputerError { return error }
        if let failure = error as? ComputerFailure { return failure.error }
        return nil
    }

    /// The error a step or a shot carries; a throw that is no `ComputerError` (a bug) takes `kind`.
    static func failure(_ error: any Error, or kind: ComputerErrorKind) -> ComputerError {
        if error is CancellationError { return Router.cancelledError }
        return computerError(error) ?? ComputerError(kind: kind, message: "The service failed: \(error).")
    }

    // MARK: Checks every call runs

    func requireSession(_ session: String) throws {
        guard book.isOpen(session) else {
            throw ComputerError(kind: .unknownSession, message: "Session \(session) is not open; open it again.")
        }
    }

    func requireAccessibility() throws {
        guard currentPermissions.accessibility else {
            pokePermissions()
            throw ComputerError(kind: .permissionMissing, message: "TempCode needs the Accessibility permission to read and act on apps.", which: .accessibility)
        }
    }

    var currentPermissions: Permissions { lock.withLock { permissions } }

    // MARK: Person input and outbox

    /// Input saw the person's own input while a session held input on `pid`.
    func personInput(pid: pid_t) {
        guard let session = held.session(holding: pid) else { return }
        interrupted(session: session)
    }

    func interrupted(session: String) {
        notify("session/interrupted", SessionInterruptedNotification.Params(session: session, by: .person, at: Int(env.system.now())))
    }

    func outboxClosed(_ reason: Outbox.CloseReason) {
        switch reason {
        case .hostGone: lifecycle.exit(0, why: "the host stopped reading (a write failed)")
        case .overBudget: lifecycle.exit(70, why: "the host left \(ComputerDefaults.Service.outboxBudgetBytes) bytes unread")
        }
    }

    // MARK: Ending

    /// The exit path's steps (shell §8.2): stop reading, cancel everything, let go of held input, stop the
    /// streams, close the readers, drain.
    func windDown() async {
        lock.withLock { reading = false }
        escape.stop()
        router.cancelAll()
        let box = InputBox(input: input)
        for (pid, _) in held.all { _ = try? await blocking { box.input.releaseHeld(pid: pid) } }
        let ending: [StreamEntry] = lock.withLock {
            defer { streams.removeAll() }
            return Array(streams.values)
        }
        for entry in ending {
            await entry.handle.stop()
            notify("capture/streamEnded", CaptureStreamEndedNotification.Params(stream: entry.id, reason: .stopped))
        }
        for session in book.openSessions { readers.close(session: session) }
        let stopping: [any Stoppable] = lock.withLock {
            defer { watchers.removeAll() }
            return watchers
        }
        for watcher in stopping { watcher.stop() }
    }

    private func register() {
        registerSetup()
        registerApps()
        registerSessions()
        registerObserve()
        registerActions()
        registerCapture()
        registerInput()
        registerEscape()
    }
}

/// Lets the callbacks built before `self` exists reach it once it does.
final class Relay: @unchecked Sendable {
    weak var service: ComputerService?
}

/// A watcher the exit path stops.
protocol Stoppable: Sendable {
    func stop()
}

/// One preview stream.
struct StreamEntry: @unchecked Sendable {
    let id: String
    let session: String
    let pid: pid_t
    let windowID: UInt32
    let handle: any StreamHandle
    /// the size of its newest frame, the start size until one comes; a click maps into it
    let size: FrameSize
}

/// A stream's frame size: its start size, then each frame's.
final class FrameSize: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (width: Int, height: Int)?

    var current: (width: Int, height: Int) { lock.withLock { value } ?? (0, 0) }

    /// The start size, unless a frame came first.
    func seed(_ size: (width: Int, height: Int)) {
        lock.withLock { if value == nil { value = size } }
    }

    func set(width: Int, height: Int) {
        guard width > 0, height > 0 else { return }
        lock.withLock { value = (width, height) }
    }
}
