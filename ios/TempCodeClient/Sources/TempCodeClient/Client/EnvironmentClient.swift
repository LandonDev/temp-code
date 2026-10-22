import Foundation
import Observation
import TempCodeContract

/// One opened thread as the app renders it.
public struct ThreadState: Sendable, Hashable {
    /// Oldest first, unique by seq. Ephemeral rows ride along in memory only.
    public var rows: [EventRow] = []
    /// The rows folded: transcript items with their round and todo stamps,
    /// and the board state (todos, passes, sources, agents).
    public var fold = ThreadFold()
    /// Older rows exist on the host (or in the cache) beyond `rows.first`.
    public var moreBefore = false
    /// The first page since the thread opened is still on its way.
    public var isLoading = false
    public var isLoadingOlder = false
    /// Board history loads after the transcript's tail has painted.
    public var isLoadingHistory = false
    public var historyError: String?
    /// Row version for off-actor fold checks.
    internal var revision = 0
    /// The live socket carries this thread's pushes right now.
    public var isLive = false
    /// `session.subscribe` was refused: the thread is gone from the host.
    public var goneReason: String?
    /// User turns this device sent that the host has not echoed yet; the echo clears them by text.
    public var pending: [PendingTurn] = []
    /// A send is on its way: from the call until the host starts the turn or echoes the text.
    public var sending = false
    /// Approval decisions this device gave that the host has not confirmed yet, by request id.
    public var decisions: [String: Bool] = [:]
    /// Question answers this device gave that the host has not confirmed yet, by request id.
    public var answers: [String: [[String]]] = [:]

    public init() {}

    /// The fold's items with the pending turns at the end: what the transcript shows.
    public var entries: [ThreadEntry] {
        pending.isEmpty ? fold.items : fold.items + pending.enumerated().map { $1.entry(index: $0) }
    }

    /// The last persisted seq held; a streaming preview at the tail never moves it.
    public var cursor: Int { rows.last(where: { $0.ephemeral != true })?.seq ?? 0 }

    /// Whole refolds run so far (`ThreadFold.fold` over every row held); a test seam.
    internal var refolds = 0

    /// Adds rows after the fold, never a seq twice; a replayed row with a
    /// known seq replaces the one held. A streaming preview (a partial tool
    /// call, seq -1, ephemeral) carries the whole input so far: one row per
    /// call, replaced in place wherever it sits and retired by its final
    /// call row; both fold incrementally, since the fold updates the call's
    /// item by callId. Rows that extend the tail fold incrementally too;
    /// a replayed replacement, an out-of-order page or a trim folds again.
    /// Called through the dictionary's modify accessor, so neither `rows`
    /// nor the fold's items are copied per push.
    mutating func append(_ incoming: [EventRow], trim: Bool) {
        revision += 1
        var incremental = true
        var needsSort = false
        for row in incoming {
            if let callId = Self.partialCallId(row) {
                if let at = rows.lastIndex(where: { Self.partialCallId($0) == callId }) {
                    rows[at] = row
                } else if rows.contains(where: { Self.persistedCallId($0) == callId }) {
                    // A partial behind its own final row: stale, never held.
                    continue
                } else {
                    rows.append(row)
                }
                if incremental { fold.apply(row) }
                continue
            }
            if let at = rows.firstIndex(where: { $0.ephemeral != true && $0.seq == row.seq }) {
                rows[at] = row
                incremental = false
                continue
            }
            if case .toolCall(let call) = row.event, let at = rows.lastIndex(where: { Self.partialCallId($0) == call.callId }) {
                rows.remove(at: at)
            }
            if let last = rows.last(where: { $0.ephemeral != true }), row.seq < last.seq {
                needsSort = true
                incremental = false
            }
            rows.append(row)
            if incremental { fold.apply(row) }
        }
        if needsSort {
            // Persisted rows by seq; a streaming preview stays at the tail.
            rows.sort { ($0.ephemeral == true ? Int.max : $0.seq) < ($1.ephemeral == true ? Int.max : $1.seq) }
        }
        if trim, rows.count > threadRowsInMemory {
            rows.removeFirst(rows.count - threadRowsInMemory)
            moreBefore = true
            incremental = false
        }
        if !incremental { refold() }
    }

    /// The fold rebuilt from every row held; the live edits carry over.
    mutating func refold() {
        var rebuilt = ThreadFold.fold(rows)
        rebuilt.carryLiveEdits(from: fold)
        fold = rebuilt
        refolds += 1
    }

