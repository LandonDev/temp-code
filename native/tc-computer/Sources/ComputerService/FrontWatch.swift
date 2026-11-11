import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import CoreGraphics
import Foundation
import Input
import UniformTypeIdentifiers

/// The front guard's live half (docs/computer-protocol.md §23.3): one `FrontGuard` per watched launch, open
/// or act, fed from the app events `apps/changed` already reads, the window events' focus changes, the
/// person's clicks and keys, a 100 ms tick and a 20 ms poll while a restore runs. It applies the guards'
/// decisions holding `session.lock`, taken without waiting, and tells a steal after its call's result went
/// out as `apps/frontRestored`. All its state lives on one serial queue.
final class FrontWatch: Stoppable, @unchecked Sendable {
    /// One watch, as its caller holds it.
    final class Watch: @unchecked Sendable {
        fileprivate let id: Int
        fileprivate weak var owner: FrontWatch?

        fileprivate init(id: Int, owner: FrontWatch) {
            self.id = id
            self.owner = owner
        }

        /// The launch's completion named the pid.
        func bind(_ pid: Int32) { owner?.event(id, .bound(pid)) }

        /// The report as the result goes out; a later outcome is told as `apps/frontRestored`.
        func answer() -> FrontReport { owner?.answer(id) ?? FrontReport(raised: false) }

        /// For a launch whose result carries no report (a call's own `launch`): every outcome, one already
        /// settled too, is told as `apps/frontRestored`.
        func tellByNotice() { owner?.tellByNotice(id) }

        /// The watch ends `tail` from now.
        func end(in tail: Duration) { owner?.end(id, in: tail) }
    }

    private struct Entry {
        var state: FrontGuard
        let session: String?
        let name: String
        /// when the call's result went out; nil until then
        var answeredAt: Double?
        /// the outcomes the result or a notification already told
        var told = 0
        /// the watched app's window was above the person's at the last tick
        var above = false
        /// a hide the lock has not let through yet
        var hiding: Int32?
    }

    private let source: any FrontSource
    private let locks: MacLocks
    private let windows: any WindowSource
    private let windowEvents: any WindowEventSource
    private let timing: ServiceTiming
    private let notify: @Sendable (AppsFrontRestoredNotification.Params) -> Void
    private let queue = DispatchQueue(label: "tc-computer.front")
    private var entries: [Int: Entry] = [:]
    private var nextID = 0
    private var pause = SessionPause()
    private var lockPaused = false
    private var timer: DispatchSourceTimer?
    private var polling = false
    private var stopped = false

    init(source: any FrontSource, locks: MacLocks, windows: any WindowSource, windowEvents: any WindowEventSource, timing: ServiceTiming,
         notify: @escaping @Sendable (AppsFrontRestoredNotification.Params) -> Void) {
        self.source = source
        self.locks = locks
        self.windows = windows
        self.windowEvents = windowEvents
        self.timing = timing
        self.notify = notify
    }

    /// What `apps.launch` checks of an item before it opens.
    func fileFacts(_ path: String) -> FileFacts? { source.fileFacts(path: path) }

    /// Records the person's front now and starts watching `watched`. A newer watch of the same app ends
    /// the older one: the newest record wins.
    func begin(_ watched: WatchedApp, session: String?, name: String) -> Watch {
        queue.sync {
            let now = source.now()
            let record = source.frontmost().map { FrontRecord(pid: $0, window: $0 == watched.pid ? source.focusedWindow(pid: $0) : nil) }
            for (id, entry) in entries where !entry.state.isOver && FrontWatch.same(entry.state.watched, watched) {
                handle(id, .endBy(now))
                handle(id, .tick(at: now))
            }
            var state = FrontGuard(recorded: record, watched: watched, at: now)
            if pause.on { _ = state.handle(.paused(.request, at: now)) }
            if lockPaused { _ = state.handle(.paused(.lock, at: now)) }
            var entry = Entry(state: state, session: session, name: name)
            if let pid = watched.pid, let record {
                if record.pid == pid {
                    // the window rule needs the app's focus changes
                    windowEvents.watch(pid: pid)
                } else {
                    entry.above = source.orderedAbove(pid: pid, over: record.pid)
                }
            }
            nextID += 1
            entries[nextID] = entry
            start()
            return Watch(id: nextID, owner: self)
        }
    }

    // MARK: What the guards hear

