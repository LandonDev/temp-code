import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

extension ComputerService {
    func registerSetup() {
        router.on("initialize", beforeInit: true) { [self] (p: Methods.Initialize.Params, ctx) in try await initialize(p, ctx) }
        router.on("shutdown", beforeInit: true, slot: false) { [self] (_: Empty, _) -> Empty in
            router.markShutDown()
            Task {
                try? await Task.sleep(for: .milliseconds(10))
                lifecycle.exit(Lifecycle.Code.clean, why: "shutdown")
            }
            return Empty()
        }
        router.on("permissions.get", slot: false) { [self] (_: Empty, _) in currentPermissions }
        router.on("permissions.request") { [self] (p: Methods.PermissionsRequest.Params, _) in requestPermission(p.which) }
        router.on("clipboard.state", slot: false) { [self] (_: Empty, _) -> ClipboardActivity in
            lock.withLock { clipboard?.state } ?? ClipboardActivity(changeCount: env.system.pasteboardChangeCount(), foreignChangeAt: nil, watchingSince: env.system.now())
        }
    }

    /// Checks the protocol, takes `<dataDir>/service.lock`, lets go of input a crashed service left held,
    /// reads the grants and the displays, then starts the watchers.
    func initialize(_ p: Methods.Initialize.Params, _ ctx: RequestContext) async throws -> Methods.Initialize.Output {
        guard p.protocol == computerProtocol else {
            throw ComputerError(kind: .protocolMismatch, message: "This service speaks protocol \(computerProtocol), not \(p.protocol).")
        }
        enum Gate { case again(Methods.Initialize.Output), refuse, go }
        let gate: Gate = lock.withLock {
            if let done = initResult { return done.dataDir == p.dataDir ? .again(done.result) : .refuse }
            if initializing { return .refuse }
            initializing = true
            return .go
        }
        switch gate {
        case .again(let result): return result
        case .refuse: throw RPCFailure.invalidRequest("the service is already initialized with another dataDir")
        case .go: break
        }
        do {
            let (result, released) = try await initializeOnce(p)
            lock.withLock {
                initResult = (p.dataDir, result)
                initializing = false
            }
            router.markInitialized()
            // nothing reaches the host before initialize's answer
            ctx.afterAnswer { [self] in
                if released > 0 {
                    log(.info, "released \(released) held \(released == 1 ? "input" : "inputs") a stopped service left down")
                }
                startWatchers()
            }
            return result
        } catch {
            lock.withLock { initializing = false }
            throw error
        }
    }

    /// Answers the result and how many held inputs it let go of; that log follows the answer.
    private func initializeOnce(_ p: Methods.Initialize.Params) async throws -> (Methods.Initialize.Output, Int) {
        let dataDir = URL(fileURLWithPath: p.dataDir, isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let lockPath = dataDir.appendingPathComponent("service.lock").path
        let wait = env.timing.serviceLockWait
        let lease = try await blocking { FileLock.acquire(lockPath, timeout: wait) }
        guard let lease else {
            throw ComputerError(kind: .alreadyRunning, message: "Another computer service is using \(p.dataDir).")
        }
        lock.withLock { serviceLease = lease }

        let stale = held.open(dataDir: dataDir)
        if !stale.isEmpty {
            let box = InputBox(input: input)
            try await blocking { for record in stale { box.input.releaseStale(record) } }
        }

        let read = readPermissions()
        lock.withLock {
            permissions = read
            hostFeatures = HostFeatures(p.features)
        }
        return (Methods.Initialize.Output(
            protocol: computerProtocol,
            service: .init(version: build.version, build: build.build),
            epoch: epoch,
            os: .init(version: env.system.osVersion(), arch: env.system.arch()),
            permissions: read,
            displays: env.system.displays(),
            features: computerFeatures
        ), stale.count)
    }

    /// The host's features, for a result on its way out.
    var features: HostFeatures { lock.withLock { hostFeatures } }

    /// `initialize` stays answered from `initResult`; this is for `log`, which waits for it.
    var dataDir: String? { lock.withLock { initResult?.dataDir } }

    // MARK: TCC

    func readPermissions() -> Permissions {
        Permissions(accessibility: env.permissions.accessibility(), screenRecording: env.permissions.screenRecording())
    }

    /// Asks the system at most once per process run for each grant; later calls only read.
    func requestPermission(_ which: PermissionName) -> Permissions {
        switch which {
        case .accessibility:
            let first = lock.withLock { () -> Bool in
                defer { promptedAccessibility = true }
                return !promptedAccessibility
            }
            if first { env.permissions.promptAccessibility() }
        case .screenRecording:
            let first = lock.withLock { () -> Bool in
                defer { promptedScreenRecording = true }
                return !promptedScreenRecording
            }
            if first { env.permissions.requestScreenRecording() }
        case .unknown:
            break
        }
        // the watch reads again and owns every transition (permissions/changed, the exit-75 restart)
        pokePermissions()
        return readPermissions()
    }

    /// A module said a grant is missing: read again now.
    func pokePermissions() {
        let watch = lock.withLock { watchers.compactMap { $0 as? PermissionWatch }.first }
        watch?.poke()
    }

    /// The grant watch, the pasteboard watch, the app and window events.
    func startWatchers() {
        let permissionWatch = PermissionWatch(service: self)
        let pasteboard = PasteboardWatch(service: self)
        lock.withLock {
            clipboard = ClipboardWatchRule(changeCount: env.system.pasteboardChangeCount(), now: env.system.now())
            watchers = [permissionWatch, pasteboard, EventsStopper(env: env)]
        }
        permissionWatch.start()
        pasteboard.start()
        env.appEvents.start { [weak self] event in self?.appChanged(event) }
        env.windowEvents.start { [weak self] event in self?.windowChanged(event) }
    }

    func appChanged(_ event: AppEvent) {
        front.appEvent(event)
        notify("apps/changed", AppsChangedNotification.Params(pid: Int(event.pid), bundleId: event.bundleId, name: event.name, change: .init(rawValue: event.change.rawValue)))
        if event.change == .terminated {
            env.windowEvents.unwatch(pid: event.pid)
            workers.drop(pid: event.pid)
        }
    }

    func windowChanged(_ event: WindowEvent) {
        front.windowEvent(event)
        capture.invalidate()
        notify(
            "window/changed",
            WindowChangedNotification.Params(pid: Int(event.pid), windowId: Int(event.windowID), change: .init(rawValue: event.change.rawValue)),
            kind: .coalesce("\(event.pid):\(event.windowID):\(event.change.rawValue)")
        )
    }
}

/// Reads the grants every 2 s while one is off and every 30 s while both are on, and at once when a
/// module says one is missing; sends `permissions/changed` when one flips. When Screen Recording comes
/// on, the service restarts itself so its own captures take the grant (exit 75).
final class PermissionWatch: Stoppable, @unchecked Sendable {
    private weak var service: ComputerService?
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "tc-computer.permissions")

