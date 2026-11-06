import SwiftUI
import UIKit
import TempCodeClient
import TempCodeContract

/// A turn's end row, one row from Send to the turn's close (the desktop's
/// TurnEnd.tsx over WorkingLine.tsx's `TurnLine`; the rules are the client
/// package's `TurnLineInput` and `TurnLineModel`). While the turn runs: one
/// 28 pt line at the prose edge, `WorkingMark` in the glyph slot and the
/// phase's words in `WorkingText`, morphing (`MorphText`) as the phase
/// changes, each phase held 300 ms. A card that waits on the person, or a
/// pause, folds it closed with its words kept; the resume opens it again. A
/// Stop morphs it to Stopped. Once the turn is over and every row of it has
/// finished revealing (`RevealDrain`), the mark leaves as an icon swap and
/// the words morph into "Worked for 2m 4s" ("Worked" until the time lands)
/// and slide to the prose edge. No clock time. The thread's last turn
/// carries the Watching line under it while the thread watches.
struct TurnLineRow: View {
    let end: TurnEnd
    let client: EnvironmentClient
    let sessionId: String
    @Environment(\.revealDrain) private var drain
    @Environment(\.transcriptCwd) private var cwd
    @Environment(\.accessibilityReduceMotion) private var reduced
    /// The row's line model, outside observation: the body reads and moves it.
    @State private var box = TurnLineBox()
    /// Bumped when a hold ends or the drain is due another look.
    @State private var wake = 0

    var body: some View {
        let _ = wake
        let meta = client.session(sessionId)
        let now = Date().timeIntervalSinceReferenceDate
        let (look, due) = box.update(end: end, meta: meta, revealing: drain?.revealing(turn: end.userKey) ?? false, phase: phase(meta), at: now)
        // Slides only for a line that was live in this row; one that mounts settled stands still.
        let slide = box.everLive && !reduced ? Motion.settleSlide : nil
        VStack(alignment: .leading, spacing: 0) {
            if look.visible {
                line(look)
                    .frame(height: look.open ? TranscriptMetrics.line : 0, alignment: .top)
                    .clipped()
                    .opacity(look.open ? 1 : 0)
                    .padding(.vertical, look.open ? TranscriptMetrics.Gap.line : 0)
                    .animation(slide, value: look.saying)
            }
            if end.last, let meta {
                WatchingLine(meta: meta, client: client)
            }
        }
        .animation(reduced ? Motion.fast : Motion.layout, value: look.open)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: due) {
            guard let due else { return }
            try? await Task.sleep(for: .seconds(max(0, due - Date().timeIntervalSinceReferenceDate)))
            if !Task.isCancelled { wake &+= 1 }
        }
        .contextMenu {
            if !look.saying, !end.answer.isEmpty {
                Button("Copy answer", systemImage: "doc.on.doc") { UIPasteboard.general.string = end.answer }
            }
        }
    }

    private func line(_ look: TurnLineModel.Look) -> some View {
        ZStack(alignment: .leading) {
            if look.saying {
                WorkingMark()
                    .frame(width: TranscriptMetrics.glyphSlot)
                    .iconSwapTransition()
            }
            MorphText(key: look.key, value: LineWords(look: look)) { words in
                words.view
            }
            .padding(.leading, look.saying ? TranscriptMetrics.glyphSlot + TranscriptMetrics.glyphGap : 0)
        }
        .frame(maxWidth: .infinity, minHeight: TranscriptMetrics.line, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(look.saying ? (look.phase.spoken ?? (look.words.isEmpty ? "Working" : look.words)) : look.words)
        .accessibilityAddTraits(look.saying ? .updatesFrequently : [])
    }

    /// What the line says while the turn runs: the host's words for a wait
    /// before the turn's own content, the turn's open wait on agents by
    /// title (`WaitSteps.waitOn`, read from the turn, drawn like a call),
    /// else what the turn's rows say (`LinePhase.of`).
    private func phase(_ meta: SessionMeta?) -> LinePhase {
        guard end.open else { return .thinking }
        let waitOn = WaitSteps.waitOn(end.turn) { client.session($0)?.title }
        return LinePhase.of(turn: end.turn, activity: LinePhase.hostWords(statusDetail: meta?.statusDetail, activity: meta?.activity), waitOn: waitOn, cwd: cwd)
    }
}

/// The row's `TurnLineTracker`, plain storage the body moves.
@MainActor
final class TurnLineBox {
    private var tracker = TurnLineTracker()
    private var lastKey: String?

