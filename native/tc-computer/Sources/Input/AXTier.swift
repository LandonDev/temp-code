import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The `ax` tier: AX actions, values, selections and page scrolls on an element. No focus
/// change the person sees, no pointer, no events. The one AX call that can reorder windows,
/// `raise`, runs only where the session tier is allowed (A12).
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
        if let table = AX.ancestor(e.element, role: "AXTable") ?? AX.ancestor(e.element, role: "AXOutline"), AX.settable(table, "AXSelectedRows") {
            let row = AX.string(e.element, "AXRole") == "AXCell" ? (AX.element(e.element, "AXParent") ?? e.element) : e.element
            let err = AX.set(table, "AXSelectedRows", [row] as CFArray)
            if err == .success { return }
        }
        let err = AX.set(e.element, "AXSelected", kCFBooleanTrue)
        if err != .success { throw AX.failure(err, element: e.index, what: "be selected") }
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

    /// `set_value`: AXValue; read-only answers action_unsupported.
    static func setValue(_ e: ResolvedElement, _ value: String) throws {
        guard AX.settable(e.element, "AXValue") else {
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "[\(e.index)]'s value can't be set.", element: e.index))
        }
        let err = AX.set(e.element, "AXValue", value as CFString)
        if err != .success { throw AX.failure(err, element: e.index, what: "take a value") }
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
    static func scrollPages(_ e: ResolvedElement, direction: ScrollDirection, pages: Int) throws {
        guard let raw = pageScrollAction(direction) else { throw AX.failure(.actionUnsupported, element: e.index, what: "scroll") }
        let target = AX.actions(e.element).contains(raw) ? e.element : (AX.ancestor(e.element, role: "AXScrollArea").flatMap { AX.actions($0).contains(raw) ? $0 : nil })
        guard let target else { throw AX.failure(.actionUnsupported, element: e.index, what: "scroll \(direction.rawValue) by page") }
        for _ in 0 ..< max(1, pages) {
            let err = AX.perform(target, raw)
            if err != .success { throw AX.failure(err, element: e.index, what: "scroll") }
        }
    }

    /// `type`'s AX rungs on the element: AXSelectedText (insert) when settable, else AXValue when it is empty or wholly selected.
    /// Nil when neither applies; throws when the write itself failed.
    static func insert(_ e: AXUIElement, _ text: String, index: Int?) throws -> InputVia? {
        if AX.settable(e, "AXSelectedText") {
            let err = AX.set(e, "AXSelectedText", text as CFString)
            if err == .success { return .axInsert }
        }
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
        let subrole = AX.string(e, "AXSubrole")
        // the role word: from AX's role and subrole, as the reader prints it
        let word = subrole.flatMap { InputTables.roleTags["\(axRole):\($0)"] } ?? InputTables.roleTags[axRole] ?? role ?? axRole
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
        return ElementFacts(role: word, actions: Set(actions), settable: settable, expandable: expandable, selectableRow: selectableRow, pageScrolls: pageScrolls, valueEmptyOrAllSelected: valueEmptyOrAllSelected(e))
    }
}
