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

private func meta(_ id: String, parentId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String = "/repo/a", status: SessionStatus = .idle, archived: Bool = false, pinned: Bool = false, isMaster: Bool? = nil, masterId: String? = nil, updatedAt: Int = 100, threadType: ThreadType = .chat, planCompletedAt: Int? = nil, lastEventAt: Int? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: threadType, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: cwd, status: status, pinned: pinned, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, lastEventAt: lastEventAt, planCompletedAt: planCompletedAt, isMaster: isMaster, masterId: masterId, createdAt: 1, updatedAt: updatedAt)
}

private func host(_ id: String, workspaces: [WorkspaceMeta], projects: [ProjectMeta], sessions: [SessionMeta], seen: [String: SeenMark] = [:]) -> HomeHostInput {
    HomeHostInput(environmentId: id, name: id, floor: 0, workspaces: workspaces, projects: projects, sessions: sessions, seen: seen)
}

private func open(_ env: String, _ sid: String) -> Route { .thread(environmentId: env, sessionId: sid, seq: nil) }

/// `seen` marks every id as seen now, so an idle thread is dormant unless the test says otherwise.
private func seen(_ ids: [String]) -> [String: SeenMark] {
    Dictionary(uniqueKeysWithValues: ids.map { ($0, SeenMark(at: 1_000, seq: 1)) })
}

private func shown(_ env: String, _ sid: String) -> (environmentId: String, sessionId: String) { (env, sid) }

/// The desktop's strip rules (threadStripModel.ts, threadHeaderModel.ts):
/// live chips in a stable order, the settled ones on the shelf, the thread
/// on screen selected wherever it sits, an outside chip for a thread the
/// scope does not hold.
@Suite struct ThreadStripTests {
    private let workspace = ws("wa", "/repo/a")
    private let projects = [project("p1", "wa"), project("p2", "wa")]

