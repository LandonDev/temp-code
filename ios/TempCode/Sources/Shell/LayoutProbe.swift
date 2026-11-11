#if DEBUG
import SwiftUI
import TempCodeClient
import UIKit

/// The layout report the iPhone Duo proof reads (DEBUG only; Release builds
/// compile none of this). Attached once at the root of `RootView` as
/// `.modifier(LayoutProbeModifier())`, it writes `Documents/layout-report.json`
/// 250 ms after any change settles — the window and screen in points, the
/// size classes, the idiom, the interface orientation, the hinge (iOS 27.1),
/// the safe area, the route, whether the transcript is at its bottom, the
/// notes any view left, and `classified`, the pose `DuoPose.classify` reads
/// off the window — and `Documents/layout-events.json`, the append log of
/// every change of `window`, `hSize`, `vSize`, `orientation`, `hinge.state`
/// and every notes key (`[{ t, key, from, to }]`, 500 at most, cleared at
/// launch; the Duo fold run's sampler merges it every 400 ms). The proof's `pose_check` holds a shot to the row for its pose;
/// the fold cycle reads the events.
///
/// The transcript's rows are counted by key (`rowInit`, `rowAppeared`,
/// `rowDisappeared`, from `rowInitProbe` on each row of TranscriptView):
/// `Documents/row-inits.json` holds every key's inits, appearances and
/// disappearances, the violations (a row whose state was made again while
/// it was on screen: an init while its appearances outnumber its
/// disappearances) and whether reduce motion was on; the layout report
/// carries the totals as `rowInits { rows, inits, violations }`.
///
/// Sibling plans make one call: `LayoutProbe.note("sidebar", "visible")`
/// from any view, a string key and value; a repeated same value is not an
/// event. `LayoutProbe.route(...)` is RootView's and ThreadScreen's.
///
/// In a performance run (`TestHooks.perf`) every entry returns at once: the
/// run times the views, not the probe's notes and its JSON writes.
@MainActor
enum LayoutProbe {
    private static let state = State()
    /// A performance run is on: nothing is noted, counted or written.
    static let off = TestHooks.perf != nil

    /// A free-form fact for the report (`notes.<key>`), and an event when it changes.
    static func note(_ key: String, _ value: String) {
        guard !off else { return }
        guard state.notes[key] != value else { return }
        // The reveal's step count changes ten times a second: kept as a note, never logged as an event.
        if key != "revealedUnits" { state.event(key, from: state.notes[key], to: value) }
        state.notes[key] = value
        state.schedule()
    }

    /// A frame in points as the notes carry it: "x,y,width,height", whole points.
    static func rect(_ frame: CGRect) -> String {
        [frame.minX, frame.minY, frame.width, frame.height].map { String(Int($0.rounded())) }.joined(separator: ",")
    }

    /// Counts an occurrence (`counts.<key>` in the report): how often a thing was drawn.
    static func count(_ key: String) {
        guard !off else { return }
        state.counts[key, default: 0] += 1
        state.schedule()
    }

    /// The tab and the focused stack's depth (RootView, on every navigation change).
    static func route(tab: String, depth: Int) {
        guard !off else { return }
        guard state.tab != tab || state.depth != depth else { return }
        state.tab = tab
        state.depth = depth
        state.schedule()
    }

    /// The thread on screen and its segment (ThreadScreen; nil when it leaves).
    static func route(thread: String?, segment: String?) {
        guard !off else { return }
        guard state.thread != thread || state.segment != segment else { return }
        state.thread = thread
        state.segment = segment
        state.schedule()
    }

    /// The transcript's position, read live at each write (TestHooks.recordTranscript hands it over).
    static func transcript(atBottom: @escaping @MainActor () -> Bool) {
        guard !off else { return }
        state.atBottom = atBottom
        state.schedule()
    }

    /// A transcript row's state was made (its `@StateObject` built): one per identity (`RowInitLedger`).
    static func rowInit(_ key: String) {
        guard !off else { return }
        state.rowLedger.inited(key, at: state.ms)
        state.schedule()
    }

    static func rowAppeared(_ key: String) {
        guard !off else { return }
        state.rowLedger.appeared(key)
        state.schedule()
    }

    static func rowDisappeared(_ key: String) {
        guard !off else { return }
        state.rowLedger.disappeared(key)
        state.schedule()
    }

