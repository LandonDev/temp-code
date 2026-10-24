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
/// launch). The proof's `pose_check` holds a shot to the row for its pose;
/// the fold cycle reads the events.
///
/// Sibling plans make one call: `LayoutProbe.note("sidebar", "visible")`
/// from any view, a string key and value; a repeated same value is not an
/// event. `LayoutProbe.route(...)` is RootView's and ThreadScreen's.
@MainActor
enum LayoutProbe {
    private static let state = State()

    /// A free-form fact for the report (`notes.<key>`), and an event when it changes.
    static func note(_ key: String, _ value: String) {
        guard state.notes[key] != value else { return }
        state.event(key, from: state.notes[key], to: value)
        state.notes[key] = value
        state.schedule()
    }

    /// The tab and the focused stack's depth (RootView, on every navigation change).
    static func route(tab: String, depth: Int) {
        guard state.tab != tab || state.depth != depth else { return }
        state.tab = tab
        state.depth = depth
        state.schedule()
    }

    /// The thread on screen and its segment (ThreadScreen; nil when it leaves).
    static func route(thread: String?, segment: String?) {
        guard state.thread != thread || state.segment != segment else { return }
        state.thread = thread
        state.segment = segment
        state.schedule()
    }

    /// The transcript's position, read live at each write (TestHooks.recordTranscript hands it over).
    static func transcript(atBottom: @escaping @MainActor () -> Bool) {
        state.atBottom = atBottom
        state.schedule()
    }

    static func sizeClasses(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        state.set(\.hSize, word(horizontal), key: "hSize")
        state.set(\.vSize, word(vertical), key: "vSize")
    }

    @available(iOS 27.1, *)
    static func hinge(_ hinge: DeviceHinge?) {
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
        var events: [[String: Any]] = []
        var writes = 0
        private var pending: Task<Void, Never>?
        private let launched = Date()
        private let pose = ProcessInfo.processInfo.environment["TC_DUO_POSE"] ?? ""

        init() {
            // A new launch starts the log afresh.
            try? FileManager.default.removeItem(at: Self.url("layout-events"))
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

        private var ms: Int { Int(Date().timeIntervalSince(launched) * 1000) }

        /// One write 250 ms after the last change.
        func schedule() {
            pending?.cancel()
            pending = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                self?.write()
            }
        }

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