    static func partialCallId(_ row: EventRow) -> String? {
        guard row.ephemeral == true, case .toolCall(let call) = row.event else { return nil }
        return call.callId
    }

    static func persistedCallId(_ row: EventRow) -> String? {
        guard row.ephemeral != true, case .toolCall(let call) = row.event else { return nil }
        return call.callId
    }
}

/// Tail retained after live appends for transcript-only threads. Board
/// threads keep the history their complete fold needs.
public let threadRowsInMemory = 2_000
/// Rows a cold open asks for (the wire's TAIL_ROWS); its byte target may cut it shorter.
public let coldOpenTail = 300
/// Rows one older page asks for.
public let olderPage = 200

/// Where the shell's session list came from, newest source last: nothing
/// yet, the cache's paint, a `session.changes` reconcile from the saved
/// cursor, or a whole `session.list` walk.
public enum ShellSource: Sendable, Hashable {
    case none
    case cache
    case changes
    case list
}

/// The host restarted and brought threads cut mid-turn back (the
/// `boot-resume` push): how many, and the boot's time it is deduped by.
public struct BootResumeNotice: Sendable, Hashable {
    public var count: Int
    public var at: Int

    public init(count: Int, at: Int) {
        self.count = count
        self.at = at
    }
}

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
    public internal(set) var threads: [String: ThreadState] = [:]
    /// The host's catalog once `loadCatalog` fetched it.
    public internal(set) var catalog: Catalog?
    /// What each thread created (worktrees, simulators, dev instances), from the `resources` push (thread iOS 20).
    public let resources = ResourceLedger()
    /// The host's accounts snapshot (`accounts.list`, then the `accounts` push); the chip and the menu read it.
    public let accounts = HostAccounts()
    /// The shell has been listed at least once in this process.
    public private(set) var hasShell = false
    /// Where the session list last came from.
    public private(set) var shellSource: ShellSource = .none
    /// The `session.changes` head the list was last reconciled to, from the
    /// cache at `start()` and saved with every answer; nil lists whole.
    public private(set) var listCursor: ListCursor?
    /// The host's restart notice, once per boot; `dismissBootResume()` clears it.
    public private(set) var bootResume: BootResumeNotice?
    /// When the user last looked at each thread, from the cache; `markSeen` writes it.
    public private(set) var seen: [String: SeenMark] = [:]
    /// Workspace icons as the cache holds them; `icon(_:)` asks the host once per launch.
    public private(set) var icons: [String: CachedIcon] = [:]
    /// Threads this host moved elsewhere in this process, by the root's and each subagent's id.
    public private(set) var moved: [String: MovedThread] = [:]
    private var iconRequests: Set<String> = []
    /// Each thread's notes (Client/NotesState.swift, iOS 18): fetched on first use, kept by the notes push.
    public internal(set) var notes: [String: NotesState] = [:]

    public let socket: TempCodeSocket
    public let cache: SessionCache
    public let subscriptions: Subscriptions
    /// The phone's push registrar, when the registry gave it one: told at every open (thread L6).
    public internal(set) var push: PushRegistrar?
    /// Called with every session meta the host sent (the Live Activity follows a thread's status through it).
    public var sessionObserver: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?
    /// The thread on screen right now, if it is one of this host's. It resumes
    /// first on a new session, and only its rows publish with the view's own
    /// motion; a thread nobody is looking at publishes through `quietly`.
    public var visibleThread: String?
    /// Home's list of this host's threads is on screen.
    public var listVisible = false
    /// How a change nobody is looking at is published. The app sets this to
    /// `withTransaction(Transaction(animation: nil))`, so rows that landed
    /// while the person was elsewhere are simply there when they come back,
    /// with nothing travelling. Tests count the calls.
    public var quietly: @MainActor (() -> Void) -> Void = { $0() }
    /// A relayed host's presence as the carrier last said it; nil on a paired host.
    public internal(set) var presence: HostPresence?
    /// When the relay state last moved, the phone's clock (ms); for the locked line.
    public internal(set) var stateSince: Int?
    /// The registry's ear for presence: the hello's `hosts` (`whole: true`),
    /// the hello's `presence` on a relayed lane (`whole: false`), a `presence`
    /// push (`whole: true`).
    public var relayObserver: (@MainActor (EnvironmentClient, [HostPresence], _ whole: Bool) -> Void)?
    private let keys: any KeyStore
    private var loops: [Task<Void, Never>] = []
    private var started = false
    private var historyLoads: [String: Task<Void, Never>] = [:]
    private var historyTokens: [String: UUID] = [:]
    /// Screens showing each thread right now; the subscription lives while any does.
    private var opens: [String: Int] = [:]

    /// - Parameter presence: a relayed host's last known presence (the
    ///   registry's store), so the cold paint and the first block are right
    ///   before the carrier speaks.
    public init(environment: PairedEnvironment, keys: any KeyStore, cache: SessionCache, api: RemoteAPI = RemoteAPI(), connect: @escaping WebSocketFactory = URLSessionWebSocket.factory(), clock: any SocketClock = SystemClock(), configuration: SocketConfiguration = SocketConfiguration(), presence: HostPresence? = nil) {
        self.environment = environment
        self.keys = keys
        self.cache = cache
        self.presence = presence
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
            if !shell.sessions.isEmpty { shellSource = .cache }
        }
        listCursor = try? await cache.cursor(environment.id)
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
        for id in Array(historyLoads.keys) { cancelHistory(id) }
        for loop in loops { loop.cancel() }
        loops = []
        await socket.stop()
        for id in threads.keys { threads[id]?.isLive = false }
    }

    /// The environment was removed: stop and forget its cache.
    public func remove() async {
        await stop()
        push?.forget(environment.id)
        try? await cache.clear(environment.id)
        workspaces = []
        projects = []
        sessions = []
        threads = [:]
        listCursor = nil
        shellSource = .none
    }

    /// The restart notice was shown.
    public func dismissBootResume() {
        bootResume = nil
    }

    public func retry() async { await socket.retry() }
    public func setForeground(_ foreground: Bool) async { await socket.setForeground(foreground) }
    public func setOnline(_ online: Bool) async { await socket.setOnline(online) }

    /// The one word the phone acts on for a relayed host; nil on a paired one.
    public var relayState: RelayState? { presence.map { RelayState($0) } }

    /// The registry heard the carrier: the relayed host's state moved. A down
    /// link holds the socket with the presence line as its reason; anything
    /// else lets it try.
    func applyRelayState(_ state: RelayState, presence: HostPresence, since: Int?) async {
        self.presence = presence
        self.stateSince = since
        let reason = state == .unreachable ? RelayWords.heldLine(presence, now: .now) : nil
        await socket.setHostReachable(state != .unreachable, reason: reason)
    }

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
    /// wants the request behind a waiting status). A live thread's rows are
    /// current; otherwise the cached tail is current only until the thread's
    /// meta moves on (`peeked` is the `updatedAt` the tail was fetched for),
    /// and then one page comes from the host and goes into the cache: a
    /// second approval on a thread never opened replaces the first's cue
    /// instead of hiding behind it. With no socket the cache is the answer.
    public func peekTail(_ id: String, limit: Int = 24) async -> [EventRow] {
        let updatedAt = session(id)?.updatedAt ?? 0
        if let state = threads[id], !state.rows.isEmpty, state.isLive || peeked[id] == updatedAt {
            return state.rows.suffix(limit).map { $0 }
        }
        let cached = (try? await cache.tail(environment.id, sessionId: id, limit: limit))?.rows ?? []
        if !cached.isEmpty, peeked[id] == updatedAt { return cached }
        guard await socket.isOpen,
              let page = try? await socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: nil, tail: limit, limit: nil))
        else { return cached }
        peeked[id] = updatedAt
        try? await cache.store(environment.id, sessionId: id, rows: page.rows, moreBefore: page.moreBefore)
        return page.rows
    }
    /// The meta's `updatedAt` each peeked tail was fetched for.
    private var peeked: [String: Int] = [:]

    /// Shows the thread: its cached tail at once, then a subscribe and a
    /// resume from the cache's cursor when the socket is up.
    public func openThread(_ id: String) async {
        opens[id, default: 0] += 1
        if threads[id] == nil {
            var state = ThreadState()
            if let tail = try? await cache.tail(environment.id, sessionId: id, limit: coldOpenTail) {
                state.rows = tail.rows
                state.moreBefore = tail.moreBefore
                state.fold = ThreadFold.fold(tail.rows)
            }
            // A painted tail is the screen; only an empty one is still loading.
            state.isLoading = state.rows.isEmpty
            // The screen opened at a cold launch or after a reopen: it is a fresh
            // paint, so it lands with no animation whatever the visibility says.
            quietly { threads[id] = state }
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

    /// The thread left a screen: once no screen shows it, leave the set so
    /// a reconnect does not replay it. A fleet row and the agent screen it
    /// pushed both hold the same thread; the push outlives the row.
    public func closeThread(_ id: String) {
        let remaining = max(0, (opens[id] ?? 1) - 1)
        opens[id] = remaining == 0 ? nil : remaining
        guard remaining == 0 else { return }
        subscriptions.remove(id)
        cancelHistory(id)
        threads[id]?.isLive = false
    }

    /// Older rows: from the cache while it has them, then from the host.
    public func loadOlder(_ id: String) async {
        guard var state = threads[id], !state.isLoadingOlder, state.moreBefore, let first = state.rows.first(where: { $0.ephemeral != true }) else { return }
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

    /// Fetches backwards until the exact search row is held. The bound and
    /// progress check keep a missing row or a broken host from looping.
    public func reveal(_ id: String, seq: Int, maxPages: Int = 100) async -> Int? {
        while threads[id]?.isLoading == true || threads[id]?.isLoadingOlder == true {
            guard !Task.isCancelled else { return nil }
            try? await Task.sleep(for: .milliseconds(20))
        }
        for page in 0...max(0, maxPages) {
            guard !Task.isCancelled, let state = threads[id] else { return nil }
            if let row = state.rows.first(where: { $0.seq == seq && $0.ephemeral != true }) {
                return state.fold.entryID(for: row)
            }
            guard page < maxPages, state.moreBefore,
                  let first = state.rows.first(where: { $0.ephemeral != true })?.seq, seq < first else { return nil }
            await loadOlder(id)
            guard let now = threads[id]?.rows.first(where: { $0.ephemeral != true })?.seq, now < first else { return nil }
        }
        return nil
    }

    private func needsBoardHistory(_ id: String) -> Bool {
        switch session(id)?.threadType {
        case .implementation?, .research?, .orchestration?, .planning?, .projectPlan?: true
        default: false
        }
    }

    private func cancelHistory(_ id: String) {
        historyTokens[id] = nil
        historyLoads.removeValue(forKey: id)?.cancel()
        threads[id]?.isLoadingHistory = false
    }

    /// Fetch pages without publishing each intermediate fold. The transcript
    /// keeps painting its tail; the complete fold is built off the main actor.
    private func loadBoardHistory(_ id: String) {
        guard needsBoardHistory(id), historyLoads[id] == nil,
              let state = threads[id], state.moreBefore,
              let first = state.rows.first(where: { $0.ephemeral != true })?.seq else { return }
        let token = UUID()
        historyTokens[id] = token
        threads[id]?.isLoadingHistory = true
        threads[id]?.historyError = nil
        historyLoads[id] = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.historyTokens[id] == token {
                    self.historyLoads[id] = nil
                    self.historyTokens[id] = nil
                    self.threads[id]?.isLoadingHistory = false
                }
            }
            var before = first
            var older: [EventRow] = []
            do {
                while before > 1 {
                    try Task.checkCancellation()
                    let page = try await self.socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: before, tail: olderPage, limit: nil))
                    guard self.historyTokens[id] == token else { return }
                    let rows = page.rows.filter { $0.ephemeral != true && $0.seq < before }
                    older.append(contentsOf: rows)
                    if !page.moreBefore { break }
                    guard let next = rows.map(\.seq).min(), next < before else { throw TransportError.notConnected }
                    before = next
                }
                // A live push or an older transcript page can land during the
                // off-actor fold. Rebuild against that revision before publishing.
                while let current = self.threads[id], self.historyTokens[id] == token {
                    try Task.checkCancellation()
                    let revision = current.revision
                    let complete = await Self.foldHistory(older: older, current: current.rows)
                    guard self.historyTokens[id] == token, var latest = self.threads[id] else { return }
                    if latest.revision != revision { continue }
                    latest.rows = complete.rows
                    var fold = complete.fold
                    fold.carryLiveEdits(from: latest.fold)
                    latest.fold = fold
                    latest.moreBefore = false
                    latest.revision += 1
                    self.threads[id] = latest
                    break
                }
            } catch {
                if self.historyTokens[id] == token, !Task.isCancelled {
                    self.threads[id]?.historyError = "Earlier board history could not be loaded. Reconnect to try again."
                }
            }
        }
    }

    @concurrent
    private static func foldHistory(older: [EventRow], current: [EventRow]) async -> (rows: [EventRow], fold: ThreadFold) {
        var bySeq: [Int: EventRow] = [:]
        for row in older + current where row.ephemeral != true { bySeq[row.seq] = row }
        let rows = bySeq.values.sorted { $0.seq < $1.seq } + current.filter { $0.ephemeral == true }
        return (rows, ThreadFold.fold(rows))
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
        // A relayed host's media is out of scope for this slice; the request carries the carrier's key.
        guard let key = try? keys.key(for: environment.keyOwner) else { return nil }
        var request = URLRequest(url: environment.origin.appending(path: "/asset/\(host)/\(path)"))
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        return request
    }

    // MARK: - the socket's events

    private func handle(_ event: SessionEvent) async {
        switch event {
        case .opened:
            subscriptions.sessionChanged()
            // The thread on screen catches up first, the rest of the open set
            // after it, while the shell lists alongside: the person came back
            // to the thread they left, not to the list.
            async let shell: Void = refreshShell()
            await subscriptions.resumeAll(tail: coldOpenTail, first: visibleThread)
            await shell
            // Off the open handler, as the desktop's: a count of worktrees never delays the subscriptions.
            Task { [weak self] in
                guard let self else { return }
                await self.resources.loadAll(self)
            }
            for id in threads.keys where subscriptions.has(id) {
                threads[id]?.isLoading = false
                threads[id]?.isLive = subscriptions.isLive(id)
            }
            await socket.markFresh(true)
            await push?.sync(self)
        case .closed:
            subscriptions.sessionChanged()
            for id in Array(historyLoads.keys) { cancelHistory(id) }
            for id in threads.keys { threads[id]?.isLive = false }
        }
    }

    /// Lists the shell on a new session. The session list reconciles with
    /// `session.changes` from the saved cursor (the metas that changed and
    /// the ids that left since, merged in place; the desktop's launch mirror
    /// does the same): one request, nothing republished that did not change.
    /// With no cursor, or when the host answers `reset` (another run of the
    /// server, a cursor older than its log keeps) or refuses the method (an
    /// older host), the whole `session.list` walk runs as before, and the
    /// head taken BEFORE the walk is the next cursor, so changes that land
    /// during the walk are replayed next time rather than lost.
    private func refreshShell() async {
        let cursor = listCursor
        // The lists are independent: one round trip for the shell. With no
        // cursor the whole list goes out alongside, since it will be needed.
        async let workspacesList = try? socket.request(Methods.WorkspaceList.self, NoParams())
        async let projectsList = try? socket.request(Methods.ProjectList.self, NoParams())
        async let changes = try? socket.request(Methods.SessionChanges.self, .init(afterSeq: cursor?.seq ?? 0, generation: cursor?.generation))
        async let coldPage = firstPage(unlessResumingFrom: cursor)
        // A list that comes back as it was is not republished: a catch-up
        // that confirms what the cache painted moves nothing on screen.
        if let list = await workspacesList {
            if list != workspaces { publishList { workspaces = list } }
            try? await cache.replaceWorkspaces(environment.id, list)
        }
        if let list = await projectsList {
            if list != projects { publishList { projects = list } }
            try? await cache.replaceProjects(environment.id, list)
        }
        let answer = await changes
        setListCursor(answer.map { ListCursor(seq: $0.seq, generation: $0.generation) })
        if let answer, !answer.reset, cursor != nil {
            // The change log carries archived metas too, and an archived
            // thread that left is in `removed`: no archived walk.
            merge(answer.sessions ?? [])
            if let removed = answer.removed, !removed.isEmpty { removeSessions(removed) }
            hasShell = true
            shellSource = .changes
            _ = await coldPage
            return
        }
        let page: SessionPage? = cursor == nil
            ? await coldPage
            : try? await socket.request(Methods.SessionList.self, .init(archived: nil, projectId: nil, cursor: nil))
        let (listed, complete) = await walk(pages: page, archived: false)
        if complete {
            let gone = sessions.filter { !$0.archived && !listed.contains($0.id) }.map(\.id)
            if !gone.isEmpty { removeSessions(gone) }
        } else {
            // A walk cut short (a page lost as the socket dropped) listed less
            // than the head covers: the next session lists whole again.
            setListCursor(nil)
        }
        hasShell = true
        shellSource = .list
        // The archived threads come after the live shell is up, off the open
        // handler, so a long archive never delays the subscriptions.
        Task { [weak self] in await self?.refreshArchived() }
    }

    /// The first `session.list` page, asked only when there is no cursor to
    /// resume from (it goes out beside `session.changes` then).
    private func firstPage(unlessResumingFrom cursor: ListCursor?) async -> SessionPage? {
        guard cursor == nil else { return nil }
        return try? await socket.request(Methods.SessionList.self, .init(archived: nil, projectId: nil, cursor: nil))
    }

    private func setListCursor(_ cursor: ListCursor?) {
        listCursor = cursor
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.setCursor(env, cursor) }
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
        case .hello(let hello):
            // A carrier's hello lists the hosts it relays; a relayed lane's carries its own row.
            if let hosts = hello.hosts { relayObserver?(self, hosts, true) }
            if let presence = hello.presence { relayObserver?(self, [presence], false) }
        case .presence(let value):
            relayObserver?(self, value.hosts, true)
        case .workspaces(let value):
            if value.workspaces != workspaces { publishList { workspaces = value.workspaces } }
            try? await cache.replaceWorkspaces(environment.id, value.workspaces)
        case .projects(let value):
            if value.projects != projects { publishList { projects = value.projects } }
            try? await cache.replaceProjects(environment.id, value.projects)
        case .sessions(let value):
            // A thread listed here again (moved back) is no longer away.
            for meta in value.sessions { moved[meta.id] = nil }
            merge(value.sessions)
        case .sessionRemoved(let value):
            removeSessions(value.sessionIds)
        case .sessionMoved(let value):
            // The thread now runs on another host (docs/box.md "Moving a thread
            // between hosts"); this host keeps a hidden tombstone and sends a
            // session-removed next, so the phone drops its copy here, and
            // remembers where it went for a screen that is open on it.
            let record = MovedThread(sessionId: value.id, to: value.to, subagents: value.sessionIds.filter { $0 != value.id }, at: Int(Date().timeIntervalSince1970 * 1000))
            for id in [value.id] + record.subagents { moved[id] = record }
            removeSessions(value.sessionIds)
        case .events(let value):
            guard threads[value.sessionId] != nil else { return }
            if subscriptions.hold(value.sessionId, rows: value.rows) { return }
            append(value.sessionId, rows: value.rows)
            threads[value.sessionId]?.isLive = true
            try? await cache.store(environment.id, sessionId: value.sessionId, rows: value.rows)
        case .resources(let value):
            resources.apply(value)
        case .bootResume(let value):
            // The host sends it after hello on every socket; the screen shows
            // it once per boot, the stamp kept in the cache across launches.
            let shown = try? await cache.noticeSeen(environment.id, kind: Self.bootResumeKind)
            guard shown != value.at else { return }
            try? await cache.markNotice(environment.id, kind: Self.bootResumeKind, at: value.at)
            bootResume = BootResumeNotice(count: value.count, at: value.at)
        case .notes(let value):
            applyNotes(value) // iOS 18: the thread's notes (Client/NotesState.swift)
        case .accounts(let value):
            accounts.apply(value.snapshot, now: Int(Date().timeIntervalSince1970 * 1000))
        case .liveEdits(let value):
            // The host's live diff of a file a thread is changing: into that
            // thread's fold, onto its running edit row; memory only, as on the desktop.
            for item in value.items {
                for sessionId in item.sessionIds where threads[sessionId] != nil {
                    threads[sessionId]!.fold.applyLiveEdit(item.edit)
                }
            }
        case .queue, .builds, .unknown:
            break
        }
    }

    static let bootResumeKind = "boot-resume"

    // MARK: - folding

    /// A thread this device just created: in the list before the `sessions` push lands.
    func adopt(_ meta: SessionMeta) {
        merge([meta])
    }

    private func merge(_ metas: [SessionMeta]) {
        guard !metas.isEmpty else { return }
        var byId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        for meta in metas {
            byId[meta.id] = meta
            // The host started the turn: the strip moves from Sending… to the spinner.
            if meta.status == .starting || meta.status == .running { threads[meta.id]?.sending = false }
        }
        let sorted = byId.values.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
        // A list that did not change in order or membership is not republished:
        // a catch-up that confirms what was already true moves nothing.
        if sorted != sessions { publishList { sessions = sorted } }
        // The thread on screen is seen as of this meta: on return its rows
        // land before the list reconciles, so the earlier mark would read
        // the stale `updatedAt` and the fresh meta would make it unseen.
        if let visible = visibleThread, metas.contains(where: { $0.id == visible }) { markSeen(visible) }
        sessionObserver?(self, metas)
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.upsertSessions(env, metas) }
    }

    private func removeSessions(_ ids: [String]) {
        let gone = Set(ids)
        publishList { sessions.removeAll { gone.contains($0.id) } }
        for id in ids {
            quietly { threads[id] = nil }
            subscriptions.remove(id)
            cancelHistory(id)
            seen[id] = nil
            peeked[id] = nil
            notes[id] = nil // iOS 18: a removed thread's notes go with it
        }
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.removeSessions(env, ids) }
    }

    /// Publishes a change to one thread with the view's motion only when that
    /// thread is on screen; elsewhere it lands with animations off.
    private func publish(thread id: String, _ body: () -> Void) {
        if visibleThread == id { body() } else { quietly(body) }
    }

    /// Publishes a change to the shell's lists with motion only when Home shows them.
    private func publishList(_ body: () -> Void) {
        if listVisible { body() } else { quietly(body) }
    }

    private func fold(_ id: String, page: EventsPage, tailFirst: Bool) {
        guard var state = threads[id] else { return }
        if page.reset || tailFirst {
            cancelHistory(id)
            state.revision += 1
            state.isLoadingHistory = false
            state.historyError = nil
            state.rows = page.rows
            state.moreBefore = page.moreBefore
            state.refold()
            Self.settle(&state, rows: page.rows)
            state.isLoading = false
            state.isLive = true
            if page.reset {
                // A replaced tail is a fresh paint, not rows arriving: no
                // motion even on the thread on screen.
                quietly { threads[id] = state }
            } else {
                publish(thread: id) { threads[id] = state }
            }
        } else {
            append(id, rows: page.rows)
            threads[id]?.isLoading = false
            threads[id]?.isLive = true
        }
        if visibleThread == id { markSeen(id) }
        let env = environment.id
        let cache = self.cache
        Task { try? await cache.store(env, sessionId: id, rows: page.rows, moreBefore: page.reset || tailFirst ? page.moreBefore : nil, reset: page.reset) }
        loadBoardHistory(id)
    }

    /// A batch of rows into one thread: one write to `threads[id]` through
    /// the subscript's modify accessor (`ThreadState.append`), so the row
    /// array and the fold's items stay unique and are mutated in place.
    private func append(_ id: String, rows: [EventRow]) {
        guard threads[id] != nil, !rows.isEmpty else { return }
        let trim = !needsBoardHistory(id)
        publish(thread: id) {
            threads[id]!.append(rows, trim: trim)
            Self.settle(&threads[id]!, rows: rows)
        }
    }

    /// What this device did optimistically, confirmed by the host's rows: the
    /// echo of a sent text retires its pending turn (and Sending… once none
    /// remain); a resolved approval or question retires its overlay.
    private static func settle(_ state: inout ThreadState, rows: [EventRow]) {
        for row in rows where row.ephemeral != true {
            switch row.event {
            case .userText(let event):
                if let at = state.pending.firstIndex(where: { $0.text == event.text }) { state.pending.remove(at: at) }
                if state.pending.isEmpty { state.sending = false }
            case .approvalResolved(let event):
                state.decisions[event.requestId] = nil
            case .questionResolved(let event):
                state.answers[event.requestId] = nil
            default:
                break
            }
        }
    }

    private func prepend(_ id: String, rows: [EventRow], moreBefore: Bool?) {
        guard var state = threads[id] else { return }
        state.revision += 1
        let known = Set(state.rows.map(\.seq))
        let fresh = rows.filter { !known.contains($0.seq) }
        state.rows = (fresh + state.rows).sorted { ($0.ephemeral == true ? Int.max : $0.seq) < ($1.ephemeral == true ? Int.max : $1.seq) }
        state.refold()
        if let moreBefore {
            state.moreBefore = moreBefore
        } else if fresh.isEmpty {
            state.moreBefore = false
        }
        publish(thread: id) { threads[id] = state }
    }
}
