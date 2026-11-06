import SwiftUI
import TempCodeClient
import TempCodeContract

/// Everything the agent did between two paragraphs, the desktop's
/// `ActionGroup`. One step is its own row at the prose's edge. More is one
/// muted 28 pt line (the main kind's glyph, the phrase, the counts, the
/// chevron) that opens onto a table: one hairline frame at radius 12 from
/// the prose's edge across the column, no fill, a 32 pt row per step with a
/// hairline between two. A lone step and a group are one tree, so the
/// second call landing remounts nothing: its row glides 12 pt to the
/// table's inset on the layout spring while the frame fades in.
///
/// While the turn works in it the group opens on its own at two steps and
/// shows its newest five rows (the line still naming them all); a step
/// landing fades in and rises 4 pt, the oldest leaves upward. When the work
/// moves on it waits `GroupFold.hold` and folds; with the reader scrolled
/// up it waits until they are back at the bottom, so a fold never moves
/// what they read, and a work that comes back cancels the wait. A person's
/// tap on the line, or opening a row's body, decides it from then on (kept
/// by the group's key in `ThreadCaches.hands`, so it outlives the row), and
/// a group opened by hand shows every row and its thoughts. Mounted working
/// it shows open, mounted settled closed, neither animated. Reduced motion
/// fades the frame over `fast` and moves nothing.
struct ActionGroup: View {
    let group: ActivityGroup
    let client: EnvironmentClient
    let sessionId: String
    /// The view opened it (a search landing inside it, the proof's `group` hook).
    var forceOpen = false
    @Environment(\.transcriptCwd) private var cwd
    @Environment(TranscriptScrollState.self) private var scroll: TranscriptScrollState?
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.displayScale) private var scale
    @State private var fold: GroupFold
    /// The hold ran its time with the reader scrolled up: the fold waits for the bottom.
    @State private var awaitingBottom = false
    /// The person's choices on this thread's groups (plain storage, outside the row).
    private let hands: GroupHands
    /// Rows a person has seen: shown at mount, or when a hand opened the group. Any other row rises in.
    @State private var seen: Set<Int>

    init(group: ActivityGroup, client: EnvironmentClient, sessionId: String, forceOpen: Bool = false) {
        self.group = group
        self.client = client
        self.sessionId = sessionId
        self.forceOpen = forceOpen
        // The proof's `chip` hook opens a call's omitted body: its group opens with it.
        let opened = forceOpen || (TestHooks.open == "chip" && group.tools.contains { $0.output.isOmitted })
        hands = ThreadCaches.hands(client: client, sessionId: sessionId)
        _fold = State(initialValue: GroupFold(working: group.working, hand: opened ? true : hands.choice(group.key)))
        _seen = State(initialValue: Set(group.shown(byHand: opened).map(\.key)))
    }

    private static var now: Double { Date().timeIntervalSinceReferenceDate }

    var body: some View {
        let lone = group.lone
        let open = fold.isOpen(lone: lone)
        let rows = Array(fold.visible(group.shown(byHand: fold.hand == true), lone: lone))
        VStack(alignment: .leading, spacing: 0) {
            if !lone {
                line(open: open)
            }
            if open, !rows.isEmpty {
                table(rows, lone: lone)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
        .environment(\.spawnedNames, FoldedStep.spawnedNames(group.entries))
        .onChange(of: group.working) { _, working in
            fold.set(working: working, at: Self.now)
            if working { awaitingBottom = false }
        }
        // One wait per hold: work coming back (a new hold, or none) cancels it.
        .task(id: fold.holding ? fold.heldUntil : nil) {
            guard fold.holding, let until = fold.heldUntil else { return }
            try? await Task.sleep(for: .seconds(max(0, until - Self.now)))
            guard !Task.isCancelled else { return }
            letGo()
        }
        // Read only while a fold waits on the reader: no other group follows the bottom.
        .onChange(of: awaitingBottom ? scroll?.atBottom : nil) { _, atBottom in
            if atBottom == true { letGo() }
        }
        .onChange(of: forceOpen) { _, now in
            guard now, fold.hand != true else { return }
            // The view's own opening (a landing): not a choice the person made, so not kept.
            Motion.withoutAnimation {
                fold.choose(open: true)
                seen.formUnion(group.entries.map(\.key))
            }
        }
    }

    /// The group line: the work it did most, its phrase, its counts, the chevron.
    private func line(open: Bool) -> some View {
        let phrase = group.phrase(cwd: cwd) { client.session($0)?.title }
        return Button {
            withAnimation(open ? Motion.collapse : Motion.expand) { take(open: !open) }
        } label: {
            ActionLine(glyph: ActionGlyph(look: .symbol(group.kind.symbol)), verb: phrase, adds: self.group.adds, dels: self.group.dels, failed: self.group.failed, chevron: open)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(phrase)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
    }

    /// The hold has run its time: the group folds now if the reader is at
    /// the bottom (on the collapse; nothing above them moves while they are
    /// up), else once they are back.
    private func letGo() {
        guard fold.holding else { awaitingBottom = false; return }
        guard scroll?.atBottom != false else { awaitingBottom = true; return }
        awaitingBottom = false
        withAnimation(reduced ? nil : Motion.collapse) { _ = fold.release(at: Self.now) }
    }

    /// A person's hand: their choice holds from now on, outlives the row,
    /// and every row they open onto is seen.
    private func take(open: Bool) {
        fold.choose(open: open)
        hands.set(group.key, open: open)
        awaitingBottom = false
        if open { seen.formUnion(group.entries.map(\.key)) }
    }

    private func table(_ rows: [ThreadEntry], lone: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.key) { index, entry in
                ActionStep(entry: entry, inTable: !lone, settled: group.settled, client: client, sessionId: sessionId) {
                    fold.decide()
                    if let hand = fold.hand { hands.set(group.key, open: hand) }
                    awaitingBottom = false
                    seen.formUnion(group.entries.map(\.key))
                }
                .overlay(alignment: .top) {
                    if index > 0, !lone { Hairline() }
                }
                .modifier(StepLanding(lands: !seen.contains(entry.key), reduced: reduced))
                .transition(lone || reduced ? .identity : .asymmetric(insertion: .identity, removal: .opacity.combined(with: .move(edge: .top))))
            }
        }
        .animation(reduced ? nil : Motion.base, value: rows.map(\.key))
        .clipShape(.corner(lone ? 0 : TranscriptMetrics.tableRadius))
        .overlay {
            RoundedRectangle.corner(TranscriptMetrics.tableRadius)
                .strokeBorder(Surface.hairline, lineWidth: Hairline.thickness(scale: scale))
                .opacity(lone ? 0 : 1)
                .animation(reduced ? Motion.fast : Motion.base, value: lone)
                .allowsHitTesting(false)
        }
    }
}