    static func sizeClasses(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        guard !off else { return }
        state.set(\.hSize, word(horizontal), key: "hSize")
        state.set(\.vSize, word(vertical), key: "vSize")
    }

    @available(iOS 27.1, *)
    static func hinge(_ hinge: DeviceHinge?) {
        guard !off else { return }
        let status: String? = hinge.map {
            switch $0.status {
            case .closed: "closed"
            case .partiallyOpen: "partiallyOpen"
            case .fullyOpen: "fullyOpen"
            default: "unknown"
            }
        }
        state.hingeAngle = hinge.map { Int($0.angle.degrees.rounded()) }
        state.set(\.hingeState, status, key: "hinge.state")
    }

    /// What the window probe read.
    static func window(_ window: UIWindow) {
        guard !off else { return }
        let bounds = window.bounds.size
        let screen = window.screen.bounds.size
        state.screen = screen
        state.scale = window.screen.scale
        state.fps = window.screen.maximumFramesPerSecond
        state.idiom = window.traitCollection.userInterfaceIdiom == .pad ? "pad" : "phone"
        state.window = window
        state.set(\.orientation, orientationWord(window.windowScene?.interfaceOrientation), key: "orientation")
        state.set(\.windowSize, bounds, key: "window") { "\(Int($0.width.rounded()))x\(Int($0.height.rounded()))" }
    }

    private static func word(_ size: UserInterfaceSizeClass?) -> String? {
        switch size {
        case .compact: "compact"
        case .regular: "regular"
        default: nil
        }
    }

    private static func orientationWord(_ orientation: UIInterfaceOrientation?) -> String? {
        switch orientation {
        case .portrait: "portrait"
        case .portraitUpsideDown: "portraitUpsideDown"
        case .landscapeLeft: "landscapeLeft"
        case .landscapeRight: "landscapeRight"
        default: nil
        }
    }

    /// Nothing observes it: plain storage behind the debounce.
    private final class State {
        var windowSize: CGSize?
        var screen: CGSize?
        var scale: CGFloat = 0
        var fps = 0
        var idiom = "phone"
        var orientation: String?
        var hSize: String?
        var vSize: String?
        var hingeState: String?
        var hingeAngle: Int?
        /// Read at the write: the safe area settles after the window's bounds.
        weak var window: UIWindow?
        var tab = ""
        var depth = 0
        var thread: String?
        var segment: String?
        var atBottom: (@MainActor () -> Bool)?
        var notes: [String: String] = [:]
        var rowLedger = RowInitLedger()
        var counts: [String: Int] = [:]
        var events: [[String: Any]] = []
        var writes = 0
        private var pending: Task<Void, Never>?
        private let launched = Date()
        private let pose = ProcessInfo.processInfo.environment["TC_DUO_POSE"] ?? ""

        init() {
            // A new launch starts the log afresh.
            try? FileManager.default.removeItem(at: Self.url("layout-events"))
            try? FileManager.default.removeItem(at: Self.url("row-inits"))
        }

        func set<T: Equatable>(_ path: ReferenceWritableKeyPath<State, T?>, _ value: T?, key: String, words: (T) -> String = { "\($0)" }) {
            guard self[keyPath: path] != value else { return }
            event(key, from: self[keyPath: path].map(words), to: value.map(words))
            self[keyPath: path] = value
            schedule()
        }

        func event(_ key: String, from: String?, to: String?) {
            events.append(["t": ms, "key": key, "from": from ?? NSNull(), "to": to ?? NSNull()])
            if events.count > 500 { events.removeFirst(events.count - 500) }
        }

        var ms: Int { Int(Date().timeIntervalSince(launched) * 1000) }

        /// One write 250 ms after the last change, and at least one a second
        /// while changes keep coming (a streaming transcript never goes quiet).
        func schedule() {
            if pending != nil, let since = pendingSince, Date().timeIntervalSince(since) > 1 { return }
            pending?.cancel()
            if pendingSince == nil { pendingSince = Date() }
            pending = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, let self else { return }
                self.pending = nil
                self.pendingSince = nil
                self.write()
            }
        }

        private var pendingSince: Date?

