import SwiftUI
import TempCodeClient
import TempCodeContract

// MARK: - the notice line

/// A notice on one line, the desktop's `NoticeLine` at the action rows'
/// size: the 14 pt glyph slot, 8 pt to the lead, then its details 4 pt
/// after it as one muted comma run that truncates once. The lead is medium
/// when details follow it, regular alone. 28 pt at the prose's edge; 32 pt
/// and 12 pt in inside a group's table. A line that wraps (plain host
/// words) breaks under the lead, never under the glyph.
///
/// Folded into a run as one of its steps (`\.noticeStep`), the line reads
/// verb then target like a call: the lead muted and regular whatever the
/// tone says (a failure is the glyph's to say), the first detail in the
/// primary step, the rest the muted run.
struct NoticeLine<Glyph: View>: View {
    enum Tone { case muted, strong, destructive }

    let lead: String
    var details: [String] = []
    var tone: Tone = .muted
    var wrap = false
    var inTable = false
    /// Where the line's subject stands, still, right after the words.
    var trailing: StepStateMark.State?
    /// The line opens what it holds: nil draws no chevron; false points right, true turns down.
    var chevron: Bool?
    @ViewBuilder let glyph: () -> Glyph
    @Environment(\.noticeStep) private var step

    var body: some View {
        let shown = details.filter { !$0.isEmpty }
        let target = step ? shown.first : nil
        let run = step ? Array(shown.dropFirst()) : shown
        HStack(alignment: .top, spacing: 0) {
            glyph()
                .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphLine)
                .padding(.trailing, TranscriptMetrics.glyphGap)
            words(target: target, run: run)
                .lineLimit(wrap ? 4 : 1)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: wrap)
            if let trailing {
                StepStateMark(state: trailing)
                    .frame(height: TranscriptMetrics.glyphLine)
                    .padding(.leading, TranscriptMetrics.afterValue)
            }
            if let chevron {
                Image(systemName: "chevron.right")
                    .transcriptFont(TranscriptType.detail, weight: .semibold)
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(chevron ? 90 : 0))
                    .animation(Motion.base, value: chevron)
                    .frame(height: TranscriptMetrics.glyphLine)
                    .padding(.leading, TranscriptMetrics.afterValue)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
        }
        .transcriptType(TranscriptType.line)
        .padding(.vertical, (TranscriptMetrics.line - TranscriptMetrics.glyphLine) / 2)
        .padding(.horizontal, inTable ? TranscriptMetrics.tableInset : 0)
        .frame(minHeight: inTable ? TranscriptMetrics.tableRow : TranscriptMetrics.line)
        .accessibilityElement(children: .combine)
    }

    private func words(target: String?, run: [String]) -> Text {
        let leadStyle: AnyShapeStyle = switch step ? .muted : tone {
        case .muted: AnyShapeStyle(.secondary)
        case .strong: AnyShapeStyle(.primary)
        case .destructive: AnyShapeStyle(Tint.destructive)
        }
        var text = Text(lead).fontWeight(!step && !run.isEmpty ? .medium : .regular).foregroundStyle(leadStyle)
        if let target { text = Text("\(text) \(Text(target).foregroundStyle(.primary))") }
        if !run.isEmpty { text = Text("\(text) \(Text(NoticeLines.join(run)).foregroundStyle(.secondary))") }
        return text
    }
}

extension NoticeLine where Glyph == NoticeSymbol {
    /// A line led by an SF Symbol in the secondary step.
    init(symbol: String?, lead: String, details: [String] = [], tone: Tone = .muted, wrap: Bool = false, inTable: Bool = false) {
        self.init(lead: lead, details: details, tone: tone, wrap: wrap, inTable: inTable) { NoticeSymbol(name: symbol, tone: tone) }
    }
}

/// A notice's chrome glyph: an SF Symbol sized to the slot, in the line's tone.
struct NoticeSymbol: View {
    let name: String?
    var tone: NoticeLine<NoticeSymbol>.Tone = .muted

    var body: some View {
        if let name {
            Image(systemName: name)
                .transcriptFont(TranscriptType.detail)
                .foregroundStyle(tone == .destructive ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(.secondary))
                .accessibilityHidden(true)
        }
    }
}

enum NoticeLines {
    /// Details joined by commas, unless the one before already ends its phrase ("Backfill the old rows? Yes").
    static func join(_ details: [String]) -> String {
        var out = ""
        for (index, detail) in details.enumerated() {
            if index > 0 { out += details[index - 1].hasSuffix("?") || details[index - 1].hasSuffix(":") ? " " : ", " }
            out += detail
        }
        return out
    }
}

