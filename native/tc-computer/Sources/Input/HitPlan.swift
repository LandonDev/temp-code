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
