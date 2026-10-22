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
        // Slot (e): thread 16 makes this [.board, .chat]; the screen routes .board for .master to MasterView.
        case .master: [.chat]
        case .subagent, .chat, .other: [.chat]
        }
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

    public init(session: SessionMeta?, thread: ThreadState, document: String?) {
        kind = ThreadKind(session)
        status = session?.status
        running = status == .running || status == .starting
        let board = thread.fold.board
        hasAgents = !board.agents.isEmpty
        hasBoard = !board.todos.isEmpty || board.rounds.contains { !$0.isEmpty } || hasAgents
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        planHasContent = !text.isEmpty
        reportComplete = !text.isEmpty && PlanDoc.report(document ?? "").isComplete
        hasSources = !board.sources.isEmpty || hasAgents || planHasContent
        undecidedSeq = thread.fold.items.last { $0.item.needsUser }?.seq
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
    /// has not looked at; nil when a board is present (its cards are inline).
    /// `seen` is the last seq the user saw on each segment.
    public static func dot(in segments: [ThreadSegment], phase: ThreadPhase, shown: ThreadSegment, seen: [ThreadSegment: Int]) -> ThreadSegment? {
        guard let card = phase.undecidedSeq, !segments.contains(.board) else { return nil }
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

    public enum Part: Equatable, Sendable {
        /// Slot (a): thread 22 renders this as its host chip and dot.
        case host(String)
        /// "Master", tertiary.
        case master
        /// The type label, tinted, medium weight.
        case type(ThreadType)
        /// A subagent's role.
        case agent(AgentType)
        /// `ModelName.short` of the id.
        case model(String)
        // Slot (b): thread 24 adds `case account(String)` here, rendered after .model.
        /// Ticks; only while live.
        case elapsed(since: Int)
        /// Paused: the frozen elapsed, in ms.
        case frozen(ms: Int)
        /// "Queued · waiting for X", "Stopped · the harness is gone".
        case words(String)
    }

    public let mark: Mark
    public let parts: [Part]
    /// The line ticks (running, starting, watching).
    public let live: Bool

    public static let stoppedWords = "Stopped · the harness is gone"
    public static let queuedWords = "Queued"

    public init(session: SessionMeta, hostName: String?) {
        var parts: [Part] = []
        if let hostName { parts.append(.host(hostName)) }
        let root = session.parentId == nil
        if root, session.isMaster == true { parts.append(.master) }
        let identity: [Part] = root ? [.type(session.threadType ?? .chat), .model(session.model)] : [.agent(session.agentType), .model(session.model)]
        let since = session.busySince ?? session.updatedAt
        var live = false
        let mark: Mark
        switch session.status {
        case .running, .starting:
            mark = .spinner
            parts += identity + [.elapsed(since: since)]
            live = true
        case .watching:
            mark = .dot(.info)
            parts += identity + [.elapsed(since: since)]
            live = true
        case .waiting:
            mark = .dot(.warning)
            parts += identity
        case .error:
            mark = .dot(.destructive)
            parts += identity
        case .paused:
            mark = .paused
            parts += identity
            if let frozen = session.frozenActiveElapsed { parts.append(.frozen(ms: frozen)) }
        case .queued:
            mark = .dot(.tertiary)
            let activity = session.activity ?? ""
            parts.append(.words(activity.hasPrefix(Self.queuedWords) ? activity : Self.queuedWords))
        case .stopped:
            mark = .stopped
            parts.append(.words(Self.stoppedWords))
        case .idle, .done, .unknown:
            // A settled root whose subagents still work shows the spinner, with no elapsed: the time is the child's.
            mark = session.treeHasLiveWork == true ? .spinner : .empty
            parts += identity
        }
        self.mark = mark
        self.parts = parts
        self.live = live
    }

    /// The parts with the host dropped, for `ViewThatFits`.
    public var withoutHost: [Part] {
        parts.filter { if case .host = $0 { false } else { true } }
    }

    /// The shortest form: the words alone ("Queued", "Stopped") or type · model.
    public var compact: [Part] {
        if case .words(let words)? = parts.last {
            return [.words(words == Self.stoppedWords ? "Stopped" : words.hasPrefix(Self.queuedWords) ? Self.queuedWords : words)]
        }
        return withoutHost.filter {
            switch $0 {
            case .type, .agent, .model: true
            default: false
            }
        }
    }
}