/// A step landing in an open table fades in and rises `Motion.travel` over
/// `base`; under reduced motion it fades over `fast`. A row seen before stands.
private struct StepLanding: ViewModifier {
    let lands: Bool
    let reduced: Bool
    @State private var landed = false

    func body(content: Content) -> some View {
        let hidden = lands && !landed
        content
            .opacity(hidden ? 0 : 1)
            .offset(y: hidden && !reduced ? Motion.travel : 0)
            .onAppear {
                guard lands, !landed else { return }
                withAnimation(reduced ? Motion.fast : Motion.base) { landed = true }
            }
    }
}

/// One step of a group, or a lone one: a call's line and the body it opens
/// onto, a thought as "Thought" (no duration) opening onto its words. In a
/// table the body is the row's lower part under one hairline, 12 pt in, 8 pt
/// above and below; alone it is a card (radius 8, the chrome fill, 12 pt
/// in). An edit's caret pushes the diff screen instead.
struct ActionStep: View {
    let entry: ThreadEntry
    var inTable = false
    /// The turn is over: a call still marked running draws settled.
    var settled = true
    let client: EnvironmentClient
    let sessionId: String
    /// The person opened a body: the group is theirs from now on.
    var onHand: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduced

    var body: some View {
        Group {
            switch entry.item {
            case .thinking(let block):
                ThoughtStep(block: block, inTable: inTable, onHand: onHand)
            case .tool(let tool) where WaitSteps.isWait(tool):
                // A wait is no row of its own: each agent it returned on is a step.
                StepRows(items: WaitSteps.outcomes(tool), inTable: inTable) { outcome in
                    AgentStepLine(id: outcome.id, status: outcome.status, inTable: inTable, client: client)
                }
            case .tool(let tool) where FoldedStep.isBatchSpawn(tool) && !tool.spawned.isEmpty:
                // A batch spawn is one row per child once the host stamped them, as an edit is one row per file.
                StepRows(items: FoldedStep.spawnedNames(tool).map(\.id), inTable: inTable) { id in
                    SpawnChildLine(id: id, name: FoldedStep.spawnedNames(tool).first { $0.id == id }?.name, inTable: inTable, client: client)
                }
            case .tool(let tool):
                ToolStep(tool: tool, inTable: inTable, settled: settled, client: client, sessionId: sessionId, onHand: onHand)
            case .system(let line):
                HostStep(line: line, inTable: inTable, client: client)
            default:
                EmptyView()
            }
        }
        // A lone call becoming a table glides to the inset on the layout spring.
        .animation(reduced ? nil : Motion.layout, value: inTable)
    }
}

