import SwiftUI
import TempCodeClient
import TempCodeContract

/// A `.sheet` on a menu item never presents (the menu dismisses the item
/// first), so the item asks the root to present instead. One instance lives
/// in the environment from `RootView`. The target is the copy the settings
/// live on (`ProjectLinks.target`); nil presents nothing.
@Observable
final class ProjectSettingsPresenter {
    var target: SettingsTarget?
}

/// "Project settings…" in the project header's menu (Home's slot). A linked
/// project's settings live on the box, so the sheet opens on the box's copy
/// whichever copy the menu was opened on.
struct ProjectSettingsMenuItem: View {
    let client: EnvironmentClient
    let project: ProjectMeta
    @Environment(ProjectSettingsPresenter.self) private var presenter
    @Environment(AppModel.self) private var app

    var body: some View {
        Button("Project settings…", systemImage: "slider.horizontal.3") {
            let registry = app.registry
            let hosts = registry.ordered.map { (environmentId: $0.environment.id, projects: $0.projects) }
            presenter.target = ProjectLinks.target(for: project, on: client.environment.id, hosts: hosts) { registry.platform($0) }
        }
    }
}

/// What the sheet loads, edits and saves: the review and plan drafts, the
/// catalog and the rules behind their pickers. One Save for both; only the
/// dirty draft is sent, review first.
@Observable
final class ProjectSettingsModel {
    enum Part {
        case review
        case plans
    }

    var review: ReviewDraft?
    var plans: PlanDraft?
    var catalog: Catalog?
    var rules: OrchestrationRules?
    var loading = true
    var loadError: String?
    var saving = false
    var saveError: String?
    /// The part whose save failed; its footer carries `saveError`.
    var failed: Part?

    var dirty: Bool { (review?.dirty ?? false) || (plans?.dirty ?? false) }

    func load(client: EnvironmentClient, projectId: String) async {
        loading = true
        loadError = nil
        async let reviewScope = client.loadReviewScope(projectId: projectId)
        async let planScope = client.loadPlanScope(projectId: projectId)
        async let globalPlans = try? client.loadPlanScope(projectId: nil)
        async let loadedCatalog = client.loadCatalog()
        async let loadedRules = client.loadRules()
        do {
            let (reviewed, planned) = try await (reviewScope, planScope)
            review = ReviewDraft(scope: reviewed)
            plans = PlanDraft(scope: planned, global: (await globalPlans)?.settings)
        } catch {
            loadError = (error as? ActionError)?.message ?? String(describing: error)
        }
        catalog = await loadedCatalog
        rules = await loadedRules
        loading = false
    }

    /// Saves the dirty drafts; true when everything landed.
    func save(client: EnvironmentClient, projectId: String) async -> Bool {
        guard !saving else { return false }
        saving = true
        saveError = nil
        failed = nil
        defer { saving = false }
        if let review, review.dirty {
            do {
                try await client.saveReview(projectId: projectId, settings: review.payload)
            } catch {
                failed = .review
                saveError = (error as? ActionError)?.message ?? String(describing: error)
                return false
            }
        }
        if let plans, plans.dirty {
            do {
                try await client.savePlans(projectId: projectId, settings: plans.payload)
            } catch {
                failed = .plans
                saveError = (error as? ActionError)?.message ?? String(describing: error)
                return false
            }
        }
        return true
    }
}

/// Project settings from the project header's menu: the preamble, review
/// before merge and the plan flow, as the desktop's project dialog has
/// them, one sheet at the large detent. `client` is the settings home's
/// (the box's copy of a linked project): every read and save goes there.
/// A key without admin, or a home out of reach, sees every control disabled
/// with the reason once, at the top; a linked project's last footer says
/// where the save lands.
struct ProjectSettingsSheet: View {
    let client: EnvironmentClient
    let target: SettingsTarget
    @Environment(\.dismiss) private var dismiss
    @State private var model = ProjectSettingsModel()

    private var projectId: String { target.home.projectId }
    private var project: ProjectMeta? { client.projects.first { $0.id == projectId } }
    private var workspace: WorkspaceMeta? { client.workspaces.first { $0.id == project?.workspaceId } }
    private var readOnly: Bool { client.adminBlock != nil }
    private var hostName: String { client.environment.name }
    /// Why the home cannot be read right now: its link, never the key.
    private var readBlock: ActionBlock? { Actions.block(status: client.status, environment: client.environment, needs: .read) }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(project?.name ?? "Project")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: PreambleScope.self) { PreambleEditor(client: client, scope: $0) }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if model.saving {
                            ProgressView()
                        } else {
                            Button("Save") {
                                Task {
                                    if await model.save(client: client, projectId: projectId) { dismiss() }
                                }
                            }
                            .disabled(!model.dirty || readOnly)
                        }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet)
        .interactiveDismissDisabled(model.saving)
        // Loads once the home's link is up; a reconnect after the load keeps the drafts.
        .task(id: readBlock == nil) {
            guard readBlock == nil, model.review == nil else { return }
            await model.load(client: client, projectId: projectId)
        }
        .accessibilityIdentifier("project-settings")
    }

    @ViewBuilder
    private var content: some View {
        if model.review == nil, let reason = target.saveReason(readBlock, hostName: hostName, now: Date().timeIntervalSince1970 * 1000) {
            // The home is out of reach before anything loaded: the reason, and the load runs when it is back.
            Text(reason)
                .textStep(.meta)
                .multilineTextAlignment(.center)
                .padding(Layout.textEdge)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.loading {
            ProgressView()
                .controlSize(.regular)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.loadError {
            VStack(spacing: 12) {
                Text(error)
                    .textStep(.meta)
                    .multilineTextAlignment(.center)
                PillButton("Retry") { Task { await model.load(client: client, projectId: projectId) } }
            }
            .padding(Layout.textEdge)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                if let reason = target.saveReason(client.adminBlock, hostName: hostName, now: Date().timeIntervalSince1970 * 1000) {
                    Section {} footer: {
                        Text(reason)
                    }
                }
                if let project {
                    Section {
                        NavigationLink(value: PreambleScope.project(projectId: project.id, workspaceId: project.workspaceId)) {
                            LabeledContent("Project rules") {
                                Text(TempCodeClient.PreambleRow.summary(project: project, workspace: workspace))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityIdentifier("preamble-project")
                        if let workspace {
                            NavigationLink(value: PreambleScope.workspace(workspaceId: workspace.id)) {
                                LabeledContent("Workspace default") {
                                    Text(TempCodeClient.PreambleRow.summary(workspace: workspace))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityIdentifier("preamble-workspace")
                        }
                    } header: {
                        Text("Preamble")
                    } footer: {
                        Text("Opens every new thread in \(project.name) as its project rules.")
                    }
                }
                if model.review != nil {
                    ReviewSettingsSection(model: model)
                        .disabled(readOnly)
                }
                if model.plans != nil {
                    PlanSettingsSection(model: model)
                        .disabled(readOnly)
                }
                if !readOnly, let footer = target.footer(hostName: hostName) {
                    Section {} footer: {
                        Text(footer)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
        }
    }
}
