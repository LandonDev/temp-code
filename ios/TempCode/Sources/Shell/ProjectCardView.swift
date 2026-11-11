import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project on its workspace's screen, the desktop's project card
/// (`ProjectCardView` in chrome/WorkspaceSessions.tsx): one container on the
/// group fill, the name and its last-active time with the project's menu,
/// the branch line, then the read-only lines of `ProjectCards.card` and the
/// quiet count line. A line opens its thread; anywhere else opens the
/// project. A long press holds the same menu as the ellipsis. The fill
/// steps at once on a press and never animates; nothing in it enters.
struct ProjectCardView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let card: ProjectCard
    var selected = false
    /// Needs-you cues by `ShellCues.key`, read for the needs-you and failed lines.
    var cues: [String: HomeModel.Cue] = [:]
    let slots: HomeSlots
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void
    @ScaledMetric(relativeTo: .caption) private var branchGap = CardMetrics.branchGap
    @ScaledMetric(relativeTo: .caption) private var linesGap = CardMetrics.linesGap

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            branchLine
                .padding(.top, branchGap)
                .allowsHitTesting(false)
            if !card.lines.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(card.lines) { line in
                        CardLineView(line: line, cue: cue(line))
                    }
                }
                .padding(.top, linesGap)
            }
            if card.hidden > 0 {
                // Past one page the project's strip holds the rest.
                CardQuietLine(text: "\(card.hidden) more")
                    .allowsHitTesting(false)
            }
            if !card.counts.isEmpty {
                CardCountLine(counts: card.counts)
                    .padding(.top, card.lines.isEmpty ? linesGap : linesGap / 2)
                    .allowsHitTesting(false)
            }
        }
        .padding(CardMetrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            Button { navigator.openProject(card.id) } label: { Color.clear }
                .buttonStyle(CardFillStyle(selected: selected))
                .accessibilityLabel(card.accessibilityLabel)
                .accessibilityHint("Opens the project")
        }
        .contentShape(.contextMenuPreview, RoundedRectangle.rowCorner)
        .contextMenu { ProjectMenuContent(project: card.project, slots: slots, newThread: newThread) }
        .task(id: card.id) {
            // The menu's Project Plan row reads the plan's state; ask once per project.
            guard slots.projectPlan != nil, let client = model.registry.client(card.project.environmentId) else { return }
            await ThreadCaches.projectPlans.load(client, projectId: card.project.project.id)
        }
        .accessibilityElement(children: .contain)
    }

    private var head: some View {
        HStack(spacing: CardMetrics.glyphGap) {
            Text(card.name)
                .transcriptType(TranscriptType.line, weight: .medium)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
                .allowsHitTesting(false)
            if card.latest > 0 {
                CardAgo(ms: card.latest)
                    .allowsHitTesting(false)
            }
            Menu {
                ProjectMenuContent(project: card.project, slots: slots, newThread: newThread)
            } label: {
                Image(systemName: "ellipsis")
                    .transcriptFont(TranscriptType.line, weight: .semibold)
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle().inset(by: -CardMetrics.menuSlop))
            }
            .buttonStyle(.pressableStatic)
            .accessibilityLabel("\(card.name) menu")
        }
        .frame(minHeight: CardMetrics.nameLine)
    }

    private var branchLine: some View {
        HStack(spacing: CardMetrics.glyphGap) {
            HStack(spacing: CardMetrics.gap) {
                Image(systemName: "arrow.triangle.branch")
                    .transcriptFont(TranscriptType.detail)
                    .accessibilityHidden(true)
                Text(card.branch)
                    .transcriptType(TranscriptType.detail)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Text(card.mode)
                .transcriptType(TranscriptType.detail)
                .fixedSize()
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private func cue(_ line: ProjectCardLine) -> HomeModel.Cue? {
        switch line {
        case .needsYou(let t), .failed(let t): cues[ShellCues.key(t.environmentId, t.meta.id)]
        default: nil
        }
    }
}

/// The card's fill: the group step at rest, a step further while pressed,
/// the selected step while its project holds the thread beside it.
private struct CardFillStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        let fill = configuration.isPressed ? Surface.groupPressed : selected ? Surface.groupSelected : Surface.group
        RoundedRectangle.rowCorner
            .fill(fill)
            .contentShape(RoundedRectangle.rowCorner)
            .hoverEffectDisabled()
    }
}

