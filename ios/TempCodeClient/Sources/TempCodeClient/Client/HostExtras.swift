import Foundation
import Observation
import TempCodeContract

/// What the host detail's Activity sections read about one host (iOS thread
/// 21): its devices (when it is a Mac, or the Macs linked to it), the deploy
/// job and its log, the harness and memory sync lines, and, on a Mac, the Mac
/// bridge's calls past the prompt. One per `EnvironmentClient`, built from its
/// socket, so it needs nothing else of the client.
///
/// Nothing polls on its own: a view runs `run(_:)` from `.task` while it is on
/// screen and the task's cancellation ends the loop (the devices watch sends
/// its unwatch on the way out). The first answer lands as plain state; the
/// views decide what animates. Words live in HostExtrasText.swift.
@MainActor @Observable
public final class HostExtras {
    /// What a view keeps fresh while it shows.
    public enum Poll: Hashable, Sendable {
        /// `host.devices.hosts`: the Macs whose devices this host can show.
        case deviceHosts
        /// `host.devices.watch` for one Mac, re-sent when the reports stop.
        case devices(String)
        /// `host.deployStatus`, and the log once a run exists.
        case deploy
        /// `macBridge.activity` (a Mac's client).
        case macBridge
        /// `harness.status` and `memory.status`.
        case sync
    }

    public nonisolated static let deviceHostsEveryMs: Double = 15_000
    /// The watch's own cadence on the host is 30 s; a report older than
    /// `devicesStaleMs` means the watch was lost and is sent again.
    public nonisolated static let devicesEveryMs: Double = 30_000
    public nonisolated static let devicesStaleMs: Double = 45_000
    public nonisolated static let deployEveryMs: Double = 5_000
    public nonisolated static let macBridgeEveryMs: Double = 5_000
    public nonisolated static let syncEveryMs: Double = 15_000
    /// While the socket is not open a loop looks again this often and sends nothing.
    public nonisolated static let waitForOpenMs: Double = 1_000
    /// The deploy log kept in memory; the sheet shows the last `LogTail.lines`.
    public nonisolated static let logLinesInMemory = 400

    /// One Mac's devices as this host last reported them.
    public struct DevicesState: Sendable, Hashable {
        public var report: HostDevicesReport?
        /// Why the last watch failed, when no report came instead.
        public var error: String?
        /// Clock milliseconds of the last report.
        public var lastReportAt: Double?
        /// A shutdown, delete or Open in Xcode is out for this device (the Mac's id for Open in Xcode).
        public var busy: String?

        public init(report: HostDevicesReport? = nil, error: String? = nil, lastReportAt: Double? = nil, busy: String? = nil) {
            self.report = report
            self.error = error
            self.lastReportAt = lastReportAt
            self.busy = busy
        }
    }

    /// The deploy log as the sheet reads it.
    public struct DeployLog: Sendable, Hashable {
        public var text: String = ""
        public var status: HostJobStatus?
        /// `host.log` answered and this socket hears the pushes.
        public var following = false

        public init() {}
    }

    /// The harness and memory sync as this host reports them.
    public struct SyncState: Sendable, Hashable {
        public var harness: HarnessSyncStatus?
        public var memory: MemorySyncStatus?
        /// The key may not read it (admin); the section says why.
        public var forbidden = false
        public var error: String?
        /// Peers a Sync now is out for.
        public var syncing: Set<String> = []

        public init() {}
    }

    public let environment: PairedEnvironment
    public private(set) var devices: [String: DevicesState] = [:]
    /// `host.devices.hosts`; nil before the first answer.
    public private(set) var deviceHosts: [HostDevicesHost]?
    public private(set) var deviceHostsError: String?
    public private(set) var deploy: DeployStatus?
    public private(set) var deployForbidden = false
    public private(set) var deployError: String?
    public private(set) var log = DeployLog()
    public private(set) var sync = SyncState()
    /// Whether `sync` holds an answer (or a refusal) yet.
    public private(set) var syncLoaded = false
    public private(set) var macBridge: MacBridgeActivity?
    public private(set) var macBridgeForbidden = false
    public private(set) var macBridgeError: String?

    @ObservationIgnored private let socket: TempCodeSocket
    @ObservationIgnored private let clock: any SocketClock

