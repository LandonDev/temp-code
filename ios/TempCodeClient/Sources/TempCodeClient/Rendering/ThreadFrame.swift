import CoreGraphics
import Foundation
import TempCodeContract

// The thread screen's frame as pure values: what kind of thread it is, which
// segments that kind has, which one shows and when the inactive one carries
// a dot, where the segmented control's pill sits at a pager offset, and the
// one line under the title. No SwiftUI here; the views in the app target's
// Sources/Thread/Frame/ draw these.

/// What the thread screen is framing: the type, or the two roles that win over it.
public enum ThreadKind: Hashable, Sendable {
    /// `parentId != nil`: the transcript alone, the agent role in the subtitle.
    case subagent
    /// `isMaster == true` on a root. Slot (e): the master view (thread 16).
    case master
    case chat, planning, projectPlan, implementation, orchestration, research
    /// `ThreadType.unknown(raw)`: the transcript alone.
    case other(String)

    /// nil → `.chat`; a subagent wins, then a master, then the thread's type.
    public init(_ session: SessionMeta?) {
        guard let session else {
            self = .chat
            return
        }
        if session.parentId != nil {
            self = .subagent
        } else if session.isMaster == true {
            self = .master
        } else {
            switch session.threadType {
            case .chat?, nil: self = .chat
            case .planning?: self = .planning
            case .projectPlan?: self = .projectPlan
            case .implementation?: self = .implementation
            case .orchestration?: self = .orchestration
            case .research?: self = .research
            case .unknown(let raw)?: self = .other(raw)
            }
        }
    }
}

public enum ThreadSegment: String, CaseIterable, Identifiable, Sendable {
    case board, chat, plan, fleet, log, sources

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .board: "Board"
        case .chat: "Chat"
        case .plan: "Plan"
        case .fleet: "Fleet"
        case .log: "Log"
        case .sources: "Sources"
        }
    }

    /// The segments a kind has, in order. The hero is first; a chat, a
    /// subagent and an unknown type have the transcript alone.
    public static func segments(for kind: ThreadKind) -> [ThreadSegment] {
        switch kind {
        case .implementation: [.board, .chat]
        case .planning, .projectPlan: [.plan, .chat]
        case .orchestration: [.fleet, .log]
        case .research: [.sources, .chat]
        // Slot (e), thread 16: the batch's board is the hero; the screen routes .board for .master to MasterView.
        case .master: [.board, .chat]
        case .subagent, .chat, .other: [.chat]
        }
    }
}

/// What the thread's frame reads of the thread itself: whether it has a
/// board, agents or sources, the newest row that waits on the person, and
/// the todo labels the two-pane fit measures. The thread's model keeps one
/// (`ThreadModel.frame`) and assigns it only when it changes, so the thread
/// screen runs again when one of these moves and not at every row.
public struct FrameFacts: Sendable, Equatable {
    public var hasAgents = false
    public var hasBoard = false
    /// The board holds a source.
    public var hasSources = false
    /// The newest undecided approval or question.
    public var undecidedSeq: Int?
    public var todoLabels: [String] = []

    public init() {}

    /// From a fold whose newest undecided row is already known (`UndecidedTracker`).
    public init(_ fold: ThreadFold, undecidedSeq: Int?) {
        let board = fold.board
        hasAgents = !board.agents.isEmpty
        hasBoard = !board.todos.isEmpty || board.rounds.contains { !$0.isEmpty } || hasAgents
        hasSources = !board.sources.isEmpty
        self.undecidedSeq = undecidedSeq
        todoLabels = board.todos.map(\.content)
    }

    /// From the whole thread: its items are walked for the undecided row.
    public init(_ thread: ThreadState) {
        self.init(thread.fold, undecidedSeq: thread.fold.items.last { $0.item.needsUser }?.seq)
    }
}

/// The newest item that waits on the person, kept from write to write. A
/// long thread asked this of every item at every push; here only the items
/// written since the last ask are read again (`FoldChanges`), and a fold
/// made whole is read whole once.
public struct UndecidedTracker: Sendable {
    private var epoch = -1
    private var generation = -1
    private var index: Int?

    public init() {}

    public mutating func seq(in fold: ThreadFold) -> Int? {
        let changes = fold.changes
        let items = fold.items
        if epoch != changes.epoch {
            index = items.lastIndex { $0.item.needsUser }
        } else if generation != changes.generation {
            // Everything before the lowest item written is as it was.
            let from = min(max(0, changes.dirtyFrom(since: generation) ?? 0), items.count)
            if let found = items[from...].lastIndex(where: { $0.item.needsUser }) {
                index = found
            } else if let kept = index, kept < from {
                index = kept
            } else if index != nil {
                // The newest undecided row was written and decided: an older one may wait still.
                index = items[..<from].lastIndex { $0.item.needsUser }
            }
        }
        epoch = changes.epoch
        generation = changes.generation
        return index.flatMap { $0 < items.count ? items[$0].seq : nil }
    }
}

