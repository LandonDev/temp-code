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

    private var block: ActionBlock? { client.operateBlock }
    private var root: Bool { session.parentId == nil }

    var body: some View {
        Menu {
            blockLine
            renameItem
            if root {
                pinItem
                // Slot (d), thread 20: `fleetSection` (Pause all, Resume all, Stop all) and `resourcesItem` ("Resources…") go here.
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

    @ViewBuilder private var archiveItem: some View {
        Button(role: session.archived ? nil : .destructive) {
            act { try await client.setArchived(session.id, !session.archived) }
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
