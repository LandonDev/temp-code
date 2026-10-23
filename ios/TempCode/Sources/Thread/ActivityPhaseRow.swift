import SwiftUI
import TempCodeClient
import TempCodeContract

/// One phase of the agent's work, the desktop's `ActivityPhaseGroup` (zen,
/// its default): the kind's glyph and one human line, "Read 3 files in
/// src/lib and searched for tokens", with the steps under it on a rail. The
/// line shimmers in the present tense while the agent is in the phase; the
/// phase opens by itself on its second step and keeps a short window pinned
/// to its newest step, then folds back to its line when the agent moves on,
/// unless the person opened it by hand. That settle-close animates only
/// while the reader is at the bottom; anywhere else it closes without
/// animation so nothing above the reader moves. A closed phase still shows
/// the edits it made. A lone step is not a group: the glyph and the step,
/// no header repeating it. The transcript opens a phase itself for a search
/// landing inside it (`forceOpen`) and for the proof's `group` hook.
struct ActivityPhaseRow: View {
    let group: ActivityGroup
    let client: EnvironmentClient
    let sessionId: String
    var forceOpen = false
    @State private var open: Bool
    /// The person toggled it: the live rule no longer decides.
    @State private var byHand = false
    @Environment(TranscriptScrollState.self) private var scroll: TranscriptScrollState?
    @Environment(\.transcriptCwd) private var cwd

    /// The live window: the newest steps that fit the desktop's 280 pt pane.
    private static let windowHeight: CGFloat = 280
    private static let windowSteps = 9

    init(group: ActivityGroup, client: EnvironmentClient, sessionId: String, forceOpen: Bool = false) {
        self.group = group
        self.client = client
        self.sessionId = sessionId
        self.forceOpen = forceOpen
        _open = State(initialValue: forceOpen || group.live)
    }

    var body: some View {
        if group.isSingle, let only = group.entries.first {
            HStack(alignment: .top, spacing: 0) {
                PhaseGlyph(kind: group.kind)
                ActivityStep(entry: only, client: client, sessionId: sessionId, live: group.live)
            }
        } else {
            phase
        }
    }

    private var title: String { group.title(cwd: cwd) }

    private var phase: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                byHand = true
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: 0) {
                    PhaseGlyph(kind: group.kind)
                    Group {
                        if group.live {
                            ShimmerText(text: title)
                        } else {
                            // Dimmed: the work is chrome around the answer.
                            Text(title).foregroundStyle(.secondary)
                        }
                    }
                    .font(.subheadline)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: ActivityStep.lineHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(title)
            .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                steps
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .identity))
            } else if !group.edits.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(group.edits, id: \.seq) { tool in
                        PhaseEdit(tool: tool, sessionId: sessionId)
                    }
                }
                .padding(.leading, ActivityStep.indent)
                .padding(.bottom, 4)
            }
        }
        .onChange(of: group.live) { _, live in
            guard !byHand else { return }
            if live {
                Motion.withoutAnimation { open = true }
            } else if open {
                // Read once, here: the flag is not a dependency of the body.
                withAnimation(scroll?.atBottom == true ? Motion.collapse : nil) { open = false }
            }
        }
        .onChange(of: forceOpen) { _, now in
            if now, !open { Motion.withoutAnimation { open = true } }
        }
    }

    /// The steps on the rail. While live, only the newest that fit the
    /// window, bottom-aligned and clipped, so the newest step holds the line
    /// the way the desktop's pinned pane does; settled, every step.
    @ViewBuilder private var steps: some View {
        let shown = group.live ? Array(group.entries.suffix(Self.windowSteps)) : group.entries
        let clipped = group.live && group.entries.count > Self.windowSteps
        let list = VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, entry in
                ActivityStep(entry: entry, client: client, sessionId: sessionId, live: group.live)
                    .padding(.leading, ActivityStep.indent)
                    .background(alignment: .topLeading) {
                        PhaseRail(last: index == shown.count - 1)
                            .stroke(PhaseRail.color, lineWidth: 1)
                            .accessibilityHidden(true)
                    }
                    // A live step fades in where it lands; a slide would fight the pinned window.
                    .transition(.asymmetric(insertion: group.live ? .opacity.animation(Motion.stepIn) : .identity, removal: .identity))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        if group.live {
            list
                .frame(maxHeight: Self.windowHeight, alignment: .bottom)
                .clipped()
                .mask {
                    // Older steps leave the window under a short fade, never a hard cut.
                    LinearGradient(stops: [.init(color: .black.opacity(clipped ? 0 : 1), location: 0), .init(color: .black, location: clipped ? 0.12 : 0)], startPoint: .top, endPoint: .bottom)
                }
        } else {
            list
        }
    }
}

