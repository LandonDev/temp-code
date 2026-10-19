import Foundation
import Observation
import TempCodeContract

/// One opened thread as the app renders it.
public struct ThreadState: Sendable, Hashable {
    /// Oldest first, unique by seq. Ephemeral rows ride along in memory only.
    public var rows: [EventRow] = []
    /// Older rows exist on the host (or in the cache) beyond `rows.first`.
    public var moreBefore = false
    /// The first page since the thread opened is still on its way.
    public var isLoading = false
    public var isLoadingOlder = false
    /// The live socket carries this thread's pushes right now.
    public var isLive = false
    /// `session.subscribe` was refused: the thread is gone from the host.
    public var goneReason: String?

    public init() {}

    public var cursor: Int { rows.last?.seq ?? 0 }
}

/// Rows a thread keeps in memory at most; older ones drop off the top and
/// come back through `loadOlder`.
public let threadRowsInMemory = 2_000
/// Rows a cold open asks for (the wire's TAIL_ROWS); its byte target may cut it shorter.
public let coldOpenTail = 300
/// Rows one older page asks for.
public let olderPage = 200

/// One environment as the app sees it: the socket's status, the shell
/// (workspaces, projects, sessions newest first) and every opened thread,
/// painted from the cache before the socket is up and kept current from
/// the pushes after. The cache is written on every change, so the next cold
/// launch starts where this one left off.
@MainActor @Observable
public final class EnvironmentClient {
    public let environment: PairedEnvironment
    public private(set) var status: EnvironmentStatus = .idle
    public private(set) var workspaces: [WorkspaceMeta] = []
    public private(set) var projects: [ProjectMeta] = []
    /// Newest first.
    public private(set) var sessions: [SessionMeta] = []
    public private(set) var threads: [String: ThreadState] = [:]
    /// The shell has been listed at least once in this process.
    public private(set) var hasShell = false
    /// When the user last looked at each thread, from the cache; `markSeen` writes it.
    public private(set) var seen: [String: SeenMark] = [:]
    /// Workspace icons as the cache holds them; `icon(_:)` asks the host once per launch.
    public private(set) var icons: [String: CachedIcon] = [:]
    private var iconRequests: Set<String> = []

    public let socket: TempCodeSocket
    public let cache: SessionCache
    public let subscriptions: Subscriptions
    private let keys: any KeyStore
    private var loops: [Task<Void, Never>] = []
    private var started = false

    public init(environment: PairedEnvironment, keys: any KeyStore, cache: SessionCache, api: RemoteAPI = RemoteAPI(), connect: @escaping WebSocketFactory = URLSessionWebSocket.factory(), clock: any SocketClock = SystemClock(), configuration: SocketConfiguration = SocketConfiguration()) {
        self.environment = environment
        self.keys = keys
        self.cache = cache
        self.socket = TempCodeSocket(environment: environment, keys: keys, api: api, connect: connect, clock: clock, configuration: configuration)
        self.subscriptions = Subscriptions(socket: socket)
    }

    // MARK: - lifecycle

    /// Paints from the cache, then connects and follows the socket.
    public func start() async {
        guard !started else { return }
        started = true
        if let shell = try? await cache.shell(environment.id) {
            workspaces = shell.workspaces
            projects = shell.projects
            sessions = shell.sessions
        }
        seen = (try? await cache.seen(environment.id)) ?? [:]
        icons = (try? await cache.icons(environment.id)) ?? [:]
        let socket = self.socket
        loops = [
            Task { [weak self] in
                for await status in socket.statuses { self?.status = status }
            },
            Task { [weak self] in
                for await event in socket.sessions { await self?.handle(event) }
            },
            Task { [weak self] in
                for await push in socket.pushes { await self?.apply(push) }
            }
        ]
        await socket.start()
    }

    /// Stops the socket and the loops; the cache stays for the next launch.
    public func stop() async {
        started = false
        for loop in loops { loop.cancel() }
        loops = []
        await socket.stop()
        for id in threads.keys { threads[id]?.isLive = false }
    }

