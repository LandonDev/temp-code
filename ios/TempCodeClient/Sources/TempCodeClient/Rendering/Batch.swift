import Foundation
import TempCodeContract

// The master board's selectors (the desktop's surfaces/threads/master/
// useMasterModel.ts, rowBody.ts, steps.ts, rulesEdit.ts, boardActions.ts),
// pure over the wire's `BatchState` and `SessionMeta`, so the phone's board
// draws exactly what the desktop's does and every rule is tested without a
// host. Nothing here knows a step by name.

// MARK: - the board

public enum MasterBoard {
    /// Unarchived root threads carrying this master's id, oldest first (masterChildrenOf).
    public static func children(of masterId: String, in metas: [SessionMeta]) -> [SessionMeta] {
        metas
            .filter { $0.masterId == masterId && $0.parentId == nil && !$0.archived }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// A child on another host, from `BatchState.children`, with its host's meta when that host is paired.
    public struct RemoteChild: Hashable, Sendable {
        public let child: BatchState.Children
        public let meta: SessionMeta?

        public init(child: BatchState.Children, meta: SessionMeta?) {
            self.child = child
            self.meta = meta
        }

        public var status: SessionStatus { meta?.status ?? SessionStatus(rawValue: child.status) }
        public var threadType: ThreadType? { meta?.threadType ?? child.threadType.map(ThreadType.init(rawValue:)) }
        public var title: String { meta?.title ?? child.title }
        public var model: String { meta?.model ?? child.model }
        public var provider: ProviderId { meta?.provider ?? ProviderId(rawValue: child.provider) }
        public var createdAt: Int { meta?.createdAt ?? child.seenAt.map { Int($0) } ?? 0 }
        /// The key `landed`, `pending` and `held` use for a remote child.
        public var batchKey: String { "\(child.environmentId):\(child.sessionId)" }
    }

    public enum Source: Hashable, Sendable {
        case local(SessionMeta)
        case remote(RemoteChild)
    }

    /// One row of the board: a local child (a build folded with the plan it
    /// came from), or a child on another host.
    public struct Row: Hashable, Sendable, Identifiable {
        public var id: String { key }
        /// The plan's id when a plan started the build, else the thread's (a remote row: its batchKey).
        public let key: String
        public let source: Source
        /// The planning thread the build came from, when it is in this batch (local rows only).
        public let plan: SessionMeta?
        /// The plan's title, else the thread's.
        public let title: String
        /// The thread's own id on its host.
        public let sessionId: String
        /// nil = this host.
        public let environmentId: String?
        public let status: SessionStatus
        public let threadType: ThreadType?
        public let provider: ProviderId
        public let model: String
        /// The local meta, or the paired remote one.
        public let meta: SessionMeta?
        public let createdAt: Int
        /// A remote row whose host is out of reach.
        public let linkDown: Bool

        public init(key: String, source: Source, plan: SessionMeta?, title: String, sessionId: String, environmentId: String?, status: SessionStatus, threadType: ThreadType?, provider: ProviderId, model: String, meta: SessionMeta?, createdAt: Int, linkDown: Bool) {
            self.key = key
            self.source = source
            self.plan = plan
            self.title = title
            self.sessionId = sessionId
            self.environmentId = environmentId
            self.status = status
            self.threadType = threadType
            self.provider = provider
            self.model = model
            self.meta = meta
            self.createdAt = createdAt
            self.linkDown = linkDown
        }

        /// The key `landed`, `pending` and `held` use for this row.
        public var batchKey: String {
            if let environmentId { return "\(environmentId):\(sessionId)" }
            return sessionId
        }

        static func local(_ child: SessionMeta, plan: SessionMeta?) -> Row {
            Row(key: plan?.id ?? child.id, source: .local(child), plan: plan, title: (plan?.title.isEmpty == false ? plan?.title : nil) ?? child.title, sessionId: child.id, environmentId: nil, status: child.status, threadType: child.threadType, provider: child.provider, model: child.model, meta: child, createdAt: (plan ?? child).createdAt, linkDown: false)
        }

        static func remote(_ remote: RemoteChild) -> Row {
            Row(key: remote.batchKey, source: .remote(remote), plan: nil, title: remote.title, sessionId: remote.child.sessionId, environmentId: remote.child.environmentId, status: remote.status, threadType: remote.threadType, provider: remote.provider, model: remote.model, meta: remote.meta, createdAt: remote.createdAt, linkDown: remote.child.linkDown == true)
        }
    }

    /// foldRows: a build whose planThreadId names a thread of the same batch
    /// takes that plan's row (its key and title); the plan is never a second
    /// row. `all` is the whole store so an archived plan still lends its
    /// title. Remote children append as their own rows (never folded),
    /// oldest first with the locals by createdAt.
    public static func foldRows(children: [SessionMeta], all: [SessionMeta], masterId: String, remote: [RemoteChild] = []) -> [Row] {
        func planOf(_ build: SessionMeta) -> SessionMeta? {
            guard let planId = build.planThreadId, let plan = all.first(where: { $0.id == planId }) else { return nil }
            return plan.masterId == masterId && plan.parentId == nil ? plan : nil
        }
        var taken = Set<String>()
        var rows: [Row] = []
        for child in children {
            let plan = planOf(child)
            if let plan { taken.insert(plan.id) }
            rows.append(.local(child, plan: plan))
        }
        rows = rows.filter { !($0.plan == nil && taken.contains($0.sessionId)) }
        rows += remote.map(Row.remote)
        return rows.sorted { ($0.createdAt, $0.key) < ($1.createdAt, $1.key) }
    }

    /// `state.children` minus this host's, each with the paired host's meta when `metaOf` finds one.
    public static func remoteChildren(_ state: BatchState, localHost: String, metaOf: (String, String) -> SessionMeta?) -> [RemoteChild] {
        (state.children ?? [])
            .filter { $0.environmentId != localHost }
            .map { RemoteChild(child: $0, meta: metaOf($0.environmentId, $0.sessionId)) }
    }

    // MARK: groups

    public enum Group: String, CaseIterable, Sendable {
        case needsYou, running, queued, done

        public var label: String {
            switch self {
            case .needsYou: "Needs you"
            case .running: "Running"
            case .queued: "Queued"
            case .done: "Done"
            }
        }
    }

    /// waiting, error → needsYou; starting, running, watching, paused → running; queued → queued; else done.
    public static func group(of status: SessionStatus) -> Group {
        switch status {
        case .waiting, .error: .needsYou
        case .starting, .running, .watching, .paused: .running
        case .queued: .queued
        default: .done
        }
    }

    public struct Section: Hashable, Sendable, Identifiable {
        public let id: Group
        public let rows: [Row]

        public init(id: Group, rows: [Row]) {
            self.id = id
            self.rows = rows
        }
    }

    /// In Group order, oldest first within one; an empty group is not returned.
    public static func sections(_ rows: [Row]) -> [Section] {
        var byGroup: [Group: [Row]] = [:]
        for row in rows { byGroup[group(of: row.status), default: []].append(row) }
        return Group.allCases.compactMap { group in
            guard let list = byGroup[group], !list.isEmpty else { return nil }
            return Section(id: group, rows: list)
        }
    }

    public static func counts(_ rows: [Row]) -> [Group: Int] {
        var out: [Group: Int] = [:]
        for group in Group.allCases { out[group] = 0 }
        for row in rows { out[group(of: row.status), default: 0] += 1 }
        return out
    }

    // MARK: agents

    /// A row's subagents: the count of every unarchived session under the
    /// child by the parentId chain (subagents of subagents too) and the live
    /// ones in the fleet's buckets (the desktop's master/agentSummary.ts).
    public struct AgentSummary: Hashable, Sendable {
        public let total: Int
        public let working: Int
        public let waiting: Int
        public let failed: Int

        public init(total: Int, working: Int, waiting: Int, failed: Int) {
            self.total = total
            self.working = working
            self.waiting = waiting
            self.failed = failed
        }

        /// "4 agents", then each nonzero live state in the fleet header's
        /// words and tones, as one clause: 4 agents, 2 working, 1 needs approval, 1 failed.
        /// Done ones are in the count only.
        public var parts: [Fleet.Line] {
            var out = [Fleet.Line("\(total) \(total == 1 ? "agent" : "agents")", tone: .muted)]
            if working > 0 { out.append(Fleet.Line("\(working) working", tone: .muted)) }
            if waiting > 0 { out.append(Fleet.Line("\(waiting) needs approval", tone: .warning)) }
            if failed > 0 { out.append(Fleet.Line("\(failed) failed", tone: .danger)) }
            return out
        }

        public var text: String { parts.map(\.text).joined(separator: ", ") }
    }

    /// Every unarchived session under `rootId` in `index` (children by parent
    /// id, archived ones included so their own children still count).
    public static func subtree(of rootId: String, index: [String: [SessionMeta]]) -> [SessionMeta] {
        var out: [SessionMeta] = []
        var seen: Set<String> = [rootId]
        var stack = [rootId]
        while let id = stack.popLast() {
            for meta in index[id] ?? [] where seen.insert(meta.id).inserted {
                stack.append(meta.id)
                if !meta.archived { out.append(meta) }
            }
        }
        return out
    }

    /// The count and the live states; nil with no agents.
    public static func agentSummary(_ agents: [SessionMeta]) -> AgentSummary? {
        guard !agents.isEmpty else { return nil }
        let c = Fleet.counts(agents.map(\.status))
        return AgentSummary(total: agents.count, working: c.working, waiting: c.waiting, failed: c.failed)
    }

    /// Each row's summary by row key, from one parent index per host: a far
    /// row counts from its own host's sessions (`sessionsOf(environmentId)`,
    /// nil = this host); a row with no agents is absent.
    public static func agentSummaries(_ rows: [Row], sessionsOf: (String?) -> [SessionMeta]) -> [String: AgentSummary] {
        var indexes: [String: [String: [SessionMeta]]] = [:]
        var out: [String: AgentSummary] = [:]
        for row in rows {
            let host = row.environmentId ?? ""
            if indexes[host] == nil {
                indexes[host] = Dictionary(grouping: sessionsOf(row.environmentId).filter { $0.parentId != nil }, by: { $0.parentId ?? "" })
            }
            let index = indexes[host] ?? [:]
            if let summary = agentSummary(subtree(of: row.sessionId, index: index)) { out[row.key] = summary }
        }
        return out
    }

    // MARK: words

    /// "Implementation", "Plan", "Project plan", "Orchestration", "Research", "Chat"; "" for nil/unknown.
    public static func typeWord(_ type: ThreadType?) -> String {
        switch type {
        case .implementation?: "Implementation"
        case .planning?: "Plan"
        case .projectPlan?: "Project plan"
        case .orchestration?: "Orchestration"
        case .research?: "Research"
        case .chat?: "Chat"
        default: ""
        }
    }

    /// "12:08" for "Landed 12:08" (24-hour, zero-padded; `calendar` carries the time zone a test fixes).
    public static func clockTime(_ ms: Int, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    public struct WhatLine: Hashable, Sendable {
        public let text: String
        public let tone: Fleet.Tone

        public init(text: String, tone: Fleet.Tone) {
            self.text = text
            self.tone = tone
        }
    }

    /// rowBody.ts whatLine: waiting/error → `line` when it has text; paused →
    /// "Paused"; queued/starting/running/watching → activity (trimmed) else
    /// line.text, muted; stopped → "Stopped"; else "Landed hh:mm" when landed, else nil.
    public static func whatLine(status: SessionStatus, activity: String?, updatedAt: Int, line: Fleet.Line, landed: Bool, calendar: Calendar = .current) -> WhatLine? {
        switch status {
        case .waiting, .error:
            return line.text.isEmpty ? nil : WhatLine(text: line.text, tone: line.tone)
        case .paused:
            return WhatLine(text: "Paused", tone: .muted)
        case .queued, .starting, .running, .watching:
            let own = activity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return WhatLine(text: own.isEmpty ? line.text : StripWords.reason(fromActivity: own), tone: .muted)
        case .stopped:
            return WhatLine(text: "Stopped", tone: .muted)
        default:
            return landed ? WhatLine(text: "Landed \(clockTime(updatedAt, calendar: calendar))", tone: .muted) : nil
        }
    }

    /// A remote row whose host is away: "Out of reach on <host>", destructive tone; else nil.
    public static func remoteLine(_ row: Row, hostName: String?) -> WhatLine? {
        guard row.environmentId != nil, row.linkDown else { return nil }
        return WhatLine(text: "Out of reach on \(hostName ?? "another host")", tone: .danger)
    }

    // MARK: the body under a row

    public enum Body: Hashable, Sendable {
        case tasks([TodoItem])
        case summary(String)
    }

    /// rowBody.ts: implementation → .tasks when the fold has any; research/
    /// orchestration → .summary from the notes' State line when given, else
    /// the latest assistant line, never equal to `what`; chat/plan → nil.
    public static func body(_ type: ThreadType?, todos: [TodoItem], items: [ThreadEntry], notesState: String? = nil, what: String?) -> Body? {
        switch type {
        case .implementation?:
            return todos.isEmpty ? nil : .tasks(todos)
        case .research?, .orchestration?:
            let text = summaryLine(notesState: notesState, items: items)
            guard !text.isEmpty, text != (what ?? "") else { return nil }
            return .summary(text)
        default:
            return nil
        }
    }

    /// The first line of the notes' State section with its bullet stripped, else the thread's latest words.
    static func summaryLine(notesState: String?, items: [ThreadEntry]) -> String {
        if let notesState {
            for raw in notesState.split(whereSeparator: \.isNewline) {
                var line = raw.trimmingCharacters(in: .whitespaces)
                if line.isEmpty { continue }
                if line.hasPrefix("- ") || line.hasPrefix("* ") { line = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
                if !line.isEmpty { return line }
            }
        }
        return Fleet.lastAssistantLine(items)
    }

    /// Open while the thread works or needs the person; folded once it sits in Done.
    public static func tasksOpenByDefault(_ status: SessionStatus) -> Bool {
        group(of: status) != .done
    }

    public struct Tally: Hashable, Sendable {
        public let done: Int
        public let total: Int

        public init(done: Int, total: Int) {
            self.done = done
            self.total = total
        }

        public var text: String { "\(done)/\(total)" }
    }

    /// From the fold's todos; before the fold is loaded, from the host's `SessionMeta.tasks`; nil before any list.
    public static func tally(todos: [TodoItem], tasks: SessionMeta.Tasks?) -> Tally? {
        if !todos.isEmpty { return Tally(done: todos.count { $0.status == .completed }, total: todos.count) }
        if let tasks, tasks.total > 0 { return Tally(done: tasks.done, total: tasks.total) }
        return nil
    }

    // MARK: the foot's lines

    /// "2 of 10 landed".
    public static func mergedLine(landed: Int, pending: Int) -> String {
        "\(landed) of \(landed + pending) landed"
    }

    /// The rules as one plain sentence from the master's step list.
    public static func rulesSentence(_ rules: BatchRules) -> String {
        let steps = rules.steps
        let merges = steps.contains { $0.kind == .land }
        let landing = !merges
            ? "The branches are left unmerged"
            : rules.land == .allAtOnce
                ? "Branches land together once every thread is done"
                : "Branches land as they finish"
        let after = steps.filter { $0.kind != .land }.map { step in
            let name = step.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? step.id : name
        }
        let first = after.isEmpty ? "\(landing), nothing runs after." : "\(landing), then \(listWords(after))."
        let then = rules.then == .archiveChildren ? "Then the threads are archived." : "Then you are notified."
        return "\(first) \(then)"
    }

    /// One name alone, "A and B", "A, B and C".
    static func listWords(_ parts: [String]) -> String {
        if parts.count <= 1 { return parts.joined() }
        return "\(parts.dropLast().joined(separator: ", ")) and \(parts[parts.count - 1])"
    }

    /// "Blocked: <title> errored" / "Blocked: a thread stopped" / "Blocked: <title> failed" / "Blocked: <title> is out of reach on <host>"; nil when nothing blocks.
    public static func blockedLine(_ state: BatchState, titleOf: (String) -> String?, hostName: (String) -> String?) -> String? {
        guard let blocked = state.blocked else { return nil }
        let who = titleOf(blocked.sessionId).flatMap { $0.isEmpty ? nil : $0 } ?? "a thread"
        switch blocked.why {
        case .errored: return "Blocked: \(who) errored"
        case .stopped: return "Blocked: \(who) stopped"
        case .failed: return "Blocked: \(who) failed"
        case .unreachable:
            let host = blocked.environmentId.flatMap(hostName) ?? "another host"
            return "Blocked: \(who) is out of reach on \(host)"
        case .unknown(let why): return "Blocked: \(who) \(why)"
        }
    }
}

extension BatchState {
    /// The batch nobody has run yet: the default rules (land, gate, release), three pending steps, nothing landed.
    public static func empty(masterId: String) -> BatchState {
        let specs = [
            BatchStepSpec(id: "land", name: "Land", kind: .land),
            BatchStepSpec(id: "gate", name: "Gate", kind: .gate),
            BatchStepSpec(id: "release", name: "Release", kind: .release)
        ]
        return BatchState(
            masterId: masterId,
            rules: BatchRules(land: .asTheyFinish, steps: specs, then: .notify),
            steps: specs.map { BatchStep(id: $0.id, name: $0.name, kind: $0.kind, status: .pending, detail: "", at: nil, log: []) },
            landed: [],
            pending: [],
            held: [],
            blocked: nil,
            finishedAt: nil
        )
    }
}

// MARK: - the steps

public enum BatchSteps {
    public struct LiveStep: Hashable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let kind: BatchStepKind
        public let run: String?
        public let status: BatchStepStatus
        public let detail: String
        public let startedAt: Int?
        public let endedAt: Int?
        public let progress: BatchStep.Progress?
        public let log: [String]

        public init(id: String, name: String, kind: BatchStepKind, run: String? = nil, status: BatchStepStatus, detail: String = "", startedAt: Int? = nil, endedAt: Int? = nil, progress: BatchStep.Progress? = nil, log: [String] = []) {
            self.id = id
            self.name = name
            self.kind = kind
            self.run = run
            self.status = status
            self.detail = detail
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.progress = progress
            self.log = log
        }
    }

    /// The rules' list as written (an empty list is empty: "nothing runs after").
    public static func specs(_ rules: BatchRules) -> [BatchStepSpec] { rules.steps }

    /// The spec of a step the state names: the rules' row, else one made from
    /// the id (its kind when the id is one, else a shell step).
    static func spec(of id: String, in specs: [BatchStepSpec]) -> BatchStepSpec {
        if let spec = specs.first(where: { $0.id == id }) { return spec }
        let kind = BatchStepKind(rawValue: id)
        if case .unknown = kind { return BatchStepSpec(id: id, name: id, kind: .shell) }
        return BatchStepSpec(id: id, name: id, kind: kind)
    }

    static func ended(_ status: BatchStepStatus) -> Bool {
        status == .passed || status == .failed || status == .skipped
    }

    /// steps.ts liveSteps: the state's steps in the state's order, each
    /// described by the state's own name and kind (an older host's blank
    /// name falls to the rules' row for the id, else a spec made from the
    /// id); a land step with no progress borrows landed of (landed + pending)
    /// when > 0; then every rules step the state lacks, pending at the end.
    public static func liveSteps(_ state: BatchState) -> [LiveStep] {
        let specs = specs(state.rules)
        var seen = Set<String>()
        var out: [LiveStep] = []
        for step in state.steps {
            seen.insert(step.id)
            let spec = spec(of: step.id, in: specs)
            let kind: BatchStepKind = { if case .unknown = step.kind { return spec.kind } else { return step.kind } }()
            let status: BatchStepStatus = step.status == .unknown("done") ? .passed : step.status
            let started = step.startedAt ?? (status == .running ? step.at : nil)
            let endedAt = step.endedAt ?? (ended(status) ? step.at : nil)
            var progress = step.progress
            if progress == nil, kind == .land {
                let total = state.landed.count + state.pending.count
                if total > 0 { progress = BatchStep.Progress(done: state.landed.count, total: total) }
            }
            out.append(LiveStep(id: step.id, name: step.name.isEmpty ? spec.name : step.name, kind: kind, run: spec.run, status: status, detail: step.detail, startedAt: started, endedAt: endedAt, progress: progress, log: step.log))
        }
        for spec in specs where !seen.contains(spec.id) {
            out.append(LiveStep(id: spec.id, name: spec.name, kind: spec.kind, run: spec.run, status: .pending))
        }
        return out
    }

    /// "4m 12s" finished, the elapsed at `now` running, nil before it started.
    public static func time(_ step: LiveStep, now: Int) -> String? {
        guard let started = step.startedAt else { return nil }
        if step.status == .running { return TimeFormat.duration(ms: max(0, now - started)) }
        guard let endedAt = step.endedAt else { return nil }
        return TimeFormat.duration(ms: max(0, endedAt - started))
    }

    public struct Progress: Hashable, Sendable {
        public let count: String
        public let label: String?
        public let fraction: Double?

        public init(count: String, label: String?, fraction: Double?) {
            self.count = count
            self.label = label
            self.fraction = fraction
        }
    }

    /// "3 of 7" + label + 3/7; total 0 → count "3", fraction nil.
    public static func progress(_ step: LiveStep) -> Progress? {
        guard let p = step.progress else { return nil }
        let label = p.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.total > 0 else { return Progress(count: "\(p.done)", label: label.flatMap { $0.isEmpty ? nil : $0 }, fraction: nil) }
        return Progress(count: "\(p.done) of \(p.total)", label: label.flatMap { $0.isEmpty ? nil : $0 }, fraction: min(1, Double(p.done) / Double(p.total)))
    }

    /// The running step, else a failed one not in `folded`, else nil.
    public static func consoleStep(_ steps: [LiveStep], folded: Set<String>) -> LiveStep? {
        steps.first { $0.status == .running } ?? steps.first { $0.status == .failed && !folded.contains($0.id) }
    }

    /// The last `limit` console lines, oldest first.
    public static func tail(_ log: [String], limit: Int = 200) -> [String] {
        log.count > limit ? Array(log.suffix(limit)) : log
    }

    /// "failed" / "skipped" / nil.
    public static func statusWord(_ status: BatchStepStatus) -> String? {
        switch status {
        case .failed: "failed"
        case .skipped: "skipped"
        default: nil
        }
    }

    /// Stop reaches a running shell or publish step (batch.ts stopStep); a gate or release runs to its end.
    public static func stoppable(_ step: LiveStep) -> Bool {
        step.status == .running && (step.kind == .shell || step.kind == .publish)
    }

    /// What the console's follow keys on: the count and the newest line (the
    /// log is a 200-line ring, so the count alone stalls once full).
    public static func logKey(_ log: [String]) -> String {
        "\(log.count)|\(log.last ?? "")"
    }
}

// MARK: - editing the rules

public enum RulesEdit {
    public static let kindLabel: [BatchStepKind: String] = [
        .land: "Merge the branches",
        .gate: "Gate the merged tree",
        .release: "Release",
        .publish: "Publish the Mac release",
        .deploy: "Deploy to the box",
        .shell: "Shell command"
    ]

    public static let kindOrder: [BatchStepKind] = [.land, .gate, .release, .publish, .deploy, .shell]

    /// The kinds the list may still take: one of each built-in kind, any number of shell steps.
    public static func addableKinds(_ steps: [BatchStepSpec]) -> [BatchStepKind] {
        let taken = Set(steps.map(\.kind))
        return kindOrder.filter { $0 == .shell || !taken.contains($0) }
    }

    /// What a built-in step is called until the person renames it; a shell step is named by hand.
    public static func defaultName(_ kind: BatchStepKind) -> String {
        if kind == .shell { return "" }
        return kindLabel[kind]?.split(separator: " ").first.map(String.init) ?? kind.rawValue
    }

    /// The muted line under a step's name: its kind's label, or a shell step's command.
    public static func stepLine(_ spec: BatchStepSpec) -> String {
        if spec.kind == .shell {
            let run = spec.run?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return run.isEmpty ? "no command" : run
        }
        return kindLabel[spec.kind] ?? spec.kind.rawValue
    }

    /// An id no step in the list has: the kind, then kind-2, kind-3.
    public static func newStepId(_ kind: BatchStepKind, in steps: [BatchStepSpec]) -> String {
        let taken = Set(steps.map(\.id))
        if !taken.contains(kind.rawValue) { return kind.rawValue }
        var n = 2
        while taken.contains("\(kind.rawValue)-\(n)") { n += 1 }
        return "\(kind.rawValue)-\(n)"
    }

    public struct ShellDraft: Hashable, Sendable {
        public var name = ""
        public var run = ""
        public var cwd = ""

        public init(name: String = "", run: String = "", cwd: String = "") {
            self.name = name
            self.run = run
            self.cwd = cwd
        }
    }

    static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    public static func add(_ kind: BatchStepKind, to steps: [BatchStepSpec], shell: ShellDraft? = nil) -> [BatchStepSpec] {
        let id = newStepId(kind, in: steps)
        let step: BatchStepSpec
        if kind == .shell {
            let cwd = trimmed(shell?.cwd ?? "")
            step = BatchStepSpec(id: id, name: trimmed(shell?.name ?? ""), kind: .shell, run: trimmed(shell?.run ?? ""), cwd: cwd.isEmpty ? nil : cwd)
        } else {
            step = BatchStepSpec(id: id, name: defaultName(kind), kind: kind)
        }
        return steps + [step]
    }

    /// The List's onMove shape: the rows at `from` land before the row that
    /// was at `to` (SwiftUI's `move(fromOffsets:toOffset:)`, which this
    /// package has no SwiftUI for).
    public static func move(_ steps: [BatchStepSpec], from: IndexSet, to: Int) -> [BatchStepSpec] {
        let moving = from.filter { $0 < steps.count }.map { steps[$0] }
        var rest = steps.enumerated().filter { !from.contains($0.offset) }.map(\.element)
        let at = min(rest.count, max(0, to - from.filter { $0 < to }.count))
        rest.insert(contentsOf: moving, at: at)
        return rest
    }

    /// By id, never by index.
    public static func remove(_ steps: [BatchStepSpec], ids: Set<String>) -> [BatchStepSpec] {
        steps.filter { !ids.contains($0.id) }
    }

    public static func rename(_ steps: [BatchStepSpec], id: String, to name: String) -> [BatchStepSpec] {
        steps.map { step in
            guard step.id == id else { return step }
            return BatchStepSpec(id: step.id, name: name, kind: step.kind, run: step.run, cwd: step.cwd, when: step.when)
        }
    }

    static func plainId(_ id: String) -> Bool {
        guard let first = id.unicodeScalars.first, first.isASCII, first.properties.isAlphabetic || (first.value >= 48 && first.value <= 57) else { return false }
        return id.unicodeScalars.dropFirst().allSatisfy { scalar in
            scalar.isASCII && (scalar.properties.isAlphabetic || (scalar.value >= 48 && scalar.value <= 57) || scalar == "_" || scalar == "." || scalar == "-")
        }
    }

    /// contract-batch.ts stepsProblem, ported with its exact messages.
    public static func stepsProblem(_ steps: [BatchStepSpec]) -> String? {
        var ids = Set<String>()
        var kinds = Set<BatchStepKind>()
        for step in steps {
            if !plainId(step.id) { return "step id \"\(step.id)\" must be letters, digits, dots, dashes or underscores" }
            if ids.contains(step.id) { return "step id \"\(step.id)\" is used twice" }
            ids.insert(step.id)
            if step.kind == .shell {
                if trimmed(step.run ?? "").isEmpty { return "shell step \"\(step.id)\" has no run" }
            } else {
                if kinds.contains(step.kind) { return "two \(step.kind.rawValue) steps; one per built-in kind" }
                kinds.insert(step.kind)
                if let run = step.run, !run.isEmpty { return "step \"\(step.id)\" is \(step.kind.rawValue), which takes no run" }
            }
        }
        return nil
    }

    /// Every step named, within the contract's lengths and stepsProblem nil (Save).
    public static func stepsValid(_ steps: [BatchStepSpec]) -> Bool {
        guard steps.count <= 32 else { return false }
        for step in steps {
            let name = trimmed(step.name)
            if name.isEmpty || name.count > 80 { return false }
            if step.id.isEmpty || step.id.count > 64 { return false }
            if (step.run?.count ?? 0) > 4_000 { return false }
            if (step.cwd?.count ?? 0) > 2_000 { return false }
        }
        return stepsProblem(steps) == nil
    }

    /// A shell draft the Add button takes: a name and a command.
    public static func shellDraftValid(_ draft: ShellDraft) -> Bool {
        !trimmed(draft.name).isEmpty && !trimmed(draft.run).isEmpty
    }

    /// The whole rules the sheet saves: land, the edited steps, then, the trimmed summary (nil when empty).
    public static func rules(land: BatchLand, steps: [BatchStepSpec], then: BatchThen, summary: String) -> BatchRules {
        let line = trimmed(summary)
        return BatchRules(land: land, steps: steps, then: then, summary: line.isEmpty ? nil : line)
    }

    /// What `batch.setRules` takes: every field of `rules` set (the partial is the whole).
    public static func params(masterId: String, rules: BatchRules) -> Methods.BatchSetRules.Params {
        .init(masterId: masterId, rules: .init(land: rules.land, steps: rules.steps, then: rules.then, summary: rules.summary))
    }
}

// MARK: - the board's switches

public enum BoardActions {
    public enum Which: String, Sendable {
        case done, all

        var wire: Methods.BatchArchive.Params.Which {
            switch self {
            case .done: .done
            case .all: .all
            }
        }
    }

    /// Finished, by the batch engine's rule (done, or idle after a turn); a stopped or errored row stays.
    public static func doneRows(_ rows: [MasterBoard.Row]) -> [MasterBoard.Row] {
        rows.filter { $0.status == .idle || $0.status == .done }
    }

    public static func pausedRows(_ rows: [MasterBoard.Row]) -> [MasterBoard.Row] {
        rows.filter { $0.status == .paused }
    }

    /// ThreadBatch.hasRunningTurn on the local meta; a remote row never.
    public static func pausableRows(_ rows: [MasterBoard.Row]) -> [MasterBoard.Row] {
        rows.filter { row in
            guard row.environmentId == nil, let meta = row.meta else { return false }
            return ThreadBatch.hasRunningTurn(meta)
        }
    }

    /// The local ids `session.batch` takes for the two switches.
    public static func localIds(_ rows: [MasterBoard.Row]) -> [String] {
        rows.filter { $0.environmentId == nil }.map(\.sessionId)
    }

    public struct ConfirmCopy: Hashable, Sendable {
        public let title: String
        public let body: String
        public let cleanup: String?
        public let confirmLabel: String

        public init(title: String, body: String, cleanup: String?, confirmLabel: String) {
            self.title = title
            self.body = body
            self.cleanup = cleanup
            self.confirmLabel = confirmLabel
        }
    }

    /// "thread" / "threads".
    static func threadWord(_ n: Int) -> String { n == 1 ? "thread" : "threads" }

    /// The archive confirm's words (boardActions.ts archiveCopy).
    public static func archiveCopy(_ which: Which, count: Int, resources: Int?) -> ConfirmCopy {
        let threads = threadWord(count)
        let title = which == .done ? "Archive \(count) done \(threads)?" : "Archive all \(count) \(threads)?"
        let body = which == .done
            ? "They leave the board and stay in the archive list. The master stays."
            : "A running thread is stopped first. Every one leaves the board and stays in the archive list. The master stays."
        var cleanup: String?
        if let resources, resources > 0 {
            cleanup = "and remove their \(resources) \(resources == 1 ? "worktree or simulator" : "worktrees and simulators")"
        }
        return ConfirmCopy(title: title, body: body, cleanup: cleanup, confirmLabel: "Archive \(count)")
    }

    /// "Pause 3 running threads?" (lib/threadBatch.ts batchConfirm, scope-less).
    public static func pauseCopy(count: Int) -> ConfirmCopy {
        ConfirmCopy(
            title: "Pause \(count) running \(threadWord(count))?",
            body: "Each thread keeps its place and picks up where it was when you resume it.",
            cleanup: nil,
            confirmLabel: "Pause \(count)"
        )
    }

    /// The project's unarchived roots on the master's host in no batch and no master themselves, oldest first.
    public static func adoptCandidates(_ metas: [SessionMeta], master: SessionMeta) -> [SessionMeta] {
        guard let projectId = master.projectId else { return [] }
        return metas
            .filter { $0.id != master.id && $0.projectId == projectId && $0.parentId == nil && !$0.archived && $0.masterId == nil && $0.isMaster != true }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// The desktop's After list: every child row, oldest first.
    public static func afterChoices(_ rows: [MasterBoard.Row]) -> [MasterBoard.Row] {
        rows.sorted { ($0.createdAt, $0.key) < ($1.createdAt, $1.key) }
    }

    /// The add sheet's types in the desktop's order (AddThreadDialog.tsx TYPES; no chat).
    public static let addTypes: [ThreadType] = [.implementation, .planning, .orchestration, .research, .projectPlan]

    /// 1M is offered for a Claude model whose catalog `context` is at least 1,000,000 (catalog.ts supportsContext1m).
    public static func supportsContext1m(provider: ProviderId, model: ModelInfo?) -> Bool {
        provider == .claude && (model?.context ?? 0) >= 1_000_000
    }
}
