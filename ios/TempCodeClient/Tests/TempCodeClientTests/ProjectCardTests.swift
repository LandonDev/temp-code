import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The workspace screen's project card: the desktop's `cardLines`,
/// `cardCounts`, `masterBlock` and `projectCardStatus` (src/renderer/src/lib/
/// sidebarRows.ts, projectCardModel.ts), with the phone's needs-you and failed
/// lines at the top.
private func ws(_ id: String, linkId: String? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: id, path: "/repo/\(id)", git: true, linkId: linkId, createdAt: 1)
}

private func project(_ id: String, _ workspaceId: String = "wa", branch: String? = "tc/main", mode: ProjectMode = .worktree, linkId: String? = nil) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: id, mode: mode, branch: branch, cwd: "/wt/\(id)", archived: false, linkId: linkId, createdAt: 10)
}

private func meta(
    _ id: String, projectId: String? = "p1", parentId: String? = nil, status: SessionStatus = .idle, type: ThreadType = .chat,
    archived: Bool = false, pinned: Bool = false, updatedAt: Int = 100, busySince: Int? = nil, frozen: Int? = nil,
    tasks: SessionMeta.Tasks? = nil, failure: String? = nil, statusDetail: String? = nil, agents: [String] = [],
    treeHasLiveWork: Bool? = nil, treeHasPaused: Bool? = nil, treeCanContinue: Bool? = nil,
    isMaster: Bool? = nil, masterId: String? = nil
) -> SessionMeta {
    SessionMeta(
        id: id, parentId: parentId, projectId: projectId, workspaceId: nil, threadType: type, planPath: nil, provider: .claude,
        model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/repo/wa", status: status,
        pinned: pinned, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false,
        busySince: busySince, pausedAt: nil, frozenActiveElapsed: frozen, nativeId: nil, statusDetail: statusDetail,
        background: agents.isEmpty ? nil : SessionMeta.Background(tasks: [], agents: agents, batch: nil, watchingSince: nil),
        tasks: tasks, failure: failure.map { Failure(kind: .harnessCrashed, account: nil, summary: $0, cause: "") },
        treeCanContinue: treeCanContinue, treeHasLiveWork: treeHasLiveWork, treeHasPaused: treeHasPaused,
        isMaster: isMaster, masterId: masterId, createdAt: 1, updatedAt: updatedAt
    )
}

private func host(_ sessions: [SessionMeta], env: String = "env_a", projects: [ProjectMeta] = [project("p1")], workspaces: [WorkspaceMeta] = [ws("wa")], seen: [String: SeenMark] = [:]) -> HomeHostInput {
    HomeHostInput(environmentId: env, name: env, floor: 10_000, workspaces: workspaces, projects: projects, sessions: sessions, seen: seen)
}

private func card(seen: [String: SeenMark] = [:], _ sessions: [SessionMeta], shown: (environmentId: String, sessionId: String)? = nil) throws -> ProjectCard {
    let screen = try #require(HomeSections.workspace("env_a:wa", hosts: [host(sessions, seen: seen)], shown: shown))
    return try #require(screen.projects.first)
}

private func kinds(_ card: ProjectCard) -> [String] {
    card.lines.map { line in
        switch line {
        case .needsYou(let t): "needs:\(t.meta.id)"
        case .failed(let t): "failed:\(t.meta.id)"
        case .master(let b): "master:\(b.master.meta.id)"
        case .working(let t): "working:\(t.meta.id)"
        case .paused(let t): "paused:\(t.meta.id)"
        case .unread(let t): "unread:\(t.meta.id)"
        }
    }
}

@Suite struct ProjectCardTests {
    @Test func `the head reads the name, the branch line and the mode`() throws {
        let local = ProjectCards.card(HomeProject(id: "k", members: [.init(environmentId: "e", group: ProjectGroup(project: project("p1", branch: nil, mode: .local), threads: [], latest: 0, archivedCount: 0))]))
        #expect(local.name == "p1")
        #expect(local.branch == "local checkout")
        #expect(local.mode == "local")
        #expect(local.latest == 0)
        let worktree = try card([meta("a", updatedAt: 500)])
        #expect(worktree.branch == "tc/main")
        #expect(worktree.mode == "worktree")
        #expect(worktree.latest == 500)
    }

    @Test func `lines run needs you, failed, masters, working, paused, unread`() throws {
        let out = try card(seen: ["u": SeenMark(at: 0, seq: 0)], [
            meta("u", updatedAt: 900),
            meta("p", status: .paused, updatedAt: 800),
            meta("w", status: .running, updatedAt: 700),
            meta("m", status: .watching, updatedAt: 600, isMaster: true),
            meta("b", status: .running, updatedAt: 50, masterId: "m"),
            meta("f", status: .error, updatedAt: 500, failure: "The CLI died"),
            meta("q", status: .waiting, updatedAt: 400, statusDetail: "Approve Bash")
        ])
        #expect(kinds(out) == ["needs:q", "failed:f", "master:m", "working:w", "paused:p", "unread:u"])
        #expect(out.lines[0].thread.detail == "Approve Bash")
        #expect(out.lines[1].thread.detail == "The CLI died")
        #expect(out.counts.isEmpty, "every root has a line")
    }

