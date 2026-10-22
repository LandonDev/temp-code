import SwiftUI
import TempCodeClient
import TempCodeContract

/// On a box's detail: what the box's threads run on a paired Mac right now,
/// from that Mac's `macBridge.activity`. The calls past the prompt (running
/// first, then held with their standing, then paused on the box), Stop on a
/// swipe and in the context menu, then the caps and the Mac's load. Deciding
/// a waiting request stays on the Mac; the footer says how many wait there.
/// Absent when the Mac does not serve this box.
struct MacBridgeSection: View {
    let box: EnvironmentClient
    let mac: EnvironmentClient
    @State private var painted = false
    @State private var actionError: String?

    var body: some View {
        if let activity = mac.extras.macBridge, let host = activity.hosts.first(where: { $0.environmentId == box.environment.id }) {
            let calls = MacBridgeWords.sorted(activity.calls.filter { $0.environmentId == box.environment.id })
            let canStop = HostExtrasAccess.macStop.allowed(mac.environment) && mac.status.transport == .open
            Section {
                ForEach(calls, id: \.id) { call in
                    MacCallRow(call: call)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if call.status != .paused {
                                // No destructive role: that slides the row out before the Mac answers.
                                Button("Stop", systemImage: "stop.fill") { stop(call) }
                                    .tint(Tint.destructive)
                                    .disabled(!canStop)
                            }
                        }
                        .contextMenu {
                            if call.status != .paused {
                                Button("Stop", systemImage: "stop.fill", role: .destructive) { stop(call) }
                                    .disabled(!canStop)
                            }
                        }
                        .rowAppearTransition()
                }
                .animation(painted ? Motion.rowAppear : nil, value: calls.map(\.id))
                RowErrorLine(message: $actionError)
                LabeledContent("Running") {
                    CountText("\(host.running) of \(host.maxRunning)", step: .title)
                }
                // After the first paint, rows that come and go travel; the first report lands still.
                .onAppear { painted = true }
                LabeledContent("Threads") {
                    CountText("\(host.threads) of \(host.maxThreads)", step: .title)
                }
                LabeledContent {
                    Text(MacBridgeWords.loadValue(activity.load))
                        .numeric(activity.load.load)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Load")
                        if let holding = MacBridgeWords.holdingLine(activity.load) {
                            Text(holding).textStep(.meta)
                        }
                    }
                }
            } header: {
                Text("On \(mac.environment.name)")
            } footer: {
                FooterText(lines: footer(host: host, hasStoppable: calls.contains { $0.status != .paused }))
            }
        }
    }

    private func footer(host: MacBridgeActivityHost, hasStoppable: Bool) -> [String] {
        var lines: [String?] = [
            MacBridgeWords.pendingFooter(pending: host.pending, macName: mac.environment.name) ?? "Approving and remembering happen on the Mac."
        ]
        if mac.status.transport != .open {
            lines.append("Mac not connected right now.")
        } else if hasStoppable, !HostExtrasAccess.macStop.allowed(mac.environment) {
            lines.append(HostExtrasAccess.macStop.reason)
        }
        return FooterLines.join(lines)
    }

    private func stop(_ call: MacBridgeCall) {
        let extras = mac.extras
        Task {
            do {
                try await extras.stopMacCall(id: call.id)
            } catch {
                withAnimation(Motion.rowAppear) { actionError = (error as? ActionError)?.message ?? error.localizedDescription }
            }
        }
    }
}

/// One call on the Mac: the mark (spinner, waiting, paused), the command in
/// mono, and under it the thread in the meta step with how long it has run
/// (or that it is paused on the box) a step quieter after it; a held call
/// says its place in line instead, swapping in place.
struct MacCallRow: View {
    let call: MacBridgeCall

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            MarkColumn(key: call.status.rawValue) { mark }
            VStack(alignment: .leading, spacing: 2) {
                MonoLine(MacBridgeWords.commandLine(call))
                second
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var mark: some View {
        switch call.status {
        case .running:
            ProgressView().controlSize(.mini)
        case .held:
            MetaGlyph("hourglass", label: "Waiting")
        case .paused, .unknown:
            MetaGlyph("pause", tint: Tint.warning, label: "Paused")
        }
    }

    @ViewBuilder private var second: some View {
        switch call.status {
        case .running:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                threadTitle
                ElapsedText(since: call.createdAt)
                    .fixedSize()
            }
        case .held:
            SwapText(call.held.map(MacBridgeWords.heldLine) ?? "Waiting for the Mac")
        case .paused, .unknown:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                threadTitle
                Text("Paused on the box")
                    .textStep(.stamp)
                    .fixedSize()
            }
        }
    }

    private var threadTitle: some View {
        Text(call.threadTitle)
            .textStep(.meta)
            .lineLimit(1)
    }
}
