import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func project(_ name: String = "ios-project", preamble: String? = nil, enabled: Bool? = nil) -> ProjectMeta {
    ProjectMeta(id: "p1", workspaceId: "w1", name: name, mode: .local, branch: "master", cwd: "/repo/\(name)", archived: false, accountPins: nil, preamble: preamble, preambleEnabled: enabled, createdAt: 1)
}

private func workspace(_ name: String = "temp-code", preamble: String? = nil, enabled: Bool? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: "w1", name: name, path: "/repo", git: true, accountPins: nil, githubRepo: nil, githubRepoCheckedAt: nil, preamble: preamble, preambleEnabled: enabled, createdAt: 1)
}

private func model(_ id: String, _ label: String, _ reasoning: [Reasoning] = [.low, .medium, .high], `default`: Reasoning? = .medium) -> ModelInfo {
    ModelInfo(id: id, label: label, reasoning: reasoning, defaultReasoning: `default`, context: nil, speedTiers: nil, minCodexVersion: nil)
}

private let catalog: Catalog = [
    "claude": ProviderInfo(id: .claude, label: "Claude", models: [model("claude-fable-5-1", "Fable 5.1", [.low, .medium, .high, .xhigh, .max]), model("claude-sonnet-5-5", "Sonnet 5.5")], defaultModel: "claude-sonnet-5-5", experimental: nil),
    "codex": ProviderInfo(id: .codex, label: "Codex", models: [model("gpt-6.1-sol", "GPT-6.1 Sol", [.low, .medium, .high, .xhigh, .max], default: .high)], defaultModel: "gpt-6.1-sol", experimental: nil),
    "pi": ProviderInfo(id: .pi, label: "Pi", models: [], defaultModel: "", experimental: nil)
]

private func rules(_ models: [String: ModelPolicy]) -> OrchestrationRules {
    OrchestrationRules(conduct: .init(delegation: .strict, selfEdit: false, selfShell: true, verifyResults: true, escalate: true, useWorktrees: true, maxParallel: 4, maxAgents: 0), models: models, routing: [])
}

private let review = ReviewSettings(beforeMerge: true, provider: .claude, model: "claude-sonnet-5-5", reasoning: .medium, blockOn: .any, maxMinutes: 10)

private func reviewScope(override: ReviewSettings? = nil, global: ReviewSettings? = nil) -> ReviewScope {
    ReviewScope(override: override, global: global, settings: override ?? global ?? ReviewDraft.defaults, source: override != nil ? .project : global != nil ? .global : .default)
}

private let plansOff = PlanSettings(autoImplement: false, archiveAfterStart: true, implementModel: "", implementReasoning: .none, implementContext: .none)

@Suite struct PreambleTests {
    @Test(arguments: [
        ("Project preambles: house rules once per project", "project-preambles-house-rules-once-per"),
        ("Ünïcode titles with a very long sequence of words that never ends here", "unicode-titles-with-a-very-long-sequence"),
        ("…!!!", "thread"),
        ("", "thread"),
        (String(repeating: "x", count: 60), String(repeating: "x", count: 40))
    ])
    func `the worktree slug matches the host's`(title: String, slug: String) {
        #expect(Preamble.worktreeSlug(title) == slug)
        #expect(Preamble.worktreeSlug(title).count <= Preamble.slugMax)
    }

    @Test func `words are runs of non-whitespace`() {
        #expect(Preamble.wordCount("") == 0)
        #expect(Preamble.wordCount("   \n ") == 0)
        #expect(Preamble.wordCount("one two\n\nthree   four") == 4)
    }

    @Test func `normalize folds CRLF, trims, and empties to nil`() {
        #expect(Preamble.normalize("a\r\nb\r\n") == "a\nb")
        #expect(Preamble.normalize("  \n ") == nil)
        #expect(Preamble.normalize(nil) == nil)
        #expect(Preamble.normalize(" rules ") == "rules")
    }

    @Test func `substitution fills the three names and keeps the rest`() {
        let vars = Preamble.Vars(worktree: "fix-login", project: "ios-project", host: "box")
        #expect(Preamble.substitute("{{worktree}} in {{ project }} on {{host}}", vars: vars) == "fix-login in ios-project on box")
        #expect(Preamble.substitute("{{branch}} and {{}} stay", vars: vars) == "{{branch}} and {{}} stay")
    }

