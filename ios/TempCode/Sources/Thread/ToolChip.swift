import SwiftUI
import TempCodeClient
import TempCodeContract

/// One line, the desktop's tool row: a glyph for the kind, the verb in the
/// dim step, the target loud (a file in mono), the duration right in
/// tabular digits, a chevron that turns when the row is open. Running shows
/// a spinner where the duration will be; failed tints the glyph destructive.
/// Tap opens it in place: the chip's line becomes an 8 pt control inside a
/// 12 pt block (concentric: 8 + 4 of padding) and the body, the input then
/// the output in mono, lands under a hairline. The block grows with the
/// expand spring; the body fades in 150 ms after the height starts. An
/// omitted body is fetched on open behind a shimmer of its final height.
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
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                line
            }
            .buttonStyle(.pressable)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                Hairline()
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                ToolBody(tool: tool, whole: whole, loading: loading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
        .padding(open ? 4 : 0)
        .background(TranscriptStyle.wash.opacity(open ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(TranscriptStyle.edge.opacity(open ? 1 : 0), lineWidth: 1 / scale))
        .task(id: open) {
            guard open, whole == nil, case .omitted(_, let seq) = tool.output else { return }
            loading = true
            whole = await client.body(sessionId: sessionId, seq: seq)
            loading = false
        }
    }

    private var line: some View {
        let phrase = tool.phrase
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tool.status == .failed ? "xmark" : tool.chipGlyph)
                .font(.footnote.weight(tool.status == .failed ? .semibold : .regular))
                .foregroundStyle(tool.status == .failed ? Tint.destructive : Color(.secondaryLabel))
                .frame(width: 18)
                .accessibilityHidden(true)
            // The verb sits in the dim step and the target reads loud, as on the desktop.
            Text(phrase.verb)
                .font(.subheadline)
                .foregroundStyle(tool.status == .failed ? Tint.destructive : Color(.secondaryLabel))
                .lineLimit(1)
                .layoutPriority(phrase.target == nil ? 1 : 0)
            if let target = phrase.target {
                Text(target)
                    .font(phrase.isFile ? .system(.footnote, design: .monospaced) : .subheadline)
                    .foregroundStyle(tool.status == .failed ? Tint.destructive : .primary)
                    .lineLimit(1)
                    .truncationMode(phrase.isFile ? .middle : .tail)
                    .layoutPriority(1)
            }
            Spacer(minLength: 8)
            switch tool.status {
            case .running:
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            case .done, .failed:
                if let ms = tool.elapsedMs(), ms >= 50 {
                    Text(ToolTime.duration(ms: ms))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(open ? 90 : 0))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 36)
        .background(TranscriptStyle.control.opacity(open ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .animation(Motion.crossFade, value: tool.status)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(phrase.line)
    }
}

/// The chip's body, the desktop's `ToolDetails`: the rest of the input,
/// then the output, both in mono; the output destructive when the call
/// failed; "… N more lines" past the fold; a reconnect line when a
/// connector's grant lapsed.
private struct ToolBody: View {
    let tool: ToolItem
    let whole: EventRow?
    let loading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let input = inputText {
                MonoText(text: input, tint: Color(.secondaryLabel), maxLines: 12)
            }
            switch output {
            case .whole(let text):
                if !text.isEmpty {
                    if inputText != nil { Hairline() }
                    MonoText(text: text, tint: tool.status == .failed ? Tint.destructive : .primary, maxLines: 24)
                } else if inputText == nil, tool.status != .running {
                    Text("No output")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            case .omitted(let omitted, _):
                if loading || whole == nil {
                    if inputText != nil { Hairline() }
                    Shimmer(height: CGFloat(min(omitted.lines, 24)) * 18 + 4)
                }
            case .none:
                if inputText == nil, tool.status != .running {
                    Text("No output")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
            if let reauth = tool.reauth {
                Label("Reconnect \(reauth.app)", systemImage: "arrow.clockwise")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Tint.warning)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The row the host sent whole, once fetched, else what the fold has.
    private var output: BodyState {
        if let whole, case .toolResult(let result) = whole.event, case .string(let text) = result.output { return .whole(text) }
        return tool.output
    }

    /// What was asked, pretty: the command bare, a path, else the input's
    /// fields as key and value lines; never raw JSON.
    private var inputText: String? {
        guard let input = tool.input else { return nil }
        guard case .object(let fields) = input else { return input.stringValue ?? Formatting.pretty(input) }
        if let command = fields["command"]?.stringValue { return ToolPhrase.bareCommand(command) }
        var lines: [String] = []
        for key in fields.keys.sorted() where key != "description" {
            guard let value = fields[key] else { continue }
            let text: String
            switch value {
            case .string(let s): text = s
            case .number(let n): text = value.intValue.map(String.init) ?? String(n)
            case .bool(let b): text = b ? "true" : "false"
            case .null: continue
            default: text = Formatting.pretty(value)
            }
            lines.append("\(key)  \(ToolPhrase.trim(text.replacingOccurrences(of: "\n", with: "⏎ "), 300))")
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }
}

/// Mono text in a body: wrapped (a body reads, a code block scrolls), with
/// a count of the lines past the fold in the dim step.
private struct MonoText: View {
    let text: String
    let tint: Color
    let maxLines: Int
    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let more = lines.count - maxLines
        VStack(alignment: .leading, spacing: 6) {
            Text((expanded ? lines : Array(lines.prefix(maxLines))).joined(separator: "\n"))
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(tint)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if more > 0 {
                Button {
                    withAnimation(expanded ? Motion.collapse : Motion.expand) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "… \(more) more \(more == 1 ? "line" : "lines")")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .frame(minHeight: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
            }
        }
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
    }
}

/// A quiet placeholder of the body's final height while it is fetched.
struct Shimmer: View {
    let height: CGFloat
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
            .fill(TranscriptStyle.control)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay {
                if !reduceMotion {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Surface.background.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
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

    /// The desktop's activity icons (`ActivityPhaseIcon`, lucide) in SF Symbols.
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

    /// The verb: what the tool did, in a word (the board's rows).
    var chipVerb: String { phrase.verb }

    /// The target: a file, a pattern, a query (the board's rows).
    var chipTarget: String? { phrase.target }
}
