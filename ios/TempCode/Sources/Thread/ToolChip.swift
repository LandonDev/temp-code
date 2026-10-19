import SwiftUI
import TempCodeClient
import TempCodeContract

/// One line: glyph, verb, target in mono, duration right in tabular digits;
/// a spinner where the duration will be while running, the glyph destructive
/// when failed. Tap opens it in place: input and output in mono inside a
/// 12 pt well, concentric with the chip's 8 pt. An omitted body is fetched
/// on open behind a shimmer of its final height.
struct ToolChip: View {
    let tool: ToolItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var open: Bool
    @State private var whole: EventRow?
    @State private var loading = false
    @Environment(\.displayScale) private var scale

    init(tool: ToolItem, client: EnvironmentClient, sessionId: String) {
        self.tool = tool
        self.client = client
        self.sessionId = sessionId
        _open = State(initialValue: TestHooks.open == "chip" && tool.output.isOmitted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                line
            }
            .buttonStyle(.pressable)
            if open {
                ToolBody(tool: tool, whole: whole, loading: loading)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
        .padding(open ? 4 : 0)
        .background(open ? Surface.chrome : .clear, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .task(id: open) {
            guard open, whole == nil, case .omitted(_, let seq) = tool.output else { return }
            loading = true
            whole = await client.body(sessionId: sessionId, seq: seq)
            loading = false
        }
    }

    private var line: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // The glyph carries the verb's weight beside it.
            Image(systemName: tool.chipGlyph)
                .font(.footnote.weight(.medium))
                .foregroundStyle(tool.status == .failed ? Tint.destructive : Color(.secondaryLabel))
                .frame(width: 16)
            Text(tool.chipVerb)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            if let target = tool.chipTarget {
                Text(target)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            switch tool.status {
            case .running:
                ProgressView()
                    .controlSize(.mini)
            case .done, .failed:
                if let ms = tool.elapsedMs(), ms >= 50 {
                    Text(ToolTime.duration(ms: ms))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 32)
        .background(open ? Surface.background : .clear, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous).strokeBorder(open ? Surface.hairline : .clear, lineWidth: 1 / scale))
        .contentShape(Rectangle())
        .accessibilityLabel("\(tool.chipVerb) \(tool.chipTarget ?? "")")
    }
}

/// The chip's body: the rest of the input, then the output, both in mono.
private struct ToolBody: View {
    let tool: ToolItem
    let whole: EventRow?
    let loading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let input = inputText {
                CodeBlock(text: input, font: .footnote, maxLines: 12)
            }
            switch output {
            case .whole(let text):
                if !text.isEmpty {
                    CodeBlock(text: text, font: .footnote, maxLines: 24, tint: tool.status == .failed ? Tint.destructive : nil)
                }
            case .omitted(let omitted, _):
                if loading || whole == nil {
                    Shimmer(height: CGFloat(min(omitted.lines, 24)) * 17 + 20)
                }
            case .none:
                if inputText == nil, tool.status != .running {
                    Text("No output")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
            if let reauth = tool.reauth {
                Text("\(reauth.app) needs to be signed in again.")
                    .font(.footnote)
                    .foregroundStyle(Tint.warning)
            }
        }
    }

    /// The row the host sent whole, once fetched, else what the fold has.
    private var output: BodyState {
        if let whole, case .toolResult(let result) = whole.event, case .string(let text) = result.output { return .whole(text) }
        return tool.output
    }

    private var inputText: String? {
        guard let input = tool.input else { return nil }
        if case .object(let fields) = input {
            // The command or path already sits in the chip; show the rest.
            var rest = fields
            for key in ["command", "file_path", "path", "pattern", "query", "url", "description"] where rest.count > 1 { rest[key] = nil }
            if rest.isEmpty { return nil }
            return Formatting.pretty(.object(rest))
        }
        return Formatting.pretty(input)
    }
}

/// A quiet placeholder of the body's final height while it is fetched.
struct Shimmer: View {
    let height: CGFloat
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
            .fill(Color(.tertiarySystemFill))
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay {
                if !reduceMotion {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Color(.systemBackground).opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.6)
                            .offset(x: phase * proxy.size.width)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { phase = 1 }
            }
            .accessibilityLabel("Loading")
    }
}

extension ToolItem {
    var chipKind: ActivityKind { Board.actKind(self) }

    /// The harness's own task-list tools: mechanics, not work.
    var isPlanTool: Bool {
        ["TodoWrite", "update_plan", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].contains(name)
    }

    /// What a plan-tool call did, in one quiet line.
    var planLine: String {
        switch name {
        case "TodoWrite", "update_plan":
            if let count = BoardState.todos(from: name, input: input)?.count { return "Updated the task list · \(count) \(count == 1 ? "task" : "tasks")" }
            return "Updated the task list"
        case "TaskCreate":
            if let subject = input?["subject"]?.stringValue, !subject.isEmpty { return "New task: \(subject)" }
            return "New task"
        case "TaskUpdate":
            let id = input?["taskId"]?.stringValue ?? input?["taskId"]?.intValue.map(String.init) ?? ""
            let status = (input?["status"]?.stringValue ?? "").replacingOccurrences(of: "_", with: " ")
            return "Task \(id.isEmpty ? "" : "#\(id) ")\(status)".trimmingCharacters(in: .whitespaces)
        default:
            return "Read the task list"
        }
    }

    var chipGlyph: String {
        switch chipKind {
        case .edit: "pencil.line"
        case .read: "doc.text"
        case .search: "magnifyingglass"
        case .command: "terminal"
        case .subagent: "person.2"
        case .web: "globe"
        case .tool: display?.app != nil ? "puzzlepiece.extension" : "wrench"
        }
    }

    /// The verb: what the tool did, in a word.
    var chipVerb: String {
        if let app = display?.app { return app }
        switch chipKind {
        case .edit: return "Edit"
        case .read: return "Read"
        case .search: return "Search"
        case .command: return "Run"
        case .web: return name.lowercased().contains("search") ? "Search" : "Fetch"
        case .subagent:
            let lower = name.lowercased()
            if lower.contains("spawn") { return "Spawn" }
            if lower.contains("wait") { return "Wait" }
            if lower.contains("send") { return "Send" }
            if lower.contains("answer") { return "Answer" }
            if lower.contains("check") { return "Check" }
            return "Agents"
        case .tool: return name
        }
    }

    /// The target in mono: a file, a command, a pattern, a query.
    var chipTarget: String? {
        if display?.app != nil { return display?.action }
        guard let detail else { return nil }
        let first = Board.firstLine(detail)
        return first.isEmpty ? nil : first
    }
}
