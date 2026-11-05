import Foundation
import TempCodeContract

/// A thread's state in the desktop's one vocabulary (components/ui/status.tsx
/// `ThreadState`), with its tree's flags folded in (sidebarRows.ts `rowState`).
public enum CardState: Sendable, Hashable {
    case waiting, failed, working, watching, paused, stopped, queued, planReady, idle, done

    /// Whether the state draws a mark at rest (threadStripModel.ts `marksAtRest`).
    public var marksAtRest: Bool { self != .idle && self != .done }

    /// The wire status's own state (`threadStateOf`).
    public nonisolated static func of(_ status: SessionStatus, planReady: Bool = false) -> CardState {
        if planReady, status != .starting, status != .running, status != .waiting, status != .error { return .planReady }
        switch status {
        case .starting, .running: return .working
        case .waiting: return .waiting
        case .paused: return .paused
        case .error: return .failed
        case .queued: return .queued
        case .stopped: return .stopped
        case .watching: return .watching
        case .done: return .done
        case .idle, .unknown: return .idle
        }
    }

    /// `rowState`: a paused tree reads paused; waiting reads waiting unless the
    /// tree needs recovery; a failure the tree has not moved past reads failed;
    /// a plan awaiting its build reads plan-ready; a settled root with live
    /// subagents reads watching, other live work under it working.
    public nonisolated static func row(_ meta: SessionMeta) -> CardState {
        if meta.status == .paused || meta.treeHasPaused == true { return .paused }
        if meta.status == .waiting, meta.treeCanContinue != true { return .waiting }
        if meta.treeHasLiveWork != true, meta.status == .error || meta.treeCanContinue == true { return .failed }
        let own = of(meta.status, planReady: ThreadStrip.planReady(meta))
        if own == .planReady { return own }
        if own == .idle || own == .done, !(meta.background?.agents.isEmpty ?? true) { return .watching }
        if meta.treeHasLiveWork == true, own == .idle || own == .done { return .working }
        return of(meta.status)
    }
}

/// A thread on a card line: its host, its meta, its state.
public struct CardThread: Sendable, Hashable {
    public var environmentId: String
    public var meta: SessionMeta
    public var state: CardState

    public init(environmentId: String, meta: SessionMeta, state: CardState? = nil) {
        self.environmentId = environmentId
        self.meta = meta
        self.state = state ?? CardState.row(meta)
    }

    public var id: String { "\(environmentId):\(meta.id)" }
    public var title: String { meta.title.isEmpty ? "Untitled" : meta.title }

    /// The tally under the title, only for a thread whose work IS a task list (`cardTasks`).
    public var tasks: SessionMeta.Tasks? { meta.threadType == .implementation ? meta.tasks : nil }

    /// Where a working line's elapsed counts from (`runningElapsed`).
    public var busySince: Int { meta.busySince ?? meta.updatedAt }

    /// A paused line's elapsed, frozen at the pause, tree-wide when known (`pausedElapsed`).
    public var pausedElapsed: Int { max(0, meta.treeFrozenActiveElapsed ?? meta.frozenActiveElapsed ?? 0) }

    /// What a needs-you or failed line says after the title: the host's
    /// verdict on a failure, else its status detail, else the state's word.
    public var detail: String {
        switch state {
        case .failed: meta.failureSummary ?? StatusDetail.of(meta) ?? "Failed"
        default: StatusDetail.of(meta) ?? "Needs you"
        }
    }
}

/// A row's subagents in the fleet's words (agents.ts `agentSummary`).
public struct AgentSummary: Sendable, Hashable {
    public enum Tone: Sendable, Hashable { case plain, waiting, failed }
    public struct Part: Sendable, Hashable {
        public var text: String
        public var tone: Tone
    }

    public var total: Int
    public var working: Int
    public var waiting: Int
    public var failed: Int

