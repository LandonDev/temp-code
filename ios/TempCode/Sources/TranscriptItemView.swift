import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every row kind the contract has, with the desktop's hierarchy: the user's
/// words set apart, the agent's answer as the page, tools as compact rows
/// that open, thinking folded, system lines quiet.
struct TranscriptItemView: View {
    let item: TranscriptItem
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        switch item {
        case .user(let turn):
            UserTurnView(turn: turn, client: client)
        case .assistant(let block):
            MarkdownText(text: block.text)
                .textSelection(.enabled)
        case .thinking(let block):
            ThinkingView(block: block)
        case .tool(let tool):
            ToolRowView(tool: tool, client: client, sessionId: sessionId)
        case .question(let question):
            QuestionView(question: question)
        case .approval(let approval):
            ApprovalView(approval: approval)
        case .compaction(let compaction):
            SystemLineView(symbol: "arrow.down.right.and.arrow.up.left", text: compactionText(compaction), tint: compaction.phase == .failed ? .red : .secondary)
        case .system(let line):
            SystemLineViewFor(line: line)
        }
    }

    private func compactionText(_ c: CompactionItem) -> String {
        switch c.phase {
        case .start: "Compacting the context…"
        case .done:
            if let pre = c.preTokens, let post = c.postTokens { "Compacted the context, \(Formatting.tokens(pre)) → \(Formatting.tokens(post))" } else { "Compacted the context" }
        case .failed: "Compaction failed" + (c.error.map { ": \($0)" } ?? "")
        case .unknown: "Compaction"
        }
    }
}