    /// From `apps/changed`'s feed: an activation reaches the guards after the choice grace, stamped when it came.
    func appEvent(_ event: AppEvent) {
        switch event.change {
        case .activated:
            let at = source.now()
            queue.asyncAfter(deadline: .now() + timing.frontChoiceGrace.timeInterval) { [self] in
                handleAll(.activated(pid: event.pid, bundleId: event.bundleId, path: event.path, at: at))
            }
        case .terminated:
            queue.async { [self] in handleAll(.quit(event.pid)) }
        default:
            break
        }
    }

    /// From `window/changed`'s feed: a focus change of an app a guard holds to the window rule.
    func windowEvent(_ event: WindowEvent) {
        guard event.change == .focused else { return }
        let at = source.now()
        queue.async { [self] in
            for id in entries.keys.sorted() {
                guard let state = entries[id]?.state, state.sameApp, let recorded = state.recorded, recorded.pid == event.pid else { continue }
                let open = recorded.window.map { own in
                    (try? windows.list(pid: event.pid)).map { list in list.contains { UInt32(truncatingIfNeeded: $0.id) == own } } ?? true
                } ?? true
                handle(id, .focusChanged(pid: event.pid, window: event.windowID, recordedOpen: open, at: at))
            }
        }
    }

    /// A request whose `tiers` include `session` started: nothing is recorded or restored until it answers.
    func requestStarted() {
        queue.sync {
            if pause.begin() { handleAll(.paused(.request, at: source.now())) }
            start()
        }
    }

    /// That request answered; `sessionStep` holds the pause until the host's restore answers, or 5 s.
    func requestAnswered(sessionStep: Bool) {
        queue.sync {
            if let lift = pause.answered(sessionStep: sessionStep, at: source.now()) { self.lift(lift) }
        }
    }

    /// `input.restoreSession` answered.
    func restoreAnswered() {
        queue.sync {
            if let lift = pause.restoreAnswered() { self.lift(lift) }
        }
    }

    func stop() {
        queue.sync {
            stopped = true
            entries.removeAll()
            stopIfIdle()
        }
    }

    // MARK: The watch's handle

    fileprivate func event(_ id: Int, _ event: FrontEvent) {
        queue.sync { handle(id, event) }
    }

    fileprivate func answer(_ id: Int) -> FrontReport {
        queue.sync {
            guard var entry = entries[id] else { return FrontReport(raised: false) }
            entry.answeredAt = source.now()
            entry.told = entry.state.outcomes
            entries[id] = entry
            let report = entry.state.report
            sweep()
            return report
        }
    }

    fileprivate func tellByNotice(_ id: Int) {
        queue.sync {
            entries[id]?.answeredAt = source.now()
            tell(id)
            sweep()
        }
    }

    fileprivate func end(_ id: Int, in tail: Duration) {
        queue.sync { handle(id, .endBy(source.now() + tail.timeInterval * 1_000)) }
    }

    // MARK: On the queue

    private func handle(_ id: Int, _ event: FrontEvent, lease: MacLockLease? = nil) {
        guard var entry = entries[id] else { return }
        let decision = entry.state.handle(event)
        entries[id] = entry
        apply(decision, id, lease: lease)
        tell(id)
    }

    private func handleAll(_ event: FrontEvent, lease: MacLockLease? = nil) {
        for id in entries.keys.sorted() { handle(id, event, lease: lease) }
        sweep()
    }

    private func apply(_ decision: FrontDecision, _ id: Int, lease: MacLockLease?) {
        switch decision {
        case .none, .follow, .giveWay, .end:
            break
        case .restore(let pid):
            change(id, lease) { $0.setFrontmost(pid: pid) }
        case .raiseWindow(let pid, let window):
            change(id, lease) { $0.raise(pid: pid, window: window) }
        case .raiseFocusedWindow(let pid):
            change(id, lease) { $0.raise(pid: pid, window: nil) }
        case .hide(let pid):
            entries[id]?.hiding = pid
            hide(id, lease)
        }
    }

    /// One front change, holding `session.lock`; a miss pauses every guard for the lock, and the tick that
    /// finds it free again tries the change again.
    private func change(_ id: Int, _ lease: MacLockLease?, _ body: (any FrontSource) -> Bool) {
        guard let held = lease ?? locks.acquire(.session, timeout: .zero) else {
            lockBusy()
            return
        }
        defer { if lease == nil { held.release() } }
        _ = body(source)
        handle(id, .restoreStarted(at: source.now()), lease: held)
        poll(after: timing.frontPoll)
    }