/// One line of the card: a needs-you or failed root with its detail under
/// it, a master's block, or a working, paused or unread root. A line opens
/// its thread (on the card for a needs-you line); its words dim on a press.
private struct CardLineView: View {
    @Environment(ShellNavigator.self) private var navigator
    let line: ProjectCardLine
    let cue: HomeModel.Cue?

    var body: some View {
        switch line {
        case .needsYou(let t):
            open(t, seq: cue?.seq) {
                CardThreadLine(thread: t, mark: .waiting)
                CardSubline(text: ProjectCards.subline(cue: cue, thread: t), tint: Tint.warningText)
            }
        case .failed(let t):
            open(t, seq: cue?.seq) {
                CardThreadLine(thread: t, mark: .failed)
                CardSubline(text: ProjectCards.subline(cue: cue, thread: t), tint: Tint.destructiveText)
            }
        case .working(let t):
            open(t) {
                CardThreadLine(thread: t, mark: t.state) { CardElapsed(since: t.busySince) }
                if let tasks = t.tasks { CardTaskLine(tasks: tasks) }
            }
        case .paused(let t):
            open(t) {
                CardThreadLine(thread: t, mark: .paused) {
                    HStack(spacing: CardMetrics.glyphGap) {
                        Text("Paused")
                        Text(TimeFormat.duration(ms: t.pausedElapsed)).monospacedDigit()
                    }
                    .transcriptType(TranscriptType.detail)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                }
                if let tasks = t.tasks { CardTaskLine(tasks: tasks) }
            }
        case .unread(let t):
            open(t) { CardThreadLine(thread: t, mark: nil, unread: true) }
        case .master(let block):
            CardMasterBlock(block: block, open: { thread in open(thread) })
        }
    }

    private func open(_ thread: CardThread, seq: Int? = nil) {
        navigator.open(.thread(environmentId: thread.environmentId, sessionId: thread.meta.id, seq: seq))
    }

    private func open(_ thread: CardThread, seq: Int? = nil, @ViewBuilder label: () -> some View) -> some View {
        Button { open(thread, seq: seq) } label: {
            VStack(alignment: .leading, spacing: 0) { label() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressableStatic)
    }
}

/// A master and its batch: its line with the done tally (its mark the
/// block's lead, the one moving mark), its own working subagents, each batch
/// thread with something to say one step in (working as a still dot), and
/// the queued ones as one count. Each thread's line opens it.
private struct CardMasterBlock: View {
    let block: MasterCardBlock
    let open: (CardThread) -> Void
    @ScaledMetric(relativeTo: .caption) private var gap = CardMetrics.glyphGap

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open(block.master) } label: {
                VStack(alignment: .leading, spacing: 0) {
                    CardThreadLine(
                        thread: block.master,
                        mark: block.unread && !block.lead.marksAtRest ? nil : block.lead,
                        unread: block.unread
                    ) {
                        CardTally(done: block.done, total: block.total)
                    }
                    if let agents = block.agents { CardAgentsLine(summary: agents) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressableStatic)
            ForEach(block.lines) { batch in
                Button { open(batch.thread) } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        CardThreadLine(thread: batch.thread, mark: batch.thread.state, still: true) {
                            if batch.thread.state == .working {
                                if let tasks = batch.thread.tasks {
                                    CardTally(done: tasks.done, total: tasks.total)
                                } else {
                                    CardElapsed(since: batch.thread.busySince)
                                }
                            }
                        }
                        if let agents = batch.agents { CardAgentsLine(summary: agents) }
                    }
                    .padding(.leading, CardMetrics.step)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressableStatic)
            }
            if block.queued > 0 {
                HStack(spacing: gap) {
                    CardMark(state: .queued)
                    Text("\(block.queued) queued")
                        .transcriptType(TranscriptType.detail)
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, CardMetrics.step)
                .frame(minHeight: CardMetrics.line)
                .allowsHitTesting(false)
            }
        }
    }
}

