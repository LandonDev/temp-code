import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's working indicator in its permanently reserved row, 28 pt
/// at the default text size and scaled once with it, never animated. Six
/// states (WorkingPhase): nothing; Sending… bridging a send to the turn's
/// start; the spinner, a flavour word turning every seven seconds and the
/// elapsed in tabular digits; the paused row in the warning tint with Stop
/// and Continue (and, on a master, how many batch threads paused with it);
/// the stopped row with Resume when the harness is gone; the queued line
/// naming the sibling it waits for, with Start now. Every line sits on the
/// composer's text edge. Only opacity animates, in 120 ms.
struct WorkingStripView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    /// The strip action out on the wire, so only its control says so.
    @State private var acting: Acting?
    @ScaledMetric(relativeTo: .footnote) private var height: CGFloat = 28

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
                Color.clear
            case .sending:
                line {
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
                queuedLine
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .animation(Self.fade, value: phase)
        .accessibilityElement(children: .contain)
    }

    /// The line sits on the composer's text edge (12 of bar, 12 of field).
    private func line<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8, content: content)
            .font(.footnote)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
    }

    /// The warning row at composer width: glyph, Paused, the frozen elapsed,
    /// the batch line on a master, then Stop and Continue.
    private var pausedRow: some View {
        let batch = session?.isMaster == true ? Self.batchPaused(of: sessionId, in: client.sessions) : 0
        return HStack(spacing: 8) {
            Image(systemName: "pause.fill")
                .font(.caption)
                .foregroundStyle(Tint.warning)
            Text("Paused")
                .font(.footnote.weight(.medium))
            Text(TimeFormat.duration(ms: max(0, session?.frozenActiveElapsed ?? 0)))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            if batch > 0 {
                Text("· and \(batch) batch \(batch == 1 ? "thread" : "threads") with it")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
            StripCapsule("Stop", style: .quiet) {
                run(.stop) { try await client.stop(sessionId) }
            }
            StripCapsule(acting == .resume ? "Continuing…" : "Continue", style: .tint(Tint.warning)) {
                run(.resume) { try await client.resume(sessionId) }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 3)
        .frame(height: height)
        .background(Tint.warning.opacity(0.1), in: RoundedRectangle.rowCorner)
        .hairlineBorder(RoundedRectangle.rowCorner, color: Tint.warning.opacity(0.2))
        .disabled(acting != nil || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : 0.6)
        .transition(.opacity)
    }

    /// The neutral row: the harness is gone and Resume brings it back on
    /// the same transcript (the host's one resume path for a dead harness).
    private var stoppedRow: some View {
        let frozen = session?.frozenActiveElapsed ?? 0
        return HStack(spacing: 8) {
            Image(systemName: "stop.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Stopped")
                .font(.footnote.weight(.medium))
            Text("· the harness is gone")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if frozen > 0 {
                Text(TimeFormat.duration(ms: frozen))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            StripCapsule(acting == .resume ? "Resuming…" : "Resume", style: .filled) {
                run(.resume) { try await client.resume(sessionId) }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 3)
        .frame(height: height)
        .background(Color(.quaternarySystemFill), in: RoundedRectangle.rowCorner)
        .hairlineBorder(RoundedRectangle.rowCorner)
        .disabled(acting != nil || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : 0.6)
        .transition(.opacity)
    }

    /// A queued batch thread: the host's line ("Queued · waiting for
    /// <sibling>", with "(errored)", "(stopped)" or "(paused)" appended),
    /// else "Queued"; Start now runs it ahead of the sibling.
    private var queuedLine: some View {
        HStack(spacing: 8) {
            Text(queuedText)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            StripCapsule(acting == .start ? "Starting…" : "Start now", style: .quiet) {
                run(.start) { try await client.start(sessionId) }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 3)
        .frame(height: height)
        .disabled(acting != nil || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : 0.6)
        .transition(.opacity)
    }

    private var queuedText: String {
        if let activity = session?.activity, activity.hasPrefix("Queued") { return activity }
        return "Queued"
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

/// A capsule in the strip's row: caption semibold, 22 pt tall, quiet on the
/// fill step, filled with a tint and white text when it is the one thing to
/// do, or in the label color on the background. The hit area is the row.
private struct StripCapsule: View {
    enum Style {
        case quiet
        case tint(Color)
        case filled
    }

    let title: String
    let style: Style
    let action: () -> Void

    init(_ title: String, style: Style, action: @escaping () -> Void) {
        self.title = title
        self.style = style
        self.action = action
    }

    private var foreground: Color {
        switch style {
        case .quiet: Color.secondary
        case .tint: Color.white
        case .filled: Color(.systemBackground)
        }
    }

    private var background: Color {
        switch style {
        case .quiet: Surface.fill
        case .tint(let tint): tint
        case .filled: Color(.label)
        }
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(foreground)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .frame(minHeight: 22)
                .background(background, in: Capsule())
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
    }
}
