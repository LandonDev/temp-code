import ComputerProtocol
import Foundation

/// The app a front guard watches: armed by bundle id and bundle path before a cold launch learns its
/// pid, since the app may activate before NSWorkspace's completion; `pid` is bound once known.
public struct WatchedApp: Equatable, Sendable {
    public var bundleId: String?
    public var path: String?
    public var pid: Int32?

    public init(bundleId: String? = nil, path: String? = nil, pid: Int32? = nil) {
        self.bundleId = bundleId
        self.path = path
        self.pid = pid
    }

    /// Its pid once bound; before that, a pid whose bundle id or path matches.
    public func matches(pid: Int32, bundleId: String?, path: String?) -> Bool {
        if let own = self.pid { return own == pid }
        if let bundleId, bundleId == self.bundleId { return true }
        if let path, let own = self.path, Self.samePath(path, own) { return true }
        return false
    }

    static func samePath(_ a: String, _ b: String) -> Bool {
        func trim(_ s: String) -> String { s.hasSuffix("/") ? String(s.dropLast()) : s }
        return trim(a) == trim(b)
    }
}

/// The person's front at one moment: the app, and its focused window when the guard needs it.
public struct FrontRecord: Equatable, Sendable {
    public var pid: Int32
    public var window: UInt32?

    public init(pid: Int32, window: UInt32? = nil) {
        self.pid = pid
        self.window = window
    }
}

/// What the listen-only monitor kept of the person's own input, unmarked events only; times in the
/// guard's milliseconds (docs/computer-protocol.md §23.3).
public struct PersonSignals: Equatable, Sendable {
    /// One mouse down and what was under it.
    public struct Down: Equatable, Sendable {
        public var at: Double
        /// the owner of the window under the point
        public var pid: Int32?
        public var window: UInt32?
        /// the bundle path of the Dock item under the point (its `AXURL`); nil off the Dock or on the Trash
        public var dockItem: String?
        public var menuBar: Bool

        public init(at: Double, pid: Int32? = nil, window: UInt32? = nil, dockItem: String? = nil, menuBar: Bool = false) {
            self.at = at
            self.pid = pid
            self.window = window
            self.dockItem = dockItem
            self.menuBar = menuBar
        }
    }

    public var down: Down?
    /// the last Tab key down with Command held
    public var commandTab: Double?
    /// the last key down with Command or Control held (⌘-N, ⌘-O, ⌘-`)
    public var commandKey: Double?

    public init() {}

    public mutating func key(at: Double, command: Bool, control: Bool, tab: Bool) {
        if command || control { commandKey = at }
        if command && tab { commandTab = at }
    }

    /// The person picked the watched app within `frontChoiceMs` before `at`: a click on one of its
    /// windows or on its own Dock item, or ⌘-Tab.
    public func choseApp(_ watched: WatchedApp, at: Double) -> Bool {
        if let tab = commandTab, Self.within(tab, at) { return true }
        guard let down, Self.within(down.at, at) else { return false }
        if let pid = down.pid, let own = watched.pid, pid == own { return true }
        if let item = down.dockItem, let path = watched.path, WatchedApp.samePath(item, path) { return true }
        return false
    }

    /// The person moved the front app's focus to `window` themselves within `frontChoiceMs` before
    /// `at`: a click on it or on the menu bar, or a key with Command or Control held.
    public func choseWindow(_ window: UInt32, at: Double) -> Bool {
        if let key = commandKey, Self.within(key, at) { return true }
        guard let down, Self.within(down.at, at) else { return false }
        return down.window == window || down.menuBar
    }

    static func within(_ signal: Double, _ at: Double) -> Bool {
        signal <= at && at - signal <= Double(ComputerDefaults.Service.frontChoiceMs)
    }
}

/// Why the guard records and restores nothing for now (decision 11).
public enum FrontPause: Hashable, Sendable {
    /// the Mac-wide `session.lock` is held by some process
    case lock
    /// a request of this service whose `tiers` include `session`, through the restore after it
    case request
}