    /// "4 agents", then each nonzero live state: "2 working", "1 needs you",
    /// "1 failed" (`agentSummaryParts`), needs you and failed in their tone.
    public var parts: [Part] {
        var out = [Part(text: total == 1 ? "1 agent" : "\(total) agents", tone: .plain)]
        if working > 0 { out.append(Part(text: "\(working) working", tone: .plain)) }
        if waiting > 0 { out.append(Part(text: "\(waiting) needs you", tone: .waiting)) }
        if failed > 0 { out.append(Part(text: "\(failed) failed", tone: .failed)) }
        return out
    }

    /// Every descendant in the fleet's buckets, only while one of them works,
    /// waits or failed (sidebarRows.ts `liveAgents`).
    public nonisolated static func live(_ items: [ThreadItem]) -> AgentSummary? {
        var all: [SessionMeta] = []
        func walk(_ list: [ThreadItem]) {
            for item in list {
                all.append(item.meta)
                walk(item.children)
            }
        }
        walk(items)
        guard !all.isEmpty else { return nil }
        var out = AgentSummary(total: all.count, working: 0, waiting: 0, failed: 0)
        for meta in all {
            switch CardState.of(meta.status) {
            case .working: out.working += 1
            case .waiting: out.waiting += 1
            case .failed: out.failed += 1
            default: break
            }
        }
        return out.working + out.waiting + out.failed > 0 ? out : nil
    }
}

/// A batch thread in its master's block: working draws a still dot.
public struct BatchLine: Sendable, Hashable, Identifiable {
    public var thread: CardThread
    public var agents: AgentSummary?

    public var id: String { thread.id }
}

/// A master on its card (sidebarRows.ts `MasterBlock`): its own line with
/// the batch's done tally, its own working subagents, then each batch thread
/// with something to say one step in, loudest first; queued and settled ones
/// fold into counts. `lead` is the block's one moving mark, on the master's line.
public struct MasterCardBlock: Sendable, Hashable {
    public var master: CardThread
    public var lead: CardState
    public var unread: Bool
    public var agents: AgentSummary?
    public var lines: [BatchLine]
    public var queued: Int
    public var done: Int
    public var total: Int
}

/// One line of a project card, in the card's order.
public enum ProjectCardLine: Sendable, Hashable, Identifiable {
    /// Waiting on the person: the glyph, the title, the detail in amber.
    case needsYou(CardThread)
    /// A failure the tree has not moved past: the detail in red.
    case failed(CardThread)
    case master(MasterCardBlock)
    /// Working or watching: the mark, the type glyph, the title, the elapsed.
    case working(CardThread)
    case paused(CardThread)
    /// Settled and unseen: the title in medium, no mark.
    case unread(CardThread)

    public var thread: CardThread {
        switch self {
        case .needsYou(let t), .failed(let t), .working(let t), .paused(let t), .unread(let t): t
        case .master(let block): block.master
        }
    }

    public var id: String {
        switch self {
        case .needsYou: "needs:\(thread.id)"
        case .failed: "failed:\(thread.id)"
        case .master: "master:\(thread.id)"
        case .working: "working:\(thread.id)"
        case .paused: "paused:\(thread.id)"
        case .unread: "unread:\(thread.id)"
        }
    }
}

/// One fact of the card's quiet count line.
public struct ProjectCardCount: Sendable, Hashable {
    public enum Kind: Sendable, Hashable { case dormant, archived, none }
    public var kind: Kind
    public var text: String
}

/// A project on its workspace's screen: the desktop's project card
/// (WorkspaceSessions.tsx `ProjectCardView` on sidebarRows.ts `cardLines`),
/// one for every host's copy. The needs-you and failed roots the desktop only
/// counts are lines here, at the top, and out of the count line.
public struct ProjectCard: Sendable, Hashable, Identifiable {
    public var project: HomeProject
    /// The branch line: the branch, else "local checkout".
    public var branch: String
    /// "worktree" or "local".
    public var mode: String
    /// Newest thread activity across every copy; 0 shows no time.
    public var latest: Int
    /// One page of lines.
    public var lines: [ProjectCardLine]
    /// Lines behind "N more".
    public var hidden: Int
    public var counts: [ProjectCardCount]
    /// The card's accessible name: "Alpha, 1 needs you, 2 working, 3 unread".
    public var accessibilityLabel: String
    /// The thread on screen is one of its threads (or housed under one): the
    /// card reads selected beside it.
    public var holdsShown: Bool