extension EnvironmentValues {
    /// The line is a step of a run: it reads verb then target.
    @Entry var noticeStep = false
    /// The names the run's spawn calls gave their children, by child id.
    @Entry var spawnedNames: [String: SpawnedName] = [:]
}

// MARK: - a state, still

/// An agent's state as one still glyph in the 14 pt slot, the desktop's
/// `StatusMark … still`: working is a dot, never a spinner (the working line
/// is the transcript's one moving mark); watching the info dot, waiting
/// the amber dot, failed the red cross, paused the pause mark, queued a
/// dashed ring, stopped a still square, settled a check. A change of state
/// cross-fades in place.
struct StepStateMark: View {
    enum State: Hashable { case working, watching, waiting, failed, paused, queued, stopped, done }
    let state: State

    var body: some View {
        ZStack {
            switch state {
            case .working: dot(.secondary)
            case .watching: dot(Tint.info)
            case .waiting: dot(Tint.warning)
            case .failed:
                Image(systemName: "xmark")
                    .transcriptFont(TranscriptType.detail, weight: .semibold)
                    .foregroundStyle(Tint.destructive)
            case .paused:
                Image(systemName: "pause.fill")
                    .transcriptFont(TranscriptType.detail)
                    .foregroundStyle(Tint.warning)
            case .queued:
                Image(systemName: "circle.dashed")
                    .transcriptFont(TranscriptType.detail)
                    .foregroundStyle(Tint.quiet)
            case .stopped:
                RoundedRectangle.corner(Radius.mark)
                    .fill(Tint.quiet)
                    .frame(width: TranscriptMetrics.stepDot, height: TranscriptMetrics.stepDot)
            case .done:
                Image(systemName: "checkmark")
                    .transcriptFont(TranscriptType.detail, weight: .medium)
                    .foregroundStyle(Tint.success)
            }
        }
        .transition(.opacity)
        .id(state)
        .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
        .animation(Motion.crossFade, value: state)
        .accessibilityLabel(Self.word(state))
    }

    private func dot(_ style: some ShapeStyle) -> some View {
        Circle().fill(style).frame(width: TranscriptMetrics.stepDot, height: TranscriptMetrics.stepDot)
    }

    static func word(_ state: State) -> String {
        switch state {
        case .working: "Working"
        case .watching: "Watching"
        case .waiting: "Needs you"
        case .failed: "Failed"
        case .paused: "Paused"
        case .queued: "Queued"
        case .stopped: "Stopped"
        case .done: "Done"
        }
    }

    /// A live session's state.
    static func of(_ status: SessionStatus) -> State {
        switch status {
        case .running, .starting: .working
        case .watching: .watching
        case .waiting: .waiting
        case .error: .failed
        case .paused: .paused
        case .queued: .queued
        case .stopped: .stopped
        case .idle, .done, .unknown: .done
        }
    }

    /// A reported status ("idle", "failed", "blocked", …).
    static func reported(_ status: String) -> State {
        switch status {
        case "failed", "error", "blocked": .failed
        case "waiting": .waiting
        case "stopped": .stopped
        case "paused": .paused
        case "watching": .watching
        case "running", "starting": .working
        default: .done
        }
    }
}

// MARK: - agents in the run

/// An agent a step names, found where it lives (`CrossHost.find`): an
/// encoded id on its host, a bare one on the parent's host, then on any
/// other paired host. Its client and its session there.
@MainActor
func agentSession(_ id: String, home client: EnvironmentClient, registry: ClientRegistry) -> (client: EnvironmentClient, session: SessionMeta)? {
    let hosts = registry.ordered.map(\.environment.id)
    let found = CrossHost.find(agentId: id, home: client.environment.id, hosts: hosts) { host, sessionId in
        let owner = host == client.environment.id ? client : registry.client(host)
        return owner.flatMap { owner in owner.session(sessionId).map { (owner, $0) } }
    }
    return found?.value
}

/// An agent that settled, as one step of the run (a report, or an agent a
/// wait returned on): its state's glyph, still, then Finished, Failed,
/// Needs you, Stopped or Paused and its title (`AgentTitle`). A tap opens
/// the agent's thread; the batch's own report reads "the batch" and opens
/// nothing, since it names this thread.
struct AgentStepLine: View {
    let id: String
    let status: String
    var stamped: String?
    var batch = false
    var inTable = false
    let client: EnvironmentClient
    @Environment(\.spawnedNames) private var names
    @Environment(AppModel.self) private var app

