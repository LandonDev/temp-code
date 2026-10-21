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
