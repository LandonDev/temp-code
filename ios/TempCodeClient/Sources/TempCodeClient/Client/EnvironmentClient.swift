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
    /// The next optimistic row's key: below every provisional call's.
    public var nextPendingKey = -100_000
    /// A send is on its way: from the click until the host's status moves
    /// (the turn starts, is held, or a status row lands after the echo). The
    /// echo alone never ends it, so the slot and the button hold busy
    /// through the gap between the echo and the host's `starting`.
    public var sending = false
    /// When the person's click opened the turn the slot is timing (the
    /// desktop's `sentAt`): stamped by a send into a thread with no turn
    /// open, kept after the host's `busySince` lands so the timer never
    /// steps back by the round trip, cleared once the turn settles.
    public var sentAt: Int?
    /// The seq of the clicked send's echo: a status row after it is the
    /// host's word on the turn the click opened.
    public var sendEcho: Int?
    /// The host's `busySince` for the turn the click opened, once it showed
    /// open: a later turn carries another, so a click that outlived its turn
    /// never times the next one (`ComposerSlot.turnStart`).
    public var sentTurn: Int?
    /// Approval decisions this device gave that the host has not confirmed yet, by request id.
    public var decisions: [String: Bool] = [:]
    /// Approvals whose decision is on the wire, by request id: a second tap sends nothing.
    public var deciding: Set<String> = []
    /// The line a refused decision left, by request id, until the next decision.
    public var refusals: [String: String] = [:]
    /// Question answers this device gave that the host has not confirmed yet, by request id.
    public var answers: [String: [[String]]] = [:]

    public init() {}

    /// The fold's items with the pending turns at the end: what the transcript shows.
    public var entries: [ThreadEntry] {
        pending.isEmpty ? fold.items : fold.items + pending.map(\.entry)
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
    ///
    /// The common push, rows past the last one held, searches nothing: a
    /// row's seq is looked for only when it is not past the newest, and a
    /// preview's row only when the fold holds its call as a preview
    /// (`ThreadFold.held`). A trimmed thread grows `threadRowsSlack` past
    /// `threadRowsInMemory` before it is cut back, so the refold a cut
    /// costs comes once per that many rows, and it is never cut while the
    /// cut would take a row the reader's window shows (`keeping`, the
    /// oldest seq the window holds).
    mutating func append(_ incoming: [EventRow], trim: Bool, keeping floor: Int? = nil) {
        revision += 1
        var incremental = true
        var needsSort = false
        var newest = rows.last(where: { $0.ephemeral != true })?.seq
        for row in incoming {
            if let callId = Self.partialCallId(row) {
                switch previewRow(callId, incremental: incremental) {
                case .stale: continue
                case .at(let at): rows[at] = row
                case .none: rows.append(row)
                }
                if incremental { fold.apply(row) }
                continue
            }
            if let held = newest, row.seq <= held {
                if let at = rows.firstIndex(where: { $0.ephemeral != true && $0.seq == row.seq }) {
                    rows[at] = row
                    incremental = false
                    continue
                }
                needsSort = needsSort || row.seq < held
                incremental = false
            }
            if case .toolCall(let call) = row.event, case .at(let at) = previewRow(call.callId, incremental: incremental) {
                rows.remove(at: at)
            }
            rows.append(row)
            newest = max(newest ?? row.seq, row.seq)
            if incremental { fold.apply(row) }
        }
        if needsSort {
            // Persisted rows by seq; a streaming preview stays at the tail.
            rows.sort { ($0.ephemeral == true ? Int.max : $0.seq) < ($1.ephemeral == true ? Int.max : $1.seq) }
        }
        if trim, rows.count > threadRowsInMemory + threadRowsSlack {
            let cut = rows.count - threadRowsInMemory
            // The window's rows stay: the cut waits while its newest row is one the reader's list still shows.
            if floor.map({ rows[cut - 1].seq < $0 }) ?? true {
                rows.removeFirst(cut)
                moreBefore = true
                incremental = false
            }
        }
        if !incremental { refold() }
    }

    private enum PreviewRow {
        /// No row is held for the call's preview.
        case none
        /// The preview is behind its own final row: stale, never held.
        case stale
        case at(Int)
    }

    /// Where the streaming preview of `callId` sits in `rows`. While the
    /// fold is current it answers without a search for a call that has no
    /// preview; once a row of this batch needs a refold the fold is behind,
    /// and the rows themselves are searched, as they always were.
    private func previewRow(_ callId: String, incremental: Bool) -> PreviewRow {
        if incremental {
            switch fold.held(callId) {
            case nil: return .none
            case .final?: return .stale
            case .preview?: break
            }
        }
        if let at = rows.lastIndex(where: { Self.partialCallId($0) == callId }) { return .at(at) }
        return rows.contains(where: { Self.persistedCallId($0) == callId }) ? .stale : .none
    }

    /// The fold rebuilt from every row held; the live edits carry over.
    mutating func refold() {
        var rebuilt = ThreadFold(keys: fold.keys, provisionalFrom: fold)
        for row in rows { rebuilt.apply(row) }
        rebuilt.carryLiveEdits(from: fold)
        fold = rebuilt
        refolds += 1
    }

    /// What this device did optimistically, confirmed by the host's rows: the
    /// echo of a sent text retires its pending turn (and Sending… once none
    /// remain), its row taking the pending row's key; a resolved approval or
    /// question retires its overlay.
    mutating func settle(_ rows: [EventRow]) {
        for row in rows where row.ephemeral != true {
            switch row.event {
            case .userText(let event):
                if let at = pending.firstIndex(where: { $0.text == event.text }) {
                    // The echo is drawn where the optimistic row was, under its key.
                    if let key = pending[at].key { fold.rekeyEcho(seq: row.seq, key: key) }
                    pending.remove(at: at)
                    if sending || sentAt != nil { sendEcho = row.seq }
                }
            case .status(let event):
                // The host's status after the echo: the turn moved, or it already closed.
                guard let echo = sendEcho, row.seq > echo else { break }
                sending = false
                if !ComposerSlot.turnOpen(event.status) { clearClick() }
            case .approvalResolved(let event):
                decisions[event.requestId] = nil
            case .questionResolved(let event):
                answers[event.requestId] = nil
            default:
                break
            }
        }
    }

    /// A send leaves: busy from the click, and the clock stamped when no
    /// turn is open (a steer into an open turn keeps that turn's clock).
    /// Answers whether this click opened the turn.
    @discardableResult
    mutating func beginSend(status: SessionStatus?, at time: Int) -> Bool {
        let opens = sentAt == nil && !ComposerSlot.turnOpen(status)
        sending = true
        if opens {
            sentAt = time
            sendEcho = nil
            sentTurn = nil
        }
        return opens
    }

    /// The host's meta for this thread. A turn open or held is the status
    /// moving: busy is the host's from here. Once the turn the click opened
    /// has shown open and closed again, or the status settled with nothing
    /// out, the click's clock goes.
    mutating func observe(_ meta: SessionMeta) {
        let next = click(after: meta)
        if next != click { click = next }
    }

    /// Whether `observe` would move the click's busy or clock: asked first,
    /// so a meta that moves neither writes nothing to the thread.
    func observes(_ meta: SessionMeta) -> Bool {
        click(after: meta) != click
    }

    /// The click's busy and clock, the four fields `observe` moves.
    private struct Click: Equatable {
        var sending = false
        var sentAt: Int?
        var sendEcho: Int?
        var sentTurn: Int?
    }

    private var click: Click {
        get { Click(sending: sending, sentAt: sentAt, sendEcho: sendEcho, sentTurn: sentTurn) }
        set {
            sending = newValue.sending
            sentAt = newValue.sentAt
            sendEcho = newValue.sendEcho
            sentTurn = newValue.sentTurn
        }
    }

    private func click(after meta: SessionMeta) -> Click {
        var next = click
        let open = ComposerSlot.turnOpen(meta.status)
        if open {
            next.sending = false
            if next.sentAt != nil, next.sentTurn == nil { next.sentTurn = meta.busySince }
        } else if meta.status == .paused || meta.status == .queued || meta.status == .stopped {
            next.sending = false
        }
        if !open, !next.sending || next.sentTurn != nil { next = Click() }
        return next
    }

    private mutating func clearClick() {
        click = Click()
    }

    /// When the open turn's clock started, as the slot shows it.
    public func turnStart(busySince: Int?) -> Int? {
        ComposerSlot.turnStart(sentAt: sentAt, busySince: busySince, sentTurn: sentTurn)
    }

    /// A message this device sends, pending under the next optimistic key.
    mutating func addPending(text: String, sentAt: Int) -> PendingTurn {
        let turn = PendingTurn(text: text, sentAt: sentAt, key: nextPendingKey)
        nextPendingKey -= 1
        pending.append(turn)
        return turn
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
/// How far past `threadRowsInMemory` a trimmed thread grows before it is cut back to it.
public let threadRowsSlack = 400
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
    /// The host; its `name` is the label the registry gave it (`relabel`).
    public private(set) var environment: PairedEnvironment
    public private(set) var status: EnvironmentStatus = .idle
    public private(set) var workspaces: [WorkspaceMeta] = []
    public private(set) var projects: [ProjectMeta] = []
    /// The sessions as they are now, outside observation (`SessionStore`):
    /// `merge` compares an incoming meta with the one held before it does
    /// any work, and everything in the client that must act on the meta as
    /// it is reads here (the badge, the Live Activity, the seen mark, a
    /// push's trim, a send's status, a bare thread's placing).
    @ObservationIgnored let store = SessionStore()
    /// The sessions the list screens read, newest first: the store's list,
    /// caught up at once while Home's list is on screen and at most four
    /// times a second while it is not (`publishListed`), so a busy host's
    /// metas do not redraw lists nobody is looking at. `seen` goes with it.
    public private(set) var listedSessions: [SessionMeta] = []
    /// Moves whenever the store or the seen marks do: what a reader off the
    /// body follows to work out its own answer from the current ones (the
    /// project shell's strip). No view reads it in its body.
    public private(set) var liveRevision = 0
    /// Every held thread, each observed on its own (`ThreadModel`); the
    /// dictionary itself is no part of what a view observes.
    @ObservationIgnored private var models: [String: ThreadModel] = [:]
    /// Moves when a thread is first held or leaves: a reader that asked for
    /// a thread before it was held hears it arrive.
    private var heldStamp = 0
    /// The oldest seq each open transcript's window shows; a trim never takes it (`ThreadState.append`).
    @ObservationIgnored private var windowFloors: [String: Int] = [:]
    /// The host's catalog once `loadCatalog` fetched it.
    public internal(set) var catalog: Catalog?
    /// What each thread created (worktrees, simulators, dev instances), from the `resources` push (thread iOS 20).
    public let resources = ResourceLedger()
    /// The host's accounts snapshot (`accounts.list`, then the `accounts` push); the chip and the menu read it.
    public let accounts = HostAccounts()
    /// Each master's batch as last heard (`batch.get` or the `batch` push), by the master's id.
    public internal(set) var batches: [String: BatchState] = [:]
    /// The shell has been listed at least once in this process.
    public private(set) var hasShell = false
    /// How many complete lists the shell has had in this process: a change-log
    /// answer, or a `session.list` walk that reached its end (one cut short
    /// counts nothing). A bare thread waits on it (`ShellPaths.awaitsListing`).
    public private(set) var completeLists = 0
    /// Moves when the workspace or project list changes (a list answer or
    /// their push): a bare thread's place reads them (`ShellPaths.awaitsListing`).
    public private(set) var catalogStamp = 0
    /// Moves when a watched thread's placing fields change, or it comes or
    /// goes (`watchPlacing`); no other push writes it, so a shell waiting on
    /// one bare thread observes nothing else of the sessions.
    public private(set) var placingStamp = 0
    /// Every listed thread's placing fields (`BareSettle.placing`), outside
    /// observation; the watched ids among them move `placingStamp`.
    @ObservationIgnored private var placingIndex: [String: String] = [:]
    @ObservationIgnored private var placingWatched: Set<String> = []
    /// Where the session list last came from.
    public private(set) var shellSource: ShellSource = .none
    /// The `session.changes` head the list was last reconciled to, from the
    /// cache at `start()` and saved with every answer; nil lists whole.
    public private(set) var listCursor: ListCursor?
    /// The host's restart notice, once per boot; `dismissBootResume()` clears it.
    public private(set) var bootResume: BootResumeNotice?
    /// When the user last looked at each thread: the host's read mark for a
    /// thread whose host keeps them (`SessionMeta.readAt`), this phone's own
    /// otherwise (`ReadMarks.merged`); `markSeen` writes both.
    public private(set) var seen: [String: SeenMark] = [:]
    /// The same marks as they are now, outside observation; `seen` catches up with the list.
    @ObservationIgnored public private(set) var currentSeen: [String: SeenMark] = [:]
    /// This phone's own marks, from the cache.
    @ObservationIgnored private var localSeen: [String: SeenMark] = [:]
    /// The host's marks this phone has to send or has not heard back.
    @ObservationIgnored private var readMarks = ReadMarks()
    @ObservationIgnored private var readFlush: Task<Void, Never>?
    @ObservationIgnored private var readFirst: ContinuousClock.Instant?
    /// The app is in the foreground: only then is a thread on screen seen.
    @ObservationIgnored private var foreground = true
    /// Workspace icons as the cache holds them; `icon(_:)` asks the host once per launch.
    public private(set) var icons: [String: CachedIcon] = [:]
    /// Threads this host moved elsewhere in this process, by the root's and each subagent's id.
    public private(set) var moved: [String: MovedThread] = [:]
    private var iconRequests: Set<String> = []
    /// Each thread's notes (Client/NotesState.swift, iOS 18): fetched on first use, kept by the notes push.
    public internal(set) var notes: [String: NotesState] = [:]
    /// The batch push's coalescing (Client/Batches.swift): when each master's state last landed, the
    /// newest one waiting for its window, and the timer that lands it. Bookkeeping, never observed.
    @ObservationIgnored var batchLanded: [String: Double] = [:]
    @ObservationIgnored var batchPending: [String: BatchState] = [:]
    @ObservationIgnored var batchTimers: [String: Task<Void, Never>] = [:]
    /// The order this device heard of each thread (the list walks in `refreshShell`): every
    /// `sessions`, `session-removed` and `session-moved` push and every `adopt` stamps its ids
    /// with the next count. A `session.list` page or a change-log answer is the host's state when
    /// it answered, and the phone may handle a push the host sent after that answer before the
    /// answer itself: a walk never undoes what was stamped after it began, nor drops a thread so
    /// brought in for missing from its pages. A push older than the answer is followed by the push
    /// of whatever changed since, so letting the push win always settles on the host's state.
    @ObservationIgnored private var heardCount = 0
    @ObservationIgnored private var heardAt: [String: Int] = [:]

    public let socket: TempCodeSocket
    public let cache: SessionCache
    /// Every write this client makes to the cache, in the order it applied them (`CacheWriter`).
    @ObservationIgnored let cacheWrites: CacheWriter
    /// Rows, live edits and session metas wait here to be applied a window at a time (`PushIngress`).
    @ObservationIgnored private(set) var ingress = PushIngress()
    /// The client's own timers (the batch window) run on the clock the socket runs on.
    @ObservationIgnored let clock: any SocketClock
    public let subscriptions: Subscriptions
    /// The host detail's Activity sections (Client/HostExtras.swift, iOS 21).
    public let extras: HostExtras
    /// The phone's push registrar, when the registry gave it one: told at every open (thread L6).
    public internal(set) var push: PushRegistrar?
    /// Called with every session meta the host sent (the Live Activity follows a thread's status through it).
    public var sessionObserver: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?
    /// The thread on screen right now, if it is one of this host's. It resumes
    /// first on a new session, and only its rows publish with the view's own
    /// motion; a thread nobody is looking at publishes through `quietly`.
    public var visibleThread: String? {
        didSet {
            guard visibleThread != oldValue else { return }
            syncFocus()
            refreshSeen()
        }
    }
    /// What this socket last told the host it shows (`session.focus`).
    @ObservationIgnored var focusSignal = FocusSignal()
    /// Home's list of this host's threads is on screen.
    public var listVisible = false {
        didSet {
            // A list that shows is current at once.
            if listVisible, !oldValue { catchUpListed() }
        }
    }
    /// When the list screens' copy last caught up, and the catch-up waiting out its quarter second.
    @ObservationIgnored private var listedAt = ContinuousClock.now - .seconds(1)
    @ObservationIgnored private var listedLater: Task<Void, Never>?
    /// How often the list screens' copy catches up while no list is on screen.
    static let listedEveryMs = 250
    @ObservationIgnored private var childrenOf: [String: SessionProjection<[SessionMeta]>] = [:]
    @ObservationIgnored private var cueOf: [String: SessionProjection<AgentsCue?>] = [:]
    @ObservationIgnored private var pausedBatchOf: [String: SessionProjection<Int>] = [:]
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
    /// The registry's ear for the platform a hello names (`build.platform`), so the store remembers it.
    public var platformObserver: (@MainActor (EnvironmentClient, String) -> Void)?
    /// The registry's ear for the name a hello says, so the store remembers what the host calls itself.
    public var nameObserver: (@MainActor (EnvironmentClient, String) -> Void)?

    /// The registry's label for this host (`HostNames.labels`): only the name moves, the socket is untouched.
    public func relabel(_ name: String) {
        guard environment.name != name else { return }
        environment.name = name
    }
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
        self.cacheWrites = CacheWriter(cache: cache)
        self.presence = presence
        self.clock = clock
        self.socket = TempCodeSocket(environment: environment, keys: keys, api: api, connect: connect, clock: clock, configuration: configuration)
        self.subscriptions = Subscriptions(socket: socket)
        self.extras = HostExtras(socket: socket, environment: environment, clock: clock)
        ingress.land = { [weak self] items in self?.land(items) }
    }

    // MARK: - lifecycle

    /// Paints from the cache, then connects and follows the socket.
    public func start() async {
        guard !started else { return }
        started = true
        if let shell = try? await cache.shell(environment.id) {
            workspaces = shell.workspaces
            projects = shell.projects
            store.replace(shell.sessions)
            listedSessions = shell.sessions
            liveRevision += 1
            catalogStamp += 1
            reindexPlacing(shell.sessions, gone: [])
            if !shell.sessions.isEmpty { shellSource = .cache }
        }
        listCursor = try? await cache.cursor(environment.id)
        localSeen = (try? await cache.seen(environment.id)) ?? [:]
        refreshSeen()
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
        ingress.drop()
        await socket.stop()
        for model in models.values where model.value.isLive { model.mutate { $0.isLive = false } }
    }

    /// The environment was removed: stop and forget its cache.
    public func remove() async {
        await stop()
        push?.forget(environment.id)
        let env = environment.id
        cacheWrites.write { try? await $0.clear(env) }
        await cacheWrites.drained()
        workspaces = []
        projects = []
        store.replace([])
        listedSessions = []
        liveRevision += 1
        reindexPlacing([], gone: Set(placingIndex.keys))
        models = [:]
        heldStamp += 1
        listCursor = nil
        shellSource = .none
    }

    /// The restart notice was shown.
    public func dismissBootResume() {
        bootResume = nil
    }

    public func retry() async { await socket.retry() }
    public func setForeground(_ foreground: Bool) async {
        self.foreground = foreground
        await socket.setForeground(foreground)
    }
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

    /// The session's meta, observed on its own: a reader runs again when
    /// this session's meta changes (or first arrives, or leaves), and for no
    /// other session's.
    public func session(_ id: String) -> SessionMeta? {
        store.slot(id).meta
    }

    /// The session's meta as it is now, with nothing tracked: for code that acts.
    public func currentSession(_ id: String) -> SessionMeta? {
        store.byId[id]
    }

    /// Every session as it is now, newest first, with nothing tracked.
    public var currentSessions: [SessionMeta] {
        store.sorted
    }

    /// The thread's direct children, observed on their own: a reader runs
    /// again only when that list changed.
    public func children(of id: String) -> [SessionMeta] {
        if let held = childrenOf[id] { return held.value }
        let made = store.project { Fleet.children(of: id, in: $0) }
        childrenOf[id] = made
        return made.value
    }

    /// The agents cue of a root (`AgentsCue.of`), observed on its own.
    public func agentsCue(of rootId: String) -> AgentsCue? {
        if let held = cueOf[rootId] { return held.value }
        let made = store.project { metas in
            AgentsCue.of(rootId: rootId, metas: metas, rootRunning: metas.first { $0.id == rootId }?.status == .running)
        }
        cueOf[rootId] = made
        return made.value
    }

    /// How many of a master's batch threads are paused (`ComposerSlot.batchPaused`), observed on its own.
    public func pausedBatch(of masterId: String) -> Int {
        if let held = pausedBatchOf[masterId] { return held.value }
        let made = store.project { ComposerSlot.batchPaused(of: masterId, in: $0) }
        pausedBatchOf[masterId] = made
        return made.value
    }

    /// The held thread, observed on its own; nil for one not held. A reader
    /// that asked before the thread was held runs again when it is.
    public func thread(_ id: String) -> ThreadModel? {
        _ = heldStamp
        return models[id]
    }

    /// The held threads by id, as values: `threads[id]` reads one thread's
    /// whole state and tracks that thread alone. A view that draws rows
    /// takes `thread(_:)` and its projections instead.
    public var threads: Threads { Threads(client: self) }

    @MainActor
    public struct Threads {
        fileprivate let client: EnvironmentClient

        public subscript(id: String) -> ThreadState? {
            get { client.thread(id)?.state }
            nonmutating set {
                if let newValue {
                    client.hold(id, newValue)
                } else {
                    client.drop(id)
                }
            }
        }

        public var keys: [String] { Array(client.models.keys) }
        public var count: Int { client.models.count }
        public var isEmpty: Bool { client.models.isEmpty }
    }

    /// The held thread's state with nothing tracked.
    func peek(_ id: String) -> ThreadState? {
        models[id]?.value
    }

    /// One write to a held thread, in place; nothing for one not held.
    @discardableResult
    func write<T>(_ id: String, _ body: (inout ThreadState) -> T) -> T? {
        models[id]?.mutate(body)
    }

    /// Holds `state` for the thread: a new model, or the held one written whole.
    fileprivate func hold(_ id: String, _ state: ThreadState) {
        if let model = models[id] {
            model.mutate { $0 = state }
        } else {
            models[id] = ThreadModel(state)
            heldStamp += 1
        }
    }

    fileprivate func drop(_ id: String) {
        guard models.removeValue(forKey: id) != nil else { return }
        heldStamp += 1
    }

    /// The user is looking at the thread: its newest work counts as seen from
    /// here on. On a host that keeps read marks the mark goes there too, while
    /// the app is in the foreground and the key may operate, coalesced
    /// (`scheduleReadFlush`), so the Mac and the box read it as read.
    public func markSeen(_ id: String) {
        guard let meta = store.byId[id] else { return }
        let mark = SeenMark(at: meta.updatedAt, seq: peek(id)?.cursor ?? 0)
        if foreground, environment.allows(.operate), readMarks.read(meta) { scheduleReadFlush() }
        guard localSeen[id] != mark else { return }
        localSeen[id] = mark
        refreshSeen()
        let env = environment.id
        cacheWrites.write { try? await $0.markSeen(env, sessionId: id, at: mark.at, seq: mark.seq) }
    }

    /// The transcript on screen shows the thread's rows from `seq` on (nil:
    /// nothing older than the newest page): a trim leaves them be, so a
    /// reader who paged back keeps the page through the next live push.
    public func keepRows(_ id: String, from seq: Int?) {
        windowFloors[id] = seq
    }

    /// How long the phone waits after a mark before sending, and the longest it holds the first one.
    static let readQuietMs = 1500
    static let readMaxWaitMs = 5000

    private func scheduleReadFlush() {
        let now = ContinuousClock.now
        let first = readFirst ?? now
        readFirst = first
        let deadline = min(now + .milliseconds(Self.readQuietMs), first + .milliseconds(Self.readMaxWaitMs))
        readFlush?.cancel()
        readFlush = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            guard !Task.isCancelled else { return }
            await self?.flushReads()
        }
    }

    /// Sends what is queued in one `session.markRead`; held while the socket
    /// is down (the next open sends it), put back when the request fails.
    func flushReads() async {
        readFirst = nil
        guard await socket.isOpen else { return }
        let items = readMarks.take()
        guard !items.isEmpty else { return }
        do {
            _ = try await socket.request(Methods.SessionMarkRead.self, .init(items: items))
        } catch {
            readMarks.requeue(items)
        }
    }

    /// The seen marks every rule reads, worked out again; the list screens' copy follows with the list.
    private func refreshSeen() {
        let next = readMarks.merged(local: localSeen, sessions: store.sorted, visible: visibleThread)
        guard next != currentSeen else { return }
        currentSeen = next
        liveRevision += 1
        publishListed()
    }

    /// The list screens' copy of the sessions and the seen marks catches up
    /// with the store: at once while Home's list is on screen, else at most
    /// once in `listedEveryMs`.
    private func publishListed() {
        if listVisible {
            catchUpListed()
            return
        }
        guard listedLater == nil else { return }
        let wait = listedAt + .milliseconds(Self.listedEveryMs) - ContinuousClock.now
        if wait <= .zero {
            catchUpListed()
            return
        }
        listedLater = Task { [weak self] in
            try? await Task.sleep(for: wait)
            self?.listedLater = nil
            self?.catchUpListed()
        }
    }

    private func catchUpListed() {
        listedLater?.cancel()
        listedLater = nil
        listedAt = .now
        let sessions = store.sorted
        if sessions != listedSessions {
            publishList { listedSessions = sessions }
            PerfCounters.bump(.sessionPublishes)
        }
        if currentSeen != seen { seen = currentSeen }
    }

    /// The newest rows of a thread the screen has not opened (a needs-you line
    /// wants the request behind a waiting status). A live thread's rows are
    /// current; otherwise the cached tail is current only until the thread's
    /// meta moves on (`peeked` is the `updatedAt` the tail was fetched for),
    /// and then one page comes from the host and goes into the cache: a
    /// second approval on a thread never opened replaces the first's cue
    /// instead of hiding behind it. With no socket the cache is the answer.
    public func peekTail(_ id: String, limit: Int = 24) async -> [EventRow] {
        let updatedAt = store.byId[id]?.updatedAt ?? 0
        if let state = peek(id), !state.rows.isEmpty, state.isLive || peeked[id] == updatedAt {
            return state.rows.suffix(limit).map { $0 }
        }
        await cacheWrites.drained()
        let cached = (try? await cache.tail(environment.id, sessionId: id, limit: limit))?.rows ?? []
        if !cached.isEmpty, peeked[id] == updatedAt { return cached }
        guard await socket.isOpen,
              let page = try? await socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: nil, tail: limit, limit: nil))
        else { return cached }
        peeked[id] = updatedAt
        let env = environment.id
        cacheWrites.write { try? await $0.store(env, sessionId: id, rows: page.rows, moreBefore: page.moreBefore) }
        return page.rows
    }
    /// The meta's `updatedAt` each peeked tail was fetched for.
    private var peeked: [String: Int] = [:]

    /// Shows the thread: its cached tail at once, then a subscribe and a
    /// resume from the cache's cursor when the socket is up.
    public func openThread(_ id: String) async {
        opens[id, default: 0] += 1
        if models[id] == nil {
            var state = ThreadState()
            // What this client queued for the cache (a removal, rows pushed before a close) is on disk first.
            await cacheWrites.drained()
            if let tail = try? await cache.tail(environment.id, sessionId: id, limit: coldOpenTail) {
                state.rows = tail.rows
                state.moreBefore = tail.moreBefore
                state.fold = ThreadFold.fold(tail.rows)
            }
            // A painted tail is the screen; only an empty one is still loading.
            state.isLoading = state.rows.isEmpty
            // The screen opened at a cold launch or after a reopen: it is a fresh
            // paint, so it lands with no animation whatever the visibility says.
            // Another open of the same thread may have held it while the cache was read.
            if models[id] == nil { quietly { hold(id, state) } }
        }
        guard !subscriptions.has(id) else { return }
        subscriptions.add(id, SubscriptionHandlers(
            cursor: { [weak self] in self?.peek(id)?.cursor ?? 0 },
            page: { [weak self] page, tailFirst in self?.fold(id, page: page, tailFirst: tailFirst) },
            gone: { [weak self] reason in
                self?.write(id) {
                    $0.goneReason = reason
                    $0.isLoading = false
                }
            },
            settle: { [weak self] in self?.ingress.flush() }
        ))
        if await socket.isOpen {
            // Not awaited: the page lands through the handlers, and a caller
            // that waited here would be a screen that cannot paint its cache.
            let resume = subscriptions.resume(id, tail: coldOpenTail)
            Task { [weak self] in
                _ = try? await resume.value
                self?.write(id) { $0.isLoading = false }
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
        windowFloors[id] = nil
        write(id) { $0.isLive = false }
    }

    /// Older rows: from the cache while it has them, then from the host.
    public func loadOlder(_ id: String) async {
        guard let state = peek(id), !state.isLoadingOlder, state.moreBefore, let first = state.rows.first(where: { $0.ephemeral != true }) else { return }
        write(id) { $0.isLoadingOlder = true }
        defer { write(id) { $0.isLoadingOlder = false } }
        await cacheWrites.drained()
        let cached = (try? await cache.rows(environment.id, sessionId: id, before: first.seq, limit: olderPage)) ?? []
        if !cached.isEmpty {
            prepend(id, rows: cached, moreBefore: nil)
            return
        }
        guard await socket.isOpen else { return }
        guard let page = try? await socket.request(Methods.SessionEvents.self, .init(sessionId: id, afterSeq: nil, beforeSeq: first.seq, tail: olderPage, limit: nil)) else { return }
        let env = environment.id
        cacheWrites.write { try? await $0.store(env, sessionId: id, rows: page.rows, moreBefore: page.moreBefore) }
        prepend(id, rows: page.rows, moreBefore: page.moreBefore)
    }

    /// Fetches backwards until the exact search row is held. The bound and
    /// progress check keep a missing row or a broken host from looping.
    public func reveal(_ id: String, seq: Int, maxPages: Int = 100) async -> Int? {
        while peek(id)?.isLoading == true || peek(id)?.isLoadingOlder == true {
            guard !Task.isCancelled else { return nil }
            try? await Task.sleep(for: .milliseconds(20))
        }
        for page in 0...max(0, maxPages) {
            guard !Task.isCancelled, let state = peek(id) else { return nil }
            if let row = state.rows.first(where: { $0.seq == seq && $0.ephemeral != true }) {
                return state.fold.entryID(for: row)
            }
            guard page < maxPages, state.moreBefore,
                  let first = state.rows.first(where: { $0.ephemeral != true })?.seq, seq < first else { return nil }
            await loadOlder(id)
            guard let now = peek(id)?.rows.first(where: { $0.ephemeral != true })?.seq, now < first else { return nil }
        }
        return nil
    }

    private func needsBoardHistory(_ id: String) -> Bool {
        switch store.byId[id]?.threadType {
        case .implementation?, .research?, .orchestration?, .planning?, .projectPlan?: true
        default: false
        }
    }

    /// A transcript-only thread keeps its newest rows in memory. A board
    /// thread keeps the history its fold needs, and a thread whose meta has
    /// not listed yet is not cut either: it may be a board.
    private func trims(_ id: String) -> Bool {
        store.byId[id] != nil && !needsBoardHistory(id)
    }

    private func cancelHistory(_ id: String) {
        historyTokens[id] = nil
        historyLoads.removeValue(forKey: id)?.cancel()
        if peek(id)?.isLoadingHistory == true { write(id) { $0.isLoadingHistory = false } }
    }

    /// Fetch pages without publishing each intermediate fold. The transcript
    /// keeps painting its tail; the complete fold is built off the main actor.
    private func loadBoardHistory(_ id: String) {
        guard needsBoardHistory(id), historyLoads[id] == nil,
              let state = peek(id), state.moreBefore,
              let first = state.rows.first(where: { $0.ephemeral != true })?.seq else { return }
        let token = UUID()
        historyTokens[id] = token
        write(id) {
            $0.isLoadingHistory = true
            $0.historyError = nil
        }
        historyLoads[id] = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.historyTokens[id] == token {
                    self.historyLoads[id] = nil
                    self.historyTokens[id] = nil
                    self.write(id) { $0.isLoadingHistory = false }
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
                while let current = self.peek(id), self.historyTokens[id] == token {
                    try Task.checkCancellation()
                    let revision = current.revision
                    let complete = await Self.foldHistory(older: older, current: current.rows)
                    guard self.historyTokens[id] == token, let held = self.peek(id) else { return }
                    if held.revision != revision { continue }
                    self.write(id) { latest in
                        latest.rows = complete.rows
                        var fold = complete.fold
                        fold.carryLiveEdits(from: latest.fold)
                        fold.carryWaitOutcomes(from: latest.fold)
                        latest.fold = fold
                        latest.moreBefore = false
                        latest.revision += 1
                    }
                    break
                }
            } catch {
                if self.historyTokens[id] == token, !Task.isCancelled {
                    self.write(id) { $0.historyError = "Earlier board history could not be loaded. Reconnect to try again." }
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
        let env = environment.id
        cacheWrites.write { try? await $0.storeBody(env, sessionId: sessionId, seq: seq, row: answer.row) }
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
        let env = environment.id
        cacheWrites.write { try? await $0.storeIcon(env, workspaceId: workspaceId, icon) }
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

    /// Names the thread on screen to the host (`session.focus { sessionId,
    /// shown }`), so its rows leave the push coalescer as they land and its
    /// own notices stay off the phone while it is on screen; null once the
    /// app leaves the screen. Once per change, again after a reconnect; a
    /// key below operate sends nothing.
    func syncFocus() {
        guard let value = focusSignal.want(visibleThread, canSend: block(needs: .operate) == nil) else { return }
        Task { [weak self] in
            _ = try? await self?.request(Methods.SessionFocus.self, .init(sessionId: value, shown: value.map(Patch.set) ?? .clear))
        }
    }

    // MARK: - the socket's events

    private func handle(_ event: SessionEvent) async {
        switch event {
        case .opened(let hello):
            // The transport keeps the hello off the push stream: a carrier's hello lists the
            // hosts it relays, a relayed lane's carries its own row; the registry hears both here.
            // The host's own name and platform first: the carrier's list is read against them.
            if let platform = hello.build?.platform { platformObserver?(self, platform) }
            if let name = hello.name, !environment.isRelayed { nameObserver?(self, name) }
            if let hosts = hello.hosts { relayObserver?(self, hosts, true) }
            if let presence = hello.presence {
                // A relayed lane's hello carries its own row: the lane knows its
                // state without a registry (the registry then stamps `since`).
                if presence.environmentId == environment.id { await applyRelayState(RelayState(presence), presence: presence, since: stateSince) }
                relayObserver?(self, [presence], false)
            }
            subscriptions.sessionChanged()
            // Nothing of an earlier socket waits behind the new one's pages.
            ingress.flush()
            // A new socket has told the host nothing: name the thread on screen again.
            focusSignal.reconnected()
            syncFocus()
            // Marks made while the host was away go now.
            await flushReads()
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
            for (id, model) in models where subscriptions.has(id) {
                let live = subscriptions.isLive(id)
                model.mutate {
                    $0.isLoading = false
                    $0.isLive = live
                }
            }
            await socket.markFresh(true)
            await push?.sync(self)
        case .closed:
            // What still waits came from the socket that closed: applied now, it would mark its thread live.
            ingress.drop()
            focusSignal.reconnected()
            subscriptions.sessionChanged()
            extras.connectionLost()
            for id in Array(historyLoads.keys) { cancelHistory(id) }
            for model in models.values where model.value.isLive { model.mutate { $0.isLive = false } }
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
        let begun = heardCount
        // The lists are independent: one round trip for the shell. With no
        // cursor the whole list goes out alongside, since it will be needed.
        async let workspacesList = try? socket.request(Methods.WorkspaceList.self, NoParams())
        async let projectsList = try? socket.request(Methods.ProjectList.self, NoParams())
        async let changes = try? socket.request(Methods.SessionChanges.self, .init(afterSeq: cursor?.seq ?? 0, generation: cursor?.generation))
        async let coldPage = firstPage(unlessResumingFrom: cursor)
        // A list that comes back as it was is not republished: a catch-up
        // that confirms what the cache painted moves nothing on screen.
        if let list = await workspacesList {
            if list != workspaces { publishList { workspaces = list }; catalogStamp += 1 }
            let env = environment.id
            cacheWrites.write { try? await $0.replaceWorkspaces(env, list) }
        }
        if let list = await projectsList {
            if list != projects { publishList { projects = list }; catalogStamp += 1 }
            let env = environment.id
            cacheWrites.write { try? await $0.replaceProjects(env, list) }
        }
        let answer = await changes
        setListCursor(answer.map { ListCursor(seq: $0.seq, generation: $0.generation) })
        if let answer, !answer.reset, cursor != nil {
            // The change log carries archived metas too, and an archived
            // thread that left is in `removed`: no archived walk.
            ingress.flush()
            merge(unheard(answer.sessions ?? [], since: begun))
            let removed = unheard(answer.removed ?? [], since: begun)
            if !removed.isEmpty { removeSessions(removed) }
            hasShell = true
            completeLists += 1
            shellSource = .changes
            _ = await coldPage
            return
        }
        let page: SessionPage? = cursor == nil
            ? await coldPage
            : try? await socket.request(Methods.SessionList.self, .init(archived: nil, projectId: nil, cursor: nil))
        let (listed, complete) = await walk(pages: page, archived: false, since: begun)
        if complete {
            let gone = unheard(store.sorted.filter { !$0.archived && !listed.contains($0.id) }.map(\.id), since: begun)
            if !gone.isEmpty { removeSessions(gone) }
            completeLists += 1
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
        cacheWrites.write { try? await $0.setCursor(env, cursor) }
    }

    /// `session.list` answers live or archived threads, never both; the shell
    /// needs the archived ones for its "n archived" rows.
    private func refreshArchived() async {
        let begun = heardCount
        let first = try? await socket.request(Methods.SessionList.self, .init(archived: true, projectId: nil, cursor: nil))
        let (listed, complete) = await walk(pages: first, archived: true, since: begun)
        if complete {
            let gone = unheard(store.sorted.filter { $0.archived && !listed.contains($0.id) }.map(\.id), since: begun)
            if !gone.isEmpty { removeSessions(gone) }
        }
    }

    /// Merges every page from `first` on, except the threads heard of after `begun`;
    /// `complete` says the walk reached the end.
    private func walk(pages first: SessionPage?, archived: Bool, since begun: Int) async -> (listed: Set<String>, complete: Bool) {
        var listed: Set<String> = []
        var page = first
        for _ in 0..<40 {
            guard let current = page else { return (listed, false) }
            ingress.flush()
            merge(unheard(current.sessions, since: begun))
            for session in current.sessions { listed.insert(session.id) }
            guard let cursor = current.cursor else { return (listed, true) }
            page = try? await socket.request(Methods.SessionList.self, .init(archived: archived, projectId: nil, cursor: cursor))
        }
        return (listed, false)
    }

    private func apply(_ push: ServerPush) async {
        switch push {
        case .hello:
            // The transport answers `open()` with the hello; it arrives as `SessionEvent.opened`.
            break
        case .resync:
            ingress.flush()
            async let shell: Void = refreshShell()
            await subscriptions.resumeAll(tail: coldOpenTail, first: visibleThread)
            await shell
        case .presence(let value):
            relayObserver?(self, value.hosts, true)
        case .workspaces(let value):
            ingress.flush()
            if value.workspaces != workspaces { publishList { workspaces = value.workspaces }; catalogStamp += 1 }
            let env = environment.id
            cacheWrites.write { try? await $0.replaceWorkspaces(env, value.workspaces) }
        case .projects(let value):
            ingress.flush()
            if value.projects != projects { publishList { projects = value.projects }; catalogStamp += 1 }
            let env = environment.id
            cacheWrites.write { try? await $0.replaceProjects(env, value.projects) }
        case .sessions(let value):
            ingress.take(.sessions(value.sessions))
        case .sessionRemoved(let value):
            ingress.flush()
            heard(value.sessionIds)
            removeSessions(value.sessionIds)
        case .sessionMoved(let value):
            // The thread now runs on another host (docs/box.md "Moving a thread
            // between hosts"); this host keeps a hidden tombstone and sends a
            // session-removed next, so the phone drops its copy here, and
            // remembers where it went for a screen that is open on it.
            ingress.flush()
            let record = MovedThread(sessionId: value.id, to: value.to, subagents: value.sessionIds.filter { $0 != value.id }, at: Int(Date().timeIntervalSince1970 * 1000))
            for id in [value.id] + record.subagents { moved[id] = record }
            heard(value.sessionIds)
            removeSessions(value.sessionIds)
        case .events(let value):
            ingress.take(.events(sessionId: value.sessionId, rows: value.rows))
        case .resources(let value):
            resources.apply(value)
        case .bootResume(let value):
            // The host sends it after hello on every socket; the screen shows
            // it once per boot, the stamp kept in the cache across launches.
            // Asked and stamped behind the writes already queued, never awaited by the push loop.
            let env = environment.id
            let kind = Self.bootResumeKind
            cacheWrites.write { [weak self] cache in
                let shown = try? await cache.noticeSeen(env, kind: kind)
                guard shown != value.at else { return }
                try? await cache.markNotice(env, kind: kind, at: value.at)
                await self?.show(BootResumeNotice(count: value.count, at: value.at))
            }
        case .notes(let value):
            applyNotes(value) // iOS 18: the thread's notes (Client/NotesState.swift)
        case .accounts(let value):
            accounts.apply(value.snapshot, now: Int(Date().timeIntervalSince1970 * 1000))
        case .liveEdits(let value):
            ingress.take(.liveEdits(value.items))
        case .hostDevices, .hostLog:
            extras.applyPush(push) // iOS 21: devices and the deploy log (Client/HostExtras.swift)
        case .batch(let value):
            applyBatch(value.state) // iOS 16: a master's batch, coalesced (Client/Batches.swift)
        case .queue, .builds, .macBridgeHeld, .unknown:
            break
        }
    }

    static let bootResumeKind = "boot-resume"

    /// Another ingress in place of the wall-clock one (a test's, on a clock it moves).
    func install(_ ingress: PushIngress) {
        self.ingress.drop()
        self.ingress = ingress
        ingress.land = { [weak self] items in self?.land(items) }
    }

    /// One window's pushes, applied in one synchronous block in the order
    /// they arrived (`PushIngress`). Rows: one batch per thread, held for a
    /// resume in flight when the block runs, not when the push arrived.
    /// Live edits: one write per thread. Metas: one merge, the observer and
    /// the click's clock seeing each status in order.
    private func land(_ items: [PushIngress.Item]) {
        for item in items {
            switch item {
            case .events(let sessionId, let rows):
                guard models[sessionId] != nil else { continue }
                if subscriptions.hold(sessionId, rows: rows) { continue }
                PerfCounters.mark(.batch)
                PerfCounters.bump(.pushedRows, by: rows.count)
                append(sessionId, rows: rows)
                if peek(sessionId)?.isLive != true { write(sessionId) { $0.isLive = true } }
                // A block of streaming previews alone holds nothing the cache keeps.
                if rows.contains(where: { $0.ephemeral != true }) {
                    let env = environment.id
                    cacheWrites.write { try? await $0.store(env, sessionId: sessionId, rows: rows) }
                }
            case .liveEdits(let edits):
                // The host's live diff of a file a thread is changing: into that
                // thread's fold, onto its running edit row; memory only, as on the desktop.
                var order: [String] = []
                var byThread: [String: [LiveEdit.Edit]] = [:]
                for item in edits {
                    for sessionId in item.sessionIds where models[sessionId] != nil {
                        if byThread[sessionId] == nil { order.append(sessionId) }
                        byThread[sessionId, default: []].append(item.edit)
                    }
                }
                for sessionId in order {
                    PerfCounters.bump(.threadPublishes)
                    write(sessionId) { _ = $0.fold.applyLiveEdits(byThread[sessionId] ?? []) }
                }
            case .sessions(let metas):
                // A thread listed here again (moved back) is no longer away.
                for meta in metas { moved[meta.id] = nil }
                heard(metas.map(\.id))
                merge(metas)
            }
        }
    }

    private func show(_ notice: BootResumeNotice) {
        bootResume = notice
    }

    // MARK: - folding

    /// A thread this device just created: in the list before the `sessions` push lands.
    func adopt(_ meta: SessionMeta) {
        // A meta the host pushed before this one must not land after it.
        ingress.flush()
        heard([meta.id])
        merge([meta])
    }

    /// Stamps `ids` as heard of now (`heardAt`).
    private func heard(_ ids: [String]) {
        heardCount += 1
        for id in ids { heardAt[id] = heardCount }
    }

    /// The metas of a list answer that no push or adoption has overtaken since `begun`.
    private func unheard(_ metas: [SessionMeta], since begun: Int) -> [SessionMeta] {
        metas.filter { (heardAt[$0.id] ?? 0) <= begun }
    }

    /// The ids of a list answer that no push or adoption has overtaken since `begun`.
    private func unheard(_ ids: [String], since begun: Int) -> [String] {
        ids.filter { (heardAt[$0] ?? 0) <= begun }
    }

    /// Folds metas the host sent into the list. Each is compared with the
    /// one held before any work: an equal meta is no news, and nothing
    /// sorts, observes or is written for it. A changed one moves to its
    /// place in the list (newest first, ids breaking ties) by position, the
    /// click's busy and clock follow it on a thread that is held (on screen
    /// or not: a send followed by Back still has a click in flight), and
    /// the observer and the cache get the metas that changed, in order.
    private func merge(_ metas: [SessionMeta]) {
        var changed: [SessionMeta] = []
        var readMoved = false
        for meta in metas {
            let held = store.byId[meta.id]
            if held == meta { continue }
            if held?.readAt != meta.readAt || readMarks.pending[meta.id] != nil { readMoved = true }
            readMarks.heard(meta)
            store.put(meta)
            changed.append(meta)
            // The host's status moves the click's busy and clock (`ThreadState.observe`).
            if let model = models[meta.id], model.value.observes(meta) { model.mutate { $0.observe(meta) } }
        }
        guard !changed.isEmpty else { return }
        store.refresh()
        liveRevision += 1
        publishListed()
        if readMoved { refreshSeen() }
        reindexPlacing(changed, gone: [])
        // The thread on screen is seen as of this meta: on return its rows
        // land before the list reconciles, so the earlier mark would read
        // the stale `updatedAt` and the fresh meta would make it unseen.
        if let visible = visibleThread, changed.contains(where: { $0.id == visible }) { markSeen(visible) }
        sessionObserver?(self, changed)
        let env = environment.id
        cacheWrites.write { [changed] in try? await $0.upsertSessions(env, changed) }
    }

    /// A shell's bare thread: what its meta's placing fields read now (nil
    /// while this host names none), read outside observation, with
    /// `placingStamp` observed so the reader runs again only when it moves.
    public func watchPlacing(_ id: String) -> String? {
        _ = placingStamp
        placingWatched.insert(id)
        return placingIndex[id]
    }

    private func reindexPlacing(_ metas: [SessionMeta], gone: Set<String>) {
        var moved = false
        for meta in metas {
            let placing = BareSettle.placing(of: meta)
            if placingIndex[meta.id] != placing {
                placingIndex[meta.id] = placing
                if placingWatched.contains(meta.id) { moved = true }
            }
        }
        for id in gone where placingIndex.removeValue(forKey: id) != nil {
            if placingWatched.contains(id) { moved = true }
        }
        if moved { placingStamp += 1 }
    }

    /// The threads left this host (a test's seam for the `session-removed` push).
    func forget(_ ids: [String]) {
        removeSessions(ids)
    }

    private func removeSessions(_ ids: [String]) {
        let gone = Set(ids)
        store.remove(gone)
        liveRevision += 1
        // A thread that left leaves every list at once.
        catchUpListed()
        reindexPlacing([], gone: gone)
        for id in ids {
            windowFloors[id] = nil
            quietly { drop(id) }
            subscriptions.remove(id)
            cancelHistory(id)
            localSeen[id] = nil
            peeked[id] = nil
            notes[id] = nil // iOS 18: a removed thread's notes go with it
        }
        readMarks.forget(ids)
        refreshSeen()
        let env = environment.id
        cacheWrites.write { try? await $0.removeSessions(env, ids) }
    }

    /// Publishes a change to one thread with the view's motion only when that
    /// thread is on screen; elsewhere it lands with animations off.
    private func publish(thread id: String, _ body: () -> Void) {
        PerfCounters.bump(.threadPublishes)
        if visibleThread == id { body() } else { quietly(body) }
    }

    /// Publishes a change to the shell's lists with motion only when Home shows them.
    private func publishList(_ body: () -> Void) {
        if listVisible { body() } else { quietly(body) }
    }

    private func fold(_ id: String, page: EventsPage, tailFirst: Bool) {
        // A page is not a push: rows still waiting for their window are applied (or held for this resume) first.
        ingress.flush()
        guard let model = models[id] else { return }
        PerfCounters.bump(.pages)
        if page.reset || tailFirst {
            cancelHistory(id)
            let replace = {
                model.mutate { state in
                    state.revision += 1
                    state.isLoadingHistory = false
                    state.historyError = nil
                    state.rows = page.rows
                    state.moreBefore = page.moreBefore
                    state.refold()
                    state.settle(page.rows)
                    state.isLoading = false
                    state.isLive = true
                }
            }
            PerfCounters.bump(.refolds)
            // A replaced tail is a fresh paint, not rows arriving: no motion
            // even on the thread on screen.
            if page.reset { quietly(replace) } else { publish(thread: id, replace) }
        } else {
            append(id, rows: page.rows)
            model.mutate {
                $0.isLoading = false
                $0.isLive = true
            }
        }
        if visibleThread == id { markSeen(id) }
        let env = environment.id
        let moreBefore = page.reset || tailFirst ? page.moreBefore : nil
        cacheWrites.write { try? await $0.store(env, sessionId: id, rows: page.rows, moreBefore: moreBefore, reset: page.reset) }
        loadBoardHistory(id)
    }

    /// A batch of rows into one thread: one write to its model, in place
    /// (`ThreadModel.mutate`, `ThreadState.append`), so the row array and
    /// the fold's items stay unique and are never copied for a push.
    private func append(_ id: String, rows: [EventRow]) {
        guard let model = models[id], !rows.isEmpty else { return }
        let trim = trims(id)
        let floor = windowFloors[id]
        PerfCounters.bump(.batches)
        let refolds = model.value.refolds
        publish(thread: id) {
            model.mutate { state in
                state.append(rows, trim: trim, keeping: floor)
                state.settle(rows)
            }
        }
        PerfCounters.bump(.refolds, by: model.value.refolds - refolds)
    }

    private func prepend(_ id: String, rows: [EventRow], moreBefore: Bool?) {
        guard let model = models[id] else { return }
        PerfCounters.bump(.refolds)
        publish(thread: id) {
            model.mutate { state in
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
            }
        }
    }
}
