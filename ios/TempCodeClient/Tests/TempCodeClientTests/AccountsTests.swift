import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

// The accounts a thread spends from, on the phone: the scope, the names,
// the headroom bar's reading, the menu's rows, the holder on the client,
// the pins over the wire and the failure cue (thread iOS 24).

private let hour = 3_600_000
private let now = 1_700_000_000_000

private func session(_ id: String = "s1", provider: ProviderId = .claude, model: String = "claude-fable-5-1", account: String? = nil, projectId: String? = "p1", workspaceId: String? = nil, status: SessionStatus = .idle, failure: Failure? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: nil, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: provider, model: model, reasoning: .low, agentType: .implementer, title: "A thread", cwd: "/tmp/repo", status: status, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: account, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, failure: failure, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: 1, updatedAt: 2)
}

private func project(_ id: String = "p1", workspaceId: String = "w1", name: String = "billing-page", pins: AccountPins? = nil) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: name, mode: .local, branch: "master", cwd: "/tmp/repo", archived: false, accountPins: pins, createdAt: 1)
}

private func workspace(_ id: String = "w1", name: String = "cosmic-web", pins: AccountPins? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: name, path: "/tmp/repo", git: true, accountPins: pins, githubRepo: nil, githubRepoCheckedAt: nil, createdAt: 1)
}

private func profile(_ name: String, email: String? = nil, nickname: String? = nil, color: String? = nil) -> AccountProfile {
    AccountProfile(name: name, email: email, nickname: nickname, color: color, active: false)
}

private func window(_ label: String, used: Double, resetsAt: Int? = nil) -> UsageWindow {
    UsageWindow(label: label, usedPercent: used, resetsAt: resetsAt, periodMs: nil)
}

private func report(_ name: String, _ windows: [UsageWindow], rateLimit: UsageReport.RateLimit? = nil, expired: Bool? = nil) -> UsageReport {
    UsageReport(profileName: name, windows: windows, note: nil, expired: expired, rateLimit: rateLimit)
}

/// Two Claude accounts: `work` with room, `spare` nearly out.
private let work = "work@example.com"
private let spare = "spare@example.com"

private func claude(profiles: [AccountProfile]? = nil, reports: [UsageReport] = [], headroom: [String: AccountHeadroom]? = nil) -> ProviderAccounts {
    ProviderAccounts(
        pinned: nil,
        profiles: profiles ?? [profile(work, email: work, nickname: "work", color: "#5b8def"), profile(spare, email: spare, color: "#d97757")],
        reports: reports,
        note: nil,
        headroom: headroom
    )
}

private func snapshot(claude accounts: ProviderAccounts = claude(), updatedAt: Int = now) -> AccountsSnapshot {
    let empty = ProviderAccounts(pinned: nil, profiles: [], reports: [], note: nil, headroom: nil)
    return AccountsSnapshot(updatedAt: updatedAt, providers: .init(claude: accounts, codex: empty, cursor: empty))
}

@Suite struct AccountScopeTests {
    @Test func `a provider the gateway does not route has no scope`() {
        #expect(AccountScope.of(session(provider: .cursor), projects: [project()], workspaces: [workspace()]) == nil)
        #expect(RoutedProvider(.grok) == nil)
        #expect(RoutedProvider(.codex) == .codex)
    }

    @Test func `with no pins the route is the thread's own account and the line says auto`() throws {
        let scope = try #require(AccountScope.of(session(account: work), projects: [project()], workspaces: [workspace()]))
        #expect(scope.provider == .claude)
        #expect(scope.inherited == nil)
        #expect(scope.current == work)
        #expect(scope.shown == work)
        #expect(scope.sourceLine == "Auto · picked by model")
    }

    @Test func `a project pin wins over the workspace's and names the project`() throws {
        let scope = try #require(AccountScope.of(session(), projects: [project(pins: ["claude": work])], workspaces: [workspace(pins: ["claude": spare])]))
        #expect(scope.inherited == AccountScope.Inherited(name: work, level: .project, from: "billing-page"))
        #expect(scope.sourceLine == "From project billing-page")
        #expect(scope.shown == work)
    }

