import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Home's sections from value inputs: the order, what is absent when empty,
/// the fold, the nested subagents, pairing across hosts and the host notes.
private func ws(_ id: String, _ path: String, repo: String? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: id, path: path, git: true, accountPins: nil, githubRepo: repo, githubRepoCheckedAt: nil, createdAt: 1)
}

private func project(_ id: String, _ workspaceId: String, archived: Bool = false) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: id, mode: .worktree, branch: "tc/\(id)", cwd: "/wt/\(id)", archived: archived, accountPins: nil, createdAt: 10)
}

private func meta(_ id: String, parentId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String = "/repo/a", status: SessionStatus = .idle, archived: Bool = false, createdAt: Int = 1, updatedAt: Int = 100, treeHasLiveWork: Bool? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: cwd, status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, treeHasLiveWork: treeHasLiveWork, createdAt: createdAt, updatedAt: updatedAt)
}

private func host(_ env: String, troubled: Bool = false, hasShell: Bool = true, workspaces: [WorkspaceMeta] = [], projects: [ProjectMeta] = [], sessions: [SessionMeta] = [], notes: [HomeNote] = []) -> HomeHostInput {
    HomeHostInput(environmentId: env, name: env.capitalized, troubled: troubled, hasShell: hasShell, floor: 0, workspaces: workspaces, projects: projects, sessions: sessions, seen: [:], notes: notes)
}

private func status(_ transport: TransportState, attempts: Int = 0, retry: Double? = nil) -> EnvironmentStatus {
    EnvironmentStatus(transport: transport, nextRetryAt: retry, attempts: attempts)
}

private let wa = ws("wa", "/repo/a")
private let p1 = project("p1", "wa")

private func sections(_ hosts: [HomeHostInput], folded: Set<String> = [], pairing: HomePairing = .none) -> [HomeSection] {
    HomeSections.build(hosts: hosts, folded: folded, pairing: pairing)
}

private func ids(_ out: [HomeSection]) -> [String] { out.map(\.id) }

@Suite struct HomeSectionsOrderTests {
    @Test func `lists status, needs you, running, then the workspaces, and leaves out what is empty`() {
        let sessions = [
            meta("wait", projectId: "p1", status: .waiting, updatedAt: 50),
            meta("run", projectId: "p1", status: .running, updatedAt: 60),
            meta("idle", projectId: "p1", updatedAt: 70)
        ]
        let out = sections([host("box", troubled: true, workspaces: [wa], projects: [p1], sessions: sessions)])
        #expect(ids(out) == ["status", "needs", "running", "workspace:box:wa"])
        #expect(out[1].header == .title("Needs you"))
        #expect(out[2].header == .title("Running"))
        #expect(out[1].rows.map(\.id) == ["needs:wait"])
        #expect(out[2].rows.map(\.id) == ["running:run"])
        #expect(out[3].rows.map(\.id) == ["project:box:p1", "thread:idle", "thread:run", "thread:wait"])
    }

    @Test func `a quiet home has no needs or running section`() {
        let out = sections([host("box", workspaces: [wa], projects: [p1], sessions: [meta("idle", projectId: "p1")])])
        #expect(ids(out) == ["calm", "workspace:box:wa"])
    }

    @Test func `needs you across hosts sorts longest waiting first and running newest first`() {
        let a = host("a", sessions: [meta("a-wait", status: .waiting, updatedAt: 300), meta("a-run", status: .running, updatedAt: 10)])
        let b = host("b", sessions: [meta("b-wait", status: .waiting, updatedAt: 100), meta("b-run", status: .running, updatedAt: 20)])
        let out = sections([a, b])
        #expect(out.first { $0.id == "needs" }?.rows.map(\.id) == ["needs:b-wait", "needs:a-wait"])
        #expect(out.first { $0.id == "running" }?.rows.map(\.id) == ["running:b-run", "running:a-run"])
        #expect(out.first { $0.id == "needs" }?.rows.map(\.environmentId) == ["b", "a"])
    }
}

@Suite struct HomeSectionsCalmTests {
    @Test func `the calm row shows only when nothing needs you or runs and a workspace is listed`() {
        let quiet = sections([host("box", workspaces: [wa], projects: [p1], sessions: [meta("idle", projectId: "p1")])])
        #expect(quiet.first?.id == "calm")
        #expect(quiet.first?.rows == [.calm(environmentId: "box", wa)])

        let busy = sections([host("box", workspaces: [wa], sessions: [meta("run", status: .running)])])
        #expect(!ids(busy).contains("calm"))

        let waiting = sections([host("box", workspaces: [wa], sessions: [meta("wait", status: .waiting)])])
        #expect(!ids(waiting).contains("calm"))

        let bare = sections([host("box")])
        #expect(!ids(bare).contains("calm"))

        let unlisted = sections([host("box", hasShell: false, workspaces: [wa])])
        #expect(!ids(unlisted).contains("calm"))
    }

