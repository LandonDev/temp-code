import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func thread(_ id: String, type: ThreadType? = .planning, parentId: String? = nil, status: SessionStatus = .idle, archived: Bool = false, title: String = "Plan: Move the history", planCompletedAt: Int? = nil, implementationId: String? = nil, planThreadId: String? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: "p1", workspaceId: "w1", threadType: type, planPath: nil, provider: .claude, model: "claude-opus-5-5", reasoning: .high, agentType: .implementer, title: title, cwd: "/tmp/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, planCompletedAt: planCompletedAt, implementationId: implementationId, planThreadId: planThreadId, createdAt: 1, updatedAt: 2)
}

private func fields(_ value: some Encodable) throws -> [String: JSONValue] {
    let data = try JSONEncoder().encode(value)
    guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data) else { throw TransportError.decoding(method: "test", detail: "not an object") }
    return fields
}

@Suite struct PlanFlowStateTests {
    struct Row: Sendable {
        let status: SessionStatus
        let completed: Bool
        let buildId: String?
        /// nil: the build is not on this host; false: listed; true: listed and archived.
        let buildArchived: Bool?
        let expected: PlanFlowState
    }

    static let table: [Row] = [
        Row(status: .running, completed: false, buildId: nil, buildArchived: nil, expected: .open),
        Row(status: .idle, completed: false, buildId: nil, buildArchived: nil, expected: .open),
        Row(status: .running, completed: true, buildId: nil, buildArchived: nil, expected: .complete),
        Row(status: .starting, completed: true, buildId: nil, buildArchived: nil, expected: .complete),
        Row(status: .waiting, completed: true, buildId: nil, buildArchived: nil, expected: .complete),
        Row(status: .idle, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .done, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .error, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .paused, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .stopped, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .queued, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .watching, completed: true, buildId: nil, buildArchived: nil, expected: .waiting),
        Row(status: .idle, completed: true, buildId: "b1", buildArchived: false, expected: .started(buildId: "b1", title: "Move the history", type: .implementation)),
        Row(status: .running, completed: true, buildId: "b1", buildArchived: false, expected: .started(buildId: "b1", title: "Move the history", type: .implementation)),
        Row(status: .idle, completed: true, buildId: "b1", buildArchived: true, expected: .waiting),
        Row(status: .running, completed: true, buildId: "b1", buildArchived: true, expected: .complete),
        Row(status: .idle, completed: true, buildId: "elsewhere", buildArchived: nil, expected: .started(buildId: "elsewhere", title: nil, type: nil))
    ]

    @Test(arguments: table)
    func `the state follows the stamp, the status and the build`(row: Row) {
        let plan = thread("plan", status: row.status, planCompletedAt: row.completed ? 1 : nil, implementationId: row.buildId)
        let build = row.buildArchived.map { thread("b1", type: .implementation, archived: $0, title: "Move the history", planThreadId: "plan") }
        let state = PlanFlowState.of(plan) { $0 == "b1" ? build : nil }
        #expect(state == row.expected)
    }

    @Test func `a subagent planner and a cleared stamp are open`() {
        let child = thread("plan", parentId: "root", planCompletedAt: 1)
        #expect(PlanFlowState.of(child) { _ in nil } == .open)
        let reopened = thread("plan", status: .idle, planCompletedAt: nil, implementationId: nil)
        #expect(PlanFlowState.of(reopened) { _ in nil } == .open)
        let notAPlan = thread("chat", type: .chat, planCompletedAt: 1)
        #expect(PlanFlowState.of(notAPlan) { _ in nil } == .open)
    }

    @Test func `each state has its line, and open has none`() {
        #expect(PlanFlowState.open.line == nil)
        #expect(PlanFlowState.complete.line == "Plan complete")
        #expect(PlanFlowState.waiting.line == "Waiting for you to start the build")
        #expect(PlanFlowState.started(buildId: "b", title: nil, type: nil).line == "Build started")
    }

    @Test func `the row tag marks a complete plan with no build`() {
        #expect(PlanFlowState.rowTag(thread("p", planCompletedAt: 1)) == "Plan ready")
        #expect(PlanFlowState.rowTag(thread("p", planCompletedAt: 1, implementationId: "b1")) == nil)
        #expect(PlanFlowState.rowTag(thread("p", planCompletedAt: nil)) == nil)
        #expect(PlanFlowState.rowTag(thread("p", parentId: "root", planCompletedAt: 1)) == nil)
        #expect(PlanFlowState.rowTag(thread("p", type: .implementation, planCompletedAt: 1)) == nil)
    }
}

@Suite struct PlanOriginTests {
    @Test func `a build names the plan it came from, archived or not`() {
        let plan = thread("plan", archived: true, title: "Plan: Move the history")
        let build = thread("b1", type: .implementation, planThreadId: "plan")
        let origin = PlanOrigin.line(for: build) { $0 == "plan" ? plan : nil }
        #expect(origin?.planId == "plan")
        #expect(origin?.text == "Planned in Plan: Move the history")
    }

    @Test func `no plan id or an unknown plan gives no line`() {
        #expect(PlanOrigin.line(for: thread("b1", type: .implementation)) { _ in nil } == nil)
        #expect(PlanOrigin.line(for: thread("b1", type: .implementation, planThreadId: "gone")) { _ in nil } == nil)
    }
}

@Suite struct ImplementPlanParamsTests {
    @Test func `an orchestration start encodes its type, model and reasoning, and no rules`() throws {
        let params = Methods.PlanImplement.Params(sessionId: "plan", provider: .codex, model: "gpt-6.1-sol", reasoning: .high, context1m: nil, permission: nil, threadType: .init(.orchestration), goal: nil, threadRules: nil)
        let encoded = try fields(params)
        #expect(encoded["sessionId"] == .string("plan"))
        #expect(encoded["threadType"] == .string("orchestration"))
        #expect(encoded["provider"] == .string("codex"))
        #expect(encoded["model"] == .string("gpt-6.1-sol"))
        #expect(encoded["reasoning"] == .string("high"))
        #expect(encoded["threadRules"] == nil)
        #expect(encoded["goal"] == nil)
        #expect(Methods.PlanImplement.Params.ThreadType(.implementation) == .implementation)
        #expect(Methods.PlanImplement.Params.ThreadType(.chat) == .implementation)
    }
}
