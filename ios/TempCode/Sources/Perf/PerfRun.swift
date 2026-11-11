import Foundation
import Observation
import TempCodeClient
import UIKit

/// One measured run of a thread's transcript (docs/IOS-DESIGN.md
/// "Performance"). The simulator's `perf` proof set asks for one per launch
/// (`TC_TEST_PERF`); the Diagnostics screen asks for the two checks on the
/// phone. Each writes one `PerfReport`.
enum PerfRun: String, CaseIterable, Sendable {
    /// Pinned at the bottom: 5 s of the host's other traffic alone, then a turn streams for 20 s.
    case follow
    /// 3,000 pt/s up 30,000 pt and back, twice (cold, then warm).
    case scrollIdle = "scroll-idle"
    /// The same while a turn streams and the host's other traffic plays.
    case scrollBusy = "scroll-busy"
    /// 120 characters into the composer, one every 100 ms, 20 of them deleted.
    case typeIdle = "type-idle"
    /// The same in a chat paged in whole while 1,000 rows stream past its cap.
    case typeBusy = "type-busy"
    /// A working turn on screen and no pushes, 10 s.
    case rest
    /// A master's chat scrolled while its children stream.
    case master
    /// The same 200-frame stream into a 600-row thread and a 12,000-row one.
    case scaleShort = "scale-short"
    case scaleBuild = "scale-build"
    /// The Diagnostics screen's checks: the scroll and the typing on the person's own thread, whatever it is doing.
    case scrollCheck = "scroll-check"
    case typingCheck = "typing-check"

    var scrolls: Bool { self == .scrollIdle || self == .scrollBusy || self == .master || self == .scrollCheck }
    var types: Bool { self == .typeIdle || self == .typeBusy || self == .typingCheck }
}

/// What a run measured. Times in milliseconds; `counters` are
/// `PerfCounters` over the measured stretch, by name.
struct PerfReport: Codable, Equatable {
    var run: String
    var sessionId: String
    /// Why the run measured nothing, when it did.
    var note: String?
    var seconds = 0.0
    var maxFramesPerSecond = 0
    var expectedMs = 0.0
    var lowPower = false
    var thermal = "nominal"
    /// Display intervals; `late` are those over one and a half, `hitchMsPerS` the time they ran over per second.
    var frames = PerfDist()
    var late = 0
    var hitchMsPerS = 0.0
    /// The main thread's CPU time per display interval, and per second of the run.
    var cpuMs = PerfDist()
    var cpuMsPerS = 0.0
    /// Per applied batch of pushed rows: CPU and wall time to the end of the commit after it, and the rows built for it.
    var batchCpuMs = PerfDist()
    var batchWallMs = PerfDist()
    var batchRows = PerfDist()
    /// Per key: CPU and wall time to the end of the commit after it.
    var keyCpuMs = PerfDist()
    var keyWallMs = PerfDist()
    var counters: [String: Int] = [:]
    /// `follow`: the counters while only other threads and other sessions got pushes.
    var loadOnly: [String: Int]?
    var loadOnlySeconds = 0.0
    /// The counters while the thread on screen streamed.
    var stream: [String: Int]?
    var streamSeconds = 0.0
    /// The counters while the keys went in.
    var typing: [String: Int]?
    var keys = 0
    var wraps = 0
    /// The keyboard's height while the keys went in: under 100 pt, no keyboard was up.
    var keyboardHeight = 0.0
    /// Rows that moved more than 2 pt beyond the scroll (the first 40), how many in the cold and the warm pass, and the largest.
    var jumps: [PerfJump] = []
    var jumpCount = [0, 0]
    var worstJumpPt = 0.0
    /// Points scrolled in the cold and the warm pass.
    var travelPt = [0.0, 0.0]
    var jumpUps = 0
    /// Wire rows held and transcript rows at the end, and the rows of the last turn.
    var rowsHeld = 0
    var items = 0
    var liveTurnRows = 0
}

