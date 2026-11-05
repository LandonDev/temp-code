import Foundation

/// The runner's hold, morph and closing checks (A6): every end row's
/// `TurnLineModel` sampled at each reveal step and each hold's end, its
/// words fed through a `MorphModel` as the app's `MorphText` takes them.
///
/// - `hold`: a phase on the line stays at least `MotionValues.wordHold`
///   before the next (the closing words included).
/// - `morph`: words morph only when their key changes, new words under one
///   key are drawn at once, the closing line never turns back into a phase,
///   and a turn that ended rests on its closing words ("Worked for …", or
///   Stopped for a turn the person stopped).
/// - `drain`: the closing words never show while a row of the turn still
///   reveals its text.
@MainActor
final class LineProbes {
    private struct Probe {
        var model: TurnLineModel
        var morph: MorphModel
        var key: String
        var paintedAt: Double
        var open: Bool
        var due: Double?
        var end: TurnEnd
    }

    let reduced: Bool
    /// The thread is paused (a `.paused` step): the open turn's line folds.
    var paused = false
    private var probes: [TranscriptRowID: Probe] = [:]
    private(set) var violations: [String] = []
    /// What the lines did, in order: "@ms <row> morph A → B", "fold", "open".
    private(set) var events: [String] = []

    init(reduced: Bool) {
        self.reduced = reduced
    }

    /// The soonest hold that ends, ms.
    var nextDue: Double? { probes.values.compactMap(\.due).min().map { $0 * 1_000 } }

    func sample(_ rows: [TranscriptRowModel], drain: RevealDrain, at ms: Double, checks: Set<TranscriptScenario.Check>, label: String) {
        let t = ms / 1_000
        for row in rows {
            guard case .turnEnd(let end) = row else { continue }
            let phase = LinePhase.of(turn: end.turn, activity: nil)
            let revealing = drain.revealing(turn: end.userKey)
            let input = TurnLineInput.of(end, paused: paused, revealing: revealing, phase: phase)
            let at = "\(label) @\(Int(ms))ms end \(end.userKey)"
            guard var probe = probes[row.id] else {
                let model = TurnLineModel(input, at: t)
                probes[row.id] = Probe(model: model, morph: MorphModel(model.look.words, reduced: reduced), key: model.look.key, paintedAt: t, open: model.look.open, due: nil, end: end)
                continue
            }
            let (look, due) = probe.model.update(input, at: t)
            probe.due = due
            probe.end = end
            if look.key != probe.key {
                if checks.contains(.hold), t - probe.paintedAt < MotionValues.wordHold - 1e-6 {
                    violations.append("\(at): \(probe.key) painted \(Int((t - probe.paintedAt) * 1_000)) ms, under the hold")
                }
                if checks.contains(.morph), probe.key == TurnLineModel.closedKey {
                    violations.append("\(at): the closing line turned back into \(look.key)")
                }
                events.append("@\(Int(ms)) \(end.userKey) morph \(probe.key) → \(look.key)")
                probe.morph.set(look.words, at: t)
                probe.key = look.key
                probe.paintedAt = t
            } else if look.words != probe.morph.words {
                probe.morph.replace(look.words)
            }
            probe.morph.tick(at: t)
            if look.open != probe.open {
                events.append("@\(Int(ms)) \(end.userKey) \(look.open ? "open" : "fold") \(look.key)")
                probe.open = look.open
            }
            if checks.contains(.drain), revealing, look.visible, look.key == TurnLineModel.closedKey {
                violations.append("\(at): the closing line showed while the turn still revealed its text")
            }
            probes[row.id] = probe
        }
    }

    /// After the last push: a turn that is over rests on its closing words.
    func finish(at ms: Double, checks: Set<TranscriptScenario.Check>, label: String) {
        guard checks.contains(.morph) else { return }
        let t = ms / 1_000
        for id in probes.keys.sorted(by: { $0.key < $1.key }) {
            guard var probe = probes[id], !probe.end.open || probe.end.stopped else { continue }
            probe.morph.tick(at: t + probe.morph.outDuration + probe.morph.inDuration)
            let want = probe.end.stopped ? TurnEndWords.stopped : TurnEndWords.worked(ms: probe.end.durationMs)
            if probe.morph.stage != .still(want) {
                violations.append("\(label): end \(id.key) rests on \(probe.morph.stage), not \(want)")
            }
        }
    }

    /// The words the row with `id` rests on now.
    func words(_ id: TranscriptRowID) -> String? { probes[id]?.morph.words }
}
