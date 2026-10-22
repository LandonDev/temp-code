import Foundation
import TempCodeContract

/// A tool item's activity family: edit, read, search, command, subagent, web, or tool.
public enum ActivityKind: String, Sendable, Hashable {
    case edit, read, search, command, subagent, web, tool
}

/// The whole change a task made to one file: a single edit as-is, several
/// fused into one card whose hunks run in call order.
public struct ChangeCard: Sendable, Hashable, Identifiable {
    public var path: String
    public var adds: Int
    public var dels: Int
    /// The edits fused, in call order.
    public var edits: [ToolItem]

    public var id: String { "\(edits.first?.seq ?? 0):\(path)" }
    public var fileName: String { Board.fileName(path) }
    public var ts: Int { edits.first?.ts ?? 0 }
    public var doneTs: Int? { edits.last?.doneTs }
    public var editCount: Int { edits.count }
    /// The diff lines across the edits when every edit carries them whole;
    /// nil when any edit left its lines on the host (fetch on open).
    public var lines: [ToolPreview.Line]? {
        var all: [ToolPreview.Line] = []
        for edit in edits {
            if case .array(let lines)? = edit.preview?.lines { all += lines; continue }
            // A running edit with no preview yet: the host's live diff, as far as it got.
            if edit.preview?.lines == nil, edit.status == .running { all += Board.diffLines(edit.live?.diff ?? ""); continue }
            return nil
        }
        return all
    }
    /// Seqs of the edits whose lines stayed on the host.
    public var omittedSeqs: [Int] {
        edits.compactMap { edit in
            if case .omittedBody? = edit.preview?.lines { return edit.seq }
            return nil
        }
    }
}

/// One user request's section of the implementation board: its todo list,
/// every item that answered it, the work among them, and its header line.
public struct RoundData: Sendable, Hashable {
    public var todos: [TodoItem]
    public var items: [ThreadEntry]
    /// Edits outside `.temp-code/`, undecided cards and errors, in order.
    public var work: [ThreadEntry]
    /// The user's request that opened the round.
    public var header: ThreadEntry?
    /// Display number; a pure Q&A round earns no row and consumes none (0).
    public var passNumber: Int
    public var isCurrent: Bool
    /// The host's landing lines in this round (gate runs, review verdicts),
    /// in order; drawn after Changes. Never part of `work`.
    public var outcomes: [ThreadEntry] = []

    public var headerText: String {
        guard case .user(let turn)? = header?.item else { return "" }
        return Board.firstLine(turn.text)
    }
    public var done: Int { todos.count { $0.status == .completed } }
    public var active: Int? { todos.firstIndex { $0.status == .inProgress } }
    /// A round with nothing on the board has no row to earn.
    public var hasRow: Bool { !todos.isEmpty || !work.isEmpty }
}

/// The implementation board as one value: the desktop's ImplementationView
/// selectors (rounds, passes, closing report, goal) over a fold.
public struct ImplementationBoard: Sendable, Hashable {
    public var rounds: [RoundData]
    public var currentRound: Int
    /// The current pass's number, or the highest earned.
    public var passNumber: Int
    public var allDone: Bool
    /// The agent's final report once every todo completed, or the answer
    /// when a follow-up produced no todos.
    public var closing: TextBlock?
    /// The first user request, first line.
    public var goal: String?

    public var current: RoundData { rounds[currentRound] }
    /// Once any round produced tasks the thread is a board.
    public var hasTodos: Bool { rounds.contains { !$0.todos.isEmpty } }

    /// Every pass wears a colour, the same one in every thread: pass 1 is
    /// always green, pass 2 sky, and so on around the wheel.
    public static let passColors = ["#10b981", "#0ea5e9", "#8b5cf6", "#f59e0b", "#f43f5e", "#06b6d4", "#84cc16", "#d946ef"]

    public static func passColor(_ passNumber: Int) -> String {
        passColors[max(0, passNumber - 1) % passColors.count]
    }

