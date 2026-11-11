import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every row kind in its mobile form, the desktop's `AgentTranscript` row
/// by row: the user's words in a bordered field, the agent's answer as the
/// page, the work between two paragraphs as one group (`ActionGroup`: a
/// lone step as its row, more under one line that opens onto a table), cards for what needs the
/// user, an agent's published page as the page itself (`HtmlRenderRow`),
/// quiet lines and labelled dividers for the rest, and each turn's end row
/// (`TurnLineRow`: its working line, then its closing line).
struct TranscriptRow: View, Equatable {
    let row: TranscriptRowModel
    let client: EnvironmentClient
    let sessionId: String
    /// The view opened this group itself (a search landing inside it).
    var forceOpen = false
    /// The row joined the last turn after the transcript opened: its prose
    /// reveals from its first word.
    var born = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.forceOpen == rhs.forceOpen && lhs.born == rhs.born && lhs.client === rhs.client && lhs.sessionId == rhs.sessionId
    }

    var body: some View {
        let _ = PerfCounters.bump(.transcriptRowBody)
        switch row {
        case .item(let entry):
            ItemRow(entry: entry, client: client, sessionId: sessionId, born: born)
        case .group(let group):
            ActionGroup(group: group, client: client, sessionId: sessionId, forceOpen: forceOpen)
        case .turnEnd(let end):
            TurnLineRow(end: end, client: client, sessionId: sessionId)
        }
    }
}

/// One entry on its own, by kind.
private struct ItemRow: View {
    let entry: ThreadEntry
    let client: EnvironmentClient
    let sessionId: String
    var born = false