    @Test func `needs you and failed are lines and never counted`() throws {
        let out = try card([meta("q", status: .waiting), meta("f", status: .error), meta("d", updatedAt: 1)])
        #expect(kinds(out) == ["needs:q", "failed:f"])
        #expect(out.counts.map(\.text) == ["1 dormant"])
        #expect(out.accessibilityLabel == "p1, 1 needs you, 1 failed")
    }

    @Test(arguments: [
        (SessionStatus.running, "working"), (.starting, "working"), (.watching, "working"), (.paused, "paused"),
        (.waiting, "needs"), (.error, "failed"), (.queued, "dormant"), (.stopped, "dormant"), (.done, "dormant")
    ])
    func `every state lands in its bucket`(status: SessionStatus, expected: String) throws {
        let out = try card([meta("a", status: status, updatedAt: 1)])
        if expected == "dormant" {
            #expect(out.lines.isEmpty)
            #expect(out.counts.map(\.text) == ["1 dormant"])
        } else {
            #expect(kinds(out) == ["\(expected):a"])
        }
    }

    @Test func `tree flags move a root: live work works, a paused tree pauses, recovery fails`() throws {
        let out = try card([
            meta("live", status: .idle, updatedAt: 3, treeHasLiveWork: true),
            meta("held", status: .running, updatedAt: 2, treeHasPaused: true),
            meta("broken", status: .idle, updatedAt: 1, treeCanContinue: true)
        ])
        #expect(kinds(out) == ["failed:broken", "working:live", "paused:held"])
        #expect(out.lines.first { $0.thread.meta.id == "live" }?.thread.state == .working)
    }

    @Test func `a settled root with live subagents reads watching`() {
        #expect(CardState.row(meta("a", status: .idle, agents: ["s1"])) == .watching)
        #expect(CardState.row(meta("a", status: .idle)) == .idle)
    }

    @Test func `the thread on screen and a thread housed in a master are never unread`() throws {
        let seen = ["x": SeenMark(at: 0, seq: 0)]
        let unread = try card(seen: seen, [meta("x", updatedAt: 100)])
        #expect(kinds(unread) == ["unread:x"])
        #expect(unread.accessibilityLabel == "p1, 1 unread")
        let shown = try card(seen: seen, [meta("x", updatedAt: 100)], shown: ("env_a", "x"))
        #expect(shown.lines.isEmpty)
        #expect(shown.counts.map(\.text) == ["1 dormant"])
        // A subagent on screen counts for its root.
        let child = try card(seen: seen, [meta("x", updatedAt: 100), meta("c", projectId: nil, parentId: "x")], shown: ("env_a", "c"))
        #expect(child.lines.isEmpty)
        // Housed: a settled, unseen batch thread is its master's tally, never a line of its own.
        let housed = try card([meta("m", status: .watching, isMaster: true), meta("b", status: .done, masterId: "m")])
        guard case .master(let block) = try #require(housed.lines.first) else { Issue.record("no block"); return }
        #expect(block.lines.isEmpty)
        #expect(block.done == 1)
        #expect(housed.lines.count == 1)
    }

    @Test func `pinned alone gives no line and no place`() throws {
        let out = try card([meta("pin", pinned: true, updatedAt: 1), meta("new", status: .running, updatedAt: 9), meta("old", status: .running, pinned: true, updatedAt: 2)])
        #expect(kinds(out) == ["working:new", "working:old"])
        #expect(out.counts.map(\.text) == ["1 dormant"])
    }

    @Test func `a master block leads working while its batch works, with the done tally`() throws {
        let out = try card([
            meta("m", status: .idle, isMaster: true),
            meta("b1", status: .running, updatedAt: 90, masterId: "m"),
            meta("b2", status: .waiting, updatedAt: 80, masterId: "m"),
            meta("b3", status: .done, masterId: "m"),
            meta("b4", status: .queued, masterId: "m"),
            meta("b5", status: .queued, masterId: "m"),
            meta("s", projectId: nil, parentId: "m", status: .running)
        ])
        guard case .master(let block) = try #require(out.lines.first) else { Issue.record("no block"); return }
        #expect(block.lead == .working)
        #expect(block.master.state == .idle)
        #expect(block.lines.map(\.thread.meta.id) == ["b2", "b1"], "loudest first")
        #expect(block.queued == 2)
        #expect(block.done == 1)
        #expect(block.total == 5)
        #expect(block.agents?.parts.map(\.text) == ["1 agent", "1 working"])
        #expect(out.counts.isEmpty, "the master and its batch have lines")
    }