    /// The environment was removed: stop and forget its cache.
    public func remove() async {
        await stop()
        try? await cache.clear(environment.id)
        workspaces = []
        projects = []
        sessions = []
        threads = [:]
    }

    public func retry() async { await socket.retry() }
    public func setForeground(_ foreground: Bool) async { await socket.setForeground(foreground) }
    public func setOnline(_ online: Bool) async { await socket.setOnline(online) }

    /// One request over the live session; what L3's actions are built on.
    public func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        try await socket.request(method, params)
    }

    // MARK: - threads

    public func session(_ id: String) -> SessionMeta? {
        sessions.first { $0.id == id }
    }

    /// The user is looking at the thread: its newest work counts as seen from here on.
    public func markSeen(_ id: String) {
        guard let meta = session(id) else { return }
        let mark = SeenMark(at: meta.updatedAt, seq: threads[id]?.cursor ?? 0)
        guard seen[id] != mark else { return }
        seen[id] = mark
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.markSeen(env, sessionId: id, at: mark.at, seq: mark.seq) }
    }

    /// The newest rows of a thread the screen has not opened (a needs-you line
    /// wants the request behind a waiting status): the cache, else one page
    /// from the host, kept in the cache.
    public func peekTail(_ id: String, limit: Int = 24) async -> [EventRow] {
        if let state = threads[id], !state.rows.isEmpty { return state.rows.suffix(limit).map { $0 } }
        if let tail = try? await cache.tail(environment.id, sessionId: id, limit: limit), !tail.rows.isEmpty { return tail.rows }
        guard await socket.isOpen,
              let page = try? await socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: nil, tail: limit, limit: nil))
        else { return [] }
        try? await cache.store(environment.id, sessionId: id, rows: page.rows, moreBefore: page.moreBefore)
        return page.rows
    }

    /// Shows the thread: its cached tail at once, then a subscribe and a
    /// resume from the cache's cursor when the socket is up.
    public func openThread(_ id: String) async {
        if threads[id] == nil {
            var state = ThreadState()
            state.isLoading = true
            if let tail = try? await cache.tail(environment.id, sessionId: id, limit: coldOpenTail) {
                state.rows = tail.rows
                state.moreBefore = tail.moreBefore
            }
            threads[id] = state
        }
        guard !subscriptions.has(id) else { return }
        subscriptions.add(id, SubscriptionHandlers(
            cursor: { [weak self] in self?.threads[id]?.cursor ?? 0 },
            page: { [weak self] page, tailFirst in self?.fold(id, page: page, tailFirst: tailFirst) },
            gone: { [weak self] reason in
                self?.threads[id]?.goneReason = reason
                self?.threads[id]?.isLoading = false
            }
        ))
        if await socket.isOpen {
            // Not awaited: the page lands through the handlers, and a caller
            // that waited here would be a screen that cannot paint its cache.
            let resume = subscriptions.resume(id, tail: coldOpenTail)
            Task { [weak self] in
                _ = try? await resume.value
                self?.threads[id]?.isLoading = false
            }
        }
    }

    /// The thread left the screen: leave the set so a reconnect does not replay it.
    public func closeThread(_ id: String) {
        subscriptions.remove(id)
        threads[id]?.isLive = false
    }

    /// Older rows: from the cache while it has them, then from the host.
    public func loadOlder(_ id: String) async {
        guard var state = threads[id], !state.isLoadingOlder, state.moreBefore, let first = state.rows.first else { return }
        state.isLoadingOlder = true
        threads[id] = state
        defer { threads[id]?.isLoadingOlder = false }
        let cached = (try? await cache.rows(environment.id, sessionId: id, before: first.seq, limit: olderPage)) ?? []
        if !cached.isEmpty {
            prepend(id, rows: cached, moreBefore: nil)
            return
        }
        guard await socket.isOpen else { return }
        guard let page = try? await socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: first.seq, tail: olderPage, limit: nil)) else { return }
        try? await cache.store(environment.id, sessionId: id, rows: page.rows, moreBefore: page.moreBefore)
        prepend(id, rows: page.rows, moreBefore: page.moreBefore)
    }

    /// The whole row behind an omitted body: the cache, else `session.rowBody`.
    public func body(sessionId: String, seq: Int) async -> EventRow? {
        if let cached = try? await cache.body(environment.id, sessionId: sessionId, seq: seq) { return cached }
        guard let answer = try? await socket.request(Methods.SessionRowBody.self, .init(sessionId: sessionId, seq: seq)) else { return nil }
        try? await cache.storeBody(environment.id, sessionId: sessionId, seq: seq, row: answer.row)
        return answer.row
    }

    /// The workspace's icon, asked of the host once per launch and kept in the
    /// cache; the screen paints whatever the cache held meanwhile.
    public func loadIcon(_ workspaceId: String) async {
        guard !iconRequests.contains(workspaceId), await socket.isOpen else { return }
        iconRequests.insert(workspaceId)
        guard let answer = try? await socket.request(Methods.WorkspaceIcon.self, .init(workspaceId: workspaceId)) else {
            iconRequests.remove(workspaceId)
            return
        }
        let icon = CachedIcon(dataUrl: answer.dataUrl, host: answer.host?.rawValue)
        guard icons[workspaceId] != icon else { return }
        icons[workspaceId] = icon
        try? await cache.storeIcon(environment.id, workspaceId: workspaceId, icon)
    }

    /// A `GET` the host answers for `tempcode-asset://<host>/<path>` content
    /// (logos, media, agent pages), with the key as the bearer.
    public func assetRequest(host: String, path: String) -> URLRequest? {
        guard let key = try? keys.key(for: environment.id) else { return nil }
        var request = URLRequest(url: environment.origin.appending(path: "/asset/\(host)/\(path)"))
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        return request
    }

    // MARK: - the socket's events

    private func handle(_ event: SessionEvent) async {
        switch event {
        case .opened:
            subscriptions.sessionChanged()
            await refreshShell()
            await subscriptions.resumeAll(tail: coldOpenTail)
            for id in threads.keys where subscriptions.has(id) {
                threads[id]?.isLoading = false
                threads[id]?.isLive = subscriptions.isLive(id)
            }
            await socket.markFresh(true)
        case .closed:
            subscriptions.sessionChanged()
            for id in threads.keys { threads[id]?.isLive = false }
        }
    }

    /// Lists the shell on a new session and merges it in; sessions the full
    /// walk did not name are gone from the host.
    private func refreshShell() async {
        // The three lists are independent: one round trip for the shell.
        async let workspacesList = try? socket.request(Methods.WorkspaceList.self, NoParams())
        async let projectsList = try? socket.request(Methods.ProjectList.self, NoParams())
        async let firstPage = try? socket.request(Methods.SessionList.self, .init(archived: nil, projectId: nil, cursor: nil))
        if let list = await workspacesList {
            workspaces = list
            try? await cache.replaceWorkspaces(environment.id, list)
        }
        if let list = await projectsList {
            projects = list
            try? await cache.replaceProjects(environment.id, list)
        }
        let (listed, complete) = await walk(pages: await firstPage, archived: false)
        if complete {
            let gone = sessions.filter { !$0.archived && !listed.contains($0.id) }.map(\.id)
            if !gone.isEmpty { removeSessions(gone) }
        }
        hasShell = true
        // The archived threads come after the live shell is up, off the open
        // handler, so a long archive never delays the subscriptions.
        Task { [weak self] in await self?.refreshArchived() }
    }

    /// `session.list` answers live or archived threads, never both; the shell
    /// needs the archived ones for its "n archived" rows.
    private func refreshArchived() async {
        let first = try? await socket.request(Methods.SessionList.self, .init(archived: true, projectId: nil, cursor: nil))
        let (listed, complete) = await walk(pages: first, archived: true)
        if complete {
            let gone = sessions.filter { $0.archived && !listed.contains($0.id) }.map(\.id)
            if !gone.isEmpty { removeSessions(gone) }
        }
    }

    /// Merges every page from `first` on; `complete` says the walk reached the end.
    private func walk(pages first: SessionPage?, archived: Bool) async -> (listed: Set<String>, complete: Bool) {
        var listed: Set<String> = []
        var page = first
        for _ in 0..<40 {
            guard let current = page else { return (listed, false) }
            merge(current.sessions)
            for session in current.sessions { listed.insert(session.id) }
            guard let cursor = current.cursor else { return (listed, true) }
            page = try? await socket.request(Methods.SessionList.self, .init(archived: archived, projectId: nil, cursor: cursor))
        }
        return (listed, false)
    }

    private func apply(_ push: ServerPush) async {
        switch push {
        case .hello:
            break
        case .workspaces(let value):
            workspaces = value.workspaces
            try? await cache.replaceWorkspaces(environment.id, value.workspaces)
        case .projects(let value):
            projects = value.projects
            try? await cache.replaceProjects(environment.id, value.projects)
        case .sessions(let value):
            merge(value.sessions)
        case .sessionRemoved(let value):
            removeSessions(value.sessionIds)
        case .events(let value):
            guard threads[value.sessionId] != nil else { return }
            append(value.sessionId, rows: value.rows)
            threads[value.sessionId]?.isLive = true
            try? await cache.store(environment.id, sessionId: value.sessionId, rows: value.rows)
        case .queue, .liveEdits, .builds, .unknown:
            break
        }
    }

    // MARK: - folding

    private func merge(_ metas: [SessionMeta]) {
        guard !metas.isEmpty else { return }
        var byId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        for meta in metas { byId[meta.id] = meta }
        sessions = byId.values.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.upsertSessions(env, metas) }
    }

    private func removeSessions(_ ids: [String]) {
        let gone = Set(ids)
        sessions.removeAll { gone.contains($0.id) }
        for id in ids {
            threads[id] = nil
            subscriptions.remove(id)
            seen[id] = nil
        }
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.removeSessions(env, ids) }
    }

    private func fold(_ id: String, page: EventsPage, tailFirst: Bool) {
        guard var state = threads[id] else { return }
        if page.reset || tailFirst {
            state.rows = page.rows
            state.moreBefore = page.moreBefore
            state.isLoading = false
            state.isLive = true
            threads[id] = state
        } else {
            append(id, rows: page.rows)
            threads[id]?.isLoading = false
            threads[id]?.isLive = true
        }
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.store(env, sessionId: id, rows: page.rows, moreBefore: page.reset || tailFirst ? page.moreBefore : nil, reset: page.reset) }
    }

    /// Adds rows after the fold, never a seq twice; a replayed row with a
    /// known seq replaces the one held (a tool result completing a partial call).
    private func append(_ id: String, rows: [EventRow]) {
        guard var state = threads[id], !rows.isEmpty else { return }
        var index: [Int: Int] = [:]
        for (offset, row) in state.rows.enumerated() { index[row.seq] = offset }
        var appended = false
        for row in rows {
            if let at = index[row.seq] {
                state.rows[at] = row
            } else {
                index[row.seq] = state.rows.count
                state.rows.append(row)
                appended = true
            }
        }
        if appended, let last = state.rows.last, rows.contains(where: { $0.seq < last.seq }) {
            state.rows.sort { $0.seq < $1.seq }
        }
        if state.rows.count > threadRowsInMemory {
            state.rows.removeFirst(state.rows.count - threadRowsInMemory)
            state.moreBefore = true
        }
        threads[id] = state
    }

    private func prepend(_ id: String, rows: [EventRow], moreBefore: Bool?) {
        guard var state = threads[id] else { return }
        let known = Set(state.rows.map(\.seq))
        let fresh = rows.filter { !known.contains($0.seq) }
        state.rows = (fresh + state.rows).sorted { $0.seq < $1.seq }
        if let moreBefore {
            state.moreBefore = moreBefore
        } else if fresh.isEmpty {
            state.moreBefore = false
        }
        threads[id] = state
    }
}
