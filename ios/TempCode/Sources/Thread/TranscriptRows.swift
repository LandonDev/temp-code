import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every row kind in its mobile form: the user's words in a bordered field,
/// the agent's answer as the page, thinking folded, tools as one-line chips,
/// edits as file rows, cards for what needs the user, quiet lines for the rest.
struct TranscriptRow: View {
    let entry: ThreadEntry
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        switch entry.item {
        case .user(let turn):
            UserTurnRow(turn: turn, client: client)
        case .assistant(let block):
            MarkdownView(seq: block.seq, text: block.text)
                .textSelection(.enabled)
        case .thinking(let block):
            ThinkingRow(block: block)
        case .tool(let tool):
            if let path = Board.editPath(tool) {
                EditRow(sessionId: sessionId, card: Board.wholeChange(path: path, edits: [tool]))
            } else if tool.isPlanTool {
                QuietLine(symbol: "checklist", text: tool.planLine)
            } else {
                ToolChip(tool: tool, client: client, sessionId: sessionId)
            }
        case .question(let question):
            QuestionCard(question: question)
        case .approval(let approval):
            ApprovalCard(approval: approval)
        case .compaction(let compaction):
            CompactionLine(compaction: compaction)
        case .system(let line):
            SystemRow(line: line, client: client)
        }
    }
}

// MARK: - user

/// A bordered field, not a bubble: hairline, 12 pt radius, 12 pt padding,
/// attachments under the text as thumbnails or a document line.
struct UserTurnRow: View {
    let turn: UserTurn
    let client: EnvironmentClient
    @Environment(\.displayScale) private var scale

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(.body)
                    .textSelection(.enabled)
            }
            ForEach(Array(turn.attachments.enumerated()), id: \.offset) { _, attachment in
                AttachmentRow(attachment: attachment, client: client)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Surface.hairline, lineWidth: 1 / scale))
    }
}

private struct AttachmentRow: View {
    let attachment: Attachment
    let client: EnvironmentClient

    var body: some View {
        if attachment.kind == .image || attachment.kind == .appshot || (attachment.mime ?? "").hasPrefix("image/") {
            MediaImage(client: client, path: attachment.path, name: attachment.name)
        } else {
            Label(attachment.name, systemImage: attachment.kind == .thread ? "text.bubble" : "doc")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

// MARK: - thinking

/// One folded line, "Thought for 2s" with the dim half, opening in place.
struct ThinkingRow: View {
    let block: TextBlock
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    if block.streaming {
                        Text("Thinking")
                            .foregroundStyle(.secondary)
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Text("Thought")
                            .foregroundStyle(.secondary)
                        if let ms = block.durationMs, ms >= 1_000 {
                            Text("for \(TimeFormat.duration(ms: ms))")
                                .foregroundStyle(.tertiary)
                                .monospacedDigit()
                        }
                    }
                }
                .font(.subheadline)
                .frame(minHeight: 28)
            }
            .buttonStyle(.pressable)
            if open {
                Text(block.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 16)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
    }
}

// MARK: - edits

/// A file name with `+n −m`; tap opens the unified diff full screen.
struct EditRow: View {
    let sessionId: String
    let card: ChangeCard

    var body: some View {
        NavigationLink(value: DiffRoute(sessionId: sessionId, card: card)) {
            HStack(spacing: 8) {
                Image(systemName: "pencil.line")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Text(card.fileName)
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if card.editCount > 1 {
                    Text("×\(card.editCount)")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                ChangeStat(adds: card.adds, dels: card.dels)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("\(card.fileName), \(card.adds) added, \(card.dels) removed")
    }
}

/// `+n` in success, `−m` in destructive, tabular.
struct ChangeStat: View {
    let adds: Int
    let dels: Int

    var body: some View {
        HStack(spacing: 6) {
            if adds > 0 {
                Text("+\(adds)")
                    .foregroundStyle(Tint.success)
            }
            if dels > 0 {
                Text("−\(dels)")
                    .foregroundStyle(Tint.destructive)
            }
        }
        .font(.footnote)
        .monospacedDigit()
        .contentTransition(.numericText())
    }
}

// MARK: - cards

/// The only raised surface in the transcript: hairline, warning tint at 8 %
/// while undecided, the one gray step once decided.
struct ThreadCard<Content: View>: View {
    let tinted: Bool
    @ViewBuilder let content: Content
    @Environment(\.displayScale) private var scale

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(tinted ? Surface.needsYou : Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Surface.hairline, lineWidth: 1 / scale))
    }
}

/// An approval with its decided state. The buttons are L5's; here they say what will be asked.
struct ApprovalCard: View {
    let approval: ApprovalItem