    @Test func `the workspace is found through the project, and its pin applies when the project has none`() throws {
        let scope = try #require(AccountScope.of(session(workspaceId: nil), projects: [project(workspaceId: "w2")], workspaces: [workspace("w1"), workspace("w2", name: "other", pins: ["claude": spare])]))
        #expect(scope.inherited == AccountScope.Inherited(name: spare, level: .workspace, from: "other"))
        #expect(scope.sourceLine == "From workspace other")
    }

    @Test func `a pin for the other provider is not this thread's`() throws {
        let scope = try #require(AccountScope.of(session(), projects: [project(pins: ["codex": "x@example.com"])], workspaces: [workspace()]))
        #expect(scope.inherited == nil)
    }

    @Test func `shown prefers the live route over the pin that will apply`() throws {
        let scope = try #require(AccountScope.of(session(account: spare), projects: [project(pins: ["claude": work])], workspaces: []))
        #expect(scope.shown == spare)
        #expect(scope.inherited?.name == work)
    }
}

@Suite struct AccountNameTests {
    @Test func `the nickname, then the email's local part, then the name's, then the name`() {
        #expect(AccountName.short(profile(work, email: work, nickname: "work")) == "work")
        #expect(AccountName.short(profile("acct-1", email: "team@example.com")) == "team")
        #expect(AccountName.short(profile(spare)) == "spare")
        #expect(AccountName.short(profile("Landon")) == "Landon")
        #expect(AccountName.short(profile(work, nickname: "")) == "work")
        #expect(AccountName.short(raw: "@odd") == "@odd")
    }

    @Test func `the chip reads nil for Auto and the local part when the snapshot lacks the profile`() {
        let auto = AccountScope(provider: .claude, inherited: nil, current: nil)
        #expect(AccountName.chipLabel(scope: auto, accounts: claude()) == nil)
        let routed = AccountScope(provider: .claude, inherited: nil, current: work)
        #expect(AccountName.chipLabel(scope: routed, accounts: claude()) == "work")
        #expect(AccountName.chipLabel(scope: routed, accounts: nil) == "work")
        let gone = AccountScope(provider: .claude, inherited: nil, current: "old@example.com")
        #expect(AccountName.chipLabel(scope: gone, accounts: claude()) == "old")
    }
}

@Suite struct HeadroomLookTests {
    private func look(_ accounts: ProviderAccounts, profile: String = work, model: String? = "claude-fable-5-1") -> HeadroomLook {
        HeadroomLook.of(profile: profile, model: model, provider: .claude, accounts: accounts, now: now)
    }

    @Test func `no report means nothing to show`() {
        let look = look(claude())
        #expect(look == HeadroomLook(fraction: 0, tone: .none, stamp: "no usage yet", accessibility: "work: no usage yet"))
    }

    @Test func `a throttled account is destructive and says when it picks again`() {
        let throttled = claude(reports: [report(work, [window("5h", used: 10)])], headroom: [work: AccountHeadroom(room: 0.9, throttledUntil: now + 39 * 60_000, ratePerMin: 2, seenAt: now)])
        let look = look(throttled)
        #expect(look.fraction == 0)
        #expect(look.tone == .destructive)
        #expect(look.stamp == "rate limited · 39m")
        #expect(look.accessibility == "work: rate limited, picks again in 39 minutes")
    }

    @Test func `a lifted throttle no longer counts, but the report's rate limit does`() {
        let lifted = claude(reports: [report(work, [window("5h", used: 10)])], headroom: [work: AccountHeadroom(room: 0.9, throttledUntil: now - 1, ratePerMin: 2, seenAt: now)])
        #expect(look(lifted).tone == .success)
        let limited = claude(reports: [report(work, [window("5h", used: 10)], rateLimit: .init(provider: "anthropic", until: nil))])
        #expect(look(limited).stamp == "rate limited")
        #expect(look(limited).tone == .destructive)
    }

