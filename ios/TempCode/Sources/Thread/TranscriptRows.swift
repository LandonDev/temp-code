import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every row kind in its mobile form, the desktop's `AgentTranscript` row
/// by row: the user's words in a bordered field, the agent's answer as the
/// page, thinking folded, tools as one-line chips with runs of them folded
/// behind "+N previous tool calls", edits as bordered cards with their
/// diffstat, cards for what needs the user, quiet lines and labelled
/// dividers for the rest, and a settled turn's closing line.
struct TranscriptRow: View, Equatable {
    let row: TranscriptRowModel
    let client: EnvironmentClient
    let sessionId: String
    /// The view opened this group itself (a search landing inside it).
    var forceOpen = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.forceOpen == rhs.forceOpen && lhs.client === rhs.client && lhs.sessionId == rhs.sessionId
    }

    var body: some View {
        switch row {
        case .item(let entry):
            ItemRow(entry: entry, client: client, sessionId: sessionId)
        case .group(let group):
            ActivityGroupRow(group: group, client: client, sessionId: sessionId, forceOpen: forceOpen)
        case .turnEnd(let end):
            TurnEndRow(end: end)
        }
    }
}

/// One entry on its own, by kind.
private struct ItemRow: View {
    let entry: ThreadEntry
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        switch entry.item {
        case .user(let turn):
            UserTurnRow(turn: turn, client: client)
        case .assistant(let block):
            AssistantRow(block: block)
        case .thinking(let block):
            ThinkingRow(block: block)
        case .tool(let tool):
            if let path = Board.editPath(tool) {
                EditRow(sessionId: sessionId, card: Board.wholeChange(path: path, edits: [tool]), running: tool.status == .running, failed: tool.status == .failed)
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
            SystemRow(line: line, client: client, sessionId: sessionId)
        }
    }
}

/// A settled turn's closing line, the desktop's `TurnEnd`: "Worked for 12s"
/// and the clock time, quiet, with Copy answer in the context menu. Nothing
/// while the turn runs; the working strip has the live timer.
struct TurnEndRow: View {
    let end: TurnEnd

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark")
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(TranscriptRows.workedLabel(ms: end.durationMs))
            Circle()
                .frame(width: 3, height: 3)
                .accessibilityHidden(true)
            Text(TimeFormat.stamp(end.completedTs))
                .monospacedDigit()
        }
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 8)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            if !end.answer.isEmpty {
                Button("Copy answer", systemImage: "doc.on.doc") { UIPasteboard.general.string = end.answer }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - user

/// A bordered field, not a bubble: hairline, 12 pt radius, 12 pt padding,
/// attachments above the text as thumbnails with a 1 px outline or a
/// document chip. A long prompt folds at six lines and opens on tap. Copy
/// from the context menu, as the desktop's corner button does. The time it
/// was sent is the turn's closing line (the desktop's stamp shows on hover
/// only). The project rules the host put ahead of the first message fold
/// inside the field above the brief (`PreambleRow`, the host rows thread's).
struct UserTurnRow: View {
    let turn: UserTurn
    let client: EnvironmentClient
    @State private var expanded = false

    private static let foldLines = 6

    /// Long enough that the fold is worth a tap.
    private var folds: Bool {
        turn.text.count > 420 || turn.text.filter { $0 == "\n" }.count >= Self.foldLines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            VStack(alignment: .leading, spacing: 10) {
                if let stamp = turn.preamble { PreambleRow(stamp: stamp) }
                if !turn.attachments.isEmpty {
                    AttachmentWrap(attachments: turn.attachments, client: client)
                }
                if !turn.text.isEmpty {
                    Text(turn.text)
                        .font(.body)
                        .textSelection(.enabled)
                        .lineLimit(folds && !expanded ? Self.foldLines : nil)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if folds {
                        Text(expanded ? "Show less" : "Show more")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Surface.chrome, in: .fieldCorner)
            .hairlineBorder(RoundedRectangle.fieldCorner)
            .contentShape(.fieldCorner)
            .onTapGesture {
                guard folds else { return }
                withAnimation(expanded ? Motion.collapse : Motion.expand) { expanded.toggle() }
            }
            .contextMenu {
                if !turn.text.isEmpty {
                    Button("Copy Message", systemImage: "doc.on.doc") { UIPasteboard.general.string = turn.text }
                }
            }
        }
        .padding(.top, 6)
        .accessibilityElement(children: .contain)
    }
}

/// Attachments as the desktop lays them: images as thumbnails, everything
/// else as a one-line chip with its glyph, wrapping as they need.
private struct AttachmentWrap: View {
    let attachments: [Attachment]
    let client: EnvironmentClient

    var body: some View {
        let images = attachments.filter(\.isImage)
        let others = attachments.filter { !$0.isImage }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, attachment in
                MediaImage(client: client, path: attachment.path, name: attachment.name)
            }
            if !others.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(Array(others.enumerated()), id: \.offset) { _, attachment in
                        Label(attachment.name, systemImage: attachment.kind == .thread ? "text.bubble" : "doc")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .inlineWash()
                    }
                }
            }
        }
    }
}