/// The run that is asked for, running or done. The transcript of the asked
/// thread takes the request once its rows are in (`TranscriptView`), the
/// thread screen gives a typing run its composer's focus, and the
/// Diagnostics screen reads the report.
@Observable
final class PerfSession {
    static let shared = PerfSession()

    struct Request: Equatable {
        var run: PerfRun
        /// nil: the first transcript that lands (the proof's launch route).
        var sessionId: String?
        var id = UUID()
    }

    private(set) var request: Request?
    private(set) var running: PerfRun?
    private(set) var report: PerfReport?
    /// The thread whose composer a typing run types into.
    var focus: String?

    private init() {
        request = TestHooks.perf.map { Request(run: $0, sessionId: nil) }
    }

    func ask(_ run: PerfRun, sessionId: String) {
        report = nil
        request = Request(run: run, sessionId: sessionId)
    }

    /// The transcript of `sessionId` takes the request, if it is its own.
    /// The request stays until the run finishes: the transcript's task is
    /// keyed on it, and a key that changed would cancel the run it started.
    func claim(_ sessionId: String) -> PerfRun? {
        guard running == nil, let request, request.sessionId == nil || request.sessionId == sessionId else { return nil }
        running = request.run
        return request.run
    }

    /// The transcript's task key: the request and whether its rows are in,
    /// held still while a run goes, so neither the claim nor a page loading
    /// under the scroll cancels it.
    func taskKey(loading: Bool, empty: Bool) -> String {
        guard let request else { return "" }
        return running == nil ? "\(request.id)|\(loading)|\(empty)" : "\(request.id)|false|false"
    }

    func finish(_ report: PerfReport) {
        request = nil
        running = nil
        focus = nil
        self.report = report
    }

    /// The asked run never started (its thread is gone).
    func cancel() {
        request = nil
    }

    private static let lastKey = "diagnostics.lastThread"

    /// The thread the person last opened: the Diagnostics screen's checks run on it.
    var lastThread: ThreadKey? {
        guard let parts = UserDefaults.standard.stringArray(forKey: Self.lastKey), parts.count == 2 else { return nil }
        return ThreadKey(environmentId: parts[0], sessionId: parts[1])
    }

    func noteOpened(_ key: ThreadKey) {
        UserDefaults.standard.set([key.environmentId, key.sessionId], forKey: Self.lastKey)
    }
}

/// What a run needs of the transcript it measures.
struct PerfContext {
    let client: EnvironmentClient
    let sessionId: String
    let scroll: () -> UIScrollView?
    let rowAt: (_ item: Int, _ items: Int) -> TranscriptRowID?
    /// The driver stands in for the reader's finger: paging and the pins read this as they do under a fling.
    let readerMoving: (Bool) -> Void
}

