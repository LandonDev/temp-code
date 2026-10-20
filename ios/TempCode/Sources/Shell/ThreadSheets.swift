import SwiftUI
import TempCodeClient
import TempCodeContract

/// A provider and model as one choice in the catalog picker.
struct ModelKey: Hashable {
    var provider: ProviderId
    var model: String
}

/// The host's catalog as the sheets pick from it: providers in the
/// desktop's order with the models the host can run (the host already
/// hides what the installed CLI cannot), and the reasoning levels of the
/// chosen model. Loads once per client and keeps the choice valid.
@Observable
final class CatalogChoice {
    var key: ModelKey
    var reasoning: Reasoning?
    private(set) var catalog: Catalog?
    private(set) var loading = false

    init(provider: ProviderId, model: String, reasoning: Reasoning?) {
        key = ModelKey(provider: provider, model: model)
        self.reasoning = reasoning
    }

    static let providerOrder: [ProviderId] = [.claude, .codex, .cursor, .grok, .opencode, .pi, .omp, .fx]

    /// Providers that have models, in the desktop's order.
    var providers: [ProviderInfo] {
        guard let catalog else { return [] }
        return Self.providerOrder.compactMap { catalog[$0.rawValue] }.filter { !$0.models.isEmpty }
            + catalog.values.filter { !Self.providerOrder.contains($0.id) && !$0.models.isEmpty }.sorted { $0.label < $1.label }
    }

    var model: ModelInfo? {
        catalog?[key.provider.rawValue]?.models.first { $0.id == key.model }
    }

    var levels: [Reasoning] { model?.reasoning ?? [] }

    func load(_ client: EnvironmentClient) async {
        guard catalog == nil, !loading else { return }
        loading = true
        catalog = await client.loadCatalog()
        loading = false
        settle()
    }

    /// The choice stays on a model the host has; the reasoning on a level the model offers.
    func settle() {
        guard let catalog else { return }
        if model == nil, let first = providers.first {
            key = ModelKey(provider: first.id, model: first.defaultModel.isEmpty ? first.models[0].id : first.defaultModel)
        }
        _ = catalog
        if let reasoning, !levels.contains(reasoning) { self.reasoning = nil }
        if reasoning == nil { reasoning = model?.defaultReasoning ?? levels.first }
    }

    func choose(_ key: ModelKey) {
        self.key = key
        reasoning = nil
        settle()
    }
}

/// The model row and the reasoning row of a sheet, over the catalog.
struct ModelReasoningRows: View {
    let client: EnvironmentClient
    @Bindable var choice: CatalogChoice

    var body: some View {
        Group {
        if choice.catalog == nil {
            HStack {
                Text("Model")
                Spacer()
                if choice.loading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text("Unavailable")
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            Picker("Model", selection: Binding(get: { choice.key }, set: { choice.choose($0) })) {
                ForEach(choice.providers, id: \.id) { provider in
                    Section(provider.label) {
                        ForEach(provider.models, id: \.id) { model in
                            Text(model.label).tag(ModelKey(provider: provider.id, model: model.id))
                        }
                    }
                }
            }
            .pickerStyle(.navigationLink)
            if choice.levels.count > 1 {
                Picker("Reasoning", selection: Binding(get: { choice.reasoning ?? choice.levels[0] }, set: { choice.reasoning = $0 })) {
                    ForEach(choice.levels, id: \.rawValue) { level in
                        Text(level.label).tag(level)
                    }
                }
                .pickerStyle(.menu)
            }
        }
        }
        .task { await choice.load(client) }
    }
}

extension Reasoning {
    nonisolated var label: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        case .ultra: "Ultra"
        case .unknown(let value): value
        }
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

/// One thread type to choose: the glyph tinted, the label, the desktop's hint.
struct ThreadTypeRow: View {
    let type: ThreadType
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: type.symbol)
                .font(.subheadline)
                .foregroundStyle(type.tint)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(type.label)
                    .font(.body)
                Text(type.hint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if selected {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
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
                Section {
                    ForEach([ThreadType.implementation, .orchestration], id: \.rawValue) { candidate in
                        Button { type = candidate } label: {
                            ThreadTypeRow(type: candidate, selected: candidate == type)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Section {
                    ModelReasoningRows(client: client, choice: choice)
                } footer: {
                    if let error {
                        Text(error)
                            .foregroundStyle(Tint.destructive)
                    }
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
                            .disabled(choice.catalog == nil && choice.loading)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
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
                Section {
                    ForEach(Self.types, id: \.rawValue) { candidate in
                        Button { type = candidate } label: {
                            ThreadTypeRow(type: candidate, selected: candidate == type)
                        }
                        .buttonStyle(.plain)
                    }
                }
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
                    if let error {
                        Text(error)
                            .foregroundStyle(Tint.destructive)
                    } else if projectId == nil {
                        Text("With no project the thread lives in \(workspace.name).")
                    }
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
                            .disabled(choice.model == nil)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet)
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