    var everLive: Bool { tracker.everLive }

    func update(end: TurnEnd, meta: SessionMeta?, revealing: Bool, phase: LinePhase, at now: Double) -> (TurnLineModel.Look, Double?) {
        let paused = [.paused, .stopped, .queued].contains(meta?.status)
        let (look, due) = tracker.update(end, paused: paused, revealing: revealing, phase: phase, at: now)
        #if DEBUG
        if let lastKey, lastKey != look.key {
            LayoutProbe.count("turnLine.morph")
            if look.key == TurnLineModel.closedKey { LayoutProbe.count("turnLine.closed") }
        }
        if end.last { LayoutProbe.note("turnLine", look.visible ? (look.open ? (look.saying ? "working" : "closed") : "folded") : "none") }
        #endif
        lastKey = look.key
        return (look, due)
    }
}

/// The words a line shows, as `MorphText` takes them.
private struct LineWords: Equatable {
    var words: String
    var verb: String?
    var object: String?
    var saying: Bool

    init(look: TurnLineModel.Look) {
        words = look.words
        saying = look.saying
        if look.saying, let verb = look.phase.verb, let object = look.phase.object, look.words == "\(verb) \(object)" {
            self.verb = verb
            self.object = object
        }
    }

    @ViewBuilder var view: some View {
        if saying {
            WorkingText(words: words, verb: verb, object: object)
        } else {
            Text(words)
                .transcriptType(TranscriptType.line)
                .foregroundStyle(.secondary)
        }
    }
}

/// The working line's mark, the desktop's `WorkingMark`: three 3 pt dots
/// in a 14 pt box that gather into one and part again every 1.6 s, the
/// right one running behind the left, each moved by offset and scale alone.
/// Still, the three dots at rest, under reduced motion and while the scene
/// is not active.
struct WorkingMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase

    struct Pose {
        var x0 = Motion.markDots[0].restX
        var s0: CGFloat = 1
        var s1: CGFloat = 1
        var x2 = Motion.markDots[2].restX
        var s2: CGFloat = 1
    }

    var body: some View {
        Group {
            if reduced || scenePhase != .active {
                dots(Pose())
            } else {
                KeyframeAnimator(initialValue: Pose(), repeating: true) { pose in
                    dots(pose)
                } keyframes: { _ in
                    track(\.x0, Motion.markDots[0].legs(Motion.markDots[0].restX, Motion.markDots[0].gatheredX))
                    track(\.s0, Motion.markDots[0].legs(1, Motion.markDots[0].gatheredScale))
                    track(\.s1, Motion.markDots[1].legs(1, Motion.markDots[1].gatheredScale))
                    track(\.x2, Motion.markDots[2].legs(Motion.markDots[2].restX, Motion.markDots[2].gatheredX))
                    track(\.s2, Motion.markDots[2].legs(1, Motion.markDots[2].gatheredScale))
                }
            }
        }
        .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
        .accessibilityHidden(true)
    }

    private func track(_ path: WritableKeyPath<Pose, CGFloat>, _ legs: [(value: CGFloat, duration: Double, curve: UnitCurve)]) -> some Keyframes<Pose> {
        KeyframeTrack(path) {
            LinearKeyframe(legs[0].value, duration: legs[0].duration, timingCurve: legs[0].curve)
            LinearKeyframe(legs[1].value, duration: legs[1].duration, timingCurve: legs[1].curve)
            LinearKeyframe(legs[2].value, duration: legs[2].duration, timingCurve: legs[2].curve)
        }
    }

    private func dots(_ pose: Pose) -> some View {
        ZStack {
            dot.scaleEffect(pose.s0).offset(x: pose.x0)
            dot.scaleEffect(pose.s1)
            dot.scaleEffect(pose.s2).offset(x: pose.x2)
        }
    }

    private var dot: some View {
        Circle()
            .fill(.primary)
            .frame(width: Motion.markDot, height: Motion.markDot)
    }
}

