import ComputerProtocol

/// §27.7 and §27.7a: where a key or text step with no target may go once an earlier step of the call sent input.
/// The live half (AXFocusedUIElement before and after a step, CFEqual, the call's record) gathers `Focus`; this
/// decides.
public enum FocusPlan {
    /// The app's focused element when the step comes up, as the service read it.
    public struct Focus: Sendable, Equatable {
        /// (a) it is in the target window, or in a menu, sheet or window §27.4 or §27.5 recorded for this call
        public var inScope: Bool
        /// (b) it is, or lies inside, an element an earlier step of the call targeted (`element`, `named`'s, `menu`'s)
        public var insideTargeted: Bool
        /// (b) the app's focused element changed during the step just before (before its input, after its wait);
        /// across segments, the live focus is still the element `prior.focusTo` names
        public var movedByStepBefore: Bool
        /// the step just before was a plain navigation key (`isNavigationKey`), which never licenses typing
        public var stepBeforeNavigates: Bool
        /// a secure text field (AXSecureTextField)
        public var secure: Bool
        /// §25.9's browser field (a Chromium app's own field, outside every web area): Input's rule runs first and wins
        public var browserField: Bool

        public init(inScope: Bool, insideTargeted: Bool, movedByStepBefore: Bool, stepBeforeNavigates: Bool, secure: Bool = false, browserField: Bool = false) {
            self.inScope = inScope
            self.insideTargeted = insideTargeted
            self.movedByStepBefore = movedByStepBefore
            self.stepBeforeNavigates = stepBeforeNavigates
            self.secure = secure
            self.browserField = browserField
        }
    }

    public enum Verdict: Sendable, Equatable {
        /// the step runs, at the live focus (Input checks the same element again before each write)
        case run
        /// `focus_moved` `unplanned`: no step of the call aimed there
        case unplanned
        /// `focus_moved` `secure`: a password field reached by name or by focus
        case secure
    }

    /// Whether §27.7 judges the step: a `type`, `paste`, `key` or `hold_key` with no `element` or `named`, after a
    /// step of the call that sent input (this request's, or `prior`'s for a later segment). A call's first input step
    /// keeps §25.9's `expectFocus`.
    public static func applies(_ action: ComputerAction, inputBefore: Bool) -> Bool {
        inputBefore && BatchStop.typesBlind(action)
    }

    /// The verdict on a step `applies` admits. Nothing focused (or unreadable) runs: the keys reach no field.
    public static func verdict(_ action: ComputerAction, focus: Focus?) -> Verdict {
        guard let focus, !focus.browserField else { return .run }
        let planned = focus.inScope && (focus.insideTargeted || (focus.movedByStepBefore && !focus.stepBeforeNavigates))
        guard planned else { return .unplanned }
        return writes(action) && focus.secure ? .secure : .run
    }

    /// §27.7a for a step whose destination `named` resolved: a secure field is refused before anything is written.
    public static func namedVerdict(_ action: ComputerAction, secure: Bool) -> Verdict {
        writes(action) && secure ? .secure : .run
    }

    /// The steps that write text into their destination.
    public static func writes(_ action: ComputerAction) -> Bool {
        action.action == .type || action.action == .paste || action.action == .setValue
    }

    /// The navigation keys of §27.7(b): Tab, the arrows, Home, End, Page Up and Page Down, alone or with shift.
    static let navigationKeys: Set<String> = [
        "tab", "iso_left_tab", "left", "right", "up", "down", "arrowleft", "arrowright", "arrowup", "arrowdown",
        "home", "end", "page_up", "page_down", "pageup", "pagedown", "prior", "next"
    ]
    static let shiftNames: Set<String> = ["shift", "shift_l", "shift_r"]

    /// Whether the step is a plain navigation key: moving focus with it never licenses typing.
    public static func isNavigationKey(_ action: ComputerAction) -> Bool {
        guard action.action == .key, let text = action.text?.lowercased(), !text.isEmpty else { return false }
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let key = parts.last, navigationKeys.contains(key) else { return false }
        return parts.dropLast().allSatisfy(shiftNames.contains)
    }

    /// The `focus_moved` error of a refusal: the focused element's line, and its index when the session's book has it.
    public static func error(_ verdict: Verdict, focused: ElementBrief?, line: String) -> ComputerError? {
        let at = focused.map { "[\($0.index)] \($0.line)" } ?? line
        switch verdict {
        case .run: return nil
        case .unplanned:
            return ComputerError(kind: .focusMoved, message: "\(at) has the focus, which no step of this batch aimed at; name the element the text is for.",
                                 element: focused?.index, reason: .unplanned, focused: focused)
        case .secure:
            return ComputerError(kind: .focusMoved, message: "\(at) can only be typed into by its element, so the person can be asked.",
                                 element: focused?.index, reason: .secure, focused: focused)
        }
    }
}
