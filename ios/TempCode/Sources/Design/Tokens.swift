import SwiftUI

/// The visual system of docs/IOS-DESIGN.md: system colors by meaning, three
/// text steps, the radius ladder, hairlines, and the few lengths every row shares.
/// Nothing else in the app names a color, a radius, a font step or a row
/// inset; it names these.
enum Tint {
    /// Chat type, starting and watching dots.
    static let info = Color(.systemBlue)
    /// Implementation type, `+n`, completed.
    static let success = Color(.systemGreen)
    /// Orchestration type, waiting, paused, the needs-you tint.
    static let warning = Color(.systemOrange)
    /// Errors, `−m`, failed tools.
    static let destructive = Color(.systemRed)
    /// Planning type.
    static let violet = Color(.systemPurple)
    /// Research type.
    static let cyan = Color(.systemCyan)
    /// A state with no urgency: the queued dot, the stopped square.
    static let quiet = Color(.systemGray2)
}

enum Surface {
    /// Content.
    static let background = Color(.systemBackground)
    /// Section headers, fields, the composer bar: the one gray step.
    static let chrome = Color(.secondarySystemBackground)
    /// Sheets and cards that float.
    static let raised = Color(.tertiarySystemBackground)
    static let hairline = Color(.separator)
    /// The needs-you row: warning at 8 %.
    static let needsYou = Tint.warning.opacity(0.08)
    /// What a chip or a pill sits on: one quiet step on either background.
    static let fill = Color(.tertiarySystemFill)
}

/// The radius ladder, and the arithmetic that keeps nested corners
/// concentric: the outer corner is the inner corner plus the padding between
/// them, always. Four steps are chosen (4, 8, 12, 16); every other corner is
/// derived from one of them with `around` or `inside`, and anything that is
/// round at both ends is a real `Capsule` (a pill, the chat bar at one line,
/// the segment switcher), never a large number. No screen writes a radius
/// literal; it names a step here.
enum Radius {
    /// An inline token on a line of text: a file:line, a code span's wash.
    static let inline: CGFloat = 4
    /// Chips and rows.
    static let row: CGFloat = 8
    /// Fields and cards: a row plus 4 pt of padding.
    static let field: CGFloat = 12
    /// Sheets.
    static let sheet: CGFloat = 16

    /// A bordered block in the transcript (code, an edit card, a chip's
    /// body): a row plus 2 pt, the desktop's 10 px.
    static let block = around(row, padding: 2)
    /// A wash or an icon box inside a block, 4 pt in from its edge.
    static let inner = inside(block, padding: 4)

    /// A square icon tile (a favicon, a workspace icon): a quarter of its side.
    static func tile(_ side: CGFloat) -> CGFloat { side / 4 }

    /// The outer radius around a corner of `inner` with `padding` between them.
    static func around(_ inner: CGFloat, padding: CGFloat) -> CGFloat {
        inner + padding
    }

    /// The inner radius inside a corner of `outer` with `padding` between them.
    static func inside(_ outer: CGFloat, padding: CGFloat) -> CGFloat {
        max(0, outer - padding)
    }
}

/// Every corner in the app is continuous (Apple's superellipse), never circular.
extension Shape where Self == RoundedRectangle {
    static func corner(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }

    /// `Radius.row` corners.
    static var rowCorner: RoundedRectangle { corner(Radius.row) }
    /// `Radius.field` corners.
    static var fieldCorner: RoundedRectangle { corner(Radius.field) }
    /// `Radius.sheet` corners.
    static var sheetCorner: RoundedRectangle { corner(Radius.sheet) }
    /// `Radius.block` corners.
    static var blockCorner: RoundedRectangle { corner(Radius.block) }
    /// `Radius.inline` corners.
    static var inlineCorner: RoundedRectangle { corner(Radius.inline) }
}

/// The three text steps and no more. A title is `subheadline` in `label`;
/// meta is `footnote` in `secondaryLabel`; a stamp (a time, a count, a cost)
/// is `caption2` in `tertiaryLabel` with tabular digits. Weight carries the
/// seen state and emphasis; size never does.
enum TextStep {
    case title
    case meta
    case stamp

    var font: Font {
        switch self {
        case .title: .subheadline
        case .meta: .footnote
        case .stamp: .caption2
        }
    }
}

