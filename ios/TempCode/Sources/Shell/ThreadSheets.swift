import SwiftUI
import TempCodeClient
import TempCodeContract

// The sheets that make or name a thread: Start a build from a plan, New
// thread from a workspace or a project, Rename. Each is the system sheet
// at medium and large, 16 pt corners, Cancel on the left and the one
// confirming verb on the right, off until the form is valid. The type is a
// grouped list with the type's glyph and the desktop's one-line hint; the
// model and reasoning rows open the host's catalog (ComposerStyles.swift).

/// The model row and the reasoning row of a sheet, over the catalog: each
/// a native-looking value row whose menu is the same one the composer's
/// chips open. The reasoning row shows only for a model with levels.
struct ModelReasoningRows: View {
    let client: EnvironmentClient
    @Bindable var choice: CatalogChoice

    var body: some View {
        Group {
            if choice.catalog == nil {
                LabeledContent("Model") {
                    if choice.loading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Unavailable")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                LabeledContent("Model") {
                    ModelMenu(choice: choice) {
                        ValueChevron(text: choice.modelLabel)
                    }
                }
                .accessibilityElement(children: .combine)
                if choice.levels.count > 1, let level = choice.reasoning {
                    LabeledContent("Reasoning") {
                        ReasoningMenu(choice: choice) {
                            ValueChevron(text: level.label)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .task { await choice.load(client) }
    }
}

/// A row's value as the system draws a menu picker's: the value in
/// secondary, the up-down chevron in the tertiary step beside it.
private struct ValueChevron: View {
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Text(text)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

extension PermissionPolicy {
    nonisolated var label: String {
        switch self {
        case .safe: "Ask for everything"
        case .edits: "Edits without asking"
        case .auto: "Full access"
        case .unknown(let value): value
        }
    }

    static let choices: [PermissionPolicy] = [.safe, .edits, .auto]
}

/// One thread type as a row of the grouped list: the glyph tinted and
/// stroked to the label's weight, the label, the desktop's hint. The list
/// draws the check.
struct ThreadTypeRow: View {
    let type: ThreadType

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: type.symbol)
                .font(.body.weight(.regular))
                .foregroundStyle(type.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(type.label)
                    .font(.body)
                    .foregroundStyle(.primary)
                Text(type.hint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The type list: a grouped section of ThreadTypeRows with the system's
/// check on the chosen one (an inline picker, so the rows highlight and
/// read as a list and not as buttons).
private struct ThreadTypeList: View {
    let types: [ThreadType]
    @Binding var type: ThreadType

    var body: some View {
        Section {
            Picker("Type", selection: $type) {
                ForEach(types, id: \.rawValue) { candidate in
                    ThreadTypeRow(type: candidate).tag(candidate)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
    }
}

/// The footer under a sheet's form: the host's refusal, else a hint.
private struct SheetFooter: View {
    let error: String?
    let hint: String?

    var body: some View {
        if let error {
            Text(error)
                .foregroundStyle(Tint.destructive)
        } else if let hint {
            Text(hint)
        }
    }
}

// MARK: - Start a build

/// The plan header's Start: Implementation or Orchestration, who builds it
/// and how hard it thinks, then the thread is created seeded from the plan
/// the way the desktop does it, and pushed.
struct StartBuildSheet: View {
    let client: EnvironmentClient
    let plan: SessionMeta
    let document: String?
    let onStarted: (SessionMeta) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var type: ThreadType = .implementation
    @State private var choice: CatalogChoice
    @State private var busy = false
    @State private var error: String?

    init(client: EnvironmentClient, plan: SessionMeta, document: String?, onStarted: @escaping (SessionMeta) -> Void) {
        self.client = client
        self.plan = plan
        self.document = document
        self.onStarted = onStarted
        _choice = State(initialValue: CatalogChoice(provider: plan.provider, model: plan.model, reasoning: plan.reasoning))
    }

    var body: some View {
        NavigationStack {
            Form {
                ThreadTypeList(types: [.implementation, .orchestration], type: $type)
                Section {
                    ModelReasoningRows(client: client, choice: choice)
                } footer: {
                    SheetFooter(error: error, hint: "Seeded from the plan, in \(URL(fileURLWithPath: plan.cwd).lastPathComponent).")
                }
            }
            .navigationTitle("Start building")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .font(.body.weight(.semibold))
                            .disabled(choice.model == nil)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
    }

    private func start() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        let tasks = PlanDoc.tasks(PlanDoc.sections(document ?? "")).count
        let draft = ThreadDraft.build(from: plan, type: type, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning, tasks: tasks)
        do {
            let built = try await client.createThread(draft)
            dismiss()
            onStarted(built)
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}

// MARK: - New thread

/// A thread from a workspace or a project: the type, the project (or none
/// for a chat in the workspace), the model and reasoning the host offers,
/// and the access policy when the key may grant it. Created, then pushed.
struct NewThreadSheet: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let onCreated: (SessionMeta) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var type: ThreadType = .chat
    @State private var projectId: String?
    @State private var permission: PermissionPolicy = .edits
    @State private var choice: CatalogChoice
    @State private var busy = false
    @State private var error: String?

    init(client: EnvironmentClient, workspace: WorkspaceMeta, project: ProjectMeta? = nil, onCreated: @escaping (SessionMeta) -> Void) {
        self.client = client
        self.workspace = workspace
        self.onCreated = onCreated
        _projectId = State(initialValue: project?.id)
        _type = State(initialValue: project == nil ? .chat : .implementation)
        _choice = State(initialValue: CatalogChoice(provider: .claude, model: "", reasoning: nil))
    }

    private var projects: [ProjectMeta] {
        client.projects.filter { $0.workspaceId == workspace.id && !$0.archived }
    }

    static let types: [ThreadType] = [.chat, .planning, .implementation, .orchestration, .research]

    var body: some View {
        NavigationStack {
            Form {
                ThreadTypeList(types: Self.types, type: $type)
                Section {
                    Picker("Project", selection: $projectId) {
                        Text("None").tag(String?.none)
                        ForEach(projects, id: \.id) { project in
                            Text(project.name).tag(String?.some(project.id))
                        }
                    }
                    .pickerStyle(.menu)
                    ModelReasoningRows(client: client, choice: choice)
                    if client.environment.allows(.approve) {
                        Picker("Access", selection: $permission) {
                            ForEach(PermissionPolicy.choices, id: \.rawValue) { policy in
                                Text(policy.label).tag(policy)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                } footer: {
                    SheetFooter(error: error, hint: projectId == nil ? "With no project the thread lives in \(workspace.name)." : nil)
                }
            }
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await create() } }
                            .font(.body.weight(.semibold))
                            .disabled(choice.model == nil)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
    }

    private func create() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        let policy: PermissionPolicy? = client.environment.allows(.approve) ? permission : nil
        let draft = ThreadDraft.thread(type: type, workspaceId: workspace.id, projectId: projectId, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning, permission: policy)
        do {
            let created = try await client.createThread(draft)
            dismiss()
            onCreated(created)
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}

// MARK: - Rename

/// A thread's title: one field with the current title selected, Save off
/// until it reads differently and is not blank. The row's new title arrives
/// with the `sessions` push; a refusal stays in the footer.
struct RenameSheet: View {
    let client: EnvironmentClient
    let session: SessionMeta
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(client: EnvironmentClient, session: SessionMeta) {
        self.client = client
        self.session = session
        _title = State(initialValue: session.title)
    }

    private var trimmed: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { !trimmed.isEmpty && trimmed != session.title && client.operateBlock == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { if valid { Task { await save() } } }
                        .onChange(of: title) { error = nil }
                } footer: {
                    SheetFooter(error: error, hint: client.operateBlock.map { $0.text(now: Date().timeIntervalSince1970 * 1000) })
                }
            }
            .navigationTitle("Rename")
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
                            .disabled(!valid)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
    }

    private func save() async {
        guard !busy, valid else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client.rename(session.id, title: trimmed)
            dismiss()
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}