struct UserTurnView: View {
    let turn: UserTurn
    let client: EnvironmentClient

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !turn.text.isEmpty {
                Text(turn.text)
                    .textSelection(.enabled)
            }
            ForEach(Array(turn.attachments.enumerated()), id: \.offset) { _, attachment in
                AttachmentView(attachment: attachment, client: client)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct AttachmentView: View {
    let attachment: Attachment
    let client: EnvironmentClient

    var body: some View {
        if attachment.kind == .image || (attachment.mime ?? "").hasPrefix("image/") {
            MediaImage(client: client, path: attachment.path, name: attachment.name)
        } else {
            Label(attachment.name, systemImage: attachment.kind == .thread ? "text.bubble" : "doc")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

struct ThinkingView: View {
    let block: TextBlock
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(duration: 0.3, bounce: 0)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(block.streaming ? "Thinking…" : "Thought")
                        .font(.subheadline)
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                Text(block.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 14)
            }
        }
    }
}

struct ToolRowView: View {
    let tool: ToolItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var open = false
    @State private var whole: EventRow?
    @State private var loadingBody = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.spring(duration: 0.3, bounce: 0)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: symbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(title)
                        .font(.subheadline.weight(.medium))
                    if let detail = tool.detail {
                        Text(detail)
                            .font(.system(.subheadline, design: isCommand ? .monospaced : .default))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    switch tool.status {
                    case .running:
                        ProgressView()
                            .controlSize(.mini)
                    case .failed:
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    case .done:
                        EmptyView()
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if let preview = tool.preview, case .array(let lines)? = preview.lines, !lines.isEmpty {
                        DiffView(lines: lines, additions: preview.additions, deletions: preview.deletions)
                    } else if let input = inputText {
                        CodeBlock(text: input, maxLines: 12)
                    }
                    outputView
                    if let reauth = tool.reauth {
                        Text("\(reauth.app) needs to be signed in again.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(.leading, 22)
                .transition(.opacity)
            }
        }
    }

    @ViewBuilder
    private var outputView: some View {
        switch effectiveOutput {
        case .whole(let text):
            if !text.isEmpty {
                CodeBlock(text: text, maxLines: 16, tint: tool.status == .failed ? .red : nil)
            }
        case .omitted(let omitted, let seq):
            VStack(alignment: .leading, spacing: 6) {
                if !omitted.head.isEmpty {
                    CodeBlock(text: omitted.head, maxLines: 2)
                }
                Button {
                    Task { await loadBody(seq: seq) }
                } label: {
                    if loadingBody {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Show all · \(Formatting.bytes(omitted.bytes)), \(omitted.lines) lines")
                            .font(.footnote.weight(.medium))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        case .none:
            EmptyView()
        }
    }

    /// The row the host sent whole, once fetched, else what the fold has.
    private var effectiveOutput: BodyState {
        if let whole, case .toolResult(let result) = whole.event, case .string(let text) = result.output { return .whole(text) }
        return tool.output
    }

    private func loadBody(seq: Int) async {
        loadingBody = true
        defer { loadingBody = false }
        whole = await client.body(sessionId: sessionId, seq: seq)
    }

    private var title: String {
        if let display = tool.display, let app = display.app {
            return display.action.map { "\(app) · \($0)" } ?? app
        }
        return tool.name
    }

    private var isCommand: Bool {
        tool.preview?.kind == .shell || tool.name.lowercased().contains("bash") || tool.name.lowercased().contains("shell")
    }

    private var symbol: String {
        switch tool.preview?.kind {
        case .shell?: return "terminal"
        case .read?: return "doc.text"
        case .write?: return "pencil.line"
        case .search?: return "magnifyingglass"
        default: break
        }
        let name = tool.name.lowercased()
        if name.contains("bash") || name.contains("shell") { return "terminal" }
        if name.contains("read") { return "doc.text" }
        if name.contains("edit") || name.contains("write") { return "pencil.line" }
        if name.contains("grep") || name.contains("glob") || name.contains("search") { return "magnifyingglass" }
        if name.contains("web") || name.contains("fetch") { return "globe" }
        if name.contains("task") || name.contains("agent") { return "person.2" }
        return "wrench"
    }

    private var inputText: String? {
        guard let input = tool.input else { return nil }
        if case .object(let fields) = input {
            // The command or path already sits in the row; show the rest.
            var rest = fields
            for key in ["command", "file_path", "path", "pattern", "query", "url", "description"] where rest.count > 1 { rest[key] = nil }
            if rest.isEmpty { return nil }
            return Formatting.pretty(.object(rest))
        }
        return Formatting.pretty(input)
    }
}

struct QuestionView: View {
    let question: QuestionItem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(question.request.questions.enumerated()), id: \.offset) { index, q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header, !header.isEmpty {
                        Text(header.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Text(q.question)
                        .font(.subheadline.weight(.medium))
                    let chosen = Set(question.answers?[safe: index] ?? [])
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: chosen.contains(option.label) ? "checkmark.circle.fill" : "circle")
                                .font(.caption)
                                .foregroundStyle(chosen.contains(option.label) ? Color.accentColor : Color(.tertiaryLabel))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .font(.subheadline)
                                if let description = option.description, !description.isEmpty {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            if !question.resolved {
                Text("Waiting for an answer on the desktop")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct ApprovalView: View {
    let approval: ApprovalItem

    var body: some View {
        SystemLineView(symbol: symbol, text: text, tint: tint)
    }

    private var text: String {
        let what = approval.request.title ?? approval.request.toolName
        switch approval.allowed {
        case true?: return "Allowed \(what)" + (approval.auto ? " (by policy)" : "")
        case false?: return "Denied \(what)" + (approval.auto ? " (by policy)" : "")
        case nil: return "Asking to run \(what)"
        }
    }

    private var symbol: String {
        switch approval.allowed {
        case true?: "checkmark.shield"
        case false?: "xmark.shield"
        case nil: "shield"
        }
    }

    private var tint: Color {
        approval.allowed == nil ? .orange : .secondary
    }
}

struct SystemLineViewFor: View {
    let line: SystemLine

    var body: some View {
        switch line.kind {
        case .plan:
            VStack(alignment: .leading, spacing: 6) {
                Text("PLAN")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                MarkdownText(text: line.text)
            }
            .padding(14)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        case .error:
            SystemLineView(symbol: line.stopped ? "stop.circle" : "exclamationmark.triangle", text: line.stopped ? "Stopped" : line.text, tint: line.stopped ? .secondary : .red)
        case .turnPass:
            SystemLineView(symbol: "arrow.triangle.2.circlepath", text: line.text, tint: .secondary)
        case .agentSpawned:
            SystemLineView(symbol: "person.badge.plus", text: line.text, tint: .secondary)
        case .agentReport:
            SystemLineView(symbol: "person.text.rectangle", text: line.detail.map { "\(line.text) · \($0)" } ?? line.text, tint: .secondary)
        case .backgroundTask:
            SystemLineView(symbol: "clock", text: line.detail.map { "\(line.text) · \($0)" } ?? line.text, tint: .secondary)
        case .goal:
            SystemLineView(symbol: "target", text: line.detail.map { "Goal \($0): \(line.text)" } ?? line.text, tint: .secondary)
        case .status:
            SystemLineView(symbol: "info.circle", text: line.text, tint: .secondary)
        case .unknown:
            SystemLineView(symbol: "questionmark.circle", text: line.text, tint: Color(.tertiaryLabel))
        }
    }
}

struct SystemLineView: View {
    let symbol: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(.caption)
                .frame(width: 14)
            Text(text)
                .font(.footnote)
                .lineLimit(4)
        }
        .foregroundStyle(tint)
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