extension Attachment {
    var isImage: Bool {
        kind == .image || kind == .appshot || (mime ?? "").hasPrefix("image/")
    }
}

// MARK: - assistant

/// The agent's answer as the page: body size, no container, a generous
/// measure, selectable, the whole message copied from the context menu.
/// Streaming appends to the same row through `StreamingAssistantRow` (the
/// streaming thread's seam); an empty streaming block draws nothing (the
/// working strip says "Thinking").
struct AssistantRow: View {
    let block: TextBlock

    var body: some View {
        if block.text.isEmpty, block.streaming {
            EmptyView()
        } else {
            // One identity across the final row, so the reveal drains before the markdown settles.
            StreamingAssistantRow(block: block)
        }
    }
}

// MARK: - thinking

/// One folded line: "Thought" with "for 2s" in the dim half, "Thinking"
/// shimmering while it streams; tap opens the thought in place, in the
/// secondary step, with the expand spring. Reasoning is read on purpose.
struct ThinkingRow: View {
    let block: TextBlock
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 18)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .accessibilityHidden(true)
                    if block.streaming {
                        StreamingThinkingLine(block: block)
                    } else {
                        Text("Thought")
                            .foregroundStyle(.secondary)
                        if let ms = block.durationMs, ms >= 1_000 {
                            Text("for \(TimeFormat.duration(ms: ms))")
                                .foregroundStyle(.tertiary)
                                .monospacedDigit()
                        }
                    }
                    Spacer(minLength: 0)
                }
                .font(.subheadline)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(block.streaming ? "Thinking" : "Thought")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                MarkdownView(seq: block.seq, text: block.text, dim: true)
                    .textSelection(.enabled)
                    .padding(.leading, 26)
                    .padding(.bottom, 8)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
    }
}

// MARK: - edits

/// A file change stands alone, the desktop's `EditRow`: a bordered card,
/// the icon in its 20 pt box, the file name leading (basename medium, the
/// directory dim), a live verb while the call runs, then the `+n −m`
/// diffstat in success and destructive, tabular. No chevron: every row
/// pushes. Tap opens the unified diff full screen.
struct EditRow: View {
    let sessionId: String
    let card: ChangeCard
    var running = false
    var failed = false

    private var directory: String? {
        let parts = card.path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return ToolPhrase.displayPath(parts.dropLast().joined(separator: "/"))
    }

    private var removed: Bool {
        card.edits.contains { edit in
            let name = edit.name.lowercased()
            return name.contains("delete") || name.contains("remove")
        }
    }

