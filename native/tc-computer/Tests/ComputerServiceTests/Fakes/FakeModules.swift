import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
@testable import ComputerService
import ComputerServiceKit
import Foundation

/// What every fake did, in order, so a test can check the sequence across modules.
final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func add(_ entry: String) { lock.withLock { entries.append(entry) } }
    var all: [String] { lock.withLock { entries } }
    func count(_ prefix: String) -> Int { all.filter { $0.hasPrefix(prefix) }.count }
    func index(_ prefix: String) -> Int? { all.firstIndex { $0.hasPrefix(prefix) } }
}

func window(_ id: Int, _ title: String, minimized: Bool = false) -> WindowInfo {
    WindowInfo(id: id, title: title, frame: Rect(x: 100, y: 50, w: 800, h: 600), main: true, focused: true, minimized: minimized, onScreen: true, space: .current)
}

func stats(thin: Bool = false) -> ObservationStats {
    ObservationStats(elements: 3, lines: 3, bytes: 40, omitted: 0, thin: thin, partial: false, readMs: 2)
}

// MARK: The AX reader

final class FakeChangeSignal: ChangeSignal, @unchecked Sendable {
    private let lock = NSLock()
    private var stamp: UInt64 = 0
    private var sig: UInt64 = 1
    private var busy = false
    let log: CallLog

    init(log: CallLog) { self.log = log }

    var lastChange: UInt64 { lock.withLock { stamp } }

    func signature() -> UInt64 {
        log.add("signature")
        return lock.withLock { sig }
    }

    func busyIndicatorShowing() -> Bool { lock.withLock { busy } }

    /// An AX notification now.
    func notify() { lock.withLock { stamp = mach_absolute_time() } }

    func setSignature(_ value: UInt64) { lock.withLock { sig = value } }
    func setBusy(_ value: Bool) { lock.withLock { busy = value } }
}

final class FakeReader: AppReading, @unchecked Sendable {
    let pid: pid_t
    let changes: any ChangeSignal
    let signal: FakeChangeSignal
    private let lock = NSLock()
    private let log: CallLog
    private var requests: [ObserveRequest] = []
    private var kinds: [ObservationKind] = []
    /// the next observations' kind and thinness, in order; then `.diff` and not thin
    var script: [(ObservationKind, Bool)] = []
    var resets = 0
    var closed = false
    /// observe blocks while this is set (a hung app)
    var hang = false
    /// what `resolve` answers, by index; a missing index is `no_such_element`
    var elements: Set<Int> = [1, 2, 3, 4, 5]
    var stale: Set<Int> = []
    /// the page a window read finds (§25.2), from the fake windows' selected tab
    let pageOf: (@Sendable () -> Page?)?
    private var page: Page?
    /// what `brief(of:)` answers for any element (the model's latest read listed it)
    var focusedBrief: ElementBrief?
    /// what the last read walked open (§26.11); `menusAsked` counts the shell's asks
    var menus: [OpenMenu] = []
    private(set) var menusAsked = 0
    var openMenus: [OpenMenu] {
        menusAsked += 1
        return menus
    }
    /// the menus the call's record saw open (§26.11)
    var openedByCallMenus = false
    func openedByCall(_ menu: AXUIElement) -> Bool { openedByCallMenus }

    init(pid: pid_t, log: CallLog, pageOf: (@Sendable () -> Page?)? = nil) {
        self.pid = pid
        self.log = log
        self.pageOf = pageOf
        self.signal = FakeChangeSignal(log: log)
        self.changes = signal
    }

    var observed: [ObserveRequest] { lock.withLock { requests } }