    @Test func `an expired sign-in asks for a sign-in`() {
        let expired = claude(reports: [report(work, [window("5h", used: 10)], expired: true)])
        #expect(look(expired) == HeadroomLook(fraction: 0, tone: .destructive, stamp: "sign in again", accessibility: "work: signed out, sign in again"))
    }

    @Test func `the least live window wins and the stamp is its reset`() {
        let accounts = claude(reports: [report(work, [window("5h", used: 12, resetsAt: now + 3 * hour), window("Weekly", used: 40, resetsAt: now + 3 * 24 * hour + 4 * hour)])])
        let look = look(accounts)
        #expect(look.fraction == 0.6)
        #expect(look.tone == .success)
        #expect(look.stamp == "in 3d 4h")
        #expect(look.accessibility == "work: 60 percent left, refills in 3 days 4 hours")
    }

    @Test func `a lifted window is skipped`() {
        let accounts = claude(reports: [report(work, [window("5h", used: 99, resetsAt: now - 1), window("Weekly", used: 40, resetsAt: now + hour)])])
        #expect(look(accounts).fraction == 0.6)
        let allLifted = claude(reports: [report(work, [window("5h", used: 99, resetsAt: now - 1)])])
        #expect(look(allLifted).stamp == "no usage yet")
    }

    @Test func `a model cap counts for its model and not another's`() {
        let accounts = claude(reports: [report(work, [window("5h", used: 10, resetsAt: now + hour), window("Fable 5", used: 95, resetsAt: now + 2 * hour), window("Opus", used: 100)])])
        #expect(look(accounts, model: "claude-fable-5-1").fraction == 0.05)
        #expect(look(accounts, model: "claude-fable-5-1").stamp == "in 2h")
        #expect(look(accounts, model: "claude-sonnet-5-5").fraction == 0.9)
        #expect(look(accounts, model: nil).fraction == 0.9)
        #expect(HeadroomLook.applies(label: "week", model: nil))
        #expect(HeadroomLook.applies(label: "5h", model: nil))
        #expect(!HeadroomLook.applies(label: "Credits", model: "claude-fable-5-1"))
    }

    @Test(arguments: [(80.0, HeadroomLook.Tone.success), (75.0, .warning), (90.0, .warning), (95.0, .warning), (96.0, .destructive), (100.0, .destructive)])
    func `the tone turns at a quarter and at a twentieth left`(used: Double, tone: HeadroomLook.Tone) {
        let accounts = claude(reports: [report(work, [window("5h", used: used)])])
        #expect(look(accounts).tone == tone)
    }

    @Test func `a window with no reset has no stamp, and a profile the snapshot lacks reads by its local part`() {
        let accounts = claude(reports: [report(work, [window("5h", used: 30)])])
        #expect(look(accounts).stamp == nil)
        #expect(look(accounts).accessibility == "work: 70 percent left")
        #expect(look(accounts, profile: "old@example.com").accessibility == "old: no usage yet")
    }

    @Test(arguments: [
        (30_000, "under a minute", "under a minute"),
        (12 * 60_000, "12m", "12 minutes"),
        (60_000, "1m", "1 minute"),
        (2 * hour + 14 * 60_000, "2h 14m", "2 hours 14 minutes"),
        (3 * hour, "3h", "3 hours"),
        (3 * 24 * hour + 4 * hour, "3d 4h", "3 days 4 hours"),
        (24 * hour, "1d", "1 day")
    ])
    func `until reads like the desktop, and spoken in words`(ms: Int, label: String, spoken: String) {
        #expect(HeadroomLook.until(now + ms, now: now) == label)
        #expect(HeadroomLook.spoken(now + ms, now: now) == spoken)
    }
}

