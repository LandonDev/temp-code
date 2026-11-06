import Foundation
import TempCodeContract

/// What the end row is told, the desktop's TurnEnd.tsx feeding `TurnLine`
/// (surfaces/transcript/WorkingLine.tsx): from the row, the thread's
/// status and the drain.
public struct TurnLineInput: Sendable, Hashable {
    /// Live on the host, or over and still revealing its text: the mark shows.
    public var live: Bool
    /// Paused, or a step waits on the person: the line folds closed with its words kept.
    public var held: Bool
    /// The phase the line would say now (`LinePhase.of`), the mark alone while draining.
    public var phase: LinePhase
    /// The closing words, once the turn is over and every row of it has
    /// finished revealing; nil until then.
    public var closing: String?
    /// Over with its time still to land ("Worked"): drawn only by a line that was live.
    public var pending: Bool

    public init(live: Bool, held: Bool, phase: LinePhase, closing: String?, pending: Bool = false) {
        self.live = live
        self.held = held
        self.phase = phase
        self.closing = closing
        self.pending = pending
    }

    /// The phase while the turn is over but its text still reveals: the mark alone.
    public static let draining = LinePhase(key: "writing", words: "")

    /// TurnEnd.tsx's rules. `paused`: the thread is paused (or its harness
    /// is gone); `revealing`: `RevealDrain.revealing(turn:)` for the row's
    /// turn; `phase`: what the line says while the turn runs.
    public static func of(_ end: TurnEnd, paused: Bool, revealing: Bool, phase: LinePhase) -> TurnLineInput {
        let over = !end.open || end.stopped
        let draining = revealing && over
        let held = !over && (paused || end.awaitsUser)
        let closes = over && !draining
        let closing = closes ? (end.stopped ? TurnEndWords.stopped : TurnEndWords.worked(ms: end.durationMs)) : nil
        return TurnLineInput(
            live: draining || (!over && !held),
            held: held,
            phase: draining ? Self.draining : phase,
            closing: closing,
            pending: !end.open && !end.stopped && end.durationMs == nil
        )
    }
}

/// The end row's life from Send to the turn's close, the desktop's
/// `TurnLine` on the caller's clock (seconds). One per row for the row's
/// whole life: a phase painted stays `MotionValues.wordHold`, and so does
/// the last phase before the closing words; a line never live draws its
/// closing line at once; a line never live with no closing draws nothing.
public struct TurnLineModel: Sendable {
    /// What the row draws.
    public struct Look: Sendable, Hashable {
        /// Anything at all.
        public var visible: Bool
        /// Not folded.
        public var open: Bool
        /// Still saying a phase: the mark shows and the words sit past the glyph slot.
        public var saying: Bool
        /// The words' key: a change morphs them. The phase's while saying, else "closed".
        public var key: String
        /// The phase on screen (its verb and object), while saying.
        public var phase: LinePhase
        /// The words on the line: the phase's while saying, else the closing words.
        public var words: String
    }

    public static let closedKey = "closed"
    /// A line folds this long after its hold starts and reopens this long
    /// after it ends: the card that holds it lands (a question asked, an
    /// approval asked) or folds (answered, decided) over `base` first. Two
    /// rows changing height in one update made the List lose the heights of
    /// the rows above the reader for a frame (the offset dropped by
    /// thousands of points until the next pin); one after the other, it
    /// keeps them. A hold shorter than this never folds the line.
    public static let holdSettle = MotionValues.base + MotionValues.revealStep / 2

    private var phaseHold: HeldPhase
    private var wordHold: HeldPhase
    /// Live once for this row: the line stays, and a pending closing is drawn.
    public private(set) var everLive: Bool
    public private(set) var look: Look
    /// The hold the line shows: the input's, `holdSettle` late.
    private var heldShown: Bool
    /// While the input's hold differs from the one shown: when the line follows it.
    private var settleAt: Double?