/// What the guard hears.
public enum FrontEvent: Equatable, Sendable {
    /// NSWorkspace's activation notice
    case activated(pid: Int32, bundleId: String?, path: String?, at: Double)
    /// the watched app's pid, from the launch's completion
    case bound(Int32)
    case personDown(PersonSignals.Down)
    case personKey(at: Double, command: Bool, control: Bool, tab: Bool)
    /// the front app's focused window moved; `recordedOpen` false when the recorded window is gone
    case focusChanged(pid: Int32, window: UInt32, recordedOpen: Bool, at: Double)
    /// a window of the watched app was ordered above the person's focused window, no activation
    case orderedAbove(at: Double)
    /// the decided restore started, the lock held; until then a restore waits for the next tick
    case restoreStarted(at: Double)
    /// a sample while a restore runs, every 20 ms
    case sample(front: Int32?, window: UInt32?, above: Bool, at: Double)
    case quit(Int32)
    case paused(FrontPause, at: Double)
    /// `front` is the front read again; nil keeps the record
    case resumed(FrontPause, front: FrontRecord?, at: Double)
    /// the watch now ends at this time (an action's closing wait plus a second)
    case endBy(Double)
    /// the 100 ms tick
    case tick(at: Double)
}

/// What the live side does next.
public enum FrontDecision: Equatable, Sendable {
    case none
    /// AXFrontmost on the person's app, holding `session.lock`; `.restoreStarted` once done
    case restore(Int32)
    /// AXRaise and AXMain on the recorded window of the front app
    case raiseWindow(pid: Int32, window: UInt32)
    /// AXRaise on the person's focused window, read fresh
    case raiseFocusedWindow(Int32)
    /// the record moved to this app
    case follow(Int32)
    /// the person chose the watched app; the watch is over
    case giveWay
    /// the watched app took the front a third time: hide it; the watch is over
    case hide(Int32)
    /// the watch is over
    case end
}

