import Foundation
import Observation
import TempCodeContract

// The accounts a thread spends from, as the phone reads them: the desktop's
// lib/accountScope.ts, lib/headroom.ts and accountScore.ts `windowShare`
// folded into pure rules, one observable holder per host for the snapshot,
// and the four calls (docs/IOS-DESIGN.md "The account chip and menu").

/// The providers whose threads name an account (the desktop's ROUTED_PROVIDERS).
public enum RoutedProvider: String, Sendable, Hashable, CaseIterable {
    case claude
    case codex

    public init?(_ provider: ProviderId) {
        switch provider {
        case .claude: self = .claude
        case .codex: self = .codex
        default: return nil
        }
    }

    public func accounts(in snapshot: AccountsSnapshot) -> ProviderAccounts {
        switch self {
        case .claude: snapshot.providers.claude
        case .codex: snapshot.providers.codex
        }
    }
}

/// A pin level, or the thread's own route: the three segments of the menu.
public enum AccountScopeKind: String, Sendable, Hashable, CaseIterable, Identifiable {
    case thread
    case project
    case workspace

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .thread: "This thread"
        case .project: "Project"
        case .workspace: "Workspace"
        }
    }
}

/// Where a thread's account comes from (lib/accountScope.ts `scopeOf`).
public struct AccountScope: Sendable, Hashable {
    public struct Inherited: Sendable, Hashable {
        public let name: String
        public let level: AccountScopeKind
        /// The project's or workspace's name.
        public let from: String

        public init(name: String, level: AccountScopeKind, from: String) {
            self.name = name
            self.level = level
            self.from = from
        }
    }

    public let provider: RoutedProvider
    /// The project's pin, else the workspace's, else nil.
    public let inherited: Inherited?
    /// `session.account`: the host's expected or live pick.
    public let current: String?

    public init(provider: RoutedProvider, inherited: Inherited?, current: String?) {
        self.provider = provider
        self.inherited = inherited
        self.current = current
    }

    /// The account to show: the current one, else the pin that will apply.
    public var shown: String? { current ?? inherited?.name }

    /// "From project billing-page", "From workspace cosmic-web", "Auto · picked by model".
    public var sourceLine: String {
        guard let inherited else { return "Auto · picked by model" }
        return "From \(inherited.level.rawValue) \(inherited.from)"
    }

    /// nil for a provider the gateway does not route. The workspace is the
    /// project's, else the session's own.
    public static func of(_ session: SessionMeta, projects: [ProjectMeta], workspaces: [WorkspaceMeta]) -> AccountScope? {
        guard let provider = RoutedProvider(session.provider) else { return nil }
        let (project, workspace) = context(of: session, projects: projects, workspaces: workspaces)
        var inherited: Inherited?
        if let project, let name = project.accountPins?[provider.rawValue] {
            inherited = Inherited(name: name, level: .project, from: project.name)
        } else if let workspace, let name = workspace.accountPins?[provider.rawValue] {
            inherited = Inherited(name: name, level: .workspace, from: workspace.name)
        }
        return AccountScope(provider: provider, inherited: inherited, current: session.account)
    }

    /// The project and workspace a thread's pins come from.
    public static func context(of session: SessionMeta, projects: [ProjectMeta], workspaces: [WorkspaceMeta]) -> (project: ProjectMeta?, workspace: WorkspaceMeta?) {
        let project = session.projectId.flatMap { id in projects.first { $0.id == id } }
        let workspaceId = project?.workspaceId ?? session.workspaceId
        let workspace = workspaceId.flatMap { id in workspaces.first { $0.id == id } }
        return (project, workspace)
    }
}

/// The nickname, else the email's local part, else the name's local part, else the name.
public enum AccountName {
    public static func short(_ profile: AccountProfile) -> String {
        if let nickname = profile.nickname, !nickname.isEmpty { return nickname }
        return short(raw: profile.email ?? profile.name)
    }

    /// "work@example.com" → "work"; a name without @ stays.
    public static func short(raw name: String) -> String {
        guard let at = name.firstIndex(of: "@"), at > name.startIndex else { return name }
        return String(name[..<at])
    }

    /// The short name of `name` through the snapshot's profile when it has one.
    public static func short(_ name: String, in accounts: ProviderAccounts?) -> String {
        guard let profile = accounts?.profiles.first(where: { $0.name == name }) else { return short(raw: name) }
        return short(profile)
    }

