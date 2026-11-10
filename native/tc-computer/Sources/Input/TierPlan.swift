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

/// The verdict class of an action (src/shared/computer/tools.ts CLASS_OF): `ignored.process` names classes.
public func actionClass(_ name: ComputerActionName) -> ActionClass? {
    switch name {
    case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftMouseDown, .leftMouseUp: .click
    case .leftClickDrag: .drag
    case .mouseMove: .hover
    case .scroll: .scroll
    case .key, .holdKey: .key
    case .type, .paste: .type
    default: nil
    }
}

/// One way to do a step (docs/computer-protocol.md §24): the step reports it in `input.via`.
public enum Route: Equatable, Sendable {
    /// the named element's own AX action, value or selection (§5.2), and `type`'s AX rungs (§5.3)
    case element
    /// a shortcut's menu item, pressed through AX (§24.2)
    case menu
    /// the element under a click given its AX action (§24.3)
    case hit
    /// the caret put at the clicked character (§24.4)
    case caret
    /// the scroll area's bar moved (§24.5)
    case scrollBar
    /// AX page scrolls, approximately (§5.2)
    case scrollPage
    /// a paste's text set as AXSelectedText, the clipboard untouched (§24.6)
    case insert
    /// posted events, at `process` or `session`
    case events

    /// the via a learned route is named by in `ignored`; nil for the routes the host never learns about
    public var via: InputVia? {
        switch self {
        case .menu: .menu
        case .hit: .hit
        case .caret: .caret
        case .scrollBar: .scrollBar
        case .scrollPage: .scrollPage
        case .insert: .axInsert
        case .element, .events: nil
        }
    }
}

/// What the new routes need to know, read lazily: only the verb that needs a fact asks for it.
/// The engine reads them from AX; the tests give values.
public struct RouteFacts {
    /// a `key` combo's menu item (§24.2)
    public var menu: () -> MenuMatch?
    /// what a click does through AX (§24.3, §24.4)
    public var hit: () -> HitChoice?
    /// the scroll area's bar for the step's direction can be set (§24.5)
    public var scrollBar: () -> Bool
    /// the page scrolls of the scroll area under a coordinate, when no element is named
    public var pageScrolls: () -> Set<String>
    /// NSRunningApplication.isActive
    public var appActive: () -> Bool

    public init(menu: @escaping () -> MenuMatch? = { nil }, hit: @escaping () -> HitChoice? = { nil }, scrollBar: @escaping () -> Bool = { false }, pageScrolls: @escaping () -> Set<String> = { [] }, appActive: @escaping () -> Bool = { false }) {
        self.menu = menu
        self.hit = hit
        self.scrollBar = scrollBar
        self.pageScrolls = pageScrolls
        self.appActive = appActive
    }

    public static var none: RouteFacts { RouteFacts() }
}

/// One try: the route at a tier, `exact: false` when it only approximates the action.
public struct RouteStep: Equatable, Sendable {
    public var tier: Tier
    public var route: Route
    public var exact: Bool

    public init(_ tier: Tier, _ route: Route, exact: Bool = true) {
        self.tier = tier
        self.route = route
        self.exact = exact
    }
}

/// What a step runs: its tries in §24.1's order, the next tried only when one did nothing it
/// could tell (a caret that moved nothing, a page action refused on its first call).
public enum RoutePlan: Equatable, Sendable {
    /// `needed`: the lowest tier with a route that is not allowed, answered once every try fell through
    case runs([RouteStep], needed: Tier?, menu: [String]?)
    /// no allowed route; `menu` names a disabled item that kept the process keys out
    case needs(Tier, menu: [String]?)
    /// the combo's menu item is disabled while the app is active: nothing is posted
    case disabledMenu([String])
    case noInput
}

public enum RouteChoice: Equatable, Sendable {
    case run(Tier, Route, exact: Bool)
    case needs(Tier, menu: [String]?)
    case disabledMenu([String])
    case noInput
}

private struct Candidate {
    var step: RouteStep
    var ignored: Bool
}

private let tierRank: [Tier: Int] = [.ax: 0, .process: 1, .session: 2]

private func isPlainClick(_ action: ComputerAction) -> Bool {
    (action.text ?? "").isEmpty && action.duration == nil
}