/// What the thread is up to, as the segment rules read it.
public struct ThreadPhase: Equatable, Sendable {
    public let kind: ThreadKind
    public let status: SessionStatus?
    /// running || starting
    public let running: Bool
    public let hasBoard: Bool
    public let hasAgents: Bool
    public let planHasContent: Bool
    public let reportComplete: Bool
    /// Research activity has landed: a boarded source, a spawned angle or report text.
    public let hasSources: Bool
    /// The newest undecided approval or question.
    public let undecidedSeq: Int?

    /// From the whole thread, read once (`FrameFacts.init(_:)` walks its items).
    public init(session: SessionMeta?, thread: ThreadState, document: String?) {
        self.init(session: session, facts: FrameFacts(thread), document: document)
    }

    /// From what the thread's model keeps of it (`ThreadModel.frame`): no row is read.
    public init(session: SessionMeta?, facts: FrameFacts, document: String?) {
        kind = ThreadKind(session)
        status = session?.status
        running = status == .running || status == .starting
        hasAgents = facts.hasAgents
        hasBoard = facts.hasBoard
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        planHasContent = !text.isEmpty
        reportComplete = !text.isEmpty && PlanDoc.report(document ?? "").isComplete
        hasSources = facts.hasSources || hasAgents || planHasContent
        undecidedSeq = facts.undecidedSeq
    }

    /// A planning thread stopped on a question shows the question.
    public var questionForcesChat: Bool { kind == .planning && status == .waiting && undecidedSeq != nil }

    /// The segment the desktop makes the hero, by kind and phase.
    public func defaultSegment(in segments: [ThreadSegment]) -> ThreadSegment {
        switch kind {
        case .implementation: hasBoard ? .board : .chat
        case .planning, .projectPlan: planHasContent ? .plan : .chat
        case .orchestration: hasAgents ? .fleet : .log
        case .research: hasSources ? .sources : .chat
        case .master, .subagent, .chat, .other: segments.first ?? .chat
        }
    }
}

public enum SegmentRules {
    /// The segment to show: a forced chat, else the remembered choice when
    /// the kind has it, else the default.
    public static func segment(chosen: ThreadSegment?, in segments: [ThreadSegment], phase: ThreadPhase) -> ThreadSegment {
        if phase.questionForcesChat, segments.contains(.chat) { return .chat }
        if let chosen, segments.contains(chosen) { return chosen }
        return phase.defaultSegment(in: segments)
    }

    /// The inactive transcript segment holding an undecided card the user
    /// has not looked at; nil when a board is present (its cards are inline),
    /// and nil in two-pane (both segments are on screen, so nothing is
    /// inactive). `seen` is the last seq the user saw on each segment.
    public static func dot(in segments: [ThreadSegment], phase: ThreadPhase, shown: ThreadSegment, seen: [ThreadSegment: Int], mode: ThreadLayoutMode = .pager) -> ThreadSegment? {
        guard mode != .twoPane, let card = phase.undecidedSeq, !segments.contains(.board) else { return nil }
        let home: ThreadSegment = segments.contains(.log) ? .log : .chat
        guard segments.contains(home), shown != home else { return nil }
        return card > (seen[home] ?? 0) ? home : nil
    }

    /// How much of the pill sits under segment `index` at pager offset
    /// `progress` (in pages), 0...1; the offset is clamped to the ends.
    public static func weight(of index: Int, progress: CGFloat, count: Int) -> CGFloat {
        let position = clamp(progress, count: count)
        return max(0, 1 - abs(position - CGFloat(index)))
    }

    /// The pill's rect at `progress` inside a bar of `size` with `inset` on every side.
    public static func pillRect(progress: CGFloat, count: Int, size: CGSize, inset: CGFloat) -> CGRect {
        let width = (size.width - 2 * inset) / CGFloat(max(1, count))
        return CGRect(x: inset + clamp(progress, count: count) * width, y: inset, width: width, height: size.height - 2 * inset)
    }

    /// Whether the agents button shows: children exist and no segment is
    /// `.fleet` (an orchestration root's Fleet segment is the list already).
    public static func showsAgents(children: Int, segments: [ThreadSegment]) -> Bool {
        children > 0 && !segments.contains(.fleet)
    }