/// Runs one `PerfRun` on a landed transcript and writes its report to
/// Documents/perf/<run>.json. In the simulator proof it also plays the
/// test server's stream and load through the control panel
/// (`TC_TEST_CONTROL_URL`); on the phone the host is whatever it is.
struct PerfRunner {
    func run(_ run: PerfRun, _ context: PerfContext) async -> PerfReport {
        var report = PerfReport(run: run.rawValue, sessionId: context.sessionId)
        report.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        report.thermal = Self.word(ProcessInfo.processInfo.thermalState)
        // The landing settles: the open's snap, the first pins, the cached replies' parse.
        await Self.sleep(2)
        guard let scroll = await scroller(context) else {
            report.note = "the transcript did not load"
            Self.write(report)
            return report
        }
        let id = context.sessionId
        let client = context.client
        if run == .typeBusy { await pageIn(client, id) }
        // A board thread fetches its whole history after it opens: the run measures the thread
        // once that is in, as a thread the person has had open, not the fetch.
        await history(client, id)
        Self.write(landed: run, rows: client.threads[id]?.rows.count ?? 0)
        let recorder = FrameRecorder()
        recorder.rowAt = context.rowAt
        var start = PerfCounters.snapshot()
        let begin = {
            start = PerfCounters.snapshot()
            recorder.start(sourceRows: client.threads[id]?.rows.count ?? 0, items: 0, scrollView: scroll, driver: .perf)
        }
        switch run {
        case .follow:
            begin()
            await Self.control("/load", ["seconds": 27])
            await Self.sleep(0.5)
            let quiet = PerfCounters.snapshot()
            await Self.sleep(4)
            report.loadOnly = PerfCounters.delta(from: quiet, to: PerfCounters.snapshot())
            report.loadOnlySeconds = 4
            await Self.sleep(0.5)
            await Self.control("/stream", ["sessionId": id, "seconds": 18])
            let streaming = PerfCounters.snapshot()
            await Self.sleep(20)
            report.stream = PerfCounters.delta(from: streaming, to: PerfCounters.snapshot())
            report.streamSeconds = 20
        case .scaleShort, .scaleBuild:
            begin()
            await Self.control("/stream", ["sessionId": id, "frames": 200])
            let streaming = PerfCounters.snapshot()
            await Self.sleep(10)
            report.stream = PerfCounters.delta(from: streaming, to: PerfCounters.snapshot())
            report.streamSeconds = 10
        case .rest:
            // A turn left open: its working line is what runs while nothing arrives.
            await Self.control("/stream", ["sessionId": id, "frames": 20, "hold": true])
            await Self.sleep(5)
            begin()
            await Self.sleep(10)
        case .scrollIdle, .scrollBusy, .master, .scrollCheck:
            if run == .scrollBusy {
                await Self.control("/load", ["seconds": 90])
                await Self.control("/stream", ["sessionId": id, "seconds": 80])
            }
            if run == .master { await Self.control("/load", ["seconds": 90, "children": true]) }
            if run != .scrollIdle { await Self.sleep(2) }
            begin()
            let driver = ScrollDriver()
            context.readerMoving(true)
            recorder.mover = { scroll, elapsed in
                recorder.pass = driver.pass
                return driver.step(scroll, elapsed: elapsed)
            }
            var waited = 0.0
            while !driver.done, waited < 120 {
                await Self.sleep(0.05)
                waited += 0.05
            }
            recorder.mover = nil
            context.readerMoving(false)
        case .typeIdle, .typeBusy, .typingCheck:
            if run == .typeBusy {
                await Self.control("/load", ["seconds": 40])
                await Self.control("/stream", ["sessionId": id, "rows": 1000, "intervalMs": 14])
            }
            PerfSession.shared.focus = id
            guard let field = await TypingDriver.field() else {
                report.note = "the composer is off"
                Self.write(report)
                return report
            }
            begin()
            let before = PerfCounters.snapshot()
            let typed = await TypingDriver().type(into: field)
            report.typing = PerfCounters.delta(from: before, to: PerfCounters.snapshot())
            report.keys = typed.keys
            report.wraps = typed.wraps
            report.keyboardHeight = typed.keyboardHeight
        }
        let measure = recorder.finish()
        // The screen left mid-run: what was measured is no run.
        if Task.isCancelled { report.note = "it was stopped" }
        report.counters = PerfCounters.delta(from: start, to: PerfCounters.snapshot())
        report.counters["offMainFolds"] = PerfOffMain.foldCount
        if run.types { TypingDriver.clear() }
        fill(&report, from: measure)
        if let state = client.threads[id] {
            report.rowsHeld = state.rows.count
            let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen)
            report.items = rows.count
            let turns = TranscriptRows.turnKeys(rows)
            if let last = rows.last, let turn = turns[last.id] { report.liveTurnRows = rows.count { turns[$0.id] == turn } }
        }
        Self.write(report)
        return report
    }

    private func fill(_ report: inout PerfReport, from measure: FrameMeasure) {
        report.seconds = PerfDist.round(measure.seconds)
        report.maxFramesPerSecond = measure.maxFramesPerSecond
        report.expectedMs = PerfDist.round(measure.expectedMs)
        report.frames = PerfDist(measure.intervals)
        report.late = measure.late
        report.hitchMsPerS = measure.seconds > 0 ? PerfDist.round(measure.hitchMs / measure.seconds) : 0
        report.cpuMs = PerfDist(measure.cpu)
        report.cpuMsPerS = measure.seconds > 0 ? PerfDist.round(measure.cpu.reduce(0, +) / measure.seconds) : 0
        report.batchCpuMs = PerfDist(measure.batchCpu)
        report.batchWallMs = PerfDist(measure.batchWall)
        report.batchRows = PerfDist(measure.batchRows)
        report.keyCpuMs = PerfDist(measure.keyCpu)
        report.keyWallMs = PerfDist(measure.keyWall)
        report.jumps = Array(measure.jumps.prefix(40))
        report.jumpCount = [measure.jumps.count { $0.pass == 0 }, measure.jumps.count { $0.pass == 1 }]
        report.worstJumpPt = measure.jumps.map { abs($0.pt) }.max() ?? 0
        report.travelPt = measure.travel.map(PerfDist.round)
        report.jumpUps = measure.jumpUps
    }

    /// The list's scroll view once the probe has found it (10 s at most).
    private func scroller(_ context: PerfContext) async -> UIScrollView? {
        for _ in 0..<100 {
            if let scroll = context.scroll() { return scroll }
            await Self.sleep(0.1)
        }
        return nil
    }

    /// Waits for the thread to go live (30 s at most) and, for a board
    /// thread, for the history it fetches after that (3 minutes at most; the
    /// report's `rowsHeld` shows what was in). A thread with no host behind
    /// it is measured as it is.
    private func history(_ client: EnvironmentClient, _ id: String) async {
        for _ in 0..<300 {
            if client.threads[id]?.isLive == true { break }
            await Self.sleep(0.1)
        }
        let board: Bool = switch client.session(id)?.threadType {
        case .implementation?, .research?, .orchestration?, .planning?, .projectPlan?: true
        default: false
        }
        for _ in 0..<1_800 {
            guard let state = client.threads[id], state.isLive, state.historyError == nil,
                  state.isLoadingHistory || (board && state.moreBefore) else { return }
            await Self.sleep(0.1)
        }
    }

    /// Every older page, so the thread holds all its rows before the run.
    private func pageIn(_ client: EnvironmentClient, _ id: String) async {
        for _ in 0..<200 {
            guard let state = client.threads[id], state.moreBefore, let first = state.rows.first?.seq else { return }
            if state.isLoadingOlder {
                await Self.sleep(0.02)
                continue
            }
            await client.loadOlder(id)
            guard let now = client.threads[id]?.rows.first?.seq, now < first else { return }
        }
    }

    static func sleep(_ seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
    }

    private static func word(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    /// One POST to the test server's control panel; nothing outside the proof.
    private static func control(_ path: String, _ body: [String: Any]) async {
        guard let base = TestHooks.controlURL, let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        _ = try? await URLSession.shared.data(for: request)
    }

    private static var directory: URL? {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let directory = documents.appending(path: "perf")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func encoded(_ report: PerfReport) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        return try? encoder.encode(report)
    }

    private static func write(_ report: PerfReport) {
        guard let directory, let data = encoded(report) else { return }
        try? data.write(to: directory.appending(path: "\(report.run).json"), options: .atomic)
    }

    /// The run's thread landed and the run began: the proof stops waiting for a launch that never opened it.
    private static func write(landed run: PerfRun, rows: Int) {
        guard let directory, let data = try? JSONEncoder().encode(["rows": rows]) else { return }
        try? data.write(to: directory.appending(path: "\(run.rawValue).landed.json"), options: .atomic)
    }
}

