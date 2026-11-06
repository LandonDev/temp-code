import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// One instance of every `Route` case: a new case must be listed here and given a column.
private let everyRoute: [Route] = [
    .thread(environmentId: "e", sessionId: "s", seq: nil),
    .workspace(key: "w"),
    .project(key: "p", thread: nil, seq: nil),
    .archivedThreads(environmentId: "e", projectId: "p"),
    .archivedProjects(environmentId: "e", workspaceId: "w"),
    .settings,
    .hosts
]

@Suite struct ShellPathsTests {
    @Test func `every route has a column: the lists in the sidebar, the project's shell and the screens in the detail`() {
        #expect(everyRoute.count == 7)
        let sidebar = everyRoute.filter { ShellPaths.column(of: $0) == .sidebar }
        let detail = everyRoute.filter { ShellPaths.column(of: $0) == .detail }
        #expect(sidebar.count + detail.count == everyRoute.count)
        #expect(sidebar == [.workspace(key: "w"), .archivedThreads(environmentId: "e", projectId: "p"), .archivedProjects(environmentId: "e", workspaceId: "w")])
        #expect(detail.count == 4)
        #expect(ShellPaths.column(of: .project(key: "p", thread: "e:s")) == .detail)
        #expect(ShellPaths.column(of: .settings) == .detail)
        #expect(ShellPaths.column(of: .hosts) == .detail)
    }