    /// The chip's label: the shown account's short name, nil for Auto.
    public static func chipLabel(scope: AccountScope, accounts: ProviderAccounts?) -> String? {
        scope.shown.map { short($0, in: accounts) }
    }
}

/// One account's bar and words (lib/headroom.ts and accountScore.ts
/// `windowShare`, folded into one reading): the least room among the usage
/// windows the thread's model spends, unless the account is throttled or
/// its sign-in lapsed.
public struct HeadroomLook: Sendable, Hashable {
    public enum Tone: Sendable, Hashable {
        case none
        case success
        case warning
        case destructive
    }

    /// 0...1 of the bar.
    public let fraction: Double
    public let tone: Tone
    /// "in 2h 14m", "rate limited · 39m", "no usage yet"; nil when nothing to say.
    public let stamp: String?
    /// "work: 61 percent left, refills in 2 hours 14 minutes".
    public let accessibility: String

    public init(fraction: Double, tone: Tone, stamp: String?, accessibility: String) {
        self.fraction = fraction
        self.tone = tone
        self.stamp = stamp
        self.accessibility = accessibility
    }

    /// Below this share of a window the bar turns warning; below `destructiveBelow`, destructive.
    public static let warningBelow = 0.25
    public static let destructiveBelow = 0.05

    public static func of(profile: String, model: String?, provider: RoutedProvider, accounts: ProviderAccounts, now: Int) -> HeadroomLook {
        let shortName = AccountName.short(profile, in: accounts)
        let report = accounts.reports.first { $0.profileName == profile }
        let headroom = accounts.headroom?[profile]
        let throttledUntil = headroom?.throttledUntil.flatMap { $0 > now ? $0 : nil }
        if throttledUntil != nil || report?.rateLimit != nil {
            let until = throttledUntil ?? report?.rateLimit?.until
            let stamp = until.map { "rate limited · \(Self.until($0, now: now))" } ?? "rate limited"
            let spoken = until.map { "\(shortName): rate limited, picks again in \(Self.spoken($0, now: now))" } ?? "\(shortName): rate limited"
            return HeadroomLook(fraction: 0, tone: .destructive, stamp: stamp, accessibility: spoken)
        }
        if report?.expired == true {
            return HeadroomLook(fraction: 0, tone: .destructive, stamp: "sign in again", accessibility: "\(shortName): signed out, sign in again")
        }
        let windows = (report?.windows ?? []).filter { window in
            (window.resetsAt.map { $0 > now } ?? true) && applies(label: window.label, model: model)
        }
        guard let tightest = windows.max(by: { $0.usedPercent < $1.usedPercent }) else {
            return HeadroomLook(fraction: 0, tone: .none, stamp: "no usage yet", accessibility: "\(shortName): no usage yet")
        }
        let least = min(1, max(0, (100 - tightest.usedPercent) / 100))
        let tone: Tone = least > warningBelow ? .success : least >= destructiveBelow ? .warning : .destructive
        let percent = Int((least * 100).rounded())
        let stamp = tightest.resetsAt.map { "in \(Self.until($0, now: now))" }
        let spoken = tightest.resetsAt.map { "\(shortName): \(percent) percent left, refills in \(Self.spoken($0, now: now))" }
            ?? "\(shortName): \(percent) percent left"
        return HeadroomLook(fraction: least, tone: tone, stamp: stamp, accessibility: spoken)
    }

    /// The windows a model spends (aliax-core `tiersFor`): the five-hour one,
    /// the weekly one, and a model cap whose first word names the model.
    public static func applies(label: String, model: String?) -> Bool {
        if label == "5h" { return true }
        if label.localizedCaseInsensitiveContains("week") { return true }
        guard let model, let word = label.split(whereSeparator: { $0.isWhitespace }).first else { return false }
        return model.localizedCaseInsensitiveContains(String(word))
    }

    /// The desktop's `untilLabel`: "under a minute", "12m", "2h 14m", "3d 4h".
    public static func until(_ at: Int, now: Int) -> String {
        let (days, hours, minutes, short) = parts(at, now: now)
        if short { return "under a minute" }
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(minutes)m"
    }

