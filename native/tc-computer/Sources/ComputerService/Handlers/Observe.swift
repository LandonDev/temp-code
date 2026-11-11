import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation

/// What a call resolved: the app, its worker and the window the reader, Input and Capture all act on.
struct Resolved: Sendable {
    let session: String
    let pid: pid_t
    let app: Observation.App
    let worker: Worker
    let info: WindowInfo
    let launched: Bool
    /// the browser tab the ref matched (§25.4), nil for none; the element is on the worker
    var tab: TabRef? = nil

    var windowID: UInt32 { UInt32(truncatingIfNeeded: info.id) }
}

/// The matched tab as the request task sees it.
struct TabRef: Sendable, Equatable {
    let title: String
    let selected: Bool
}

/// The knobs of one observation, from `state.get` or an action's `observe`.
struct ObserveKnobs: Sendable {
    var mode: ObservationMode = .auto
    var element: Int?
    var screenshot: ScreenshotPolicy = .auto
    var maxEdge: Int?
    var geometry: Bool?
    var menus: Bool?
    var budgetBytes: Int = ComputerDefaults.ObservationBudget.defaultBytes
    /// an acting call's closing read: the menus its steps opened close the text (§27.4)
    var openedMenus = false

    init() {}

    init(_ options: ObserveOptions?) {
        if options?.mode == .full { mode = .full }
        screenshot = options?.screenshot ?? .auto
        maxEdge = options?.maxEdge
        geometry = options?.geometry
        menus = options?.menus
        budgetBytes = options?.budget?.bytes ?? ComputerDefaults.ObservationBudget.defaultBytes
    }
}

extension ComputerService {
    func registerObserve() {
        router.on("state.get") { [self] (p: Methods.StateGet.Params, ctx) in try await stateGet(p, ctx) }
    }

    func stateGet(_ p: Methods.StateGet.Params, _ ctx: RequestContext) async throws -> Observation {
        if let failure = EpochCheck.check(names: p.element, epoch: p.epoch, current: epoch) { throw failure }
        let target = try await resolveTarget(session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, ctx: ctx)
        let options = p.wait ?? ComputerDefaults.Wait.observe
        // a read that must select a tab holds the exclusive slot through its observation (§25.4)
        let hold = try await readHold(target, tabs: p.tabs, waitMs: options.busyMaxMs)
        defer { hold.lease.release() }
        let pixel = await pixelWatch(target)
        let t0 = MachTime.now()
        let sig0 = try await signature(target)
        let waited = await SmartWait.run(
            options, from: t0, signature0: sig0, thin: book.lastThin(target.session, pid: target.pid),
            watch: try await waitWatch(target, pixel: pixel), cancel: ctx.cancel, isRunning: { [inventory] in inventory.isRunning($0) },
            tick: env.timing.waitTick, trace: trace
        )
        if waited.report.reason == .cancelled { throw Router.cancelledError }
        var knobs = ObserveKnobs()
        knobs.mode = p.mode ?? .auto
        knobs.element = p.element
        knobs.screenshot = p.screenshot ?? .auto
        knobs.maxEdge = p.maxEdge
        knobs.geometry = p.geometry
        knobs.menus = p.menus
        knobs.budgetBytes = p.budget?.bytes ?? ComputerDefaults.ObservationBudget.defaultBytes
        return try await observe(target, knobs, loading: waited.report.busy, waited: waited.report, selectedTab: hold.selectedTab, cancel: ctx.cancel)
    }

    // MARK: Resolving

    /// The session open, Accessibility on, the app found (launched in the background when asked, then its
    /// first window waited for), the window resolved on the session × pid worker, which keeps its element.
    func resolveTarget(session: String, app: AppRef, window: WindowRef?, launch: Bool, ctx: RequestContext) async throws -> Resolved {
        try requireSession(session)
        lock.withLock { sessionRequests[session, default: [:]][ctx.id] = ctx.cancel }
        ctx.afterAnswer { [self] in
            lock.withLock {
                sessionRequests[session]?[ctx.id] = nil
                if sessionRequests[session]?.isEmpty == true { sessionRequests[session] = nil }
            }
        }
        try requireAccessibility()
        let (pid, launched) = try await inventory.resolve(app, launch: launch, session: session)
        let worker = workers.worker(session, pid)
        let source = modules.windows
        let readers = self.readers
        if launched { try await waitForFirstWindow(pid: pid, worker: worker) }
        let (info, tab) = try await worker.run { state -> (WindowInfo, TabRef?) in
            // §25.4: a ref may name a browser tab; resolution only finds it, the slot's holder selects it; §27.6: a title no
            // live window or tab has may be one the service answered for a live window before
            let (element, info, tab) = try ComputerService.resolveKept(source, pid: pid, ref: window, aliases: &state.aliases)
            let id = UInt32(truncatingIfNeeded: info.id)
            state.windows[id] = element
            state.tabs[id] = tab
            if state.reader == nil { state.reader = try readers.reader(session: session, pid: pid) }
            return (info, tab.map { TabRef(title: $0.title, selected: $0.selected) })
        }
        env.windowEvents.watch(pid: pid)
        let running = inventory.running().first { $0.pid == pid }
        return Resolved(
            session: session, pid: pid, app: Observation.App(pid: Int(pid), bundleId: running?.bundleId, name: running?.name ?? ""),
            worker: worker, info: info, launched: launched, tab: tab
        )
    }