    private func hide(_ id: Int, _ lease: MacLockLease?) {
        guard let pid = entries[id]?.hiding else { return }
        guard let held = lease ?? locks.acquire(.session, timeout: .zero) else {
            lockBusy()
            return
        }
        defer { if lease == nil { held.release() } }
        source.hide(pid: pid)
        entries[id]?.hiding = nil
    }

    private func lockBusy() {
        guard !lockPaused else { return }
        lockPaused = true
        handleAll(.paused(.lock, at: source.now()))
    }

    private func lift(_ lift: SessionPause.Lift) {
        let now = source.now()
        let front = lift == .reread ? source.frontmost() : nil
        for id in entries.keys.sorted() {
            let watched = entries[id]?.state.watched.pid
            let record = front.map { FrontRecord(pid: $0, window: $0 == watched ? source.focusedWindow(pid: $0) : nil) }
            handle(id, .resumed(.request, front: record, at: now))
        }
        sweep()
    }

    /// Tells a guard's new outcome once its call's result went out.
    private func tell(_ id: Int) {
        guard let entry = entries[id], let at = entry.answeredAt, entry.state.outcomes > entry.told else { return }
        entries[id]?.told = entry.state.outcomes
        notify(AppsFrontRestoredNotification.Params(
            session: entry.session, pid: Int(entry.state.watched.pid ?? 0), name: entry.name, front: entry.state.report,
            afterMs: Int(max(0, source.now() - at))
        ))
    }

    /// The window order, the lock, the pause's bound and each watch's end, every `frontTick`.
    private func tick() {
        let now = source.now()
        if let lift = pause.tick(at: now) { self.lift(lift) }
        let lease = locks.acquire(.session, timeout: .zero)
        defer { lease?.release() }
        if lease == nil {
            lockBusy()
        } else if lockPaused {
            lockPaused = false
            handleAll(.resumed(.lock, front: nil, at: now), lease: lease)
        }
        for id in entries.keys.sorted() {
            guard let entry = entries[id] else { continue }
            if entry.hiding != nil { hide(id, lease) }
            let state = entry.state
            if !state.isOver, !state.isPaused, state.phase == .idle, !state.sameApp, let recorded = state.recorded, let pid = state.watched.pid {
                let above = source.orderedAbove(pid: pid, over: recorded.pid)
                entries[id]?.above = above
                if above && !entry.above { handle(id, .orderedAbove(at: now), lease: lease) }
            }
            handle(id, .tick(at: now), lease: lease)
        }
        sweep()
    }

    /// While a restore runs: the front, and what its undo waits for, every `frontPoll`.
    private func poll(after delay: Duration) {
        guard !polling else { return }
        polling = true
        queue.asyncAfter(deadline: .now() + delay.timeInterval) { [self] in
            polling = false
            let now = source.now()
            for id in entries.keys.sorted() {
                guard let state = entries[id]?.state, case .restoring(let undo, _, _) = state.phase else { continue }
                var window: UInt32?
                var above = false
                switch undo {
                case .app: break
                case .window(let pid, _): window = source.focusedWindow(pid: pid)
                case .order(let person): above = state.watched.pid.map { source.orderedAbove(pid: $0, over: person) } ?? false
                }
                handle(id, .sample(front: source.frontmost(), window: window, above: above, at: now))
            }
            if entries.values.contains(where: { if case .restoring = $0.state.phase { true } else { false } }) { poll(after: timing.frontPoll) }
            sweep()
        }
    }

    /// Drops a watch once it is over, its result went out and nothing waits on it.
    private func sweep() {
        for (id, entry) in entries where entry.state.isOver && entry.answeredAt != nil && entry.hiding == nil {
            entries[id] = nil
        }
        stopIfIdle()
    }

    /// The monitor and the tick run while any watch or pause does.
    private func start() {
        guard !stopped, timer == nil else { return }
        source.startSignals { [weak self] event in
            guard let self else { return }
            queue.async { self.handleAll(event) }
        }
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now() + timing.frontTick.timeInterval, repeating: timing.frontTick.timeInterval)
        next.setEventHandler { [weak self] in self?.tick() }
        next.resume()
        timer = next
    }

    private func stopIfIdle() {
        guard entries.isEmpty, !pause.on || stopped, let running = timer else { return }
        running.cancel()
        timer = nil
        source.stopSignals()
    }

    static func same(_ a: WatchedApp, _ b: WatchedApp) -> Bool {
        if let pa = a.pid, let pb = b.pid { return pa == pb }
        if let ba = a.bundleId, ba == b.bundleId { return true }
        if let pa = a.path, pa == b.path { return true }
        return false
    }
}

