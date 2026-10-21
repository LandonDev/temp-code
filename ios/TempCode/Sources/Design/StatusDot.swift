import SwiftUI
import TempCodeContract

/// What leads a thread row, in a 14 pt column. The desktop's `StatusDot`
/// colors: waiting is warning, error destructive, starting and watching
/// info; a running thread (or a settled root whose subagents still work)
/// shows the spinner, a paused one the pause mark, idle and done nothing.
/// Dot, spinner and mark cross-fade over 150 ms; the column never moves.
/// The dot is a static cue too: VoiceOver reads it as the state.
struct StatusDot: View {
    let status: SessionStatus
    /// The row is live: the spinner leads whatever the status says.
    var running = false
    /// The stroke of the pause mark follows the title beside it.
    var weight: Font.Weight = .regular

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
                    .frame(width: 7, height: 7)
                    .transition(.opacity)
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2.weight(weight))
                    .foregroundStyle(Tint.warning)
                    .transition(.opacity)
            case .none:
                EmptyView()
            }
        }
        .frame(width: Layout.markWidth, height: Layout.markWidth)
        .animation(Motion.crossFade, value: mark)
        .accessibilityHidden(mark == .none)
        .accessibilityLabel(accessibilityLabel)
    }

    private enum Mark: Equatable {
        case spinner
        case dot(Color)
        case paused
        case none
    }

    private var mark: Mark {
        if running { return .spinner }
        switch status {
        case .running: return .spinner
        case .starting, .watching: return .dot(Tint.info)
        case .waiting: return .dot(Tint.warning)
        case .error: return .dot(Tint.destructive)
        case .paused: return .paused
        case .idle, .done, .unknown: return .none
        }
    }

    private var accessibilityLabel: String {
        switch mark {
        case .spinner: "Running"
        case .paused: "Paused"
        case .none: ""
        case .dot:
            switch status {
            case .waiting: "Needs you"
            case .error: "Failed"
            case .watching: "Watching"
            default: "Starting"
            }
        }
    }
}