    func observe(_ request: ObserveRequest) throws -> ObservationText {
        log.add("observe space=\(request.space.width)x\(request.space.height) loading=\(request.loading) noteThin=\(request.noteThin) mode=\(request.mode.rawValue)")
        if request.openedMenus { lock.withLock { openedMenusAsked = true } }
        while lock.withLock({ hang }) { usleep(5_000) }
        let (kind, thin): (ObservationKind, Bool) = lock.withLock {
            requests.append(request)
            if request.element != nil { return (.subtree, false) }
            if request.mode == .full { return (.full, script.isEmpty ? false : script.removeFirst().1) }
            if !script.isEmpty { return script.removeFirst() }
            return (kinds.isEmpty ? .full : .diff, false)
        }
        lock.withLock { kinds.append(kind) }
        // a window read finds the selected tab's page; an element read none
        let found = request.element == nil ? pageOf?() : nil
        lock.withLock { page = found }
        if let found { log.add("observe page=\(found.tab)") }
        let text = "[1] window \"Doc\"" + (found.map { " tab \"\($0.tab)\"" } ?? "")
        return ObservationText(kind: kind, text: text, stats: stats(thin: thin), window: window(7, "Doc"), focused: nil)
    }

    var lastPage: Page? { lock.withLock { page } }

    func brief(of element: AXUIElement) -> ElementBrief? { lock.withLock { focusedBrief } }

    func watchPage(window: AXUIElement) {
        log.add("watchPage")
        signal.setBusy(true)
    }

    func resolve(_ index: Int) throws -> ResolvedElement {
        if lock.withLock({ stale.contains(index) }) {
            throw ComputerError(kind: .staleElement, message: "[\(index)] is gone", element: index, reason: .gone)
        }
        guard lock.withLock({ elements.contains(index) }) else {
            throw ComputerError(kind: .noSuchElement, message: "no [\(index)]", element: index)
        }
        log.add("resolve \(index)")
        return ResolvedElement(
            index: index, element: AXUIElementCreateApplication(pid), role: "AXButton", frame: Rect(x: 110, y: 60, w: 40, h: 20),
            actions: ["AXPress"], settable: [], brief: ElementBrief(index: index, line: "button \"B\(index)\"")
        )
    }

    func resetBase() {
        lock.withLock { resets += 1 }
        log.add("resetBase")
    }

    func close() { lock.withLock { closed = true } }

    // §27: what `named` and `menu` resolve to, by name or path; the focused element a blind key step meets
    var namedTargets: [String: Int] = [:]
    var menuTargets: [String: Int] = [:]
    /// the live focus as (in scope, inside a targeted element, secure, index); by default a field an earlier step
    /// targeted, so blind keys after a step run; nil: the focus could not be read
    var live: (inScope: Bool, targeted: Bool, secure: Bool, index: Int)? = (inScope: true, targeted: true, secure: false, index: 9)
    var openedMenusAsked = false

    func beginCallRecord() { log.add("record begin") }
    func recordStep(_ index: Int) { log.add("record step \(index)") }
    func endCallRecord() { log.add("record end") }

    func resolveNamed(_ name: String, window: AXUIElement) throws -> ResolvedElement {
        guard let index = lock.withLock({ namedTargets[name] }) else {
            throw ComputerFailure(ComputerError(kind: .namedTarget, message: "Nothing named \"\(name)\".", reason: .noMatch))
        }
        log.add("named \(name)")
        return try resolve(index)
    }

    func resolveMenu(_ path: String) throws -> ResolvedElement {
        guard let index = lock.withLock({ menuTargets[path] }) else {
            throw ComputerFailure(ComputerError(kind: .namedTarget, message: "No menu item \"\(path)\".", reason: .noMatch))
        }
        log.add("menu \(path)")
        return try resolve(index)
    }

    func liveFocus(window: AXUIElement, windows: [AXUIElement], targeted: [Int]) -> LiveFocus? {
        guard let l = lock.withLock({ live }) else { return nil }
        return LiveFocus(element: AXUIElementCreateApplication(pid), inScope: l.inScope, insideTargeted: l.targeted, secure: l.secure, role: l.secure ? "password" : "input",
                         inWebArea: false, brief: ElementBrief(index: l.index, line: l.secure ? "password \"Password\"" : "input \"Name\""))
    }
}