    @Test func `the effective template follows the project, then the workspace`() {
        #expect(Preamble.effective(project: project(preamble: "own"), workspace: workspace(preamble: "ws")) == "own")
        #expect(Preamble.effective(project: project(preamble: "own", enabled: false), workspace: workspace(preamble: "ws")) == nil)
        #expect(Preamble.effective(project: project(), workspace: workspace(preamble: "ws")) == "ws")
        #expect(Preamble.effective(project: project(), workspace: workspace(preamble: "ws", enabled: false)) == nil)
        #expect(Preamble.effective(project: nil, workspace: workspace(preamble: "ws")) == nil)
    }

    @Test func `the sample values slug the project's name`() {
        let vars = Preamble.sampleVars(project: project("Cosmic Web"), host: "box")
        #expect(vars == Preamble.Vars(worktree: "cosmic-web", project: "Cosmic Web", host: "box"))
        #expect(Preamble.sampleVars(workspace: workspace("temp-code"), host: "mac").project == "temp-code")
    }
}

@Suite struct PreambleDraftTests {
    @Test func `dirty follows the normalized text and the switch`() {
        var draft = PreambleDraft(saved: "rules\r\n", enabled: nil)
        #expect(!draft.dirty)
        #expect(draft.enabled)
        #expect(draft.text == "rules")
        draft.text = "rules  \n"
        #expect(!draft.dirty)
        draft.text = "new rules"
        #expect(draft.dirty)
        #expect(draft.words == 2)
        draft.text = "rules"
        #expect(!draft.dirty)
        draft.enabled = false
        #expect(draft.dirty)
    }

    @Test func `an empty draft saves nil`() {
        var draft = PreambleDraft(saved: nil, enabled: false)
        #expect(draft.normalized == nil)
        #expect(!draft.enabled)
        draft.text = "  "
        #expect(!draft.dirty)
    }
}

@Suite struct PreambleRowTests {
    @Test func `the project row's five words`() {
        #expect(PreambleRow.summary(project: project(preamble: "one two three"), workspace: nil) == "3 words")
        #expect(PreambleRow.summary(project: project(preamble: "one", enabled: false), workspace: workspace(preamble: "ws")) == "Off")
        #expect(PreambleRow.summary(project: project(), workspace: workspace(preamble: "a b")) == "Workspace default · 2 words")
        #expect(PreambleRow.summary(project: project(), workspace: workspace(preamble: "a b", enabled: false)) == "Workspace default · off")
        #expect(PreambleRow.summary(project: project(), workspace: workspace()) == "None")
    }

    @Test func `the workspace row's three words`() {
        #expect(PreambleRow.summary(workspace: workspace(preamble: "a b c d")) == "4 words")
        #expect(PreambleRow.summary(workspace: workspace(preamble: "a", enabled: false)) == "Off")
        #expect(PreambleRow.summary(workspace: workspace()) == "None")
    }
}

@Suite struct RulesPolicyTests {
    @Test func `absent is approved, false is not, orchestrators only for an orchestrator`() {
        let set = rules([
            "claude:claude-fable-5-1": ModelPolicy(approved: .string("orchestrators")),
            "codex:gpt-6.1-sol": ModelPolicy(approved: .bool(false)),
            "claude:claude-sonnet-5-5": ModelPolicy(approved: .bool(true))
        ])
        #expect(RulesPolicy.approves(nil, provider: .claude, model: "anything"))
        #expect(RulesPolicy.approves(set, provider: .claude, model: "claude-opus-5-5"))
        #expect(RulesPolicy.approves(set, provider: .claude, model: "claude-sonnet-5-5"))
        #expect(!RulesPolicy.approves(set, provider: .codex, model: "gpt-6.1-sol"))
        #expect(!RulesPolicy.approves(set, provider: .claude, model: "claude-fable-5-1"))
        #expect(RulesPolicy.approves(set, provider: .claude, model: "claude-fable-5-1", orchestrator: true))
        #expect(!RulesPolicy.approves(rules(["claude:x": ModelPolicy(approved: .unknown(.null))]), provider: .claude, model: "x"))
    }
}