    @Test func `a project thread's scope is its project; live roots are on the row, settled ones on the shelf`() {
        let sessions = [
            meta("running", projectId: "p1", status: .running, updatedAt: 50),
            meta("pinned", projectId: "p1", pinned: true, updatedAt: 10),
            meta("waiting", projectId: "p1", status: .waiting, updatedAt: 90),
            meta("dormant", projectId: "p1", updatedAt: 80),
            meta("other-project", projectId: "p2", status: .running, updatedAt: 99)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["dormant", "pinned"]))]
        let scope = ThreadStrip.scope(for: open("h1", "running"), hosts: hosts)!
        guard case .project(let project) = scope.kind else { Issue.record("expected a project scope"); return }
        #expect(project.project.id == "p1")
        #expect(scope.lead == StripScope.Lead(environmentId: "h1", workspaceId: "wa", projectId: "p1"))
        #expect(scope.key == "h1:p1")
        let model = ThreadStrip.model(scope: scope, shown: shown("h1", "running"), order: [], hosts: hosts)
        // New chips join oldest first; pinned alone is not live.
        #expect(model.live.map(\.meta.id) == ["running", "waiting"])
        #expect(model.shelf.map(\.meta.id) == ["dormant", "pinned"])
        #expect(model.selected?.meta.id == "running")
    }

    @Test func `the open dormant thread stays on the shelf, selected there`() {
        let sessions = [meta("fresh", projectId: "p1", status: .running, updatedAt: 90), meta("me", projectId: "p1", updatedAt: 60)]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["me"]))]
        let scope = ThreadStrip.scope(for: open("h1", "me"), hosts: hosts)!
        let model = ThreadStrip.model(scope: scope, shown: shown("h1", "me"), order: [], hosts: hosts)
        #expect(model.live.map(\.meta.id) == ["fresh"])
        #expect(model.shelf.map(\.meta.id) == ["me"])
        #expect(model.shelf[0].selected)
    }

    @Test func `a tapped live chip keeps its place until another is selected, though opening it marked it seen`() {
        let sessions = [meta("first", projectId: "p1", status: .running, updatedAt: 40), meta("read", projectId: "p1", updatedAt: 60), meta("last", projectId: "p1", status: .running, updatedAt: 90)]
        let order = ["h1:first", "h1:read", "h1:last"]
        // Unread, it is live in its saved slot.
        let unread = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let unreadScope = ThreadStrip.scope(for: open("h1", "read"), hosts: unread)!
        #expect(ThreadStrip.model(scope: unreadScope, shown: nil, order: order, hosts: unread).live.map(\.meta.id) == ["first", "read", "last"])
        // Tapped: the thread opens and is seen; the chip stays where it was, selected, at either width.
        let seenNow = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["read"]))]
        let scope = ThreadStrip.scope(for: open("h1", "read"), hosts: seenNow)!
        let opened = ThreadStrip.model(scope: scope, shown: shown("h1", "read"), order: order, hosts: seenNow)
        #expect(opened.live.map(\.meta.id) == ["first", "read", "last"])
        #expect(opened.live[1].selected && !opened.live[1].outside)
        #expect(opened.shelf.isEmpty)
        #expect(opened.compact.live.map(\.meta.id) == ["first", "read", "last"])
        #expect(opened.saveIds == order)
        // Another selected: the settled, seen chip leaves for the shelf.
        let moved = ThreadStrip.model(scope: scope, shown: shown("h1", "last"), order: order, hosts: seenNow)
        #expect(moved.live.map(\.meta.id) == ["first", "last"])
        #expect(moved.shelf.map(\.meta.id) == ["read"])
        // A settled chip opened from the shelf was never on the row: it stays on the shelf.
        let fromShelf = ThreadStrip.model(scope: scope, shown: shown("h1", "read"), order: ["h1:first", "h1:last"], hosts: seenNow)
        #expect(fromShelf.shelf.map(\.meta.id) == ["read"])
    }

    @Test func `a draft's send in flight is a live chip until its meta lands, selected once its thread is on screen`() {
        let quiet = [host("h1", workspaces: [workspace], projects: projects, sessions: [meta("run", projectId: "p1", status: .running)])]
        let scope = ThreadStrip.scope(key: "h1:p1", hosts: quiet)!
        var sending = DraftSending(environmentId: "h1", workspaceId: "wa", projectId: "p1", title: "Ship it", threadType: .implementation, provider: .claude, model: "m", startedAt: 9)
        let inFlight = ThreadStrip.model(scope: scope, shown: nil, order: ["h1:run"], hosts: quiet, sending: sending)
        #expect(inFlight.live.map(\.id) == ["h1:run", "h1:sending-9"])
        #expect(inFlight.live[1].sending && !inFlight.live[1].selected)
        #expect(inFlight.live[1].look(onShelf: false).glyph == .status(.working))
        #expect(inFlight.saveIds == ["h1:run"])
        // Nothing selected: the row scrolls to the send in flight.
        #expect(inFlight.scrollTarget == "h1:sending-9")
        // The create answered and the shell opened the thread; its meta has not landed.
        sending.sessionId = "new"
        let opened = ThreadStrip.model(scope: scope, shown: shown("h1", "new"), order: ["h1:run"], hosts: quiet, sending: sending)
        #expect(opened.live.last?.id == "h1:new")
        #expect(opened.live.last?.selected == true)
        #expect(opened.scrollTarget == "h1:new")
        // Landed: its own chip takes the place.
        let landed = [host("h1", workspaces: [workspace], projects: projects, sessions: [meta("run", projectId: "p1", status: .running), meta("new", projectId: "p1", status: .running, updatedAt: 200)])]
        let after = ThreadStrip.model(scope: ThreadStrip.scope(key: "h1:p1", hosts: landed)!, shown: shown("h1", "new"), order: ["h1:run"], hosts: landed, sending: sending)
        #expect(after.live.map(\.id) == ["h1:run", "h1:new"])
        #expect(!after.live[1].sending)
    }

    @Test func `New Thread leads the row only while no chip is live`() {
        let quiet = [host("h1", workspaces: [workspace], projects: projects, sessions: [meta("done", projectId: "p1", updatedAt: 60)], seen: seen(["done"]))]
        let scope = ThreadStrip.scope(key: "h1:p1", hosts: quiet)!
        #expect(ThreadStrip.model(scope: scope, shown: nil, order: [], hosts: quiet).leadsWithNewThread)
        let busy = [host("h1", workspaces: [workspace], projects: projects, sessions: [meta("run", projectId: "p1", status: .running)])]
        #expect(!ThreadStrip.model(scope: ThreadStrip.scope(key: "h1:p1", hosts: busy)!, shown: nil, order: [], hosts: busy).leadsWithNewThread)
    }

    @Test func `a subagent selects its root`() {
        let sessions = [meta("root", projectId: "p1", status: .running, updatedAt: 90), meta("child", parentId: "root", projectId: "p1", status: .running, updatedAt: 95)]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "child"), hosts: hosts)!
        let model = ThreadStrip.model(scope: scope, shown: shown("h1", "child"), order: [], hosts: hosts)
        #expect(model.live.map(\.meta.id) == ["root"])
        #expect(model.selected?.meta.id == "root")
    }

    @Test func `subagents, batch children and archived roots take no chip; an open batch child is an outside chip`() {
        let sessions = [
            meta("root", projectId: "p1", status: .running, updatedAt: 90),
            meta("child", parentId: "root", projectId: "p1", status: .running, updatedAt: 95),
            meta("master", projectId: "p1", status: .watching, isMaster: true, updatedAt: 80),
            meta("batch-kid", projectId: "p1", status: .running, masterId: "master", updatedAt: 85),
            meta("archived", projectId: "p1", status: .running, archived: true, updatedAt: 99)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "root"), hosts: hosts)!
        #expect(ThreadStrip.model(scope: scope, shown: shown("h1", "root"), order: [], hosts: hosts).live.map(\.meta.id) == ["master", "root"])
        let withKid = ThreadStrip.model(scope: scope, shown: shown("h1", "batch-kid"), order: [], hosts: hosts)
        #expect(withKid.live.map(\.meta.id) == ["master", "root", "batch-kid"])
        #expect(withKid.live.last?.outside == true)
        #expect(withKid.live.last?.selected == true)
        #expect(withKid.saveIds == ["h1:master", "h1:root"], "the outside chip is never saved")
    }

    @Test func `another scope's thread on screen is an outside chip at the live row's end`() {
        let sessions = [meta("a", projectId: "p1", status: .running, updatedAt: 90), meta("b", projectId: "p2", updatedAt: 95)]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["b"]))]
        let scope = ThreadStrip.scope(project: "h1:p1", hosts: hosts) ?? ThreadStrip.scope(for: open("h1", "a"), hosts: hosts)!
        let model = ThreadStrip.model(scope: scope, shown: shown("h1", "b"), order: [], hosts: hosts)
        #expect(model.live.map(\.meta.id) == ["a", "b"])
        #expect(model.live[1].outside)
        #expect(!model.live[1].live, "settled: it rides the row only as the thread on screen")
    }

    @Test func `the saved order holds: places kept, a state change moves nothing, new chips at the end`() {
        let sessions = [
            meta("a", projectId: "p1", status: .running, updatedAt: 10),
            meta("b", projectId: "p1", status: .waiting, updatedAt: 90),
            meta("c", projectId: "p1", status: .running, updatedAt: 50)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "a"), hosts: hosts)!
        let model = ThreadStrip.model(scope: scope, shown: nil, order: ["h1:b", "h1:gone", "h1:a"], hosts: hosts)
        #expect(model.live.map(\.meta.id) == ["b", "a", "c"])
    }

    @Test func `linked copies of a project mix into one strip under the link's key`() {
        let a = host("h1", workspaces: [ws("wa", "/repo/a", linkId: "wl")], projects: [project("p1", "wa", linkId: "pl")], sessions: [meta("mac", projectId: "p1", status: .running, updatedAt: 50)])
        let b = host("h2", workspaces: [ws("wb", "/srv/a", linkId: "wl")], projects: [project("pb", "wb", linkId: "pl")], sessions: [meta("box", projectId: "pb", status: .running, updatedAt: 70)])
        let scope = ThreadStrip.scope(for: open("h2", "box"), hosts: [a, b])!
        #expect(scope.lead == StripScope.Lead(environmentId: "h1", workspaceId: "wa", projectId: "p1"))
        #expect(scope.key == "link:pl")
        let model = ThreadStrip.model(scope: scope, shown: shown("h2", "box"), order: [], hosts: [a, b])
        #expect(model.live.map(\.id) == ["h1:mac", "h2:box"])
        #expect(model.live.map(\.selected) == [false, true])
    }

    @Test func `a chat with no project scopes to its workspace's loose chats`() {
        let sessions = [
            meta("chat", workspaceId: "wa", status: .running, updatedAt: 50),
            meta("chat2", workspaceId: "wa", status: .waiting, updatedAt: 60),
            meta("in-project", projectId: "p1", status: .running, updatedAt: 70)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        let scope = ThreadStrip.scope(for: open("h1", "chat"), hosts: hosts)!
        guard case .workspaceChats(let found) = scope.kind else { Issue.record("expected the workspace's chats"); return }
        #expect(found.name == "wa")
        #expect(scope.key == "loose:h1:wa")
        #expect(ThreadStrip.model(scope: scope, shown: shown("h1", "chat"), order: [], hosts: hosts).live.map(\.meta.id) == ["chat", "chat2"])
    }

    @Test func `a chat outside every workspace has no strip`() {
        let sessions = [meta("loose", cwd: "/tmp/x", status: .running, updatedAt: 50)]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        #expect(ThreadStrip.scope(for: open("h1", "loose"), hosts: hosts) == nil)
    }

    @Test func `unread and plan-ready make a settled thread live`() {
        let sessions = [
            meta("new", projectId: "p1", updatedAt: 500),
            meta("seen", projectId: "p1", updatedAt: 400),
            meta("plan", projectId: "p1", updatedAt: 300, threadType: .planning, planCompletedAt: 290)
        ]
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions, seen: seen(["seen", "plan"]))]
        let scope = ThreadStrip.scope(for: open("h1", "new"), hosts: hosts)!
        let model = ThreadStrip.model(scope: scope, shown: nil, order: [], hosts: hosts)
        #expect(Set(model.live.map(\.meta.id)) == ["new", "plan"])
        #expect(model.live.first { $0.meta.id == "new" }?.unseen == true)
        #expect(model.shelf.map(\.meta.id) == ["seen"])
    }

    @Test func `no scope for another route or an unknown thread`() {
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: [])]
        #expect(ThreadStrip.scope(for: .settings, hosts: hosts) == nil)
        #expect(ThreadStrip.scope(for: nil, hosts: hosts) == nil)
        #expect(ThreadStrip.scope(for: open("h1", "gone"), hosts: hosts) == nil)
    }
}