@Suite struct AccountMenuModelTests {
    private let accounts = claude(reports: [report(work, [window("5h", used: 12, resetsAt: now + hour)]), report(spare, [window("5h", used: 91, resetsAt: now + hour)])])

    private func rows(_ kind: AccountScopeKind, session meta: SessionMeta = session(), project: ProjectMeta? = project(), workspace: WorkspaceMeta? = workspace(), accounts: ProviderAccounts? = nil) -> [AccountRowModel] {
        let scope = AccountScope.of(meta, projects: project.map { [$0] } ?? [], workspaces: workspace.map { [$0] } ?? [])!
        return AccountMenuModel.rows(scope: scope, kind: kind, session: meta, project: project, workspace: workspace, accounts: accounts ?? self.accounts, now: now)
    }

    @Test func `Automatic comes first with the best-account line, then the profiles in the snapshot's order`() {
        let rows = rows(.thread)
        #expect(rows.map(\.id) == ["auto", work, spare])
        #expect(rows[0].kind == .automatic(detail: "Best account for the model"))
        #expect(rows[0].checked)
        #expect(rows.dropFirst().allSatisfy { !$0.checked })
        if case .account(let name, let shortName, let color, let look) = rows[1].kind {
            #expect(name == work && shortName == "work" && color == "#5b8def" && look.tone == .success)
        } else {
            Issue.record("expected an account row")
        }
        #expect(rows[1].name == work)
        #expect(rows[0].name == nil)
    }

    @Test func `at This thread the route's account is checked`() {
        let rows = rows(.thread, session: session(account: spare))
        #expect(rows.map(\.checked) == [false, false, true])
    }

    @Test func `Automatic says what it follows at each scope`() {
        let pinnedWorkspace = workspace(pins: ["claude": work])
        #expect(rows(.thread, workspace: pinnedWorkspace)[0].kind == .automatic(detail: "Follows the workspace: work"))
        #expect(rows(.project, workspace: pinnedWorkspace)[0].kind == .automatic(detail: "Follows the workspace: work"))
        #expect(rows(.workspace, workspace: pinnedWorkspace)[0].kind == .automatic(detail: "Best account for the model"))
        #expect(rows(.thread, project: project(pins: ["claude": spare]), workspace: pinnedWorkspace)[0].kind == .automatic(detail: "Follows the project: spare"))
        #expect(rows(.workspace, project: project(pins: ["claude": spare]))[0].kind == .automatic(detail: "Best account for the model"))
    }

    @Test func `the pin at each scope is the checked row, Automatic when none`() {
        let projectRows = rows(.project, project: project(pins: ["claude": spare]), workspace: workspace(pins: ["claude": work]))
        #expect(projectRows.map(\.checked) == [false, false, true])
        let workspaceRows = rows(.workspace, project: project(pins: ["claude": spare]), workspace: workspace(pins: ["claude": work]))
        #expect(workspaceRows.map(\.checked) == [false, true, false])
        #expect(rows(.project)[0].checked)
        #expect(rows(.workspace)[0].checked)
    }

    @Test func `a name the snapshot does not know gets a gone row, checked`() {
        let pinned = rows(.project, project: project(pins: ["claude": "old@example.com"]))
        #expect(pinned.map(\.id) == ["auto", work, spare, "old@example.com"])
        #expect(pinned.last?.kind == .gone(name: "old@example.com"))
        #expect(pinned.last?.checked == true)
        #expect(pinned[0].checked == false)
        let routed = rows(.thread, session: session(account: "old@example.com"))
        #expect(routed.last?.kind == .gone(name: "old@example.com"))
        #expect(rows(.thread, session: session(account: work)).map(\.id) == ["auto", work, spare])
    }

    @Test func `without a snapshot the rows are Automatic and the checked name alone`() {
        let empty = ProviderAccounts(pinned: nil, profiles: [], reports: [], note: nil, headroom: nil)
        #expect(rows(.thread, session: session(account: work), accounts: empty).map(\.id) == ["auto", work])
        let scope = AccountScope.of(session(), projects: [], workspaces: [])!
        #expect(AccountMenuModel.rows(scope: scope, kind: .thread, session: session(), project: nil, workspace: nil, accounts: nil, now: now).map(\.id) == ["auto"])
    }

