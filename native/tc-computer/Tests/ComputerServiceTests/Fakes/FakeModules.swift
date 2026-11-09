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

    init(pid: pid_t, log: CallLog) {
        self.pid = pid
        self.log = log
        self.signal = FakeChangeSignal(log: log)
        self.changes = signal
    }

    var observed: [ObserveRequest] { lock.withLock { requests } }

    func observe(_ request: ObserveRequest) throws -> ObservationText {
        log.add("observe space=\(request.space.width)x\(request.space.height) loading=\(request.loading) noteThin=\(request.noteThin) mode=\(request.mode.rawValue)")
        while lock.withLock({ hang }) { usleep(5_000) }
        let (kind, thin): (ObservationKind, Bool) = lock.withLock {
            requests.append(request)
            if request.element != nil { return (.subtree, false) }
            if request.mode == .full { return (.full, script.isEmpty ? false : script.removeFirst().1) }
            if !script.isEmpty { return script.removeFirst() }
            return (kinds.isEmpty ? .full : .diff, false)
        }
        lock.withLock { kinds.append(kind) }
        return ObservationText(kind: kind, text: "[1] window \"Doc\"", stats: stats(thin: thin), window: window(7, "Doc"), focused: nil)
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
}

final class FakeReaders: ReaderPool, @unchecked Sendable {
    private let lock = NSLock()
    private var readers: [String: FakeReader] = [:]
    let log: CallLog

    init(log: CallLog) { self.log = log }

    func reader(session: String, pid: pid_t) throws -> any AppReading { fake(session, pid) }

    func fake(_ session: String, _ pid: pid_t) -> FakeReader {
        lock.withLock {
            if let reader = readers["\(session):\(pid)"] { return reader }
            let reader = FakeReader(pid: pid, log: log)
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

    init(wiring: InputWiring, log: CallLog) {
        self.wiring = wiring
        self.log = log
    }

    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome {
        log.add("perform \(action.action.rawValue)")
        lock.withLock {
            cursors.append(target.cursor)
            quiets.append(target.pasteQuietMs)
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

    var releasedPids: [pid_t] { lock.withLock { released } }
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