@Suite struct StripOrderTests {
    @Test func `orderChips keeps places, drops the gone and adds the new oldest first`() {
        #expect(ThreadStrip.orderChips(["b", "x", "a"], [("a", 1), ("b", 2), ("c", 9), ("d", 5)]) == ["b", "a", "d", "c"])
        #expect(ThreadStrip.orderChips([], [("a", 3), ("b", 1)]) == ["b", "a"])
    }

    @Test func `the saved order keeps 64 ids and forgets a scope unseen for 30 days`() {
        var orders = StripOrders()
        orders.save("p1", ids: (0..<80).map(String.init), now: 0)
        #expect(orders.order("p1").count == StripOrders.maxIds)
        orders.save("p2", ids: ["a"], now: StripOrders.maxAgeMs + 1)
        #expect(orders.order("p1").isEmpty)
        #expect(orders.order("p2") == ["a"])
    }

    @MainActor @Test func `the store persists what the strip drew, the outside chip left out`() throws {
        let defaults = try #require(UserDefaults(suiteName: "strip-order-\(UUID().uuidString)"))
        let store = ThreadStripStore(defaults: defaults)
        let chip = { (id: String, outside: Bool) in StripChip(environmentId: "h1", meta: meta(id), selected: false, unseen: false, live: true, outside: outside) }
        store.save("k", model: StripModel(live: [chip("a", false), chip("b", true)], shelf: []), now: 1)
        #expect(ThreadStripStore(defaults: defaults).order("k") == ["h1:a"])
    }
}