    @Test func `the scopes a thread has`() {
        #expect(AccountMenuModel.scopes(session: session(), project: project(), workspace: workspace()) == [.thread, .project, .workspace])
        #expect(AccountMenuModel.scopes(session: session(projectId: nil, workspaceId: "w1"), project: nil, workspace: workspace()) == [.thread, .workspace])
        #expect(AccountMenuModel.scopes(session: session(projectId: nil), project: nil, workspace: nil) == [.thread])
        #expect(AccountScopeKind.project.title == "Project")
        #expect(AccountScopeKind.thread.title == "This thread")
    }

    @Test func `the next pins set or remove the provider's key and keep the other's`() {
        #expect(AccountMenuModel.pins(after: nil, provider: .claude, name: work) == ["claude": work])
        #expect(AccountMenuModel.pins(after: ["codex": "c@example.com"], provider: .claude, name: work) == ["claude": work, "codex": "c@example.com"])
        #expect(AccountMenuModel.pins(after: ["claude": work, "codex": "c@example.com"], provider: .claude, name: nil) == ["codex": "c@example.com"])
        #expect(AccountMenuModel.pins(after: nil, provider: .codex, name: nil) == [:])
    }
}

/// A client on a fake socket, its key's capabilities chosen per test.
@MainActor
private final class AccountsRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let environment: PairedEnvironment
    let client: EnvironmentClient
    var projects: [ProjectMeta] = [project()]

    init(caps: [Capability] = [.read, .operate, .approve, .admin]) throws {
        environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    /// Brings the socket up with the shell listed.
    func open() async throws -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: environment.caps.map(\.rawValue))
        var answered: Set<String> = []
        for _ in 0..<4000 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([workspace()]))
                case "project.list": fake.answer(id: sent.id, result: json(projects))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [session(account: work)], cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if client.hasShell, client.status.transport == .open { return fake }
            await Task.yield()
        }
        throw TransportError.notConnected
    }

    func request(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        for _ in 0..<4000 {
            let matching = fake.sentRequests.filter { $0.method == method }
            if matching.count >= count { return matching[count - 1] }
            await Task.yield()
        }
        return nil
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<4000 {
            if predicate() { return true }
            await Task.yield()
        }
        return false
    }
}

@MainActor
@Suite struct HostAccountsTests {
    @Test func `apply stores the snapshot and stamps when; stale after thirty seconds`() {
        let held = HostAccounts()
        #expect(held.snapshot == nil)
        #expect(held.isStale(now: now))
        held.apply(snapshot(), now: now)
        #expect(held.snapshot?.providers.claude.profiles.count == 2)
        #expect(held.receivedAt == now)
        #expect(!held.isStale(now: now + 29_000))
        #expect(held.isStale(now: now + 30_001))
    }

    @Test func `an accounts push lands on the client's holder`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        fake.deliver(json(ServerPush.accounts(AccountsPush(snapshot: snapshot()))))
        #expect(await rig.wait { rig.client.accounts.snapshot != nil })
        #expect(rig.client.accounts.snapshot?.providers.claude.profiles.map(\.name) == [work, spare])
        await rig.client.stop()
    }

    @Test func `loadAccounts asks once, not again while fresh, again when forced, and keeps the old snapshot on a refusal`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        let first = Task { await rig.client.loadAccounts() }
        let request = try #require(await rig.request(fake, "accounts.list"))
        #expect(rig.client.accounts.isLoading)
        fake.answer(id: request.id, result: json(snapshot()))
        await first.value
        #expect(!rig.client.accounts.isLoading)
        #expect(rig.client.accounts.snapshot?.updatedAt == now)
        await rig.client.loadAccounts()
        #expect(fake.sentRequests.filter { $0.method == "accounts.list" }.count == 1, "fresh: nothing sent")
        let forced = Task { await rig.client.loadAccounts(force: true) }
        let second = try #require(await rig.request(fake, "accounts.list", count: 2))
        fake.refuse(id: second.id, error: "forbidden: accounts.list needs read")
        await forced.value
        #expect(rig.client.accounts.snapshot?.updatedAt == now, "the old snapshot stays")
        #expect(!rig.client.accounts.isLoading)
        await rig.client.stop()
    }
}

