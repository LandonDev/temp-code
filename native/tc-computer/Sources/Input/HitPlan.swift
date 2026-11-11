import ComputerProtocol

/// What the hit route reads of the element under a click and of each ancestor it looks at
/// (docs/computer-protocol.md §24.3). The live layer reads it from AX.
public struct HitFacts: Equatable, Sendable {
    /// the role word a line prints (`button`, `text area`, `web area`)
    public var role: String
    /// raw AX action names
    public var actions: Set<String>
    /// an AXIncrementor: a stepper's two halves
    public var isIncrementor: Bool
    /// a row or cell selectable through its table (§5.2's selection)
    public var selectableRow: Bool
    /// a text element the caret route can place a caret in
    public var isText: Bool
    /// screen points
    public var frame: ComputerProtocol.Rect?
    /// its AXWindow is the target window, or it sits in a sheet of it
    public var inTargetWindow: Bool

    public init(role: String, actions: Set<String> = [], isIncrementor: Bool = false, selectableRow: Bool = false, isText: Bool = false, frame: ComputerProtocol.Rect? = nil, inTargetWindow: Bool = true) {
        self.role = role
        self.actions = actions
        self.isIncrementor = isIncrementor
        self.selectableRow = selectableRow
        self.isText = isText
        self.frame = frame
        self.inTargetWindow = inTargetWindow
    }
}

public enum HitAction: Equatable, Sendable {
    case press, pick, increment, decrement, selectRow, showMenu, open
    /// no action: put the caret at the clicked character (§24.4)
    case caret

    /// the raw AX action it performs; nil for a selection or the caret
    public var raw: String? {
        switch self {
        case .press: "AXPress"
        case .pick: "AXPick"
        case .increment: "AXIncrement"
        case .decrement: "AXDecrement"
        case .showMenu: "AXShowMenu"
        case .open: "AXOpen"
        case .selectRow, .caret: nil
        }
    }
}

/// What a click at a point does through AX: an action on the element `level` steps up from the start.
public struct HitChoice: Equatable, Sendable {
    public var action: HitAction
    /// 0 is the start, the element under the point (or the one named)
    public var level: Int

    public init(_ action: HitAction, level: Int) {
        self.action = action
        self.level = level
    }
}

/// Whether a text element of an AX role may take the caret (§24.4): one whose AXSelectedTextRange is
/// settable, or one that takes focus, since an NSTextField nobody is editing has no field editor yet and
/// lists its range as settable only once focused.
public func takesCaret(axRole: String, rangeSettable: Bool, focusSettable: Bool) -> Bool {
    caretAXRoles.contains(axRole) && (rangeSettable || focusSettable)
}

/// The AX roles of text a caret goes into (a search field is an AXTextField by its subrole).
public let caretAXRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

/// The containers the walk stops before: pressing one would act on far more than the click.
public let hitStopRoles: Set<String> = ["window", "sheet", "dialog", "scroll area", "web area", "table", "outline", "list", "text area"]

/// The roles the caret route takes (§24.4).
public let caretRoles: Set<String> = ["text area", "input", "search", "combo box"]

/// The hit route's choice for a click (§24.3, §24.4): from the start and at most `hitAncestors`
/// ancestors (`chain[0]` the start, then each parent), stopping before a container, the first that has,
/// for `left_click`, AXPress, else AXPick, else a stepper half by the point's side of its middle, else
/// a selectable row; for `right_click` AXShowMenu; for `double_click` AXOpen. A `left_click` that
/// found none on a text start places the caret. Nil when the start is not in the target window,
/// or nothing applies: a click on content with no action cannot be done in the background.
public func chooseHit(chain: [HitFacts], verb: ComputerActionName, point: ScreenPoint?) -> HitChoice? {
    guard let start = chain.first, start.inTargetWindow else { return nil }
    let looked = chain.prefix(InputTiming.hitAncestors + 1)
    for (level, f) in looked.enumerated() {
        // a container ends the walk; a text area start is the caret's, never pressed as a container
        if hitStopRoles.contains(f.role) {
            if level == 0, !f.isText { return nil }
            if level > 0 { break }
        }
        if let a = hitAction(f, verb: verb, point: point) { return HitChoice(a, level: level) }
    }
    if verb == .leftClick, start.isText, caretRoles.contains(start.role) { return HitChoice(.caret, level: 0) }
    return nil
}

private func hitAction(_ f: HitFacts, verb: ComputerActionName, point: ScreenPoint?) -> HitAction? {
    switch verb {
    case .leftClick:
        if f.actions.contains("AXPress") { return .press }
        if f.actions.contains("AXPick") { return .pick }
        if f.isIncrementor, let frame = f.frame, let point {
            let mid = frame.y + frame.h / 2
            let up = point.y < mid
            if up, f.actions.contains("AXIncrement") { return .increment }
            if !up, f.actions.contains("AXDecrement") { return .decrement }
        }
        if f.selectableRow { return .selectRow }
        return nil
    case .rightClick:
        return f.actions.contains("AXShowMenu") ? .showMenu : nil
    case .doubleClick:
        return f.actions.contains("AXOpen") ? .open : nil
    default:
        return nil
    }
}

/// The element under a point by frames alone (§24.3), for a target window the system's hit test cannot
/// see: one covered by another app's window, or one that takes no mouse, where
/// `AXUIElementCopyElementAtPosition` answers what is on top there (another app's element, or the
/// app's menu bar). From the root, each step goes into the last child whose frame holds the point (AX
/// lists children back to front, so the last is on top); a child with no frame is looked through to its
/// own children. It stops at an element with no such child, or once `budget` nodes were read. Nil when
/// the root's own frame does not hold the point.
public func walkHit<Node>(root: Node, point: ScreenPoint, budget: Int = InputTiming.hitWalkNodes,
                          children: (Node) -> [Node], frame: (Node) -> ComputerProtocol.Rect?) -> Node? {
    guard let r = frame(root), contains(r, point) else { return nil }
    var read = 1
    var current = root
    while read < budget {
        var top: Node?
        var queue = children(current)
        while !queue.isEmpty, read < budget {
            let child = queue.removeFirst()
            read += 1
            if let f = frame(child) {
                if contains(f, point) { top = child }
            } else {
                queue.insert(contentsOf: children(child), at: 0)
            }
        }
        guard let next = top else { break }
        current = next
    }
    return current
}

private func contains(_ r: ComputerProtocol.Rect, _ p: ScreenPoint) -> Bool {
    p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
}

/// The caret write's read-back (§24.4). Focusing a field nobody was editing gives it a field editor that
/// selects the whole text, possibly after the caret's first write landed, so the range is read back and
/// written again, at most `caretWrites` times in all, until it holds.
public enum CaretWrite {
    public enum Decision: Equatable, Sendable { case done, write, wait }
    public static let caretWrites = 3

    /// The character under the point: the focused field's answer first. A field nobody was editing answers
    /// from its cell, which may name no character there (TC Probe's Digits field said 0 at its fifth digit,
    /// 2026-11-11), and once focused from the field editor that lays out the text the click lands in.
    public static func location(unfocused: Int?, focused: Int?) -> Int? {
        focused ?? unfocused
    }

    public static func next(range: TextRange?, want: TextRange, writes: Int) -> Decision {
        if range == want { return .done }
        return writes < caretWrites ? .write : .wait
    }
}