    public static func build(_ fold: ThreadFold, running: Bool) -> ImplementationBoard {
        let board = fold.board
        let currentRound = board.rounds.count
        var rounds: [RoundData] = (0...currentRound).map { r in
            RoundData(todos: r < currentRound ? board.rounds[r] : board.todos, items: [], work: [], header: nil, passNumber: 0, isCurrent: r == currentRound)
        }
        for entry in fold.items {
            let r = min(max(entry.round, 0), currentRound)
            rounds[r].items.append(entry)
            if rounds[r].header == nil, case .user = entry.item { rounds[r].header = entry }
            if Board.isWork(entry.item) { rounds[r].work.append(entry) }
            if Board.isOutcome(entry.item) { rounds[r].outcomes.append(entry) }
        }
        // Passes number by what the board shows: a pure Q&A round has no
        // row and consumes no number.
        var n = 0
        for r in rounds.indices where rounds[r].hasRow {
            n += 1
            rounds[r].passNumber = n
        }
        let passNumber = rounds[currentRound].passNumber > 0 ? rounds[currentRound].passNumber : n
        let cur = rounds[currentRound]
        let allDone = !cur.todos.isEmpty && cur.todos.allSatisfy { $0.status == .completed }
        var closing: TextBlock?
        if allDone || (!running && cur.todos.isEmpty), case .assistant(let block)? = fold.items.last?.item, !block.streaming, !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            closing = block
        }
        var goal: String?
        for entry in fold.items {
            if case .user(let turn) = entry.item {
                goal = Board.firstLine(turn.text)
                break
            }
        }
        return ImplementationBoard(rounds: rounds, currentRound: currentRound, passNumber: passNumber, allDone: allDone, closing: closing, goal: goal)
    }
}