    public var id: String { project.id }
    public var name: String { project.project.name }
}

public enum ProjectCards {
    /// Lines on a card before "N more" (`SESSION_LIST_PAGE`).
    public static let page = 32
    /// An elapsed shows from three seconds in: a turn that ends at once never flashes a clock.
    public static let showsElapsedMs = 3_000

    public nonisolated static func showsElapsed(since: Int, now: Int) -> Bool {
        now - since >= showsElapsedMs
    }

    /// The card for a project, with `shown` the thread on screen (never unread).
    public nonisolated static func card(_ project: HomeProject, shown: (environmentId: String, sessionId: String)? = nil) -> ProjectCard {
        let roots = project.members
            .flatMap { member in member.group.threads.map { (environmentId: member.environmentId, item: $0) } }
            // Newest first; a pin earns no place here.
            .sorted { ($0.item.meta.updatedAt, $0.item.meta.id, $0.environmentId) > ($1.item.meta.updatedAt, $1.item.meta.id, $1.environmentId) }
        let archived = project.members.reduce(0) { $0 + $1.group.archivedCount }

        var needs: [ProjectCardLine] = [], failed: [ProjectCardLine] = [], masters: [ProjectCardLine] = []
        var working: [ProjectCardLine] = [], paused: [ProjectCardLine] = [], unread: [ProjectCardLine] = []
        var counted = (waiting: 0, failed: 0, working: 0, paused: 0, unread: 0)
        var dormant = 0
        for root in roots {
            let meta = root.item.meta
            let thread = CardThread(environmentId: root.environmentId, meta: meta)
            let bucket = bucket(meta)
            let isUnread = bucket == nil && root.item.unseen && !holds(root.item, shown, root.environmentId)
            switch bucket {
            case .waiting?: counted.waiting += 1
            case .failed?: counted.failed += 1
            case .working?: counted.working += 1
            case .paused?: counted.paused += 1
            case nil: if isUnread { counted.unread += 1 }
            }
            if let block = masterBlock(root.item, environmentId: root.environmentId, unread: isUnread) {
                masters.append(.master(block))
                continue
            }
            switch bucket {
            case .waiting?: needs.append(.needsYou(thread))
            case .failed?: failed.append(.failed(thread))
            case .working?: working.append(.working(thread))
            case .paused?: paused.append(.paused(thread))
            case nil:
                if isUnread { unread.append(.unread(thread)) } else { dormant += 1 }
            }
        }

        let all = needs + failed + masters + working + paused + unread
        var counts: [ProjectCardCount] = []
        if roots.isEmpty, archived == 0 {
            counts.append(ProjectCardCount(kind: .none, text: "No threads"))
        } else {
            if dormant > 0 { counts.append(ProjectCardCount(kind: .dormant, text: "\(dormant) dormant")) }
            if archived > 0 { counts.append(ProjectCardCount(kind: .archived, text: "\(archived) archived")) }
        }
        let meta = project.project
        let branch = meta.branch.flatMap { $0.isEmpty ? nil : $0 } ?? "local checkout"
        return ProjectCard(
            project: project,
            branch: branch,
            mode: meta.mode == .worktree ? "worktree" : "local",
            latest: roots.map(\.item.meta.updatedAt).max() ?? 0,
            lines: Array(all.prefix(page)),
            hidden: max(0, all.count - page),
            counts: counts,
            accessibilityLabel: accessibilityLabel(meta.name, counted),
            holdsShown: roots.contains { holds($0.item, shown, $0.environmentId) }
        )
    }

    // MARK: The rules

    private enum Bucket { case waiting, failed, working, paused }