    public init(_ input: TurnLineInput, at now: Double) {
        phaseHold = HeldPhase(input.phase, at: now)
        let phased = input.live || (input.held && input.closing == nil)
        wordHold = HeldPhase(LinePhase(key: phased ? input.phase.key : Self.closedKey, words: ""), at: now)
        everLive = input.live
        heldShown = input.held
        look = Look(visible: false, open: false, saying: false, key: Self.closedKey, phase: input.phase, words: "")
        _ = update(input, at: now)
    }

    /// The look for `input` at `now`; `due` is when to ask again (a hold ends).
    @discardableResult
    public mutating func update(_ input: TurnLineInput, at now: Double) -> (look: Look, due: Double?) {
        let held = phaseHold.update(input.phase, at: now)
        let phase = held.shown
        if input.live { everLive = true }
        let closing = input.closing.flatMap { !input.pending || everLive ? $0 : nil }
        let phased = input.live || (input.held && closing == nil)
        let word = wordHold.update(LinePhase(key: phased ? phase.key : Self.closedKey, words: ""), at: now)
        let closedShown = word.shown.key == Self.closedKey && !phased
        let ending = !phased && !closedShown && everLive
        let saying = phased || ending
        if input.held == heldShown {
            settleAt = nil
        } else {
            let at = settleAt ?? now + Self.holdSettle
            if now >= at {
                heldShown = input.held
                settleAt = nil
            } else {
                settleAt = at
            }
        }
        look = Look(
            visible: everLive || closing != nil,
            open: !heldShown && (input.live || input.held || closing != nil || ending),
            saying: saying,
            key: saying ? phase.key : Self.closedKey,
            phase: phase,
            words: saying ? phase.words : (closing ?? "")
        )
        let dues = [held.due, word.due, settleAt].compactMap { $0 }
        return (look, dues.min())
    }
}

/// One end row's line over its life, as the app's row drives it: the model,
/// and the drain's two gaps. The drain tells no one when a row stops
/// revealing, so while the turn is over and still revealing the row looks
/// again each reveal step (`due`). And a row of text that mounts in the
/// same pass as the turn's end may not have reported yet, so for a row that
/// saw its turn open, the first reveal step after the end counts as
/// revealing; a row that mounts on a settled turn draws its closing line at
/// once. The drain is believed for `drainBound` past the turn's end and no
/// longer: every character shows within the reveal's catch-up, so a row
/// that never reported its drain off (it left the screen mid-report, or its
/// turn had no key) cannot hold the closing line, or wake the row each
/// step, forever.
public struct TurnLineTracker: Sendable {
    /// The reveal's own promise: every character within the catch-up (two
    /// steps of slack), then its last fade, seconds past the turn's end.
    public static var drainBound: Double {
        (SmoothText.catchUpMs + 2 * SmoothText.stepMs) / 1_000 + StreamRevealLedger.fade
    }

    public private(set) var model: TurnLineModel?
    private var sawOpen = false
    private var overAt: Double?

    public init() {}

    public var everLive: Bool { model?.everLive ?? false }

    public mutating func update(_ end: TurnEnd, paused: Bool, revealing: Bool, phase: LinePhase, at now: Double) -> (look: TurnLineModel.Look, due: Double?) {
        let over = !end.open || end.stopped
        if !over {
            sawOpen = true
            overAt = nil
        } else if overAt == nil {
            overAt = now
        }
        let sinceOver = now - (overAt ?? now)
        let grace = sawOpen && over && sinceOver < MotionValues.revealStep
        // Past the bound a drain that never reported off is not believed.
        let revealing = revealing && !(over && sinceOver >= Self.drainBound)
        let input = TurnLineInput.of(end, paused: paused, revealing: revealing || grace, phase: phase)
        var result: (look: TurnLineModel.Look, due: Double?)
        if var model {
            result = model.update(input, at: now)
            self.model = model
        } else {
            let model = TurnLineModel(input, at: now)
            result = (model.look, nil)
            self.model = model
        }
        if over, revealing || grace {
            result.due = min(result.due ?? .infinity, now + MotionValues.revealStep)
        }
        return result
    }
}
