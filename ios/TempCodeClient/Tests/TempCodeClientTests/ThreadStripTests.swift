import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func ws(_ id: String, _ path: String, linkId: String? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: id, path: path, git: true, linkId: linkId, createdAt: 1)
}

private func project(_ id: String, _ workspaceId: String, linkId: String? = nil) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: id, mode: .worktree, branch: "tc/\(id)", cwd: "/wt/\(id)", archived: false, linkId: linkId, createdAt: 10)
}

private func meta(_ id: String, parentId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String = "/repo/a", status: SessionStatus = .idle, archived: Bool = false, pinned: Bool = false, isMaster: Bool? = nil, masterId: String? = nil, updatedAt: Int = 100) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: cwd, status: status, pinned: pinned, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, isMaster: isMaster, masterId: masterId, createdAt: 1, updatedAt: updatedAt)
}

private func host(_ id: String, workspaces: [WorkspaceMeta], projects: [ProjectMeta], sessions: [SessionMeta], seen: [String: SeenMark] = [:]) -> HomeHostInput {
    HomeHostInput(environmentId: id, name: id, floor: 0, workspaces: workspaces, projects: projects, sessions: sessions, seen: seen)
}

private func open(_ env: String, _ sid: String) -> Route { .thread(environmentId: env, sessionId: sid, seq: nil) }

/// `seen` marks every id as seen now, so an idle thread is dormant unless the test says otherwise.
private func seen(_ ids: [String]) -> [String: SeenMark] {
    Dictionary(uniqueKeysWithValues: ids.map { ($0, SeenMark(at: 1_000, seq: 1)) })
}

@Suite struct ThreadStripTests {
    private let workspace = ws("wa", "/repo/a")
    private let projects = [project("p1", "wa"), project("p2", "wa")]

