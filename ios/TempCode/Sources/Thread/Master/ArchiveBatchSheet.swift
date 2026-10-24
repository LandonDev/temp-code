import SwiftUI
import TempCodeClient
import TempCodeContract

/// Archive done… and Archive all…: what leaves and what stays, said once,
/// the clean-up switch when the batch holds worktrees or simulators, and the
/// one button. `batch.archive` archives the children (the live ones stopped
/// first for all); the master stays and the rows leave through the push.
/// `resourcesHeldBy` is where the thread-resources work plugs its count in;
/// with none the switch is not shown. A confirm like the other two: the
/// prose is the title, Cancel in the bar, the sheet as tall as what it says.
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
    /// The content's height, so the sheet is as tall as what it says (the fleet confirm's rule).
    @State private var contentHeight: CGFloat = 280
    /// The inline navigation bar and the drag indicator above the content.
    @ScaledMetric(relativeTo: .body) private var chrome: CGFloat = 60

    var body: some View {
        let copy = BoardActions.archiveCopy(which, count: count, resources: resourcesHeldBy(master.id))
        let block = client.operateBlock
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(copy.title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
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
                if busy {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                        .padding(.top, 16)
                } else {
                    WideButton(copy.confirmLabel, prominent: true) { Task { await archive(cleanup: copy.cleanup != nil) } }
                        .disabled(count == 0 || block != nil)
                        .padding(.top, 16)
                }
            }
            .padding(Layout.textEdge)
            .frame(maxWidth: .infinity, alignment: .top)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .tcSheet(.confirm, fitted: contentHeight + chrome)
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
