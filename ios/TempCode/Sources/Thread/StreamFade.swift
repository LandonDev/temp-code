import SwiftUI
import TempCodeClient

// The phrase fade (docs/IOS-DESIGN.md "Motion", the streaming row): a
// streaming block's text is one `Text` built from runs, the settled prefix
// as one and each step younger than the fade as its own, tagged with when
// it arrived (`StreamFadeAttribute`); `StreamFadeRenderer` draws a tagged
// run at its linear opacity. A `TimelineView` wraps only the renderer and
// runs only while a run is young; the `Text` is built outside its closure.

/// When a run of streamed text arrived, seconds on the reference clock.
struct StreamFadeAttribute: TextAttribute {
    var bornAt: Double
}

/// Draws each tagged run at its opacity at `now`; the rest as it is.
struct StreamFadeRenderer: TextRenderer {
    var now: Double

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line {
                if let fade = run[StreamFadeAttribute.self] {
                    var faded = context
                    faded.opacity = RevealSegment(from: 0, to: 0, bornAt: fade.bornAt).opacity(at: now)
                    faded.draw(run)
                } else {
                    context.draw(run)
                }
            }
        }
    }
}

/// A streaming row's fade: the ledger, armed once the row's first text is
/// drawn (what the row held when it mounted is shown, not faded), disarmed
/// while the row is off screen (its reveal snaps there). Plain storage the
/// row's body reads and writes; nothing observes it.
@MainActor
final class StreamFadeState {
    private(set) var ledger = StreamRevealLedger()
    var reduced = false

    static var now: Double { Date().timeIntervalSinceReferenceDate }

    func arm() { if !ledger.armed { ledger.arm() } }

    /// Off screen: a new ledger, armed again at the next appearance.
    func disarm() { ledger = StreamRevealLedger() }

    func runs(_ plain: String) -> [RevealSegment] {
        ledger.segments(for: plain, at: Self.now, reduced: reduced)
    }

    var fading: Bool { ledger.fading(at: Self.now) }
    var lastStepAt: Double { ledger.lastStepAt }
}

extension EnvironmentValues {
    /// The key of the turn a transcript row belongs to (its message's key), for `RevealDrain`.
    @Entry var revealTurn: Int? = nil
    /// The thread's drain: which turns still reveal text.
    @Entry var revealDrain: RevealDrain? = nil
}

enum FadedText {
    /// `styled` as one `Text` of its runs: young runs tagged with their arrival.
    static func build(_ styled: AttributedString, runs: [RevealSegment]) -> Text {
        guard runs.contains(where: \.young) else { return Text(styled) }
        var text = Text(verbatim: "")
        for run in runs {
            let start = styled.index(styled.startIndex, offsetByCharacters: run.from)
            let end = styled.index(styled.startIndex, offsetByCharacters: run.to)
            var piece = Text(AttributedString(styled[start..<end]))
            if let bornAt = run.bornAt { piece = piece.customAttribute(StreamFadeAttribute(bornAt: bornAt)) }
            text = Text("\(text)\(piece)")
        }
        return text
    }
}

/// One block of streamed prose: its runs drawn through the renderer, the
/// timeline running only while a run is young.
struct StreamFadeText: View {
    let styled: AttributedString
    let runs: [RevealSegment]
    let type: TypeSpec

    var body: some View {
        let young = runs.contains(where: \.young)
        let text = FadedText.build(styled, runs: runs)
        #if DEBUG
        // The transcript proof reads these: young runs drawn under full motion, none under reduced.
        let _ = LayoutProbe.count(young ? "streamFadeYoung" : "streamFadeSettled")
        #endif
        TimelineView(.animation(paused: !young)) { context in
            text
                .transcriptType(type)
                .textRenderer(StreamFadeRenderer(now: context.date.timeIntervalSinceReferenceDate))
        }
    }
}
