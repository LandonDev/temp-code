import SwiftUI
import TempCodeContract

/// What leads a thread row, in a 14 pt column. The desktop's `StatusDot`
/// colors: waiting is warning, error destructive, starting and watching
/// info; a running thread (or a settled root whose subagents still work)
/// shows the spinner, a paused one the pause mark, a stopped one a still
/// square, a queued one the quiet dot, idle and done nothing. Dot, spinner
/// and mark cross-fade over 150 ms; the column never moves and scales with
/// the title's Dynamic Type. The dot is a static cue too: VoiceOver reads
/// it as the state, and an empty column is hidden from it.
struct StatusDot: View {
    let status: SessionStatus
    /// The row is live: the spinner leads whatever the status says.
    var running = false
    /// The stroke of the pause mark follows the title beside it.
    var weight: Font.Weight = .regular
    @ScaledMetric(relativeTo: .subheadline) private var column = Layout.markWidth
    @ScaledMetric(relativeTo: .subheadline) private var dot = Layout.dotSize

    var body: some View {
        ZStack {
            switch mark {
            case .spinner:
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            case .dot(let color):
                Circle()
                    .fill(color)
                    .frame(width: dot, height: dot)
                    .transition(.opacity)
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2.weight(weight))
                    .foregroundStyle(Tint.warning)
                    .transition(.opacity)
            case .stopped:
                // The harness is gone: a still square, the quiet opposite of the spinner.
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Tint.quiet)
                    .frame(width: dot - 1, height: dot - 1)
                    .transition(.opacity)
            case .empty:
                EmptyView()
            }
        }
        .frame(width: column, height: column)
        .animation(Motion.crossFade, value: mark)
        .accessibilityHidden(mark == .empty)
        .accessibilityLabel(accessibilityLabel)
    }

    private enum Mark: Equatable {
        case spinner
        case dot(Color)
        case paused
        case stopped
        case empty
    }

    private var mark: Mark {
        if running { return .spinner }
        return switch status {
        case .running: .spinner
        case .starting, .watching: .dot(Tint.info)
        case .waiting: .dot(Tint.warning)
        case .error: .dot(Tint.destructive)
        case .paused: .paused
        case .stopped: .stopped
        // Created, not booted (the host's `queued`): a dot with no urgency.
        case .queued: .dot(Tint.quiet)
        case .idle, .done, .unknown: .empty
        }
    }

    private var accessibilityLabel: String {
        switch mark {
        case .spinner: "Running"
        case .paused: "Paused"
        case .stopped: "Stopped"
        case .empty: ""
        case .dot:
            switch status {
            case .waiting: "Needs you"
            case .error: "Failed"
            case .queued: "Queued"
            case .watching: "Watching"
            default: "Starting"
            }
        }
    }
}
