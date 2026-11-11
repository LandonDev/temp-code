import CoreGraphics
import Foundation

// The thread screen's pose as pure values: whether it is one transcript, a
// pager of two segments or two panes side by side; where the panes split;
// when the segment bar shows; how wide a lone transcript reads; and where a
// transcript lands after its width changes. No SwiftUI here; ThreadScreen
// and TranscriptView (ios/TempCode/Sources/Thread/) read these. The inputs
// are the screen's OWN size class and width, never the device or its
// orientation: the Duo is a `.phone` with regular size classes inside, and
// the shell's split can hand the screen a column narrower than the window.

/// How the thread screen lays its segments out.
public enum ThreadLayoutMode: Equatable, Sendable {
    /// One segment (a chat, a subagent, an unknown type): the transcript alone.
    case single
    /// Two segments, one on screen at a time, swiped between (the phone).
    case pager
    /// Two segments side by side: the hero left, the chat right.
    case twoPane
}

/// Hero, gap and chat widths of a two-pane screen, in points.
public struct TwoPaneColumns: Equatable, Sendable {
    public let hero: CGFloat
    public let gap: CGFloat
    public let chat: CGFloat
    /// The gap is the fold's division band: nothing is drawn in it (the
    /// fold is the divider). False when the gap is the hairline.
    public let gapIsDivision: Bool

    public init(hero: CGFloat, gap: CGFloat, chat: CGFloat, gapIsDivision: Bool = false) {
        self.hero = hero
        self.gap = gap
        self.chat = chat
        self.gapIsDivision = gapIsDivision
    }
}

public enum ThreadPose {
    /// The hero yields first; the chat keeps at least this (the desktop's chat beside a board).
    public static let minChat: CGFloat = 360
    /// The narrowest hero worth a pane of its own.
    public static let minHero: CGFloat = 320
    /// A fitted board never passes this (the board content's 672 on the desktop).
    public static let maxFit: CGFloat = 672
    /// Two panes only when the hero gets `minHero` and the chat `minChat`.
    public static let twoPaneMinWidth: CGFloat = minHero + minChat

    /// What a settled pager's offset may be off a whole page by, in pages.
    public static let pageHair = 0.02

    /// A pager's page is in view: it is the one shown, or the pager's
    /// offset, in pages, is within a page of it (a swipe has part of it on
    /// screen). At rest the offset reads a whole number give or take a
    /// hair, so the page beside the one shown is not in view. A hero that
    /// is not in view reads nothing of its thread (`HeroGate`).
    public static func pageInView(_ page: Int, shown: Int?, progress: Double?) -> Bool {
        if shown == page { return true }
        guard let progress else { return false }
        return abs(progress - Double(page)) < 1 - pageHair
    }

    /// The mode. `regularWidth` is the shell's split pose (the width size
    /// class at the root); `width` is the thread body's own measured width.
    /// Size class first (Apple's rule: a 678 pt folded-landscape column is
    /// compact and never two-pane), then the bounds for the column the
    /// shell's sidebar leaves.
    public static func mode(segments: Int, regularWidth: Bool, width: CGFloat) -> ThreadLayoutMode {
        if segments < 2 { return .single }
        if regularWidth, width >= twoPaneMinWidth { return .twoPane }
        return .pager
    }

    /// Whether the segment bar shows. Never in `.single` (nothing to pick)
    /// or `.twoPane` (both segments are on screen). In compact height
    /// (folded landscape) it leaves while the composer has focus: with the
    /// keyboard up the body is about 150 pt, and the newest rows and the
    /// field are what a landscape phone shows. Focus, not a keyboard frame,
    /// is the signal: UIKit reports zero-height keyboards around a fold.
    public static func segmentBarShown(mode: ThreadLayoutMode, compactHeight: Bool, composerFocused: Bool) -> Bool {
        switch mode {
        case .single, .twoPane: false
        case .pager: !(compactHeight && composerFocused)
        }
    }

    /// The columns of a two-pane screen `width` wide, the desktop's split: a
    /// hero that asks for a `fit` (an implementation board's widest task)
    /// gets it within `minHero` and the smaller of half the body and
    /// `maxFit`; any other hero starts at half; the chat keeps at least
    /// `minChat` and the hero yields first. A vertical division band that
    /// leaves at least `minimum` on each side is the gap instead: the fold
    /// divides and nothing is drawn under it. A horizontal band or one too
    /// near an edge changes nothing. `division` is in the body's own coordinates.
    public static func columns(width: CGFloat, hairline: CGFloat, division: CGRect?, fit: CGFloat? = nil, minimum: CGFloat = 280) -> TwoPaneColumns {
        if let band = division, band.height > band.width, band.minX >= minimum, width - band.maxX >= minimum {
            return TwoPaneColumns(hero: band.minX, gap: band.width, chat: width - band.maxX, gapIsDivision: true)
        }
        let half = floor((width - hairline) / 2)
        var hero = fit.map { min(max($0, minHero), min(half, maxFit)).rounded(.down) } ?? half
        hero = floor(min(hero, width - hairline - minChat))
        return TwoPaneColumns(hero: hero, gap: hairline, chat: width - hero - hairline)
    }

