import SwiftUI
import TempCodeClient
import TempCodeContract

/// The slot above the composer, the desktop's (surfaces/threads/
/// WorkingStrip.tsx over `composerSlotOf`): while a turn works or waits,
/// the turn's elapsed time counted from the click (`ThreadState.sentAt`,
/// never stepped back by the host's `busySince`) and Stop, which says
/// Stopping… while its interrupt is out; Paused in the warning tint with
/// its frozen time (on a master, how many batch threads paused with it),
/// Stop and Continue; Stopped when the harness is gone, with Resume;
/// Queued with the host's reason and Start now. Nothing else: what the
/// thread does is the transcript's working line. While empty, a locked
/// relayed host's one line. One 28 pt row in the detail type on the
/// transcript's column edges, its actions small glass capsules at the
/// trailing edge. Between states and as it empties only opacity moves, over
/// `fast` (at once under reduced motion); the outgoing row stays inert
/// while it fades. BottomDock decides whether the slot takes room.
struct WorkingStripView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    let slot: ComposerSlot
    /// The slot action out on the wire, so only its control says so.
    @State private var acting: Acting?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Acting {
        case stop, resume, start
    }

    private var fade: AnyTransition {
        reduceMotion ? .identity : .opacity.animation(Motion.fast)
    }

    var body: some View {
        ZStack {
            switch slot {
            case .empty:
                // Thread 29: a locked relayed host's one line.
                RelayStripLine(client: client)
                    .transition(fade)
            case .timer:
                timerRow
                    .transition(fade)
            case .paused:
                pausedRow
                    .transition(fade)
            case .stopped:
                stoppedRow
                    .transition(fade)
            case .queued:
                queuedRow
                    .transition(fade)
            }
        }
        .frame(height: ComposerMetrics.slot)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : Motion.fast, value: slot)
        .accessibilityElement(children: .contain)
    }

    /// The open turn's time from the click, then Stop.
    private var timerRow: some View {
        row {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let now = Int(context.date.timeIntervalSince1970 * 1000)
                if let ms = ComposerSlot.elapsedMs(.timer, sentAt: thread.sentAt, busySince: session?.busySince, frozen: nil, now: now) {
                    let shown = TimeFormat.duration(ms: ms)
                    Text(shown)
                        .transcriptType(TranscriptType.detail)
                        .foregroundStyle(.secondary)
                        .numeric(shown)
                        .accessibilityLabel("Working for \(shown)")
                }
            }
        } actions: {
            StripButton(acting == .stop ? ComposerSlot.stopping : "Stop", systemImage: "stop.fill") {
                run(.stop) { try await client.stop(sessionId) }
            }
        }
    }

    /// The words of a held state: its glyph, the title at medium weight, an
    /// optional stamp in tertiary tabular digits, the detail in secondary.
    private func words(_ words: StripWords, symbol: String, tint: Color, stamp: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: TranscriptMetrics.wordGap) {
            Image(systemName: symbol)
                .transcriptFont(TranscriptType.detail, weight: .medium)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(words.title)
                .transcriptType(TranscriptType.detail, weight: .medium)
            if let stamp {
                Text(stamp)
                    .transcriptType(TranscriptType.detail)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            if let detail = words.detail {
                Text(detail)
                    .transcriptType(TranscriptType.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var frozen: String? {
        ComposerSlot.elapsedMs(slot, sentAt: nil, busySince: nil, frozen: session?.frozenActiveElapsed, now: 0).map { TimeFormat.duration(ms: $0) }
    }

    /// Paused: the glyph in the warning tint, the frozen time, the batch
    /// on a master, then Stop and Continue.
    private var pausedRow: some View {
        let batch = session?.isMaster == true ? ComposerSlot.batchPaused(of: sessionId, in: client.sessions) : 0
        return row {
            words(.paused(batch: batch), symbol: "pause.fill", tint: Tint.warning, stamp: frozen)
        } actions: {
            StripButton("Stop", systemImage: "stop.fill") {
                run(.stop) { try await client.stop(sessionId) }
            }
            StripButton(acting == .resume ? "Continuing…" : "Continue", systemImage: "play.fill", tint: Tint.warning) {
                run(.resume) { try await client.resume(sessionId) }
            }
        }
    }

    /// Stopped: the harness is gone and Resume brings it back on the same
    /// transcript (the host's one resume path for a dead harness).
    private var stoppedRow: some View {
        row {
            words(.stopped, symbol: "stop.fill", tint: Color.secondary, stamp: frozen)
        } actions: {
            StripButton(acting == .resume ? "Resuming…" : "Resume", systemImage: "arrow.clockwise", tint: Color.accentColor) {
                run(.resume) { try await client.resume(sessionId) }
            }
        }
    }

    /// Queued: the host's reason (the sibling it waits for, the running
    /// cap, memory) after the word; Start now runs it ahead.
    private var queuedRow: some View {
        row {
            words(session.map(StatusWords.queuedLine) ?? StripWords(title: "Queued"), symbol: "clock", tint: Color.secondary)
        } actions: {
            StripButton(acting == .start ? "Starting…" : "Start now", systemImage: "play.fill") {
                run(.start) { try await client.start(sessionId) }
            }
        }
    }

    /// The words on the column's leading edge, the actions at its trailing
    /// edge; the whole row dims and stops answering while the key cannot act.
    private func row<Words: View, Actions: View>(@ViewBuilder _ words: () -> Words, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: TranscriptMetrics.glyphGap) {
            words()
            Spacer(minLength: 0)
            actions()
        }
        .disabled(acting != nil || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : Motion.pressDim)
    }

    /// A refused action re-enables the control and is otherwise silent: the
    /// block is already in the composer field, and the row has no room for a line.
    private func run(_ action: Acting, _ body: @escaping () async throws -> Void) {
        guard acting == nil else { return }
        acting = action
        Task {
            defer { acting = nil }
            try? await body()
        }
    }
}

/// A small glass button in the status line: a glyph and a word on the
/// system's glass at the small control size, filled in its tint when it is
/// the one thing to do.
private struct StripButton: View {
    let title: String
    let systemImage: String
    var tint: Color?
    let action: () -> Void

    init(_ title: String, systemImage: String, tint: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .transcriptFont(TranscriptType.detail, weight: .semibold)
                .labelStyle(StripLabelStyle())
        }
        .tcGlassButton(prominent: tint != nil)
        .tint(tint)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
    }
}

/// The glyph a size down beside the word, 4 pt apart.
private struct StripLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
                .imageScale(.small)
            configuration.title
        }
    }
}
