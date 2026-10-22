import SwiftUI
import TempCodeClient
import TempCodeContract

/// The chat bar's status line, above the capsule only while there is
/// something to say (BottomDock decides). It sits on the capsule's text
/// edge, one footnote line at 32 pt that scales with the text size, its
/// actions as small glass buttons at the trailing edge. Five states
/// (WorkingPhase): Sending… bridging a send to the turn's start; the
/// spinner, a flavour word turning every seven seconds and the elapsed in
/// tabular digits; Paused in the warning tint with the frozen elapsed (on a
/// master, how many batch threads paused with it), Stop and Continue; Stopped
/// when the harness is gone, with Resume; Queued with the host's reason and
/// Start now. While idle, a locked relayed host's one line. The words are
/// the client package's `StripWords`: a title, then a quieter detail as its
/// own text, never joined with a dot. Only opacity animates between states.
struct WorkingStripView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    /// The strip action out on the wire, so only its control says so.
    @State private var acting: Acting?
    @ScaledMetric(relativeTo: .footnote) private var height: CGFloat = 32

    /// High frequency, so opacity alone and under 150 ms.
    static let fade: Animation = .easeOut(duration: 0.12)

    private var phase: WorkingPhase { WorkingPhase(status: session?.status, sending: thread.sending) }

    private enum Acting {
        case stop, resume, start
    }

    /// How many of a paused master's batch threads are paused with it (the
    /// desktop's `pausedText` rule); 0 for anything but a master.
    static func batchPaused(of id: String, in sessions: [SessionMeta]) -> Int {
        WorkingPhase.batchPaused(of: id, in: sessions)
    }

    var body: some View {
        let phase = phase
        ZStack {
            switch phase {
            case .idle:
                // Thread 29: a locked relayed host's one line.
                RelayStripLine(client: client)
                    .padding(.horizontal, ComposerBar.textInset - 4)
            case .sending:
                line {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Sending…")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
            case .working:
                line {
                    ProgressView()
                        .controlSize(.mini)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let elapsed = TimeFormat.elapsed(since: session?.busySince ?? session?.updatedAt ?? 0, now: context.date)
                        HStack(spacing: 8) {
                            SwapText(Self.flavour(seed: sessionId, now: context.date.timeIntervalSince1970), step: .meta)
                            Text(elapsed)
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                                .numeric(elapsed)
                        }
                    }
                    Spacer(minLength: 0)
                }
            case .paused:
                pausedRow
            case .stopped:
                stoppedRow
            case .queued:
                queuedRow
            }
        }
        .frame(minHeight: height)
        .frame(maxWidth: .infinity)
        .animation(Self.fade, value: phase)
        .accessibilityElement(children: .contain)
    }

    /// A line on the capsule's text edge.
    private func line<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8, content: content)
            .font(.footnote)
            .padding(.horizontal, ComposerBar.textInset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
    }

    /// The words of a state: its glyph, the title at medium weight, an
    /// optional stamp in tertiary tabular digits, the detail in secondary.
    private func words(_ words: StripWords, symbol: String, tint: Color, stamp: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .font(.caption.weight(.medium))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(words.title)
                .font(.footnote.weight(.medium))
            if let stamp {
                Text(stamp)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            if let detail = words.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Paused: the glyph in the warning tint, the frozen elapsed, the batch
    /// on a master, then Stop and Continue.
    private var pausedRow: some View {
        let batch = session?.isMaster == true ? Self.batchPaused(of: sessionId, in: client.sessions) : 0
        return row {
            words(.paused(batch: batch), symbol: "pause.fill", tint: Tint.warning, stamp: TimeFormat.duration(ms: max(0, session?.frozenActiveElapsed ?? 0)))
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
        let frozen = session?.frozenActiveElapsed ?? 0
        return row {
            words(.stopped, symbol: "stop.fill", tint: Color.secondary, stamp: frozen > 0 ? TimeFormat.duration(ms: frozen) : nil)
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
            words(.queued(activity: session?.activity), symbol: "clock", tint: Color.secondary)
        } actions: {
            StripButton(acting == .start ? "Starting…" : "Start now", systemImage: "play.fill") {
                run(.start) { try await client.start(sessionId) }
            }
        }
    }

    /// The words on the text edge, the actions at the trailing edge; the
    /// whole row dims and stops answering while the key cannot act.
    private func row<Words: View, Actions: View>(@ViewBuilder _ words: () -> Words, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: 8) {
            words()
            Spacer(minLength: 0)
            actions()
        }
        .padding(.leading, ComposerBar.textInset)
        .disabled(acting != nil || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : 0.6)
        .transition(.opacity)
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

    /// The word for this second (Flavour.word, shared with the Live Activity).
    static func flavour(seed id: String, now: TimeInterval) -> String { Flavour.word(seed: id, now: now) }
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
                .font(.footnote.weight(.semibold))
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