    @Test func `a master's own louder state leads as itself, and a quiet master is dormant`() throws {
        #expect(ProjectCards.lead(.waiting, lines: [BatchLine(thread: CardThread(environmentId: "e", meta: meta("b", status: .running)))], agents: nil) == .waiting)
        #expect(ProjectCards.lead(.watching, lines: [], agents: nil) == .watching)
        let quiet = try card([meta("m", status: .idle, isMaster: true), meta("b", status: .done, masterId: "m")])
        #expect(quiet.lines.isEmpty)
        #expect(quiet.counts.map(\.text) == ["1 dormant"])
    }

    @Test func `a batch thread's subagents speak in the fleet's words`() throws {
        let out = try card([
            meta("m", status: .watching, isMaster: true),
            meta("b", status: .running, masterId: "m"),
            meta("s1", projectId: nil, parentId: "b", status: .waiting),
            meta("s2", projectId: nil, parentId: "b", status: .error)
        ])
        guard case .master(let block) = try #require(out.lines.first) else { Issue.record("no block"); return }
        let parts = try #require(block.lines.first?.agents?.parts)
        #expect(parts.map(\.text) == ["2 agents", "1 needs you", "1 failed"])
        #expect(parts.map(\.tone) == [.plain, .waiting, .failed])
    }

    @Test func `an implementation line carries its tally, paused its frozen elapsed`() throws {
        let out = try card([
            meta("i", status: .running, type: .implementation, busySince: 40, tasks: .init(done: 3, total: 7, current: "Write tests")),
            meta("c", status: .running, tasks: .init(done: 1, total: 2)),
            meta("p", status: .paused, frozen: 65_000, treeHasPaused: nil)
        ])
        let impl = try #require(out.lines.first { $0.thread.meta.id == "i" }).thread
        #expect(impl.tasks?.done == 3)
        #expect(impl.busySince == 40)
        #expect(try #require(out.lines.first { $0.thread.meta.id == "c" }).thread.tasks == nil, "a chat's tasks are not its work")
        #expect(try #require(out.lines.first { $0.thread.meta.id == "p" }).thread.pausedElapsed == 65_000)
        #expect(ProjectCards.showsElapsed(since: 1_000, now: 3_999) == false)
        #expect(ProjectCards.showsElapsed(since: 1_000, now: 4_000))
    }

    @Test func `the count line says dormant and archived, or No threads`() throws {
        let archived = try card([meta("d"), meta("gone", archived: true)])
        #expect(archived.counts.map(\.text) == ["1 dormant", "1 archived"])
        let none = try card([])
        #expect(none.counts.map(\.text) == ["No threads"])
        #expect(none.counts.first?.kind == ProjectCardCount.Kind.none)
        let onlyArchived = try card([meta("gone", archived: true)])
        #expect(onlyArchived.counts.map(\.text) == ["1 archived"])
    }

    @Test func `linked copies are one card with every host's lines`() throws {
        let pa = project("p1", linkId: "pl_1"), pb = project("q1", "wb", linkId: "pl_1")
        let hosts = [
            host([meta("a", status: .running, updatedAt: 10)], env: "env_a", projects: [pa], workspaces: [ws("wa", linkId: "wl_1")]),
            host([meta("b", projectId: "q1", status: .running, updatedAt: 20), meta("old", projectId: "q1", archived: true)], env: "env_b", projects: [pb], workspaces: [ws("wb", linkId: "wl_1")])
        ]
        let screen = try #require(HomeSections.workspace("link:wl_1", hosts: hosts))
        #expect(screen.projects.count == 1)
        let out = try #require(screen.projects.first)
        #expect(out.project.isLinked)
        #expect(out.lines.map(\.thread.id) == ["env_b:b", "env_a:a"])
        #expect(out.counts.map(\.text) == ["1 archived"])
    }

    @Test func `one page of lines, then N more`() throws {
        let many = (0..<40).map { meta("t\($0)", status: .running, updatedAt: $0) }
        let out = try card(many)
        #expect(out.lines.count == ProjectCards.page)
        #expect(out.hidden == 8)
        #expect(out.lines.first?.thread.meta.id == "t39")
    }

    @Test func `the workspace's chats keep their rows`() throws {
        let screen = try #require(HomeSections.workspace("env_a:wa", hosts: [host([meta("chat", projectId: nil), meta("a")])]))
        #expect(screen.chats.map(\.id) == ["thread:env_a:chat"])
        #expect(screen.projects.map(\.id) == ["env_a:p1"])
    }
}