/// The reader's finger for a measured scroll: each tick it moves the list
/// from where it is by 3,000 pt/s times the time since the last tick, never
/// to a place worked out from the start, so a correction the list makes to
/// its own offset stands. Up 30,000 pt (or to the top, once nothing more
/// joins above for a second and a half) and back to the bottom, twice: the
/// cold pass meets rows never measured, the warm pass the same rows again.
final class ScrollDriver {
    static let velocity = 3_000.0
    static let distance = 30_000.0

    /// 0 and 2 go up, 1 and 3 come back.
    private var leg = 0
    private(set) var done = false
    private var travelled = 0.0
    private var stuck = 0.0
    private var climbed = 0.0

    /// 0 for the cold pass, 1 for the warm one.
    var pass: Int { min(1, leg / 2) }

    /// Moves the list one step and answers the step it took.
    func step(_ scroll: UIScrollView, elapsed: Double) -> Double {
        guard !done else { return 0 }
        let up = leg % 2 == 0
        let inset = scroll.adjustedContentInset
        let lowest = -inset.top
        let highest = max(lowest, scroll.contentSize.height + inset.bottom - scroll.bounds.height)
        // A late frame moves the list as far as a finger would have in that time, a tenth of a second at most.
        let want = Self.velocity * min(elapsed, 0.1) * (up ? -1 : 1)
        let from = scroll.contentOffset.y
        let to = min(highest, max(lowest, from + want))
        if to != from { scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: to), animated: false) }
        let step = Double(scroll.contentOffset.y - from)
        travelled += abs(step)
        stuck = abs(step) < 0.5 ? stuck + elapsed : 0
        let over = up ? travelled >= Self.distance || stuck > 1.5 : stuck > 0.3 || travelled >= climbed + 4_000
        if over {
            if up { climbed = travelled }
            travelled = 0
            stuck = 0
            leg += 1
            done = leg > 3
        }
        return step
    }
}