    @Test func `the calm row names the first listed host and its first workspace`() {
        let out = sections([host("a", hasShell: false, workspaces: [wa]), host("b", workspaces: [ws("wb", "/repo/b"), wa])])
        #expect(out.first?.rows == [.calm(environmentId: "b", ws("wb", "/repo/b"))])
    }
}

@Suite struct HomeSectionsStatusTests {
    @Test(arguments: [TransportState.unauthorized, .offline, .reconnecting])
    func `a refused, offline or reconnecting host is troubled`(transport: TransportState) {
        #expect(HomeSections.troubled(status(transport)))
    }

    @Test(arguments: [TransportState.open, .suspended])
    func `an open or suspended host is not`(transport: TransportState) {
        #expect(!HomeSections.troubled(status(transport)))
    }

    @Test func `a connecting host is troubled only once a retry is pending after a failed attempt`() {
        #expect(!HomeSections.troubled(status(.connecting)))
        #expect(!HomeSections.troubled(status(.connecting, attempts: 2)))
        #expect(!HomeSections.troubled(status(.connecting, attempts: 0, retry: 5_000)))
        #expect(HomeSections.troubled(status(.connecting, attempts: 1, retry: 5_000)))
    }

    @Test func `one status row per troubled host, in host order, and no section when none is`() {
        let out = sections([host("a", troubled: true), host("b"), host("c", troubled: true)])
        #expect(out.first?.id == "status")
        #expect(out.first?.rows == [.status(environmentId: "a"), .status(environmentId: "c")])
        #expect(!ids(sections([host("a"), host("b")])).contains("status"))
    }
}

@Suite struct HomeSectionsHostTests {
    @Test func `one host gets no host header; two get one each, over their own workspaces`() {
        let one = sections([host("box", workspaces: [wa])])
        #expect(!ids(one).contains("host:box"))

        let wb = ws("wb", "/repo/b")
        let two = sections([host("box", workspaces: [wa]), host("mac", workspaces: [wb])])
        #expect(ids(two) == ["calm", "host:box", "workspace:box:wa", "host:mac", "workspace:mac:wb"])
        #expect(two[1].header == .host(environmentId: "box", name: "Box"))
        #expect(two[1].rows.isEmpty)
    }

    @Test func `loose chats sit under their own header before the workspaces`() {
        let out = sections([host("box", workspaces: [wa], sessions: [meta("loose", cwd: "/tmp/x")])])
        #expect(ids(out) == ["calm", "chats:box", "workspace:box:wa"])
        #expect(out[1].header == .chats(environmentId: "box"))
        #expect(out[1].rows.map(\.id) == ["thread:loose"])
    }

    @Test func `a host with no workspace and no chat gets the nothing row, listed once its shell is`() {
        let unlisted = sections([host("box", hasShell: false)])
        #expect(unlisted.map(\.id) == ["nothing:box"])
        #expect(unlisted[0].rows == [.nothing(environmentId: "box", name: "Box", listed: false)])

        let listed = sections([host("box")])
        #expect(listed[0].rows == [.nothing(environmentId: "box", name: "Box", listed: true)])

        let chats = sections([host("box", sessions: [meta("loose", cwd: "/tmp/x")])])
        #expect(!ids(chats).contains("nothing:box"))
    }

    @Test func `host notes land right after the host header, or first for the only host`() {
        let note = HomeNote(id: "boot", text: "3 threads resumed after restart")
        let one = sections([host("box", workspaces: [wa], notes: [note])])
        #expect(ids(one) == ["calm", "notes:box", "workspace:box:wa"])
        #expect(one[1].header == .none)
        #expect(one[1].rows == [.hostNote(environmentId: "box", note)])

        let two = sections([host("box", workspaces: [wa], notes: [note]), host("mac")])
        #expect(ids(two) == ["calm", "host:box", "workspace:box:wa", "host:mac", "nothing:mac"])
        #expect(two[1].rows == [.hostNote(environmentId: "box", note)])
        #expect(two[3].rows.isEmpty)
    }
}

@Suite struct HomeSectionsWorkspaceTests {
    private let sessions = [
        meta("chat", workspaceId: "wa", updatedAt: 5),
        meta("t1", projectId: "p1", updatedAt: 9),
        meta("t2", projectId: "p1", updatedAt: 8),
        meta("gone", projectId: "p1", archived: true),
        meta("old", projectId: "p-old")
    ]
    private let projects = [p1, project("p-old", "wa", archived: true)]

