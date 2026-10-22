import SwiftUI
import TempCodeClient
import TempCodeContract

/// "Add a thread to <master>": the brief first (what the thread should do
/// and what done looks like), then its type, who runs it and how hard it
/// thinks, the 1M window where the model offers it, and the sibling it waits
/// for. The thread is created in the master's project and directory with the
/// master's id as its batch and its starter (the desktop's AddThreadDialog);
/// the brief is its first message, and the host queues it until `After` is
/// done. The new row lands through the sessions push.
struct AddThreadSheet: View {
    let client: EnvironmentClient
    let master: SessionMeta
    let rows: [MasterBoard.Row]
    var onCreated: (SessionMeta) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var brief = ""
    @State private var type: ThreadType = .implementation
    @State private var choice: CatalogChoice
    @State private var context1m = false
    @State private var after: String?
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(client: EnvironmentClient, master: SessionMeta, rows: [MasterBoard.Row], onCreated: @escaping (SessionMeta) -> Void = { _ in }) {
        self.client = client
        self.master = master
        self.rows = rows
        self.onCreated = onCreated
        _choice = State(initialValue: CatalogChoice(provider: master.provider, model: master.model, reasoning: master.reasoning))
    }

    private var trimmed: String { brief.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Only a sibling on this host can be waited for.
    private var afterChoices: [MasterBoard.Row] { BoardActions.afterChoices(rows).filter { $0.environmentId == nil } }
    private var offers1m: Bool { BoardActions.supportsContext1m(provider: choice.key.provider, model: choice.model) }

    var body: some View {
        let block = client.operateBlock
        NavigationStack {
            Form {
                Section {
                    TextField("What this thread should do, and what done looks like.", text: $brief, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focused)
                }
                Section {
                    Picker("Type", selection: $type) {
                        ForEach(BoardActions.addTypes, id: \.rawValue) { candidate in
                            ThreadTypeRow(type: candidate).tag(candidate)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    ModelReasoningRows(client: client, choice: choice)
                    if offers1m {
                        Toggle("1M context", isOn: $context1m)
                    }
                    Picker("After", selection: $after) {
                        Text("Nothing, start now").tag(String?.none)
                        ForEach(afterChoices) { row in
                            Text(row.title.isEmpty ? "Untitled" : row.title).tag(String?.some(row.sessionId))
                        }
                    }
                    .pickerStyle(.menu)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Tint.destructive)
                    } else if let block {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                    }
                }
            }
            .navigationTitle(master.title.isEmpty ? "Add a thread to the batch" : "Add a thread to \(master.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Add") { Task { await add() } }
                            .font(.body.weight(.semibold))
                            .disabled(trimmed.isEmpty || choice.model == nil || block != nil)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
            .onAppear { focused = true }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
    }

    private func add() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        let draft = ThreadDraft.batch(brief: trimmed, type: type, master: master, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning, context1m: offers1m && context1m, after: after)
        do {
            let created = try await client.createThread(draft)
            dismiss()
            onCreated(created)
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}