    public init(socket: TempCodeSocket, environment: PairedEnvironment, clock: any SocketClock) {
        self.socket = socket
        self.environment = environment
        self.clock = clock
    }

    // MARK: - derived

    /// Where the deploy is: the log's status once following (it moves with the
    /// pushes), else the last poll's.
    public var deployJob: HostJobStatus? {
        if let status = log.status { return status }
        guard let deploy else { return nil }
        return HostJobStatus(job: .deploy, phase: deploy.phase, target: deploy.target, startedAt: deploy.startedAt, finishedAt: deploy.finishedAt, exit: deploy.exit, stoppable: deploy.stoppable)
    }

    // MARK: - pushes

    /// `host.devices` and `host-log`; everything else is the client's.
    public func applyPush(_ push: ServerPush) {
        switch push {
        case .hostDevices(let value):
            land(value.report)
        case .hostLog(let value):
            guard value.job == .deploy else { return }
            let text = LogTail.apply(log.text, append: value.append, reset: value.reset ?? false)
            log.text = LogTail.cap(text, lines: Self.logLinesInMemory)
            log.status = value.status
        default:
            break
        }
    }

    // MARK: - the loops

    /// Keeps `poll` fresh until the calling task is cancelled, or until the
    /// key turns out not to be allowed to read it. While the socket is not
    /// open it sends nothing; when it opens again, what a lost connection
    /// dropped is asked again (the devices watch, the deploy log).
    public func run(_ poll: Poll) async {
        var wasOpen = false
        while !Task.isCancelled {
            guard await socket.isOpen else {
                wasOpen = false
                do { try await clock.sleep(ms: Self.waitForOpenMs) } catch { break }
                continue
            }
            let reopened = !wasOpen
            wasOpen = true
            guard await tick(poll, reopened: reopened) else { break }
            do { try await clock.sleep(ms: Self.every(poll)) } catch { break }
        }
        if case .devices(let mac) = poll {
            // Best effort, on a task of its own: this one is cancelled.
            let socket = self.socket
            Task { _ = try? await socket.request(Methods.HostDevicesUnwatch.self, .init(environmentId: mac)) }
        }
    }

    nonisolated static func every(_ poll: Poll) -> Double {
        switch poll {
        case .deviceHosts: deviceHostsEveryMs
        case .devices: devicesEveryMs
        case .deploy: deployEveryMs
        case .macBridge: macBridgeEveryMs
        case .sync: syncEveryMs
        }
    }

    /// One round of `poll`; false stops the loop (the key may not read it).
    private func tick(_ poll: Poll, reopened: Bool) async -> Bool {
        switch poll {
        case .deviceHosts:
            await refreshDeviceHosts()
            return true
        case .devices(let mac):
            let last = devices[mac]?.lastReportAt
            if reopened || last == nil || clock.now - (last ?? 0) > Self.devicesStaleMs { await watch(mac) }
            return true
        case .deploy:
            await refreshDeploy()
            guard !deployForbidden else { return false }
            if let deploy, deploy.phase != .idle {
                // A run exists: take its log once, again after a reconnect (the
                // box restarts into the new build mid-deploy) or for a new run.
                let newRun = log.status?.startedAt != deploy.startedAt && deploy.phase != .done
                if !log.following || reopened || newRun { await followDeployLog() }
            }
            return true
        case .macBridge:
            await refreshMacBridge()
            return !macBridgeForbidden
        case .sync:
            await refreshSync()
            return !sync.forbidden
        }
    }

    // MARK: - reads

    public func refreshDeviceHosts() async {
        do {
            deviceHosts = try await call(Methods.HostDevicesHosts.self, .init())
            deviceHostsError = nil
        } catch {
            deviceHostsError = error.message
        }
    }

    /// Opens (or renews) this socket's watch of one Mac; the answer is a report.
    public func watch(_ mac: String) async {
        do {
            land(try await call(Methods.HostDevicesWatch.self, .init(environmentId: mac)))
        } catch {
            devices[mac, default: DevicesState()].error = error.message
        }
    }

    public func refreshDeploy() async {
        do {
            deploy = try await call(Methods.HostDeployStatus.self, .init())
            deployError = nil
        } catch {
            if error.isForbidden { deployForbidden = true } else { deployError = error.message }
        }
    }