/// Pure selectors for the implementation board: which items belong to
/// which task, how long a pass really worked, and the change a task made
/// to a file as one card (the desktop's rounds.ts).
public enum Board {
    static let editTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "str_replace_editor", "str_replace_based_edit_tool", "write_file", "edit_file", "create_file", "replace_string_in_file"]
    static let readTools: Set<String> = ["read", "glob", "notebookread", "fs.read"]
    static let webTools: Set<String> = ["websearch", "web_search", "webfetch"]
    static let subagentCalls = ["spawn_agent", "wait_for_agent", "check_agent", "send_to_agent", "answer_agent", "list_agents"]

    public static func firstLine(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    }

    public static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The file an edit touched, when it names one: the host's preview
    /// first, else the edit tool's own input.
    public static func editPath(_ tool: ToolItem) -> String? {
        if let preview = tool.preview, preview.kind == .write, let path = preview.path, !path.isEmpty { return path }
        guard editTools.contains(tool.name) else { return nil }
        for key in ["file_path", "path", "filePath", "target_file"] {
            if let path = tool.input?[key]?.stringValue, !path.isEmpty { return path }
        }
        return nil
    }

    public static func editPath(_ item: TranscriptItem) -> String? {
        guard case .tool(let tool) = item else { return nil }
        return editPath(tool)
    }

    /// Bookkeeping-only edits (.temp-code/) are not work to review.
    public static func isWorkEdit(_ item: TranscriptItem) -> Bool {
        guard let path = editPath(item) else { return false }
        return !path.contains(".temp-code/")
    }

    public static func isWork(_ item: TranscriptItem) -> Bool {
        isWorkEdit(item) || item.needsUser || item.isError
    }

    /// A host's landing line: a gate run or a review verdict, carried whole
    /// on the notice. A plain notice (an account that left) is not one.
    public static func isOutcome(_ item: TranscriptItem) -> Bool {
        guard case .system(let line) = item, let notice = line.notice else { return false }
        return notice.gate != nil || notice.review != nil
    }

    /// Additions and deletions an edit reports: the host's preview, else a
    /// count of the lines the edit's own input replaces.
    public static func stat(_ tool: ToolItem) -> (adds: Int, dels: Int) {
        if tool.status == .running, let live = tool.live { return (live.adds, live.dels) }
        if let preview = tool.preview, preview.additions != nil || preview.deletions != nil {
            return (Int(preview.additions ?? 0), Int(preview.deletions ?? 0))
        }
        let lines = { (value: String?) in value.map { $0.isEmpty ? 0 : $0.split(separator: "\n", omittingEmptySubsequences: false).count } ?? 0 }
        if let content = tool.input?["content"]?.stringValue { return (lines(content), 0) }
        return (lines(tool.input?["new_string"]?.stringValue), lines(tool.input?["old_string"]?.stringValue))
    }

    public static func actKind(_ tool: ToolItem) -> ActivityKind {
        if editPath(tool) != nil { return .edit }
        let name = tool.name.lowercased()
        if readTools.contains(name) { return .read }
        if name == "grep" { return .search }
        if name == "bash" || name == "shell" { return .command }
        if subagentCalls.contains(where: { name.contains($0) }) { return .subagent }
        if webTools.contains(name) { return .web }
        switch tool.preview?.kind {
        case .read?: return .read
        case .search?: return .search
        case .shell?: return .command
        default: return .tool
        }
    }

    /// Working time across an item sequence. Tool calls count their full
    /// run (ts → doneTs); the idle gap BEFORE a user message never counts,
    /// since that is the user thinking between a halt and a resume.
    public static func activeMs(_ list: [ThreadEntry], liveNow: Int? = nil) -> Int {
        var total = 0
        var prev: Int?
        for entry in list {
            let ts = entry.ts
            var isUser = false
            var end = ts
            switch entry.item {
            case .user: isUser = true
            case .tool(let tool): end = tool.doneTs ?? ts
            default: break
            }
            if let p = prev, !isUser { total += max(0, ts - p) }
            prev = max(prev ?? end, end)
        }
        if let liveNow, let p = prev { total += max(0, liveNow - p) }
        return total
    }

    /// Items under the task in progress at their birth; -1 = before the
    /// round's first list. Indices past a shrunken list clamp to the last.
    public static func groupByTodo(_ list: [ThreadEntry], todoCount: Int) -> [Int: [ThreadEntry]] {
        var groups: [Int: [ThreadEntry]] = [:]
        for entry in list {
            let key = todoCount == 0 ? -1 : entry.todo < 0 ? -1 : min(entry.todo, todoCount - 1)
            groups[key, default: []].append(entry)
        }
        return groups
    }

    /// Additions and deletions across a set of items' edits.
    public static func changeStat(_ list: [ThreadEntry]) -> (adds: Int, dels: Int) {
        var adds = 0
        var dels = 0
        for entry in list {
            guard case .tool(let tool) = entry.item, editPath(tool) != nil else { continue }
            let s = stat(tool)
            adds += s.adds
            dels += s.dels
        }
        return (adds, dels)
    }

    /// The whole change a task made to one file.
    public static func wholeChange(path: String, edits: [ToolItem]) -> ChangeCard {
        var adds = 0
        var dels = 0
        for edit in edits {
            let s = stat(edit)
            adds += s.adds
            dels += s.dels
        }
        return ChangeCard(path: path, adds: adds, dels: dels, edits: edits)
    }

    /// Every file the items edited, one card each, in first-edit order.
    public static func changes(in list: [ThreadEntry]) -> [ChangeCard] {
        var order: [String] = []
        var byPath: [String: [ToolItem]] = [:]
        for entry in list {
            guard case .tool(let tool) = entry.item, let path = editPath(tool), !path.contains(".temp-code/") else { continue }
            if byPath[path] == nil { order.append(path) }
            byPath[path, default: []].append(tool)
        }
        return order.map { wholeChange(path: $0, edits: byPath[$0] ?? []) }
    }

    /// Unified diff text as preview lines, uncapped.
    public static func diffLines(_ diff: String) -> [ToolPreview.Line] {
        var out: [ToolPreview.Line] = []
        var newNumber = 0
        for raw in diff.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git") || line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ") { continue }
            if line.hasPrefix("@@") {
                // "@@ -a,b +c,d @@": the new file's first line of the hunk.
                if let plus = line.firstIndex(of: "+") {
                    let digits = line[line.index(after: plus)...].prefix { $0.isNumber }
                    newNumber = Int(digits) ?? newNumber
                }
                continue
            }
            if line.hasPrefix("+") {
                out.append(ToolPreview.Line(number: Double(newNumber), kind: .add, text: String(line.dropFirst())))
                newNumber += 1
            } else if line.hasPrefix("-") {
                out.append(ToolPreview.Line(number: Double(newNumber), kind: .del, text: String(line.dropFirst())))
            } else if line.hasPrefix("\\") {
                continue
            } else if !line.isEmpty || !out.isEmpty {
                out.append(ToolPreview.Line(number: Double(newNumber), kind: .context, text: line.hasPrefix(" ") ? String(line.dropFirst()) : line))
                newNumber += 1
            }
        }
        while let last = out.last, last.kind == .context, last.text.isEmpty { out.removeLast() }
        return out
    }
}
