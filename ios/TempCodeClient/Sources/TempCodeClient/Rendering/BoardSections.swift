import Foundation
import TempCodeContract

/// The progress line under the goal: how much of a pass is done and whether
/// a task is under way, as the bar draws it (done in the full tint, the
/// task under way as a lighter reach past it). Never a percentage.
public struct BoardProgress: Sendable, Hashable {
    public var done: Int
    public var total: Int
    public var running: Bool

    public init(done: Int, total: Int, running: Bool) {
        self.done = done
        self.total = total
        self.running = running
    }

    /// The done share of the bar, 0…1.
    public var fraction: Double { total == 0 ? 0 : Double(done) / Double(total) }
    /// The share including the task under way: where the lighter segment reaches.
    public var workingFraction: Double {
        total == 0 ? 0 : Double(min(total, done + (running ? 1 : 0))) / Double(total)
    }
    public var complete: Bool { total > 0 && done == total }
    /// "2 of 5".
    public var label: String { "\(done) of \(total)" }
}

/// One todo's files under Changes: the todo (−1 for work before the round's
/// first list), its title, and the cards in first-edit order.
public struct ChangeGroup: Sendable, Hashable, Identifiable {
    public var todo: Int
    public var title: String
    public var cards: [ChangeCard]

    public init(todo: Int, title: String, cards: [ChangeCard]) {
        self.todo = todo
        self.title = title
        self.cards = cards
    }

    public var id: Int { todo }
}

extension RoundData {
    public var progress: BoardProgress {
        BoardProgress(done: done, total: todos.count, running: active != nil)
    }

    /// The round's edited files grouped by the todo that made them, setup first.
    public func changeGroups() -> [ChangeGroup] {
        Board.changeGroups(work: work, todos: todos)
    }
}

extension ImplementationBoard {
    /// Pass headers earn their row only once more than one pass has one;
    /// a single pass reads from the goal line alone.
    public var showsPasses: Bool { rounds.count { $0.hasRow } > 1 }

    /// The progress line's pass: the current one, else the newest that had
    /// tasks (a follow-up that produced none keeps the last list's shape).
    public var progress: BoardProgress? {
        rounds.last { !$0.todos.isEmpty }?.progress
    }
}

extension Board {
    /// The harness's own task-list tools: mechanics, never a todo's trace.
    public static let planTools: Set<String> = ["TodoWrite", "update_plan", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]

    public static func isPlanTool(_ tool: ToolItem) -> Bool { planTools.contains(tool.name) }

    /// What a todo's trace shows: the tool calls that landed while it was in
    /// progress other than edits (those sit in Changes) and the plan tools
    /// (mechanics), the agent's quiet notes, and errors.
    public static func traceItems(_ list: [ThreadEntry]) -> [ThreadEntry] {
        list.filter { entry in
            switch entry.item {
            case .tool(let tool): editPath(tool) == nil && !isPlanTool(tool)
            case .assistant(let block): !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .system(let line): line.kind == .error
            default: false
            }
        }
    }

    /// Edited files grouped by the todo in progress when each edit landed,
    /// in todo order with setup (−1) first; a todo with no edits has no group.
    public static func changeGroups(work: [ThreadEntry], todos: [TodoItem]) -> [ChangeGroup] {
        let byTodo = groupByTodo(work, todoCount: todos.count)
        return byTodo.keys.sorted().compactMap { key in
            let cards = changes(in: byTodo[key] ?? [])
            guard !cards.isEmpty else { return nil }
            let title = key < 0 ? "Setup" : todos[key].content
            return ChangeGroup(todo: key, title: title, cards: cards)
        }
    }
}

