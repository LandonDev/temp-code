import SwiftUI
import TempCodeClient
import TempCodeContract

/// "Add existing threads": the project's root threads on this host that are
/// in no batch and are no master, oldest first, one tap to pick each. Add
/// brings them in with one `batch.adopt`; a refusal comes back as one line
/// per thread in the footer, and the adopted ones leave the list through the
/// sessions push.
struct AdoptThreadSheet: View {
    let client: EnvironmentClient
    let master: SessionMeta
    var onAdopted: ([String]) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var refusals: [String] = []
    @State private var error: String?

    var body: some View {
        let candidates = BoardActions.adoptCandidates(client.sessions, master: master)
        let block = client.operateBlock
        NavigationStack {
            List {
                Section {
                    ForEach(candidates, id: \.id) { meta in
                        Button { toggle(meta.id) } label: {
                            HStack(spacing: Layout.rowGap) {
                                TypeGlyph(type: meta.threadType)
                                Text(meta.title.isEmpty ? "Untitled" : meta.title)
                                    .textStep(.title)
                                    .lineLimit(1)
                                Text(MasterBoard.typeWord(meta.threadType))
                                    .textStep(.meta)
                                    .lineLimit(1)
                                    .fixedSize()
                                Spacer(minLength: 8)
                                if selected.contains(meta.id) {
                                    Image(systemName: "checkmark")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Color.accentColor)
                                        .transition(.opacity)
                                }
                            }
                            .frame(minHeight: Layout.rowHeight)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.pressable)
                        .animation(Motion.crossFade, value: selected.contains(meta.id))
                        .accessibilityAddTraits(selected.contains(meta.id) ? .isSelected : [])
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if candidates.isEmpty {
                            Text("Nothing to add: every root thread of this project is in a batch or is a master.")
                        }
                        ForEach(refusals, id: \.self) { line in
                            Text(line).foregroundStyle(Tint.destructive)
                        }
                        if let error {
                            Text(error).foregroundStyle(Tint.destructive)
                        } else if let block {
                            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                        }
                    }
                }
            }
            .navigationTitle("Add existing threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Add") { Task { await adopt(candidates) } }
                            .font(.body.weight(.semibold))
                            .disabled(selected.isEmpty || block != nil)
                    }
                }
                .highVisibility()
            }
            .interactiveDismissDisabled(busy)
        }
        .tcSheet(.picker)
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    private func adopt(_ candidates: [SessionMeta]) async {
        guard !busy, !selected.isEmpty else { return }
        busy = true
        error = nil
        refusals = []
        defer { busy = false }
        do {
            let result = try await client.adoptIntoBatch(master.id, candidates.map(\.id).filter(selected.contains))
            selected.subtract(result.adopted)
            refusals = result.refused.map { refusal in
                let title = candidates.first { $0.id == refusal.sessionId }?.title ?? refusal.sessionId
                return "\(title.isEmpty ? "Untitled" : title): \(refusal.why)"
            }
            onAdopted(result.adopted)
            if result.refused.isEmpty { dismiss() }
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}