/// A line's first row: the mark, the type's tinted glyph, the title (medium
/// and primary while unread, else secondary), the host glyph with two or
/// more hosts, then what the state puts at the end.
private struct CardThreadLine<Trailing: View>: View {
    let thread: CardThread
    let mark: CardState?
    var still = false
    var unread = false
    @ViewBuilder var trailing: () -> Trailing
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.line
    /// Scaled with the mark and glyph columns, so the title sits on `CardMetrics.textEdge` at every size.
    @ScaledMetric(relativeTo: .caption) private var gap = CardMetrics.glyphGap

    var body: some View {
        HStack(spacing: gap) {
            CardMark(state: mark, still: still)
            CardTypeGlyph(type: thread.meta.threadType)
            Text(thread.title)
                .transcriptType(TranscriptType.detail, weight: unread ? .medium : .regular)
                .foregroundStyle(unread ? .primary : .secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            HostGlyph(environmentId: thread.environmentId)
            trailing()
        }
        .frame(minHeight: height)
        .accessibilityElement(children: .combine)
    }
}

extension CardThreadLine where Trailing == EmptyView {
    init(thread: CardThread, mark: CardState?, still: Bool = false, unread: Bool = false) {
        self.init(thread: thread, mark: mark, still: still, unread: unread) { EmptyView() }
    }
}

/// The card's status mark in a 12 pt column: the phone's vocabulary
/// (`StatusDot`) at the card's size. `still` draws working as a dot, for a
/// line under its master's, so a block has one moving mark.
struct CardMark: View {
    let state: CardState?
    var still = false
    @ScaledMetric private var column: CGFloat
    @ScaledMetric private var dot: CGFloat
    private let type: TypeSpec

    /// `column` and `dot` at the default text size, scaled with `type`: the
    /// card's 12 pt column, or a strip chip's 14 pt slot.
    init(state: CardState?, still: Bool = false, column: CGFloat = CardMetrics.mark, dot: CGFloat = CardMetrics.dot, type: TypeSpec = TranscriptType.detail) {
        self.state = state
        self.still = still
        self.type = type
        _column = ScaledMetric(wrappedValue: column, relativeTo: type.style.textStyle)
        _dot = ScaledMetric(wrappedValue: dot, relativeTo: type.style.textStyle)
    }

    var body: some View {
        ZStack {
            switch state {
            case .working?:
                if still {
                    Circle().fill(.secondary).frame(width: dot, height: dot)
                } else {
                    ProgressView().controlSize(.mini)
                }
            case .watching?: Circle().fill(Tint.info).frame(width: dot, height: dot)
            case .waiting?: Circle().fill(Tint.warning).frame(width: dot, height: dot)
            case .failed?: Circle().fill(Tint.destructive).frame(width: dot, height: dot)
            case .queued?: Circle().fill(Tint.quiet).frame(width: dot, height: dot)
            case .planReady?: Circle().fill(Tint.violet).frame(width: dot, height: dot)
            case .paused?:
                Image(systemName: "pause.fill")
                    .transcriptFont(type)
                    .imageScale(.small)
                    .foregroundStyle(Tint.warning)
            case .stopped?:
                RoundedRectangle.corner(Radius.mark).fill(Tint.quiet).frame(width: dot, height: dot)
            case .idle?, .done?, nil:
                EmptyView()
            }
        }
        .frame(width: column, height: column)
        .accessibilityHidden(label.isEmpty)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch state {
        case .working?: "Working"
        case .watching?: "Watching"
        case .waiting?: "Needs you"
        case .failed?: "Failed"
        case .queued?: "Queued"
        case .planReady?: "Plan ready"
        case .paused?: "Paused"
        case .stopped?: "Stopped"
        case .idle?, .done?, nil: ""
        }
    }
}

/// A thread's type at the card's size, tinted, in the mark's width.
private struct CardTypeGlyph: View {
    let type: ThreadType?
    @ScaledMetric(relativeTo: .caption) private var column = CardMetrics.mark

