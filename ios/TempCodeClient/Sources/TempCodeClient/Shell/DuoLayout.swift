import Foundation

/// The layout rules that change with the window's shape on the iPhone Duo
/// (docs/IOS-DESIGN.md "iPhone Duo"): how a sheet sizes in each pose, how
/// the Inbox splits one path across two columns, and the toast's measure.
/// Pure: the app reads the size classes off SwiftUI and hands them here.
/// Every pose is a pair of size classes, never an idiom, an orientation or
/// a screen: folded portrait is compact × regular, folded landscape compact
/// × compact, unfolded (either way up) regular × regular.

/// A size class as SwiftUI reports it; an unknown one counts as compact.
public enum LayoutClass: Sendable, Hashable {
    case compact, regular
}

/// The window's two size classes, published once at the root. A sheet reads
/// these and never its own: a form sheet's own width class is compact on
/// every display.
public struct WindowClasses: Sendable, Hashable {
    public var horizontal: LayoutClass
    public var vertical: LayoutClass

    public init(horizontal: LayoutClass, vertical: LayoutClass) {
        self.horizontal = horizontal
        self.vertical = vertical
    }

    /// Today's phone: compact × regular.
    public static let phone = WindowClasses(horizontal: .compact, vertical: .regular)

    /// Both classes regular: the unfolded display, an iPad.
    public var isRegular: Bool { horizontal == .regular && vertical == .regular }
}

/// What a sheet holds, which decides how it sizes.
public enum SheetKind: Sendable, Hashable, CaseIterable {
    /// A few rows and a confirm: Start a build, New thread, Pairing, Milestone start.
    case form
    /// A form that fills the height in every pose: Project settings, Rules, Add a thread.
    case editor
    /// A list to pick from: Adopt threads, Account, Resources.
    case picker
    /// One line: Rename.
    case field
    /// As tall as what it says: the fleet confirm, Archive with resources, Archive batch.
    case confirm
    /// A document to read: Notes, the research report, the deploy log.
    case document
}

public enum SheetDetent: Sendable, Hashable {
    case medium
    case large
    /// The measured height of the sheet's content.
    case fitted
}

/// How a sheet sizes at regular width (`presentationSizing`).
public enum SheetSizing: Sendable, Hashable {
    /// The system's: a bottom sheet in a compact window.
    case automatic
    /// A centered form sheet.
    case form
    /// A centered form sheet as tall as its content.
    case formFitted
    /// A page sheet.
    case page
}

public struct SheetShape: Sendable, Hashable {
    public var detents: [SheetDetent]
    public var sizing: SheetSizing
    /// Always true: every sheet opts into horizontal bars, so Cancel, Save and
    /// Done stay text at the top as Apple's own form sheets do. Kept in the
    /// shape so the test states it.
    public var horizontalBars: Bool
    /// Only where the sheet has two detents to move between.
    public var dragIndicator: Bool

    public init(detents: [SheetDetent], sizing: SheetSizing, horizontalBars: Bool = true, dragIndicator: Bool) {
        self.detents = detents
        self.sizing = sizing
        self.horizontalBars = horizontalBars
        self.dragIndicator = dragIndicator
    }
}

public enum SheetRules {
    /// The one rule every sheet is shaped by. Folded portrait keeps today's
    /// detents. Folded landscape takes the large detent for everything that
    /// is not sized by its content: a medium detent in 466 pt of height is
    /// under a Form's third row. Unfolded, a form, a picker, a field or a
    /// confirm is a centered form sheet (a confirm fitted to its content) and
    /// a document a page sheet; nothing is a full-screen cover on a 7.6"
    /// display.
    public static func shape(_ kind: SheetKind, in window: WindowClasses) -> SheetShape {
        let detents = detents(kind, in: window)
        let sizing: SheetSizing
        if window.isRegular {
            sizing = switch kind {
            case .confirm: .formFitted
            case .document: .page
            case .form, .editor, .picker, .field: .form
            }
        } else {
            sizing = .automatic
        }
        return SheetShape(detents: detents, sizing: sizing, horizontalBars: true, dragIndicator: detents.count > 1)
    }

    private static func detents(_ kind: SheetKind, in window: WindowClasses) -> [SheetDetent] {
        switch kind {
        case .confirm: return [.fitted]
        case .editor, .document: return [.large]
        case .form, .picker, .field: break
        }
        // Only the phone's own pose offers medium.
        guard window == .phone else { return [.large] }
        return kind == .field ? [.medium] : [.medium, .large]
    }
}

/// The Inbox's two shapes share one path: the first element is the selected
/// item, the rest the detail column's pushes (a file's diff). A fold keeps
/// the item (the compact stack is list → item → diff) and an unfold shows the
/// list beside it with the diff still pushed.
public enum InboxColumns {
    public struct Split<Element: Hashable>: Hashable {
        public var selected: Element?
        public var detail: [Element]

        public init(selected: Element?, detail: [Element]) {
            self.selected = selected
            self.detail = detail
        }
    }

    public static func split<Element: Hashable>(_ path: [Element]) -> Split<Element> {
        Split(selected: path.first, detail: Array(path.dropFirst()))
    }

    /// The path back from the columns; nothing is pushed under no selection.
    public static func path<Element: Hashable>(selected: Element?, detail: [Element]) -> [Element] {
        guard let selected else { return [] }
        return [selected] + detail
    }

    /// Mail's shape: a regular window, and the tab's own column regular too
    /// (a shell that puts the Inbox in a detail column leaves it a stack).
    public static func usesSplit(_ window: WindowClasses, screen: LayoutClass) -> Bool {
        window.isRegular && screen == .regular
    }
}

/// The fleet toast's measure: full width to 440 pt, then centered. A glass
/// line across 951 pt reads as a bar, not a notice.
public enum ToastMeasure {
    public static let maxWidth: Double = 440

    public static func width(available: Double) -> Double {
        min(max(0, available), maxWidth)
    }
}