    var body: some View {
        switch entry.item {
        case .user(let turn):
            UserTurnRow(turn: turn, client: client)
        case .assistant(let block):
            AssistantRow(block: block, born: born)
        case .thinking:
            // Thinking rides in a group; this is only ever a stray.
            ActionStep(entry: entry, client: client, sessionId: sessionId)
        case .tool(let tool):
            if let render = tool.htmlRender {
                HtmlRenderRow(render: render, client: client)
            } else {
                // Every other call rides in a group; a stray draws as its row.
                ActionStep(entry: entry, client: client, sessionId: sessionId)
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

// MARK: - user

/// The person's words as the desktop draws them (transcript/UserMessage.tsx):
/// a bubble at the column's trailing edge on the chrome fill, radius 12,
/// padded 12 × 8, at most 85 % of the column (`UserTurnLayout`), no
/// outline, in the prose type; attachments above the text. A long prompt
/// folds at six lines and opens on tap; Copy is in the context menu. The
/// project rules the host put ahead of the first message fold 4 pt above
/// the bubble (`PreambleRow`). Under it, where a steer stands: one word in
/// the detail type, red when it never arrived, morphing as it moves on;
/// its time and how in the accessibility value. A bubble sent from here
/// rises in once (TranscriptView's born rows).
struct UserTurnRow: View {
    let turn: UserTurn
    let client: EnvironmentClient
    @State private var expanded = false
    @Environment(\.transcriptFollow) private var follow

    private static let foldLines = 6

    /// Long enough that the fold is worth a tap.
    private var folds: Bool {
        turn.text.count > 420 || turn.text.filter { $0 == "\n" }.count >= Self.foldLines
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: TranscriptMetrics.Gap.line) {
            if let stamp = turn.preamble {
                PreambleRow(stamp: stamp)
            }
            BubbleLayout {
                bubble
            }
            if let stamp = turn.steer, let word = stamp.word {
                MorphText(key: word, value: word) { Text($0) }
                    .transcriptType(TranscriptType.detail)
                    .foregroundStyle(stamp.state == .failed ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(.secondary))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(word)
                    .accessibilityValue(stamp.detail() ?? "")
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.Gap.block) {
            if !turn.attachments.isEmpty {
                AttachmentWrap(attachments: turn.attachments, client: client)
            }
            if !turn.text.isEmpty {
                Text(turn.text)
                    .transcriptType(TranscriptType.prose)
                    .textSelection(.enabled)
                    .lineLimit(folds && !expanded ? Self.foldLines : nil)
                    .fixedSize(horizontal: false, vertical: true)
                if folds {
                    Text(expanded ? "Show less" : "Show more")
                        .transcriptType(TranscriptType.line, weight: .medium)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(TranscriptMetrics.bubblePadding)
        .background(Surface.chrome, in: RoundedRectangle.corner(TranscriptMetrics.bubbleRadius))
        .contentShape(RoundedRectangle.corner(TranscriptMetrics.bubbleRadius))
        .onTapGesture {
            guard folds else { return }
            TranscriptFollow.resize(follow) { expanded.toggle() }
        }
        .contextMenu {
            if !turn.text.isEmpty {
                Button("Copy Message", systemImage: "doc.on.doc") { UIPasteboard.general.string = turn.text }
            }
        }
    }
}

/// The bubble's place in the column: as wide as its text wants, never past
/// 85 % of the column (`UserTurnLayout.maxWidth`), at the trailing edge.
private struct BubbleLayout: SwiftUI.Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let bubble = subviews.first else { return .zero }
        let column = proposal.width ?? .infinity
        let size = bubble.sizeThatFits(ProposedViewSize(width: UserTurnLayout.maxWidth(column: column), height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let bubble = subviews.first else { return }
        let size = bubble.sizeThatFits(ProposedViewSize(width: UserTurnLayout.maxWidth(column: bounds.width), height: nil))
        let x = bounds.minX + UserTurnLayout.leadingInset(bubble: size.width, column: bounds.width)
        bubble.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: size.width, height: size.height))
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

/// The agent's answer as the page: the prose type, no container, a generous
/// measure, selectable, the whole message copied from the context menu.
/// Streaming appends to the same row through `StreamingAssistantRow` (the
/// streaming thread's seam); an empty streaming block draws nothing (the
/// working strip says "Thinking").
struct AssistantRow: View {
    let block: TextBlock
    var born = false

    var body: some View {
        if block.text.isEmpty, block.streaming {
            EmptyView()
        } else {
            // One identity across the final row, so the reveal drains before the markdown settles.
            StreamingAssistantRow(block: block, born: born)
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
        .lineLimit(1)
        // Never wraps: in the diff's bar, "+1,200 −600" broke into two lines of digits.
        .fixedSize()
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
/// edit with the lines it adds, or the request's string fields. A computer
/// tool's title already names the app, the window and each action, so its
/// card is the title alone (`ApprovalShape.titleOnly`).
private enum ApprovalDetail {
    case shell(doing: String, command: String)
    case file(path: String, added: [String], more: Bool)
    case fields([(String, String)])

    static func of(_ request: ApprovalRequestEvent) -> ApprovalDetail? {
        if ApprovalShape.titleOnly(request.toolName) { return nil }
        let input = request.input?.objectValue ?? [:]
        let name = request.toolName.lowercased()
        let command: String? = {
            if let parts = input["command"]?.arrayValue { return parts.compactMap(\.stringValue).joined(separator: " ") }
            return input["command"]?.stringValue ?? input["cmd"]?.stringValue
        }()
        if let command, !command.isEmpty, ["bash", "shell", "local_shell", "exec"].contains(name) {
            let phrases = ToolPhrase.commandPhrases(command)
            let doing = phrases.isEmpty ? "Run a command" : ToolPhrase.sentence(phrases)
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
/// thread's), or Run now and Skip for a computer step held for the Mac
/// (`CardDecision` by the request's `choices`); decided, the one-line verdict.
struct ApprovalCard: View {
    let approval: ApprovalItem
    let client: EnvironmentClient
    let sessionId: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host's decision, else this device's until the host confirms.
    private var decided: Bool? {
        approval.allowed ?? client.thread(sessionId)?.overlays.decisions[approval.request.requestId]
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
                    // Undecided, the title is what the person decides on: whole at every text size.
                    Text(approval.request.title ?? approval.request.toolName)
                        .font(.subheadline)
                        .foregroundStyle(decided == nil ? .primary : .secondary)
                        .lineLimit(decided == nil ? nil : 3)
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
        CardDecision.heading(allowed: decided, auto: approval.auto, choices: approval.request.choices)
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

/// A question, the desktop's `QuestionCard` in its proportions: the amber
/// glyph beside the title (the question's header, else "Question") in 15
/// medium, each prompt in the prose type, its options as 28 pt rows with
/// their description line (the picked one on the fill step), an Other field
/// when the question takes free text, then Answer sends the whole set. The
/// key tiles are the desktop's keyboard and stay there. Once answered, the
/// chosen rows stay and the rest fall away. A key that cannot act sees the
/// card read-only with one line saying why.
struct QuestionCard: View {
    let question: QuestionItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var picks: [Int: [String]] = [:]
    @State private var typed: [Int: String] = [:]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The host's answers, else this device's until the host confirms.
    private var answers: [[String]]? {
        question.answers ?? client.thread(sessionId)?.overlays.answers[question.request.requestId]
    }

    private var resolved: Bool { question.resolved || answers != nil }

    var body: some View {
        let answers = answers
        let resolved = resolved
        let block = client.operateBlock
        let readOnly = resolved || block != nil
        let specs = question.request.questions
        ThreadCard(tinted: !resolved) {
            VStack(alignment: .leading, spacing: TranscriptMetrics.Gap.block) {
                HStack(alignment: .firstTextBaseline, spacing: TranscriptMetrics.glyphGap) {
                    Image(systemName: "questionmark.circle")
                        .transcriptFont(TranscriptType.prose, weight: .medium)
                        .foregroundStyle(resolved ? Color(.secondaryLabel) : Tint.warning)
                        .accessibilityHidden(true)
                    Text(specs.first?.header.flatMap { $0.isEmpty ? nil : $0 } ?? "Question")
                        .transcriptType(TranscriptType.prose, weight: .medium)
                        .foregroundStyle(resolved ? .secondary : .primary)
                        .lineLimit(1)
                }
                ForEach(Array(specs.enumerated()), id: \.offset) { index, spec in
                    let chosen = Set(answers?[safe: index] ?? picks[index] ?? [])
                    VStack(alignment: .leading, spacing: TranscriptMetrics.Gap.line) {
                        if index > 0, let header = spec.header, !header.isEmpty {
                            Text(header)
                                .transcriptType(TranscriptType.line, weight: .medium)
                                .foregroundStyle(.secondary)
                        }
                        Text(spec.question)
                            .transcriptType(TranscriptType.prose)
                            .foregroundStyle(resolved ? .secondary : .primary)
                            .fixedSize(horizontal: false, vertical: true)
                        VStack(alignment: .leading, spacing: TranscriptMetrics.wordGap) {
                            ForEach(Array(spec.options.enumerated()), id: \.offset) { _, option in
                                let picked = chosen.contains(option.label)
                                if !resolved || picked {
                                    OptionRow(label: option.label, description: option.description, picked: picked, enabled: !readOnly) {
                                        pick(option.label, in: index, multi: spec.multiSelect == true)
                                    }
                                }
                            }
                            if resolved, let free = answers?[safe: index]?.first(where: { label in !spec.options.contains { $0.label == label } }) {
                                OptionRow(label: free, description: nil, picked: true, enabled: false) {}
                            }
                        }
                        .padding(.top, TranscriptMetrics.Gap.line)
                        if spec.allowFreeform != false, !resolved {
                            TextField("Other", text: Binding(get: { typed[index] ?? "" }, set: { typed[index] = $0 }), axis: .vertical)
                                .transcriptType(TranscriptType.prose)
                                .lineLimit(1...4)
                                .padding(.horizontal, TranscriptMetrics.glyphGap)
                                .frame(minHeight: TranscriptMetrics.composerControl)
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

/// One option, the desktop's option row: at least 28 pt, the label in the
/// prose type and its description muted under it, on the fill step when
/// picked; a full-width target.
private struct OptionRow: View {
    let label: String
    let description: String?
    let picked: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .transcriptType(TranscriptType.prose)
                    .foregroundStyle(.primary)
                if let description, !description.isEmpty {
                    Text(description)
                        .transcriptType(TranscriptType.line)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, TranscriptMetrics.glyphGap)
            .padding(.vertical, TranscriptMetrics.wordGap)
            .frame(maxWidth: .infinity, minHeight: TranscriptMetrics.composerControl, alignment: .leading)
            .background(picked ? Surface.fill : Color.clear, in: .rowCorner)
            .contentShape(.rowCorner)
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .animation(Motion.crossFade, value: picked)
        .accessibilityAddTraits(picked ? .isSelected : [])
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
        .frame(minHeight: TranscriptMetrics.line)
        .accessibilityElement(children: .combine)
    }
}

/// The system lines: the host's own rows where the fold carries a verdict
/// or a notice (`FailureCard`, `NoticeRow`), else the desktop's `ErrorChip`
/// (a gray Stopped for the user's own Stop, red Failed with the harness's
/// words for anything else), a plan, a goal, and every other host line on
/// the one notice line. The host's steps (a report, a spawn, a task, the
/// pass, the hand-off) ride in a run (`HostStep`); one met here alone draws
/// the same line.
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
                NoticeLine(lead: "Stopped") { StepStateMark(state: .stopped) }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.footnote)
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Failed")
                            .fontWeight(.medium)
                        if !line.text.isEmpty {
                            Text(Board.firstLine(line.text))
                                .opacity(0.8)
                        }
                    }
                }
                .font(.footnote)
                .foregroundStyle(Tint.destructive)
                .padding(.horizontal, 8)
                .frame(minHeight: TranscriptMetrics.line)
                .textSelection(.enabled)
                .accessibilityElement(children: .combine)
            }
        case .plan:
            MarkdownView(seq: line.seq, text: line.text)
                .padding(.vertical, 4)
        case .turnPass, .agentSpawned, .agentReport, .planHandoff, .backgroundTask:
            HostStep(line: line, client: client)
        case .goal:
            NoticeLine(symbol: "target", lead: line.detail.map { "Goal \($0)" } ?? "Goal", details: [line.text], wrap: true)
        case .status:
            if line.notice != nil {
                NoticeRow(line: line, client: client, sessionId: sessionId)
            } else {
                NoticeLine(symbol: "info.circle", lead: line.text, wrap: true)
            }
        case .unknown:
            NoticeLine(symbol: "questionmark.circle", lead: line.text, wrap: true)
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
