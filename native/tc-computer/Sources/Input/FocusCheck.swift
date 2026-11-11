import ComputerCore
import ComputerProtocol

/// What the focus check knows of the app's focused element (docs/computer-protocol.md §25.9).
public struct FocusedFacts: Equatable, Sendable {
    /// the role word a line prints (`input`, `search`, `combo box`, `button`)
    public var role: String
    /// it lies inside an AXWebArea
    public var inWebArea: Bool
    /// its index and line in the model's latest read, when the read listed it
    public var brief: ElementBrief?
    /// `input "Address and search bar"`, for when the read never listed it
    public var line: String

    public init(role: String, inWebArea: Bool, brief: ElementBrief? = nil, line: String? = nil) {
        self.role = role
        self.inWebArea = inWebArea
        self.brief = brief
        self.line = line ?? brief?.line ?? role
    }

    /// `[9] input "…"`, or the line alone when it has no index.
    var named: String { brief.map { "[\($0.index)] \($0.line)" } ?? line }
}

/// Where the call's `expectFocus` stands for this step.
public enum FocusExpectation: Equatable, Sendable {
    /// nothing expected: no `expectFocus`, or not the step it binds
    case none
    /// the focused element is the expected one, now or after AXFocused put it back
    case held
    /// AXFocused on the expected element did not take within `focusConfirmMs`
    case lost
}

public enum FocusVerdict: Equatable, Sendable {
    case go
    /// the step fails with this `focus_moved`; nothing was sent
    case refuse(ComputerError)
}

/// §25.9: keys go where the read said. A `key`, `hold_key`, `type` or `paste` with no `element`, sent to
/// a Chromium window, is checked before its first route runs and again after a session step's activation.
public enum FocusCheck {
    /// the browser's own fields: the address bar and the find bar are inputs, searches or combo boxes
    public static let fieldRoles: Set<String> = ["input", "search", "combo box"]
    /// the bar titles of the Edit menu, whose commands change a field's text
    public static let editMenuTitles: Set<String> = ["edit"]
    /// Command combos that edit text in any app, checked like text whatever the menu says
    static let editKeys: Set<Character> = ["a", "c", "v", "x", "z", "y"]

    /// Whether the step is checked at all: a key or text verb with no element, in a Chromium window.
    public static func applies(_ action: ComputerAction, chromium: Bool) -> Bool {
        guard chromium, action.element == nil else { return false }
        switch action.action {
        case .key, .holdKey, .type, .paste: return true
        default: return false
        }
    }

    /// Whether the verb sends keys or text.
    static func sendsKeys(_ name: ComputerActionName) -> Bool {
        name == .key || name == .holdKey || name == .type || name == .paste
    }

    /// Whether a step changes anything: every verb but the reads and the waits.
    static func acts(_ name: ComputerActionName) -> Bool {
        switch name {
        case .screenshot, .zoom, .wait, .cursorPosition, .unknown: false
        default: true
        }
    }

    /// Whether the call's `expectFocus` binds step `index` of `actions`: the call's first step that sends
    /// keys or text, with no acting step before it. Once a step ran, focus is whatever it left (a `Tab`
    /// moves it on purpose), and only the browser-field rule applies to the steps after.
    public static func bindsExpectation(step index: Int, of actions: [ComputerAction]) -> Bool {
        guard actions.indices.contains(index), sendsKeys(actions[index].action) else { return false }
        return !actions[..<index].contains { acts($0.action) }
    }

    /// A `key` that cannot change a field's text: a `super` or `ctrl` combo whose menu item is enabled
    /// and outside the Edit menu (⌘L, ⌘T, ⌘F, ⌘R). Every Edit-menu command, every combo with no menu
    /// match and every `hold_key` is checked like text.
    public static func exempt(_ action: ComputerAction, menu: () -> MenuMatch?) -> Bool {
        guard action.action == .key, let combo = try? parseKeyCombo(action.text ?? ""), hasMenuModifier(combo) else { return false }
        if combo.modifiers.contains(.command), case .character(let c) = combo.key, editKeys.contains(Character(c.lowercased())) { return false }
        guard let m = menu(), m.enabled, let bar = m.path.first else { return false }
        return !editMenuTitles.contains(bar.lowercased())
    }

    /// Whether the focused element is one of the browser's own fields: outside every web area, and an input, search or combo box.
    public static func isBrowserField(_ f: FocusedFacts) -> Bool {
        !f.inWebArea && fieldRoles.contains(f.role)
    }

    /// The step's verdict: a lost expectation fails `focus_moved` (`moved`); else keys bound for a browser
    /// field fail it (`browser-field`); else the step goes. `focused` nil (nothing focused, or unreadable) goes.
    public static func verdict(_ action: ComputerAction, chromium: Bool, focused: FocusedFacts?, expectation: FocusExpectation, menu: () -> MenuMatch?) -> FocusVerdict {
        guard applies(action, chromium: chromium) else { return .go }
        if expectation == .lost {
            return .refuse(moved(focused))
        }
        guard let focused, isBrowserField(focused), !exempt(action, menu: menu) else { return .go }
        return .refuse(ComputerError(
            kind: .focusMoved,
            message: "The keys would go to \(focused.named), not the page; name the element they are for.",
            element: focused.brief?.index, reason: .browserField, focused: focused.brief
        ))
    }

    /// `focus_moved` `moved`: the focus left the element the read showed.
    static func moved(_ focused: FocusedFacts?) -> ComputerError {
        let at = focused?.named ?? "another element"
        return ComputerError(
            kind: .focusMoved,
            message: "The focus moved to \(at) since your read; name the element the keys are for.",
            element: focused?.brief?.index, reason: .moved, focused: focused?.brief
        )
    }
}