    /// `host.log { job: deploy }`: the whole log so far replaces what is held,
    /// and this socket hears the `host-log` pushes from now on.
    public func followDeployLog() async {
        do {
            let answer = try await call(Methods.HostLog.self, .init(job: .deploy))
            log.text = LogTail.cap(answer.text, lines: Self.logLinesInMemory)
            log.status = answer.status
            log.following = true
        } catch {
            if error.isForbidden { deployForbidden = true } else { deployError = error.message }
        }
    }

    public func refreshMacBridge() async {
        do {
            macBridge = try await call(Methods.MacBridgeActivity.self, .init())
            macBridgeError = nil
        } catch {
            if error.isForbidden { macBridgeForbidden = true } else { macBridgeError = error.message }
        }
    }

    public func refreshSync() async {
        let socket = self.socket
        async let harness = Self.attempt { try await socket.request(Methods.HarnessStatus.self, .init()) }
        async let memory = Self.attempt { try await socket.request(Methods.MemoryStatus.self, .init()) }
        let (h, m) = await (harness, memory)
        land(harness: h, memory: m)
    }

    // MARK: - actions

    /// `host.deploy { ref: master }`, then the log from its first line.
    public func startDeploy() async throws {
        try gate(.deploy)
        deploy = try await call(Methods.HostDeploy.self, .init(ref: "master"))
        log = DeployLog()
        await followDeployLog()
    }

    /// The device's row shows a spinner while `busy` names it; the answer is the Mac's report after the act.
    public func shutdownSimulator(mac: String, udid: String) async throws {
        try gate(.deviceActions)
        devices[mac, default: DevicesState()].busy = udid
        defer { devices[mac]?.busy = nil }
        land(try await call(Methods.HostSimulatorShutdown.self, .init(environmentId: mac, udid: udid)))
    }

    public func deleteSimulator(mac: String, udid: String) async throws {
        try gate(.deviceActions)
        devices[mac, default: DevicesState()].busy = udid
        defer { devices[mac]?.busy = nil }
        land(try await call(Methods.HostSimulatorDelete.self, .init(environmentId: mac, udid: udid)))
    }

    /// Opens Xcode's Devices and Simulators window on the Mac.
    public func openXcode(mac: String) async throws {
        try gate(.deviceActions)
        devices[mac, default: DevicesState()].busy = mac
        defer { devices[mac]?.busy = nil }
        _ = try await call(Methods.HostDeviceOpenXcode.self, .init(environmentId: mac))
    }

    /// `harness.sync` and `memory.sync` for one peer, each only when its side
    /// is on; the answers are the fresh status.
    public func syncNow(environmentId: String) async throws {
        try gate(.sync)
        sync.syncing.insert(environmentId)
        defer { sync.syncing.remove(environmentId) }
        let socket = self.socket
        let harnessOn = sync.harness?.enabled ?? true
        let memoryOn = sync.memory?.enabled ?? true
        async let harness = Self.attempt(if: harnessOn) { try await socket.request(Methods.HarnessSync.self, .init(environmentId: environmentId)) }
        async let memory = Self.attempt(if: memoryOn) { try await socket.request(Methods.MemorySync.self, .init(environmentId: environmentId)) }
        let (h, m) = await (harness, memory)
        land(harness: h, memory: m)
        if case .failure(let error)? = h { throw error }
        if case .failure(let error)? = m { throw error }
    }

    /// `macBridge.stop`: what the Mac's own Stop does for a running or held
    /// call. Called on the Mac's client; then one refresh.
    public func stopMacCall(id: String) async throws {
        try gate(.macStop)
        _ = try await call(Methods.MacBridgeStop.self, .init(id: id))
        await refreshMacBridge()
    }

    // MARK: - landing

    private func land(_ report: HostDevicesReport) {
        var state = devices[report.environmentId] ?? DevicesState()
        state.report = report
        state.error = nil
        state.lastReportAt = clock.now
        devices[report.environmentId] = state
    }

