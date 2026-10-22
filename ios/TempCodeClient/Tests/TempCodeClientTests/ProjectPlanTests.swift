import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The document of src/shared/projectPlan.test.ts, verbatim, with its three
/// field spellings (`- Scope:`, `**Scope:**`, bare `Depends on:` / `Done-when:`).
private let doc = """
# Acme — project plan

## Goals
Ship the thing.

## Current state
Half built.

## Milestones

### [x] 1. Data model
- Scope: tables and migrations
- Dependencies: none
- Done when: the schema test passes

### [ ] 2. API
- **Scope:** the REST layer
- Dependencies: 1
- Done when: e2e passes

### 3. UI
Scope: screens
Depends on: 2
Done-when: the screens render

## Risks
- time

## Open questions
- none

"""

private func planThread(planPath: String? = "/repo/.temp-code/plans/project.md", projectId: String? = "p1") -> SessionMeta {
    SessionMeta(id: "pp", parentId: nil, projectId: projectId, workspaceId: "w1", threadType: .projectPlan, planPath: planPath, provider: .claude, model: "claude-opus-5-5", reasoning: .high, agentType: .implementer, title: "Project plan: Acme", cwd: "/repo", status: .idle, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: 1, updatedAt: 2)
}

private func fields(_ value: some Encodable) throws -> [String: JSONValue] {
    let data = try JSONEncoder().encode(value)
    guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data) else { throw TransportError.decoding(method: "test", detail: "not an object") }
    return fields
}

@Suite struct ProjectPlanPathTests {
    @Test func `names one file per project under .temp-code/plans`() {
        #expect(ProjectPlan.path(for: "/repo/") == "/repo/.temp-code/plans/project.md")
        #expect(ProjectPlan.path(for: "/repo") == "/repo/.temp-code/plans/project.md")
        #expect(ProjectPlan.isPlanPath("/repo/.temp-code/plans/project.md"))
        #expect(!ProjectPlan.isPlanPath("/repo/.temp-code/plan-abc.md"))
        #expect(!ProjectPlan.isPlanPath(nil))
    }

    @Test func `never lets a project plan auto-start a build; an ordinary plan may`() {
        #expect(!ProjectPlan.mayAutoStart(.projectPlan))
        #expect(ProjectPlan.mayAutoStart(.planning))
        #expect(!ProjectPlan.mayAutoStart(nil))
    }
}

@Suite struct ProjectPlanParseTests {
    @Test func `reads the title, every fixed section and the milestones with their fields`() {
        let plan = ProjectPlan.parse(doc)
        #expect(plan.title == "Acme — project plan")
        #expect(plan.missing.isEmpty)
        #expect(plan.status == nil)
        #expect(plan.sectionOrder == ["Goals", "Current state", "Milestones", "Risks", "Open questions"])
        #expect(plan.sections["Goals"] == "Ship the thing.")
        #expect(plan.milestones.map { [String($0.index), $0.title, String($0.done)] } == [["1", "Data model", "true"], ["2", "API", "false"], ["3", "UI", "false"]])
        let a = plan.milestones[0], b = plan.milestones[1], c = plan.milestones[2]
        #expect(a.scope == "tables and migrations")
        #expect(a.dependencies == "none")
        #expect(a.doneWhen == "the schema test passes")
        #expect(b.scope == "the REST layer")
        #expect(c.dependencies == "2")
        #expect(c.doneWhen == "the screens render")
        #expect(c.body == "Scope: screens\nDepends on: 2\nDone-when: the screens render")
    }

    @Test func `names the fixed sections a document lacks, case-insensitively`() {
        let plan = ProjectPlan.parse("# x\n\n## goals\nok\n\n## Milestones\n### A\n")
        #expect(plan.missing == ["Current state", "Risks", "Open questions"])
        #expect(plan.milestones.count == 1)
        #expect(plan.milestones[0].index == 1)
        #expect(plan.milestones[0].title == "A")
        #expect(!plan.milestones[0].done)
        #expect(!plan.milestones[0].hasDetails)
    }

    @Test func `ignores ### headings outside Milestones and inside code fences`() {
        let plan = ProjectPlan.parse("## Risks\n### not a milestone\n## Milestones\n```\n### fenced\n```\n### [ ] 1. Real\n")
        #expect(plan.milestones.map(\.title) == ["Real"])
    }