    /// `until` in words for VoiceOver: "2 hours 14 minutes".
    public static func spoken(_ at: Int, now: Int) -> String {
        let (days, hours, minutes, short) = parts(at, now: now)
        if short { return "under a minute" }
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        if days > 0 { return hours > 0 ? "\(unit(days, "day")) \(unit(hours, "hour"))" : unit(days, "day") }
        if hours > 0 { return minutes > 0 ? "\(unit(hours, "hour")) \(unit(minutes, "minute"))" : unit(hours, "hour") }
        return unit(minutes, "minute")
    }

    private static func parts(_ at: Int, now: Int) -> (days: Int, hours: Int, minutes: Int, short: Bool) {
        let ms = at - now
        let minute = 60_000
        let hour = 60 * minute
        let day = 24 * hour
        guard ms >= minute else { return (0, 0, 0, true) }
        return (ms / day, (ms % day) / hour, (ms % hour) / minute, false)
    }
}

/// One row of the menu at one scope.
public struct AccountRowModel: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        /// "Best account for the model", "Follows the workspace: work", "Follows the project: work".
        case automatic(detail: String)
        case account(name: String, shortName: String, color: String?, look: HeadroomLook)
        /// Named by the pin or the route, not in the snapshot.
        case gone(name: String)
    }

    public let kind: Kind
    public let checked: Bool

    public init(kind: Kind, checked: Bool) {
        self.kind = kind
        self.checked = checked
    }

    /// "auto", or the name.
    public var id: String {
        switch kind {
        case .automatic: "auto"
        case .account(let name, _, _, _): name
        case .gone(let name): name
        }
    }

    /// The account this row would pin; nil for Automatic.
    public var name: String? {
        switch kind {
        case .automatic: nil
        case .account(let name, _, _, _): name
        case .gone(let name): name
        }
    }
}

public enum AccountMenuModel {
    /// The rows for a scope: Automatic first, then the profiles in the
    /// snapshot's order, then one gone row when the checked name is not a
    /// profile. `checked` at .thread is the route's reading (`scope.shown`);
    /// at .project the project's pin for the provider (Automatic when none);
    /// at .workspace the workspace's pin.
    public static func rows(scope: AccountScope, kind: AccountScopeKind, session: SessionMeta, project: ProjectMeta?, workspace: WorkspaceMeta?, accounts: ProviderAccounts?, now: Int) -> [AccountRowModel] {
        let provider = scope.provider
        let projectPin = project?.accountPins?[provider.rawValue]
        let workspacePin = workspace?.accountPins?[provider.rawValue]
        let checked: String?
        let follows: (level: AccountScopeKind, name: String)?
        switch kind {
        case .thread:
            checked = scope.shown
            follows = scope.inherited.map { ($0.level, $0.name) }
        case .project:
            checked = projectPin
            follows = workspacePin.map { (.workspace, $0) }
        case .workspace:
            checked = workspacePin
            follows = nil
        }
        let detail = follows.map { "Follows the \($0.level.rawValue): \(AccountName.short($0.name, in: accounts))" }
            ?? "Best account for the model"
        var rows = [AccountRowModel(kind: .automatic(detail: detail), checked: checked == nil)]
        for profile in accounts?.profiles ?? [] {
            let look = accounts.map { HeadroomLook.of(profile: profile.name, model: session.model, provider: provider, accounts: $0, now: now) }
                ?? HeadroomLook(fraction: 0, tone: .none, stamp: nil, accessibility: AccountName.short(profile))
            rows.append(AccountRowModel(kind: .account(name: profile.name, shortName: AccountName.short(profile), color: profile.color, look: look), checked: profile.name == checked))
        }
        if let checked, !(accounts?.profiles.contains { $0.name == checked } ?? false) {
            rows.append(AccountRowModel(kind: .gone(name: checked), checked: true))
        }
        return rows
    }

    /// The scopes a thread has: .project with a project, .workspace with a workspace.
    public static func scopes(session: SessionMeta, project: ProjectMeta?, workspace: WorkspaceMeta?) -> [AccountScopeKind] {
        var scopes: [AccountScopeKind] = [.thread]
        if session.projectId != nil, project != nil { scopes.append(.project) }
        if workspace != nil { scopes.append(.workspace) }
        return scopes
    }

