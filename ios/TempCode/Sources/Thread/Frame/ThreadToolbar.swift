import SwiftUI
import TempCodeClient
import TempCodeContract

/// The toolbar's way into the subagents, the desktop's agents cue
/// (`AgentsCue`): while any subagent works, waits or is queued at any depth
/// (a master's batch is its board's), the loudest live state's glyph
/// (waiting's amber dot, else working's dot, else the queued ring) and the
/// live count beside it, amber while one needs you. Working is the still
/// dot while the thread's own turn runs (one moving mark on screen), a
/// spinner otherwise. With nothing live, the agents glyph alone. The glyph
/// and the count cross-fade; the press dims. In a vertical bar
/// (`\.tcVerticalBar`, the Duo's inner display in landscape) the glyph
/// stands alone: the system shows no custom view vertically, and the count
/// stays in the accessibility label.
struct AgentsButton: View {
    let cue: AgentsCue?
    let action: () -> Void
    @Environment(\.tcVerticalBar) private var verticalBar

    var body: some View {
        Button(action: action) {
            HStack(spacing: TranscriptMetrics.wordGap) {
                glyph
                    .transition(.opacity)
                    .id(cue?.state)
                if let cue, !verticalBar {
                    Text("\(cue.waiting > 0 ? cue.waiting : cue.total)")
                        .font(.footnote)
                        .foregroundStyle(cue.state == .waiting ? AnyShapeStyle(Tint.warningText) : AnyShapeStyle(.primary))
                        .numeric(cue.total)
                        .transition(.opacity)
                }
            }
            .animation(Motion.crossFade, value: cue)
            .frame(minWidth: TranscriptMetrics.hitArea, minHeight: TranscriptMetrics.hitArea)
        }
        .buttonStyle(.pressableStatic)
        .accessibilityLabel(cue?.line ?? "Subagents")
        .accessibilityIdentifier("thread-agents")
    }

    @ViewBuilder private var glyph: some View {
        switch cue?.state {
        case .waiting?:
            Circle().fill(Tint.warning).frame(width: TranscriptMetrics.stepDot, height: TranscriptMetrics.stepDot)
                .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
        case .working?:
            if cue?.still == true {
                Circle().fill(.secondary).frame(width: TranscriptMetrics.stepDot, height: TranscriptMetrics.stepDot)
                    .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
            } else {
                ProgressView().controlSize(.mini)
            }
        case .queued?:
            Image(systemName: "circle.dashed")
                .font(.footnote)
                .foregroundStyle(Tint.quiet)
        case nil:
            Image(systemName: "person.2")
                .font(.body.weight(.regular))
        }
    }
}

/// The ellipsis menu, its items in `ThreadMenuItem.items`' order: the
/// reason a lesser key cannot act (first, when there is one), Rename, then
/// in a project's shell "Account…" (the account chip's sheet, since the shell
/// has no subtitle for the chip), Pin, the master pin, slot (d) for the
/// fleet switches and Resources (thread 20), then a divider and Archive
/// (roots). A subagent's menu has the block line and Rename only. Failures
/// go to `onFailure` and the screen's "Couldn't do that" alert.
struct ThreadMenu: View {
    let client: EnvironmentClient
    let session: SessionMeta
    var inShell = false
    let onRename: () -> Void
    let onFailure: (String) -> Void
    /// Slot (d), thread 20: the Resources sheet and the archive prompt the menu opens.
    @State private var showResources = false
    @State private var archiving: ArchiveWithResourcesSheet.Target?
    @State private var showAccount = false

    private var block: ActionBlock? { client.operateBlock }
    private var root: Bool { session.parentId == nil }
    private var routed: Bool { AccountScope.of(session, projects: client.projects, workspaces: client.workspaces, catalog: client.catalog) != nil }

    var body: some View {
        Menu {
            blockLine
            ForEach(ThreadMenuItem.items(root: root, inShell: inShell, routed: routed), id: \.self) { item in
                switch item {
                case .rename: renameItem
                case .account:
                    Button { showAccount = true } label: { Label("Account…", systemImage: "person.crop.circle") }
                case .pin: pinItem
                case .master: MasterPinButton(client: client, session: session, onFailure: onFailure)
                case .fleet: fleetSection
                case .resources: resourcesItem
                case .archive:
                    Divider()
                    archiveItem
                }
            }
        } label: {
            Image(systemName: GlassMetrics.moreSymbol)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.pressableStatic)
        .accessibilityLabel("More")
        .accessibilityIdentifier("thread-menu")
        .sheet(isPresented: $showResources) { ResourcesSheet(client: client, sessionId: session.id) }
        .sheet(isPresented: $showAccount) { AccountMenu(client: client, session: session) }
        .task(id: inShell && routed ? client.status.transport : nil) {
            // The chip loaded the accounts and the catalog; in the shell the menu row does.
            guard inShell, routed, client.status.transport == .open else { return }
            async let catalog = client.loadCatalog()
            await client.loadAccounts()
            _ = await catalog
            #if DEBUG
            if TestHooks.open == "account" { showAccount = true }
            #endif
        }
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