    /// An implementation board's widest task, estimated from its labels'
    /// lengths at the board's 13 pt (no text measuring in the package): the
    /// mark, its gap and the time a row shows, plus the row's insets.
    public static func boardFit(labels: [String]) -> CGFloat? {
        guard let longest = labels.map(\.count).max(), longest > 0 else { return nil }
        let perCharacter: CGFloat = 6.6
        let chrome: CGFloat = 14 + 8 + 40 + 2 * ReadingMeasure.edge
        return (CGFloat(longest) * perCharacter + chrome).rounded(.up)
    }
}

/// The reading width: a transcript at the desktop's 768 pt column, a
/// document (the plan page, the research report, Notes) at 640, centred.
/// The composer's box, its row and the slot take the transcript's column
/// and its edges: `columnFrame` is the column plus the edge each side.
public enum ReadingMeasure {
    /// The transcript's column (`TranscriptLengths.column`).
    public static let cap = CGFloat(TranscriptLengths.column)
    /// A document's column (`TranscriptLengths.documentColumn`).
    public static let documentCap = CGFloat(TranscriptLengths.documentColumn)
    /// The row inset at the screen's edge, as on the phone.
    public static let edge: CGFloat = 16

    /// The column a segment reads at: the plan page (a document, as the
    /// research report and Notes are) at 640, every transcript at 768. A
    /// board, the fleet and the sources are lists that fill their pane.
    public static func cap(for segment: ThreadSegment) -> CGFloat {
        segment == .plan ? documentCap : cap
    }

    /// The inset from each side to the text column: the edge, or more to
    /// centre a column no wider than `cap`.
    public static func sideInset(width: CGFloat, cap: CGFloat = cap) -> CGFloat {
        max(edge, (width - cap) / 2)
    }

    /// The column and its edges: what the composer's box and the slot span,
    /// so the box's edges are the column's.
    public static func columnFrame(width: CGFloat, cap: CGFloat = cap) -> CGFloat {
        min(width, cap + 2 * edge)
    }
}

/// Where a transcript lands after its width changes (a fold, an unfold, the
/// sidebar toggling, the mode switch): its end when the reader is there,
/// else the row at the top edge, at the reader's place inside it (`Place`:
/// SwiftUI's `List` exposes no row-relative offset, so the view reads the
/// row's frame from the list's own layout and puts the same share of a
/// re-wrapped row above the edge). A size change is not an open:
/// `TranscriptLanding` is untouched.
public enum TranscriptReflow {
    public enum Anchor: Equatable, Sendable {
        case end
        case row(TranscriptRowID)
    }

    /// The anchor to restore: the end at the bottom, the top row otherwise,
    /// nil when neither is known (the list has not laid out yet).
    public static func anchor(atBottom: Bool, topRow: TranscriptRowID?) -> Anchor? {
        if atBottom { return .end }
        if let topRow { return .row(topRow) }
        return nil
    }

    /// A width change worth a reflow: more than a point (sub-point jitter
    /// from the geometry is not a fold).
    public static func widthChanged(_ from: CGFloat, _ to: CGFloat) -> Bool {
        abs(to - from) > 1
    }

    /// The row at the top edge: the earliest, in list order, of the rows on
    /// screen. A `List` never reports `scrollPosition(id:)` on iOS 27.1 and
    /// its cells get no geometry while UIKit scrolls them, so the transcript
    /// keeps the keys its rows' `onAppear`/`onDisappear` bracket instead.
    public static func topRow(onScreen: Set<TranscriptRowID>, order: [TranscriptRowID]) -> TranscriptRowID? {
        onScreen.isEmpty ? nil : order.first(where: onScreen.contains)
    }

    /// Where the reader is inside a row: how far its top sits below the
    /// list's top edge (`viewY`, negative once the row starts above it) and
    /// the share of the row above that edge (`fraction`, 0 to 1).
    public struct Place: Equatable, Sendable {
        public var viewY: Double
        public var fraction: Double

        public init(viewY: Double, fraction: Double) {
            self.viewY = viewY
            self.fraction = fraction
        }

        /// From the row's frame in the list's content (`rowTop`, `rowHeight`)
        /// and the content's y at the top edge (`edge`: the offset past the inset).
        public init(rowTop: Double, rowHeight: Double, edge: Double) {
            viewY = rowTop - edge
            fraction = rowHeight > 0 ? min(1, max(0, (edge - rowTop) / rowHeight)) : 0
        }

        /// The content's y to put at the top edge so the reader is where they
        /// were: the same share of the row above the edge when it re-wrapped
        /// (`rewrapped`: a width change), else the same points; a row that
        /// started below the edge keeps its distance from it.
        public func edge(rowTop: Double, rowHeight: Double, rewrapped: Bool) -> Double {
            guard viewY < 0, rewrapped else { return rowTop - viewY }
            return rowTop + fraction * rowHeight
        }
    }

    /// The list's item for a row: past the rows above the window (the
    /// sentinel, the empty state: `lead`), the row's place in the window.
    /// nil when the list holds a different count than the window says
    /// (`items`), so a restore never lands on the wrong row.
    public static func item(of id: TranscriptRowID, shown: [TranscriptRowID], lead: Int, items: Int) -> Int? {
        guard items == lead + shown.count + 1, let index = shown.firstIndex(of: id) else { return nil }
        return lead + index
    }

    /// A fold resizes in steps about 200 ms apart with the rows re-wrapping
    /// between them; the anchor is restored at each of these delays after
    /// the last step and held until the last one. Each new step restarts
    /// the run.
    public static let restoreDelaysMs = [0, 250, 600]
}
