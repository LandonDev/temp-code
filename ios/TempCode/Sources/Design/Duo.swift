import SwiftUI
import UIKit

// The iPhone Duo's reads, shared by the shell, the thread screen and the
// sheets: where the fold's division band lies, whether a toolbar is drawn
// vertically, and where a floating bar would sit. Every 27.1 symbol sits
// under a runtime `if #available(iOS 27.1, *)` and nothing else: the app
// target needs Xcode 27.1, which scripts/ios-xcode.sh enforces, so there is
// no compile-time SDK gate. Before 27.1 the helpers answer nil or false and
// this file has no behaviour, which is why it has no tests: the rules it
// feeds (`ThreadPose.columns`) take the band as a plain `CGRect?` and are
// tested in the client package.
//
// Nothing here reads the device, its orientation or `UIScreen.main`: the
// band comes from the view's own geometry proxy, the bar edge from the
// toolbar's environment, the bar region from the view's window.

enum Duo {
    /// The first ACTIVE division region (the fold while the device is partly
    /// open; Apple marks it inactive when fully open or flat) in `proxy`'s
    /// own coordinates, leading to trailing (`.fixed`, so the column math is
    /// in points from the leading edge). Nil below 27.1 and nil with no
    /// active band.
    static func divisionBand(_ proxy: GeometryProxy) -> CGRect? {
        if #available(iOS 27.1, *) {
            return proxy.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).first { $0.isActive }?.frame
        }
        return nil
    }

    /// Whether the toolbar the environment belongs to is drawn vertically
    /// (the inner display in landscape, the outer display): the system's
    /// `toolbarVerticalEdge` on 27.1, false before. Meaningful inside a
    /// toolbar item's content, where the system sets the value.
    static func inVerticalBar(_ environment: EnvironmentValues) -> Bool {
        if #available(iOS 27.1, *) {
            return environment.toolbarVerticalEdge != nil
        }
        return false
    }

    /// How far a 48 pt bar floating inside the window's bottom bar region
    /// would push a dock sitting on the safe area: the region's bottom inset
    /// less the safe area's, less the 6 pt gutter between a bar and what
    /// sits above it. Zero when the bar is in the safe area or absent.
    static func barInset(region: CGFloat, safeArea: CGFloat) -> CGFloat {
        max(0, region - safeArea - 6)
    }

    /// The extent of the bar the probe asks about: the tab bar's height.
    static let barExtent: CGFloat = 48
}

extension EnvironmentValues {
    /// The toolbar this view's items are in is vertical: a custom toolbar view
    /// draws its glyph alone (the system shows no custom view vertically).
    @Entry var tcVerticalBar = false
}

extension View {
    /// Writes `\.tcVerticalBar` from the system's `toolbarVerticalEdge`.
    /// Apply it inside a toolbar item's content (the trailing group), where
    /// the system sets the edge; at a screen's root the edge is unset.
    func tcVerticalBarFromSystem() -> some View {
        modifier(VerticalBarReader())
    }

    /// Runs `action` when the hinge moves (27.1); nothing before. Effects
    /// only, per Apple: here a counter the geometry re-reads the band on.
    @ViewBuilder
    func onDuoHingeChange(_ action: @escaping () -> Void) -> some View {
        if #available(iOS 27.1, *) {
            onHingeChange { _, _ in action() }
        } else {
            self
        }
    }
}

private struct VerticalBarReader: ViewModifier {
    @Environment(\.self) private var environment

    func body(content: Content) -> some View {
        content.environment(\.tcVerticalBar, Duo.inVerticalBar(environment))
    }
}

/// Reports, from UIKit's own layout pass, where a `Duo.barExtent` bar on the
/// window's bottom edge would lie (`UIView.LayoutRegion.bar`, 27.1) and
/// the window's bottom safe area; the dock turns the pair into its inset
/// with `Duo.barInset`. Below 27.1 the region reads as zero: no inset.
/// Zero-sized and untouchable; put it in a background.
struct BarRegionProbe: UIViewRepresentable {
    let report: @MainActor (_ region: CGFloat, _ safeArea: CGFloat) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.report = report
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.report = report
        view.measure()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ProbeView, context: Context) -> CGSize? { .zero }

    final class ProbeView: UIView {
        var report: (@MainActor (CGFloat, CGFloat) -> Void)?
        private var lastRegion: CGFloat?
        private var lastSafeArea: CGFloat?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            measure()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            measure()
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            measure()
        }

        func measure() {
            guard let window else { return }
            var region: CGFloat = 0
            if #available(iOS 27.1, *) {
                region = window.edgeInsets(for: .bar(onEdge: UIRectEdge.bottom, extent: Duo.barExtent)).bottom
            }
            let safeArea = window.safeAreaInsets.bottom
            guard region != lastRegion || safeArea != lastSafeArea else { return }
            lastRegion = region
            lastSafeArea = safeArea
            let callback = report
            Task { @MainActor in callback?(region, safeArea) }
        }
    }
}
