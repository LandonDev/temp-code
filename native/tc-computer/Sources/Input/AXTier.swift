import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The `ax` tier: AX actions, values, selections and page scrolls on an element. No focus
/// change the person sees, no pointer, no events. The one AX call that can reorder windows,
/// `raise`, runs only where the session tier is allowed (A12).
/// A route that did nothing it could tell: the engine tries the plan's next one (§24.1).
struct RouteFellThrough: Error {}

enum AXTier {
    /// The word for each raw action, and its inverse.
    static let rawForWord: [String: String] = Dictionary(InputTables.actionWords.map { ($0.value, $0.key) }, uniquingKeysWith: { a, _ in a })

    /// The words an element takes: what it lists, its role's defaults, and expand/collapse where they apply.
    static func words(_ e: ResolvedElement, facts: ElementFacts) -> [String] {
        var out = e.actions.compactMap(actionWord)
        out += InputTables.roleDefaults[facts.role] ?? []
        if facts.expandable { out += ["expand", "collapse"] }
        var seen = Set<String>()
        return out.filter { seen.insert($0).inserted }.filter { ($0 != "expand" && $0 != "collapse") || facts.expandable }
    }

    /// observation.ts actionWord: the listed word for a raw action, a custom action by its Name: part.
    static func actionWord(_ raw: String) -> String? {
        if InputTables.droppedActions.contains(raw) { return nil }
        if let w = InputTables.actionWords[raw] { return w }
        if raw.hasPrefix("Name:") {
            let name = raw.dropFirst(5).split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            let w = name.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: ", ", with: " ").replacingOccurrences(of: ",", with: " ")
            return w.isEmpty ? nil : w
        }
        return nil
    }

    /// `left_click` on AX: AXPress, or a row or cell selected through its table.
    static func press(_ e: ResolvedElement, facts: ElementFacts) throws {
        if e.actions.contains("AXPress") {
            let err = AX.perform(e.element, "AXPress")
            if err != .success { throw AX.failure(err, element: e.index, what: "be pressed") }
            return
        }
        guard facts.selectableRow else { throw AX.failure(.actionUnsupported, element: e.index, what: "be pressed") }
        try selectRow(e.element, index: e.index)
    }

    /// A row or cell selected through its table's AXSelectedRows, else its own AXSelected.
    static func selectRow(_ e: AXUIElement, index: Int?) throws {
        if let table = AX.ancestor(e, role: "AXTable") ?? AX.ancestor(e, role: "AXOutline"), AX.settable(table, "AXSelectedRows") {
            let row = AX.string(e, "AXRole") == "AXCell" ? (AX.element(e, "AXParent") ?? e) : e
            let err = AX.set(table, "AXSelectedRows", [row] as CFArray)
            if err == .success { return }
        }
        let err = AX.set(e, "AXSelected", kCFBooleanTrue)
        if err != .success { throw AX.failure(err, element: index, what: "be selected") }
    }

    /// `right_click` (AXShowMenu) and `double_click` (AXOpen) on AX.
    static func action(_ e: ResolvedElement, raw: String, what: String) throws {
        let err = AX.perform(e.element, raw)
        if err != .success { throw AX.failure(err, element: e.index, what: what) }
    }

    /// `perform`: a word the element lists, a role default, or expand/collapse where AXExpanded (a row's AXDisclosing) is settable.
    static func perform(_ e: ResolvedElement, word: String, facts: ElementFacts) throws {
        let accepted = words(e, facts: facts)
        guard accepted.contains(word) else {
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "[\(e.index)] has no action \"\(word)\".", element: e.index, available: accepted))
        }
        if word == "expand" || word == "collapse" {
            let attr = AX.settable(e.element, "AXExpanded") ? "AXExpanded" : "AXDisclosing"
            let err = AX.set(e.element, attr, (word == "expand" ? kCFBooleanTrue : kCFBooleanFalse)!)
            if err != .success { throw AX.failure(err, element: e.index, available: accepted, what: word) }
            return
        }
        let raw = e.actions.first { actionWord($0) == word } ?? rawForWord[word] ?? word
        if word == "press", !e.actions.contains("AXPress"), facts.selectableRow { return try press(e, facts: facts) }
        let err = AX.perform(e.element, raw)
        if err != .success { throw AX.failure(err, element: e.index, available: accepted, what: word) }
    }

    /// `set_value`: AXValue; read-only answers action_unsupported. With `readBack` (web content, §25.8)
    /// the value is read back for up to `readBackMs`, and one that does not read as asked fails
    /// `value_not_taken`; a password, or an element whose value reads nothing, keeps the write's answer.
    static func setValue(_ e: ResolvedElement, _ value: String, readBack: Bool = false, clock: InputClock? = nil) throws {
        guard AX.settable(e.element, "AXValue") else {
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "[\(e.index)]'s value can't be set.", element: e.index))
        }
        let err = AX.set(e.element, "AXValue", value as CFString)
        if err != .success { throw AX.failure(err, element: e.index, what: "take a value") }
        guard readBack, let clock, AX.string(e.element, "AXSubrole") != "AXSecureTextField" else { return }
        try confirmValue(e, clock: clock) { ReadBack.verdict(asked: value, read: AX.valueText(e.element)) }
    }

    /// `select_text`: the first match with its prefix and suffix, or the range; `place` selects it or puts the caret beside it.
    static func selectText(_ e: ResolvedElement, text: String?, range: [Int]?, prefix: String?, suffix: String?, place: Placement?) throws {
        let match: TextRange
        if let range {
            guard let r = textRange(range) else { throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "A range is [a, b] with a ≤ b.", element: e.index)) }
            match = r
        } else {
            let value = AX.string(e.element, "AXValue") ?? ""
            guard let m = findText(text ?? "", in: value, prefix: prefix, suffix: suffix) else {
                let around = [prefix.map { "after \"\($0)\"" }, suffix.map { "before \"\($0)\"" }].compactMap { $0 }.joined(separator: " and ")
                throw ComputerFailure(ComputerError(kind: .textNotFound, message: "[\(e.index)] has no \"\(text ?? "")\"\(around.isEmpty ? "" : " \(around)").", element: e.index))
            }
            match = m
        }
        guard AX.settable(e.element, "AXSelectedTextRange") else {
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "This element's selection can't be set.", element: e.index))
        }
        let err = AX.set(e.element, "AXSelectedTextRange", AX.rangeValue(selection(for: match, place: place)))
        if err != .success { throw AX.failure(err, element: e.index, what: "take a selection") }
    }

    /// `scroll` on AX, approximately: page scrolls on the element or its nearest scroll area that has them.
    /// A page action refused as unsupported on its first call moved nothing: the route falls through
    /// (§24.5, TextEdit lists them and answers -25205); a refusal after a page moved, or a timeout, fails.
    static func scrollPages(_ e: AXUIElement, index: Int?, direction: ScrollDirection, pages: Int) throws {
        guard let raw = pageScrollAction(direction) else { throw AX.failure(.actionUnsupported, element: index, what: "scroll") }
        let target = AX.actions(e).contains(raw) ? e : (AX.ancestor(e, role: "AXScrollArea").flatMap { AX.actions($0).contains(raw) ? $0 : nil })
        guard let target else { throw AX.failure(.actionUnsupported, element: index, what: "scroll \(direction.rawValue) by page") }
        for page in 0 ..< max(1, pages) {
            let err = AX.perform(target, raw)
            if err == .actionUnsupported, page == 0 { throw RouteFellThrough() }
            if err != .success { throw AX.failure(err, element: index, what: "scroll") }
        }
    }

    // MARK: the background fallbacks (§24)

    /// The role word a line prints for an element: from AX's role and subrole, as the reader prints it.
    static func roleWord(_ e: AXUIElement, fallback: String?) -> String {
        let axRole = AX.string(e, "AXRole") ?? ""
        let subrole = AX.string(e, "AXSubrole")
        return subrole.flatMap { InputTables.roleTags["\(axRole):\($0)"] } ?? InputTables.roleTags[axRole] ?? fallback ?? axRole
    }

    /// `menu`: the item read again where the lookup found it, pressed `count` times while it stays enabled.
    static func pressMenu(_ item: AXUIElement, match: MenuMatch, count: Int) throws {
        AX.setTimeout(item, seconds: InputTiming.axTimeoutS)
        for i in 0 ..< max(1, count) {
            if i > 0, AX.bool(item, "AXEnabled") == false { return }
            let err = AX.perform(item, "AXPress")
            if err != .success { throw AX.failure(err, element: nil, what: "run \(match.line)") }
        }
    }

    /// `hit`: the chosen action on the chosen element.
    static func pressHit(_ e: AXUIElement, action: HitAction) throws {
        switch action {
        case .selectRow:
            try selectRow(e, index: nil)
        case .caret:
            throw AX.failure(.actionUnsupported, element: nil, what: "be pressed")
        default:
            let err = AX.perform(e, action.raw ?? "AXPress")
            if err != .success { throw AX.failure(err, element: nil, what: "be clicked") }
        }
    }

    /// `caret`: AXFocused, then the caret at the character under the point. The evidence is the focus and
    /// the range read back for up to `caretEvidenceMs`: `none` when the app accepted the writes and moved neither.
    static func placeCaret(_ e: AXUIElement, at p: ScreenPoint, clock: InputClock) throws -> StepEffect {
        let before = (AX.bool(e, "AXFocused"), AX.range(e))
        let location = AXHit.characterIndex(e, at: p)
        AX.set(e, "AXFocused", kCFBooleanTrue)
        if let location {
            let err = AX.set(e, "AXSelectedTextRange", AX.rangeValue(TextRange(location: location, length: 0)))
            if err != .success, err != .cannotComplete { throw AX.failure(err, element: nil, what: "take the caret") }
        }
        let deadline = clock.seconds() + Double(InputTiming.caretEvidenceMs) / 1000
        repeat {
            let focused = AX.bool(e, "AXFocused")
            let range = AX.range(e)
            if focused == true, before.0 != true { return .changed }
            if let range, range != before.1 { return .changed }
            clock.sleep(ms: 10)
        } while clock.seconds() < deadline
        // already focused with the caret there is a click that changed nothing
        return before.0 == nil && before.1 == nil ? .unknown : .none
    }

    /// `scroll-bar`: the area's bar for the direction, moved by the wheel's distance (§24.5).
    /// Nil when it has no such bar that takes a value.
    static func moveScrollBar(_ area: AXUIElement, direction: ScrollDirection, clicks: Int) throws -> ScrollBarMove? {
        guard let (axis, _) = scrollBar(for: direction), let bar = AX.element(area, axis.attribute), AX.settable(bar, "AXValue"),
              let value = AX.number(bar, "AXValue"), let visible = AX.frame(area),
              let contents = AX.elements(area, "AXContents").first.flatMap(AX.frame) else { return nil }
        let content = axis == .vertical ? contents.h : contents.w
        let view = axis == .vertical ? visible.h : visible.w
        let move = scrollBarMove(value: value, direction: direction, clicks: clicks, content: content, visible: view)
        if case .set(let next) = move {
            let err = AX.set(bar, "AXValue", NSNumber(value: next))
            if err != .success { throw AX.failure(err, element: nil, what: "scroll") }
        }
        return move
    }

    /// Whether a scroll area has a bar for the direction that takes a value.
    static func hasScrollBar(_ area: AXUIElement, direction: ScrollDirection) -> Bool {
        guard let (axis, _) = scrollBar(for: direction), let bar = AX.element(area, axis.attribute) else { return false }
        return AX.settable(bar, "AXValue")
    }

    /// Plain text set as AXSelectedText at the caret, the clipboard untouched: `paste`'s `ax-insert`
    /// route and `type`'s first rung. False when the element takes no insert.
    static func insertPlain(_ e: AXUIElement, _ text: String) -> Bool {
        guard AX.settable(e, "AXSelectedText") else { return false }
        return AX.set(e, "AXSelectedText", text as CFString) == .success
    }

    /// `type`'s AX rungs on the element: AXSelectedText (insert) when settable, else AXValue when it is empty or wholly selected.
    /// Nil when neither applies; throws when the write itself failed.
    static func insert(_ e: AXUIElement, _ text: String, index: Int?) throws -> InputVia? {
        if insertPlain(e, text) { return .axInsert }
        if AX.settable(e, "AXValue"), valueEmptyOrAllSelected(e) {
            let err = AX.set(e, "AXValue", text as CFString)
            if err == .success { return .axValue }
            throw AX.failure(err, element: index, what: "take text")
        }
        return nil
    }

    static func valueEmptyOrAllSelected(_ e: AXUIElement) -> Bool {
        let value = AX.string(e, "AXValue") ?? ""
        if value.isEmpty { return true }
        guard let r = AX.range(e) else { return false }
        return r.location == 0 && r.length == value.utf16.count
    }

    /// The tier choice's facts of an element, read from AX.
    static func facts(_ e: AXUIElement, role: String?, actions: [String]) -> ElementFacts {
        let axRole = AX.string(e, "AXRole") ?? ""
        let word = roleWord(e, fallback: role)
        var settable: Set<String> = []
        for a in ["AXValue", "AXSelectedText", "AXSelectedTextRange", "AXFocused", "AXSelected"] where AX.settable(e, a) { settable.insert(a) }
        let expandable = AX.settable(e, "AXExpanded") || AX.settable(e, "AXDisclosing")
        var selectableRow = false
        if axRole == "AXRow" || axRole == "AXCell" {
            let table = AX.ancestor(e, role: "AXTable") ?? AX.ancestor(e, role: "AXOutline")
            selectableRow = settable.contains("AXSelected") || table.map { AX.settable($0, "AXSelectedRows") } == true
        }
        var pageScrolls = Set(actions.filter { $0.hasPrefix("AXScroll") && $0.hasSuffix("ByPage") })
        if pageScrolls.isEmpty, let area = AX.ancestor(e, role: "AXScrollArea") {
            pageScrolls = Set(AX.actions(area).filter { $0.hasPrefix("AXScroll") && $0.hasSuffix("ByPage") })
        }
        let menuItem = axRole == "AXMenuItem" ? NamedMenuItem(path: menuPath(e), enabled: AX.bool(e, "AXEnabled") ?? false) : nil
        return ElementFacts(role: word, actions: Set(actions), settable: settable, expandable: expandable, selectableRow: selectableRow, pageScrolls: pageScrolls,
                            valueEmptyOrAllSelected: valueEmptyOrAllSelected(e), menuItem: menuItem)
    }

    /// A menu item's title path, `["File", "Save"]`: its own title, then up through each menu to the
    /// item, bar item or opener (a pop-up, a menu button) that holds it.
    static func menuPath(_ item: AXUIElement) -> [String] {
        var path = [AX.string(item, "AXTitle") ?? ""]
        var node = AX.element(item, "AXParent")
        for _ in 0 ..< 8 {
            guard let n = node else { break }
            let role = AX.string(n, "AXRole") ?? ""
            if role == "AXMenuBar" || role == "AXApplication" || role == "AXWindow" { break }
            if role != "AXMenu" {
                let title = AX.string(n, "AXTitle") ?? AX.string(n, "AXDescription") ?? ""
                if !title.isEmpty { path.insert(title, at: 0) }
                if role != "AXMenuItem" && role != "AXMenuBarItem" { break }
            }
            node = AX.element(n, "AXParent")
        }
        return path
    }
}
