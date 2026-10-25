import SwiftUI
import TempCodeClient
import UIKit

/// One tab's container in every pose: a `NavigationSplitView` that SwiftUI
/// collapses to a stack in compact width and expands in regular width. The
/// view tree is the same before and after a fold, so the detail keeps its
/// identity and its state (a typed draft, a rename, the segment). The
/// sidebar is the tab's list stack on `navigator.sidebarPath`; the detail is
/// a stack on `navigator.detailStack` over the route at `navigator.detailRoot`,
/// or the placeholder when nothing is open. `detailTop` sits above the
/// detail's stack (the Home tab's thread strip) and is the caller's.
///
/// The style is the system's automatic one, which is `SidebarMode`'s rule:
/// the sidebar tiles beside the detail when the window is wider than tall
/// and overlays it behind the system toggle when taller than wide.
/// `columnVisibility` always carries the expanded preference (the remembered
/// toggle), never the collapsed state, so the sidebar arrives with the
/// expansion and never flickers in.
struct ShellSplit<Sidebar: View, Top: View, Placeholder: View, Destination: View>: View {
    @Bindable var navigator: ShellNavigator
    @ViewBuilder let sidebar: () -> Sidebar
    @ViewBuilder let detailTop: (Route?) -> Top
    @ViewBuilder let placeholder: () -> Placeholder
    @ViewBuilder let destination: (Route) -> Destination
    /// The device partially open (tabletop): the seam sits on the fold.
    @State private var halfOpen = false
    /// Where the window's centre line (the fold) falls in this split's own coordinates.
    @State private var foldX: CGFloat = 0

    var body: some View {
        NavigationSplitView(columnVisibility: visibility, preferredCompactColumn: compactColumn) {
            NavigationStack(path: $navigator.sidebarPath) {
                sidebar()
                    .navigationDestination(for: Route.self, destination: destination)
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: halfOpen && foldX > 280 ? foldX : 320, max: halfOpen ? max(360, foldX) : 360)
        } detail: {
            VStack(spacing: 0) {
                detailTop(navigator.detailRoot)
                NavigationStack(path: $navigator.detailStack) {
                    Group {
                        if let root = navigator.detailRoot {
                            destination(root)
                        } else {
                            placeholder()
                        }
                    }
                    // A new root is a new screen; the same root through a fold is the same one.
                    .id(navigator.detailRoot)
                    .navigationDestination(for: Route.self, destination: destination)
                    // At the stack's root, not on Hosts: a push made while Hosts itself was still
                    // arriving (the proof's hook) found no destination and drew the warning glyph.
                    .navigationDestination(for: HostDetailRoute.self) { HostDetailView(environmentId: $0.environmentId) }
                }
            }
        }
        // The fold is the window's centre line; the split may start short of the window's leading edge.
        .onGeometryChange(for: CGFloat.self) { navigator.windowWidth / 2 - $0.frame(in: .global).minX } action: { foldX = $0 }
        .background { HingeWatch(halfOpen: $halfOpen) }
    }

    /// The expanded preference: the remembered toggle, whatever the collapsed state.
    private var visibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { navigator.sidebarShown ? .all : .detailOnly },
            set: { navigator.sidebarShown = $0 != .detailOnly }
        )
    }

    /// Collapsed: the detail while something is open, else the sidebar. Back
    /// from the detail's root sets `.sidebar`, which clears what was open.
    private var compactColumn: Binding<NavigationSplitViewColumn> {
        Binding(
            get: { navigator.detailRoot == nil ? .sidebar : .detail },
            set: { column in
                guard column == .sidebar, navigator.detailRoot != nil else { return }
                navigator.detailRoot = nil
                navigator.detailStack = NavigationPath()
            }
        )
    }
}

/// The fold's division (iOS 27.1): while the hinge is partially open the
/// two panels are a tabletop and the sidebar takes the left one, so the
/// seam sits on the fold; fully open or closed the 320 pt ideal holds. The
/// SDK's hinge read is `UIHingeInteraction` (status and angle; no region),
/// and the inner display's panels are equal, so the window's centre line is
/// the fold. An ideal, never a forced width: a forced one makes the split
/// write its own visibility back.
private struct HingeWatch: UIViewRepresentable {
    @Binding var halfOpen: Bool

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        if #available(iOS 27.1, *) {
            view.addInteraction(UIHingeInteraction { _, update in
                let open = update.hinge?.status == .partiallyOpen
                if open != halfOpen { halfOpen = open }
            })
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

/// The detail's empty state: a title only, no description and no button;
/// the list is beside it and the shell never opens a thread the person did
/// not pick.
struct DetailPlaceholder: View {
    let title: LocalizedStringKey
    let symbol: String

    var body: some View {
        ContentUnavailableView(title, systemImage: symbol)
    }
}