/// One `action.run` or `action.batch` under the front guard (§23.4): watched on its target from after the
/// target resolves until `frontActionTail` after its closing wait, unless an action raises by design; a call
/// whose `tiers` include `session` pauses every guard from its start (decision 11).
final class FrontRun: @unchecked Sendable {
    /// Actions that bring their app forward by design, so a call holding one is not watched: an action
    /// name, with the `perform` names that raise (nil: every one). A window action that raises joins here.
    static let raisingActions: [ComputerActionName: Set<String>?] = [
        .perform: ["raise", "AXRaise"]
    ]

    static func raises(_ action: ComputerAction) -> Bool {
        guard let entry = raisingActions[action.action] else { return false }
        guard let names = entry else { return true }
        return names.contains(action.name ?? "")
    }

    private let front: FrontWatch
    private let watched: Bool
    private let pausing: Bool
    private let tail: Duration
    private let lock = NSLock()
    private var watch: FrontWatch.Watch?
    private var closed = false

    init(_ front: FrontWatch, actions: [ComputerAction], tiers: [Tier], tail: Duration) {
        self.front = front
        self.tail = tail
        watched = !actions.contains(where: FrontRun.raises)
        // §23.4, §26.2: a step that may bring the app forward on purpose pauses the guard
        pausing = tiers.contains(.session) || tiers.contains(.front)
        if pausing { front.requestStarted() }
    }

    /// The target resolved: its app is watched.
    func watch(_ target: Resolved) {
        guard watched else { return }
        let begun = front.begin(WatchedApp(bundleId: target.app.bundleId, pid: target.pid), session: target.session, name: target.app.name)
        lock.withLock { watch = begun }
    }

    /// The closing wait is over: the watch runs on for the tail.
    func closing() {
        let current: FrontWatch.Watch? = lock.withLock {
            defer { closed = true }
            return closed ? nil : watch
        }
        current?.end(in: tail)
    }

    /// The result is known (nil: the call threw): the report when the app came forward, and the pause
    /// lifted, or held for the host's restore after a step at `session` or a call cut short.
    func answered(_ result: BatchResult?, cancelled: Bool) -> FrontReport? {
        closing()
        let report = lock.withLock { watch }?.answer()
        if pausing {
            front.requestAnswered(sessionStep: cancelled || (result.map { SessionPause.ranAtSession($0.steps) } ?? false))
        }
        return report?.raised == true ? report : nil
    }
}

extension BatchResult {
    /// The same result with the guard's report.
    func with(front: FrontReport?) -> BatchResult {
        BatchResult(steps: steps, observation: observation, observationError: observationError, waited: waited, front: front, menusLeftOpen: menusLeftOpen)
    }
}

// MARK: The Mac

/// The binary's `FrontSource`: NSWorkspace, AX on the apps, the window list and a listen-only monitor.
final class LiveFrontSource: FrontSource, @unchecked Sendable {
    /// the Tab key's virtual keycode
    static let tabKeycode: UInt16 = 48
    private let windows: any WindowSource
    private nonisolated(unsafe) var monitor: Any?
    /// the Dock's AX hit runs here, off the main thread the monitor calls back on
    private let hits = DispatchQueue(label: "tc-computer.front-hits")

    init(windows: any WindowSource) {
        self.windows = windows
    }

    func now() -> Double { ProcessInfo.processInfo.systemUptime * 1_000 }

    func frontmost() -> Int32? {
        onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    }

    func focusedWindow(pid: Int32) -> UInt32? {
        LiveFrontSource.focusedWindowElement(pid).flatMap { windows.windowID(of: $0, pid: pid) }
    }

