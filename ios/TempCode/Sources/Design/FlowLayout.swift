import SwiftUI
import TempCodeClient

/// Views left to right, wrapping as the desktop's `flex-wrap` does: as many
/// on a line as fit the proposed width, `spacing` apart, the next line
/// `lineSpacing` under the last, every line at the leading edge. Each view
/// keeps its ideal size; one wider than the line is offered the line's
/// width and holds the whole line, so at an accessibility text size the
/// views fall one per line on their own. The arithmetic is the client package's
/// `FlowRows`, where it is tested. Pure geometry, so it stays off the main
/// actor like the protocol it adopts (named with its module: the kit's
/// `Layout` enum shadows it). The failure card's actions and a user turn's
/// attachment chips wrap with it.
nonisolated struct FlowLayout: SwiftUI.Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    init(spacing: CGFloat, lineSpacing: CGFloat? = nil) {
        self.spacing = spacing
        self.lineSpacing = lineSpacing ?? spacing
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let placed = place(proposal.width, subviews)
        return CGSize(width: placed.size.width, height: placed.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let placed = place(bounds.width, subviews)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: bounds.minX + placed.xs[index], y: bounds.minY + placed.ys[index]),
                proposal: ProposedViewSize(width: CGFloat(placed.widths[index]), height: nil)
            )
        }
    }

    private func place(_ width: CGFloat?, _ subviews: Subviews) -> FlowRows.Placement {
        let sizes = subviews.map { subview -> FlowRows.Size in
            var size = subview.sizeThatFits(.unspecified)
            // Wider than the line (flex-wrap's shrunk item): it fits itself to the line and holds the whole of it.
            if let width, size.width > width { size = CGSize(width: width, height: subview.sizeThatFits(ProposedViewSize(width: width, height: nil)).height) }
            return FlowRows.Size(width: Double(size.width), height: Double(size.height))
        }
        return FlowRows.place(sizes, width: width.map(Double.init), spacing: Double(spacing), lineSpacing: Double(lineSpacing))
    }
}