    var body: some View {
        let type = type ?? .chat
        Image(systemName: type.symbol)
            .transcriptFont(TranscriptType.detail)
            .imageScale(.small)
            .foregroundStyle(type.tint)
            .frame(width: column)
            .accessibilityLabel(type.label)
    }
}

/// A line under a line, at the title's column: 12 on 16.
private struct CardSubline: View {
    let text: String
    var tint: Color?
    @ScaledMetric(relativeTo: .caption) private var edge = CardMetrics.textEdge
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.subline

    var body: some View {
        Text(text)
            .transcriptType(TranscriptType.detail)
            .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.secondary))
            .lineLimit(1)
            .padding(.leading, edge)
            .frame(minHeight: height, alignment: .leading)
    }
}

/// An implementation's tally and current task, under its title.
private struct CardTaskLine: View {
    let tasks: SessionMeta.Tasks
    @ScaledMetric(relativeTo: .caption) private var edge = CardMetrics.textEdge
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.subline

    var body: some View {
        HStack(spacing: CardMetrics.glyphGap) {
            CardTally(done: tasks.done, total: tasks.total)
            if let current = tasks.current, !current.isEmpty {
                Text(current)
                    .transcriptType(TranscriptType.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.leading, edge)
        .frame(minHeight: height, alignment: .leading)
    }
}

/// Subagents in the fleet's words, set apart by space, needs you and failed in their tone.
private struct CardAgentsLine: View {
    let summary: AgentSummary
    @ScaledMetric(relativeTo: .caption) private var edge = CardMetrics.textEdge
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.subline

    var body: some View {
        HStack(spacing: CardMetrics.glyphGap) {
            ForEach(summary.parts, id: \.text) { part in
                Text(part.text)
                    .transcriptType(TranscriptType.detail)
                    .foregroundStyle(tone(part.tone))
                    .lineLimit(1)
            }
        }
        .padding(.leading, edge)
        .frame(minHeight: height, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func tone(_ tone: AgentSummary.Tone) -> AnyShapeStyle {
        switch tone {
        case .plain: AnyShapeStyle(.secondary)
        case .waiting: AnyShapeStyle(Tint.warningText)
        case .failed: AnyShapeStyle(Tint.destructiveText)
        }
    }
}

/// "3/7", green once every one is done.
private struct CardTally: View {
    let done: Int
    let total: Int

    var body: some View {
        Text("\(done)/\(total)")
            .transcriptType(TranscriptType.detail)
            .monospacedDigit()
            .foregroundStyle(done == total ? AnyShapeStyle(Tint.success) : AnyShapeStyle(.secondary))
            .fixedSize()
            .accessibilityLabel("\(done) of \(total) done")
    }
}

/// A working line's elapsed, from three seconds in, ticking each second.
private struct CardElapsed: View {
    let since: Int

    var body: some View {
        Tick(every: 1) { tick in
            let now = Int(tick.timeIntervalSince1970 * 1_000)
            if ProjectCards.showsElapsed(since: since, now: now) {
                let text = TimeFormat.duration(ms: now - since)
                Text(text)
                    .transcriptType(TranscriptType.detail)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .numeric(text)
                    .fixedSize()
            }
        }
    }
}

/// The card's last-active time, 12 tabular, refreshed every 30 s.
private struct CardAgo: View {
    let ms: Int

    var body: some View {
        Tick(every: 30) { tick in
            let text = TimeFormat.ago(ms, now: tick)
            Text(text)
                .transcriptType(TranscriptType.detail)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }
}

/// "N more" past the card's one page.
private struct CardQuietLine: View {
    let text: String
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.line

    var body: some View {
        Text(text)
            .transcriptType(TranscriptType.detail)
            .foregroundStyle(.secondary)
            .frame(minHeight: height, alignment: .leading)
    }
}

/// What has no line: "2 dormant", "5 archived", or "No threads", set apart by space.
private struct CardCountLine: View {
    let counts: [ProjectCardCount]
    @ScaledMetric(relativeTo: .caption) private var height = CardMetrics.subline

    var body: some View {
        HStack(spacing: CardMetrics.glyphGap) {
            ForEach(counts, id: \.text) { count in
                Text(count.text)
                    .transcriptType(TranscriptType.detail)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(minHeight: height, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