final class FakeReaders: ReaderPool, @unchecked Sendable {
    private let lock = NSLock()
    private var readers: [String: FakeReader] = [:]
    let log: CallLog
    /// the page each pid's reader finds (`FakeWindows.page`)
    var pageSource: (@Sendable (pid_t) -> Page?)?

    init(log: CallLog) { self.log = log }

    func reader(session: String, pid: pid_t) throws -> any AppReading { fake(session, pid) }

    func fake(_ session: String, _ pid: pid_t) -> FakeReader {
        lock.withLock {
            if let reader = readers["\(session):\(pid)"] { return reader }
            let source = pageSource
            let reader = FakeReader(pid: pid, log: log, pageOf: source.map { pages in { @Sendable in pages(pid) } })
            readers["\(session):\(pid)"] = reader
            return reader
        }
    }

    func close(session: String) {
        log.add("readers.close \(session)")
        lock.withLock { for (key, reader) in readers where key.hasPrefix(session + ":") { reader.close() } }
    }
}

final class FakeWindows: WindowSource, @unchecked Sendable {
    private let lock = NSLock()
    var windows: [pid_t: [WindowInfo]] = [:]

    func set(_ pid: pid_t, _ list: [WindowInfo]) { lock.withLock { windows[pid] = list } }

    func resolve(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo) {
        let list = lock.withLock { windows[pid] ?? [] }
        let found = ref?.id.flatMap { id in list.first { $0.id == id } }
            ?? ref?.title.flatMap { title in list.first { $0.title == title } }
            ?? (ref == nil ? list.first : nil)
        guard let found else {
            throw ComputerError(kind: .windowNotFound, message: "no such window", candidates: list.map(\.title))
        }
        return (AXUIElementCreateApplication(pid), found)
    }

    func list(pid: pid_t) throws -> [WindowInfo] { lock.withLock { windows[pid] ?? [] } }

    func windowID(of element: AXUIElement, pid: pid_t) -> UInt32? { nil }

    // §25: a browser window's tabs, by window id; the selected one's page
    struct Strip {
        var titles: [String]
        var selected: Int
    }

    var strips: [Int: Strip] = [:]
    var chromiumPids: Set<pid_t> = []
    /// the person is looking at the browser window: a `background` selection is `tab_in_use`
    var personsWindow = false
    /// how long a selection's page wait takes
    var selectDelay: Duration = .zero
    var log: CallLog?

    func setTabs(_ pid: pid_t, window info: WindowInfo, _ titles: [String], selected: Int = 0) {
        lock.withLock {
            windows[pid, default: []].append(info)
            strips[info.id] = Strip(titles: titles, selected: selected)
            chromiumPids.insert(pid)
        }
    }

    /// The selected tab's page of the pid's first browser window.
    func page(_ pid: pid_t) -> Page? {
        lock.withLock {
            guard let id = windows[pid]?.first(where: { strips[$0.id] != nil })?.id, let strip = strips[id] else { return nil }
            return Page(tab: strip.titles[strip.selected], state: .loaded)
        }
    }

    func resolveTab(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo, tab: TabHandle?) {
        let (list, strips) = lock.withLock { (windows[pid] ?? [], self.strips) }
        if let title = ref?.title, ref?.id == nil, !list.contains(where: { $0.title == title }) {
            for info in list {
                if let strip = strips[info.id], let at = strip.titles.firstIndex(of: title) {
                    return (AXUIElementCreateApplication(pid), info, TabHandle(element: AXUIElementCreateApplication(pid), title: title, selected: at == strip.selected))
                }
            }
        }
        let (element, info) = try resolve(pid: pid, ref: ref)
        return (element, info, nil)
    }