    var body: some View {
        NavigationLink(value: DiffRoute(sessionId: sessionId, card: card)) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle.corner(TranscriptStyle.iconBoxRadius)
                        .fill(TranscriptStyle.control)
                    if running {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: removed ? "trash" : card.edits.first.map { $0.name == "Write" } == true ? "doc.badge.plus" : "pencil.line")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: TranscriptStyle.iconBox, height: TranscriptStyle.iconBox)
                .accessibilityHidden(true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if running {
                        Text("Editing")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(card.fileName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(failed ? Tint.destructive : .primary)
                        .strikethrough(removed)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    if let directory {
                        Text(directory)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    if card.editCount > 1 {
                        Text("×\(card.editCount)")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 8)
                if failed {
                    Text("failed")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Tint.destructive)
                } else if removed {
                    Text("deleted")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Tint.destructive.opacity(0.8))
                } else {
                    ChangeStat(adds: card.adds, dels: card.dels)
                }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 36)
            .contentShape(.corner(TranscriptStyle.blockRadius))
        }
        .buttonStyle(.pressable)
        .transcriptBlock(tint: failed ? Tint.destructive.opacity(0.3) : nil)
        .accessibilityLabel("\(running ? "Editing" : "Edited") \(card.fileName), \(card.adds) added, \(card.dels) removed")
    }
}

/// `+n` in success, `−m` in destructive, semibold and tabular, as the desktop's diffstat.
struct ChangeStat: View {
    let adds: Int
    let dels: Int

    var body: some View {
        HStack(spacing: 5) {
            if adds > 0 {
                Text("+\(adds)")
                    .foregroundStyle(Tint.success)
            }
            if dels > 0 {
                Text("−\(dels)")
                    .foregroundStyle(Tint.destructive)
            }
        }
        .font(.footnote.weight(.semibold))
        .numeric([adds, dels])
    }
}

// MARK: - cards

/// The only raised surface in the transcript: hairline, warning tint at 8 %
/// while undecided, the one gray step once decided.
struct ThreadCard<Content: View>: View {
    let tinted: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(tinted ? Surface.needsYou : Surface.chrome, in: .fieldCorner)
            .hairlineBorder(RoundedRectangle.fieldCorner, color: tinted ? Tint.warning.opacity(0.35) : Surface.hairline)
    }
}

/// What an approval asks for, shaped per tool and never raw JSON (the
/// desktop's `approvalDetailOf`): a shell command with its gist, a file
/// edit with the lines it adds, or the request's string fields.
private enum ApprovalDetail {
    case shell(doing: String, command: String)
    case file(path: String, added: [String], more: Bool)
    case fields([(String, String)])

    static func of(_ request: ApprovalRequestEvent) -> ApprovalDetail? {
        let input = request.input?.objectValue ?? [:]
        let name = request.toolName.lowercased()
        let command: String? = {
            if let parts = input["command"]?.arrayValue { return parts.compactMap(\.stringValue).joined(separator: " ") }
            return input["command"]?.stringValue ?? input["cmd"]?.stringValue
        }()
        if let command, !command.isEmpty, ["bash", "shell", "local_shell", "exec"].contains(name) {
            let phrases = ToolPhrase.commandPhrases(command)
            let doing = phrases.isEmpty ? "Run a command" : phrases.prefix(2).joined(separator: " · ")
            return .shell(doing: doing.prefix(1).uppercased() + doing.dropFirst(), command: ToolPhrase.bareCommand(command))
        }
        if let path = input["file_path"]?.stringValue ?? input["notebook_path"]?.stringValue ?? input["path"]?.stringValue, !path.isEmpty {
            let content = input["content"]?.stringValue ?? input["new_string"]?.stringValue ?? input["new_source"]?.stringValue ?? ""
            let lines = content.isEmpty ? [] : content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            return .file(path: ToolPhrase.displayPath(path), added: Array(lines.prefix(10)), more: lines.count > 10)
        }
        let entries = input.keys.sorted().compactMap { key -> (String, String)? in
            guard let value = input[key]?.stringValue, !value.isEmpty else { return nil }
            return (key, String(value.prefix(300)))
        }
        return entries.isEmpty ? nil : .fields(Array(entries.prefix(4)))
    }
}

/// An approval with its decided state, the desktop's `ApprovalControls`:
/// undecided, what the agent wants to do in plain words with the command
/// in a mono well, then Allow and Deny (`ApprovalActions`, the steering
/// thread's); decided, the one-line verdict.
struct ApprovalCard: View {
    let approval: ApprovalItem
    let client: EnvironmentClient
    let sessionId: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host's decision, else this device's until the host confirms.
    private var decided: Bool? {
        approval.allowed ?? client.threads[sessionId]?.decisions[approval.request.requestId]
    }

