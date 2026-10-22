import SwiftUI
import TempCodeClient
import TempCodeContract

/// "When the threads are done": the batch's rules as a form the person can
/// change. How branches land, the steps in order (rename in place, reorder
/// with Edit, swipe to delete, add a built-in kind or a shell command),
/// what happens after, and the master's one-line summary. The footer reads
/// the sentence back and says what the contract would refuse; Save is off
/// until the list is valid and the key may act. The foot takes the saved
/// rules from the host's answer.
struct RulesSheet: View {
    let client: EnvironmentClient
    let master: SessionMeta
    var onSaved: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var land: BatchLand
    @State private var steps: [BatchStepSpec]
    @State private var then: BatchThen
    @State private var summary: String
    @State private var shell: RulesEdit.ShellDraft?
    @State private var editing: EditMode = .inactive
    @State private var busy = false
    @State private var error: String?

    init(client: EnvironmentClient, master: SessionMeta, rules: BatchRules, onSaved: @escaping () -> Void = {}) {
        self.client = client
        self.master = master
        self.onSaved = onSaved
        _land = State(initialValue: rules.land)
        _steps = State(initialValue: rules.steps)
        _then = State(initialValue: rules.then)
        _summary = State(initialValue: rules.summary ?? "")
    }

    private var rules: BatchRules { RulesEdit.rules(land: land, steps: steps, then: then, summary: summary) }

    var body: some View {
        let problem = RulesEdit.stepsProblem(steps)
        let block = client.operateBlock
        NavigationStack {
            Form {
                if steps.contains(where: { $0.kind == .land }) {
                    Section("Branches land") {
                        Picker("Branches land", selection: $land) {
                            Text("As they finish").tag(BatchLand.asTheyFinish)
                            Text("All at once").tag(BatchLand.allAtOnce)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                    }
                }
                Section {
                    ForEach(steps, id: \.id) { step in
                        StepEditRow(
                            number: (steps.firstIndex { $0.id == step.id } ?? 0) + 1,
                            step: step,
                            name: Binding(get: { step.name }, set: { steps = RulesEdit.rename(steps, id: step.id, to: $0) })
                        )
                    }
                    .onMove { from, to in steps = RulesEdit.move(steps, from: from, to: to) }
                    .onDelete { offsets in steps = RulesEdit.remove(steps, ids: Set(offsets.map { steps[$0].id })) }
                    Menu {
                        ForEach(RulesEdit.addableKinds(steps), id: \.rawValue) { kind in
                            Button(kind == .shell ? "Shell command…" : RulesEdit.kindLabel[kind] ?? kind.rawValue) {
                                if kind == .shell {
                                    shell = RulesEdit.ShellDraft()
                                } else {
                                    steps = RulesEdit.add(kind, to: steps)
                                }
                            }
                        }
                    } label: {
                        Label("Add a step…", systemImage: "plus")
                    }
                    .disabled(shell != nil)
                } header: {
                    HStack {
                        Text("Steps, in order")
                        Spacer()
                        EditButton()
                            .font(.footnote)
                    }
                }
                if shell != nil {
                    Section("Shell command") {
                        TextField("Name, e.g. Smoke test", text: shellField(\.name))
                        TextField("Command, exit 0 passes", text: shellField(\.run), axis: .vertical)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Directory, default the project", text: shellField(\.cwd))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        HStack {
                            Button("Cancel") { shell = nil }
                                .buttonStyle(.borderless)
                            Spacer()
                            Button("Add") {
                                if let draft = shell { steps = RulesEdit.add(.shell, to: steps, shell: draft) }
                                shell = nil
                            }
                            .buttonStyle(.borderless)
                            .font(.body.weight(.semibold))
                            .disabled(!RulesEdit.shellDraftValid(shell ?? RulesEdit.ShellDraft()))
                        }
                    }
                }
                Section("Then") {
                    Picker("Then", selection: $then) {
                        Text("Notify me").tag(BatchThen.notify)
                        Text("Archive the threads").tag(BatchThen.archiveChildren)
                    }
                    .pickerStyle(.menu)
                }
                Section {
                    TextField("One line on what this batch is for", text: $summary)
                } header: {
                    Text("Summary")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(MasterBoard.rulesSentence(rules))
                        if let problem {
                            Text(problem).foregroundStyle(Tint.destructive)
                        }
                        if let block {
                            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                        }
                        if let error {
                            Text(error).foregroundStyle(Tint.destructive)
                        }
                    }
                }
            }
            .environment(\.editMode, $editing)
            .navigationTitle("When the threads are done")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .font(.body.weight(.semibold))
                            .disabled(!RulesEdit.stepsValid(steps) || block != nil)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
    }

    /// A field of the shell draft; writes land only while the draft is open.
    private func shellField(_ path: WritableKeyPath<RulesEdit.ShellDraft, String>) -> Binding<String> {
        Binding(
            get: { shell?[keyPath: path] ?? "" },
            set: { value in shell?[keyPath: path] = value }
        )
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client.setBatchRules(master.id, rules)
            onSaved()
            dismiss()
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}

/// A step in the editor: its place, its name as a field, and under it what it does.
private struct StepEditRow: View {
    let number: Int
    let step: BatchStepSpec
    @Binding var name: String

    var body: some View {
        HStack(spacing: 10) {
            Text("\(number)")
                .textStep(.stamp)
                .frame(minWidth: 14, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                TextField("Name", text: $name)
                Text(RulesEdit.stepLine(step))
                    .font(step.kind == .shell ? .system(.caption2, design: .monospaced) : .caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
