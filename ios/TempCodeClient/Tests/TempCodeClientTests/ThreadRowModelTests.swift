import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The row model's precedence rules: tasks over activity, a failure over
/// both, the master tag, what counts as running, and the child's defaults.
private func session(
    _ id: String = "t",
    parentId: String? = nil,
    title: String = "Ship it",
    model: String = "claude-sonnet-5-5",
    status: SessionStatus = .idle,
    activity: String? = nil,
    tasks: SessionMeta.Tasks? = nil,
    failure: Failure? = nil,
    treeHasLiveWork: Bool? = nil,
    isMaster: Bool? = nil,
    pinned: Bool = false,
    busySince: Int? = nil,
    updatedAt: Int = 100
) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: nil, workspaceId: nil, threadType: .implementation, planPath: nil, provider: .claude, model: model, reasoning: .low, agentType: .explorer, title: title, cwd: "/repo", status: status, pinned: pinned, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: busySince, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, activity: activity, tasks: tasks, failure: failure, treeHasLiveWork: treeHasLiveWork, isMaster: isMaster, createdAt: 1, updatedAt: updatedAt)
}

private let rateLimited = Failure(kind: .rateLimited, account: nil, summary: "Rate limited by Anthropic", cause: "429")

@Suite struct ThreadRowModelDetailTests {
    @Test func `tasks with a current task read as count and task`() {
        let meta = session(tasks: .init(done: 3, total: 7, current: "Writing tests"))
        #expect(ThreadRowModel.detail(of: meta) == "3/7 Writing tests")
    }

    @Test func `tasks without a current task read as the count`() {
        #expect(ThreadRowModel.detail(of: session(tasks: .init(done: 3, total: 7))) == "3/7")
        #expect(ThreadRowModel.detail(of: session(tasks: .init(done: 3, total: 7, current: ""))) == "3/7")
    }

    @Test func `no tasks falls to the activity, and an empty activity to nothing`() {
        #expect(ThreadRowModel.detail(of: session(activity: "Queued · waiting for Backfill", tasks: .init(done: 0, total: 0))) == "Queued · waiting for Backfill")
        #expect(ThreadRowModel.detail(of: session(activity: "")) == nil)
        #expect(ThreadRowModel.detail(of: session()) == nil)
    }
}

@Suite struct ThreadRowModelSecondLineTests {
    @Test func `a failure wins over the tasks`() {
        let row = ThreadRowModel(session: session(status: .error, tasks: .init(done: 3, total: 7, current: "Writing tests"), failure: rateLimited))
        #expect(row.failure == "Rate limited by Anthropic")
        #expect(row.detail == "3/7 Writing tests")
        #expect(row.secondLine == .failure("Rate limited by Anthropic"))
    }

    @Test func `without a failure the line is the detail`() {
        #expect(ThreadRowModel(session: session(activity: "Reading")).secondLine == .detail("Reading"))
        #expect(ThreadRowModel(session: session()).secondLine == .detail(nil))
    }

    @Test func `the model reads short`() {
        #expect(ThreadRowModel(session: session(model: "gpt-6.1-sol")).model == "GPT-6.1 Sol")
    }
}

@Suite struct ThreadRowModelTagTests {
    @Test func `a pinned master carries the Master tag and nothing else does`() {
        #expect(ThreadRowModel(session: session(isMaster: true)).tag == "Master")
        #expect(ThreadRowModel(session: session(isMaster: false)).tag == nil)
        #expect(ThreadRowModel(session: session()).tag == nil)
    }
}

@Suite struct ThreadRowModelRunningTests {
    @Test(arguments: [SessionStatus.running, .starting])
    func `running and starting are live`(status: SessionStatus) {
        #expect(ThreadRowModel(session: session(status: status)).running)
    }

    @Test func `a settled root whose subagents still work is live`() {
        #expect(ThreadRowModel(session: session(status: .idle, treeHasLiveWork: true)).running)
        #expect(!ThreadRowModel(session: session(status: .idle)).running)
    }

    @Test(arguments: [SessionStatus.watching, .queued, .stopped, .waiting, .error, .paused])
    func `watching, queued, stopped, waiting, failed and paused are not`(status: SessionStatus) {
        #expect(!ThreadRowModel(session: session(status: status, treeHasLiveWork: true)).running)
    }

    @Test func `the row carries what the time needs`() {
        let row = ThreadRowModel(session: session(status: .running, pinned: true, busySince: 50, updatedAt: 90))
        #expect(row.busySince == 50)
        #expect(row.updatedAt == 90)
        #expect(row.pinned)
        #expect(row.status == .running)
    }
}

@Suite struct ThreadRowModelChildTests {
    @Test func `a child takes the agent glyph and a default title`() {
        let row = ThreadRowModel(session: session(parentId: "root", title: ""))
        #expect(row.agent == .explorer)
        #expect(row.title == "Subagent")
    }

    @Test func `a root keeps its type and defaults to Untitled`() {
        let row = ThreadRowModel(session: session(title: ""))
        #expect(row.agent == nil)
        #expect(row.type == .implementation)
        #expect(row.title == "Untitled")
    }

    @Test func `a titled child keeps its title`() {
        #expect(ThreadRowModel(session: session(parentId: "root", title: "Find the leak")).title == "Find the leak")
    }
}

@Suite struct ThreadRowModelEmphasisTests {
    @Test func `emphasis follows unseen`() {
        #expect(ThreadRowModel(session: session(), unseen: true).emphasized)
        #expect(!ThreadRowModel(session: session(), unseen: false).emphasized)
        #expect(!ThreadRowModel(session: session()).emphasized)
    }

    @Test func `the memberwise init takes every slot a sibling composes`() {
        let row = ThreadRowModel(title: "Backfill", status: .queued, model: "Sonnet 5.5 · work", detail: "Queued · waiting for Ship it", tag: "Master", updatedAt: 1)
        #expect(row.secondLine == .detail("Queued · waiting for Ship it"))
        #expect(row.tag == "Master")
        #expect(!row.running && !row.pinned && row.agent == nil && row.type == nil)
    }
}