@Suite struct ReviewersTests {
    @Test func `options are the catalog filtered by the rules, with the set's model kept first`() {
        let set = rules(["claude:claude-fable-5-1": ModelPolicy(approved: .string("orchestrators"))])
        let claude = Reviewers.options(provider: .claude, catalog: catalog, rules: set, current: "claude-sonnet-5-5")
        #expect(claude.map(\.model) == ["claude-sonnet-5-5"])
        #expect(claude.allSatisfy { $0.approved })
        let unfiltered = Reviewers.options(provider: .claude, catalog: catalog, rules: nil, current: "claude-sonnet-5-5")
        #expect(unfiltered.map(\.model) == ["claude-fable-5-1", "claude-sonnet-5-5"])
        let kept = Reviewers.options(provider: .claude, catalog: catalog, rules: set, current: "claude-fable-5-1")
        #expect(kept.first == Reviewers.Option(model: "claude-fable-5-1", label: "Fable 5.1 (not approved)", approved: false))
        #expect(kept.count == 2)
        let unknown = Reviewers.options(provider: .codex, catalog: catalog, rules: nil, current: "gpt-9")
        #expect(unknown.first?.label == "gpt-9 (not approved)")
        #expect(Reviewers.options(provider: .codex, catalog: nil, rules: nil, current: "").isEmpty)
    }

    @Test func `the ladder, the minute choices and the summary`() {
        #expect(Reviewers.ladder(provider: .codex, model: "gpt-6.1-sol", catalog: catalog) == [.low, .medium, .high, .xhigh, .max])
        #expect(Reviewers.ladder(provider: .codex, model: "nope", catalog: catalog).isEmpty)
        #expect(Reviewers.minuteChoices(current: 20) == [5, 10, 15, 20, 30, 60, 120, 240])
        #expect(Reviewers.minuteChoices(current: 15) == Reviewers.minutePresets)
        #expect(Reviewers.summary(ReviewDraft.defaults, catalog: catalog) == "Off")
        #expect(Reviewers.summary(review, catalog: catalog) == "Sonnet 5.5 · any finding · 10 min")
        #expect(Reviewers.summary(review, catalog: nil) == "claude-sonnet-5-5 · any finding · 10 min")
    }
}

@Suite struct ReviewDraftTests {
    @Test func `a project with no override follows; a touch makes it its own`() {
        var draft = ReviewDraft(scope: reviewScope(global: review))
        #expect(draft.follows)
        #expect(!draft.dirty)
        #expect(draft.payload == nil)
        draft.beforeMerge = false
        draft.touch()
        #expect(!draft.follows)
        #expect(draft.dirty)
        #expect(draft.payload?.beforeMerge == false)
        draft.useGlobal()
        #expect(draft.follows)
        #expect(!draft.dirty)
        #expect(draft.beforeMerge)
    }

    @Test func `use global on an existing override is dirty with a nil payload`() {
        var draft = ReviewDraft(scope: reviewScope(override: review, global: nil))
        #expect(!draft.follows)
        #expect(!draft.dirty)
        draft.maxMinutes = 30
        draft.touch()
        #expect(draft.dirty)
        draft.useGlobal()
        #expect(draft.follows)
        #expect(draft.dirty)
        #expect(draft.payload == nil)
        #expect(draft.settings == ReviewDraft.defaults)
    }

    @Test func `choosing a provider resets the model and the reasoning; choosing a model clamps the reasoning`() {
        var draft = ReviewDraft(scope: reviewScope(global: review))
        draft.choose(provider: .codex, options: { Reviewers.options(provider: $0, catalog: catalog, rules: nil, current: "") }, ladder: { Reviewers.ladder(provider: $0, model: $1, catalog: catalog) }, defaultReasoning: { Reviewers.defaultReasoning(provider: $0, model: $1, catalog: catalog) })
        #expect(draft.provider == .codex)
        #expect(draft.model == "gpt-6.1-sol")
        #expect(draft.reasoning == .high)
        #expect(!draft.follows)
        draft.reasoning = .max
        draft.choose(model: "claude-sonnet-5-5", ladder: [.low, .medium, .high], defaultReasoning: .medium)
        #expect(draft.model == "claude-sonnet-5-5")
        #expect(draft.reasoning == .medium)
        draft.choose(model: "other", ladder: [], defaultReasoning: nil)
        #expect(draft.reasoning == .medium)
    }
}

