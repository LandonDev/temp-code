import SwiftUI
import TempCodeClient
import TempCodeContract

// The rows that change while a turn streams. None of them animates: the
// reveal is a pacing of data (`SmoothTextReveal`), seen hundreds of times a
// day, so there is no fade, no translate and no veil. Only a replaced chip
// target cross-fades (150 ms, 2 pt of blur), and only under full motion.

/// The agent's answer: `AssistantRow` sends every non-empty block here, so
/// the row keeps its state when the final row lands. A block mounted settled
/// (history, a cache paint) carries no pacer and is the markdown at once. A
/// block mounted streaming is paced by the jitter buffer inside this row's
/// own state, so a paint re-runs this body and nothing in the fold; the
/// revealed prefix goes through the markdown's incremental path (the last
/// changed block only). When the final row arrives the pacer drains the text
/// still held back (τ 90 ms) and only then the settled markdown takes over.
struct StreamingAssistantRow: View {
    let block: TextBlock
    @State private var reveal: SmoothTextReveal?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    init(block: TextBlock) {
        self.block = block
        _reveal = State(initialValue: block.streaming ? SmoothTextReveal(text: block.text, streaming: true, paced: !UIAccessibility.isReduceMotionEnabled) : nil)
    }

    var body: some View {
        if let reveal, block.streaming || reveal.revealedUnits < block.text.utf8.count {
            let shown = String(reveal.revealed)
            Group {
                if !shown.isEmpty {
                    // The incremental path, never the async one: that would
                    // flicker between plain and styled on every paint.
                    MarkdownView(seq: block.seq, text: shown, streaming: true)
                        .textSelection(.enabled)
                        .padding(.vertical, 6)
                }
            }
            .onChange(of: block.text) { reveal.update(text: block.text, streaming: block.streaming) }
            .onChange(of: block.streaming) { reveal.update(text: block.text, streaming: block.streaming) }
            .onChange(of: reduceMotion) {
                reveal.paced = !reduceMotion
                reveal.update(text: block.text, streaming: block.streaming)
            }
            .onChange(of: scenePhase) { if scenePhase != .active { reveal.snap() } }
            .onDisappear { reveal.snap() }
        } else {
            MarkdownView(seq: block.seq, text: block.text)
                .textSelection(.enabled)
                .padding(.vertical, 6)
                .contextMenu {
                    Button("Copy Message", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
                }
        }
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
