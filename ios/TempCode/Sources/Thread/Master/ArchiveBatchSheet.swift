import SwiftUI
import TempCodeClient
import TempCodeContract

/// Archive done… and Archive all…: what leaves and what stays, said once,
/// the clean-up switch when the batch holds worktrees or simulators, and the
/// one button. `batch.archive` archives the children (the live ones stopped
/// first for all); the master stays and the rows leave through the push.
/// `resourcesHeldBy` is where the thread-resources work plugs its count in;
/// with none the switch is not shown.
struct ArchiveBatchSheet: View {
    let client: EnvironmentClient
    let master: SessionMeta
    let which: BoardActions.Which
    let count: Int
    var resourcesHeldBy: (String) -> Int? = { _ in nil }
    var onDone: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var removeResources = true
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let copy = BoardActions.archiveCopy(which, count: count, resources: resourcesHeldBy(master.id))
        let block = client.operateBlock
        VStack(alignment: .leading, spacing: 12) {
            Text(copy.title)
                .font(.headline)
            Text(copy.body)
                .textStep(.meta)
                .fixedSize(horizontal: false, vertical: true)
            if let cleanup = copy.cleanup {
                Toggle(cleanup, isOn: $removeResources)
                    .font(.footnote)
            }
            if let error {
                Text(error)
                    .textStep(.meta, tint: Tint.destructive)
            } else if let block {
                Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                    .textStep(.meta)
            }
            Spacer(minLength: 0)
            if busy {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
            } else {
                WideButton(copy.confirmLabel, prominent: true) { Task { await archive(cleanup: copy.cleanup != nil) } }
                    .disabled(count == 0 || block != nil)
            }
        }
        .padding(Layout.textEdge)
        .padding(.top, 8)
        .presentationDetents([.medium])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
    }

    private func archive(cleanup: Bool) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await client.archiveBatch(master.id, which: which, removeResources: cleanup && removeResources)
            if let first = result.failed.first {
                error = "\(result.failed.count) not archived: \(first.error)"
            } else {
                onDone()
                dismiss()
            }
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}