/// A call's line and its body.
private struct ToolStep: View {
    let tool: ToolItem
    let inTable: Bool
    let settled: Bool
    let client: EnvironmentClient
    let sessionId: String
    let onHand: () -> Void
    @Environment(\.transcriptCwd) private var cwd
    @State private var open: Bool
    @State private var whole: EventRow?
    @State private var loading = false

    init(tool: ToolItem, inTable: Bool, settled: Bool, client: EnvironmentClient, sessionId: String, onHand: @escaping () -> Void) {
        self.tool = tool
        self.inTable = inTable
        self.settled = settled
        self.client = client
        self.sessionId = sessionId
        self.onHand = onHand
        _open = State(initialValue: TestHooks.open == "chip" && tool.output.isOmitted)
    }

    /// Running only while its turn is open: a Stop leaves the call settled.
    private var action: ActionRow {
        var row = ActionRow.of(tool, cwd: cwd, live: settled ? false : nil)
        if settled { row.running = false }
        return row
    }

    var body: some View {
        let row = action
        VStack(alignment: .leading, spacing: 0) {
            if row.opens == .diff, let path = Board.editPath(tool) {
                NavigationLink(value: DiffRoute(sessionId: sessionId, card: Board.wholeChange(path: path, edits: [tool]))) {
                    lineView(row, chevron: false)
                }
                .buttonStyle(.pressable)
            } else {
                Button {
                    if !open { onHand() }
                    withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
                } label: {
                    lineView(row, chevron: open)
                }
                .buttonStyle(.pressable)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                if open {
                    StepBody(tool: tool, whole: whole, loading: loading, command: row.opens == .command)
                        .modifier(BodyFrame(inTable: inTable))
                        .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                }
            }
        }
        .task(id: open) {
            guard open, whole == nil, case .omitted(_, let seq) = tool.output else { return }
            loading = true
            whole = await client.body(sessionId: sessionId, seq: seq)
            loading = false
        }
    }

    /// The one child a spawn made, where it stands: a still mark after the words.
    private var child: StepStateMark.State? {
        guard tool.spawned.count == 1, !FoldedStep.isBatchSpawn(tool) else { return nil }
        let id = tool.spawned[0]
        return (client.session(WatchWords.bareAgentId(id)) ?? client.session(id)).map { StepStateMark.of($0.status) }
    }

    private func lineView(_ row: ActionRow, chevron: Bool) -> some View {
        ActionLine(glyph: ActionGlyph(look: row.look), verb: row.verb, object: row.object, isFile: row.isFile, tally: row.tally, adds: row.adds ?? 0, dels: row.dels ?? 0, chevron: chevron, inTable: inTable, trailing: child)
            .accessibilityElement(children: .combine)
            .accessibilityLabel([row.verb, row.object].filter { !$0.isEmpty }.joined(separator: " "))
    }
}