    func selectTab(pid: pid_t, window: AXUIElement, tab: TabHandle, mode: TabsMode, waitMs: Int) throws -> TabSelection {
        log?.add("selectTab \(tab.title) \(mode.rawValue)")
        let (id, already, front) = lock.withLock { () -> (Int?, Bool, Bool) in
            let id = windows[pid]?.first { strips[$0.id]?.titles.contains(tab.title) == true }?.id
            let strip = id.flatMap { strips[$0] }
            return (id, strip.map { $0.titles[$0.selected] == tab.title } ?? false, personsWindow)
        }
        guard let id else { throw ComputerError(kind: .windowNotFound, message: "no tab") }
        if already { return TabSelection(title: tab.title, switched: false, page: page(pid)) }
        if front && mode != .any {
            throw ComputerError(kind: .tabInUse, message: "Browser's window \"W\" is in front, on tab \"x\"; switch tabs with an act, which waits for the Mac to be free")
        }
        let delay = lock.withLock { selectDelay }
        if delay > .zero { usleep(useconds_t(delay / .microseconds(1))) }
        lock.withLock {
            let selected = strips[id]?.titles.firstIndex(of: tab.title) ?? 0
            strips[id]?.selected = selected
        }
        log?.add("selected \(tab.title)")
        return TabSelection(title: tab.title, switched: true, page: page(pid))
    }

    func tabSelected(_ tab: TabHandle) -> Bool {
        lock.withLock { strips.values.contains { $0.titles[$0.selected] == tab.title } }
    }

    func chromium(pid: pid_t) -> Bool { lock.withLock { chromiumPids.contains(pid) } }
}

// MARK: Capture

final class FakePixelSignal: PixelChangeSignal, @unchecked Sendable {
    private let lock = NSLock()
    private var isLive: Bool
    private var stamp: UInt64 = 0
    private let log: CallLog

    init(live: Bool, log: CallLog) {
        self.isLive = live
        self.log = log
    }

    var live: Bool { lock.withLock { isLive } }
    var lastChange: UInt64 { lock.withLock { stamp } }

    func waitLive(timeout: Duration) async -> Bool {
        log.add("waitLive")
        lock.withLock { isLive = true }
        return true
    }

    func change() { lock.withLock { stamp = mach_absolute_time() } }
}

final class FakeStream: StreamHandle, @unchecked Sendable {
    private let lock = NSLock()
    private var acks: [Int] = []
    private var ending: CheckedContinuation<StreamEndReason, Never>?
    private var endedWith: StreamEndReason?
    let onFrame: @Sendable (Frame) -> Void
    let startSize: (width: Int, height: Int)

    init(startSize: (width: Int, height: Int), onFrame: @escaping @Sendable (Frame) -> Void) {
        self.startSize = startSize
        self.onFrame = onFrame
    }

    var acked: [Int] { lock.withLock { acks } }

    func stop() async { end(.stopped) }

    func ack(_ seq: Int) { lock.withLock { acks.append(seq) } }