    private static func clamp(_ progress: CGFloat, count: Int) -> CGFloat {
        min(max(progress, 0), CGFloat(max(1, count) - 1))
    }
}

/// The one line under the title, as data: the mark and the words, in order.
public struct ThreadHeaderLine: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case info, warning, destructive, tertiary }

    public enum Mark: Equatable, Sendable {
        case empty, spinner, dot(Tone), paused, stopped
    }

    /// The line names the thread, never its model or its time: the
    /// composer's row says the model and the slot above it the one clock.
    public enum Part: Equatable, Sendable {
        /// Slot (a): thread 22 renders this as its host chip and dot.
        case host(String)
        /// "Master", tertiary.
        case master
        /// The type label, tinted, medium weight.
        case type(ThreadType)
        /// A subagent's role.
        case agent(AgentType)
        /// The account the thread spends from (`session.account`), nil for Auto; only for a provider the gateway routes (thread 24's chip).
        case account(String?)
        /// A state's word ("Queued", "Stopped"), and its reason drawn as a
        /// quieter text beside it ("Waiting for X", "The harness is gone").
        case words(String, detail: String? = nil)
    }

    public let mark: Mark
    public let parts: [Part]

    public init(session: SessionMeta, hostName: String?) {
        var parts: [Part] = []
        if let hostName { parts.append(.host(hostName)) }
        let root = session.parentId == nil
        if root, session.isMaster == true { parts.append(.master) }
        var identity: [Part] = root ? [.type(session.threadType ?? .chat)] : [.agent(session.agentType)]
        if RoutedProvider.routes(session.provider) { identity.append(.account(session.account)) }
        let mark: Mark
        switch session.status {
        case .running, .starting:
            // The turn's phase (the CLI starting, the provider slow or
            // refusing) is the transcript's working line, never the header's.
            mark = .spinner
            parts += identity
        case .watching:
            mark = .dot(.info)
            parts += identity
        case .waiting:
            mark = .dot(.warning)
            parts += identity
        case .error:
            mark = .dot(.destructive)
            parts += identity
        case .paused:
            mark = .paused
            parts += identity
        case .queued:
            mark = .dot(.tertiary)
            let queued = StatusWords.queuedLine(session)
            parts.append(.words(queued.title, detail: queued.detail))
        case .stopped:
            mark = .stopped
            parts.append(.words(StripWords.stopped.title, detail: StripWords.stopped.detail))
        case .idle, .done, .unknown:
            // A settled root whose subagents still work shows the spinner.
            mark = session.treeHasLiveWork == true ? .spinner : .empty
            parts += identity
        }
        self.mark = mark
        self.parts = parts
    }

    /// The line under the title, or nil inside a project's shell: there the
    /// bar names the project, the strip's chip says the state, the composer's
    /// row the model and the slot the time, so the line would say it twice.
    /// A subagent's screen and a bare chat keep it.
    public static func subtitle(session: SessionMeta, hostName: String?, inShell: Bool) -> ThreadHeaderLine? {
        inShell ? nil : ThreadHeaderLine(session: session, hostName: hostName)
    }

    /// The parts with the host dropped, for `ViewThatFits`.
    public var withoutHost: [Part] {
        parts.filter { if case .host = $0 { false } else { true } }
    }

    /// Compact height (folded landscape): a 32 pt bar has no room for a line
    /// under the title, so the header draws the mark leading the title on one
    /// line and no words. The mark says the state; the type and the account
    /// are in the row the person came from, the model in the composer's row,
    /// and the slot shows the elapsed.
    public var compactHeight: [Part] { [] }

    /// The shortest form: the words alone ("Queued", "Stopped") or the type.
    public var compact: [Part] {
        if case .words(let words, _)? = parts.last {
            return [.words(words)]
        }
        return withoutHost.filter {
            switch $0 {
            case .type, .agent: true
            default: false
            }
        }
    }
}

/// The thread's ellipsis menu, in order. Inside a project's shell the
/// account chip has no subtitle to sit in, so it moves here as "Account…",
/// after Rename, opening the same sheet; a subagent's menu has the block
/// line and Rename only.
public enum ThreadMenuItem: Sendable, Hashable {
    case rename, account, pin, master, fleet, resources, archive

    /// `routed`: the thread spends from an account (`AccountScope.of` is not nil).
    public static func items(root: Bool, inShell: Bool, routed: Bool) -> [ThreadMenuItem] {
        var items: [ThreadMenuItem] = [.rename]
        if inShell, routed { items.append(.account) }
        if root { items += [.pin, .master, .fleet, .resources, .archive] }
        return items
    }
}