@Suite struct ProjectLandingTests {
    private let workspace = ws("wa", "/repo/a")
    private let projects = [project("p1", "wa")]

    private func landing(_ sessions: [SessionMeta], shown: (String, String)? = nil) -> ProjectLanding.Landing? {
        let hosts = [host("h1", workspaces: [workspace], projects: projects, sessions: sessions)]
        guard let scope = ThreadStrip.scope(project: "h1:p1", hosts: hosts) else { return nil }
        return ProjectLanding.active(scope: scope, hosts: hosts, shown: shown.map { (environmentId: $0.0, sessionId: $0.1) })
    }

    @Test func `the most recent active root by its last event`() {
        let found = landing([
            meta("old", projectId: "p1", status: .running, lastEventAt: 10),
            meta("new", projectId: "p1", status: .waiting, lastEventAt: 90),
            meta("idle", projectId: "p1", lastEventAt: 99)
        ])
        #expect(found?.meta.id == "new")
        #expect(found?.environmentId == "h1")
    }

    @Test func `a batch thread lands on its master`() {
        let found = landing([
            meta("plain", projectId: "p1", status: .running, lastEventAt: 50),
            meta("master", projectId: "p1", status: .watching, isMaster: true, lastEventAt: 20),
            meta("kid", projectId: "p1", status: .running, masterId: "master", lastEventAt: 80)
        ])
        #expect(found?.meta.id == "master")
    }

    @Test func `nothing when nothing is active, or the thread on screen is already in the project`() {
        #expect(landing([meta("idle", projectId: "p1")]) == nil)
        #expect(landing([meta("a", projectId: "p1", status: .running, lastEventAt: 9), meta("b", projectId: "p1")], shown: ("h1", "b")) == nil)
    }

    @Test func `failed, stopped and plan-ready threads are not active; a subagent never counts`() {
        #expect(!ProjectLanding.isActive(meta("e", status: .error)))
        #expect(!ProjectLanding.isActive(meta("s", status: .stopped)))
        #expect(!ProjectLanding.isActive(meta("p", threadType: .planning, planCompletedAt: 5)))
        #expect(ProjectLanding.isActive(meta("q", status: .queued)))
        #expect(landing([meta("root", projectId: "p1"), meta("sub", parentId: "root", projectId: "p1", status: .running, lastEventAt: 5)]) == nil)
    }
}
