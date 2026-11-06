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

    /// Still on the streaming render: the stream runs, the reveal holds text
    /// back, a step is still fading, or a step has not been drawn by the
    /// fade yet (a reply that lands whole in its first step fades too).
    private var revealing: Bool {
        guard let reveal else { return false }
        _ = fadeEnded
        return StreamRowRule.onStreamingRender(streaming: block.streaming, revealing: reveal.revealing, fading: fade.fading,
                                               revealedUnits: reveal.revealedUnits, drawnUnits: fade.drawnUnits)
    }

    var body: some View {
        #if DEBUG
        let _ = LayoutProbe.count(reveal == nil ? "streamRow.noReveal" : revealing ? "streamRow.streaming" : "streamRow.settled")
        #endif
        if let reveal, revealing {
            let shown = reveal.revealed
            let _ = fade.reduced = reduceMotion
            let _ = fade.drawnUnits = reveal.revealedUnits
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
            // Settle once the last fade has run out: each step restarts the
            // wait, read once the step is drawn (a task starts after the body).
            .task(id: reveal.revealedUnits) {
                while !Task.isCancelled {
                    let left = fade.lastStepAt + StreamRevealLedger.fade - StreamFadeState.now
                    if left <= 0 { break }
                    try? await Task.sleep(for: .seconds(left))
                }
                if !Task.isCancelled { fadeEnded += 1 }
            }
            .onChange(of: reveal.revealedUnits, initial: true) {
                #if DEBUG
                LayoutProbe.note("revealedUnits", String(reveal.revealedUnits))
                #endif
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