    init(service: ComputerService) {
        self.service = service
    }

    func start() { schedule() }

    func poke() { queue.async { [self] in check() } }

    func stop() {
        lock.withLock {
            timer?.cancel()
            timer = nil
        }
    }

    private func schedule() {
        guard let service else { return }
        let both = service.currentPermissions.accessibility && service.currentPermissions.screenRecording
        let every = both ? service.env.timing.permissionPollOn : service.env.timing.permissionPollOff
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now() + every.timeInterval)
        next.setEventHandler { [weak self] in
            self?.check()
            self?.schedule()
        }
        let previous: DispatchSourceTimer? = lock.withLock {
            defer { timer = next }
            return timer
        }
        previous?.cancel()
        next.resume()
    }

    private func check() {
        guard let service else { return }
        let now = service.readPermissions()
        let before: Permissions = service.lock.withLock {
            defer { service.permissions = now }
            return service.permissions
        }
        guard now != before else { return }
        service.notify("permissions/changed", now)
        if now.screenRecording && !before.screenRecording {
            service.log(.info, "Screen Recording is on; the service restarts so its captures take the grant")
            Task {
                let deadline = ContinuousClock.now + service.env.timing.restartQuiet
                while service.router.busy && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(50)) }
                service.lifecycle.exit(Lifecycle.Code.restart, why: "Screen Recording was granted")
            }
        }
    }
}

extension ComputerService {
    /// Input's question right before a paste, holding the clipboard lock and before the pasteboard is
    /// read or written: did a foreign change come within `ms`, `watchingSince` counted as one
    /// (`clipboard.state`'s rule)? The pasteboard is looked at now, since the poll may not have seen a
    /// copy yet; a change since the lock's own look is foreign, as nothing of the paste is written yet.
    func recentForeignCopy(withinMs ms: Int) -> Bool {
        lookAtPasteboard(own: false)
        let now = env.system.now()
        return lock.withLock { clipboard.map { !$0.quiet(for: Double(ms), now: now) } ?? true }
    }

    /// One look at the pasteboard's change count outside the poll (the clipboard lock's edges, the paste's check).
    func lookAtPasteboard(own: Bool) {
        let count = env.system.pasteboardChangeCount()
        let now = env.system.now()
        lock.withLock { clipboard?.observe(changeCount: count, ownHoldSinceLastPoll: own, at: now) }
    }
}

/// The pasteboard's change count every 250 ms, never its contents (`clipboard.state`, shell §6.2).
final class PasteboardWatch: Stoppable, @unchecked Sendable {
    private weak var service: ComputerService?
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()

    init(service: ComputerService) {
        self.service = service
    }

    func start() {
        guard let service else { return }
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tc-computer.pasteboard"))
        let every = service.env.timing.clipboardPoll.timeInterval
        source.schedule(deadline: .now() + every, repeating: every)
        source.setEventHandler { [weak self] in self?.poll() }
        lock.withLock { timer = source }
        source.resume()
    }

    func stop() {
        lock.withLock {
            timer?.cancel()
            timer = nil
        }
    }

    private func poll() {
        guard let service else { return }
        let count = service.env.system.pasteboardChangeCount()
        let own = service.clipboardLock.takeHeldSincePoll()
        let now = service.env.system.now()
        service.lock.withLock { service.clipboard?.observe(changeCount: count, ownHoldSinceLastPoll: own, at: now) }
    }
}

/// Stops the app and window event sources on exit.
struct EventsStopper: Stoppable {
    let env: ServiceEnvironment

    func stop() {
        env.appEvents.stop()
        env.windowEvents.stop()
    }
}
