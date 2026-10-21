import SwiftUI
import TempCodeClient
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
        running = HomeModel.isLive(session)
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

    /// The weight of the title, and of every glyph beside it.
    var weight: Font.Weight { unseen ? .semibold : .regular }
}

/// The one row shape every list shares: 44 pt minimum, the status dot or
/// spinner, the tinted type glyph at the title's weight, the title
/// (semibold while unseen), a dim line with the model and the tasks or
/// activity that cross-fades without changing height, the time trailing in
/// tabular digits that roll. Subagents step in with the agent glyph. No
/// chevron: every row pushes. The separator starts at the title.
struct ThreadRow: View {
    let row: ThreadRowModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var gap = Layout.rowGap
    @ScaledMetric(relativeTo: .subheadline) private var textEdge = Layout.rowTextEdge

    var body: some View {
        HStack(alignment: .center, spacing: gap) {
            StatusDot(status: row.status, running: row.running, weight: row.weight)
            if let agent = row.agent {
                AgentGlyph(type: agent, weight: row.weight)
            } else {
                TypeGlyph(type: row.type, weight: row.weight)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .textStep(.title, weight: row.weight)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                ThreadRowSecondLine(model: row.model, detail: row.detail)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                if row.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2.weight(row.weight))
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Pinned")
                }
                ThreadRowTime(row: row)
            }
        }
        .padding(.leading, row.agent == nil ? 0 : Layout.indent)
        .padding(.vertical, 6)
        .frame(minHeight: Layout.rowHeight)
        .separatorAtTextEdge(textEdge + (row.agent == nil ? 0 : Layout.indent))
        .accessibilityElement(children: .combine)
    }
}

/// The model, then the tasks or activity. The variable half cross-fades
/// when it changes (2 pt of blur) and the line never changes height.
struct ThreadRowSecondLine: View {
    let model: String
    let detail: String?

    var body: some View {
        HStack(spacing: 0) {
            Text(model)
                .textStep(.meta)
                .lineLimit(1)
                .layoutPriority(1)
            if detail != nil {
                Text(" · ")
                    .textStep(.meta)
                    .layoutPriority(1)
            }
            SwapText(detail, step: .meta)
        }
    }
}

/// A running elapsed that ticks each second, else how long ago the thread
/// moved. One or the other, never both, and the digits roll.
struct ThreadRowTime: View {
    let row: ThreadRowModel

    var body: some View {
        if row.running {
            ElapsedText(since: row.busySince ?? row.updatedAt)
        } else {
            AgoText(row.updatedAt)
        }
    }
}
