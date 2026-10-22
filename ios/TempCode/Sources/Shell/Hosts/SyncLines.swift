import SwiftUI
import TempCodeClient
import TempCodeContract

/// Sync: per peer host, the harness config line and the memory line, each
/// swapping in place as it changes ("2m ago" ticks every 30 s), with Sync
/// now; the memory conflict copies behind a disclosure. Reading it needs an
/// admin key: a lesser key sees the section with one quiet row and the
/// reason, and nothing is asked of the host. Polled by `ActivityPollers`.
struct SyncSection: View {
    let client: EnvironmentClient
    @State private var actionError: String?

    var body: some View {
        let extras = client.extras
        let allowed = HostExtrasAccess.sync.allowed(client.environment)
        Section {
            if !allowed || extras.sync.forbidden {
                Text("Harness config and memory")
                    .foregroundStyle(.secondary)
            } else if !extras.syncLoaded {
                LookingRow()
            } else {
                // One timeline per row: a List splits a ForEach into rows, not a single view holding one.
                ForEach(peers(extras.sync), id: \.id) { peer in
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let now = context.date.timeIntervalSince1970 * 1000
                        SyncPeerRow(
                            name: peer.name,
                            connected: peer.connected,
                            harness: peer.harness.map { SyncWords.harnessLine($0, now: now) },
                            memory: peer.memory.map { SyncWords.memoryLine($0, now: now) },
                            syncing: extras.sync.syncing.contains(peer.id) || peer.harness?.running == true || peer.memory?.running == true,
                            canSync: canSync(peer, sync: extras.sync)
                        ) { syncNow(peer.id) }
                    }
                }
                if let conflicts = extras.sync.memory?.conflicts, !conflicts.isEmpty {
                    DisclosureGroup(SyncWords.conflictsTitle(conflicts.count)) {
                        ForEach(conflicts, id: \.path) { conflict in
                            TimelineView(.periodic(from: .now, by: 30)) { context in
                                VStack(alignment: .leading, spacing: 2) {
                                    MonoLine(conflict.of, truncation: .middle)
                                    Text(SyncWords.conflictLine(conflict, now: context.date.timeIntervalSince1970 * 1000))
                                        .textStep(.meta)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
                RowErrorLine(message: $actionError)
            }
        } header: {
            Text("Sync")
        } footer: {
            FooterText(lines: footer(allowed: allowed && !extras.sync.forbidden))
        }
    }

    private struct Peer {
        let id: String
        let name: String
        let harness: HarnessEnvironmentStatus?
        let memory: MemoryEnvironmentStatus?

        var connected: Bool { harness?.connected ?? memory?.connected ?? false }
    }

    /// The harness list's peers, joined with the memory list by id, then any memory-only peer.
    private func peers(_ sync: HostExtras.SyncState) -> [Peer] {
        let harness = sync.harness?.environments ?? []
        let memory = sync.memory?.environments ?? []
        var out = harness.map { h in Peer(id: h.id, name: h.name, harness: h, memory: memory.first { $0.id == h.id }) }
        for m in memory where !harness.contains(where: { $0.id == m.id }) {
            out.append(Peer(id: m.id, name: m.name, harness: nil, memory: m))
        }
        return out
    }

    private func canSync(_ peer: Peer, sync: HostExtras.SyncState) -> Bool {
        let connected = peer.connected
        let enabled = sync.harness?.enabled == true || sync.memory?.enabled == true
        return client.status.transport == .open && connected && enabled
    }

    private func footer(allowed: Bool) -> [String] {
        guard allowed else { return [HostExtrasAccess.sync.reason] }
        let sync = client.extras.sync
        guard client.extras.syncLoaded else { return [] }
        if peers(sync).isEmpty { return ["Nothing to sync with: this host has no paired peer."] }
        let enabled = sync.harness?.enabled ?? false
        let skipped = sync.harness?.skipped ?? 0
        return FooterLines.join([SyncWords.footer(enabled: enabled, skipped: skipped), sync.error])
    }

    private func syncNow(_ id: String) {
        let extras = client.extras
        Task {
            do {
                try await extras.syncNow(environmentId: id)
            } catch {
                withAnimation(Motion.rowAppear) { actionError = (error as? ActionError)?.message ?? error.localizedDescription }
            }
        }
    }
}

/// One peer: its name with "Not connected" beside it while the link is
/// down, the two lines in the meta step, and Sync Now (reading Syncing…
/// while either side runs).
struct SyncPeerRow: View {
    let name: String
    let connected: Bool
    let harness: String?
    let memory: String?
    let syncing: Bool
    let canSync: Bool
    let sync: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: Layout.rowGap) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(name)
                        .lineLimit(1)
                    if !connected {
                        Text("Not connected")
                            .textStep(.meta)
                            .fixedSize()
                    }
                }
                // The harness line names its sets and may wrap; SwapText holds one
                // line, so these cross-fade in place and keep the "synced …" end.
                if let harness { line(harness) }
                if let memory { line(memory) }
            }
            .layoutPriority(1)
            Spacer(minLength: Layout.rowGap)
            PillButton(syncing ? "Syncing…" : "Sync Now", action: sync)
                .animation(Motion.crossFade, value: syncing)
                .disabled(!canSync || syncing)
        }
        .padding(.vertical, 2)
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .textStep(.meta)
            .lineLimit(3)
            .contentTransition(.opacity)
            .animation(Motion.crossFade, value: text)
    }
}