/// The front guard of one launch, open or act (docs/computer-protocol.md §23.3): a value with no clock
/// and no AppKit, fed events with their times. It records the person's front, takes an activation of
/// the watched app that the person did not choose for a steal and undoes it, gives way to the person's
/// own pick, hides the app at its third steal and pauses for session-tier work.
public struct FrontGuard: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        /// a steal decided and its undo not started (the lock was busy, or a pause holds it)
        case pending(Undo, stealAt: Double)
        case restoring(Undo, stealAt: Double, startedAt: Double)
        case ended
    }

    /// How a steal is undone.
    public enum Undo: Equatable, Sendable {
        case app(Int32)
        case window(pid: Int32, window: UInt32)
        case order(Int32)

        var isWindow: Bool { if case .window = self { true } else { false } }
    }

    public private(set) var watched: WatchedApp
    /// nil while the recorded app has quit and no other came forward yet
    public private(set) var recorded: FrontRecord?
    public private(set) var phase: Phase = .idle
    public private(set) var signals = PersonSignals()
    public private(set) var steals = 0
    /// bumped each time a steal ends one way or another, or the person chooses; the live side tells a
    /// change after the result went out as `apps/frontRestored`
    public private(set) var outcomes = 0
    public private(set) var restored: FrontRestore?
    public private(set) var ms: Int?
    public private(set) var endsAt: Double
    public private(set) var pauses: Set<FrontPause> = []
    /// the watched app activated during a pause and was still front at its end
    private var stolenWhilePaused: Double?
    /// this steal's undo already raised the person's window: a window undo starts with that raise, and an app
    /// restore that brought the app back on another window raises it once
    private var windowRaised = false

    public init(recorded: FrontRecord?, watched: WatchedApp, at: Double, watchMs: Int = ComputerDefaults.Service.frontWatchMs) {
        self.recorded = recorded
        self.watched = watched
        self.endsAt = at + Double(watchMs)
    }

    /// `{ raised, restored?, ms? }` so far: raised once the app came forward, by a steal or the person's pick.
    public var report: FrontReport {
        FrontReport(raised: steals > 0 || restored == .personChose, restored: restored, ms: ms)
    }

    public var isOver: Bool { phase == .ended }
    public var isPaused: Bool { !pauses.isEmpty }

    /// The window rule applies: the watched app is the person's own front app.
    public var sameApp: Bool {
        guard let recorded, let pid = watched.pid else { return false }
        return recorded.pid == pid
    }

    public mutating func handle(_ event: FrontEvent) -> FrontDecision {
        guard phase != .ended else { return .none }
        switch event {
        case .bound(let pid):
            watched.pid = pid
            return .none
        case .personDown(let down):
            signals.down = down
            return lateChoice(at: down.at)
        case .personKey(let at, let command, let control, let tab):
            signals.key(at: at, command: command, control: control, tab: tab)
            return lateChoice(at: at)
        case .activated(let pid, let bundleId, let path, let at):
            return activated(pid: pid, bundleId: bundleId, path: path, at: at)
        case .focusChanged(let pid, let window, let recordedOpen, let at):
            return focusChanged(pid: pid, window: window, recordedOpen: recordedOpen, at: at)
        case .orderedAbove(let at):
            guard !isPaused, phase == .idle, !sameApp, let recorded, watched.pid != nil else { return .none }
            if let down = signals.down, PersonSignals.within(down.at, at), down.pid == watched.pid { return chose() }
            return steal(.order(recorded.pid), at: at)
        case .restoreStarted(let at):
            guard case .pending(let undo, let stealAt) = phase else { return .none }
            phase = .restoring(undo, stealAt: stealAt, startedAt: at)
            return .none
        case .sample(let front, let window, let above, let at):
            return sample(front: front, window: window, above: above, at: at)
        case .quit(let pid):
            if pid == watched.pid { return end() }
            guard pid == recorded?.pid else { return .none }
            recorded = nil
            if case .pending = phase { settle(.failed, ms: nil) }
            if case .restoring = phase { settle(.failed, ms: nil) }
            return .none
        case .paused(let reason, _):
            if !isPaused { stolenWhilePaused = nil }
            pauses.insert(reason)
            return .none
        case .resumed(let reason, let front, _):
            pauses.remove(reason)
            if let front {
                // a session step moved the front and its restore put back what it could: the front read again is the record
                recorded = front
                stolenWhilePaused = nil
                if case .pending = phase { phase = .idle }
            }
            guard !isPaused else { return .none }
            if let at = stolenWhilePaused, phase == .idle, let recorded, !sameApp {
                stolenWhilePaused = nil
                return steal(.app(recorded.pid), at: at, now: false)
            }
            stolenWhilePaused = nil
            return .none
        case .endBy(let at):
            endsAt = at
            return .none
        case .tick(let at):
            return tick(at: at)
        }
    }

    // MARK: Activations

    private mutating func activated(pid: Int32, bundleId: String?, path: String?, at: Double) -> FrontDecision {
        let isWatched = watched.matches(pid: pid, bundleId: bundleId, path: path)
        if isWatched, watched.pid == nil { watched.pid = pid }
        if isPaused {
            // the guard records nothing; it remembers only whether the watched app ended up in front
            stolenWhilePaused = isWatched && !sameApp && !signals.choseApp(watched, at: at) ? at : nil
            return .none
        }
        switch phase {
        case .restoring(let undo, let stealAt, _), .pending(let undo, let stealAt):
            if pid == recorded?.pid {
                // its own restore, told by NSWorkspace after it ran; with the person's window recorded the
                // restore is over once a sample shows that window focused, since an app may come back on another
                if case .app = undo { return appBack(stealAt: stealAt, at: at) }
                return .none
            }
            if isWatched, let recorded { return steal(.app(recorded.pid), at: at) }
            // a third app: the person switched; the restore ends and that app is the record
            if case .restoring = phase { settle(.restored, ms: at - stealAt) } else { phase = .idle }
            recorded = FrontRecord(pid: pid)
            return .follow(pid)
        case .idle:
            if isWatched {
                if sameApp { return .none }
                if signals.choseApp(watched, at: at) { return chose() }
                guard let recorded else {
                    steals += 1
                    settle(.failed, ms: nil)
                    return .none
                }
                return steal(.app(recorded.pid), at: at)
            }
            guard pid != recorded?.pid else { return .none }
            recorded = FrontRecord(pid: pid)
            return .follow(pid)
        case .ended:
            return .none
        }
    }

    /// The window rule: while the watched app is the person's front app, a focus change they did not make is put back.
    private mutating func focusChanged(pid: Int32, window: UInt32, recordedOpen: Bool, at: Double) -> FrontDecision {
        guard !isPaused, sameApp, let recorded, pid == recorded.pid else { return .none }
        if case .restoring(.window(_, let own), let stealAt, _) = phase, own == window {
            settle(.restored, ms: at - stealAt)
            return .none
        }
        guard recorded.window != window else { return .none }
        guard recordedOpen, let own = recorded.window, !signals.choseWindow(window, at: at) else {
            // the person's own move, or a window that closed under them: the new one is the record
            self.recorded = FrontRecord(pid: pid, window: window)
            if case .pending = phase { phase = .idle }
            return .none
        }
        return steal(.window(pid: pid, window: own), at: at)
    }

    // MARK: Steals

    /// One steal: the third in a watch hides the app, unless it is the person's own front app (the window rule).
    private mutating func steal(_ undo: Undo, at: Double, now decide: Bool = true) -> FrontDecision {
        steals += 1
        if steals >= ComputerDefaults.Service.frontStealsMax, !sameApp, let pid = watched.pid {
            settle(.hidApp, ms: nil)
            phase = .ended
            return .hide(pid)
        }
        phase = .pending(undo, stealAt: at)
        windowRaised = undo.isWindow
        return decide ? decision(undo) : .none
    }

    private func decision(_ undo: Undo) -> FrontDecision {
        switch undo {
        case .app(let pid): .restore(pid)
        case .window(let pid, let window): .raiseWindow(pid: pid, window: window)
        case .order(let pid): .raiseFocusedWindow(pid)
        }
    }

    /// The person's own pick: the guard stands aside and stops watching.
    private mutating func chose() -> FrontDecision {
        settle(.personChose, ms: nil)
        phase = .ended
        return .giveWay
    }

    /// A pick whose event reached the guard after the activation, while its undo still waits.
    private mutating func lateChoice(at: Double) -> FrontDecision {
        guard case .pending(.app, let stealAt) = phase, at <= stealAt, signals.choseApp(watched, at: stealAt) else { return .none }
        steals -= 1
        return chose()
    }

    private mutating func settle(_ outcome: FrontRestore, ms: Double?) {
        restored = outcome
        self.ms = ms.map { Int(max(0, $0).rounded()) }
        outcomes += 1
        if phase != .ended { phase = .idle }
    }

    private mutating func end() -> FrontDecision {
        if case .pending = phase { settle(.failed, ms: nil) }
        if case .restoring = phase { settle(.failed, ms: nil) }
        phase = .ended
        return .end
    }

    // MARK: Time

    /// The person's app is front again after an app restore: restored when no window of theirs was recorded,
    /// else the restore goes on as their window's, confirmed by the next sample.
    private mutating func appBack(stealAt: Double, at: Double) -> FrontDecision {
        guard case .restoring(.app(let person), _, let startedAt) = phase, let own = recorded?.window, recorded?.pid == person else {
            settle(.restored, ms: at - stealAt)
            return .none
        }
        phase = .restoring(.window(pid: person, window: own), stealAt: stealAt, startedAt: startedAt)
        return .none
    }

    private mutating func sample(front: Int32?, window: UInt32?, above: Bool, at: Double) -> FrontDecision {
        guard case .restoring(let undo, let stealAt, let startedAt) = phase else { return .none }
        if case .app(let person) = undo, front == person, recorded?.window != nil {
            _ = appBack(stealAt: stealAt, at: at)
            return sample(front: front, window: window, above: above, at: at)
        }
        let back: Bool = switch undo {
        case .app(let person): front == person
        // an unreadable focus (nil) is the app's own to keep: nothing says the window moved
        case .window(let pid, let own): front == pid && (window == own || window == nil)
        case .order: !above
        }
        if !back, case .window(let pid, let own) = undo, front == pid, !windowRaised {
            // the app came back on another window: the person's own is raised once, inside the same bound
            windowRaised = true
            return .raiseWindow(pid: pid, window: own)
        }
        if back {
            settle(.restored, ms: at - stealAt)
        } else if at - startedAt > Double(ComputerDefaults.Service.frontRestoreMs) {
            settle(.failed, ms: nil)
        }
        return .none
    }

    private mutating func tick(at: Double) -> FrontDecision {
        if case .restoring(_, _, let startedAt) = phase, at - startedAt > Double(ComputerDefaults.Service.frontRestoreMs) {
            settle(.failed, ms: nil)
        }
        if at >= endsAt {
            if case .restoring = phase { return .none }
            return end()
        }
        guard !isPaused, case .pending(let undo, _) = phase else { return .none }
        return decision(undo)
    }
}