    var body: some View {
        let decided = decided
        let detail = ApprovalDetail.of(approval.request)
        ThreadCard(tinted: decided == nil) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: symbol(decided))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(tint(decided))
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    Text(heading(decided))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                    Spacer(minLength: 0)
                }
                switch detail {
                case .shell(let doing, let command)?:
                    Text(doing)
                        .font(.subheadline)
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                    Text(command)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(decided == nil ? 8 : 2)
                        .textSelection(.enabled)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TranscriptStyle.wash, in: .rowCorner)
                case .file(let path, let added, let more)?:
                    Text("Write \(path)")
                        .font(.subheadline)
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                    if !added.isEmpty, decided == nil {
                        Text(added.joined(separator: "\n") + (more ? "\n…" : ""))
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(11)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(TranscriptStyle.wash, in: .rowCorner)
                    }
                case .fields(let entries)?:
                    Text(approval.request.title ?? approval.request.toolName)
                        .font(.subheadline)
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                    if decided == nil {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(entry.0)
                                        .foregroundStyle(.tertiary)
                                    Text(entry.1)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                .font(.footnote)
                            }
                        }
                    }
                case nil:
                    Text(approval.request.title ?? approval.request.toolName)
                        .font(.subheadline)
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                        .lineLimit(3)
                }
                if decided == nil {
                    ApprovalActions(approval: approval, client: client, sessionId: sessionId)
                        .padding(.top, 2)
                        .transition(.opacity)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: decided == nil)
        .accessibilityElement(children: .contain)
    }

    private func heading(_ decided: Bool?) -> String {
        switch decided {
        case nil: "Approve"
        case true?: "Approved"
        case false?: approval.auto ? "Denied (timed out)" : "Denied"
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
}

/// A question with its options as chips, the desktop's `QuestionCard`: the
/// header small and dim, the question, the options as wash chips (the
/// picked one near-black), an Other field when the question takes free
/// text, then Answer sends the whole set. Once answered, the chosen chips
/// stay on and the rest fall away. A key that cannot act sees the card
/// read-only with one line saying why.
struct QuestionCard: View {
    let question: QuestionItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var picks: [Int: [String]] = [:]
    @State private var typed: [Int: String] = [:]
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
        let specs = question.request.questions
        ThreadCard(tinted: !resolved) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(specs.enumerated()), id: \.offset) { index, spec in
                    let chosen = Set(answers?[safe: index] ?? picks[index] ?? [])
                    VStack(alignment: .leading, spacing: 8) {
                        if let header = spec.header, !header.isEmpty {
                            Text(header.uppercased())
                                .font(.caption2.weight(.semibold))
                                .tracking(0.6)
                                .foregroundStyle(.tertiary)
                        }
                        Text(spec.question)
                            .font(.subheadline.weight(resolved ? .regular : .medium))
                            .foregroundStyle(resolved ? .secondary : .primary)
                        FlowLayout(spacing: 6) {
                            ForEach(Array(spec.options.enumerated()), id: \.offset) { _, option in
                                let picked = chosen.contains(option.label)
                                if !resolved || picked {
                                    OptionChip(label: option.label, description: option.description, picked: picked, enabled: !readOnly) {
                                        pick(option.label, in: index, multi: spec.multiSelect == true)
                                    }
                                }
                            }
                            if resolved, let free = answers?[safe: index]?.first(where: { label in !spec.options.contains { $0.label == label } }) {
                                OptionChip(label: free, description: nil, picked: true, enabled: false) {}
                            }
                        }
                        if spec.allowFreeform != false, !resolved {
                            TextField("Other", text: Binding(get: { typed[index] ?? "" }, set: { typed[index] = $0 }), axis: .vertical)
                                .font(.subheadline)
                                .lineLimit(1...4)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Surface.background, in: .rowCorner)
                                .disabled(readOnly)
                        }
                    }
                }
                if !resolved {
                    QuestionActions(question: question, client: client, sessionId: sessionId, answers: set, complete: complete)
                        .transition(.opacity)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: resolved)
    }

    /// Every question's answer as the card has it: the chosen labels, else the typed text.
    private var set: [[String]] {
        question.request.questions.indices.map { index -> [String] in
            let chosen = picks[index] ?? []
            let text = (typed[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return chosen.isEmpty ? [text] : chosen
        }
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

}

/// One option: the desktop's `CHIP` at rest, `CHIP_ON` when picked. The
/// description, when the option has one, rides under the label.
private struct OptionChip: View {
    let label: String
    let description: String?
    let picked: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.subheadline.weight(.medium))
                if let description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .opacity(0.75)
                }
            }
            .foregroundStyle(picked ? Surface.background : .primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(minHeight: 32)
            .background(picked ? Color.primary : TranscriptStyle.control, in: .rowCorner)
            .contentShape(.rowCorner)
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .animation(Motion.crossFade, value: picked)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}

