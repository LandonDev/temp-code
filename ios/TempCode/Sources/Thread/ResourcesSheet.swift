import SwiftUI
import TempCodeClient
import TempCodeContract

/// What a thread created (docs/box.md "Thread resources"): one group per
/// host the rows live on, each row the label, its identifier in mono, the
/// state word when it has one, and Remove. The ledger's push is the truth: a
/// row leaves when the host says it is gone, not when the button was tapped.
struct ResourcesSheet: View {
    let client: EnvironmentClient
    let sessionId: String
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: ThreadResource?
    @State private var confirmingAll = false
    @State private var failure: String?
    @State private var appeared = false

    var body: some View {
        let rows = client.resources.bySession[sessionId] ?? []
        let live = rows.filter { $0.removedAt == nil }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let block = client.operateBlock {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .textStep(.meta)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.top, 12)
                    }
                    if rows.isEmpty {
                        Text("This thread created no worktrees, simulators or dev instances.")
                            .textStep(.meta)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                            .padding(.horizontal, Layout.textEdge)
                    } else {
                        ForEach(groups(rows), id: \.environmentId) { group in
                            GroupHeader(hostName(group.environmentId))
                            VStack(spacing: 0) {
                                ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                                    if index > 0 { Hairline(inset: Layout.textEdge) }
                                    ResourceRow(row: row, removing: client.resources.removing.contains(row.id), canRemove: client.operateBlock == nil) {
                                        confirming = row
                                    }
                                    .transition(.opacity)
                                }
                            }
                            .groupCard()
                            .padding(.horizontal, Layout.textEdge)
                        }
                        if live.count > 1 {
                            HStack {
                                Spacer()
                                Button("Remove all") { confirmingAll = true }
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(Tint.destructive)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .buttonStyle(.pressable)
                                    .disabled(client.operateBlock != nil)
                            }
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.top, 4)
                        }
                    }
                    if let failure {
                        Text(failure)
                            .font(.footnote)
                            .foregroundStyle(Tint.destructive)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.top, 12)
                    }
                }
                .padding(.bottom, 24)
                .animation(appeared ? Motion.rowLeave : nil, value: rows.map(\.id))
            }
            .background(Surface.background)
            .navigationTitle("Resources")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(confirming.map { "Remove \(ResourceWords.kindLabel($0.kind)) \($0.label)?" } ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    if let row = confirming { remove([row.id]) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Remove \(live.count) resources?", isPresented: $confirmingAll, titleVisibility: .visible) {
                Button("Remove all", role: .destructive) { remove(nil) }
                Button("Cancel", role: .cancel) {}
            }
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .task {
            // The first load lands before any animation is keyed; rows that leave later fade.
            await client.resources.load(client, sessionId: sessionId)
            appeared = true
        }
    }

    private struct HostGroup {
        let environmentId: String
        let rows: [ThreadResource]
    }

    /// One group per host, in first-seen order.
    private func groups(_ rows: [ThreadResource]) -> [HostGroup] {
        var order: [String] = []
        var byHost: [String: [ThreadResource]] = [:]
        for row in rows {
            if byHost[row.environmentId] == nil { order.append(row.environmentId) }
            byHost[row.environmentId, default: []].append(row)
        }
        return order.map { HostGroup(environmentId: $0, rows: byHost[$0] ?? []) }
    }

    private func hostName(_ environmentId: String) -> String {
        ResourceWords.hostName(environmentId, here: client.environment, paired: app.registry.ordered.map(\.environment))
    }

    private func remove(_ ids: [String]?) {
        failure = nil
        Task {
            do {
                let results = try await client.removeResources(sessionId, ids: ids)
                if let failed = results.first(where: { $0.outcome == .failed }) {
                    failure = failed.note ?? "The host could not remove it."
                }
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// One resource: the kind's glyph, the label, the identifier in mono, the
/// state word, and the trailing slot that is Remove, a spinner while a
/// removal is out, or "Waiting for the Mac" when the host is offline.
struct ResourceRow: View {
    let row: ThreadResource
    let removing: Bool
    let canRemove: Bool
    let remove: () -> Void

    private enum Trailing: Hashable {
        case remove, removing, waiting, removed
    }

    private var trailing: Trailing {
        if row.removedAt != nil { return .removed }
        if removing { return .removing }
        if ResourceWords.isWaiting(row) { return .waiting }
        return .remove
    }

    var body: some View {
        let trailing = trailing
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            MetaGlyph(ResourceWords.symbol(row.kind), label: ResourceWords.kindLabel(row.kind))
                .frame(width: Layout.glyphWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label)
                    .textStep(.title)
                    .lineLimit(1)
                Text(row.identifier)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let state = ResourceWords.rowState(row) {
                    Text(state)
                        .textStep(.stamp)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            ZStack {
                switch trailing {
                case .remove:
                    Button("Remove", action: remove)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Tint.destructive)
                        .frame(minWidth: 44, minHeight: 44)
                        .buttonStyle(.pressable)
                        .disabled(!canRemove)
                        .transition(.opacity)
                case .removing:
                    ProgressView()
                        .controlSize(.mini)
                        .transition(.opacity)
                case .waiting:
                    Text("Waiting for the Mac")
                        .textStep(.stamp)
                        .transition(.opacity)
                case .removed:
                    EmptyView()
                }
            }
            .animation(Motion.crossFade, value: trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: Layout.rowHeight)
        .opacity(trailing == .waiting || trailing == .removed ? 0.5 : 1)
        .accessibilityElement(children: .contain)
    }
}

/// "Archive <title>?" for a thread that holds something: the removal clause
/// with a switch on by default, the rows as stamp lines, and Archive at the
/// foot (archiving is reversible, so the label color, not destructive).
struct ArchiveWithResourcesSheet: View {
    struct Target: Identifiable {
        let client: EnvironmentClient
        let meta: SessionMeta

        var id: String { "\(client.environment.id):\(meta.id)" }
    }

    let target: Target
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var remove = true
    @State private var busy = false
    @State private var failure: String?
    @State private var confirmedAt = 0

    var body: some View {
        let client = target.client
        let live = client.resources.live(for: target.meta.id)
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                Text("Archive \(target.meta.title.isEmpty ? "this thread" : target.meta.title)?")
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 8) {
                    Toggle(isOn: $remove) {
                        Text(ResourceWords.removalClause(live, hostName: hostName))
                            .textStep(.meta)
                    }
                    ForEach(live, id: \.id) { row in
                        HStack(spacing: 6) {
                            Text(ResourceWords.kindLabel(row.kind))
                                .textStep(.stamp)
                            Text(row.label)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .padding(.leading, Layout.textEdge)
                    }
                }
                .padding(12)
                .groupCard()
                .padding(.top, 8)
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Tint.destructive)
                }
                Spacer(minLength: 16)
                WideButton(busy ? "Archiving…" : "Archive", prominent: true) { archive() }
                    .disabled(busy || client.operateBlock != nil)
            }
            .padding(Layout.textEdge)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .presentationDetents([.medium])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.impact(weight: .light), trigger: confirmedAt)
    }

    private func hostName(_ environmentId: String) -> String {
        ResourceWords.hostName(environmentId, here: target.client.environment, paired: app.registry.ordered.map(\.environment))
    }

    private func archive() {
        guard !busy else { return }
        busy = true
        confirmedAt += 1
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await target.client.archive(target.meta.id, removeResources: remove)
                dismiss()
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}