/// A settled thought in a group a person opened: "Thought", no duration;
/// a tap opens its words in place.
private struct ThoughtStep: View {
    let block: TextBlock
    let inTable: Bool
    let onHand: () -> Void
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if !open { onHand() }
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                ActionLine(glyph: ActionGlyph(look: .symbol(ActivityGroup.Kind.think.symbol)), verb: "Thought", chevron: open, inTable: inTable)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(open ? "Hide thought" : "Thought")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                MarkdownView(seq: block.seq, text: block.text, dim: true)
                    .textSelection(.enabled)
                    .modifier(BodyFrame(inTable: inTable))
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
    }
}

/// Where an open body sits: under one hairline in a table, else a card.
private struct BodyFrame: ViewModifier {
    let inTable: Bool

    func body(content: Content) -> some View {
        if inTable {
            content
                .padding(.horizontal, TranscriptMetrics.bodyInset)
                .padding(.vertical, TranscriptMetrics.bodyGap)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Hairline() }
        } else {
            content
                .padding(TranscriptMetrics.bodyInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.chrome, in: .corner(TranscriptMetrics.bodyRadius))
                .padding(.bottom, TranscriptMetrics.wordGap)
        }
    }
}

/// A call's body, the desktop's `ToolDetails`: a command as itself in mono
/// over its whole output; any other call's input as key and value lines
/// over its output. The output sits in a box capped at
/// `TranscriptMetrics.outputCap` that scrolls inside itself; Copy is in its
/// menu. Failed output reads destructive; a connector whose grant lapsed
/// says so.
private struct StepBody: View {
    let tool: ToolItem
    let whole: EventRow?
    let loading: Bool
    let command: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.bodyGap) {
            if let input = inputText {
                Text(input)
                    .transcriptType(TranscriptType.rowCode)
                    .foregroundStyle(command ? .primary : .secondary)
                    .textSelection(.enabled)
                    .lineLimit(command ? nil : 12)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch output {
            case .whole(let text):
                if !text.isEmpty {
                    OutputBox(text: text, failed: tool.status == .failed)
                } else if tool.status != .running {
                    noOutput
                }
            case .omitted(let omitted, _):
                if loading || whole == nil {
                    Shimmer(height: min(CGFloat(omitted.lines) * TranscriptMetrics.line, TranscriptMetrics.outputCap))
                }
            case .none:
                if tool.status != .running { noOutput }
            }
            if let reauth = tool.reauth {
                Label("Reconnect \(reauth.app)", systemImage: "arrow.clockwise")
                    .transcriptType(TranscriptType.line, weight: .medium)
                    .foregroundStyle(Tint.warning)
            }
        }
    }

    private var noOutput: some View {
        Text("No output")
            .transcriptType(TranscriptType.line)
            .foregroundStyle(.tertiary)
    }

    /// The row the host sent whole, once fetched, else what the fold has.
    private var output: BodyState {
        if let whole, case .toolResult(let result) = whole.event, case .string(let text) = result.output { return .whole(text) }
        return tool.output
    }

    /// What was asked: the command bare, else the input's fields as key and value lines; never raw JSON.
    private var inputText: String? {
        guard let input = tool.input else { return nil }
        guard case .object(let fields) = input else { return input.stringValue ?? Formatting.pretty(input) }
        if let command = fields["command"]?.stringValue { return ToolPhrase.bareCommand(command) }
        if let parts = fields["command"]?.arrayValue { return ToolPhrase.bareCommand(parts.compactMap(\.stringValue).joined(separator: " ")) }
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

/// A call's whole output in mono, in a box no taller than the cap that
/// scrolls inside itself.
private struct OutputBox: View {
    let text: String
    let failed: Bool
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView(.vertical) {
            Text(text)
                .transcriptType(TranscriptType.rowCode)
                .foregroundStyle(failed ? Tint.destructive : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(TranscriptMetrics.bodyGap)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .frame(height: min(height, TranscriptMetrics.outputCap))
        .scrollBounceBehavior(.basedOnSize)
        .hairlineBorder(RoundedRectangle.corner(TranscriptMetrics.bodyRadius))
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
    }
}

extension EnvironmentValues {
    /// The thread's working directory: a group's line and its rows read paths relative to it.
    @Entry var transcriptCwd: String? = nil
}