    private func land(harness: Result<HarnessSyncStatus, ActionError>?, memory: Result<MemorySyncStatus, ActionError>?) {
        var next = sync
        var errors: [String] = []
        for error in [harness?.failure, memory?.failure].compactMap({ $0 }) {
            if error.isForbidden { next.forbidden = true } else { errors.append(error.message) }
        }
        if case .success(let value)? = harness { next.harness = value }
        if case .success(let value)? = memory { next.memory = value }
        next.error = errors.first
        sync = next
        syncLoaded = true
    }

    // MARK: - the wire

    /// Refused before the wire when the key lacks the capability, with the sentence the section shows.
    private func gate(_ access: HostExtrasAccess) throws {
        guard access.allowed(environment) else { throw ActionError.refused(message: access.reason, forbidden: true) }
    }

    private func call<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws(ActionError) -> M.Output {
        do {
            return try await socket.request(method, params)
        } catch {
            throw ActionError.wrap(error)
        }
    }

    /// One request as a result, so two can run side by side; nil when `on` is false (nothing sent).
    private nonisolated static func attempt<T: Sendable>(if on: Bool = true, _ body: @Sendable () async throws -> T) async -> Result<T, ActionError>? {
        guard on else { return nil }
        do {
            return .success(try await body())
        } catch {
            return .failure(ActionError.wrap(error))
        }
    }
}

extension ActionError {
    /// The key's capabilities said no (`forbidden: … needs …`).
    public var isForbidden: Bool {
        if case .refused(_, let forbidden) = self { return forbidden }
        return false
    }
}

private extension Result {
    var failure: Failure? {
        if case .failure(let error) = self { return error }
        return nil
    }
}

// MARK: - master's release

/// Master's release.json, read by the phone itself from GitHub (the desktop's
/// `deploy.master` is local-only): fetched while a drift mark or a host
/// detail is on screen, every ten minutes, and again when the app comes
/// forward after fifteen idle minutes, the desktop's cadence
/// (src/main/deployDrift.ts). A failure keeps the last value. Several
/// runners share one fetch.
@MainActor @Observable
public final class MasterReleaseWatcher {
    public static let shared = MasterReleaseWatcher()

    public nonisolated static let url = URL(string: "https://raw.githubusercontent.com/LandonDev/temp-code/master/release.json")!
    public nonisolated static let everyMs: Double = 600_000
    public nonisolated static let focusRecheckMs: Double = 900_000
    public nonisolated static let timeoutSeconds: TimeInterval = 15

    public typealias Fetch = @Sendable (URL) async throws -> Data

    public private(set) var release: MasterRelease?
    /// The last attempt failed (network, a non-200, JSON without `n`).
    public private(set) var fetchFailed = false
    /// Clock milliseconds of the last attempt.
    public private(set) var fetchedAt: Double?

    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let clock: any SocketClock

    public init(clock: any SocketClock = SystemClock(), fetch: @escaping Fetch = MasterReleaseWatcher.urlSessionFetch) {
        self.clock = clock
        self.fetch = fetch
    }

    /// GET with no cache and a 15 s timeout; anything but a 200 is a failure.
    public nonisolated static let urlSessionFetch: Fetch = { url in
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeoutSeconds)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }

    /// Fetches when due, then sleeps until the next due moment, until cancelled.
    public func run() async {
        while !Task.isCancelled {
            if let at = fetchedAt {
                let wait = at + Self.everyMs - clock.now
                if wait > 0 {
                    do { try await clock.sleep(ms: wait) } catch { return }
                    continue
                }
            }
            await refresh()
        }
    }

    /// The app came forward: fetch only when the last attempt is older than the focus recheck.
    public func foreground() async {
        if let at = fetchedAt, clock.now - at <= Self.focusRecheckMs { return }
        await refresh()
    }

    /// One fetch, shared with any runner that asks while it is out.
    public func refresh() async {
        if let inflight {
            await inflight.value
            return
        }
        fetchedAt = clock.now
        let fetch = self.fetch
        let task = Task { [weak self] in
            let result: Result<Data, any Error>
            do { result = .success(try await fetch(Self.url)) } catch { result = .failure(error) }
            self?.land(result)
        }
        inflight = task
        await task.value
        inflight = nil
    }

    private func land(_ result: Result<Data, any Error>) {
        guard case .success(let data) = result, let parsed = MasterRelease.parse(data, now: clock.now) else {
            fetchFailed = true
            return
        }
        release = parsed
        fetchFailed = false
    }
}