    func ended() async -> StreamEndReason {
        await withCheckedContinuation { continuation in
            let done: StreamEndReason? = lock.withLock {
                if let endedWith { return endedWith }
                ending = continuation
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }

    func end(_ reason: StreamEndReason) {
        let waiting: CheckedContinuation<StreamEndReason, Never>? = lock.withLock {
            guard endedWith == nil else { return nil }
            endedWith = reason
            defer { ending = nil }
            return ending
        }
        waiting?.resume(returning: reason)
    }
}

final class FakeCapture: CaptureSource, @unchecked Sendable {
    private let lock = NSLock()
    private let log: CallLog
    private var counters: [String: Int] = [:]
    private var made: [String: FakeStream] = [:]
    let pixel: FakePixelSignal
    /// what `space` answers; a screenshot comes out at `shotSize`
    var space = CoordinateSpace(width: 1280, height: 960, scale: 1.6)
    var shotSize: (Int, Int)?
    var failShots = false

    init(log: CallLog, pixelLive: Bool = false) {
        self.log = log
        self.pixel = FakePixelSignal(live: pixelLive, log: log)
    }

    func stream(_ windowID: UInt32) -> FakeStream? { lock.withLock { made["\(windowID)"] } }

    func invalidate() { log.add("invalidate") }

    func space(windowID: UInt32, frame: Rect, maxEdge: Int) -> CoordinateSpace {
        let space = lock.withLock { self.space }
        return maxEdge == ComputerDefaults.Shot.defaultMaxEdge ? space : CoordinateSpace(width: maxEdge, height: maxEdge * 3 / 4, scale: Double(maxEdge) / 800)
    }

    func nextStem(dataDir: String, session: String, action: String) throws -> String {
        let n: Int = lock.withLock {
            counters[session, default: 0] += 1
            return counters[session]!
        }
        return "\(dataDir)/shots/\(session)/\(String(format: "%04d", n))-\(action)"
    }

    func forget(session: String) { lock.withLock { counters[session] = nil } }

    func screenshot(windowID: UInt32, maxEdge: Int, regionPoints: Rect?, format: ShotFormat?, to stem: String) async throws -> Shot {
        log.add("screenshot \(stem.split(separator: "/").last ?? "")" + (regionPoints.map { " region=\(Int($0.w))x\(Int($0.h))" } ?? ""))
        if lock.withLock({ failShots }) { throw ComputerError(kind: .captureFailed, message: "capture refused") }
        let space = self.space(windowID: windowID, frame: Rect(x: 0, y: 0, w: 800, h: 600), maxEdge: maxEdge)
        let (w, h) = lock.withLock { shotSize } ?? (space.width, space.height)
        return Shot(
            path: stem + ".jpg", format: .jpeg, width: w, height: h, bytes: 1_000, scale: Double(w) / 800,
            window: Shot.Window(id: Int(windowID), frame: Rect(x: 100, y: 50, w: 800, h: 600)), region: nil, blank: false, capturedAt: 1
        )
    }

    func startStream(windowID: UInt32, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void) async throws -> any StreamHandle {
        log.add("startStream")
        let fit = min(1, Double(maxEdge) / Double(max(space.width, space.height)))
        let stream = FakeStream(startSize: (Int(Double(space.width) * fit), Int(Double(space.height) * fit)), onFrame: onFrame)
        lock.withLock { made["\(windowID)"] = stream }
        return stream
    }

    func watch(windowID: UInt32) async throws -> any PixelChangeSignal {
        log.add("watch")
        return pixel
    }
}

// MARK: Input

final class FakeInput: InputPerforming, @unchecked Sendable {
    private let lock = NSLock()
    private let log: CallLog
    let wiring: InputWiring
    /// what `perform` does; the default answers at the process tier
    var onPerform: (@Sendable (ComputerAction, InputTarget) throws -> InputOutcome)?
    private(set) var released: [pid_t] = []
    private(set) var stale: [HeldRecord] = []
    private(set) var cursors: [[Int]?] = []
    private(set) var quiets: [Int?] = []
    private(set) var tokens: [Int?] = []
    private(set) var idles: [Int?] = []
    /// §25.9 as each step saw it: the process is Chromium, the expected focus's index, the brief of the window
    private(set) var webFacts: [(chromium: Bool, expect: Int?, brief: ElementBrief?)] = []
    private var nextToken = 0
    /// decision 4: what each step's target said of the next step, the reports a closed hold leaves, the closes asked
    private(set) var keepOpens: [Bool] = []
    var frontReports: [FrontHold] = []
    private(set) var frontCloses = 0
    /// §26.5: the shell's key monitor switch, in order
    private(set) var keyWatches: [Bool] = []

    init(wiring: InputWiring, log: CallLog) {
        self.wiring = wiring
        self.log = log
    }

    /// the report a close leaves for `takeFrontReport`
    var closeReport: FrontHold?

    func closeFrontHold(pid: pid_t) {
        lock.withLock {
            frontCloses += 1
            if let r = closeReport { frontReports.append(r) }
        }
    }

    func takeFrontReport(pid: pid_t) -> FrontHold? {
        lock.withLock { frontReports.isEmpty ? nil : frontReports.removeFirst() }
    }

    func watchKeys(_ on: Bool) { lock.withLock { keyWatches.append(on) } }

    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome {
        lock.withLock { keepOpens.append(target.keepFrontOpen) }
        log.add("perform \(action.action.rawValue)")
        lock.withLock {
            cursors.append(target.cursor)
            quiets.append(target.pasteQuietMs)
            tokens.append(target.callToken)
            idles.append(target.personIdleMs)
            webFacts.append((target.chromium, target.expectFocus?.index, target.briefOf(target.window)))
        }
        if let onPerform = lock.withLock({ onPerform }) { return try onPerform(action, target) }
        if action.action == .cursorPosition { return InputOutcome(tier: nil, via: nil, clipboard: nil, cursor: target.cursor ?? [0, 0]) }
        return InputOutcome(tier: tiers.first, via: nil, clipboard: nil, cursor: action.coordinate, lastInputAt: mach_absolute_time())
    }

    func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport {
        log.add("probe")
        return ProbeReport(pid: Int(target.pid), bundleId: nil, keyWindow: .target, results: classes.map { .init(class: $0, outcome: .honoured, restored: true, ms: 1) })
    }

    func restoreSession(afterInterrupt: Bool) throws -> SessionRestore {
        log.add(afterInterrupt ? "restoreSession afterInterrupt" : "restoreSession")
        return SessionRestore(frontmost: .nothing, pointer: .nothing, held: nil)
    }

    func releaseHeld(pid: pid_t) {
        log.add("releaseHeld \(pid)")
        lock.withLock { released.append(pid) }
    }

    func releaseStale(_ record: HeldRecord) {
        log.add("releaseStale \(record.pid)")
        lock.withLock { stale.append(record) }
    }

    func callBegan(pid: pid_t) -> Int {
        let token = lock.withLock { () -> Int in
            nextToken += 1
            return nextToken
        }
        log.add("callBegan \(pid) \(token)")
        return token
    }

    func callEnded(_ token: Int) {
        log.add("callEnded \(token)")
    }

    func endGuard() {
        log.add("endGuard")
    }

    var releasedPids: [pid_t] { lock.withLock { released } }
    var seenWeb: [(chromium: Bool, expect: Int?, brief: ElementBrief?)] { lock.withLock { webFacts } }
    var seenTokens: [Int?] { lock.withLock { tokens } }
    var seenPersonIdles: [Int?] { lock.withLock { idles } }
    var staleRecords: [HeldRecord] { lock.withLock { stale } }
    var seenCursors: [[Int]?] { lock.withLock { cursors } }
    var seenPasteQuiets: [Int?] { lock.withLock { quiets } }
}

// MARK: Escape

/// The escape tap without a tap: `press()` stands in for the person's Escape.
final class FakeEscapeTap: EscapeTapping, @unchecked Sendable {
    private let lock = NSLock()
    private var onPress: (@Sendable () -> Void)?
    private(set) var starts = 0
    private(set) var stops = 0
    var refuse = false

    var running: Bool { lock.withLock { onPress != nil } }

    func start(onPress: @escaping @Sendable () -> Void) throws {
        if lock.withLock({ refuse }) {
            throw ComputerError(kind: .permissionMissing, message: "no tap", which: .accessibility)
        }
        lock.withLock {
            starts += 1
            self.onPress = onPress
        }
    }

    func stop() {
        lock.withLock {
            if onPress != nil { stops += 1 }
            onPress = nil
        }
    }

    func press() { lock.withLock { onPress }?() }
}