        private func write() {
            writes += 1
            let w = windowSize ?? .zero
            let safeArea = window?.safeAreaInsets ?? .zero
            let hinge: DuoPose.HingeState? = hingeState.flatMap(DuoPose.HingeState.init(rawValue:))
            let classified = DuoPose.classify(
                width: w.width, height: w.height,
                horizontal: hSize == "compact" ? .compact : .regular,
                vertical: vSize == "compact" ? .compact : .regular,
                hinge: hinge
            )
            var route: [String: Any] = ["tab": tab, "depth": depth]
            if let thread { route["thread"] = thread }
            if let segment { route["segment"] = segment }
            var report: [String: Any] = [
                "pose": pose,
                "window": ["w": Int(w.width.rounded()), "h": Int(w.height.rounded())],
                "screen": ["w": Int((screen?.width ?? 0).rounded()), "h": Int((screen?.height ?? 0).rounded())],
                "scale": Int(scale.rounded()),
                "fps": fps,
                "hSize": hSize ?? "",
                "vSize": vSize ?? "",
                "idiom": idiom,
                "orientation": orientation ?? "",
                "hinge": hingeState.map { ["state": $0, "angle": hingeAngle ?? 0] as [String: Any] } ?? NSNull(),
                "safeArea": ["top": Int(safeArea.top.rounded()), "left": Int(safeArea.left.rounded()), "bottom": Int(safeArea.bottom.rounded()), "right": Int(safeArea.right.rounded())],
                "route": route,
                "notes": notes,
                "classified": classified?.rawValue ?? NSNull(),
                "writes": writes,
                "t": ms
            ]
            if let atBottom { report["transcriptAtBottom"] = atBottom() ? 1 : 0 }
            if !counts.isEmpty { report["counts"] = counts }
            if !rowLedger.rows.isEmpty {
                report["rowInits"] = ["rows": rowLedger.rows.count, "inits": rowLedger.inits, "violations": rowLedger.violations.count]
                let perRow = rowLedger.rows.mapValues { ["inits": $0.inits, "appears": $0.appears, "disappears": $0.disappears] }
                Self.dump([
                    "rows": perRow,
                    "violations": rowLedger.violations.map { ["key": $0.key, "t": $0.at, "inits": $0.inits] as [String: Any] },
                    "reduceMotion": UIAccessibility.isReduceMotionEnabled ? 1 : 0,
                    "t": ms
                ] as [String: Any], to: "row-inits")
            }
            Self.dump(report, to: "layout-report")
            Self.dump(events, to: "layout-events")
        }

        private static func url(_ name: String) -> URL {
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
            return documents.appending(path: "\(name).json")
        }

        private static func dump(_ object: Any, to name: String) {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
            try? data.write(to: url(name), options: .atomic)
        }
    }
}

extension View {
    /// A view's frame on screen as a note (`LayoutProbe.rect`), kept current; no observer at all in a performance run.
    @ViewBuilder
    func layoutProbeFrame(_ key: String) -> some View {
        if LayoutProbe.off {
            self
        } else {
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { LayoutProbe.note(key, LayoutProbe.rect($0)) }
        }
    }
}

/// On RootView's root: the size classes from the environment, the window
/// through a UIKit view laid out with the root, the hinge on iOS 27.1.
struct LayoutProbeModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontal
    @Environment(\.verticalSizeClass) private var vertical

    func body(content: Content) -> some View {
        let probed = content
            .background { LayoutProbeWindowView().allowsHitTesting(false).ignoresSafeArea() }
            .onChange(of: horizontal, initial: true) { LayoutProbe.sizeClasses(horizontal: horizontal, vertical: vertical) }
            .onChange(of: vertical) { LayoutProbe.sizeClasses(horizontal: horizontal, vertical: vertical) }
        if #available(iOS 27.1, *) {
            probed.onHingeChange { _, context in LayoutProbe.hinge(context.hinge) }
        } else {
            probed
        }
    }
}

/// Fills the root's frame so every change of the window lays it out again.
private struct LayoutProbeWindowView: UIViewRepresentable {
    func makeUIView(context: Context) -> ProbeView { ProbeView() }
    func updateUIView(_ view: ProbeView, context: Context) { view.report() }

    final class ProbeView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            report()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            report()
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            report()
        }

        func report() {
            guard let window else { return }
            LayoutProbe.window(window)
        }
    }
}
#endif