    /// projectCardModel.ts `projectCardStatus`: each root in one bucket,
    /// loudest first, else nil (unread or dormant).
    private nonisolated static func bucket(_ meta: SessionMeta) -> Bucket? {
        if meta.status == .paused || meta.treeHasPaused == true { return .paused }
        let canContinue = meta.treeCanContinue == true
        let liveWork = meta.treeHasLiveWork == true
        if meta.status != .waiting, !canContinue,
           meta.status == .running || meta.status == .starting || meta.status == .watching || liveWork { return .working }
        if !canContinue, meta.status == .waiting { return .waiting }
        if !liveWork, meta.status == .error || canContinue { return .failed }
        return nil
    }

    /// The thread on screen is the root or anything housed under it.
    private nonisolated static func holds(_ item: ThreadItem, _ shown: (environmentId: String, sessionId: String)?, _ environmentId: String) -> Bool {
        guard let shown, shown.environmentId == environmentId else { return false }
        if item.id == shown.sessionId { return true }
        return item.children.contains { holds($0, shown, environmentId) }
    }

    private nonisolated static func lineRank(_ state: CardState) -> Int {
        switch state {
        case .waiting: 0
        case .failed: 1
        case .paused: 2
        case .working, .watching: 3
        case .planReady: 4
        case .stopped: 5
        case .queued: 6
        case .done, .idle: 7
        }
    }

    /// sidebarRows.ts `masterBlock`: the block for a master row with a batch,
    /// or nil when nothing in it says anything. The master's own subagents
    /// are its `children` with a parent; the batch is the roots housed under it.
    nonisolated static func masterBlock(_ master: ThreadItem, environmentId: String, unread: Bool) -> MasterCardBlock? {
        let batch = master.children.filter { $0.meta.parentId == nil }
        guard !batch.isEmpty else { return nil }
        var lines: [BatchLine] = []
        var queued = 0, done = 0
        for item in batch {
            let thread = CardThread(environmentId: environmentId, meta: item.meta)
            if thread.state == .queued { queued += 1 }
            else if !thread.state.marksAtRest { done += 1 }
            else { lines.append(BatchLine(thread: thread, agents: AgentSummary.live(item.children))) }
        }
        lines = lines.enumerated()
            .sorted { (lineRank($0.element.thread.state), $0.offset) < (lineRank($1.element.thread.state), $1.offset) }
            .map(\.element)
        let state = CardState.row(master.meta)
        let agents = AgentSummary.live(master.children.filter { $0.meta.parentId != nil })
        if lines.isEmpty, queued == 0, !unread, agents == nil, !state.marksAtRest { return nil }
        return MasterCardBlock(
            master: CardThread(environmentId: environmentId, meta: master.meta, state: state),
            lead: lead(state, lines: lines, agents: agents),
            unread: unread,
            agents: agents,
            lines: lines,
            queued: queued,
            done: done,
            total: batch.count
        )
    }

    /// `blockLead`: a master that only watches, idles or is done while a batch
    /// line works, or while a line's or its own subagents work, leads as
    /// working; any louder or held state of its own leads as itself.
    nonisolated static func lead(_ state: CardState, lines: [BatchLine], agents: AgentSummary?) -> CardState {
        guard state == .watching || state == .idle || state == .done else { return state }
        let works = (agents?.working ?? 0) > 0 || lines.contains { $0.thread.state == .working || ($0.agents?.working ?? 0) > 0 }
        return works ? .working : state
    }

    /// `projectCardAriaLabel`: the project, then what needs saying, loudest first.
    private nonisolated static func accessibilityLabel(_ name: String, _ c: (waiting: Int, failed: Int, working: Int, paused: Int, unread: Int)) -> String {
        var parts = [name]
        if c.waiting > 0 { parts.append("\(c.waiting) \(c.waiting == 1 ? "needs" : "need") you") }
        if c.failed > 0 { parts.append("\(c.failed) failed") }
        if c.working > 0 { parts.append("\(c.working) working") }
        if c.paused > 0 { parts.append("\(c.paused) paused") }
        if c.unread > 0 { parts.append("\(c.unread) unread") }
        return parts.joined(separator: ", ")
    }
}
