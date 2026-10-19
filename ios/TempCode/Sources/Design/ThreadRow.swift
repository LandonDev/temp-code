import SwiftUI
import TempCodeContract

/// What one thread row reads. The shell builds it from a `SessionMeta` and
/// the cache's seen state; L4's fleet rows build the same shape by hand.
struct ThreadRowModel: Hashable {
    var title: String
    var type: ThreadType?
    var status: SessionStatus
    /// Settled work the user has not looked at: the title goes semibold.
    var unseen = false
    var model: String
    /// `done/total` with the current task when the thread has tasks, else the last activity.
    var detail: String?
    var updatedAt: Int
    var busySince: Int?
    /// The spinner leads and the trailing time runs.
    var running = false
    var pinned = false
    /// A subagent under its root: one step in, the agent glyph instead of the type.
    var agent: AgentType?
}

extension ThreadRowModel {
    init(session: SessionMeta, unseen: Bool = false) {
        let child = session.parentId != nil
        title = session.title.isEmpty ? (child ? "Subagent" : "Untitled") : session.title
        type = session.threadType
        status = session.status
        self.unseen = unseen
        model = ModelName.short(session.model)
        detail = Self.detail(of: session)
        updatedAt = session.updatedAt
        busySince = session.busySince
        running = session.status == .running || session.status == .starting || session.treeHasLiveWork == true
        pinned = session.pinned
        agent = child ? session.agentType : nil
    }

    /// The second line's variable half: tasks first, since they say where the work is.
    nonisolated static func detail(of session: SessionMeta) -> String? {
        if let tasks = session.tasks, tasks.total > 0 {
            let count = "\(tasks.done)/\(tasks.total)"
            if let current = tasks.current, !current.isEmpty { return "\(count) \(current)" }
            return count
        }
        if let activity = session.activity, !activity.isEmpty { return activity }
        return nil
    }
}

/// The one row shape every list shares: 44 pt minimum, the status dot or
/// spinner, the tinted type glyph, the title (semibold while unseen), a dim
/// line with the model and the tasks or activity, the time trailing in
/// tertiary tabular digits. Subagents step in with the agent glyph. No
/// chevron: every row pushes.
struct ThreadRow: View {
    let row: ThreadRowModel

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: row.status, running: row.running)
            if let agent = row.agent {
                AgentGlyph(type: agent)
            } else {
                TypeGlyph(type: row.type, weight: row.unseen ? .semibold : .regular)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.subheadline.weight(row.unseen ? .semibold : .regular))
                    .lineLimit(1)
                SecondLine(model: row.model, detail: row.detail)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                if row.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Pinned")
                }
                TrailingTime(row: row)
            }
        }
        .padding(.leading, row.agent == nil ? 0 : 16)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// The model, then the tasks or activity. The variable half cross-fades
/// when it changes and the line never changes height.
private struct SecondLine: View {
    let model: String
    let detail: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            Text(model)
            if let detail {
                Text(" · ")
                ZStack(alignment: .leading) {
                    Text(detail)
                        .id(detail)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
                .animation(Motion.crossFade, value: detail)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// A running elapsed that ticks each second, else how long ago the thread moved.
private struct TrailingTime: View {
    let row: ThreadRowModel

    var body: some View {
        Group {
            if row.running {
                let since = row.busySince ?? row.updatedAt
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(TimeFormat.elapsed(since: since, now: context.date))
                        .contentTransition(.numericText())
                        .animation(Motion.crossFade, value: context.date)
                }
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(TimeFormat.ago(row.updatedAt, now: context.date))
                }
            }
        }
        .font(.caption2)
        .monospacedDigit()
        .foregroundStyle(.tertiary)
    }
}