/// The gate row's one line: the desktop's `gateLine` (src/shared/gate.ts).
/// "Typecheck passed on feature", "Typecheck failed on feature · 3 errors",
/// "Gate failed on master · at vitest", "Release failed on master".
public enum GateLine {
    public static func text(_ gate: NoticeEvent.Gate) -> String {
        let label = label(gate.step)
        if gate.ok { return "\(label) passed on \(gate.branch)" }
        switch gate.step {
        case .typecheck:
            let errors = errorCount(gate.log)
            return errors > 0 ? "\(label) failed on \(gate.branch) · \(errors) \(errors == 1 ? "error" : "errors")" : "\(label) failed on \(gate.branch)"
        case .gate:
            if let step = failedStep(gate.log) { return "\(label) failed on \(gate.branch) · at \(step)" }
            return "\(label) failed on \(gate.branch)"
        case .release, .unknown:
            return "\(label) failed on \(gate.branch)"
        }
    }

    /// tsc's error count: its "Found N errors" line, else the `error TS` lines; 0 when neither appears.
    public static func errorCount(_ log: String) -> Int {
        if let match = log.firstMatch(of: /Found (\d+) errors?/), let n = Int(match.1) { return n }
        return log.matches(of: /error TS\d+/).count
    }

    /// The failed gate step named in its own log (`✗ vitest 12s failed`), the last one.
    public static func failedStep(_ log: String) -> String? {
        for line in log.split(separator: "\n").reversed() {
            if let match = line.firstMatch(of: /✗ (\S+)/) { return String(match.1) }
        }
        return nil
    }

    /// The last `lines` non-empty lines of a log.
    public static func tail(_ log: String, lines: Int = 20) -> String {
        log.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .suffix(lines)
            .joined(separator: "\n")
    }

    static func label(_ step: NoticeEvent.Gate.Step) -> String {
        switch step {
        case .typecheck: "Typecheck"
        case .gate: "Gate"
        case .release: "Release"
        case .unknown(let value): value.prefix(1).uppercased() + value.dropFirst()
        }
    }
}

/// The review row's two lines: the desktop ReviewCard's lead and summary.
/// The model's label is formatted by the caller (`ModelName.short` lives in
/// the app target); the package only puts the words around it.
public enum ReviewLine {
    /// "Reviewed by GPT-6.1 Sol", "Review by GPT-6.1 Sol timed out", "Review
    /// by … did not run", "Merged anyway", "Merged"; an unknown outcome reads "Review".
    public static func lead(_ review: NoticeEvent.Review, label: String) -> String {
        switch review.outcome {
        case .pass, .held: "Reviewed by \(label)"
        case .timeout: "Review by \(label) timed out"
        case .failed: "Review by \(label) did not run"
        case .mergedAnyway: "Merged anyway"
        case .skipped: "Merged"
        case .unknown: "Review"
        }
    }

    /// "no blocking findings, 2 minor"; "2 blocking findings, 1 minor, merge
    /// held" (or "merged anyway" once overridden); "after 2.4 min, merged
    /// without it"; "<reason>, merged without it"; "1 blocking finding
    /// overridden"; a skipped review's reason; an unknown outcome's raw value.
    public static func summary(_ review: NoticeEvent.Review) -> String {
        let blocking = review.blocking.count
        let minor = review.minor.count
        let minorText = minor > 0 ? "\(minor) minor" : nil
        let blockingText = "\(blocking) blocking \(blocking == 1 ? "finding" : "findings")"
        switch review.outcome {
        case .pass:
            return ["no blocking findings", minorText].compactMap { $0 }.joined(separator: ", ")
        case .held:
            return [blockingText, minorText, review.merged ? "merged anyway" : "merge held"].compactMap { $0 }.joined(separator: ", ")
        case .timeout:
            let minutes = review.minutes.map { $0.formatted(.number.precision(.fractionLength(0...1))) } ?? "?"
            return "after \(minutes) min, merged without it"
        case .failed:
            return [review.reason, "merged without it"].compactMap { $0 }.joined(separator: ", ")
        case .mergedAnyway:
            return "\(blockingText) overridden"
        case .skipped:
            return review.reason ?? ""
        case .unknown(let value):
            return value
        }
    }

    /// The merge is held on this verdict: blocking findings, not yet overridden.
    public static func isHeld(_ review: NoticeEvent.Review) -> Bool {
        review.outcome == .held && !review.merged
    }
}