    @Test func `an open workspace lists chats, each project with its threads and archived row, then the archived projects`() {
        let out = sections([host("box", workspaces: [wa], projects: projects, sessions: sessions)])
        let workspace = out.first { $0.id == "workspace:box:wa" }
        #expect(workspace?.rows.map(\.id) == ["thread:chat", "project:box:p1", "thread:t1", "thread:t2", "archived:box:p1", "archived-projects:box:wa"])
        guard case .workspace(let listed, let collapsed, let threads)? = workspace?.header else {
            Issue.record("no workspace header")
            return
        }
        #expect(listed.id == "box:wa")
        #expect(listed.name == "wa")
        #expect(!listed.isPaired)
        #expect(!collapsed)
        #expect(threads == 3)
        #expect(HomeSections.foldKey(listed) == "box:wa")
    }

    @Test func `a folded workspace has no rows and its header counts the threads inside`() {
        let out = sections([host("box", workspaces: [wa], projects: projects, sessions: sessions)], folded: ["box:wa"])
        let workspace = out.first { $0.id == "workspace:box:wa" }
        #expect(workspace?.rows.isEmpty == true)
        guard case .workspace(_, let collapsed, let threads)? = workspace?.header else {
            Issue.record("no workspace header")
            return
        }
        #expect(collapsed)
        #expect(threads == 3)
    }

    @Test func `an open workspace with nothing in it says so once`() {
        let out = sections([host("box", workspaces: [wa], projects: [p1])])
        #expect(out.first { $0.id == "workspace:box:wa" }?.rows == [.emptyWorkspace(environmentId: "box", wa)])
        let folded = sections([host("box", workspaces: [wa], projects: [p1])], folded: ["box:wa"])
        #expect(folded.first { $0.id == "workspace:box:wa" }?.rows.isEmpty == true)
    }

    @Test func `project rows carry the host only when the workspace is paired`() {
        let out = sections([host("box", workspaces: [wa], projects: [p1], sessions: [meta("t", projectId: "p1")])])
        #expect(out.first { $0.id == "workspace:box:wa" }?.rows.first == .project(environmentId: "box", ThreadGroups.group([meta("t", projectId: "p1")], projects: [p1], workspaces: [wa], workspaceId: "wa").projects[0], paired: false))
    }
}

@Suite struct HomeSectionsThreadRowsTests {
    private func root(_ children: [SessionMeta]) -> ThreadItem {
        ThreadItem(meta: meta("root", projectId: "p1"), children: ThreadGroups.sortAgents(children).map { ThreadItem(meta: $0) })
    }

    @Test func `shows every live child, three settled ones, and one row for the rest`() {
        let children = [
            meta("c-done-1", parentId: "root", createdAt: 1),
            meta("c-done-2", parentId: "root", createdAt: 2),
            meta("c-done-3", parentId: "root", createdAt: 3),
            meta("c-done-4", parentId: "root", createdAt: 4),
            meta("c-done-5", parentId: "root", createdAt: 5),
            meta("c-run", parentId: "root", status: .running, createdAt: 6),
            meta("c-wait", parentId: "root", status: .waiting, createdAt: 7),
            meta("c-fail", parentId: "root", status: .error, createdAt: 8)
        ]
        let rows = HomeSections.threadRows("box", [root(children)])
        #expect(rows.map(\.id) == ["thread:root", "thread:c-wait", "thread:c-fail", "thread:c-run", "thread:c-done-1", "thread:c-done-2", "thread:c-done-3", "more:root"])
        #expect(rows.last == .moreAgents(environmentId: "box", root: meta("root", projectId: "p1"), hidden: 2))
    }

    @Test func `a root with few settled children has no more row`() {
        let rows = HomeSections.threadRows("box", [root([meta("c1", parentId: "root"), meta("c2", parentId: "root", createdAt: 2)])])
        #expect(rows.map(\.id) == ["thread:root", "thread:c1", "thread:c2"])
    }

    @Test func `every row names its host`() {
        let rows = HomeSections.threadRows("mac", [root([meta("c1", parentId: "root")])])
        #expect(rows.allSatisfy { $0.environmentId == "mac" })
    }
}

@Suite struct HomeSectionsPairingTests {
    private let boxWs = ws("ws-box", "/srv/agents/work/temp-code", repo: "LandonDev/temp-code")
    private let macWs = ws("ws-mac", "/Users/me/IdeaProjects/temp-code", repo: "LandonDev/temp-code")
    private let byRepo = HomePairing { env, workspace in workspace.githubRepo ?? "\(env):\(workspace.id)" }

    private var hosts: [HomeHostInput] {
        [
            host("box", workspaces: [boxWs, wa], projects: [project("pb", "ws-box"), p1], sessions: [meta("box-t", projectId: "pb", updatedAt: 3), meta("a-t", projectId: "p1")]),
            host("mac", workspaces: [macWs], projects: [project("pm", "ws-mac")], sessions: [meta("mac-t1", projectId: "pm", updatedAt: 2), meta("mac-t2", projectId: "pm", updatedAt: 1)])
        ]
    }