@Suite struct PlanDraftTests {
    @Test func `follow, touch and use global`() {
        var draft = PlanDraft(scope: PlanScope(settings: PlanDraft.defaults, overridden: false), global: nil)
        #expect(draft.follows)
        #expect(!draft.dirty)
        #expect(draft.payload == nil)
        draft.autoImplement = false
        draft.touch()
        #expect(draft.dirty)
        #expect(draft.payload?.autoImplement == false)
        draft.useGlobal()
        #expect(!draft.dirty)
        #expect(draft.autoImplement)

        var overridden = PlanDraft(scope: PlanScope(settings: plansOff, overridden: true), global: PlanDraft.defaults)
        #expect(!overridden.follows)
        #expect(!overridden.dirty)
        overridden.useGlobal()
        #expect(overridden.follows)
        #expect(overridden.dirty)
        #expect(overridden.payload == nil)
        #expect(overridden.autoImplement)
    }

    @Test func `a fixed model clamps a fixed effort off its ladder`() {
        var draft = PlanDraft(scope: PlanScope(settings: PlanDraft.defaults, overridden: false), global: nil)
        draft.implementReasoning = .ultra
        draft.choose(model: "gpt-6.1-sol", catalog: catalog)
        #expect(draft.implementModel == "gpt-6.1-sol")
        #expect(draft.implementReasoning == .none)
        #expect(!draft.follows)
        draft.implementReasoning = .high
        draft.choose(model: "", catalog: catalog)
        #expect(draft.implementReasoning == .high)
    }
}

@Suite struct PlanBuildTests {
    @Test func `model options follow the desktop's provider order and keep an unknown current id`() {
        let options = PlanBuild.modelOptions(catalog: catalog, current: "gpt-9")
        #expect(options.map(\.model) == ["claude-fable-5-1", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-9"])
        #expect(options[0].label == "Claude · Fable 5.1")
        #expect(options.last?.label == "gpt-9")
        #expect(PlanBuild.modelOptions(catalog: nil, current: "").isEmpty)
        #expect(PlanBuild.modelOptions(catalog: nil, current: "x").map(\.model) == ["x"])
    }

    @Test func `the ladder is the model's, or every level`() {
        #expect(PlanBuild.ladder(model: "claude-sonnet-5-5", catalog: catalog) == [.low, .medium, .high])
        #expect(PlanBuild.ladder(model: "", catalog: catalog) == PlanBuild.allLevels)
        #expect(PlanBuild.ladder(model: "nope", catalog: catalog) == PlanBuild.allLevels)
        #expect(PlanBuild.ladder(model: "gpt-6.1-sol", catalog: nil) == PlanBuild.allLevels)
    }

    @Test func `the summary reads the desktop's`() {
        #expect(PlanBuild.summary(PlanDraft.defaults, catalog: catalog) == "Auto-start")
        let fixed = PlanSettings(autoImplement: false, archiveAfterStart: false, implementModel: "gpt-6.1-sol", implementReasoning: .xhigh, implementContext: ._1m)
        #expect(PlanBuild.summary(fixed, catalog: catalog) == "Start by hand · GPT-6.1 Sol · Extra high · 1M")
        #expect(PlanBuild.summary(fixed, catalog: nil) == "Start by hand · gpt-6.1-sol · Extra high · 1M")
        let short = PlanSettings(autoImplement: true, archiveAfterStart: true, implementModel: "", implementReasoning: .none, implementContext: ._200k)
        #expect(PlanBuild.summary(short, catalog: catalog) == "Auto-start · 200k")
    }
}

@Suite struct AdminBlockTests {
    @Test func `a key without admin is blocked as noAdmin, before the socket`() {
        let open = EnvironmentStatus(transport: .open, fresh: true)
        let reader = PairedEnvironment(id: "env", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate, .approve], keyId: "K", keyName: "phone", addedAt: 0)
        #expect(Actions.block(status: open, environment: reader, needs: .admin) == .noAdmin)
        #expect(ActionBlock.noAdmin.text(now: 0) == "This key can read these settings but not change them")
        #expect(!ActionBlock.noAdmin.isTransient)
        let admin = PairedEnvironment(id: "env", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate, .approve, .admin], keyId: "K", keyName: "phone", addedAt: 0)
        #expect(Actions.block(status: open, environment: admin, needs: .admin) == nil)
        #expect(Actions.block(status: EnvironmentStatus(transport: .connecting), environment: admin, needs: .admin) == .connecting)
        #expect(ActionError.wrap(TransportError.server(method: "review.set", message: "forbidden: review.set needs admin")).message == ActionBlock.noAdmin.text(now: 0))
    }
}
