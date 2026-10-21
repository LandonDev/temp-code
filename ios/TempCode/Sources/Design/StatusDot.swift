import SwiftUI
import TempCodeContract

/// What leads a thread row. The desktop's `StatusDot` colors: waiting is
/// warning, error destructive, starting and watching info; a running thread
/// (or a settled root whose subagents still work) shows the spinner, a paused
/// one the pause mark, idle and done nothing. Dot and spinner cross-fade.
struct StatusDot: View {
    let status: SessionStatus
    /// The row is live: the spinner leads whatever the status says.
    var running = false

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
                    .font(.caption2)
                    .foregroundStyle(Tint.warning)
                    .transition(.opacity)
            case .stopped:
                // The harness is gone: a still square, the quiet opposite of the spinner.
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Color.secondary)
                    .frame(width: 6, height: 6)
                    .transition(.opacity)
            case .none:
                EmptyView()
            }
        }
        .frame(width: 14, height: 14)
        .animation(Motion.crossFade, value: mark)
        .accessibilityLabel(accessibilityLabel)
    }

    private enum Mark: Equatable {
        case spinner
        case dot(Color)
        case paused
        case stopped
        case none
    }

    private var mark: Mark {
        if running { return .spinner }
        switch status {
        case .running, .starting: return .spinner
        case .watching: return .dot(Tint.info)
        case .waiting: return .dot(Tint.warning)
        case .error: return .dot(Tint.destructive)
        case .paused: return .paused
        case .stopped: return .stopped
        case .idle, .done, .unknown: return .none
        }
    }

    private var accessibilityLabel: String {
        switch mark {
        case .spinner: "Running"
        case .paused: "Paused"
        case .stopped: "Stopped"
        case .none: ""
        case .dot:
            switch status {
            case .waiting: "Needs you"
            case .error: "Failed"
            default: "Starting"
            }
        }
    }
}
