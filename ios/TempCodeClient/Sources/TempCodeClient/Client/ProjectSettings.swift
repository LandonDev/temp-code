import Foundation
import TempCodeContract

// MARK: - Preamble (src/shared/preamble.ts)

/// The project preamble's pure side: the slug, the count, the substitution
/// and the precedence the desktop's projectPreamble.ts applies.
public enum Preamble {
    public static let variables: [(name: String, meaning: String)] = [
        ("worktree", "a slug from the thread title"),
        ("project", "the project name"),
        ("host", "the machine the thread runs on")
    ]

    public struct Vars: Sendable, Hashable {
        public var worktree: String
        public var project: String
        public var host: String

        public init(worktree: String, project: String, host: String) {
            self.worktree = worktree
            self.project = project
            self.host = host
        }
    }

    /// Longest slug: a branch and a worktree dir name that stay readable.
    public static let slugMax = 40

    /// `Project preambles: house rules once` → `project-preambles-house-rules-once`:
    /// lowercase ASCII words joined by dashes, cut at a word boundary under
    /// `slugMax`; a single word over the cap is cut to it; a title with no
    /// word at all gives `thread`.
    public static func worktreeSlug(_ title: String) -> String {
        let decomposed = title.decomposedStringWithCompatibilityMapping.lowercased()
        var words: [String] = []
        var current = ""
        for scalar in decomposed.unicodeScalars {
            // The TS strips U+0300–U+036F (combining marks) after NFKD; everything else that is not a-z0-9 splits.
            if (0x0300...0x036F).contains(scalar.value) { continue }
            if (0x61...0x7A).contains(scalar.value) || (0x30...0x39).contains(scalar.value) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty { words.append(current) }
        var out = ""
        for word in words {
            let next = out.isEmpty ? word : "\(out)-\(word)"
            if next.count > slugMax {
                if out.isEmpty { out = String(word.prefix(slugMax)) }
                break
            }
            out = next
        }
        return out.isEmpty ? "thread" : out
    }

    /// Words as a person counts them: runs of non-whitespace; 0 for blank.
    public static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    /// `{{name}}` (spaces inside the braces allowed) → the variable; an
    /// unknown name stays as written, so a stray brace pair never vanishes.
    public static func substitute(_ template: String, vars: Vars) -> String {
        template.replacing(/\{\{\s*([a-zA-Z]+)\s*\}\}/) { match in
            switch match.output.1 {
            case "worktree": vars.worktree
            case "project": vars.project
            case "host": vars.host
            default: String(match.output.0)
            }
        }
    }

    /// Stored text as the editor saves it: CRLF folded, trimmed, nil when empty.
    public static func normalize(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The template a project runs under: its own (when enabled), else the
    /// workspace's (when enabled), else nil. A project switched off carries
    /// nothing, whatever the workspace says.
    public static func effective(project: ProjectMeta?, workspace: WorkspaceMeta?) -> String? {
        guard let project, project.preambleEnabled != false else { return nil }
        if let own = normalize(project.preamble) { return own }
        guard let workspace, workspace.preambleEnabled != false else { return nil }
        return normalize(workspace.preamble)
    }

    /// The preview's sample values for a project on a host: a thread title
    /// does not exist yet, so the slug of the project's name stands in.
    public static func sampleVars(project: ProjectMeta, host: String) -> Vars {
        Vars(worktree: worktreeSlug(project.name), project: project.name, host: host)
    }

    /// The same for the workspace default, previewed with the workspace's name as the project.
    public static func sampleVars(workspace: WorkspaceMeta, host: String) -> Vars {
        Vars(worktree: worktreeSlug(workspace.name), project: workspace.name, host: host)
    }
}

/// Whose preamble the editor holds.
public enum PreambleScope: Sendable, Hashable {
    case project(projectId: String, workspaceId: String)
    case workspace(workspaceId: String)
}

/// What the editor holds: the text and the switch, dirty against what was saved.
public struct PreambleDraft: Sendable, Hashable {
    public var text: String
    public var enabled: Bool
    /// The saved text, normalized.
    public let savedText: String?
    public let savedEnabled: Bool

    /// `enabled` nil is on: the wire's default for a row that never set it.
    public init(saved: String?, enabled: Bool?) {
        savedText = Preamble.normalize(saved)
        savedEnabled = enabled ?? true
        text = savedText ?? ""
        self.enabled = savedEnabled
    }

    public var normalized: String? { Preamble.normalize(text) }
    public var words: Int { Preamble.wordCount(text) }
    public var dirty: Bool { normalized != savedText || enabled != savedEnabled }
}

/// The preamble rows' state words.
public enum PreambleRow {
    /// "212 words", "Off", "80 words from workspace", "Off in workspace", "None".
    public static func summary(project: ProjectMeta, workspace: WorkspaceMeta?) -> String {
        if project.preambleEnabled == false { return "Off" }
        if let own = Preamble.normalize(project.preamble) { return "\(Preamble.wordCount(own)) words" }
        if let workspace, let text = Preamble.normalize(workspace.preamble) {
            return workspace.preambleEnabled == false ? "Off in workspace" : "\(Preamble.wordCount(text)) words from workspace"
        }
        return "None"
    }

    /// "80 words", "Off", "None".
    public static func summary(workspace: WorkspaceMeta) -> String {
        if workspace.preambleEnabled == false { return "Off" }
        if let text = Preamble.normalize(workspace.preamble) { return "\(Preamble.wordCount(text)) words" }
        return "None"
    }
}

// MARK: - The orchestration rules' model policy (src/shared/rules.ts)

/// `modelApproved` over the generated rules: the policy under
/// "provider:model"; absent is approved; `orchestrators` approves only an
/// orchestrator role; anything else the host may say is not approved.
public enum RulesPolicy {
    public static func approves(_ rules: OrchestrationRules?, provider: ProviderId, model: String, orchestrator: Bool = false) -> Bool {
        guard let policy = rules?.models["\(provider.rawValue):\(model)"] else { return true }
        switch policy.approved {
        case .bool(let approved): return approved
        case .string(let word): return word == "orchestrators" && orchestrator
        case .unknown: return false
        }
    }
}

// MARK: - Reviews (src/shared/review.ts)

/// The reviewer picker's side of the review set.
public enum Reviewers {
    /// The two harnesses a reviewer runs in (the ones that reach report_findings).
    public static let providers: [ProviderId] = [.codex, .claude]

    public struct Option: Sendable, Hashable {
        public let model: String
        public let label: String
        public let approved: Bool

        public init(model: String, label: String, approved: Bool) {
            self.model = model
            self.label = label
            self.approved = approved
        }
    }

    /// The catalog's models of `provider` the orchestration rules approve for
    /// a thread (nil rules: all of them); a `current` model absent from the
    /// list is prepended as "<label> (not approved)" so the set stays visible.
    public static func options(provider: ProviderId, catalog: Catalog?, rules: OrchestrationRules?, current: String) -> [Option] {
        let models = catalog?[provider.rawValue]?.models ?? []
        var options = models
            .filter { RulesPolicy.approves(rules, provider: provider, model: $0.id) }
            .map { Option(model: $0.id, label: $0.label, approved: true) }
        if !current.isEmpty, !options.contains(where: { $0.model == current }) {
            let label = models.first { $0.id == current }?.label ?? current
            options.insert(Option(model: current, label: "\(label) (not approved)", approved: false), at: 0)
        }
        return options
    }

    /// The ladder of the chosen model from the catalog, empty when unknown.
    public static func ladder(provider: ProviderId, model: String, catalog: Catalog?) -> [Reasoning] {
        catalog?[provider.rawValue]?.models.first { $0.id == model }?.reasoning ?? []
    }

    /// The model's own default effort, when the catalog knows it.
    public static func defaultReasoning(provider: ProviderId, model: String, catalog: Catalog?) -> Reasoning? {
        catalog?[provider.rawValue]?.models.first { $0.id == model }?.defaultReasoning
    }

    public static let minutePresets = [5, 10, 15, 30, 60, 120, 240]

    /// The presets with `current` folded in, sorted.
    public static func minuteChoices(current: Int) -> [Int] {
        Array(Set(minutePresets + [current])).sorted()
    }

    /// The label the catalog gives a model, else its id.
    public static func modelLabel(provider: ProviderId, model: String, catalog: Catalog?) -> String {
        catalog?[provider.rawValue]?.models.first { $0.id == model }?.label ?? model
    }

    /// The desktop's reviewSummary as a phrase: "Off", or "Sonnet 5.5 holds
    /// on any finding, up to 10 min" ("on confirmed findings" when that is the bar).
    public static func summary(_ settings: ReviewSettings, catalog: Catalog?) -> String {
        guard settings.beforeMerge else { return "Off" }
        let model = modelLabel(provider: settings.provider, model: settings.model, catalog: catalog)
        let hold = settings.blockOn == .any ? "any finding" : "confirmed findings"
        return "\(model) holds on \(hold), up to \(settings.maxMinutes) min"
    }
}

/// A scope's review set as the sheet edits it: it follows the global set
/// until a field changes; "Use global setting" goes back.
public struct ReviewDraft: Sendable, Hashable {
    public var beforeMerge: Bool
    public var provider: ProviderId
    public var model: String
    public var reasoning: Reasoning
    public var blockOn: ReviewSettings.BlockOn
    public var maxMinutes: Int
    /// True while the project follows the global set (no override saved and nothing touched).
    public var follows: Bool
    public let scope: ReviewScope

    /// DEFAULT_REVIEW_SETTINGS; the wire always carries `settings`, so only `useGlobal` with no global set reads this.
    public static let defaults = ReviewSettings(beforeMerge: false, provider: .codex, model: "gpt-6.1-sol", reasoning: .high, blockOn: .confirmed, maxMinutes: 15)

    public init(scope: ReviewScope) {
        self.scope = scope
        follows = scope.override == nil
        beforeMerge = scope.settings.beforeMerge
        provider = scope.settings.provider
        model = scope.settings.model
        reasoning = scope.settings.reasoning
        blockOn = scope.settings.blockOn
        maxMinutes = scope.settings.maxMinutes
    }

    public var settings: ReviewSettings {
        ReviewSettings(beforeMerge: beforeMerge, provider: provider, model: model, reasoning: reasoning, blockOn: blockOn, maxMinutes: maxMinutes)
    }

    /// What review.set sends: nil to follow, the set to override.
    public var payload: ReviewSettings? { follows ? nil : settings }

    public var dirty: Bool {
        if follows { return scope.override != nil }
        return settings != scope.override
    }

    /// Any field edit leaves the global set; the fields keep their values.
    public mutating func touch() { follows = false }

    /// "Use global setting": back to the global set (or the defaults), following.
    public mutating func useGlobal() {
        apply(scope.global ?? Self.defaults)
        follows = true
    }

    private mutating func apply(_ set: ReviewSettings) {
        beforeMerge = set.beforeMerge
        provider = set.provider
        model = set.model
        reasoning = set.reasoning
        blockOn = set.blockOn
        maxMinutes = set.maxMinutes
    }

    /// Changing the provider resets the model to its first option and the
    /// reasoning to that model's default (the desktop's `set`).
    public mutating func choose(provider: ProviderId, options: (ProviderId) -> [Reviewers.Option], ladder: (ProviderId, String) -> [Reasoning], defaultReasoning: (ProviderId, String) -> Reasoning?) {
        self.provider = provider
        let first = options(provider).first?.model ?? ""
        model = first
        let steps = ladder(provider, first)
        reasoning = defaultReasoning(provider, first) ?? steps.first ?? reasoning
        follows = false
    }

    /// Changing the model clamps the reasoning to its ladder.
    public mutating func choose(model: String, ladder: [Reasoning], defaultReasoning: Reasoning?) {
        self.model = model
        if !ladder.isEmpty, !ladder.contains(reasoning) { reasoning = defaultReasoning ?? ladder[0] }
        follows = false
    }
}

// MARK: - Plans (src/shared/plans.ts)

/// A project's plan settings as the sheet edits them, following the global
/// set until a field changes.
public struct PlanDraft: Sendable, Hashable {
    public var autoImplement: Bool
    public var archiveAfterStart: Bool
    /// "" = the same model as the plan.
    public var implementModel: String
    public var implementReasoning: PlanSettings.ImplementReasoning
    public var implementContext: PlanSettings.ImplementContext
    public var follows: Bool
    public let scope: PlanScope
    /// The global set, for `useGlobal`; nil when the host answered none.
    public let global: PlanSettings?

    public static let defaults = PlanSettings(autoImplement: true, archiveAfterStart: true, implementModel: "", implementReasoning: .none, implementContext: .none)

    public init(scope: PlanScope, global: PlanSettings?) {
        self.scope = scope
        self.global = global
        follows = !scope.overridden
        autoImplement = scope.settings.autoImplement
        archiveAfterStart = scope.settings.archiveAfterStart
        implementModel = scope.settings.implementModel
        implementReasoning = scope.settings.implementReasoning
        implementContext = scope.settings.implementContext
    }

    public var settings: PlanSettings {
        PlanSettings(autoImplement: autoImplement, archiveAfterStart: archiveAfterStart, implementModel: implementModel, implementReasoning: implementReasoning, implementContext: implementContext)
    }

    /// What plans.set sends: nil to follow, the set to override.
    public var payload: PlanSettings? { follows ? nil : settings }

    public var dirty: Bool {
        if follows { return scope.overridden }
        return !scope.overridden || settings != scope.settings
    }

    public mutating func touch() { follows = false }

    public mutating func useGlobal() {
        let set = global ?? Self.defaults
        autoImplement = set.autoImplement
        archiveAfterStart = set.archiveAfterStart
        implementModel = set.implementModel
        implementReasoning = set.implementReasoning
        implementContext = set.implementContext
        follows = true
    }

    /// A fixed model: a fixed effort off its ladder goes back to "same as the plan".
    public mutating func choose(model: String, catalog: Catalog?) {
        implementModel = model
        let ladder = PlanBuild.ladder(model: model, catalog: catalog)
        if let level = Reasoning(implementReasoning), !ladder.contains(level) { implementReasoning = .none }
        follows = false
    }
}

extension Reasoning {
    /// The build's effort as a catalog level; nil for "same as the plan".
    public init?(_ level: PlanSettings.ImplementReasoning) {
        if level == .none { return nil }
        self.init(rawValue: level.rawValue)
    }

    /// The desktop's EFFORT_LABELS.
    public var title: String {
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

/// The build-model picker's side of the plan set.
public enum PlanBuild {
    public struct ModelOption: Sendable, Hashable {
        public let provider: ProviderId
        public let model: String
        public let label: String

        public init(provider: ProviderId, model: String, label: String) {
            self.provider = provider
            self.model = model
            self.label = label
        }
    }

    /// The desktop's provider order; providers it does not name follow, by label.
    public static let providerOrder: [ProviderId] = [.claude, .codex, .cursor, .grok, .opencode, .pi, .omp, .fx]

    /// Providers that have models, in the desktop's order.
    public static func providers(_ catalog: Catalog?) -> [ProviderInfo] {
        guard let catalog else { return [] }
        let named = providerOrder.compactMap { catalog[$0.rawValue] }.filter { !$0.models.isEmpty }
        let rest = catalog.values.filter { !providerOrder.contains($0.id) && !$0.models.isEmpty }.sorted { $0.label < $1.label }
        return named + rest
    }

    /// Every model of every provider, labelled with the model's own label
    /// (the provider is its own field, for a picker's section); an unknown
    /// current id is appended as itself.
    public static func modelOptions(catalog: Catalog?, current: String) -> [ModelOption] {
        var options = providers(catalog).flatMap { provider in
            provider.models.map { ModelOption(provider: provider.id, model: $0.id, label: $0.label) }
        }
        if !current.isEmpty, !options.contains(where: { $0.model == current }) {
            options.append(ModelOption(provider: .unknown(""), model: current, label: current))
        }
        return options
    }

    public static let allLevels: [Reasoning] = [.low, .medium, .high, .xhigh, .max, .ultra]

    /// The ladder of a fixed model; all six levels when none is fixed or the
    /// model is unknown (the desktop's `effortLadder` fallback).
    public static func ladder(model: String, catalog: Catalog?) -> [Reasoning] {
        guard !model.isEmpty, let catalog else { return allLevels }
        for provider in catalog.values {
            if let info = provider.models.first(where: { $0.id == model }), !info.reasoning.isEmpty { return info.reasoning }
        }
        return allLevels
    }

    /// The label the catalog gives a model, else its id.
    public static func modelLabel(_ model: String, catalog: Catalog?) -> String {
        guard let catalog else { return model }
        for provider in catalog.values {
            if let info = provider.models.first(where: { $0.id == model }) { return info.label }
        }
        return model
    }

    /// The desktop's planSettingsSummary as a phrase: "Auto-start" | "Start
    /// by hand", "with" the fixed model, then effort and context in
    /// parentheses: "Start by hand with GPT-6.1 Sol (Extra high, 1M context)".
    public static func summary(_ settings: PlanSettings, catalog: Catalog?) -> String {
        var text = settings.autoImplement ? "Auto-start" : "Start by hand"
        if !settings.implementModel.isEmpty { text += " with \(modelLabel(settings.implementModel, catalog: catalog))" }
        var fixed: [String] = []
        if let level = Reasoning(settings.implementReasoning) { fixed.append(level.title) }
        switch settings.implementContext {
        case ._1m: fixed.append("1M context")
        case ._200k: fixed.append("200k context")
        case .none, .unknown: break
        }
        return fixed.isEmpty ? text : "\(text) (\(fixed.joined(separator: ", ")))"
    }
}

// MARK: - The client calls

extension EnvironmentClient {
    /// Why the settings sheet is read-only, or nil: the key must be admin.
    public var adminBlock: ActionBlock? { Actions.block(status: status, environment: environment, needs: .admin) }

    public func loadReviewScope(projectId: String?) async throws -> ReviewScope {
        try await read { try await self.request(Methods.ReviewGet.self, .init(projectId: projectId.map { Patch<String>.set($0) })) }
    }

    /// Admin. `settings` nil makes the project follow the global set.
    public func saveReview(projectId: String?, settings: ReviewSettings?) async throws {
        try await admin { try await self.request(Methods.ReviewSet.self, .init(projectId: projectId.map { Patch<String>.set($0) }, settings: settings)) }
    }

    public func loadPlanScope(projectId: String?) async throws -> PlanScope {
        try await read { try await self.request(Methods.PlansGet.self, .init(projectId: projectId.map { Patch<String>.set($0) })) }
    }

    /// Admin. `settings` nil makes the project follow the global set.
    public func savePlans(projectId: String?, settings: PlanSettings?) async throws {
        try await admin { try await self.request(Methods.PlansSet.self, .init(projectId: projectId.map { Patch<String>.set($0) }, settings: settings)) }
    }

    /// Admin. `text` nil clears the scope's own text (a project then takes the workspace default).
    public func setPreamble(_ scope: PreambleScope, text: String?, enabled: Bool) async throws {
        try await admin {
            switch scope {
            case .project(let projectId, _):
                try await self.request(Methods.ProjectSetPreamble.self, .init(projectId: projectId, preamble: text, enabled: enabled))
            case .workspace(let workspaceId):
                try await self.request(Methods.WorkspaceSetPreamble.self, .init(workspaceId: workspaceId, preamble: text, enabled: enabled))
            }
        }
    }

    /// The host's orchestration rules (the global scope); nil when the host
    /// does not answer, and the reviewer list is then unfiltered.
    public func loadRules() async -> OrchestrationRules? {
        (try? await request(Methods.RulesGet.self, .init(workspaceId: nil)))?.rules
    }

    private func read<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch {
            throw ActionError.wrap(error)
        }
    }

    private func admin<T>(_ body: () async throws -> T) async throws {
        if let block = adminBlock { throw ActionError.blocked(block) }
        do {
            _ = try await body()
        } catch {
            throw ActionError.wrap(error)
        }
    }
}
