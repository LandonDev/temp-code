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
                    // Held (a card, a pause) the line is folded out of sight: its mark and shimmer stand still.
                    .environment(\.workingStill, !look.open)
                    // Open, the line's minimum (it grows with a large text size); closed, folded to nothing.
                    .frame(minHeight: look.open ? TranscriptMetrics.line : 0, maxHeight: look.open ? nil : 0, alignment: .top)
                    .clipped()
                    .opacity(look.open ? 1 : 0)
                    // The 8 pt from the turn's last row is the row's own, folding with it.
                    .padding(.top, look.open ? TranscriptMetrics.Gap.closing : 0)
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
/// Core Animation moves them (`MarkLoopView`): the render server draws each
/// frame, and no body or closure runs for one. Still, the three dots at
/// rest, under reduced motion, while the scene is not active and while its
/// line is folded (`workingStill`).
struct WorkingMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.workingStill) private var still

    var body: some View {
        Group {
            if reduced || still || scenePhase != .active {
                ZStack {
                    dot.offset(x: Motion.markDots[0].restX)
                    dot
                    dot.offset(x: Motion.markDots[2].restX)
                }
            } else {
                MarkLoop()
            }
        }
        .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
        .accessibilityHidden(true)
    }

    private var dot: some View {
        Circle()
            .fill(.primary)
            .frame(width: Motion.markDot, height: Motion.markDot)
    }
}

private struct MarkLoop: UIViewRepresentable {
    func makeUIView(context: Context) -> MarkLoopView { MarkLoopView() }
    func updateUIView(_ view: MarkLoopView, context: Context) {}
}

/// The mark's dots as layers, each on its two loops (`Motion.MarkDot`).
/// A layer drops its animations when it leaves its window, so they are
/// added each time the view joins one.
private final class MarkLoopView: UIView {
    private let dots = Motion.markDots.map { _ in UIView() }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for (dot, loop) in zip(dots, Motion.markDots) {
            dot.backgroundColor = .label
            dot.bounds.size = CGSize(width: Motion.markDot, height: Motion.markDot)
            dot.layer.cornerRadius = Motion.markDot / 2
            // At rest whenever nothing animates it.
            dot.transform = CGAffineTransform(translationX: loop.restX, y: 0)
            addSubview(dot)
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        for dot in dots { dot.center = CGPoint(x: bounds.midX, y: bounds.midY) }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        for (dot, loop) in zip(dots, Motion.markDots) {
            dot.layer.add(Motion.repeating(loop.x, keyPath: "transform.translation.x"), forKey: "x")
            dot.layer.add(Motion.repeating(loop.scale, keyPath: "transform.scale"), forKey: "scale")
        }
    }
}

/// The one "words being produced" text, the desktop's `WorkingText`: the
/// words muted (a call's object in the primary step), and over them the
/// primary step seen through a band that crosses every 3 s, the band moved
/// by its offset alone. The band is a layer Core Animation moves
/// (`ShimmerBandView`), cut to the words' shape, so the render server draws
/// each frame and no body or closure runs for one. Still muted words under
/// reduced motion, while the scene is not active and while its line is
/// folded (`workingStill`).
struct WorkingText: View {
    let words: String
    var verb: String?
    var object: String?
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.workingStill) private var still
    @Environment(\.measuring) private var measuring

    var body: some View {
        base
            .transcriptType(TranscriptType.line)
            .overlay {
                if !reduced, !measuring, !still, scenePhase == .active, !words.isEmpty {
                    ShimmerBand()
                        .mask {
                            Text(words)
                                .transcriptType(TranscriptType.line)
                        }
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
}

private struct ShimmerBand: UIViewRepresentable {
    func makeUIView(context: Context) -> ShimmerBandView { ShimmerBandView() }
    func updateUIView(_ view: ShimmerBandView, context: Context) {}
}

/// The shimmer's band: the label color through a soft-edged window as wide
/// as the words, resting off their leading edge and crossing on
/// `MotionValues.shimmerLoop`. The loop is in points, so it is made again
/// when the width changes, and added again when the view joins a window.
private final class ShimmerBandView: UIView {
    private let band = CAGradientLayer()
    private var width: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.locations = [0, 0.4, 0.6, 1]
        layer.addSublayer(band)
        tint()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: ShimmerBandView, _: UITraitCollection) in
            view.tint()
        }
    }

    required init?(coder: NSCoder) { return nil }

    private func tint() {
        let ink = UIColor.label.resolvedColor(with: traitCollection)
        let clear = ink.withAlphaComponent(0).cgColor
        band.colors = [clear, ink.cgColor, ink.cgColor, clear]
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width != width || band.bounds.height != bounds.height else { return }
        width = bounds.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.bounds = bounds
        band.position = CGPoint(x: bounds.midX, y: bounds.midY)
        // Off the words whenever nothing animates it.
        band.transform = CATransform3DMakeTranslation(-width, 0, 0)
        CATransaction.commit()
        sweep()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        sweep()
    }

    private func sweep() {
        band.removeAnimation(forKey: "sweep")
        guard window != nil, width > 0 else { return }
        band.add(Motion.repeating(MotionValues.shimmerLoop.scaled(by: width), keyPath: "transform.translation.x"), forKey: "sweep")
    }
}

/// The thread still watching, under its last closing line (the desktop's
/// `WatchingLine` in a kept fold): the watching ring, Watching in medium,
/// what it watches (`WatchWords.watchSubject`: one subagent by its title,
/// else counted) and the watch's age ticking each second, amber past 30
/// minutes on its own tasks. A tap opens the agents list when it watches
/// subagents. Once shown it stays mounted, folding closed when the watch
/// ends; folded, its clock stops (`Tick`).
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
                content(ticking: watching)
                    .frame(minHeight: watching ? TranscriptMetrics.line : 0, maxHeight: watching ? nil : 0, alignment: .top)
                    .clipped()
                    .opacity(watching ? 1 : 0)
                    .padding(.top, watching ? TranscriptMetrics.Gap.line : 0)
            }
        }
        .animation(reduced ? Motion.fast : Motion.layout, value: watching)
        .onChange(of: watching, initial: true) { _, now in if now { opened = true } }
    }

    @ViewBuilder private func content(ticking: Bool) -> some View {
        let agents = meta.background?.agents ?? []
        if let openAgents, !agents.isEmpty {
            Button(action: openAgents) { words(ticking: ticking) }
                .buttonStyle(.pressable)
                .accessibilityHint("Opens the agents")
        } else {
            words(ticking: ticking)
        }
    }

    private func words(ticking: Bool) -> some View {
        let subject = WatchWords.watchSubject(meta.background) { client.session($0)?.title }
        let since = meta.background?.watchingSince
        return Tick(every: 1, ticking: ticking) { tick in
            let nowMs = Int(tick.timeIntervalSince1970 * 1_000)
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
    /// The working line is folded (held): its mark and its shimmer stand still.
    @Entry var workingStill: Bool = false
}