    var body: some View {
        let found = batch ? nil : agentSession(id, home: client, registry: app.registry)
        let spawn = names[id]
        let name = AgentTitle.of(batch ? nil : id, titleOf: { _ in found?.session.title }, inputTitle: spawn?.title, stamped: stamped, task: spawn?.task)
        let verb = WaitSteps.word(status)
        let line = ActionLine(verb: verb, object: batch ? "the batch" : name.title, inTable: inTable, mark: StepStateMark(state: StepStateMark.reported(status)))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(verb) \(batch ? "the batch" : name.full)")
        if let found {
            NavigationLink(value: ThreadScreenRoute(sessionId: found.session.id, environmentId: found.client.environment.id)) { line }
                .buttonStyle(.pressable)
        } else {
            line
        }
    }
}

/// One child of a spawn as one line: Spawned, its title, and where it
/// stands as a still dot at the end. A batch spawn draws one per child, as
/// an edit draws one row per file; a spawn with no call to stand on draws
/// one too. A tap opens the agent's thread.
struct SpawnChildLine: View {
    let id: String
    var name: SpawnedName?
    var inTable = false
    let client: EnvironmentClient
    @Environment(AppModel.self) private var app

    var body: some View {
        let found = agentSession(id, home: client, registry: app.registry)
        let session = found?.session
        let title = AgentTitle.of(id, titleOf: { _ in session?.title }, inputTitle: name?.title, task: name?.task)
        let line = ActionLine(glyph: ActionGlyph(look: .symbol("person.2")), verb: "Spawned", object: title.title, inTable: inTable, trailing: session.map { StepStateMark.of($0.status) })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Spawned \(title.full)")
            .accessibilityValue(session.map { StepStateMark.word(StepStateMark.of($0.status)) } ?? "")
        if let found {
            NavigationLink(value: ThreadScreenRoute(sessionId: found.session.id, environmentId: found.client.environment.id)) { line }
                .buttonStyle(.pressable)
        } else {
            line
        }
    }
}

/// Rows of one step drawn as several (a wait's agents, a batch spawn's
/// children): in a table each is a row of its own under a hairline.
struct StepRows<Item: Hashable, Row: View>: View {
    let items: [Item]
    let inTable: Bool
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element) { index, item in
                row(item)
                    .overlay(alignment: .top) {
                        if index > 0, inTable { Hairline() }
                    }
            }
        }
    }
}

// MARK: - the host's steps

/// A row the host wrote that folds into the run (`FoldedStep`): a report, a
/// spawn with no call to stand on, a finished task, a gate, a merged
/// review, the pass, the plan's hand-off, a batch merge, an away line. Each
/// reads verb then target, as a call does.
struct HostStep: View {
    let line: SystemLine
    var inTable = false
    let client: EnvironmentClient

    var body: some View {
        Group {
            switch line.kind {
            case .agentReport:
                AgentStepLine(id: line.agentId ?? "", status: line.detail ?? "done", stamped: line.text, batch: line.batch, inTable: inTable, client: client)
            case .agentSpawned:
                SpawnChildLine(id: line.agentId ?? "", inTable: inTable, client: client)
            case .backgroundTask:
                let (state, verb) = Self.task(line.detail)
                ActionLine(verb: verb, object: line.text, inTable: inTable, mark: StepStateMark(state: state))
                    .accessibilityElement(children: .combine)
            case .planHandoff:
                PlanHandoffRow(line: line, client: client, inTable: inTable)
            case .turnPass:
                NoticeLine(symbol: "arrow.trianglehead.2.clockwise", lead: "Pass", details: [line.text], inTable: inTable)
            default:
                notice
            }
        }
        .environment(\.noticeStep, true)
    }

    @ViewBuilder private var notice: some View {
        if let notice = line.notice {
            if let gate = notice.gate {
                GateStep(gate: gate, inTable: inTable)
            } else if let review = notice.review {
                ReviewStep(review: review, inTable: inTable, client: client)
            } else if notice.kind == .batch {
                BatchLine(message: notice.message, inTable: inTable)
            } else if notice.kind == .away {
                AwayLine(notice: notice, inTable: inTable)
            } else {
                NoticeLine(symbol: "info.circle", lead: notice.message, wrap: true, inTable: inTable)
            }
        } else {
            NoticeLine(symbol: "info.circle", lead: line.text, wrap: true, inTable: inTable)
        }
    }

    static func task(_ status: String?) -> (StepStateMark.State, String) {
        switch status {
        case "failed": (.failed, "Task failed")
        case "stopped": (.stopped, "Task stopped")
        default: (.done, "Task finished")
        }
    }
}

/// A gate run as a step: passed, or failed on its branch with its last
/// lines a tap away.
struct GateStep: View {
    let gate: GateNotice
    var inTable = false
    @State private var open = false
    @Environment(\.transcriptFollow) private var follow