/// Chips that wrap: each row fills the width, then the next begins. Pure
/// geometry, so it stays off the main actor like the protocol it adopts
/// (named with its module: the kit's `Layout` enum shadows it here).
nonisolated struct FlowLayout: SwiftUI.Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = Self.size(of: subview, within: width)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return CGSize(width: width == .infinity ? maxX : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = Self.size(of: subview, within: bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    /// A chip's own width, or the row's when it is wider: a long option wraps inside its chip instead of running past the card.
    private static func size(of subview: LayoutSubview, within width: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        guard width.isFinite, ideal.width > width else { return ideal }
        return subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }
}

// MARK: - quiet lines

/// One quiet line: glyph and text in the secondary step; errors in destructive.
struct QuietLine: View {
    let symbol: String
    let text: String
    var tint: Color = Color(.secondaryLabel)

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(.footnote)
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .lineLimit(4)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
    }
}

/// A compaction's three faces, the desktop's `CompactionCard`: a pulsing
/// violet dot and "Compacting context" while the harness squeezes the
/// window, a labelled divider with the before and after once it lands, a
/// destructive line when it fails.
struct CompactionLine: View {
    let compaction: CompactionItem
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch compaction.phase {
        case .start:
            HStack(spacing: 8) {
                Circle()
                    .fill(Tint.violet)
                    .frame(width: 6, height: 6)
                    .opacity(pulse ? 0.35 : 1)
                    // The pulse rides on the dot alone, never on the row's layout.
                    .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: pulse)
                    .frame(width: 18)
                    .onAppear {
                        guard !reduceMotion else { return }
                        pulse = true
                    }
                Text("Compacting context")
                    .foregroundStyle(.secondary)
                if let trigger = compaction.trigger {
                    Text(trigger.rawValue)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(TimeFormat.elapsed(since: compaction.ts))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .contentTransition(.numericText())
                }
            }
            .font(.footnote)
            .padding(.horizontal, 8)
            .frame(minHeight: 28)
            .accessibilityElement(children: .combine)
        case .failed:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text("Compaction failed")
                if let error = compaction.error, !error.isEmpty {
                    Text(error)
                        .opacity(0.7)
                        .lineLimit(2)
                }
            }
            .font(.footnote)
            .foregroundStyle(Tint.destructive)
            .padding(.horizontal, 8)
            .frame(minHeight: 28)
            .accessibilityElement(children: .combine)
        case .done, .unknown:
            LabeledDivider {
                HStack(spacing: 6) {
                    Text("Context compacted")
                        .foregroundStyle(.secondary)
                    if !parts.isEmpty {
                        Text(parts.joined(separator: " · "))
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Context compacted \(parts.joined(separator: ", "))")
        }
    }

    private var parts: [String] {
        var out: [String] = []
        if let pre = compaction.preTokens, let post = compaction.postTokens {
            out.append("\(Formatting.tokens(pre)) → \(Formatting.tokens(post))")
        } else if let post = compaction.postTokens {
            out.append("now \(Formatting.tokens(post))")
        }
        if let ms = compaction.durationMs { out.append(TimeFormat.duration(ms: Int(ms))) }
        if let trigger = compaction.trigger { out.append(trigger.rawValue) }
        return out
    }
}