/// Every route a verb has (§24.1's table), in its order, those the facts allow.
private func candidates(_ action: ComputerAction, element f: ElementFacts?, facts: RouteFacts, ignored: IgnoredRoutes?, disabled: inout MenuMatch?) -> [Candidate] {
    let ignoredVias = Set(ignored?.via ?? [])
    let processIgnored = actionClass(action.action).map { (ignored?.process ?? []).contains($0) } ?? false
    func c(_ tier: Tier, _ route: Route, exact: Bool = true) -> Candidate {
        let named = route.via.map(ignoredVias.contains) ?? false
        return Candidate(step: RouteStep(tier, route, exact: exact), ignored: named || (route == .events && tier == .process && processIgnored))
    }
    let events = [c(.process, .events), c(.session, .events)]
    let plain = isPlainClick(action)
    switch action.action {
    case .key:
        guard let combo = try? parseKeyCombo(action.text ?? ""), hasMenuModifier(combo) else { return events }
        guard let m = facts.menu() else { return events }
        if m.enabled { return [c(.ax, .menu)] + events }
        // the same key goes through the same disabled item: only activation re-validates it
        disabled = m
        return facts.appActive() ? [] : [c(.session, .events)]
    case .leftClick where plain:
        if let f, f.actions.contains("AXPress") || f.selectableRow { return [c(.ax, .element)] + events }
        switch facts.hit()?.action {
        case .caret: return [c(.ax, .caret)] + events
        case .some: return [c(.ax, .hit)] + events
        case nil: return events
        }
    case .rightClick where plain:
        if f?.actions.contains("AXShowMenu") == true { return [c(.ax, .element)] + events }
        return (facts.hit()?.action == .showMenu ? [c(.ax, .hit)] : []) + events
    case .doubleClick where plain:
        if f?.actions.contains("AXOpen") == true { return [c(.ax, .element)] + events }
        return (facts.hit()?.action == .open ? [c(.ax, .hit)] : []) + events
    case .scroll where (action.text ?? "").isEmpty:
        let bar = facts.scrollBar() ? [c(.ax, .scrollBar)] : []
        let pages = (f?.pageScrolls ?? []).union(f == nil ? facts.pageScrolls() : [])
        let page = pageScrollAction(action.scroll_direction).map(pages.contains) == true ? [c(.ax, .scrollPage, exact: false)] : []
        return bar + [c(.process, .events)] + page + [c(.session, .events)]
    case .type:
        guard let f else { return events }
        let ax = f.settable.contains("AXSelectedText") || (f.settable.contains("AXValue") && f.valueEmptyOrAllSelected)
        return (ax ? [c(.ax, .element)] : []) + events
    case .paste:
        // AX inserts plain text: a rich paste takes it only into an input, which pastes plain text anyway
        let plainFormat = action.format == nil || action.format == .text || f?.role == "input"
        let ax = f?.settable.contains("AXSelectedText") == true && plainFormat
        return (ax ? [c(.ax, .insert)] : []) + events
    case .setValue, .selectText:
        return [c(.ax, .element)]
    case .perform:
        return isRaise(action) ? [c(.session, .element)] : [c(.ax, .element)]
    default:
        return postsEvents(action.action) ? events : []
    }
}

/// §24.1: the step's tries, first found: (1) an exact route at `ax`, then at `process`, that
/// `ignored` does not name; (2) an approximate route not named there; (3) a route at `session`;
/// (4) the routes `ignored` names, exact first (none with `skip`). A held button or key forces its
/// tier on every action that posts events. With no allowed route: `needs` naming the lowest tier
/// with one.
public func planRoutes(_ action: ComputerAction, element: ElementFacts?, facts: RouteFacts = .none, tiers: [Tier], held: Tier?, ignored: IgnoredRoutes? = nil) -> RoutePlan {
    switch action.action {
    case .screenshot, .zoom, .cursorPosition, .wait, .unknown:
        return .noInput
    default:
        break
    }
    if let held, postsEvents(action.action) {
        return tiers.contains(held) ? .runs([RouteStep(held, .events)], needed: nil, menu: nil) : .needs(held, menu: nil)
    }
    let allowed = Set(tiers.filter { tierRank[$0] != nil })
    var disabled: MenuMatch?
    var all = candidates(action, element: element, facts: facts, ignored: ignored, disabled: &disabled)
    if let disabled, all.isEmpty { return .disabledMenu(disabled.path) }
    if ignored?.skip == true { all.removeAll(where: \.ignored) }
    let runnable = all.filter { allowed.contains($0.step.tier) }
    let fresh = runnable.filter { !$0.ignored }
    let band1 = fresh.filter { $0.step.exact && $0.step.tier != .session }
    let band2 = fresh.filter { !$0.step.exact }
    let band3 = fresh.filter { $0.step.exact && $0.step.tier == .session }
    let stale = runnable.filter(\.ignored)
    let band4 = stale.filter(\.step.exact) + stale.filter { !$0.step.exact }
    let ordered = (band1 + band2 + band3 + band4).map(\.step)
    let needed = all.map(\.step.tier).filter { !allowed.contains($0) && tierRank[$0] != nil }.min { tierRank[$0]! < tierRank[$1]! }
    if ordered.isEmpty { return .needs(needed ?? .session, menu: disabled?.path) }
    return .runs(ordered, needed: needed, menu: disabled?.path)
}

/// The first try of `planRoutes`.
public func chooseRoute(_ action: ComputerAction, element: ElementFacts?, facts: RouteFacts = .none, tiers: [Tier], held: Tier?, ignored: IgnoredRoutes? = nil) -> RouteChoice {
    switch planRoutes(action, element: element, facts: facts, tiers: tiers, held: held, ignored: ignored) {
    case .runs(let steps, _, _): .run(steps[0].tier, steps[0].route, exact: steps[0].exact)
    case .needs(let t, let menu): .needs(t, menu: menu)
    case .disabledMenu(let path): .disabledMenu(path)
    case .noInput: .noInput
    }
}

/// The tier of `chooseRoute`'s first try, for the callers that need only that.
public func chooseTier(_ action: ComputerAction, element: ElementFacts?, tiers: [Tier], held: Tier?) -> TierChoice {
    switch chooseRoute(action, element: element, tiers: tiers, held: held) {
    case .run(let t, _, let exact): .run(t, exact: exact)
    case .needs(let t, _): .needs(t)
    case .disabledMenu: .needs(.session)
    case .noInput: .noInput
    }
}