/// One step of a phase, the desktop's `ActivityRow` in its railed form: a
/// thought as its first line, a tool call as its chip without the glyph
/// (the rail is the bullet), an edit as its card.
struct ActivityStep: View {
    let entry: ThreadEntry
    let client: EnvironmentClient
    let sessionId: String
    var live = false

    /// A step's first line: the rail's branch meets its middle.
    static let lineHeight: CGFloat = 32
    /// Where a step starts: past the 8 pt row inset and the 18 pt glyph column.
    static let indent: CGFloat = 26

    var body: some View {
        switch entry.item {
        case .thinking(let block):
            ThinkingStep(block: block)
        case .tool(let tool):
            if Board.editPath(tool) != nil {
                PhaseEdit(tool: tool, sessionId: sessionId)
            } else {
                ToolChip(tool: tool, client: client, sessionId: sessionId, bare: true)
            }
        default:
            EmptyView()
        }
    }
}

/// An edit inside a phase: its card, 2 pt off the steps around it.
private struct PhaseEdit: View {
    let tool: ToolItem
    let sessionId: String

    var body: some View {
        if let path = Board.editPath(tool) {
            EditRow(sessionId: sessionId, card: Board.wholeChange(path: path, edits: [tool]), running: tool.status == .running, failed: tool.status == .failed)
                .padding(.vertical, 2)
        }
    }
}

/// A thought inside a phase, the desktop's `ActivityThinkingRow`: its first
/// paragraph as one plain line in the dim step, breathing while it streams.
/// Tap opens the whole thought in place; reasoning is read on purpose.
struct ThinkingStep: View {
    let block: TextBlock
    @State private var open = false

    var body: some View {
        let summary = TranscriptRows.summary(block.text)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: 0) {
                    BreathingText(text: summary, breathing: block.streaming)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(minHeight: ActivityStep.lineHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(open ? "Hide thinking" : "Thinking: \(summary)")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                MarkdownView(seq: block.seq, text: block.text, dim: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
            }
        }
    }
}

/// A line in the dim step that breathes while it streams, the desktop's
/// `zen-thinking-pulse`: opacity 0.35 to 0.9 and back over 3.6 s, stepped
/// (14 steps a leg), so it redraws a handful of times a second, never per
/// frame. Still under Reduce Motion.
private struct BreathingText: View {
    let text: String
    let breathing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if breathing, !reduceMotion {
            TimelineView(.periodic(from: .now, by: 1.8 / 14)) { context in
                Text(text)
                    .foregroundStyle(.secondary)
                    .opacity(Self.level(at: context.date))
            }
        } else {
            Text(text).foregroundStyle(.secondary)
        }
    }

    static func level(at date: Date) -> Double {
        let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3.6) / 1.8
        let leg = t < 1 ? t : 2 - t
        return 0.35 + 0.55 * (leg * 14).rounded(.down) / 14
    }
}

/// What a phase was for, at a glance: look, change, run, think; the
/// desktop's `ActivityPhaseIcon`, in the chip's glyph column.
struct PhaseGlyph: View {
    let kind: ActivityGroup.Kind

    var body: some View {
        Image(systemName: symbol)
            .font(.footnote)
            .foregroundStyle(Color(.tertiaryLabel))
            .frame(width: 18, height: ActivityStep.lineHeight)
            .padding(.leading, 8)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch kind {
        case .edit: "pencil.line"
        case .research: "magnifyingglass"
        case .run: "terminal"
        case .think: "sparkles"
        case .other: "wrench.adjustable"
        }
    }
}

/// The rail the steps hang off, drawn per step so it follows however tall
/// the step turns out to be: a spine down the glyph column's centre and a
/// quarter-round branch to the step's first line. The last step is where
/// the spine leaves off. One path, stroked once, so the branch never doubles
/// the spine's alpha where the two run together.
struct PhaseRail: Shape {
    let last: Bool

    static let color = Color.primary.opacity(0.14)
    /// The glyph column's centre: the 8 pt inset and half of 18.
    private static let spine: CGFloat = 17
    private static let radius: CGFloat = 8

    func path(in rect: CGRect) -> Path {
        let x = Self.spine
        let r = Self.radius
        let y = ActivityStep.lineHeight / 2
        var path = Path()
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: last ? y - r : rect.maxY))
        path.move(to: CGPoint(x: x, y: y - r))
        path.addQuadCurve(to: CGPoint(x: x + r, y: y), control: CGPoint(x: x, y: y))
        return path
    }
}

/// The thinking line a live turn ends on while it has nothing to show yet,
/// the desktop's thinking tail: the next content takes its slot.
struct ThinkingTailRow: View {
    var body: some View {
        HStack(spacing: 0) {
            ShimmerText(text: "Thinking")
                .font(.subheadline)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(minHeight: ActivityStep.lineHeight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Thinking")
    }
}

extension EnvironmentValues {
    /// The thread's working directory: a phase's line reads paths relative to it.
    @Entry var transcriptCwd: String? = nil
}
