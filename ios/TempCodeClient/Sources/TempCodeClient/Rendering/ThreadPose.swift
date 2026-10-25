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
    /// Two panes need a regular column at least this wide: two 300 pt panes,
    /// the narrowest a chat column with 17 pt body text reads at (Messages in
    /// an iPad one-third split is 320). The folded Duo is 466 wide, so the
    /// hero views are phone-width lists already and need no more.
    public static let twoPaneMinWidth: CGFloat = 600

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

    /// The columns of a two-pane screen `width` wide. Default: equal halves
    /// around a `hairline` (in unfolded landscape with no sidebar the
    /// hairline lands on the fold). With an active division band that is
    /// vertical (`height > width`) and leaves at least `minimum` on each
    /// side, the band is the gap: the fold divides, nothing is drawn under
    /// it. A horizontal band (unfolded portrait partly open) or one too near
    /// an edge changes nothing. `division` is in the body's own coordinates.
    public static func columns(width: CGFloat, hairline: CGFloat, division: CGRect?, minimum: CGFloat = 280) -> TwoPaneColumns {
        if let band = division, band.height > band.width, band.minX >= minimum, width - band.maxX >= minimum {
            return TwoPaneColumns(hero: band.minX, gap: band.width, chat: width - band.maxX, gapIsDivision: true)
        }
        let hero = floor((width - hairline) / 2)
        return TwoPaneColumns(hero: hero, gap: hairline, chat: width - hero - hairline)
    }
}

/// A lone transcript's reading width: 640 pt, centred, the dock matched to
/// it. Applied only in `.single`; a two-pane chat column is at most 475, so
/// the same arithmetic leaves the edge inset there.
public enum ReadingMeasure {
    /// The widest a transcript reads at; the plan page and the research report cap here too.
    public static let cap: CGFloat = 640
    /// The row inset at the screen's edge, as on the phone.
    public static let edge: CGFloat = 16

    /// The inset from each side to the text column: the edge, or more to
    /// centre a column no wider than the cap.
    public static func sideInset(width: CGFloat) -> CGFloat {
        max(edge, (width - cap) / 2)
    }

    /// The dock's width: the screen's, or the cap plus its edges, so the
    /// capsule keeps its outdent from the text column.
    public static func dockWidth(width: CGFloat) -> CGFloat {
        min(width, cap + 2 * edge)
    }
}

/// Where a transcript lands after its width changes (a fold, an unfold, the
/// sidebar toggling, the mode switch): its end when the reader is there,
/// else the row at the top edge, at the top. SwiftUI's `List` exposes no
/// row-relative offset to restore, so a reader inside a long reply lands at
/// that reply's top; the default (a constant offset over re-wrapped rows)
/// drifts further. A size change is not an open: `TranscriptLanding` is
/// untouched.
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

    /// A fold resizes in steps about 200 ms apart with the rows re-wrapping
    /// between them; the anchor is restored at each of these delays after
    /// the last step and held until the last one. Each new step restarts
    /// the run.
    public static let restoreDelaysMs = [0, 250, 600]
}