@MainActor
@Suite struct PinActionsTests {
    @Test func `a key below admin cannot pin: the block says so and nothing goes out`() async throws {
        let rig = try AccountsRig(caps: [.read, .operate])
        let fake = try await rig.open()
        #expect(rig.client.pinBlock == .needsAdmin)
        #expect(PinBlock.needsAdmin.text(now: 0) == "This key can't change pins")
        await #expect(throws: ActionError.refused(message: "This key can't change pins", forbidden: true)) {
            try await rig.client.setProjectAccount("p1", provider: .claude, name: spare)
        }
        await #expect(throws: ActionError.refused(message: "This key can't change pins", forbidden: true)) {
            try await rig.client.setWorkspaceAccount("w1", provider: .claude, name: nil)
        }
        #expect(!fake.sentRequests.contains { $0.method == "project.setAccounts" || $0.method == "workspace.setAccounts" })
        await rig.client.stop()
    }

    @Test func `with the socket down the host's block is the reason`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        fake.drop()
        #expect(await rig.wait { rig.client.status.transport == .reconnecting })
        if case .host(.reconnecting)? = rig.client.pinBlock {} else { Issue.record("expected the host's reconnecting block, got \(String(describing: rig.client.pinBlock))") }
        #expect(PinBlock.host(.reconnecting(retryAt: nil)).text(now: 0) == "Reconnecting…")
        await rig.client.stop()
    }

    @Test func `an admin key pins the project with the current pins plus the chosen one, and Automatic removes the key`() async throws {
        let rig = try AccountsRig()
        rig.projects = [project(pins: ["codex": "c@example.com"])]
        let fake = try await rig.open()
        #expect(rig.client.pinBlock == nil)
        let pinning = Task { try await rig.client.setProjectAccount("p1", provider: .claude, name: spare) }
        let request = try #require(await rig.request(fake, "project.setAccounts"))
        #expect(request.params == .object(["projectId": .string("p1"), "pins": .object(["claude": .string(spare), "codex": .string("c@example.com")])]))
        fake.answer(id: request.id, result: "null")
        try await pinning.value
        let clearing = Task { try await rig.client.setProjectAccount("p1", provider: .codex, name: nil) }
        let second = try #require(await rig.request(fake, "project.setAccounts", count: 2))
        #expect(second.params == .object(["projectId": .string("p1"), "pins": .object([:])]))
        fake.answer(id: second.id, result: "null")
        try await clearing.value
        await rig.client.stop()
    }

    @Test func `the workspace pin goes out the same way`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        let pinning = Task { try await rig.client.setWorkspaceAccount("w1", provider: .claude, name: work) }
        let request = try #require(await rig.request(fake, "workspace.setAccounts"))
        #expect(request.params == .object(["workspaceId": .string("w1"), "pins": .object(["claude": .string(work)])]))
        fake.answer(id: request.id, result: "null")
        try await pinning.value
        await rig.client.stop()
    }

    @Test func `a forbidden answer reads as the pin block, any other as what the host said`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        let refused = Task { try await rig.client.setProjectAccount("p1", provider: .claude, name: work) }
        let request = try #require(await rig.request(fake, "project.setAccounts"))
        fake.refuse(id: request.id, error: "forbidden: project.setAccounts needs admin")
        await #expect(throws: ActionError.refused(message: "This key can't change pins", forbidden: true)) { try await refused.value }
        let unknown = Task { try await rig.client.setProjectAccount("p9", provider: .claude, name: work) }
        let second = try #require(await rig.request(fake, "project.setAccounts", count: 2))
        fake.refuse(id: second.id, error: "unknown project: p9")
        await #expect(throws: ActionError.refused(message: "unknown project: p9", forbidden: false)) { try await unknown.value }
        await rig.client.stop()
    }

    @Test func `reroute sends session.reroute and answers whether the thread moved`() async throws {
        let rig = try AccountsRig()
        let fake = try await rig.open()
        let moving = Task { try await rig.client.rerouteAccount("s1") }
        let request = try #require(await rig.request(fake, "session.reroute"))
        #expect(request.params == .object(["sessionId": .string("s1")]))
        fake.answer(id: request.id, result: #"{"account":"spare@example.com","moved":true}"#)
        let moved = try await moving.value
        #expect(moved)
        let staying = Task { try await rig.client.rerouteAccount("s1") }
        let second = try #require(await rig.request(fake, "session.reroute", count: 2))
        fake.answer(id: second.id, result: #"{"account":null,"moved":false}"#)
        let stayed = try await staying.value
        #expect(!stayed)
        await rig.client.stop()
    }

    @Test func `reroute needs operate`() async throws {
        let rig = try AccountsRig(caps: [.read])
        let fake = try await rig.open()
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.rerouteAccount("s1") }
        #expect(!fake.sentRequests.contains { $0.method == "session.reroute" })
        await rig.client.stop()
    }
}

