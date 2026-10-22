import SwiftUI
import TempCodeClient
import TempCodeContract

/// The account menu: where the thread's account comes from, three scopes
/// (This thread reads the route and offers Route automatically; Project and
/// Workspace pin), and the provider's accounts as rows with a headroom bar
/// each. Reads the host's live snapshot; pins show at once and revert with
/// the reason when the host refuses. docs/IOS-DESIGN.md "The account chip
/// and menu".
struct AccountMenu: View {
    let client: EnvironmentClient
    let session: SessionMeta
    @State private var scopeKind: AccountScopeKind = .thread
    /// The optimistic check until the push lands, or 10 s pass.
    @State private var pending: PendingPin?
    /// The refusal, or the reroute's word; the key's block while none.
    @State private var reason: String?
    /// False through the first body, so nothing animates on first paint.
    @State private var appeared = false
    @Environment(\.dismiss) private var dismiss

    private struct PendingPin: Hashable {
        let kind: AccountScopeKind
        let name: String?
    }

    var body: some View {
        // The live row: a reroute's `sessions` push moves the check.
        let live = client.session(session.id) ?? session
        NavigationStack {
            Group {
                if let scope = AccountScope.of(live, projects: client.projects, workspaces: client.workspaces) {
                    content(scope: scope, session: live)
                } else {
                    Text("This thread's provider has no accounts here.")
                        .textStep(.meta)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { appeared = true }
        .task(id: pending) {
            guard pending != nil else { return }
            try? await Task.sleep(for: .seconds(10))
            pending = nil
        }
    }

    private func content(scope: AccountScope, session: SessionMeta) -> some View {
        let (project, workspace) = AccountScope.context(of: session, projects: client.projects, workspaces: client.workspaces)
        let scopes = AccountMenuModel.scopes(session: session, project: project, workspace: workspace)
        let accounts = client.accounts.snapshot.map { scope.provider.accounts(in: $0) }
        let pinOnScreen = pinned(scopeKind, project: project, workspace: workspace)
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text(scope.sourceLine)
                    .textStep(.meta)
                    .lineLimit(1)
                if scopes.count > 1 {
                    Picker("Scope", selection: $scopeKind) {
                        ForEach(scopes) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                ReasonLine(text: reason ?? blockLine, tone: reason == nil ? .secondary : .destructive)
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.top, 8)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = Int(context.date.timeIntervalSince1970 * 1000)
                let rows = AccountMenuModel.rows(scope: scope, kind: scopeKind, session: session, project: project, workspace: workspace, accounts: accounts, now: now)
                List {
                    ForEach(rows) { row in
                        let checked = pending.map { $0.kind == scopeKind ? row.name == $0.name : row.checked } ?? row.checked
                        Group {
                            if scopeKind == .thread {
                                AccountRow(row: row, checked: checked, appeared: appeared)
                            } else {
                                Button { choose(row.name, project: project, workspace: workspace) } label: {
                                    AccountRow(row: row, checked: checked, appeared: appeared)
                                }
                                .buttonStyle(.pressable)
                            }
                        }
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(Layout.markWidth + Layout.rowGap)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
            if scopeKind == .thread, scope.current != nil {
                HStack {
                    Spacer()
                    PillButton("Route automatically", systemImage: "arrow.triangle.2.circlepath") { reroute(session.id) }
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.bottom, 16)
            }
        }
        .onChange(of: pinOnScreen) {
            // The host's push caught up with the optimistic check.
            if let pending, pending.kind == scopeKind, pinned(pending.kind, project: project, workspace: workspace) == pending.name { self.pending = nil }
        }
        .onChange(of: scopeKind) { reason = nil }
    }

    /// The key's block while a pin scope shows and the key cannot pin.
    private var blockLine: String? {
        guard scopeKind != .thread, let block = client.pinBlock else { return nil }
        return block.text(now: Date().timeIntervalSince1970 * 1000)
    }

    private func pinned(_ kind: AccountScopeKind, project: ProjectMeta?, workspace: WorkspaceMeta?) -> String? {
        guard let provider = RoutedProvider(session.provider) else { return nil }
        switch kind {
        case .thread: return nil
        case .project: return project?.accountPins?[provider.rawValue]
        case .workspace: return workspace?.accountPins?[provider.rawValue]
        }
    }

    /// Pin `name` (nil = Automatic) at the scope on screen: the check moves at
    /// once and comes back with the reason if the host says no.
    private func choose(_ name: String?, project: ProjectMeta?, workspace: WorkspaceMeta?) {
        guard let provider = RoutedProvider(session.provider) else { return }
        if let block = client.pinBlock {
            reason = block.text(now: Date().timeIntervalSince1970 * 1000)
            return
        }
        let kind = scopeKind
        pending = PendingPin(kind: kind, name: name)
        reason = nil
        Task {
            do {
                switch kind {
                case .project:
                    guard let project else { return }
                    try await client.setProjectAccount(project.id, provider: provider, name: name)
                case .workspace:
                    guard let workspace else { return }
                    try await client.setWorkspaceAccount(workspace.id, provider: provider, name: name)
                case .thread:
                    return
                }
            } catch {
                pending = nil
                reason = (error as? ActionError)?.message ?? "Couldn't change the pin"
            }
        }
    }

    /// `session.reroute`: the host re-picks; its `sessions` push moves the check.
    private func reroute(_ sessionId: String) {
        if let block = client.operateBlock {
            reason = block.text(now: Date().timeIntervalSince1970 * 1000)
            return
        }
        reason = nil
        Task {
            do {
                let moved = try await client.rerouteAccount(sessionId)
                if !moved { reason = "Already on the best account" }
            } catch {
                reason = (error as? ActionError)?.message ?? "Couldn't reroute"
            }
        }
    }
}

/// One account row: the dot in its colour, the name, the stamp, the bar (or
/// Automatic's line, or "gone from this host"), and the check on the one
/// that applies.
private struct AccountRow: View {
    let row: AccountRowModel
    let checked: Bool
    let appeared: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Layout.rowGap) {
            mark
                .frame(width: Layout.markWidth, height: 20)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(title)
                        .textStep(.title, weight: checked ? .medium : .regular)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if case .account(_, _, _, let look) = row.kind, let stamp = look.stamp {
                        Text(stamp)
                            .textStep(.stamp)
                            .lineLimit(1)
                    }
                }
                switch row.kind {
                case .account(_, _, _, let look):
                    HeadroomBar(look: look, appeared: appeared)
                case .automatic(let detail):
                    Text(detail)
                        .textStep(.meta)
                        .lineLimit(1)
                case .gone:
                    Text("gone from this host")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
            Image(systemName: "checkmark")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: 20, height: 20)
                .opacity(checked ? 1 : 0)
                .animation(Motion.crossFade, value: checked)
                .accessibilityHidden(true)
        }
        .frame(minHeight: Layout.rowHeight)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(accessibilityValue)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    @ViewBuilder private var mark: some View {
        if case .account(_, _, let color, _) = row.kind {
            Circle()
                .fill(color.flatMap(Color.init(hex:)) ?? Color(.tertiaryLabel))
                .frame(width: Layout.dotSize, height: Layout.dotSize)
        } else {
            Color.clear
                .frame(width: Layout.dotSize, height: Layout.dotSize)
        }
    }

    private var title: String {
        switch row.kind {
        case .automatic: "Automatic"
        case .account(_, let shortName, _, _): shortName
        case .gone(let name): AccountName.short(raw: name)
        }
    }

    private var accessibilityValue: String {
        switch row.kind {
        case .automatic(let detail): detail
        case .account(_, _, _, let look): look.accessibility
        case .gone: "gone from this host"
        }
    }
}

/// One account's room: a 3 pt capsule, filled by the least room among the
/// windows its model spends, in the tone's colour. The fill eases 200 ms on
/// a snapshot change, never on the first paint; under reduced motion it snaps.
private struct HeadroomBar: View {
    let look: HeadroomLook
    let appeared: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { track in
            ZStack(alignment: .leading) {
                Capsule().fill(Surface.fill)
                Capsule()
                    .fill(tone)
                    .frame(width: track.size.width * look.fraction)
            }
        }
        .frame(height: 3)
        .animation(appeared && !reduceMotion ? AccountMotion.bar : nil, value: look.fraction)
    }

    private var tone: Color {
        switch look.tone {
        case .none: Color(.tertiaryLabel)
        case .success: Tint.success
        case .warning: Tint.warning
        case .destructive: Tint.destructive
        }
    }
}

/// The reserved line under the scope row: the key's block, a refusal, or the
/// reroute's word, cross-faded in place at a fixed height (SwapText with a
/// tone; thread 1's `SwapText(tint:)` replaces it once it lands).
private struct ReasonLine: View {
    enum Tone {
        case secondary
        case destructive
    }

    let text: String?
    let tone: Tone
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .leading) {
            Text(" ")
                .textStep(.meta)
                .hidden()
            if let text {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(tone == .destructive ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(.secondary))
                    .id(text)
                    .transition(Motion.swap(reduced: reduceMotion))
            }
        }
        .lineLimit(1)
        .animation(Motion.crossFade, value: text)
    }
}

/// The one motion value this surface adds: the headroom bar's fill easing on
/// a snapshot change. Thread 1 absorbs it into `Motion`.
private enum AccountMotion {
    static let bar: Animation = .easeOut(duration: 0.2)
}
