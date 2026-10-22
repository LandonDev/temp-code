import SwiftUI
import TempCodeClient
import TempCodeContract

/// The toolbar's way into the subagents: the agent glyph with the running
/// count beside it in tabular digits. The screen shows it when the thread
/// has children and no Fleet segment lists them already
/// (`SegmentRules.showsAgents`); nothing running shows the glyph alone.
/// The glyph's stroke matches the count's weight; the press dims, a scale
/// on a 17 pt glyph in a dense bar would distract.
struct AgentsButton: View {
    let running: Int
    let total: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: "person.2")
                    .font(.body.weight(.regular))
                if running > 0 {
                    Text("\(running)")
                        .font(.footnote)
                        .numeric(running)
                        .transition(.opacity)
                }
            }
            .animation(Motion.crossFade, value: running > 0)
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.pressableStatic)
        .accessibilityLabel("Subagents")
        .accessibilityValue(running > 0 ? "\(running) of \(total) running" : "\(total)")
        .accessibilityIdentifier("thread-agents")
    }
}

/// The ellipsis menu. Its sections, in order, each a named place a sibling
/// adds to: the reason a lesser key cannot act (first, when there is one),
/// Rename, Pin (roots), slot (d) for the fleet switches and Resources
/// (thread 20), then a divider and Archive (roots). A subagent's menu has
/// the block line and Rename only. Failures go to `onFailure` and the
/// screen's "Couldn't do that" alert.
struct ThreadMenu: View {
    let client: EnvironmentClient
    let session: SessionMeta
    let onRename: () -> Void
    let onFailure: (String) -> Void
    /// Slot (d), thread 20: the Resources sheet and the archive prompt the menu opens.
    @State private var showResources = false
    @State private var archiving: ArchiveWithResourcesSheet.Target?

    private var block: ActionBlock? { client.operateBlock }
    private var root: Bool { session.parentId == nil }

    var body: some View {
        Menu {
            blockLine
            renameItem
            if root {
                pinItem
                fleetSection
                resourcesItem
                Divider()
                archiveItem
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.pressableStatic)
        .accessibilityLabel("More")
        .accessibilityIdentifier("thread-menu")
        .sheet(isPresented: $showResources) { ResourcesSheet(client: client, sessionId: session.id) }
        .sheet(item: $archiving) { ArchiveWithResourcesSheet(target: $0) }
        .task {
            // DEBUG proof: `TC_TEST_SHEET=resources` opens the sheet; `archive` opens the prompt once the ledger says the thread holds something.
            guard root, let sheet = TestHooks.sheet else { return }
            if sheet == "resources" { showResources = true }
            if sheet == "archive" {
                await client.resources.load(client, sessionId: session.id)
                if !client.resources.live(for: session.id).isEmpty { archiving = ArchiveWithResourcesSheet.Target(client: client, meta: session) }
            }
        }
    }

    /// Slot (d), thread 20: Start now or Resume for this root's state, then the
    /// fleet switches of its project (else its host).
    @ViewBuilder private var fleetSection: some View {
        RowStateActions(client: client, meta: session, onFailure: onFailure)
        FleetSwitchRows(client: client, scope: FleetSwitches.scope(of: session, client: client), showsBlock: false)
    }

    @ViewBuilder private var resourcesItem: some View {
        Button {
            showResources = true
        } label: {
            Label("Resources…", systemImage: "shippingbox")
        }
    }

    /// Why the actions below are disabled, when they are.
    @ViewBuilder private var blockLine: some View {
        if let block {
            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
        }
    }

    @ViewBuilder private var renameItem: some View {
        Button(action: onRename) {
            Label("Rename…", systemImage: "pencil")
        }
        .disabled(block != nil)
    }

    @ViewBuilder private var pinItem: some View {
        Button {
            act { try await client.setPinned(session.id, !session.pinned) }
        } label: {
            Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin")
        }
        .disabled(block != nil)
    }

    /// Unarchive at once; archive through the prompt when the thread holds resources (thread 20).
    @ViewBuilder private var archiveItem: some View {
        Button(role: session.archived ? nil : .destructive) {
            act {
                if session.archived {
                    try await client.setArchived(session.id, false)
                } else {
                    try await ArchivePrompt.archive(client, session) { archiving = $0 }
                }
            }
        } label: {
            Label(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox")
        }
        .disabled(block != nil)
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do {
                try await body()
            } catch {
                onFailure((error as? ActionError)?.message ?? String(describing: error))
            }
        }
    }
}
