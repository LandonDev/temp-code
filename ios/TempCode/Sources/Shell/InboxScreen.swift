import SwiftUI
import TempCodeClient
import TempCodeContract

/// Where the Inbox tab goes: an item, or a file's diff under it. The tab's
/// one path (`RootView.inboxPath`) holds these in both of the Inbox's
/// shapes; `InboxColumns.split` reads the selection off its first element
/// and the detail column's pushes off the rest.
enum InboxRoute: Hashable, Codable {
    case item(environmentId: String, item: GithubInboxItem)
    case diff(PatchDiffRoute)

    /// The item's host-qualified key, for the sidebar's selection.
    var key: String? {
        if case .item(let environmentId, let item) = self { return InboxModel.key(environmentId: environmentId, item: item) }
        return nil
    }

    /// What the launch memory keeps: the item alone (a patch is the host's to
    /// hand back, never a defaults key).
    static func remembered(_ path: [InboxRoute]) -> [InboxRoute] {
        path.filter { $0.key != nil }
    }
}

/// The Inbox in its two shapes (docs/IOS-DESIGN.md "Inbox"). Folded, or in a
/// compact column: today's stack, the list at the root, the item pushed, the
/// diff pushed under it. Unfolded with a regular column of its own: Mail's
/// shape inside the tab, the list in a 320 to 420 pt column and the selected
/// item beside it, a Changes row pushing the diff into the item's column.
/// Both read the tab's one path, so a fold mid-item keeps the item and an
/// unfold shows the list beside it with the diff still pushed.
struct InboxScreen: View {
    @Binding var path: [InboxRoute]
    @Environment(AppModel.self) private var model
    @Environment(\.windowClasses) private var window
    @Environment(\.horizontalSizeClass) private var column

    var body: some View {
        if InboxColumns.usesSplit(window, screen: WindowClassesPublisher.layoutClass(column)) {
            split
        } else {
            stack
        }
    }

    private var stack: some View {
        NavigationStack(path: $path) {
            InboxView(path: $path, split: false)
                .fleetToastInset()
                .navigationDestination(for: InboxRoute.self) { destination($0) }
        }
    }

    private var split: some View {
        let columns = InboxColumns.split(path)
        return NavigationSplitView(columnVisibility: .constant(.all)) {
            InboxView(path: $path, split: true)
                .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 420)
        } detail: {
            NavigationStack(path: Binding(
                get: { columns.detail },
                set: { path = InboxColumns.path(selected: columns.selected, detail: $0) }
            )) {
                Group {
                    if let selected = columns.selected {
                        destination(selected)
                    } else {
                        ContentUnavailableView("Select an item", systemImage: "tray")
                    }
                }
                .navigationDestination(for: InboxRoute.self) { destination($0) }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .fleetToastInset()
    }

    @ViewBuilder
    private func destination(_ route: InboxRoute) -> some View {
        switch route {
        case .item(let environmentId, let item):
            if let client = model.registry.client(environmentId) {
                InboxItemView(client: client, item: item, path: $path)
            }
        case .diff(let route):
            DiffScreen(route: route)
        }
    }
}