    @Test func `two hosts' copies of one repo fold into one workspace listed before any host, with both members' rows`() {
        let out = sections(hosts, pairing: byRepo)
        #expect(ids(out) == ["calm", "workspace:LandonDev/temp-code", "host:box", "workspace:box:wa", "host:mac"])
        let paired = out[1]
        guard case .workspace(let workspace, let collapsed, let threads) = paired.header else {
            Issue.record("no workspace header")
            return
        }
        #expect(workspace.isPaired)
        #expect(workspace.members.map(\.environmentId) == ["box", "mac"])
        #expect(workspace.repo == "LandonDev/temp-code")
        #expect(!collapsed)
        #expect(threads == 3)
        #expect(paired.rows.map(\.id) == ["project:box:pb", "thread:box-t", "project:mac:pm", "thread:mac-t1", "thread:mac-t2"])
        guard case .project(_, _, let flagged)? = paired.rows.first else {
            Issue.record("no project row")
            return
        }
        #expect(flagged)
    }

    @Test func `a paired workspace folds by its pairing key, folding both copies`() {
        let out = sections(hosts, folded: ["LandonDev/temp-code"], pairing: byRepo)
        let paired = out.first { $0.id == "workspace:LandonDev/temp-code" }
        #expect(paired?.rows.isEmpty == true)
        guard case .workspace(let workspace, let collapsed, let threads)? = paired?.header else {
            Issue.record("no workspace header")
            return
        }
        #expect(HomeSections.foldKey(workspace) == "LandonDev/temp-code")
        #expect(collapsed)
        #expect(threads == 3)
    }

    @Test func `the default pairing keeps every workspace under its host`() {
        let out = sections(hosts)
        #expect(ids(out) == ["calm", "host:box", "workspace:box:ws-box", "workspace:box:wa", "host:mac", "workspace:mac:ws-mac"])
    }

    @Test func `two workspaces of one host under one key stay apart`() {
        let twin = ws("ws-box-2", "/srv/other", repo: "LandonDev/temp-code")
        let out = sections([host("box", workspaces: [boxWs, twin]), host("mac", workspaces: [macWs])], pairing: byRepo)
        #expect(ids(out) == ["calm", "workspace:LandonDev/temp-code", "host:box", "workspace:box:ws-box-2", "host:mac"])
    }

    @Test func `a host whose only workspace is paired away has no nothing row`() {
        let out = sections(hosts, pairing: byRepo)
        #expect(!ids(out).contains("nothing:mac"))
    }
}

@Suite struct HomeRowTests {
    @Test func `status, host notes and needs-you rows are events and nothing else is`() {
        let item = NeedsYouItem(meta: meta("w", status: .waiting), kind: .waiting, since: 1)
        #expect(HomeRow.status(environmentId: "a").isEvent)
        #expect(HomeRow.hostNote(environmentId: "a", HomeNote(id: "n", text: "x")).isEvent)
        #expect(HomeRow.needsYou(environmentId: "a", item).isEvent)
        #expect(!HomeRow.running(environmentId: "a", meta("r", status: .running)).isEvent)
        #expect(!HomeRow.calm(environmentId: "a", wa).isEvent)
        #expect(!HomeRow.thread(environmentId: "a", ThreadItem(meta: meta("t"))).isEvent)
        #expect(!HomeRow.nothing(environmentId: "a", name: "A", listed: true).isEvent)
    }

    @Test func `ids are stable and name the host where a meta id alone would not`() {
        #expect(HomeRow.status(environmentId: "a").id == "status:a")
        #expect(HomeRow.hostNote(environmentId: "a", HomeNote(id: "boot", text: "x")).id == "note:a:boot")
        #expect(HomeRow.calm(environmentId: "a", wa).id == "calm:a")
        #expect(HomeRow.archivedProjects(environmentId: "a", wa, count: 2).id == "archived-projects:a:wa")
        #expect(HomeRow.nothing(environmentId: "a", name: "A", listed: false).id == "nothing:a")
    }

    @Test func `a queued root is neither running nor an event, and a stopped one needs no one`() {
        let queued = meta("q", projectId: "p1", status: .queued)
        let stopped = meta("s", projectId: "p1", status: .stopped)
        let out = sections([host("box", workspaces: [wa], projects: [p1], sessions: [queued, stopped])])
        #expect(!ids(out).contains("running"))
        #expect(!ids(out).contains("needs"))
        let rows = out.first { $0.id == "workspace:box:wa" }?.rows ?? []
        #expect(rows.map(\.id) == ["project:box:p1", "thread:s", "thread:q"])
        #expect(rows.allSatisfy { !$0.isEvent })
    }
}
