import Foundation
import TempCodeClient
import SwiftUI

/// DEBUG-only hooks the simulator proof drives through the process
/// environment: which segment to open, what to open inside it, and the
/// scroll run that measures frames. Release builds read nothing. The
/// recorder and the drivers themselves are in Sources/Perf, compiled in
/// every configuration.
///
/// Reports land in the app's Documents as `<name>.json`, each written once
/// its value settles: `dock-report` / `dock-report-focused` (the dock's
/// height), `transcript-report` (atBottom, the top row and the reflow
/// anchor), `navigation-report`, `board-history-report`, `scroll-report`,
/// and `pose-<sessionId>` (the thread screen's pose: mode, width,
/// regularWidth, compactHeight, columns, division, segmentBarShown,
/// dockWidth, barInset; rewritten on every change, so the Duo runner reads
/// it at each stop of a fold run).
enum TestHooks {
    #if DEBUG
    private static let env = ProcessInfo.processInfo.environment
    /// `board`, `chat`, `plan`, `fleet`, `log` or `sources`.
    static let segment = env["TC_TEST_SEGMENT"].flatMap(ThreadSegment.init(rawValue:))
    /// `chip` opens the first tool chip with a held-back body, `group` opens
    /// the first activity group and lands on it, `diff` pushes
    /// the first edit's diff, `agent` pushes the first subagent, `agents`
    /// pushes the subagent list from the toolbar button once the thread has
    /// children, `rename` opens the inline title field once the thread is
    /// loaded (the proof types nothing), `report` opens the research report,
    /// `source` the first source's page, `page` pushes the first agent page
    /// (html_render) full screen, `account` opens the header's
    /// account menu sheet, `composer` focuses the chat field (the keyboard
    /// up; an operate key). With `TC_TEST_ROUTE=thread` in the unfolded
    /// portrait pose, `sidebar` shows the overlay sidebar over the thread. On a master's board, `rules`, `add-thread`,
    /// `adopt` and `archive-done` open that sheet once the batch has landed.
    static let open = env["TC_TEST_OPEN"].flatMap { $0.isEmpty ? nil : $0 }
    /// With `TC_TEST_ROUTE=thread`: `shown` or `hidden`, the split's sidebar
    /// for the shot (tiled beside the thread unfolded, over it in portrait),
    /// set after the thread opens whatever the launch memory says.
    static let sidebar = env["TC_TEST_SIDEBAR"].flatMap { $0 == "shown" ? true : $0 == "hidden" ? false : nil }
    /// Scrolls the whole transcript top and back while a display link
    /// records every frame; the report lands in Documents/scroll-report.json.
    static let scroll = env["TC_TEST_SCROLL"] == "1"
    /// The transcript proof's scrolled-up run: once the thread lands, the
    /// reader scrolls 700 pt up, and every content offset after that is held
    /// in Documents/scroll-hold.json (it must never move while rows arrive below).
    static let scrollUp = env["TC_TEST_SCROLL_UP"] == "1"
    /// The stream driver: once the thread lands, a display link records
    /// every frame for `TC_TEST_STREAM_SECONDS` (22) with the reader pinned at
    /// the bottom while the proof's `POST /stream` plays; Documents/stream-report.json.
    static let stream = env["TC_TEST_STREAM"] == "1"
    static let streamSeconds = env["TC_TEST_STREAM_SECONDS"].flatMap(Double.init) ?? 22
    /// With `stream`: 4 s in, a finger stands in for a slow drag 40 pt up
    /// (inside the bottom's slack) and holds 3 s while the reply streams;
    /// Documents/drag-hold.json says whether anything pulled it back.
    static let streamDrag = env["TC_TEST_STREAM_DRAG"] == "1"
    static let targetSeq = env["TC_TEST_TARGET_SEQ"].flatMap(Int.init)
    /// A second search hit in the same thread, opened once the first has landed.
    static let targetSeqNext = env["TC_TEST_TARGET_SEQ_NEXT"].flatMap(Int.init)
    static let history = env["TC_TEST_HISTORY"] == "1"
    /// An action the thread screen performs once its rows are in, through the
    /// same calls the buttons make: `send:<text>`, `stop`, `approve`, `deny`,
    /// `answer:<label>`, `start-build`, `rename:<title>`, `pin`, `archive`,
    /// `start-now` (a queued thread), `resume` (a stopped or paused one),
    /// `stop-step` (a master's running step), `set-master` (toggles the pin; an admin key),
    /// `draft:<text>` (types the text into the composer and focuses it, sending nothing, so a
    /// fold shot proves the draft and the keyboard survive).
    static let action = env["TC_TEST_ACTION"].flatMap { $0.isEmpty ? nil : $0 }
    /// `new-chat-held`: how long the draft's create is held before it goes out.
    static let draftHoldSeconds = 15.0
    /// `new-chat-wait`: how many 100 ms looks the draft takes for its host's catalog (60 s).
    static let catalogWaitTicks = 600
    /// A sheet to open for the shot: `start` on a planning thread, `new` on Home,
    /// `fleet:pause|fleet:stop|fleet:archive` (the fleet confirm on Home),
    /// `resources` (the Resources sheet on a thread), `archive` (the archive prompt on a thread with resources).
    /// For the iPhone Duo set: `rename` (the first thread row on screen), `notes` (a root thread's notes),
    /// `project-settings` (the first project), `preamble` (project settings with the editor pushed),
    /// `milestone` (Plan the milestone for a project plan's first undone one).
    /// Actions, in the list above: `batch:pause|batch:resume|batch:stop|batch:archive` on Home run the host-scope
    /// batch without the sheet; `archive-remove` and `remove-resources` on a thread.
    static let sheet = env["TC_TEST_SHEET"].flatMap { $0.isEmpty ? nil : $0 }
    /// With `TC_TEST_ROUTE=notification`: "title part|seq", a payload the delegate routes like a tap.
    static let notification = env["TC_TEST_NOTIFICATION"].flatMap { $0.isEmpty ? nil : $0 }
    /// The glide proof: `bottom` or `up` (the reader 700 pt up first). Once the
    /// thread lands, a tool group on screen (the lowest at the bottom, the
    /// highest up) is tapped open and shut three times through the line's own
    /// path (`TranscriptFollow.resize`), the list's offset, content height and
    /// each visible cell's presentation frame sampled every 8 ms through each;
    /// Documents/group-glide.json (scripts/lib/group_glide_check.py reads it).
    static let groupGlide = env["TC_TEST_GROUP_GLIDE"].flatMap { $0.isEmpty ? nil : $0 }
    /// A performance run (`PerfRun`): the thread the launch route opens runs it once it has
    /// landed and writes Documents/perf/<run>.json. The proof's probes stand down for the
    /// whole launch (`LayoutProbe`, `rowInitProbe`, `transcriptTrace`), so the run times the
    /// views a Release build has.
    static let perf = env["TC_TEST_PERF"].flatMap(PerfRun.init(rawValue:))
    /// The test server's control panel: a performance run plays its own stream and load through it.
    static let controlURL = env["TC_TEST_CONTROL_URL"].flatMap(URL.init(string:))
    #else
    static let segment: ThreadSegment? = nil
    static let open: String? = nil
    static let sidebar: Bool? = nil
    static let scroll = false
    static let scrollUp = false
    static let stream = false
    static let streamSeconds = 0.0
    static let streamDrag = false
    static let targetSeq: Int? = nil
    static let targetSeqNext: Int? = nil
    static let history = false
    static let action: String? = nil
    static let sheet: String? = nil
    static let notification: String? = nil
    static let groupGlide: String? = nil
    static let perf: PerfRun? = nil
    static let controlURL: URL? = nil
    #endif
    /// True once per key: a hook that several rows read fires on the first.
    static func once(_ key: String) -> Bool {
        #if DEBUG
        guard !fired.contains(key) else { return false }
        fired.insert(key)
        return true
        #else
        return false
        #endif
    }

