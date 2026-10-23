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
    /// The glyph's frame plus the 8 pt gap, scaled as the glyph is: the lines under the title start at the title's edge.
    @ScaledMetric(relativeTo: .subheadline) private var indent = ActivityMetrics.indent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ActivityTitleRow(attributes: attributes, state: state)
            ActivityStatusLine(type: attributes.threadType, state: state)
                .padding(.leading, indent)
            if state.hasTasks {
                ActivityTally(type: attributes.threadType, state: state)
                    .padding(.leading, indent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(nil)
        .activitySystemActionForegroundColor(attributes.threadType.tint)
    }
}

enum ActivityMetrics {
    /// The glyph's frame (Layout.glyphWidth, 20 pt) plus the 8 pt gap, at the default text size; the card scales it with the glyph.
    static let indent: CGFloat = Layout.glyphWidth + 8
    static let barHeight: CGFloat = 3
    /// The status line's fixed height: its text changes, its height never does.
    static let lineHeight: CGFloat = 18
    /// The compact trailing clock's room: `1:02:33` fits, shrinking a little before it would clip.
    static let compactClockWidth: CGFloat = 60
    /// The status mark's frame.
    static let markWidth: CGFloat = 14
    /// A group card's rows: three fit the lock screen's 160 pt; past three, two and "and N more".
    static let cardRows = 3
    /// The expanded island's rows.
    static let islandRows = 3
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
                    .fill(Tint.quiet)
                    .frame(width: 6, height: 6)
            }
        }
        .frame(width: ActivityMetrics.markWidth, height: ActivityMetrics.markWidth)
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
                    .fill(Tint.quiet)
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

// MARK: - several threads

/// The lock screen for any state: one thread's card, or the group card once
/// two or more threads share the activity. One thread links to itself and
/// its row; the group card links to Home and each row to its thread.
struct ThreadActivityLockScreen: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        if state.isGroup {
            ThreadActivityGroupCard(attributes: attributes, state: state)
                .widgetURL(ThreadActivityAttributes.homeURL)
        } else {
            let single = attributes.single(state)
            ThreadActivityCard(attributes: single.attributes, state: single.state)
                .widgetURL(single.attributes.url(seq: single.state.seq))
        }
    }
}

/// Several threads: a row per thread in the card's own two lines (glyph,
/// title and clock; the status mark with the task or the reason under the
/// title), needs-you first. Three rows fit the lock screen's height; past
/// three, two rows and "and N more", so the card never grows past it.
struct ThreadActivityGroupCard: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState
    @ScaledMetric(relativeTo: .subheadline) private var indent = ActivityMetrics.indent

    var body: some View {
        let rows = state.threads ?? []
        let total = rows.count + (state.more ?? 0)
        let shown = Array(rows.prefix(total > ActivityMetrics.cardRows ? ActivityMetrics.cardRows - 1 : ActivityMetrics.cardRows))
        VStack(alignment: .leading, spacing: 8) {
            ForEach(shown) { row in
                if let url = attributes.url(sessionId: row.id) {
                    Link(destination: url) { ActivityGroupCardRow(row: row, state: state.state(of: row), indent: indent) }
                } else {
                    ActivityGroupCardRow(row: row, state: state.state(of: row), indent: indent)
                }
            }
            if total > shown.count {
                Text(ThreadActivityText.more(total - shown.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, indent)
                    .contentTransition(.numericText())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(nil)
        .activitySystemActionForegroundColor(state.groupTint)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ThreadActivityText.groupLabel(state.counts, total: total))
    }
}

/// One thread on the group card: the single card's first two rows, one step smaller in the title.
struct ActivityGroupCardRow: View {
    let row: ThreadActivityRow
    let state: ThreadActivityAttributes.ContentState
    let indent: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                TypeGlyph(type: row.threadType, weight: .semibold)
                Text(row.title ?? "")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                ActivityElapsedText(state: state)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            ActivityStatusLine(type: row.threadType, state: state)
                .padding(.leading, indent)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Compact leading for a group: what is at work and how many. The spinner
/// and the count of working threads; with none working, the pause mark and
/// the held count; once nothing runs, the mark of the final state.
struct ActivityGroupLeading: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let counts = state.counts
        HStack(spacing: 4) {
            if counts.working > 0 {
                PhaseMark(phase: .working, type: state.leadType)
                Text("\(counts.working)")
            } else if counts.paused > 0 {
                PhaseMark(phase: .paused, type: state.leadType)
                Text("\(counts.paused)")
            } else {
                PhaseMark(phase: state.phase, type: state.leadType)
            }
        }
        .font(.caption2.weight(.semibold))
        .monospacedDigit()
        .contentTransition(.numericText())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ThreadActivityText.groupLabel(counts, total: (state.threads?.count ?? 0) + (state.more ?? 0)))
    }
}