    func setFrontmost(pid: Int32) -> Bool {
        AXUIElementSetAttributeValue(LiveFrontSource.app(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success
    }

    func raise(pid: Int32, window: UInt32?) -> Bool {
        let element = window.map { id in windowElement(pid, id: id) } ?? LiveFrontSource.focusedWindowElement(pid)
        guard let element else { return false }
        let raised = AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        return raised
    }

    func orderedAbove(pid: Int32, over: Int32) -> Bool {
        guard let target = focusedWindow(pid: over) else { return false }
        // front to back: a window of `pid` before the person's focused window that overlaps it
        var mine: [CGRect] = []
        for info in LiveFrontSource.onScreen() where (info[kCGWindowLayer as String] as? Int) == 0 {
            guard let bounds = LiveFrontSource.bounds(info) else { continue }
            if (info[kCGWindowNumber as String] as? Int).map({ UInt32(truncatingIfNeeded: $0) }) == target {
                return mine.contains { $0.intersects(bounds) }
            }
            if (info[kCGWindowOwnerPID as String] as? Int).map({ Int32(truncatingIfNeeded: $0) }) == pid { mine.append(bounds) }
        }
        return false
    }

    func hide(pid: Int32) -> Bool {
        onMain { NSRunningApplication(processIdentifier: pid)?.hide() ?? false }
    }

    func startSignals(_ handler: @escaping @Sendable (FrontEvent) -> Void) {
        let hits = self.hits
        onMain { [self] in
            guard monitor == nil else { return }
            monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { event in
                // our own posted events carry the mark; only the person's count
                guard let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) != TC_EVENT_MARK else { return }
                let at = event.timestamp * 1_000
                if event.type == .keyDown {
                    let flags = event.modifierFlags
                    handler(.personKey(at: at, command: flags.contains(.command), control: flags.contains(.control), tab: event.keyCode == LiveFrontSource.tabKeycode))
                    return
                }
                let point = cg.location
                hits.async { handler(.personDown(LiveFrontSource.down(at: at, point: point))) }
            }
        }
    }

    func stopSignals() {
        onMain { [self] in
            if let running = monitor { NSEvent.removeMonitor(running) }
            monitor = nil
        }
    }

    func fileFacts(path: String) -> FileFacts? {
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &directory) else { return nil }
        let isDirectory = directory.boolValue
        let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isPackageKey, .contentTypeKey])
        let bundle = isDirectory ? Bundle(path: path) : nil
        let isBundle = isDirectory && ((values?.isPackage ?? false) || bundle?.bundleIdentifier != nil)
        let mode = ((try? FileManager.default.attributesOfItem(atPath: path))?[.posixPermissions] as? NSNumber)?.intValue ?? 0
        let conforms = values?.contentType.map { $0.conforms(to: .executable) || $0.conforms(to: .script) || $0.conforms(to: .application) } ?? false
        return FileFacts(
            exists: true, isDirectory: isDirectory, isBundle: isBundle, hasExecutable: isBundle && bundle?.executableURL != nil,
            executeBit: !isDirectory && mode & 0o111 != 0, conformsToExecutable: conforms
        )
    }

    // MARK: Helpers

    /// The app's element with a short messaging timeout, so a hung app cannot hold the guard's queue.
    static func app(_ pid: Int32) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.5)
        return element
    }

    static func focusedWindowElement(_ pid: Int32) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app(pid), kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func windowElement(_ pid: Int32, id: UInt32) -> AXUIElement? {
        var list: CFTypeRef?
        guard AXUIElementCopyAttributeValue(LiveFrontSource.app(pid), kAXWindowsAttribute as CFString, &list) == .success,
              let elements = list as? [AXUIElement] else { return nil }
        return elements.first { windows.windowID(of: $0, pid: pid) == id }
    }

    static func onScreen() -> [[String: Any]] {
        (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    }

    static func bounds(_ info: [String: Any]) -> CGRect? {
        guard let dictionary = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
    }

    /// What was under a mouse down: the menu bar, a Dock item's bundle path, or a window and its owner.
    static func down(at: Double, point: CGPoint) -> PersonSignals.Down {
        let menuLevels = [Int(CGWindowLevelForKey(.mainMenuWindow)), Int(CGWindowLevelForKey(.statusWindow))]
        for info in onScreen() {
            guard let bounds = bounds(info), bounds.contains(point), (info[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            let owner = (info[kCGWindowOwnerPID as String] as? Int).map { Int32(truncatingIfNeeded: $0) }
            let id = (info[kCGWindowNumber as String] as? Int).map { UInt32(truncatingIfNeeded: $0) }
            if menuLevels.contains(layer) { return PersonSignals.Down(at: at, pid: owner, menuBar: true) }
            if let owner, NSRunningApplication(processIdentifier: owner)?.bundleIdentifier == "com.apple.dock" {
                return PersonSignals.Down(at: at, pid: owner, dockItem: dockItem(at: point))
            }
            return PersonSignals.Down(at: at, pid: owner, window: id)
        }
        return PersonSignals.Down(at: at)
    }

    /// The Dock item's `AXURL` at the point, as a path; nil off an item.
    static func dockItem(at point: CGPoint) -> String? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.5)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success, let element else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXURLAttribute as CFString, &value) == .success, let value else { return nil }
        if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).path }
        return (value as? String).flatMap { URL(string: $0)?.path }
    }
}
