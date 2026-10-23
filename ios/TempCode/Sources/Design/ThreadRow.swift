import SwiftUI
import TempCodeClient
import TempCodeContract

/// The one row shape every list shares: 44 pt minimum, the status dot or
/// spinner, the tinted type glyph at the title's weight, the title
/// (semibold while unseen) with one muted word after it when the thread is
/// a master, a dim line with the model and the tasks or activity (or the
/// host's verdict in destructive when the thread failed) that cross-fades
/// without changing height, the time trailing in tabular digits that roll.
/// Subagents step in with the agent glyph. No chevron: every row pushes. The
/// separator starts at the title. The model is `ThreadRowModel` in the
/// client package; this file only draws it.
///
/// `accessory` sits between the second line and the pin: an account mark, a
/// count, nothing by default. A sibling that needs more puts it there or in
/// the `menu:` slot of `.threadRowActions`, never in this file.
struct ThreadRow<Accessory: View>: View {
    let row: ThreadRowModel
    let accessory: Accessory
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var gap = Layout.rowGap
    @ScaledMetric(relativeTo: .subheadline) private var textEdge = Layout.rowTextEdge

    init(row: ThreadRowModel, @ViewBuilder accessory: () -> Accessory) {
        self.row = row
        self.accessory = accessory()
    }

    /// The weight of the title, and of every glyph beside it.
    private var weight: Font.Weight { row.emphasized ? .semibold : .regular }

    var body: some View {
        HStack(alignment: .center, spacing: gap) {
            StatusDot(status: row.status, running: row.running, weight: weight)
            if let agent = row.agent {
                AgentGlyph(type: agent, weight: weight)
            } else {
                TypeGlyph(type: row.type, weight: weight)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Layout.tagGap) {
                    Text(row.title)
                        .textStep(.title, weight: weight)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    if let tag = row.tag {
                        // The tag never truncates; the title does.
                        Text(tag)
                            .textStep(.meta)
                            .fixedSize()
                    }
                }
                ThreadRowSecondLine(line: row.secondLine, model: row.model)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                accessory
                if row.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2.weight(weight))
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Pinned")
                }
                ThreadRowTime(row: row)
            }
        }
        .padding(.leading, CGFloat(row.indent) * Layout.indent)
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight)
        .separatorAtTextEdge(textEdge + CGFloat(row.indent) * Layout.indent)
        .accessibilityElement(children: .combine)
    }
}

extension ThreadRow where Accessory == EmptyView {
    /// The row with nothing in the accessory slot.
    init(row: ThreadRowModel) {
        self.init(row: row) { EmptyView() }
    }
}

/// The model in the quiet step, then the tasks or activity in secondary, or
/// the host's verdict on a failed turn in destructive: two texts told apart
/// by their color and an 8 pt gap, never joined with a dot. The variable
/// half cross-fades when it changes (2 pt of blur) and the line never
/// changes height, so rows in one list share one.
struct ThreadRowSecondLine: View {
    let line: ThreadRowModel.SecondLine
    let model: String

    var body: some View {
        HStack(spacing: 8) {
            Text(model)
                .textStep(.meta, tint: Color(.tertiaryLabel))
                .lineLimit(1)
                .layoutPriority(1)
            switch line {
            case .failure(let summary):
                SwapText(summary, step: .meta, tint: Tint.destructive)
            case .detail(let detail):
                SwapText(detail, step: .meta)
            }
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