/// The reader's keys for a measured run: text goes into the field that has
/// the focus through `UIKeyInput`, one character every 100 ms: 100
/// characters, 20 deleted, 20 more. It measures the app's side of a key;
/// the keyboard process, autocorrect and the candidate bar are not in it.
struct TypingDriver {
    /// 120 characters of plain words, long enough to wrap the field three times.
    static let text = String(String(repeating: "the quick brown fox jumps over the lazy dog and ", count: 3).prefix(120))

    /// Characters this driver left in the field, deleted again by `clear`.
    private static var left = 0

    /// The composer's field once it has the focus (5 s at most).
    static func field() async -> (UIResponder & UIKeyInput)? {
        for _ in 0..<50 {
            if let field = UIResponder.focused as? (UIResponder & UIKeyInput) { return field }
            await PerfRunner.sleep(0.1)
        }
        return nil
    }

    func type(into field: UIResponder & UIKeyInput) async -> (keys: Int, wraps: Int, keyboardHeight: Double) {
        let view = field as? UIView
        var height = view?.bounds.height ?? 0
        var keys = 0
        var wraps = 0
        func key(_ insert: Character?) async {
            PerfCounters.mark(.key)
            if let insert { field.insertText(String(insert)) } else { field.deleteBackward() }
            Self.left += insert == nil ? -1 : 1
            keys += 1
            await PerfRunner.sleep(0.1)
            if let now = view?.bounds.height, abs(now - height) > 1 {
                wraps += 1
                height = now
            }
        }
        for (index, character) in Self.text.enumerated() {
            await key(character)
            if index == 99 { for _ in 0..<20 { await key(nil) } }
        }
        let keyboard = view?.window.map { Double($0.keyboardLayoutGuide.layoutFrame.height) } ?? 0
        return (keys, wraps, keyboard)
    }

    /// Takes the typed characters out again and lets the keyboard go: a draft the person had is as it was.
    static func clear() {
        let field = UIResponder.focused
        if let input = field as? UIKeyInput { for _ in 0..<max(0, left) { input.deleteBackward() } }
        left = 0
        field?.resignFirstResponder()
    }
}

extension UIResponder {
    private static weak var found: UIResponder?

    /// The first responder, by the action the responder chain delivers to it.
    static var focused: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(noteFocused), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func noteFocused() {
        UIResponder.found = self
    }
}