    @Test func `the scope of a project thread is its project, and the chips are its live and pinned roots freshest first`() {
        let sessions = [
            meta("running", projectId: "p1", status: .running, updatedAt: 50),
            meta("pinned", projectId: "p1", pinned: true, updatedAt: 10),
            meta("waiting", projectId: "p1", status: .waiting, updatedAt: 90),
            meta("dormant", projectId: "p1", updatedAt: 80),
            meta("other-project", projectId: "p2", status: .running, updatedAt: 99)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["dormant", "pinned"]))]
        let scope = ThreadStrip.scope(for: open("h1", "running"), hosts: hosts)
        guard case .project(let project)? = scope?.kind else { Issue.record("expected a project scope"); return }
        #expect(project.project.id == "p1")
        #expect(scope?.lead == StripScope.Lead(environmentId: "h1", workspaceId: "wa", projectId: "p1"))
        let chips = ThreadStrip.chips(scope: scope!, open: open("h1", "running"))
        #expect(chips.map(\.meta.id) == ["waiting", "running", "pinned"])
        #expect(chips.map(\.selected) == [false, true, false])
    }

    @Test func `the open thread is kept at its recency slot even when dormant`() {
        let sessions = [
            meta("fresh", projectId: "p1", status: .running, updatedAt: 90),
            meta("me", projectId: "p1", updatedAt: 60),
            meta("old", projectId: "p1", status: .running, updatedAt: 30),
            meta("other-dormant", projectId: "p1", updatedAt: 70)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["me", "other-dormant"]))]
        let scope = ThreadStrip.scope(for: open("h1", "me"), hosts: hosts)!
        let chips = ThreadStrip.chips(scope: scope, open: open("h1", "me"))
        #expect(chips.map(\.meta.id) == ["fresh", "me", "old"])
        #expect(chips.first { $0.meta.id == "me" }?.selected == true)
        // Without the open thread, the dormant one is out.
        #expect(ThreadStrip.chips(scope: scope, open: nil).map(\.meta.id) == ["fresh", "old"])
    }

    @Test func `subagents, batch children and archived roots never appear`() {
        let sessions = [
            meta("root", projectId: "p1", status: .running, updatedAt: 90),
            meta("child", parentId: "root", projectId: "p1", status: .running, updatedAt: 95),
            meta("master", projectId: "p1", status: .watching, isMaster: true, updatedAt: 80),
            meta("batch-kid", projectId: "p1", status: .running, masterId: "master", updatedAt: 85),
            meta("archived", projectId: "p1", status: .running, archived: true, updatedAt: 99)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "root"), hosts: hosts)!
        #expect(ThreadStrip.chips(scope: scope, open: open("h1", "root")).map(\.meta.id) == ["root", "master"])
        // Even as the open thread, a batch child takes no chip.
        #expect(ThreadStrip.chips(scope: scope, open: open("h1", "batch-kid")).map(\.meta.id) == ["root", "master"])
    }

    @Test func `linked copies of a project mix into one strip, and the lead is the first host's copy`() {
        let a = host("h1", workspaces: [ws("wa", "/repo/a", linkId: "wl")], projects: [project("p1", "wa", linkId: "pl")], sessions: [meta("mac", projectId: "p1", status: .running, updatedAt: 50)])
        let b = host("h2", workspaces: [ws("wb", "/srv/a", linkId: "wl")], projects: [project("pb", "wb", linkId: "pl")], sessions: [meta("box", projectId: "pb", status: .running, updatedAt: 70)])
        let scope = ThreadStrip.scope(for: open("h2", "box"), hosts: [a, b])!
        #expect(scope.lead == StripScope.Lead(environmentId: "h1", workspaceId: "wa", projectId: "p1"))
        let chips = ThreadStrip.chips(scope: scope, open: open("h2", "box"))
        #expect(chips.map(\.id) == ["h2:box", "h1:mac"])
        #expect(chips.map(\.selected) == [true, false])
    }

    @Test func `a chat with no project scopes to its workspace's chats`() {
        let sessions = [
            meta("chat", workspaceId: "wa", status: .running, updatedAt: 50),
            meta("chat2", workspaceId: "wa", status: .waiting, updatedAt: 60),
            meta("in-project", projectId: "p1", status: .running, updatedAt: 70)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "chat"), hosts: hosts)!
        guard case .workspaceChats(let found) = scope.kind else { Issue.record("expected the workspace's chats"); return }
        #expect(found.name == "wa")
        #expect(scope.lead == StripScope.Lead(environmentId: "h1", workspaceId: "wa", projectId: nil))
        #expect(ThreadStrip.chips(scope: scope, open: open("h1", "chat")).map(\.meta.id) == ["chat2", "chat"])
    }

    @Test func `a loose chat scopes to its host's loose chats with no lead`() {
        let sessions = [
            meta("loose", cwd: "/tmp/x", status: .running, updatedAt: 50),
            meta("loose2", cwd: "/tmp/y", status: .running, updatedAt: 40),
            meta("chat", workspaceId: "wa", status: .running, updatedAt: 60)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "loose"), hosts: hosts)!
        #expect(scope.kind == .hostChats(environmentId: "h1"))
        #expect(scope.lead == nil)
        #expect(ThreadStrip.chips(scope: scope, open: open("h1", "loose")).map(\.meta.id) == ["loose", "loose2"])
    }

    @Test func `unseen rides on the chip and makes a settled thread live`() {
        let sessions = [meta("new", projectId: "p1", updatedAt: 500), meta("seen", projectId: "p1", updatedAt: 400)]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: ["seen": SeenMark(at: 1_000, seq: 1)])]
        let scope = ThreadStrip.scope(for: open("h1", "new"), hosts: hosts)!
        let chips = ThreadStrip.chips(scope: scope, open: open("h1", "new"))
        #expect(chips.map(\.meta.id) == ["new"])
        #expect(chips[0].unseen)
    }

    @Test func `no scope for another route or an unknown thread`() {
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: [])]
        #expect(ThreadStrip.scope(for: .settings, hosts: hosts) == nil)
        #expect(ThreadStrip.scope(for: nil, hosts: hosts) == nil)
        #expect(ThreadStrip.scope(for: open("h1", "gone"), hosts: hosts) == nil)
    }
}