extension View {
    /// One of the three text steps, at a weight. `tint` replaces the step's
    /// color and nothing else (a failure summary in destructive).
    func textStep(_ step: TextStep, weight: Font.Weight = .regular, tint: Color? = nil) -> some View {
        modifier(TextStepModifier(step: step, weight: weight, tint: tint))
    }
}

private struct TextStepModifier: ViewModifier {
    let step: TextStep
    let weight: Font.Weight
    let tint: Color?

    private var color: AnyShapeStyle {
        if let tint { return AnyShapeStyle(tint) }
        return switch step {
        case .title: AnyShapeStyle(.primary)
        case .meta: AnyShapeStyle(.secondary)
        case .stamp: AnyShapeStyle(.tertiary)
        }
    }

    func body(content: Content) -> some View {
        switch step {
        case .title, .meta:
            content.font(step.font.weight(weight)).foregroundStyle(color)
        case .stamp:
            content.font(step.font.weight(weight)).monospacedDigit().foregroundStyle(color)
        }
    }
}

/// The lengths every list shares, so rows, headers and separators meet on
/// the same edges.
enum Layout {
    /// The text edge: where a row's content and a header's title begin.
    static let textEdge: CGFloat = 16
    /// A row's minimum height.
    static let rowHeight: CGFloat = 44
    /// Between the status mark, the type glyph and the text.
    static let rowGap: CGFloat = 10
    /// The status dot or spinner's column.
    static let markWidth: CGFloat = 14
    /// The status dot itself.
    static let dotSize: CGFloat = 7
    /// The type or agent glyph's column.
    static let glyphWidth: CGFloat = 20
    /// How far a subagent steps in under its root.
    static let indent: CGFloat = 16
    /// Where a thread row's title begins, from the row's leading edge: the
    /// mark, the glyph and the two gaps. Separators start here.
    static let rowTextEdge: CGFloat = markWidth + rowGap + glyphWidth + rowGap
    /// A thread row's vertical padding; with two lines a row lands near 50 pt.
    static let rowVertical: CGFloat = 6
    /// Between a row's title and the one muted word after it ("Master").
    static let tagGap: CGFloat = 6
    /// A list row's insets: the text edge on both sides, nothing vertical.
    static let rowInsets = EdgeInsets(top: 0, leading: textEdge, bottom: 0, trailing: textEdge)
}

/// A one-pixel rule in `separator`, inset from the leading edge to the text edge.
struct Hairline: View {
    var inset: CGFloat = 0
    @Environment(\.displayScale) private var scale

    var body: some View {
        Surface.hairline
            .frame(height: 1 / scale)
            .padding(.leading, inset)
    }
}

extension View {
    /// A list row's separator starts at `offset` from the row's leading edge,
    /// the text edge, never under the status mark.
    func separatorAtTextEdge(_ offset: CGFloat = Layout.rowTextEdge) -> some View {
        alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + offset }
    }

    /// A one-pixel ring in `separator` (or `color`) just inside `shape`.
    func hairlineBorder(_ shape: some InsettableShape, color: Color = Surface.hairline) -> some View {
        modifier(HairlineBorder(shape: shape, color: color))
    }

    /// The grouped-list look where it fits: a card on the chrome step with
    /// field corners and a hairline ring. Rows inside separate with
    /// `Hairline(inset:)` at the text edge; chips inside use `Radius.inside`.
    func groupCard(radius: CGFloat = Radius.field) -> some View {
        background(Surface.chrome, in: RoundedRectangle.corner(radius))
            .hairlineBorder(RoundedRectangle.corner(radius))
    }

    /// A layer that floats (a pill over the transcript, a card over content):
    /// the raised surface, a hairline ring, and in light mode two soft shadows
    /// with an offset (a tight one for the edge, a wide one for the lift).
    /// Dark mode keeps the ring only.
    func raised(radius: CGFloat = Radius.field) -> some View {
        modifier(Raised(radius: radius))
    }
}

private struct HairlineBorder<S: InsettableShape>: ViewModifier {
    let shape: S
    let color: Color
    @Environment(\.displayScale) private var scale

    func body(content: Content) -> some View {
        content.overlay(shape.strokeBorder(color, lineWidth: 1 / scale))
    }
}

private struct Raised: ViewModifier {
    let radius: CGFloat
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .background(Surface.raised, in: RoundedRectangle.corner(radius))
            .hairlineBorder(RoundedRectangle.corner(radius))
            .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.06), radius: 1, y: 1)
            .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.08), radius: 12, y: 4)
    }
}
