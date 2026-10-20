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
            QuestionCard(question: question, client: client, sessionId: sessionId)
        case .approval(let approval):
            ApprovalCard(approval: approval, client: client, sessionId: sessionId)
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

/// An approval with its decided state. Undecided, it asks with Deny and
/// Allow; a decision shows at once and reverts if the host refuses. A key
/// that cannot approve sees the card read-only with one line saying why.
struct ApprovalCard: View {
    let approval: ApprovalItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var busy = false
    @State private var failure: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host's decision, else this device's until the host confirms.
    private var decided: Bool? {
        approval.allowed ?? client.threads[sessionId]?.decisions[approval.request.requestId]
    }

    var body: some View {
        let decided = decided
        let block = client.approveBlock
        ThreadCard(tinted: decided == nil) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: symbol(decided))
                        .font(.footnote)
                        .foregroundStyle(tint(decided))
                    Text(heading(decided))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(decided == nil ? .primary : .secondary)
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
                if decided == nil {
                    if let block, !block.isTransient {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        HStack(spacing: 8) {
                            Button { decide(false) } label: {
                                Text("Deny").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button { decide(true) } label: {
                                Text("Allow").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .controlSize(.regular)
                        .disabled(busy || block != nil)
                        if let block {
                            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Tint.destructive)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: decided == nil)
        .animation(Motion.crossFade, value: failure)
        .accessibilityElement(children: .contain)
    }

    private func decide(_ allow: Bool) {
        guard !busy else { return }
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await client.approve(sessionId, requestId: approval.request.requestId, allow: allow)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func heading(_ decided: Bool?) -> String {
        switch decided {
        case nil: "Approve"
        case true?: approval.auto ? "Allowed by policy" : "Allowed"
        case false?: approval.auto ? "Denied by policy" : "Denied"
        }
    }

    private func symbol(_ decided: Bool?) -> String {
        switch decided {
        case nil: "shield"
        case true?: "checkmark.shield"
        case false?: "xmark.shield"
        }
    }

    private func tint(_ decided: Bool?) -> Color {
        switch decided {
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

/// A question with its options: tap to choose (one, or several when the
/// question allows), type when it takes free text, then Answer sends the
/// whole set. Once answered, the chosen ones stay marked. A key that
/// cannot act sees the card read-only with one line saying why.
struct QuestionCard: View {
    let question: QuestionItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var picks: [Int: [String]] = [:]
    @State private var typed: [Int: String] = [:]
    @State private var busy = false
    @State private var failure: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host's answers, else this device's until the host confirms.
    private var answers: [[String]]? {
        question.answers ?? client.threads[sessionId]?.answers[question.request.requestId]
    }

    private var resolved: Bool { question.resolved || answers != nil }

    var body: some View {
        let answers = answers
        let resolved = resolved
        let block = client.operateBlock
        let readOnly = resolved || block != nil
        ThreadCard(tinted: !resolved) {
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
                        let chosen = Set(answers?[safe: index] ?? picks[index] ?? [])
                        ForEach(Array(spec.options.enumerated()), id: \.offset) { _, option in
                            let picked = chosen.contains(option.label)
                            Button {
                                pick(option.label, in: index, multi: spec.multiSelect == true)
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                                        .font(.footnote)
                                        .foregroundStyle(picked ? Tint.success : Color(.tertiaryLabel))
                                        .contentTransition(.symbolEffect(.replace))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.label)
                                            .font(.subheadline)
                                            .foregroundStyle(resolved && !picked ? .secondary : .primary)
                                        if let description = option.description, !description.isEmpty {
                                            Text(description)
                                                .font(.footnote)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.pressable)
                            .disabled(readOnly)
                            .accessibilityAddTraits(picked ? .isSelected : [])
                        }
                        if spec.allowFreeform == true, !resolved {
                            TextField("Other", text: Binding(get: { typed[index] ?? "" }, set: { typed[index] = $0 }), axis: .vertical)
                                .font(.subheadline)
                                .lineLimit(1...4)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(Surface.background, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                                .disabled(readOnly)
                        } else if resolved, let free = answers?[safe: index]?.first(where: { label in !spec.options.contains { $0.label == label } }) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.footnote)
                                    .foregroundStyle(Tint.success)
                                Text(free)
                                    .font(.subheadline)
                            }
                        }
                    }
                }
                if !resolved {
                    if let block, !block.isTransient {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Button { submit() } label: {
                            Text("Answer").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.regular)
                        .disabled(busy || block != nil || !complete)
                        if let block {
                            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Tint.destructive)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: resolved)
        .animation(Motion.crossFade, value: failure)
    }

    /// Every question has a choice or typed text.
    private var complete: Bool {
        question.request.questions.indices.allSatisfy { index in
            !(picks[index] ?? []).isEmpty || !(typed[index] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func pick(_ label: String, in index: Int, multi: Bool) {
        var current = picks[index] ?? []
        if let at = current.firstIndex(of: label) {
            current.remove(at: at)
        } else if multi {
            current.append(label)
        } else {
            current = [label]
        }
        picks[index] = current
    }

    private func submit() {
        guard !busy else { return }
        let set = question.request.questions.indices.map { index -> [String] in
            let chosen = picks[index] ?? []
            let text = (typed[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return chosen.isEmpty ? [text] : chosen
        }
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await client.answer(sessionId, requestId: question.request.requestId, answers: set)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
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