    /// The pins to send when `name` (nil = Automatic) is chosen for `provider`:
    /// the current pins with that key set or removed.
    public static func pins(after current: AccountPins?, provider: RoutedProvider, name: String?) -> AccountPins {
        var pins = current ?? [:]
        pins[provider.rawValue] = name
        return pins
    }
}

/// Why a pin cannot be changed right now, or nil.
public enum PinBlock: Sendable, Hashable {
    /// The key is below admin: "This key can't change pins".
    case needsAdmin
    /// The socket's block, its text.
    case host(ActionBlock)

    public func text(now: Double) -> String {
        switch self {
        case .needsAdmin: "This key can't change pins"
        case .host(let block): block.text(now: now)
        }
    }
}

/// One host's accounts snapshot as the phone holds it: the last
/// `accounts.list` answer or `accounts` push.
@MainActor @Observable
public final class HostAccounts {
    public private(set) var snapshot: AccountsSnapshot?
    /// Clock ms of the last snapshot.
    public private(set) var receivedAt: Int?
    public private(set) var isLoading = false

    /// Nothing for this long means a new socket session may have missed a push.
    public static let staleAfterMs = 30_000

    public init() {}

    public func apply(_ snapshot: AccountsSnapshot, now: Int) {
        self.snapshot = snapshot
        receivedAt = now
    }

    func beginLoad() { isLoading = true }
    func endLoad() { isLoading = false }

    /// Stale when nothing has landed for 30 s.
    public func isStale(now: Int) -> Bool {
        guard let receivedAt else { return true }
        return now - receivedAt > Self.staleAfterMs
    }
}

extension EnvironmentClient {
    /// `accounts.list` once, unless a fresh snapshot is held; a refused or
    /// failed call leaves the old one.
    public func loadAccounts(force: Bool = false) async {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard force || accounts.isStale(now: now), !accounts.isLoading else { return }
        accounts.beginLoad()
        defer { accounts.endLoad() }
        guard let snapshot = try? await request(Methods.AccountsList.self, NoParams()) else { return }
        accounts.apply(snapshot, now: Int(Date().timeIntervalSince1970 * 1000))
    }

    /// nil when the key may pin and the socket is up.
    public var pinBlock: PinBlock? {
        guard environment.allows(.admin) else { return .needsAdmin }
        return operateBlock.map(PinBlock.host)
    }

    /// Pin `name` (nil = Automatic) for `provider` on the project: the project's
    /// current pins with that key set or removed. The `projects` push then
    /// carries the pin and the rows follow.
    public func setProjectAccount(_ projectId: String, provider: RoutedProvider, name: String?) async throws {
        let current = projects.first { $0.id == projectId }?.accountPins
        let pins = AccountMenuModel.pins(after: current, provider: provider, name: name)
        try await pin {
            try await self.request(Methods.ProjectSetAccounts.self, .init(projectId: projectId, pins: .init(claude: pins["claude"], codex: pins["codex"])))
        }
    }

    public func setWorkspaceAccount(_ workspaceId: String, provider: RoutedProvider, name: String?) async throws {
        let current = workspaces.first { $0.id == workspaceId }?.accountPins
        let pins = AccountMenuModel.pins(after: current, provider: provider, name: name)
        try await pin {
            try await self.request(Methods.WorkspaceSetAccounts.self, .init(workspaceId: workspaceId, pins: .init(claude: pins["claude"], codex: pins["codex"])))
        }
    }

    /// `session.reroute`: the host picks the thread's account fresh; true when it moved.
    public func rerouteAccount(_ sessionId: String) async throws -> Bool {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            return try await request(Methods.SessionReroute.self, .init(sessionId: sessionId)).moved
        } catch {
            throw ActionError.wrap(error)
        }
    }

    /// The gate every pin runs: the key's standing first, then the socket;
    /// a `forbidden` answer reads as the pin block, not the composer's.
    private func pin(_ body: () async throws -> Void) async throws {
        switch pinBlock {
        case .needsAdmin?: throw ActionError.refused(message: PinBlock.needsAdmin.text(now: 0), forbidden: true)
        case .host(let block)?: throw ActionError.blocked(block)
        case nil: break
        }
        do {
            try await body()
        } catch {
            let wrapped = ActionError.wrap(error)
            if case .refused(_, true) = wrapped { throw ActionError.refused(message: PinBlock.needsAdmin.text(now: 0), forbidden: true) }
            throw wrapped
        }
    }
}
