import ComputerProtocol

/// What the tier choice needs to know of the element an action names (or, for `type`
/// without one, of the app's focused element). The live layer reads it from AX.
public struct ElementFacts: Equatable, Sendable {
    /// the role word an observation line prints (`row`, `scroll area`, `window`)
    public var role: String
    /// raw AX action names
    public var actions: Set<String>
    /// AX attributes that are settable
    public var settable: Set<String>
    /// AXExpanded, or a row's AXDisclosing, is settable
    public var expandable: Bool
    /// a row or cell whose table takes AXSelectedRows, or with AXSelected settable
    public var selectableRow: Bool
    /// the AXScroll<Dir>ByPage actions of the element, or of its nearest scroll-area ancestor that has them
    public var pageScrolls: Set<String>
    /// AXValue is empty or wholly selected, so setting it replaces nothing the person typed
    public var valueEmptyOrAllSelected: Bool

    public init(role: String, actions: Set<String> = [], settable: Set<String> = [], expandable: Bool = false, selectableRow: Bool = false, pageScrolls: Set<String> = [], valueEmptyOrAllSelected: Bool = false) {
        self.role = role
        self.actions = actions
        self.settable = settable
        self.expandable = expandable
        self.selectableRow = selectableRow
        self.pageScrolls = pageScrolls
        self.valueEmptyOrAllSelected = valueEmptyOrAllSelected
    }
}

public enum TierChoice: Equatable, Sendable {
    /// run at this tier; `exact: false` when it only approximates the action (AX page scrolls)
    case run(Tier, exact: Bool)
    /// no allowed tier can do it; the lowest that could
    case needs(Tier)
    /// the action sends no input (`cursor_position`, and the shell's `screenshot`, `zoom`, `wait`)
    case noInput
}

/// The AX page-scroll action for a direction.
public func pageScrollAction(_ d: ScrollDirection?) -> String? {
    switch d {
    case .up: "AXScrollUpByPage"
    case .down: "AXScrollDownByPage"
    case .left: "AXScrollLeftByPage"
    case .right: "AXScrollRightByPage"
    default: nil
    }
}

/// AX page scrolls for a wheel amount: one page per five clicks, at least one.
public func pagesFor(amount: Int) -> Int {
    max(1, Int((Double(amount) / 5).rounded()))
}

/// Whether an action posts events whenever it is not on AX: a held button or key forces their tier.
func postsEvents(_ name: ComputerActionName) -> Bool {
    switch name {
    case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftClickDrag, .mouseMove,
         .leftMouseDown, .leftMouseUp, .scroll, .type, .key, .holdKey, .paste:
        true
    default:
        false
    }
}

/// `perform raise` can put the window over the person's: it runs only where the session tier is allowed.
func isRaise(_ action: ComputerAction) -> Bool {
    action.action == .perform && action.name == "raise"
}

private enum Expression { case exact, approximate, no }

private func expression(_ action: ComputerAction, at tier: Tier, facts: ElementFacts?) -> Expression {
    let plain = (action.text ?? "").isEmpty && action.duration == nil
    switch tier {
    case .ax:
        switch action.action {
        case .leftClick:
            guard plain, let f = facts else { return .no }
            return f.actions.contains("AXPress") || f.selectableRow ? .exact : .no
        case .rightClick:
            return plain && facts?.actions.contains("AXShowMenu") == true ? .exact : .no
        case .doubleClick:
            return plain && facts?.actions.contains("AXOpen") == true ? .exact : .no
        case .scroll:
            guard (action.text ?? "").isEmpty, let f = facts, let a = pageScrollAction(action.scroll_direction) else { return .no }
            return f.pageScrolls.contains(a) ? .approximate : .no
        case .type:
            guard let f = facts else { return .no }
            if f.settable.contains("AXSelectedText") { return .exact }
            return f.settable.contains("AXValue") && f.valueEmptyOrAllSelected ? .exact : .no
        case .setValue, .selectText:
            return .exact
        case .perform:
            return isRaise(action) ? .no : .exact
        default:
            return .no
        }
    case .process, .session:
        switch action.action {
        case .setValue, .selectText:
            return .no
        case .perform:
            return tier == .session && isRaise(action) ? .exact : .no
        default:
            return postsEvents(action.action) ? .exact : .no
        }
    case .unknown:
        return .no
    }
}

private let allTiers: [Tier] = [.ax, .process, .session]

/// The tier an action runs at: the first allowed tier that expresses it exactly, else the
/// first that approximates it, else `needs` naming the lowest tier that could. A held
/// button or key forces its tier on every action that posts events.
public func chooseTier(_ action: ComputerAction, element: ElementFacts?, tiers: [Tier], held: Tier?) -> TierChoice {
    switch action.action {
    case .screenshot, .zoom, .cursorPosition, .wait, .unknown:
        return .noInput
    default:
        break
    }
    if let held, postsEvents(action.action) {
        return tiers.contains(held) ? .run(held, exact: true) : .needs(held)
    }
    let allowed = tiers.filter { if case .unknown = $0 { false } else { true } }
    if let t = allowed.first(where: { expression(action, at: $0, facts: element) == .exact }) { return .run(t, exact: true) }
    if let t = allowed.first(where: { expression(action, at: $0, facts: element) == .approximate }) { return .run(t, exact: false) }
    return .needs(allTiers.first { expression(action, at: $0, facts: element) != .no } ?? .session)
}