/// Compact trailing for a group: how many threads need the person, in the
/// needs-you color with the raised hand, whenever one does; otherwise the
/// longest-running thread's clock.
struct ActivityGroupTrailing: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let waiting = state.counts.waiting
        Group {
            if waiting > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "hand.raised.fill")
                    Text("\(waiting)")
                        .contentTransition(.numericText())
                }
                .foregroundStyle(Tint.warning)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(waiting) \(waiting == 1 ? "needs" : "need") you")
            } else {
                ActivityElapsedText(state: state.longestRunning)
                    .frame(maxWidth: ActivityMetrics.compactClockWidth)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(state.phase.wordStyle)
            }
        }
        .font(.caption2.weight(.medium))
        .monospacedDigit()
        .lineLimit(1)
    }
}

/// Minimal for a group: the raised hand while anyone needs the person, else
/// the count of threads at work in the lead thread's tint; once nothing
/// runs, the final state's mark.
struct ActivityGroupMinimal: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let counts = state.counts
        Group {
            if counts.waiting > 0 {
                Image(systemName: "hand.raised.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Tint.warning)
            } else if state.phase.isLive {
                Text("\(counts.working + counts.paused)")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(counts.working > 0 ? state.leadType.tint : Tint.warning)
                    .contentTransition(.numericText())
            } else {
                PhaseMark(phase: state.phase, type: state.leadType)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ThreadActivityText.groupLabel(counts, total: (state.threads?.count ?? 0) + (state.more ?? 0)))
    }
}

/// Expanded leading for a group: how many threads the card covers, beside the camera.
struct ActivityGroupHeadline: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let total = (state.threads?.count ?? 0) + (state.more ?? 0)
        Text("\(total) threads")
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .contentTransition(.numericText())
            .accessibilityLabel(ThreadActivityText.groupLabel(state.counts, total: total))
    }
}

/// Expanded bottom for a group: one line per thread (the status mark, the
/// title, then what it is doing, what it needs, or how it ended), three at
/// most, "and N more" under them. Each row opens its thread.
struct ActivityGroupExpandedBottom: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let rows = state.threads ?? []
        let total = rows.count + (state.more ?? 0)
        let shown = Array(rows.prefix(ActivityMetrics.islandRows))
        VStack(alignment: .leading, spacing: 6) {
            ForEach(shown) { row in
                if let url = attributes.url(sessionId: row.id) {
                    Link(destination: url) { ActivityGroupIslandRow(row: row) }
                } else {
                    ActivityGroupIslandRow(row: row)
                }
            }
            if total > shown.count {
                Text(ThreadActivityText.more(total - shown.count))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, ActivityMetrics.markWidth + 6)
            }
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 2)
    }
}

struct ActivityGroupIslandRow: View {
    let row: ThreadActivityRow

    var body: some View {
        HStack(spacing: 6) {
            PhaseMark(phase: row.phase, type: row.threadType)
            Text(row.title ?? "")
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 8)
            if let detail = ThreadActivityText.rowDetail(phase: row.phase, task: row.task, reason: row.reason) {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(row.phase == .working ? AnyShapeStyle(.secondary) : row.phase.wordStyle)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
            }
        }
        .frame(height: ActivityMetrics.lineHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title ?? ""), \(ThreadActivityText.statusLabel(phase: row.phase, task: row.task, reason: row.reason))")
    }
}

extension ThreadActivityRow {
    var threadType: ThreadType { type.map(ThreadType.init(rawValue:)) ?? .chat }
}

extension ThreadActivityAttributes.ContentState {
    /// The type of the thread the group's marks take their tint from: the first working one, else the first row.
    var leadType: ThreadType {
        let rows = threads ?? []
        return (rows.first(where: { $0.phase == .working }) ?? rows.first)?.threadType ?? .chat
    }

    /// The keyline and the system action color: needs-you while anyone waits, else the lead thread's type.
    var groupTint: Color { counts.waiting > 0 ? Tint.warning : leadType.tint }

    /// The longest-running thread's clock as a state ActivityElapsedText reads.
    var longestRunning: Self {
        var clock = self
        clock.since = longestSince
        return clock
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
        case .stopped: Tint.quiet
        }
    }

    /// The tally bar's fill: the type's tint while live, the outcome's once settled.
    func tallyTint(for type: ThreadType) -> Color {
        switch self {
        case .working, .waiting: type.tint
        case .paused: Tint.warning
        case .finished: Tint.success
        case .failed: Tint.destructive
        case .stopped: Tint.quiet
        }
    }
}
