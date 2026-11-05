import Foundation

/// The words, mark, counts and destination that a tool row draws.
public struct ActionRow: Hashable, Sendable {
    public enum Glyph: Hashable, Sendable { case kind(ToolPhrase.Kind), delete, app }
    public enum Opens: Hashable, Sendable { case diff, command, details, file, none }
    public var glyph: Glyph
    public var verb: String
    public var object: String
    public var isFile: Bool
    public var path: String?
    public var tally: String?
    public var adds: Int?
    public var dels: Int?
    public var opens: Opens
    public var connector: String?
    public var agent: Bool
    public var failed: Bool
    public var running: Bool
    public var pending: Bool

    public static func of(_ tool: ToolItem, cwd: String? = nil, live: Bool? = nil) -> ActionRow {
        var row = rowAction(tool, cwd: cwd, live: live)
        if !row.agent, ["a command", "a file", "the project", "a page", "the web", "a question"].contains(row.object) {
            row.verb = [row.verb, row.object].filter { !$0.isEmpty }.joined(separator: " ")
            row.object = ""
            row.isFile = false
        }
        return row
    }

    private static func rowAction(_ tool: ToolItem, cwd: String?, live: Bool?) -> ActionRow {
        let kind = ToolPhrase.kind(of: tool)
        let parts = ToolPhrase.of(tool, live: live, cwd: cwd)
        let server = mcpServerOf(tool.name)
        let connector = ToolPhrase.firstText(tool.display?.app, server == "app" ? nil : server)
        let short = ToolPhrase.shortName(tool.name)
        let agent = ["spawn_agent", "send_to_agent", "check_agent", "wait_for_agent", "interrupt_agent", "answer_agent", "Agent", "Task"].contains(short)
        // ToolItem has no approval stamp; the fold stores it in a separate ApprovalItem.
        var row = ActionRow(glyph: .kind(kind), verb: parts.verb, object: parts.target ?? "", isFile: parts.isFile, opens: .details, connector: connector.isEmpty ? nil : connector, agent: agent, failed: tool.status == .failed, running: tool.status == .running, pending: false)
        if let app = tool.display?.app, !app.isEmpty {
            row.verb = addonTitle(app)
            row.object = tool.display?.action ?? ""
            row.isFile = false
            return row
        }
        // The phone has no appView value yet; thread links and app row overrides belong there.
        if !connector.isEmpty, let server, server != "orchestrator", !agent {
            row.verb = addonTitle(connector)
            row.object = ToolPhrase.sentenceName(tool.name)
            row.isFile = false
            return row
        }
        if GroupPhrase.isEdit(tool) {
            let files = GroupPhrase.editFiles(tool)
            let path = Board.editPath(tool) ?? files.first?.path ?? ToolPhrase.pathOf(tool)
            let change = Board.wholeChange(path: path, edits: [tool])
            let removed = files.first?.verb == "delete"
            row.glyph = removed ? .delete : .kind(files.first?.verb == "create" && parts.verb.hasPrefix("Creat") ? .write : kind == .patch ? .patch : .edit)
            row.path = path.isEmpty ? nil : path
            row.adds = change.adds
            row.dels = change.dels
            row.opens = .diff
            return row
        }
        if kind == .run { row.opens = .command; return row }
        if kind == .todo {
            // Count every wire item, including a streamed item whose text is not here yet.
            let input = ToolPhrase.input(tool)
            let raw = input["todos"] == .null ? input["plan"] : input["todos"] ?? input["plan"]
            let items = raw?.arrayValue ?? []
            if !items.isEmpty {
                row.object = ""
                row.tally = "\(items.count { $0["status"]?.stringValue == "completed" })/\(items.count)"
            }
            return row
        }
        if kind == .read || kind == .list {
            let input = ToolPhrase.input(tool)
            let path = ToolPhrase.firstText(input["file_path"]?.stringValue, input["path"]?.stringValue, tool.preview?.path)
            row.path = path.isEmpty ? nil : path
            if !path.isEmpty, !row.failed, !row.pending { row.opens = .file }
        }
        return row
    }

    private static func mcpServerOf(_ name: String) -> String? {
        guard name.hasPrefix("mcp__") else { return nil }
        let rest = String(name.dropFirst(5))
        guard let cut = rest.range(of: "__", options: .backwards), cut.lowerBound > rest.startIndex else { return nil }
        return String(rest[..<cut.lowerBound])
    }

    private static func addonTitle(_ name: String) -> String {
        let proper = ["github": "GitHub", "google-drive": "Google Drive", "googledrive": "Google Drive", "heroui": "HeroUI", "reui": "ReUI", "node_repl": "Node REPL", "openaideveloperdocs": "OpenAI Docs", "pdf": "PDF", "computer-use": "Computer Use"]
        return proper[name.lowercased()] ?? name.components(separatedBy: CharacterSet(charactersIn: "-_")).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