/// The one "words being produced" text, the desktop's `WorkingText`: the
/// words muted (a call's object in the primary step), and over them a copy
/// in the primary step seen through a band that crosses every 3 s, the band
/// moved by its offset alone. Still muted words under reduced motion and
/// while the scene is not active.
struct WorkingText: View {
    let words: String
    var verb: String?
    var object: String?
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.measuring) private var measuring

    var body: some View {
        base
            .transcriptType(TranscriptType.line)
            .overlay {
                if !reduced, !measuring, scenePhase == .active, !words.isEmpty {
                    Text(words)
                        .transcriptType(TranscriptType.line)
                        .foregroundStyle(.primary)
                        .mask { band }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    private var base: Text {
        if let verb, let object {
            return Text("\(Text(verb).foregroundStyle(.secondary)) \(Text(object).foregroundStyle(.primary))")
        }
        return Text(words).foregroundStyle(.secondary)
    }

    private var band: some View {
        GeometryReader { proxy in
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.4), .init(color: .black, location: 0.6), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing)
                .frame(width: proxy.size.width)
                .keyframeAnimator(initialValue: CGFloat(-1), repeating: true) { content, share in
                    content.offset(x: share * proxy.size.width)
                } keyframes: { _ in
                    KeyframeTrack {
                        LinearKeyframe(Motion.shimmerLegs[0].value, duration: Motion.shimmerLegs[0].duration, timingCurve: Motion.shimmerLegs[0].curve)
                        LinearKeyframe(Motion.shimmerLegs[1].value, duration: Motion.shimmerLegs[1].duration, timingCurve: Motion.shimmerLegs[1].curve)
                        LinearKeyframe(Motion.shimmerLegs[2].value, duration: Motion.shimmerLegs[2].duration, timingCurve: Motion.shimmerLegs[2].curve)
                    }
                }
        }
    }
}

/// The thread still watching, under its last closing line (the desktop's
/// `WatchingLine` in a kept fold): the watching ring, Watching in medium,
/// what it watches (`WatchWords.watchSubject`: one subagent by its title,
/// else counted) and the watch's age ticking each second, amber past 30
/// minutes on its own tasks. A tap opens the agents list when it watches
/// subagents. Once shown it stays mounted, folding closed when the watch ends.
private struct WatchingLine: View {
    let meta: SessionMeta
    let client: EnvironmentClient
    @Environment(\.openAgents) private var openAgents
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var opened = false

    var body: some View {
        let watching = WatchWords.isWatching(meta)
        Group {
            if opened || watching {
                content
                    .frame(height: watching ? TranscriptMetrics.line : 0, alignment: .top)
                    .clipped()
                    .opacity(watching ? 1 : 0)
                    .padding(.vertical, watching ? TranscriptMetrics.Gap.line : 0)
            }
        }
        .animation(reduced ? Motion.fast : Motion.layout, value: watching)
        .onChange(of: watching, initial: true) { _, now in if now { opened = true } }
    }

    @ViewBuilder private var content: some View {
        let agents = meta.background?.agents ?? []
        if let openAgents, !agents.isEmpty {
            Button(action: openAgents) { words }
                .buttonStyle(.pressable)
                .accessibilityHint("Opens the agents")
        } else {
            words
        }
    }

    private var words: some View {
        let subject = WatchWords.watchSubject(meta.background) { client.session($0)?.title }
        let since = meta.background?.watchingSince
        return TimelineView(.periodic(from: .now, by: 1)) { context in
            let nowMs = Int(context.date.timeIntervalSince1970 * 1_000)
            let age = since.map { TimeFormat.duration(ms: max(0, nowMs - $0)) }
            HStack(spacing: 0) {
                Circle()
                    .strokeBorder(.secondary, lineWidth: 1.5)
                    .frame(width: TranscriptMetrics.glyphSlot - TranscriptMetrics.wordGap, height: TranscriptMetrics.glyphSlot - TranscriptMetrics.wordGap)
                    .frame(width: TranscriptMetrics.glyphSlot)
                    .padding(.trailing, TranscriptMetrics.glyphGap)
                    .accessibilityHidden(true)
                Text("\(Text("Watching").fontWeight(.medium)) \(Text(age == nil ? subject : "\(subject),"))")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let age {
                    Text(age)
                        .foregroundStyle(WatchWords.isStale(meta, nowMs: nowMs) ? AnyShapeStyle(Tint.warning) : AnyShapeStyle(.secondary))
                        .numeric(age)
                        .padding(.leading, TranscriptMetrics.wordGap)
                        .layoutPriority(1)
                }
                Spacer(minLength: 0)
            }
            .transcriptType(TranscriptType.line)
            .frame(minHeight: TranscriptMetrics.line)
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
        }
    }
}

extension EnvironmentValues {
    /// Opens the thread's agents list (the thread screen's), for the Watching line.
    @Entry var openAgents: (() -> Void)? = nil
}