    @Test func `reads the frontmatter status without counting it as content`() {
        let plan = ProjectPlan.parse("---\nstatus: complete\ncompleted: 2026-10-21T00:00:00.000Z\n---\n# T\n## Milestones\n### [ ] 1. A\n")
        #expect(plan.status == .complete)
        #expect(plan.isComplete)
        #expect(plan.completedAt == "2026-10-21T00:00:00.000Z")
        #expect(plan.title == "T")
        #expect(plan.milestones[0].line == 6)
        #expect(ProjectPlan.isComplete("---\nstatus: in-progress\n---\n# T\n") == false)
        #expect(ProjectPlan.parse("---\nstatus: in-progress\n---\n# T\n").status == .inProgress)
        #expect(!ProjectPlan.isComplete(nil))
        #expect(!ProjectPlan.isComplete(doc))
    }

    @Test func `a document without frontmatter starts at line zero and keeps a rule as content`() {
        #expect(ProjectPlan.parse(doc).milestones[0].line == 10)
        let ruled = ProjectPlan.parse("# T\n\n---\n\n## Milestones\n### [ ] 1. A\n")
        #expect(ruled.status == nil)
        #expect(ruled.title == "T")
        #expect(ruled.milestones.count == 1)
    }
}

@Suite struct ProjectPlanTickTests {
    @Test func `counts progress and finds the next milestone in document order`() {
        let progress = ProjectPlan.progress(doc)
        #expect(progress.done == 1 && progress.total == 3)
        #expect(ProjectPlan.next(in: doc)?.index == 2)
        #expect(ProjectPlan.milestone(3, in: doc)?.title == "UI")
        #expect(ProjectPlan.milestone(9, in: doc) == nil)
        #expect(ProjectPlan.summary(doc) == "1 of 3 milestones done")
        #expect(ProjectPlan.summary("# t\n## Milestones\n### [x] 1. Only\n") == "1 of 1 milestone done")
        #expect(ProjectPlan.summary("# t\n## Milestones\n") == "Plan")
        #expect(ProjectPlan.summary(nil) == nil)
    }

    @Test func `the chip reads Plan until the plan is kept and has milestones`() {
        #expect(ProjectPlan.chipText(done: 3, total: 7, pinned: true) == "3/7")
        #expect(ProjectPlan.chipText(done: 3, total: 7, pinned: false) == "Plan")
        #expect(ProjectPlan.chipText(done: 0, total: 0, pinned: true) == "Plan")
    }

    @Test func `dependency chips split the field and drop the nothing words`() {
        #expect(ProjectPlan.dependencyChips(nil).isEmpty)
        #expect(ProjectPlan.dependencyChips("").isEmpty)
        #expect(ProjectPlan.dependencyChips("none").isEmpty)
        #expect(ProjectPlan.dependencyChips("None").isEmpty)
        #expect(ProjectPlan.dependencyChips("—").isEmpty)
        #expect(ProjectPlan.dependencyChips("-").isEmpty)
        #expect(ProjectPlan.dependencyChips("1, 2") == ["1", "2"])
        #expect(ProjectPlan.dependencyChips("milestone 1 and 2") == ["1", "2"])
        #expect(ProjectPlan.dependencyChips("Milestone 4, milestone 5") == ["4", "5"])
        #expect(ProjectPlan.dependencyChips("2") == ["2"])
    }

    @Test func `reconcile keeps only the optimistic ticks the document has not caught up with`() {
        let milestones = ProjectPlan.parse(doc).milestones
        let overlay = [1: true, 2: true, 9: false]
        let kept = ProjectPlan.reconcile(overlay: overlay, with: milestones)
        // 1 is done in the document too: landed, gone. 2 is still unticked there: stays. 9 is no milestone: gone.
        #expect(kept == [2: true])
        #expect(ProjectPlan.reconcile(overlay: [:], with: milestones).isEmpty)
        #expect(ProjectPlan.reconcile(overlay: [1: false], with: milestones) == [1: false])
    }
}

