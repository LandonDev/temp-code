import SwiftUI
import TempCodeClient
import TempCodeContract

/// The preamble as its own screen, pushed from the project settings sheet:
/// Edit and Preview segments in the bar, the whole height for the text, and
/// a panel on the chrome step at the bottom with the switch, the live word
/// count, the variables and "Use workspace default". Save is the bar's
/// trailing item; a key without admin reads but cannot save.
struct PreambleEditor: View {
    enum Mode: Hashable {
        case edit
        case preview
    }

    /// The parse cache key for the preview, beside PlanView's negative document seqs.
    static let previewSeq = -3

    let client: EnvironmentClient
    let scope: PreambleScope
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: PreambleDraft
    @State private var mode: Mode = .edit
    @State private var saving = false
    @State private var error: String?
    @FocusState private var editing: Bool

    init(client: EnvironmentClient, scope: PreambleScope) {
        self.client = client
        self.scope = scope
        // A key that cannot save reads: Preview first, since a disabled editor cannot scroll.
        _mode = State(initialValue: client.adminBlock != nil ? .preview : .edit)
        switch scope {
        case .project(let projectId, _):
            let project = client.projects.first { $0.id == projectId }
            _draft = State(initialValue: PreambleDraft(saved: project?.preamble, enabled: project?.preambleEnabled))
        case .workspace(let workspaceId):
            let workspace = client.workspaces.first { $0.id == workspaceId }
            _draft = State(initialValue: PreambleDraft(saved: workspace?.preamble, enabled: workspace?.preambleEnabled))
        }
    }

    private var readOnly: Bool { client.adminBlock != nil }

    private var workspace: WorkspaceMeta? {
        switch scope {
        case .project(_, let workspaceId), .workspace(let workspaceId):
            client.workspaces.first { $0.id == workspaceId }
        }
    }

    private var project: ProjectMeta? {
        guard case .project(let projectId, _) = scope else { return nil }
        return client.projects.first { $0.id == projectId }
    }

    private var isProject: Bool {
        if case .project = scope { return true }
        return false
    }

    private var scopeKey: String {
        switch scope {
        case .project(let projectId, _): "project:\(projectId)"
        case .workspace(let workspaceId): "workspace:\(workspaceId)"
        }
    }

    /// The workspace's text a project with no text of its own falls back to.
    private var fallback: String? {
        guard isProject, let workspace else { return nil }
        return Preamble.normalize(workspace.preamble)
    }

    private var sampleVars: Preamble.Vars {
        let host = client.environment.name
        if let project { return Preamble.sampleVars(project: project, host: host) }
        if let workspace { return Preamble.sampleVars(workspace: workspace, host: host) }
        return Preamble.Vars(worktree: "thread", project: "", host: host)
    }

    var body: some View {
        ZStack {
            if mode == .edit {
                editor
                    .transition(.opacity)
            } else {
                preview
                    .transition(.opacity)
            }
        }
        .animation(Motion.crossFade, value: mode)
        .background(Surface.background)
        .safeAreaInset(edge: .bottom, spacing: 0) { panel }
        .navigationTitle(isProject ? "Preamble" : "Workspace preamble")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Mode", selection: $mode) {
                    Text("Edit").tag(Mode.edit)
                    Text("Preview").tag(Mode.preview)
                }
                .pickerStyle(.segmented)
                .frame(width: 168)
                .accessibilityIdentifier("preamble-mode")
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .disabled(!draft.dirty || readOnly)
                }
            }
            .highVisibility()
        }
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: "preamble:\(scopeKey)"))
        .task {
            // The push settles first; a keyboard rising mid-push stutters.
            guard mode == .edit, !readOnly else { return }
            try? await Task.sleep(for: .milliseconds(350))
            editing = true
        }
        .accessibilityIdentifier("preamble-editor")
    }

    // MARK: - Edit

    private var editor: some View {
        TextEditor(text: $draft.text)
            .font(.body)
            .scrollContentBackground(.hidden)
            // TextEditor's own 5 pt inset lands the text on the 16 pt edge.
            .padding(.horizontal, Layout.textEdge - 5)
            .focused($editing)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.sentences)
            .disabled(readOnly)
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("- Work in your own worktree: `git worktree add .claude/worktrees/{{worktree}} -b {{worktree}} master`.")
                        Text("- Run typecheck and the tests you touched; land with merge_branch.")
                        Text("- Never touch the user's checkout on {{host}}.")
                    }
                    .textStep(.meta)
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.top, 8)
                    .allowsHitTesting(false)
                }
            }
            .accessibilityIdentifier("preamble-text")
    }

    // MARK: - Preview

    private var preview: some View {
        let own = draft.normalized
        let text = own ?? fallback
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if own == nil, let fallback, let workspace {
                    Text("Empty: threads take the workspace default (\(Preamble.wordCount(fallback)) words\(workspace.preambleEnabled == false ? ", switched off" : ""))")
                        .textStep(.stamp)
                }
                if let text {
                    MarkdownView(seq: Self.previewSeq, text: Preamble.substitute(text, vars: sampleVars))
                        .textSelection(.enabled)
                } else {
                    Text("Nothing is prepended.")
                        .textStep(.meta)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .accessibilityIdentifier("preamble-preview")
    }

    // MARK: - The panel

    private var stateWord: String {
        draft.enabled ? (draft.words == 0 ? "Empty" : "\(draft.words) words") : "Off"
    }

    private var panel: some View {
        VStack(spacing: 0) {
            Hairline()
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: $draft.enabled) {
                    LabeledContent("Apply to new threads") {
                        Text(stateWord)
                            .numeric(draft.words)
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(readOnly)
                .accessibilityIdentifier("preamble-apply")
                if isProject, draft.normalized != nil {
                    Button("Use workspace default") { draft.text = "" }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.pressable)
                        .disabled(readOnly)
                }
                Text(variables)
                    .textStep(.stamp)
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Tint.destructive)
                        .transition(Motion.appear(reduced: reduceMotion))
                } else if let block = client.adminBlock {
                    Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                        .textStep(.stamp)
                }
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, 12)
        }
        .background(Surface.chrome)
        .animation(Motion.crossFade, value: error)
    }

    /// One sentence, the names in code: "{{worktree}} is a slug from the
    /// thread title, {{project}} the project name and {{host}} the machine
    /// the thread runs on, filled in when the thread starts."
    private var variables: AttributedString {
        var out = AttributedString()
        let all = Preamble.variables
        for (index, variable) in all.enumerated() {
            if index > 0 { out += AttributedString(index == all.count - 1 ? " and " : ", ") }
            var name = AttributedString("{{\(variable.name)}}")
            name.inlinePresentationIntent = .code
            out += name
            out += AttributedString(index == 0 ? " is \(variable.meaning)" : " \(variable.meaning)")
        }
        out += AttributedString(", filled in when the thread starts.")
        return out
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            try await client.setPreamble(scope, text: draft.normalized, enabled: draft.enabled)
            dismiss()
        } catch {
            self.error = (error as? ActionError)?.message ?? String(describing: error)
        }
    }
}