/// The system lines: the host's own rows where the fold carries a verdict
/// or a notice (`FailureCard`, `NoticeRow`, `PlanHandoffRow`, the host rows
/// thread's), else the desktop's `ErrorChip` (a gray Stopped for the user's
/// own Stop, red Failed with the harness's words for anything else),
/// `PassRow`, a plan, and the spawn and report rows.
struct SystemRow: View {
    let line: SystemLine
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        switch line.kind {
        case .error:
            if let failure = line.failure, !line.stopped {
                FailureCard(line: line, failure: failure, client: client, sessionId: sessionId)
            } else if line.stopped {
                QuietLine(symbol: "stop.circle", text: "Stopped", tint: Color(.tertiaryLabel))
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.footnote)
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    Text("\(Text("Failed").fontWeight(.medium))\(line.text.isEmpty ? "" : " · \(Board.firstLine(line.text))")")
                }
                .font(.footnote)
                .foregroundStyle(Tint.destructive)
                .padding(.horizontal, 8)
                .frame(minHeight: 28)
                .textSelection(.enabled)
                .accessibilityElement(children: .combine)
            }
        case .plan:
            MarkdownView(seq: line.seq, text: line.text)
                .padding(.vertical, 4)
        case .turnPass:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Pass")
                    .frame(width: 18)
                Text(line.text.replacingOccurrences(of: ", ", with: " · "))
                    .lineLimit(1)
            }
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 8)
            .frame(minHeight: 28)
            .accessibilityElement(children: .combine)
        case .agentSpawned:
            AgentSpawnRow(line: line, client: client, kind: .spawned)
        case .agentReport:
            AgentSpawnRow(line: line, client: client, kind: .reported)
        case .planHandoff:
            PlanHandoffRow(line: line, client: client)
        case .backgroundTask:
            QuietLine(symbol: "clock", text: line.detail.map { "\(line.text) · \($0)" } ?? line.text)
        case .goal:
            QuietLine(symbol: "target", text: line.detail.map { "Goal \($0): \(line.text)" } ?? line.text)
        case .status:
            if line.notice != nil {
                NoticeRow(line: line, client: client, sessionId: sessionId)
            } else {
                QuietLine(symbol: "info.circle", text: line.text)
            }
        case .unknown:
            QuietLine(symbol: "questionmark.circle", text: line.text, tint: Color(.tertiaryLabel))
        }
    }
}

/// A spawned agent's row, the desktop's `AgentSpawnRow`: nested under a
/// rail, its role glyph, "Spawned" or "Reported", its title in a wash, and
/// where it stands. Tap pushes the child's own transcript.
struct AgentSpawnRow: View {
    enum Kind { case spawned, reported }

    let line: SystemLine
    let client: EnvironmentClient
    let kind: Kind
    @Environment(\.displayScale) private var scale

    private var child: SessionMeta? { line.agentId.flatMap(client.session) }

    var body: some View {
        let child = child
        let title: String = {
            if let child, !child.title.isEmpty { return child.title }
            return kind == .reported ? line.text : "Subagent"
        }()
        let status: String? = kind == .reported ? line.detail : child?.status.rawValue
        let row = HStack(spacing: 8) {
            if let child {
                AgentGlyph(type: child.agentType)
                    .frame(width: 18)
            } else {
                Image(systemName: "person")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .frame(width: 18)
            }
            Text(kind == .reported ? "Reported" : "Spawned")
                .foregroundStyle(.secondary)
                .fixedSize()
            Text(title)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .inlineWash()
                .layoutPriority(1)
            if let status, !status.isEmpty {
                HStack(spacing: 5) {
                    if kind == .spawned, let child { StatusDot(status: child.status, running: Fleet.isLive(child.status)) }
                    Text(status)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                .font(.footnote)
            }
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .padding(.leading, 12)
        .frame(minHeight: 36)
        .overlay(alignment: .leading) {
            Surface.hairline
                .frame(width: 1 / scale)
                .padding(.vertical, 4)
        }
        .padding(.leading, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        if let child {
            NavigationLink(value: ThreadScreenRoute(sessionId: child.id)) { row }
                .buttonStyle(.pressable)
        } else {
            row
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