    var body: some View {
        ThreadCard(tinted: approval.allowed == nil) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.footnote)
                        .foregroundStyle(tint)
                    Text(heading)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(approval.allowed == nil ? .primary : .secondary)
                    Spacer(minLength: 0)
                }
                Text(approval.request.title ?? approval.request.toolName)
                    .font(.body)
                    .lineLimit(3)
                if let detail {
                    Text(detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if approval.allowed == nil {
                    HStack(spacing: 8) {
                        Button {} label: {
                            Text("Deny").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        Button {} label: {
                            Text("Allow").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .controlSize(.regular)
                    .disabled(true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var heading: String {
        switch approval.allowed {
        case nil: "Approve"
        case true?: approval.auto ? "Allowed by policy" : "Allowed"
        case false?: approval.auto ? "Denied by policy" : "Denied"
        }
    }

    private var symbol: String {
        switch approval.allowed {
        case nil: "shield"
        case true?: "checkmark.shield"
        case false?: "xmark.shield"
        }
    }

    private var tint: Color {
        switch approval.allowed {
        case nil: Tint.warning
        case true?: Tint.success
        case false?: Tint.destructive
        }
    }

    /// The command or path the tool asked for, when the request names one.
    private var detail: String? {
        guard case .object(let fields)? = approval.request.input else { return nil }
        for key in ["command", "file_path", "path", "url", "query"] {
            if case .string(let value)? = fields[key], !value.isEmpty, value != approval.request.title { return value }
        }
        return nil
    }
}

/// A question with its options; the chosen ones once answered.
struct QuestionCard: View {
    let question: QuestionItem

    var body: some View {
        ThreadCard(tinted: !question.resolved) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(question.request.questions.enumerated()), id: \.offset) { index, spec in
                    VStack(alignment: .leading, spacing: 8) {
                        if let header = spec.header, !header.isEmpty {
                            Text(header)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        Text(spec.question)
                            .font(.subheadline.weight(.medium))
                        let chosen = Set(question.answers?[safe: index] ?? [])
                        ForEach(Array(spec.options.enumerated()), id: \.offset) { _, option in
                            let picked = chosen.contains(option.label)
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                                    .font(.footnote)
                                    .foregroundStyle(picked ? Tint.success : Color(.tertiaryLabel))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label)
                                        .font(.subheadline)
                                        .foregroundStyle(question.resolved && !picked ? .secondary : .primary)
                                    if let description = option.description, !description.isEmpty {
                                        Text(description)
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
                if !question.resolved {
                    Button {} label: {
                        Text("Answer").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(true)
                }
            }
        }
    }
}

// MARK: - quiet lines

/// One quiet line: glyph and text, secondary; errors in destructive.
struct QuietLine: View {
    let symbol: String
    let text: String
    var tint: Color = Color(.secondaryLabel)

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(.caption)
                .frame(width: 16)
            Text(text)
                .font(.footnote)
                .lineLimit(4)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .accessibilityElement(children: .combine)
    }
}

struct CompactionLine: View {
    let compaction: CompactionItem

    var body: some View {
        QuietLine(symbol: "arrow.down.right.and.arrow.up.left", text: text, tint: compaction.phase == .failed ? Tint.destructive : Color(.secondaryLabel))
    }

    private var text: String {
        switch compaction.phase {
        case .start: "Compacting the context…"
        case .done:
            if let pre = compaction.preTokens, let post = compaction.postTokens { "Compacted \(Formatting.tokens(pre)) → \(Formatting.tokens(post))" } else { "Compacted the context" }
        case .failed: "Compaction failed" + (compaction.error.map { ": \($0)" } ?? "")
        case .unknown: "Compaction"
        }
    }
}

struct SystemRow: View {
    let line: SystemLine
    let client: EnvironmentClient

    var body: some View {
        switch line.kind {
        case .error:
            QuietLine(symbol: line.stopped ? "stop.circle" : "exclamationmark.triangle", text: line.stopped ? "Stopped" : line.text, tint: line.stopped ? Color(.secondaryLabel) : Tint.destructive)
        case .plan:
            VStack(alignment: .leading, spacing: 6) {
                Text("Plan")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                MarkdownView(seq: line.seq, text: line.text)
            }
            .padding(.horizontal, 8)
        case .turnPass:
            QuietLine(symbol: "arrow.triangle.2.circlepath", text: "Pass: \(line.text)")
        case .agentSpawned:
            AgentLinkRow(childId: line.detail, client: client, fallback: line.text, symbol: "person.badge.plus")
        case .agentReport:
            AgentLinkRow(childId: nil, client: client, fallback: line.detail.map { "\(line.text) · \($0)" } ?? line.text, symbol: "person.text.rectangle")
        case .backgroundTask:
            QuietLine(symbol: "clock", text: line.detail.map { "\(line.text) · \($0)" } ?? line.text)
        case .goal:
            QuietLine(symbol: "target", text: line.detail.map { "Goal \($0): \(line.text)" } ?? line.text)
        case .status:
            QuietLine(symbol: "info.circle", text: line.text)
        case .unknown:
            QuietLine(symbol: "questionmark.circle", text: line.text, tint: Color(.tertiaryLabel))
        }
    }
}

/// A spawned agent as a row: its glyph, title, model and status; tap pushes
/// its own transcript. Without a known child it is a quiet line.
struct AgentLinkRow: View {
    let childId: String?
    let client: EnvironmentClient
    let fallback: String
    let symbol: String

    var body: some View {
        if let childId, let child = client.session(childId) {
            NavigationLink(value: ThreadScreenRoute(sessionId: childId)) {
                HStack(spacing: 10) {
                    StatusDot(status: child.status, running: Fleet.isLive(child.status))
                    AgentGlyph(type: child.agentType)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(child.title.isEmpty ? "Subagent" : child.title)
                            .font(.subheadline)
                            .lineLimit(1)
                        Text(ModelName.short(child.model))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                }
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
        } else {
            QuietLine(symbol: symbol, text: fallback)
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/// Durations as a chip reads them: "0.4s", "12s", "3m 4s".
enum ToolTime {
    nonisolated static func duration(ms: Int) -> String {
        if ms < 1_000 { return String(format: "%.1fs", Double(max(0, ms)) / 1_000) }
        return TimeFormat.duration(ms: ms)
    }
}