    @Test func `a snapshot round-trips through JSON with a detail open`() throws {
        var snapshot = NavigationSnapshot(tab: .inbox, sidebarShown: false)
        snapshot[.home] = ColumnMemory(sidebar: [.workspace(key: "w")], detailRoot: .project(key: "p", thread: "e:s", seq: 12), detailStack: Data([1, 2, 3]))
        snapshot[.search] = ColumnMemory(detailRoot: .thread(environmentId: "e", sessionId: "hit", seq: 4))
        let data = try JSONEncoder().encode(snapshot)
        let back = try JSONDecoder().decode(NavigationSnapshot.self, from: data)
        #expect(back == snapshot)
        #expect(back[.home].sidebar == [.workspace(key: "w")])
        #expect(back[.home].detailRoot == .project(key: "p", thread: "e:s", seq: 12))
        #expect(back[.home].detailStack == Data([1, 2, 3]))
        #expect(back[.search].detailRoot == .thread(environmentId: "e", sessionId: "hit", seq: 4))
        // The tabs key the object by name, so a hand-read snapshot is legible.
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"home\""))
        #expect(text.contains("\"search\""))
    }

    @Test func `a snapshot round-trips with no detail and reads empty columns for a tab it never saw`() throws {
        var snapshot = NavigationSnapshot()
        snapshot[.home] = ColumnMemory(sidebar: [.workspace(key: "w")])
        let back = try JSONDecoder().decode(NavigationSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(back == snapshot)
        #expect(back.tab == .home)
        #expect(back.sidebarShown)
        #expect(back[.home].detailRoot == nil)
        #expect(back[.home].detailStack == nil)
        #expect(back[.inbox] == ColumnMemory())
    }

    @Test func `a project route saved without its thread decodes as the draft`() throws {
        let data = Data(#"{"project":{"key":"link:pl_1"}}"#.utf8)
        #expect(try JSONDecoder().decode(Route.self, from: data) == .project(key: "link:pl_1", thread: nil, seq: nil))
    }

    @Test func `a shell is one screen whichever thread it shows`() {
        #expect(ShellPaths.identity(of: .project(key: "k", thread: "e:a")) == ShellPaths.identity(of: .project(key: "k", thread: "e:b")))
        #expect(ShellPaths.identity(of: .project(key: "k")) == ShellPaths.identity(of: .project(key: "k", thread: "e:b")))
        #expect(ShellPaths.identity(of: .project(key: "k")) != ShellPaths.identity(of: .project(key: "j")))
        #expect(ShellPaths.identity(of: open("e", "a")) != ShellPaths.identity(of: open("e", "b")))
        #expect(ShellPaths.shown(.project(key: "k", thread: "env_x:s:1"))! == ("env_x", "s:1"))
        #expect(ShellPaths.shown(.project(key: "k")) == nil)
        #expect(ShellPaths.shown(open("e", "a"))! == ("e", "a"))
    }

    @Test func `a project's root opens in its shell, a subagent pushes over its root's, a loose chat in its workspace's`() {
        let hosts = [fixture()]
        // A card's line, a notification and a search hit all name a thread; each places it the same way.
        #expect(ShellPaths.place(open("e", "a", seq: 7), hosts: hosts) == .init(root: .project(key: "e:p1", thread: "e:a", seq: 7), push: nil))
        #expect(ShellPaths.place(open("e", "kid", seq: 3), hosts: hosts) == .init(root: .project(key: "e:p1", thread: "e:a"), push: open("e", "kid", seq: 3)))
        let loose = ShellPaths.place(open("e", "loose"), hosts: hosts)
        #expect(loose.root == .project(key: "loose:e:wa", thread: "e:loose"))
        #expect(ThreadStrip.scope(key: "loose:e:wa", hosts: hosts)?.roots.map(\.item.meta.id) == ["loose"])
        // A chat outside every workspace, and a thread no host lists, open bare.
        #expect(ShellPaths.place(open("e", "stray"), hosts: hosts).root == open("e", "stray"))
        #expect(ShellPaths.place(open("e", "unknown"), hosts: hosts).root == open("e", "unknown"))
        #expect(ShellPaths.place(.settings, hosts: hosts).root == .settings)
    }

    @Test func `a bare thread its host listed and left bare is never looked for again`() {
        let listed = fixture()
        let empty = HomeHostInput(environmentId: "e", name: "e", workspaces: [], projects: [], sessions: [])
        var settled: Route?
        var built = 0
        func awaits(_ root: Route, hasListed: Bool, hosts: HomeHostInput) -> Bool {
            ShellPaths.awaitsListing(root, stackEmpty: true, settled: &settled, listed: { _ in hasListed }, hosts: { built += 1; return [hosts] })
        }
        // Before the list lands: looked for on every pass, and placed once it lands.
        #expect(!awaits(open("e", "a"), hasListed: false, hosts: empty))
        #expect(!awaits(open("e", "a"), hasListed: false, hosts: empty))
        #expect(awaits(open("e", "a"), hasListed: true, hosts: listed))
        #expect(built == 3)
        // A chat outside every workspace: one look after the list, then none.
        #expect(!awaits(open("e", "stray"), hasListed: true, hosts: listed))
        #expect(settled == open("e", "stray"))
        for _ in 0..<5 { #expect(!awaits(open("e", "stray"), hasListed: true, hosts: listed)) }
        #expect(built == 4)
        // Another root is looked at again; something pushed over the root waits on nothing.
        #expect(awaits(open("e", "a"), hasListed: true, hosts: listed))
        #expect(!ShellPaths.awaitsListing(open("e", "a"), stackEmpty: false, settled: &settled, listed: { _ in true }, hosts: { built += 1; return [listed] }))
        #expect(built == 5)
    }

    @Test func `a thread opened bare before its host listed it moves into its shell once the list lands`() {
        // A notification's tap on a cold launch: the host is paired but has listed nothing yet.
        let listed = fixture()
        let empty = HomeHostInput(environmentId: "e", name: "e", workspaces: [], projects: [], sessions: [])
        let tapped = open("e", "a", seq: 7)
        #expect(ShellPaths.place(tapped, hosts: [empty]).root == tapped)
        #expect(ShellPaths.relisted(tapped, hosts: [empty]) == nil)
        #expect(ShellPaths.relisted(tapped, hosts: [listed]) == .init(root: .project(key: "e:p1", thread: "e:a", seq: 7), push: nil))
        // A subagent lands over its root's shell; a chat outside every workspace stays bare; a shell is no bare thread.
        #expect(ShellPaths.relisted(open("e", "kid"), hosts: [listed])?.push == open("e", "kid"))
        #expect(ShellPaths.relisted(open("e", "stray"), hosts: [listed]) == nil)
        #expect(ShellPaths.relisted(.project(key: "e:p1", thread: "e:a"), hosts: [listed]) == nil)
        #expect(ShellPaths.relisted(nil, hosts: [listed]) == nil)
    }

    @Test func `folded and unfolded place a thread the same and a snapshot restores it equal`() throws {
        let hosts = [fixture()]
        // One placement, whatever the pose: the navigator puts the detail root on top of the sidebar or beside it.
        let placed = ShellPaths.place(open("e", "a"), hosts: hosts)
        var snapshot = NavigationSnapshot()
        snapshot[.home] = ColumnMemory(sidebar: [.workspace(key: "e:wa")], detailRoot: placed.root)
        snapshot[.search] = ColumnMemory(detailRoot: ShellPaths.place(open("e", "a", seq: 9), hosts: hosts).root)
        let back = try #require(NavigationSnapshot.restore(v3: JSONEncoder().encode(snapshot), v2: nil))
        #expect(back == snapshot)
        #expect(back[.home].detailRoot == .project(key: "e:p1", thread: "e:a"))
        // Search keeps its own place: the same shell in its detail, its hit's row named.
        #expect(back[.search].detailRoot == .project(key: "e:p1", thread: "e:a", seq: 9))
    }

    @Test func `a card's tap lands on the active thread, else the remembered one, else the draft; already there, nothing moves`() {
        let hosts = [fixture()]
        #expect(ShellPaths.land(key: "e:p1", current: nil, hosts: hosts, remembered: nil) == .project(key: "e:p1"))
        #expect(ShellPaths.land(key: "e:p1", current: nil, hosts: hosts, remembered: .thread("e:b")) == .project(key: "e:p1", thread: "e:b"))
        #expect(ShellPaths.land(key: "e:p1", current: nil, hosts: hosts, remembered: .draft) == .project(key: "e:p1"))
        // A remembered thread since archived or gone falls back to the draft.
        #expect(ShellPaths.land(key: "e:p1", current: nil, hosts: hosts, remembered: .thread("e:gone")) == .project(key: "e:p1"))
        let busy = [fixture(running: "b")]
        #expect(ShellPaths.land(key: "e:p1", current: nil, hosts: busy, remembered: .draft) == .project(key: "e:p1", thread: "e:b"))
        let here = Route.project(key: "e:p1", thread: "e:a")
        #expect(ShellPaths.land(key: "e:p1", current: here, hosts: busy, remembered: nil) == here)
    }
}

private func open(_ env: String, _ sid: String, seq: Int? = nil) -> Route { .thread(environmentId: env, sessionId: sid, seq: seq) }

private func fixture(running: String? = nil) -> HomeHostInput {
    let workspaces = [WorkspaceMeta(id: "wa", name: "wa", path: "/repo/a", git: true, createdAt: 1)]
    let projects = [ProjectMeta(id: "p1", workspaceId: "wa", name: "p1", mode: .worktree, branch: "tc/p1", cwd: "/wt/p1", archived: false, createdAt: 1)]
    func meta(_ id: String, parentId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String = "/repo/a", archived: Bool = false) -> SessionMeta {
        SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "m", reasoning: .low, agentType: .implementer, title: id, cwd: cwd, status: id == running ? .running : .idle, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, createdAt: 1, updatedAt: 100)
    }
    let sessions = [
        meta("a", projectId: "p1"),
        meta("b", projectId: "p1"),
        meta("gone", projectId: "p1", archived: true),
        meta("kid", parentId: "a", projectId: "p1"),
        meta("loose", workspaceId: "wa"),
        meta("stray", cwd: "/elsewhere")
    ]
    return HomeHostInput(environmentId: "e", name: "e", workspaces: workspaces, projects: projects, sessions: sessions)
}