    var body: some View {
        let lines = GateText.lineCount(gate.log)
        let opens = !gate.ok && lines > 0
        VStack(alignment: .leading, spacing: 0) {
            Button {
                TranscriptFollow.resize(follow) { open.toggle() }
            } label: {
                NoticeLine(lead: GateText.lead(gate), details: [gate.branch, GateText.tail(gate) ?? ""], inTable: inTable, chevron: opens ? open : nil) {
                    StepStateMark(state: gate.ok ? .done : .failed)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .disabled(!opens)
            .accessibilityValue(opens ? (open ? "Expanded" : "Collapsed") : "")
            if open {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(gate.log.trimmingCharacters(in: .whitespacesAndNewlines))
                        .transcriptType(TranscriptType.rowCode)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.horizontal, TranscriptMetrics.bodyInset)
                .padding(.vertical, TranscriptMetrics.bodyGap)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { if inTable { Hairline() } }
                .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
    }
}

/// A review that let the merge through, as a step: the reviewer's verdict
/// in one line, the reviewer's thread a tap away. A held review stays its
/// card (`ReviewCard`).
struct ReviewStep: View {
    let review: ReviewNotice
    var inTable = false
    let client: EnvironmentClient

    var body: some View {
        let line = NoticeLine(lead: ReviewText.lead(review, label: ModelName.short(review.model)), details: [ReviewText.detail(review, resolved: false)], inTable: inTable) {
            StepStateMark(state: review.outcome == .failed ? .failed : review.outcome == .timeout ? .stopped : .done)
        }
        if let reviewerId = review.reviewerId, client.session(reviewerId) != nil {
            NavigationLink(value: ThreadScreenRoute(sessionId: reviewerId)) { line }
                .buttonStyle(.pressable)
                .accessibilityHint("Opens the review thread")
        } else {
            line
        }
    }
}

/// What the host decided, answered or skipped while the person was away, in its words.
struct AwayLine: View {
    let notice: NoticeEvent
    var inTable = false

    var body: some View {
        let symbol: String? = switch notice.away?.kind {
        case .question?: "questionmark.circle"
        case .approval?: "lock"
        default: nil
        }
        NoticeLine(symbol: symbol, lead: notice.message, wrap: true, inTable: inTable)
    }
}

// MARK: - the compaction

/// A compaction on one notice line for its whole life, the desktop's
/// `CompactionCard`: "Compacting context" in the working text with the time
/// since it started, then "Context compacted" with the before and after
/// and its span, "Compaction failed" with the error, or "Compaction
/// stopped" with its span when its turn ended with neither. The glyph and
/// the words cross-fade in place, so the outcome never remounts the row.
struct CompactionLine: View {
    let compaction: CompactionItem

    private enum Phase: Hashable { case running, done, failed, stopped }

    private var phase: Phase {
        if compaction.stoppedTs != nil { return .stopped }
        switch compaction.phase {
        case .start: return .running
        case .failed: return .failed
        case .done, .unknown: return .done
        }
    }

    var body: some View {
        let phase = phase
        Group {
            switch phase {
            case .running:
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack(spacing: 0) {
                        StepStateMark(state: .working)
                            .padding(.trailing, TranscriptMetrics.glyphGap)
                        WorkingText(words: "Compacting context")
                        Text(TimeFormat.duration(ms: max(0, Int(context.date.timeIntervalSince1970 * 1_000) - compaction.ts)))
                            .transcriptType(TranscriptType.line)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .padding(.leading, TranscriptMetrics.wordGap)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: TranscriptMetrics.line)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Compacting context")
                .accessibilityAddTraits(.updatesFrequently)
            case .done:
                NoticeLine(symbol: "arrow.down.right.and.arrow.up.left", lead: "Context compacted", details: figures)
            case .failed:
                NoticeLine(lead: "Compaction failed", details: [compaction.error ?? ""], tone: .strong, wrap: true) {
                    StepStateMark(state: .failed)
                }
            case .stopped:
                NoticeLine(lead: "Compaction stopped", details: compaction.stoppedTs.map { [TimeFormat.duration(ms: max(0, $0 - compaction.ts))] } ?? []) {
                    StepStateMark(state: .stopped)
                }
            }
        }
        .id(phase)
        .transition(.opacity)
        .animation(Motion.crossFade, value: phase)
    }

    /// "412k → 36k", "3s": the before and after, then the span.
    private var figures: [String] {
        var out: [String] = []
        if let pre = compaction.preTokens, let post = compaction.postTokens {
            out.append("\(Formatting.tokens(pre)) → \(Formatting.tokens(post))")
        } else if let post = compaction.postTokens {
            out.append("now \(Formatting.tokens(post))")
        }
        if let ms = compaction.durationMs { out.append(TimeFormat.duration(ms: Int(ms))) }
        return out
    }
}
