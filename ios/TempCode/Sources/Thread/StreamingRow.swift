import SwiftUI
import TempCodeClient
import TempCodeContract

// The rows that change while a turn streams. The reveal is a pacing of
// data (`SmoothTextReveal`, the desktop's jitter buffer): whole words every
// 100 ms on a timer, no display frames. Only a replaced chip target
// cross-fades, and only under full motion.

/// The agent's answer: `AssistantRow` sends every non-empty block here, so
/// the row keeps its state when the final row lands. A block mounted settled
/// (history, a cache paint, a row scrolled back in) carries no reveal and is
/// the markdown at once, unless it was born live (`born`: it joined the last
/// turn after the transcript opened), which reveals from its first word
/// even when it mounts settled. A streaming block is paced inside this row's
/// own state, so a step re-runs this body and nothing in the fold; the
/// revealed prefix goes through the markdown's incremental path (the last
/// changed block only), each step fading in as one run (`StreamFade.swift`).
/// When the final row arrives the reveal drains what it still holds at the
/// stream's pace; the row stays on the streaming render until that drain
/// and its last fade are done, then swaps to the settled parse, which is
/// the same document, so nothing on screen changes. The row reports to the
/// thread's `RevealDrain` under its turn while it reveals.
struct StreamingAssistantRow: View {
    let block: TextBlock
    @State private var reveal: SmoothTextReveal?
    /// The phrase fade's ledger (plain storage; the reveal's steps redraw the row).
    @State private var fade = StreamFadeState()
    /// Bumped when the last fade has run out, so the row settles.
    @State private var fadeEnded = 0
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.revealTurn) private var revealTurn
    @Environment(\.revealDrain) private var revealDrain
    @Environment(\.transcriptFollow) private var follow

    init(block: TextBlock, born: Bool = false) {
        self.block = block
        _reveal = State(initialValue: block.streaming || born ? SmoothTextReveal(text: block.text, streaming: block.streaming, fromStart: born) : nil)
        // Born live, the row reveals from its first word: armed from the start, so that word fades too.
        _fade = State(initialValue: StreamFadeState(armed: born))
    }

    /// Still on the streaming render: the stream runs, the reveal holds text back, or a step is still fading.
    private var revealing: Bool {
        guard let reveal else { return false }
        _ = fadeEnded
        return block.streaming || reveal.revealing || fade.fading
    }

    var body: some View {
        #if DEBUG
        let _ = LayoutProbe.count(reveal == nil ? "streamRow.noReveal" : revealing ? "streamRow.streaming" : "streamRow.settled")
        #endif
        if let reveal, revealing {
            let shown = reveal.revealed
            let _ = fade.reduced = reduceMotion
            Group {
                if !shown.isEmpty {
                    // The incremental path, never the async one: that would
                    // flicker between plain and styled on every step.
                    MarkdownView(seq: block.seq, text: shown, streaming: true, fade: fade)
                        .textSelection(.enabled)
                        .padding(.vertical, 6)
                }
            }
            .onChange(of: block.text) { reveal.update(text: block.text, streaming: block.streaming) }
            .onChange(of: block.streaming) { reveal.update(text: block.text, streaming: block.streaming) }
            .onChange(of: scenePhase) { if scenePhase != .active { reveal.snap() } }
            // What the row held when it mounted is shown, not faded; from then on every step fades.
            .onAppear { fade.arm() }
            .onDisappear {
                fade.disarm()
                reveal.snap()
            }
            // Settle once the last fade has run out (each step restarts the wait).
            .task(id: fade.lastStepAt) {
                try? await Task.sleep(for: .seconds(StreamRevealLedger.fade))
                if !Task.isCancelled { fadeEnded += 1 }
            }
            .onChange(of: reveal.revealedUnits, initial: true) {
                LayoutProbe.note("revealedUnits", String(reveal.revealedUnits))
                // The step grew the row: the reader at the bottom stays there through the drain.
                follow?.pin()
            }
            .onChange(of: revealing, initial: true) { report() }
            .onDisappear { revealDrain?.report(turn: revealTurn ?? -1, row: block.seq, on: false) }
        } else {
            MarkdownView(seq: block.seq, text: block.text)
                .textSelection(.enabled)
                .padding(.vertical, 6)
                .contextMenu {
                    Button("Copy Message", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
                }
                .onAppear { report() }
        }
    }

    /// Tells the thread's drain whether this row still reveals under its turn.
    private func report() {
        guard let revealDrain, let revealTurn else { return }
        revealDrain.report(turn: revealTurn, row: block.seq, on: revealing)
    }
}

/// A chip's verb and target while the call streams: the target types in as
/// the arguments grow (a prefix growing is set without a transaction) and
/// cross-fades, 150 ms with 2 pt of blur, when a new value replaces the old
/// (the partial's JSON cut mid-string, then whole). A hidden one-line mono
/// sizer keeps the slot's height whether the target is nil, growing or
/// swapping, so the chip never changes height.
struct LiveChipLabel: View {
    let verb: String
    let target: String?
    /// A path in mono with its middle cut; anything else in the text face with its tail cut.
    var isFile = true
    let failed: Bool
    @State private var generation = 0
    @State private var shownTarget: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(verb: String, target: String?, isFile: Bool = true, failed: Bool) {
        self.verb = verb
        self.target = target
        self.isFile = isFile
        self.failed = failed
        _shownTarget = State(initialValue: Self.nonEmpty(target))
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // The verb in the dim step, the target loud: the settled chip's line.
            Text(verb)
                .font(.subheadline)
                .foregroundStyle(failed ? Tint.destructive : Color(.secondaryLabel))
                .lineLimit(1)
                // A verb with a target never gives way to it: the target is the one that truncates.
                .fixedSize(horizontal: shownTarget != nil, vertical: false)
            ZStack(alignment: .leading) {
                Text(" ")
                    .font(targetFont)
                    .hidden()
                if let shownTarget {
                    Text(shownTarget)
                        .font(targetFont)
                        .foregroundStyle(failed ? Tint.destructive : .primary)
                        .lineLimit(1)
                        .truncationMode(isFile ? .middle : .tail)
                        .id(generation)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
            }
            .animation(Motion.crossFade, value: generation)
            .layoutPriority(1)
        }
        .onChange(of: target) { _, next in
            guard let next = Self.nonEmpty(next) else {
                shownTarget = nil
                return
            }
            if shownTarget == nil || next.hasPrefix(shownTarget!) || shownTarget!.hasPrefix(next) {
                // Typing in: the text advances, nothing fades.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { shownTarget = next }
            } else {
                // Replaced: the old line fades out through the blur, the new one in.
                generation += 1
                shownTarget = next
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var targetFont: Font {
        isFile ? .system(.footnote, design: .monospaced) : .subheadline
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