/// The session-request half of the pause (decision 11), kept apart from any one watch: from the start of
/// each request whose `tiers` include `session` until it answers; when a step ran at `session` (or the
/// call was cut short, which the host also restores after), until the next `input.restoreSession`
/// answers or `restoreWaitMs` later. Its lift says whether the front is read again.
public struct SessionPause: Equatable, Sendable {
    /// how long a pause waits for the host's restore after a session step (docs/computer-protocol.md §20.3)
    public static let restoreWaitMs: Double = 5_000

    public enum Lift: Equatable, Sendable {
        /// no step ran at `session`: the guard keeps its record
        case keep
        /// a step moved the front: the guard reads it again
        case reread
    }

    public private(set) var requests = 0
    public private(set) var restoreBy: Double?
    private var stepRan = false

    public init() {}

    public var on: Bool { requests > 0 || restoreBy != nil }

    /// A session-allowed request started; true when this starts the pause.
    public mutating func begin() -> Bool {
        requests += 1
        return requests == 1 && restoreBy == nil
    }

    /// That request answered; `sessionStep` when a step of it ran at `session` or it was cut short.
    public mutating func answered(sessionStep: Bool, at: Double) -> Lift? {
        requests = max(0, requests - 1)
        if sessionStep {
            stepRan = true
            restoreBy = at + Self.restoreWaitMs
        }
        return lift()
    }

    /// `input.restoreSession` answered.
    public mutating func restoreAnswered() -> Lift? {
        guard restoreBy != nil else { return nil }
        restoreBy = nil
        return lift()
    }

    public mutating func tick(at: Double) -> Lift? {
        guard let by = restoreBy, at >= by else { return nil }
        restoreBy = nil
        return lift()
    }

    private mutating func lift() -> Lift? {
        guard !on else { return nil }
        defer { stepRan = false }
        return stepRan ? .reread : .keep
    }

    /// Whether any step of a call ran at `session`: an ok step or a failed one that carries a `SessionChange`.
    public static func ranAtSession(_ steps: [StepResult]) -> Bool {
        steps.contains { step in
            switch step {
            case .ok(let ok): ok.session != nil
            case .failed(let failed): failed.error.session != nil
            default: false
            }
        }
    }
}