@Suite struct FailureCueTests {
    private func row(_ seq: Int, _ event: AgentEvent) -> EventRow {
        EventRow(sessionId: "s", seq: seq, ts: seq, event: event)
    }

    private let verdict = Failure(kind: .rateLimited, account: work, summary: "work is rate limited for 39 minutes", cause: "429 from api.anthropic.com")

    @Test func `an error root with a summary reads the host's verdict and still points at the error row`() {
        let item = NeedsYouItem(meta: session(status: .error, failure: verdict), kind: .error, since: 2)
        let rows = [row(1, .userText(UserTextEvent(text: "go", attachments: nil, model: nil, reasoning: nil, context1m: nil, fast: nil, ultrafast: nil, newPass: nil))), row(2, .error(ErrorEvent(message: "The provider answered 429\nRetry in a minute.", stopped: nil, limit: nil)))]
        #expect(HomeModel.cue(for: item, rows: rows) == HomeModel.Cue(text: "work is rate limited for 39 minutes", seq: 2))
        #expect(HomeModel.cue(for: item, rows: []) == HomeModel.Cue(text: "work is rate limited for 39 minutes", seq: nil))
    }

    @Test func `without a summary the error row's first line stands, and a waiting item is unchanged`() {
        let plain = NeedsYouItem(meta: session(status: .error), kind: .error, since: 2)
        let rows = [row(2, .error(ErrorEvent(message: "The provider answered 429\nRetry in a minute.", stopped: nil, limit: nil)))]
        #expect(HomeModel.cue(for: plain, rows: rows) == HomeModel.Cue(text: "Error: The provider answered 429", seq: 2))
        let empty = NeedsYouItem(meta: session(status: .error, failure: Failure(kind: .unknown, account: nil, summary: "", cause: "")), kind: .error, since: 2)
        #expect(HomeModel.cue(for: empty, rows: rows).text == "Error: The provider answered 429")
        let waiting = NeedsYouItem(meta: session(status: .waiting, failure: verdict), kind: .waiting, since: 2)
        #expect(HomeModel.cue(for: waiting, rows: []) == HomeModel.Cue(text: "Waiting for you", seq: nil))
    }

    @Test func `the summary is read only while the thread is in error`() {
        #expect(session(status: .error, failure: verdict).failureSummary == "work is rate limited for 39 minutes")
        #expect(session(status: .idle, failure: verdict).failureSummary == nil)
        #expect(session(status: .error).failureSummary == nil)
    }
}
