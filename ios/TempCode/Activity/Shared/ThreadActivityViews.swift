import ActivityKit
import SwiftUI
import TempCodeContract
import WidgetKit

/// The Live Activity's presentation, shared by the extension (the lock
/// screen and the Dynamic Island) and the app (the DEBUG gallery that
/// screenshots every state). The desktop's running row, in the design doc's
/// tokens: the type glyph tinted, the title, the elapsed time in tabular
/// digits, a status mark with the task (or the word, once the thread is no
/// longer working), and a thin tally bar with `3/7` when the thread has a
/// list. Color only where it means something.
///
/// No `.animation` modifier anywhere here: WidgetKit drives a Live
/// Activity's updates with its own transition and ignores view-level
/// animation; the only motion asked for is `contentTransition` on the text
/// that changes. Reduced motion needs nothing: WidgetKit honors it.

// MARK: - the lock screen card

struct ThreadActivityCard: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ActivityTitleRow(attributes: attributes, state: state)
            ActivityStatusLine(type: attributes.threadType, state: state)
                .padding(.leading, ActivityMetrics.indent)
            if state.hasTasks {
                ActivityTally(type: attributes.threadType, state: state)
                    .padding(.leading, ActivityMetrics.indent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(nil)
        .activitySystemActionForegroundColor(attributes.threadType.tint)
    }
}

enum ActivityMetrics {
    /// The glyph's 20 pt frame plus the 8 pt gap: the lines under the title start at the title's edge.
    static let indent: CGFloat = 28
    static let barHeight: CGFloat = 3
    /// The status line's fixed height: its text changes, its height never does.
    static let lineHeight: CGFloat = 18
    /// The compact trailing clock's room: `1:02:33` fits, shrinking a little before it would clip.
    static let compactClockWidth: CGFloat = 60
}

/// Glyph, title and the clock, on one baseline.
struct ActivityTitleRow: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            TypeGlyph(type: attributes.threadType, weight: .semibold)
            Text(state.title ?? attributes.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 8)
            ActivityElapsedText(state: state)
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
    }
}

/// The status mark and one line beside it. Working: the task alone (the
/// spinner already says working, and the desktop row never spells it).
/// Paused and waiting: the word, colored, then the task or the reason.
/// Finished, failed and stopped: the word alone. One line, never taller.
struct ActivityStatusLine: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 6) {
            PhaseMark(phase: state.phase, type: type)
            if state.phase != .working {
                Text(state.phase.word)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(state.phase.wordStyle)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
            if let line = state.line {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .frame(height: ActivityMetrics.lineHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ThreadActivityText.statusLabel(phase: state.phase, task: state.task, reason: state.reason))
    }
}

/// The thin bar and the count, when the thread has a list (or a master its batch).
struct ActivityTally: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            TallyBar(fraction: state.fraction, tint: state.phase.tallyTint(for: type))
            Text(state.tally ?? "")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(state.phase == .finished && state.allDone ? AnyShapeStyle(Tint.success) : AnyShapeStyle(.secondary))
                .contentTransition(.numericText())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.tallyLabel)
    }
}

struct TallyBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(tint)
                    .frame(width: max(ActivityMetrics.barHeight, geometry.size.width * fraction))
            }
        }
        .frame(height: ActivityMetrics.barHeight)
    }
}

/// The desktop StatusDot's marks: a spinner while working, the pause mark,
/// a colored dot for waiting, failed and done, and the still square for a
/// thread whose harness is gone.
struct PhaseMark: View {
    let phase: ThreadActivityAttributes.Phase
    let type: ThreadType

    var body: some View {
        ZStack {
            switch phase {
            case .working:
                ProgressView()
                    .controlSize(.mini)
                    .tint(type.tint)
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2)
                    .foregroundStyle(Tint.warning)
            case .waiting, .finished, .failed:
                Circle()
                    .fill(phase.dotTint(for: type))
                    .frame(width: 7, height: 7)
            case .stopped:
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Color.secondary)
                    .frame(width: 6, height: 6)
            }
        }
        .frame(width: 14, height: 14)
    }
}

/// The elapsed time, ticking on the device from `since`. A working thread's
/// clock runs; a paused or settled one is frozen at the state's time, so the
/// final state reads as it was (a waiting end shows the work time, not the
/// time spent waiting: that count belongs to the app's Needs-you row).
struct ActivityElapsedText: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let since = Date(timeIntervalSince1970: Double(state.since) / 1000)
        let frozen = Date(timeIntervalSince1970: Double(state.ts) / 1000)
        Text(timerInterval: since...Date.distantFuture, pauseTime: state.phase == .working ? nil : max(since, frozen), countsDown: false, showsHours: true)
            .monospacedDigit()
    }
}

// MARK: - the Dynamic Island's slots

/// Compact leading: the type glyph while the thread is at work or held; once
/// it settled, the mark of its final state.
struct ActivityCompactLeading: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        if state.phase.isSettled {
            PhaseMark(phase: state.phase, type: type)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.phase.word)
        } else {
            TypeGlyph(type: type, weight: .semibold)
        }
    }
}

/// Compact trailing: the tally when the thread has a list, else the clock,
/// bounded so an hour-long thread's `1:02:33` shrinks instead of clipping;
/// the phase colors it once the thread stops working.
struct ActivityCompactTrailing: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        Group {
            if let tally = state.tally {
                Text(tally)
                    .contentTransition(.numericText())
            } else {
                ActivityElapsedText(state: state)
                    .frame(maxWidth: ActivityMetrics.compactClockWidth)
                    .minimumScaleFactor(0.8)
            }
        }
        .font(.caption2.weight(.medium))
        .monospacedDigit()
        .foregroundStyle(state.phase.wordStyle)
        .lineLimit(1)
    }
}

/// Minimal: the status dot, in the type's tint while it works; the still
/// square for a stopped thread.
struct ActivityMinimal: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.phase == .stopped {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Color.secondary)
                    .frame(width: 6, height: 6)
            } else {
                Circle()
                    .fill(state.phase.dotTint(for: type))
                    .frame(width: 8, height: 8)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.phase.word)
    }
}

/// Expanded bottom: the status line and the tally, as on the card.
struct ActivityExpandedBottom: View {
    let type: ThreadType
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ActivityStatusLine(type: type, state: state)
            if state.hasTasks { ActivityTally(type: type, state: state) }
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 2)
    }
}

// MARK: - colors

extension ThreadActivityAttributes.Phase {
    /// The status word's style: secondary while working or stopped, colored where the phase carries meaning.
    var wordStyle: AnyShapeStyle {
        switch self {
        case .working, .stopped: AnyShapeStyle(.secondary)
        case .paused, .waiting: AnyShapeStyle(Tint.warning)
        case .finished: AnyShapeStyle(Tint.success)
        case .failed: AnyShapeStyle(Tint.destructive)
        }
    }

    /// The dot's color: the thread's type while it works, warning while it waits or pauses, destructive failed, success done, secondary stopped.
    func dotTint(for type: ThreadType) -> Color {
        switch self {
        case .working: type.tint
        case .paused, .waiting: Tint.warning
        case .finished: Tint.success
        case .failed: Tint.destructive
        case .stopped: Color.secondary
        }
    }

    /// The tally bar's fill: the type's tint while live, the outcome's once settled.
    func tallyTint(for type: ThreadType) -> Color {
        switch self {
        case .working, .waiting: type.tint
        case .paused: Tint.warning
        case .finished: Tint.success
        case .failed: Tint.destructive
        case .stopped: Color.secondary
        }
    }
}