    /// §2.1's match, tabs included, then §27.6's last step: a kept title of exactly one live window. A title a live
    /// window or tab has wins; two live windows that once shared it, or none, fail as the match failed.
    static func resolveKept(_ source: any WindowSource, pid: pid_t, ref: WindowRef?, aliases: inout WindowAliases) throws -> (element: AXUIElement, info: WindowInfo, tab: TabHandle?) {
        let found: (element: AXUIElement, info: WindowInfo, tab: TabHandle?)
        do {
            found = try source.resolveTab(pid: pid, ref: ref)
        } catch {
            guard ref?.id == nil, let title = ref?.title, ComputerService.failure(error, or: .windowNotFound).kind == .windowNotFound else { throw error }
            let live = ((try? source.list(pid: pid)) ?? []).map(\.id)
            aliases.keep(live: live)
            guard let id = aliases.match(title, live: live) else { throw error }
            found = try source.resolveTab(pid: pid, ref: WindowRef(id: id))
        }
        aliases.answered(id: found.info.id, title: found.info.title)
        return found
    }

    /// After a launch: the app's AX window list, polled every 100 ms up to 10 s.
    private func waitForFirstWindow(pid: pid_t, worker: Worker) async throws {
        let source = modules.windows
        let deadline = ContinuousClock.now + env.timing.launchWindow
        while ContinuousClock.now < deadline {
            let count = (try? await worker.run { _ in try source.list(pid: pid).count }) ?? 0
            if count > 0 { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ComputerError(kind: .windowNotFound, message: "The app was launched but showed no window within \(env.timing.launchWindow).", candidates: [])
    }

    // MARK: The wait's inputs

    /// Capture's watch on the window (only with Screen Recording); nil when it is off or never went live.
    func pixelWatch(_ target: Resolved) async -> (any PixelChangeSignal)? {
        guard currentPermissions.screenRecording else { return nil }
        guard let signal = try? await capture.watch(windowID: target.windowID) else { return nil }
        if signal.live { return signal }
        return await signal.waitLive(timeout: .milliseconds(300)) ? signal : nil
    }

    func signature(_ target: Resolved) async throws -> UInt64 {
        try await target.worker.run { state in state.reader?.changes.signature() ?? 0 }
    }

    func waitWatch(_ target: Resolved, pixel: (any PixelChangeSignal)?) async throws -> WaitWatch {
        let change = try await target.worker.run { state in state.reader.map { ChangeBox(signal: $0.changes) } }
        return WaitWatch(worker: target.worker, pid: target.pid, change: change, pixel: pixel)
    }

    // MARK: The observation

    /// The reader's text, the shot when asked or thin, and the shell's own fields (shell §9.1 step 6), as one
    /// transaction per session × pid, stamped once: `seq` and `base` count only what the host gets.
    /// `selectedTab`: the tab this call switched to (§25.4), nil when it switched none.
    func observe(_ target: Resolved, _ knobs: ObserveKnobs, loading: Bool, waited: WaitReport?, selectedTab: String? = nil, cancel: CancelFlag) async throws -> Observation {
        try await target.worker.observing.run {
            try await observeOnce(target, knobs, loading: loading, waited: waited, selectedTab: selectedTab, cancel: cancel)
        }
    }

    private func observeOnce(_ target: Resolved, _ knobs: ObserveKnobs, loading: Bool, waited: WaitReport?, selectedTab: String?, cancel: CancelFlag) async throws -> Observation {
        let screenRecording = currentPermissions.screenRecording
        let maxEdge = knobs.maxEdge ?? ComputerDefaults.Shot.defaultMaxEdge
        let windowID = target.windowID
        // the space first, so the text's geometry and the shot agree: a certain shot's space, else the one
        // coordinates mean now (an auto shot of a thin tree that comes out another size reads again below)
        var space = knobs.screenshot == .always
            ? capture.space(windowID: windowID, frame: target.info.frame, maxEdge: maxEdge)
            : book.space(target.session, window: windowID) ?? capture.space(windowID: windowID, frame: target.info.frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
        var request = ObserveRequest(
            window: WindowRef(id: target.info.id), mode: knobs.mode, element: knobs.element, budgetBytes: knobs.budgetBytes,
            geometry: knobs.geometry ?? (knobs.screenshot == .always), menus: knobs.menus ?? false, space: space,
            loading: loading, noteThin: knobs.screenshot != .never && screenRecording
        )
        request.openedMenus = knobs.openedMenus
        var text = try await read(target, request)
        if cancel.isSet { return try await dropped(target) }

        var shot: Shot?
        var shotError: ComputerError?
        let wantShot = knobs.element == nil && (knobs.screenshot == .always || (knobs.screenshot == .auto && text.stats.thin && screenRecording))
        if wantShot {
            do {
                shot = try await takeShot(target, maxEdge: maxEdge, region: nil, format: nil, action: "observe")
            } catch {
                shotError = ComputerService.failure(error, or: .captureFailed)
            }
        }
        if let shot, shot.width != space.width || shot.height != space.height {
            // the window resized between the read and the shot: read again in the shot's space, whole
            space = CoordinateSpace(width: shot.width, height: shot.height, scale: shot.scale)
            try await resetBase(target)
            request.space = space
            request.mode = .full
            text = try await read(target, request)
        }
        if cancel.isSet { return try await dropped(target) }
        // what coordinates mean from now on is the space this observation states, shot or no shot
        book.setSpace(target.session, window: windowID, space)
        if text.kind != .subtree { book.noteThin(target.session, pid: target.pid, thin: text.stats.thin) }
        let (seq, base) = book.stamp(target.session, pid: target.pid, kind: text.kind)
        return Observation(
            epoch: epoch, session: target.session, app: target.app,
            window: Observation.Window(id: target.info.id, title: text.window.title, frame: text.window.frame),
            kind: text.kind, seq: seq, base: base, text: text.body, space: space, stats: text.stats,
            shot: shot, shotError: shotError, waited: waited,
            // §25.2: the selected tab's page as the reader found it; an element read has none
            page: knobs.element == nil ? text.page : nil, selectedTab: selectedTab
        )
    }

    private func read(_ target: Resolved, _ request: ObserveRequest) async throws -> TextBox {
        let box = RequestBox(request: request)
        return try await target.worker.run { state in
            guard let reader = state.reader else { throw ComputerError(kind: .windowNotFound, message: "The app's reader is gone.") }
            let text = try reader.observe(box.request)
            // §27.6: the title the service answered for this window, which a later ref may still use
            if box.request.element == nil { state.aliases.answered(id: text.window.id, title: text.window.title) }
            return TextBox(text: text, page: reader.lastPage)
        }
    }

    func resetBase(_ target: Resolved) async throws {
        try await target.worker.run { state in state.reader?.resetBase() }
    }

    /// A read the model will never see (a cancel after it): the next auto read is full. The reset runs
    /// inside the observation's transaction, so no later read diffs against the dropped one.
    private func dropped(_ target: Resolved) async throws -> Observation {
        try? await resetBase(target)
        throw Router.cancelledError
    }

    // MARK: Pictures

    /// The one gate every picture path goes through (shell §9.2): Screen Recording off is
    /// `permission_missing`, a minimized window `window_minimized`.
    func captureGuard(_ target: Resolved) async throws {
        guard currentPermissions.screenRecording else {
            pokePermissions()
            throw ComputerError(kind: .permissionMissing, message: "TempCode needs the Screen Recording permission to capture windows.", which: .screenRecording)
        }
        let source = modules.windows
        let pid = target.pid
        let ref = WindowRef(id: target.info.id)
        let minimized = try await target.worker.run { state in
            let (element, info) = try source.resolve(pid: pid, ref: ref)
            state.windows[UInt32(truncatingIfNeeded: info.id)] = element
            return info.minimized
        }
        if minimized {
            throw ComputerError(kind: .windowMinimized, message: "The window is minimized; restore it to capture it.")
        }
    }

    /// A screenshot to the session's next shot file, through the guard.
    func takeShot(_ target: Resolved, maxEdge: Int, region: Region?, format: ShotFormat?, action: String) async throws -> Shot {
        try await captureGuard(target)
        guard let dataDir else { throw ComputerError(kind: .notInitialized, message: "The service has not been initialized.") }
        let stem = try capture.nextStem(dataDir: dataDir, session: target.session, action: action)
        var regionPoints: Rect?
        if let region, region.count == 4 {
            let space = book.space(target.session, window: target.windowID) ?? capture.space(windowID: target.windowID, frame: target.info.frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
            regionPoints = Rect(
                x: Double(region[0]) / space.scale, y: Double(region[1]) / space.scale,
                w: Double(region[2] - region[0]) / space.scale, h: Double(region[3] - region[1]) / space.scale
            )
        }
        return try await capture.screenshot(windowID: target.windowID, maxEdge: maxEdge, regionPoints: regionPoints, format: format, to: stem)
    }
}

/// An `ObserveRequest` handed to the worker (it holds no AX handle).
private struct RequestBox: @unchecked Sendable { let request: ObserveRequest }

/// The reader's answer handed back from the worker, with the page it found (§25.2).
private struct TextBox: @unchecked Sendable {
    let text: ObservationText
    let page: Page?

    var body: String { text.text }
    var kind: ObservationKind { text.kind }
    var stats: ObservationStats { text.stats }
    var window: WindowInfo { text.window }
}