    #if DEBUG
    @MainActor private static var fired: Set<String> = []
    #endif

    /// `pause`, `resume`, `stop` or `archive` as the fleet's action.
    static func batchAction(_ name: String) -> BatchAction? {
        switch name {
        case "pause": .pause
        case "resume": .resume
        case "stop": .stop
        case "archive": .archiveDone
        default: nil
        }
    }

    /// The bottom dock's height in points (the chat bar's resting height
    /// when nothing is typed), written once it settles: dock-report.json
    /// holds it in tenths of a point beside the composer's focus state.
    static func recordDock(height: CGFloat, focused: Bool) {
        #if DEBUG
        guard env["TC_TEST_ROUTE"] == "thread" else { return }
        writeReport(focused ? "dock-report-focused" : "dock-report", ["height10": Int((height * 10).rounded())])
        #endif
    }

    /// Whether the transcript is at its bottom one second after it landed,
    /// the app came back to the foreground, or its width changed
    /// (transcript-report.json: atBottom 1 or 0, topRow the stable key of the row at
    /// the top edge or -1, reflowAnchor 1 for the end, 2 for a row, 0 for
    /// none). Written under a launch route, or with
    /// `TC_TEST_TRANSCRIPT_REPORT=1` for a plain launch that restores a thread.
    @MainActor static func recordTranscript(sessionId: String, state: TranscriptScrollState) {
        #if DEBUG
        // The layout report reads the position live at each of its writes (the fold cycle's B, C, D).
        LayoutProbe.transcript { state.atBottom }
        guard env["TC_TEST_ROUTE"] == "thread" || env["TC_TEST_TRANSCRIPT_REPORT"] == "1" else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            let anchor: Int = switch state.reflowAnchor {
            case .end?: 1
            case .row?: 2
            case nil: 0
            }
            writeReport("transcript-report", ["atBottom": state.atBottom ? 1 : 0, "topRow": state.topRow?.key ?? -1, "reflowAnchor": anchor])
        }
        #endif
    }

    /// The thread screen's pose as the rules decided it, `pose-<sessionId>.json`,
    /// rewritten on every change (a fold run reads it at each stop).
    static func recordPose(sessionId: String, _ pose: PoseRecord) {
        #if DEBUG
        guard env["TC_TEST_ROUTE"] == "thread" || env["TC_TEST_POSE_REPORT"] == "1",
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(pose) else { return }
        try? data.write(to: documents.appending(path: "pose-\(sessionId).json"), options: .atomic)
        #endif
    }

    /// What `recordPose` writes. Lengths in points, rounded to tenths.
    struct PoseRecord: Codable, Equatable {
        struct Columns: Codable, Equatable {
            var hero: Double
            var gap: Double
            var chat: Double
        }

        struct Band: Codable, Equatable {
            var x: Double
            var y: Double
            var width: Double
            var height: Double
        }

        var mode: String
        var width: Double
        var regularWidth: Bool
        var compactHeight: Bool
        var columns: Columns?
        var division: Band?
        var segmentBarShown: Bool
        var dockWidth: Double
        var barInset: Double
        /// The pager's scroll container, which must equal `width` (a scroll view that extends under a side bar would page wrong).
        var pagerContainer: Double
        /// The pager's leading content inset and offset: both zero on Board, the inset zero on every page.
        var pagerInset: Double = 0
        var pagerOffset: Double = 0

        static func tenths(_ value: CGFloat) -> Double { (Double(value) * 10).rounded() / 10 }
    }

    static func recordNavigation(target: Int, item: Int?, oldest: Int?) {
        #if DEBUG
        guard targetSeq != nil || notification != nil else { return }
        writeReport("navigation-report", ["target": target, "item": item ?? -1, "oldest": oldest ?? -1])
        #endif
    }

    static func recordHistory(_ thread: ThreadState) {
        #if DEBUG
        guard history, !thread.rows.isEmpty, !thread.isLoading, !thread.isLoadingHistory else { return }
        writeReport("board-history-report", ["oldest": thread.rows.first?.seq ?? -1, "rows": thread.rows.count,
            "rounds": thread.fold.board.rounds.count, "todos": thread.fold.board.todos.count,
            "sources": thread.fold.board.sources.count, "complete": thread.moreBefore ? 0 : 1])
        #endif
    }

    /// The scrolled-up run's offsets (`TC_TEST_SCROLL_UP`): the offset the
    /// reader was left at, the lowest and highest seen since, how many, and
    /// the rows and last seq at the start and now. Rewritten on each sample.
    static func recordScrollHold(_ hold: ScrollHold) {
        #if DEBUG
        guard scrollUp, let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(hold) else { return }
        try? data.write(to: documents.appending(path: "scroll-hold.json"), options: .atomic)
        #endif
    }

    struct ScrollHold: Codable {
        var startOffset: Double
        var minOffset: Double
        var maxOffset: Double
        var samples: Int
        var rowsAtStart: Int
        var rows: Int
        var seqAtStart: Int
        var seq: Int
        var atBottom: Bool
    }

    /// The drag-hold run's samples (`TC_TEST_STREAM_DRAG`), offsets in tenths of a point.
    static func recordDragHold(_ fields: [String: Int]) {
        #if DEBUG
        guard streamDrag else { return }
        writeReport("drag-hold", fields)
        #endif
    }

    #if DEBUG
    private static func writeReport(_ name: String, _ fields: [String: Int]) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(fields) else { return }
        try? data.write(to: documents.appending(path: "\(name).json"), options: .atomic)
    }
    #endif

}
