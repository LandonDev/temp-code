import SwiftUI
import TempCodeClient
import TempCodeContract

/// The plan page's header, its two slots filled: the state line and what
/// the person can do about it. The state comes from `PlanFlowState` (the
/// client package); the thread screen computes it once per render.
struct PlanStatusLine: View {
    let state: PlanFlowState

    var body: some View {
        // Fixed height, cross-fade with 2 pt of blur when the line changes.
        SwapText(state.line, step: .meta)
    }
}

/// The action slot: Start while the plan waits (opens the Start sheet), the
/// build chip once a build exists on this host, nothing otherwise. A key
/// that cannot operate keeps the pill; the tap says why.
struct PlanAction: View {
    let client: EnvironmentClient
    let state: PlanFlowState
    /// Opens the Start sheet.
    let onStart: () -> Void
    /// Pushes the build.
    let onOpen: (String) -> Void
    @State private var blocked: ActionBlock?

    var body: some View {
        Group {
            switch state {
            case .waiting:
                PillButton("Start", systemImage: "play.fill") {
                    if let block = client.operateBlock { blocked = block } else { onStart() }
                }
                .accessibilityHint("Start building this plan")
                .accessibilityIdentifier("plan-start")
            case .started(let buildId, let title?, let type):
                PillButton(title, systemImage: (type ?? .implementation).symbol) { onOpen(buildId) }
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 200, alignment: .trailing)
                    .accessibilityHint("Open the implementation thread started from this plan")
                    .accessibilityIdentifier("plan-build")
            case .started, .complete, .open:
                EmptyView()
            }
        }
        .alert("Couldn't do that", isPresented: Binding(get: { blocked != nil }, set: { if !$0 { blocked = nil } })) {
            Button("OK") {}
        } message: {
            Text(blocked?.text(now: Date().timeIntervalSince1970 * 1000) ?? "")
        }
    }
}