@Suite struct ProjectPlanBriefTests {
    @Test func `the briefs name the milestone, its fields and the plan file`() throws {
        let m = try #require(ProjectPlan.milestone(2, in: doc))
        let brief = ProjectPlan.planningBrief(planPath: "/repo/.temp-code/plans/project.md", milestone: m)
        #expect(brief.contains("Plan milestone 2 of the project plan at /repo/.temp-code/plans/project.md: \"API\""))
        #expect(brief.contains("Scope: the REST layer"))
        #expect(brief.contains("Dependencies: 1"))
        #expect(brief.contains("Done when: e2e passes"))
        #expect(brief.contains("plan ONLY this milestone"))
        let orch = ProjectPlan.orchestrationBrief(planPath: "/p/.temp-code/plans/project.md", milestone: m)
        #expect(orch.contains("Orchestrate milestone 2"))
        #expect(orch.contains("split this one milestone across subagents"))
        #expect(ProjectPlan.threadTitle(m) == "M2 · API")
    }

    @Test func `revise sends the desktop's default when nothing is typed, else the ask with the keep-the-ticks line`() {
        #expect(ProjectPlan.reviseText("") == ProjectPlan.reviseDefault)
        #expect(ProjectPlan.reviseText("  \n") == ProjectPlan.reviseDefault)
        #expect(ProjectPlan.reviseDefault.hasPrefix("Revise the project plan: re-read the project"))
        let text = ProjectPlan.reviseText(" drop milestone 5 ")
        #expect(text.hasPrefix("Revise the project plan: drop milestone 5\n\nKeep the milestone ticks that are there"))
        #expect(text.hasSuffix("call plan_complete again when the revision is settled."))
    }
}

@Suite struct MilestoneDraftTests {
    @Test func `a planning thread for a milestone inherits the plan's project, cwd and permission, and carries the brief`() throws {
        let plan = planThread()
        let m = try #require(ProjectPlan.milestone(2, in: doc))
        let draft = try #require(ThreadDraft.milestone(from: plan, milestone: m, kind: .planning, provider: .codex, model: "gpt-6.1-sol", reasoning: .high))
        #expect(draft.threadType == .planning)
        #expect(draft.title == "M2 · API")
        #expect(draft.brief == ProjectPlan.planningBrief(planPath: "/repo/.temp-code/plans/project.md", milestone: m))
        #expect(draft.planPath == nil)
        #expect(draft.goal == nil)
        #expect(draft.permission == .edits)
        #expect(draft.needs == .operate)
        let params = try fields(draft.params)
        #expect(params["threadType"] == .string("planning"))
        #expect(params["agentType"] == .string("implementer"))
        #expect(params["provider"] == .string("codex"))
        #expect(params["model"] == .string("gpt-6.1-sol"))
        #expect(params["reasoning"] == .string("high"))
        #expect(params["projectId"] == .string("p1"))
        #expect(params["workspaceId"] == .string("w1"))
        #expect(params["cwd"] == .string("/repo"))
        #expect(params["planPath"] == nil)
    }

    @Test func `an orchestration thread for a milestone carries the plan file and the done-when as its goal`() throws {
        let m = try #require(ProjectPlan.milestone(2, in: doc))
        let draft = try #require(ThreadDraft.milestone(from: planThread(), milestone: m, kind: .orchestration, provider: .claude, model: "claude-opus-5-5", reasoning: nil))
        #expect(draft.threadType == .orchestration)
        #expect(draft.planPath == "/repo/.temp-code/plans/project.md")
        #expect(draft.goal == "e2e passes")
        #expect(draft.title == "M2 · API")
        #expect(draft.brief == ProjectPlan.orchestrationBrief(planPath: "/repo/.temp-code/plans/project.md", milestone: m))
        let params = try fields(draft.params)
        #expect(params["agentType"] == .string("orchestrator"))
        #expect(params["planPath"] == .string("/repo/.temp-code/plans/project.md"))
        #expect(params["goal"] == .string("e2e passes"))
        #expect(params["reasoning"] == nil)
    }

    @Test func `no draft without a plan file or a project`() throws {
        let m = try #require(ProjectPlan.milestone(2, in: doc))
        #expect(ThreadDraft.milestone(from: planThread(planPath: nil), milestone: m, kind: .planning, provider: .claude, model: "m", reasoning: nil) == nil)
        #expect(ThreadDraft.milestone(from: planThread(projectId: nil), milestone: m, kind: .orchestration, provider: .claude, model: "m", reasoning: nil) == nil)
    }
}
