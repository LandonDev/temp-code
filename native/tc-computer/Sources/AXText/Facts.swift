import ComputerProtocol
import Foundation

private typealias T = ObservationTables

/// What one element line says, before indent, index and geometry (plan §3.1).
public struct LineFacts: Sendable, Equatable {
    public var role: String
    /// as printed: already cut
    public var name: String?
    /// as printed: already cut; nil when not shown
    public var value: String?
    public var states: [String]
    public var caret: Int?
    /// `[a, b]`
    public var selection: [Int]?
    public var actions: [String]

    public init(role: String, name: String? = nil, value: String? = nil, states: [String] = [], caret: Int? = nil, selection: [Int]? = nil, actions: [String] = []) {
        self.role = role
        self.name = name
        self.value = value
        self.states = states
        self.caret = caret
        self.selection = selection
        self.actions = actions
    }

    /// Nothing but the role: a run of these folds into a range line.
    public var isBare: Bool { name == nil && value == nil && states.isEmpty && caret == nil && selection == nil && actions.isEmpty }
}

public enum NameSource: Sendable, Equatable {
    case title, description, titleElement, placeholder, subrole
}

/// The budget's classes, dropped lowest first (§4.3 step 2).
public enum LineClass: Int, Sendable, Comparable {
    case other = 0, text, interactive

    public static func < (a: LineClass, b: LineClass) -> Bool { a.rawValue < b.rawValue }
}

/// Everything the reader knows of one element after reading its facts.
public struct ElementFacts: Sendable {
    public var line: LineFacts
    /// trimmed, uncut
    public var rawName: String?
    public var nameSource: NameSource?
    /// the value's own string (trimmed) for text dedupe; nil for none
    public var rawValue: String?
    /// the value as shown before its cut, and its whole length in scalars (the budget halves from these)
    public var fullValue: String?
    public var valueTotal: Int
    /// a hash of everything read of the value: the text (or prefix), its whole length, the selection (A6)
    public var valueHash: UInt64
    public var hasRoleDefault: Bool
    public var cls: LineClass
}

public struct FactContext: Sendable {
    public var focusedID: NodeID?
    /// inside a web area of a process whose ambient actions apply (A5)
    public var ambient: Set<String>
    /// a subtree read: values whole up to the budget
    public var wholeValues: Bool

    public init(focusedID: NodeID?, ambient: Set<String> = [], wholeValues: Bool = false) {
        self.focusedID = focusedID
        self.ambient = ambient
        self.wholeValues = wholeValues
    }
}

public enum Facts {
    /// The roles whose AXValue is text a person types; their value may be read as a prefix.
    public static let textEntryRoles: Set<String> = ["input", "search", "password", "text area", "combo box", "date"]
    /// The roles a caret or selection prints on.
    static let caretRoles: Set<String> = ["input", "search", "password", "text area", "combo box"]
    /// `read-only` applies to these when AXValue is not settable.
    static let readOnlyRoles: Set<String> = ["input", "search", "text area", "combo box", "date"]
    public static let listRoles: Set<String> = ["list", "outline", "table"]
    /// `collapsed` prints only where it says something can open (spec §4.1: rows, disclosures);
    /// Chrome reports AXExpanded false on every web node
    static let collapsibleRoles: Set<String> = ["row", "cell", "disclosure"]
    /// roles whose AXValue, when a number, is never a value a person reads
    static let containerRoles: Set<String> = ["window", "sheet", "dialog", "group", "radio group", "split", "toolbar", "tabs", "scroll area", "row", "cell", "tab",
                                              "list", "outline", "table", "web area", "menu", "menu bar"]
    static let textRoles: Set<String> = ["text", "heading"]

    /// The word for a role: a `role:subrole` entry wins; an unknown AX name splits into words.
    public static func roleWord(_ role: String, _ subrole: String?) -> String {
        if let subrole, let word = T.roleTags["\(role):\(subrole)"] { return word }
        return T.roleTags[role] ?? axWords(role)
    }

    /// `AXRulerMarker` → `ruler marker` (observation.ts `axWords`).
    public static func axWords(_ name: String) -> String {
        let chars = Array(name.hasPrefix("AX") ? String(name.dropFirst(2)) : name)
        let lowerOrDigit = { (c: Character) in c.isASCII && (c.isLowercase || c.isNumber) }
        let upper = { (c: Character) in c.isASCII && c.isUppercase }
        var first: [Character] = []
        for (i, c) in chars.enumerated() {
            if i > 0, lowerOrDigit(chars[i - 1]), upper(c) { first.append(" ") }
            first.append(c)
        }
        var out = ""
        for (i, c) in first.enumerated() {
            if i > 0, i + 1 < first.count, upper(first[i - 1]), upper(c), first[i + 1].isASCII, first[i + 1].isLowercase { out.append(" ") }
            out.append(c)
        }
        return out.lowercased().trimmed
    }

    /// The word for a raw CopyActionNames entry, or nil when it is never listed (observation.ts `actionWord`).
    public static func actionWord(_ raw: String) -> String? {
        if T.droppedActions.contains(raw) { return nil }
        if let word = T.actionWords[raw] { return word }
        if raw.hasPrefix("Name:") {
            let name = String(raw.dropFirst(5)).split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            return nonEmpty(commasToSpaces(name.trimmed.lowercased()))
        }
        if raw.hasPrefix("AX") { return nonEmpty(axWords(raw)) }
        return nonEmpty(commasToSpaces(raw.trimmed.lowercased()))
    }

    /// `, ` and `,` → one space: the action list is comma-separated.
    static func commasToSpaces(_ s: String) -> String {
        var out = ""
        var it = Array(s)[...]
        while let c = it.popFirst() {
            if c == "," {
                while let n = it.first, n.isWhitespace { it.removeFirst() }
                out.append(" ")
            } else {
                out.append(c)
            }
        }
        return out
    }

    static func nonEmpty(_ s: String) -> String? { s.isEmpty ? nil : s }

    public static func hasRoleDefault(_ role: String) -> Bool {
        !(T.roleDefaults[role] ?? []).isEmpty || T.typingRoles.contains(role)
    }

    /// The first non-empty of title, description, the title element's value,
    /// the placeholder (only with no value) and the subrole's word.
    static func name(of node: AXNode, valueEmpty: Bool) -> (String, NameSource)? {
        if let t = node.title?.trimmed, !t.isEmpty { return (t, .title) }
        if let t = node.description?.trimmed, !t.isEmpty { return (t, .description) }
        if let t = node.titleElementValue?.trimmed, !t.isEmpty { return (t, .titleElement) }
        if valueEmpty, let t = node.placeholder?.trimmed, !t.isEmpty { return (t, .placeholder) }
        if let s = node.subrole, let t = T.subroleNames[s] { return (t, .subrole) }
        return nil
    }

    /// Checkbox, switch and radio: 0, 1, 2 or a boolean.
    static func toggleState(_ value: AXScalar?) -> String {
        switch value {
        case .bool(true): "checked"
        case .number(let n) where n == "1" || n == "1.0": "checked"
        case .number(let n) where n == "2" || n == "2.0": "mixed"
        default: "unchecked"
        }
    }

    public static func of(_ node: AXNode, _ ctx: FactContext) -> ElementFacts {
        let role = roleWord(node.role, node.subrole)
        let toggle = T.toggleRoles.contains(role)
        // an AppKit disclosure triangle says open or closed as AXValue 0 or 1, with no AXExpanded
        var expanded = node.flags.expanded
        var disclosed = false
        if role == "disclosure", expanded == nil, case .number(let n)? = node.value, n == "0" || n == "1" {
            expanded = n == "1"
            disclosed = true
        }

        var rawValue: String?
        switch node.value {
        case .string(let s), .number(let s): rawValue = s
        default: rawValue = nil
        }
        let valueEmpty = (rawValue ?? "").isEmpty
        let named = name(of: node, valueEmpty: valueEmpty)

        var shownValue: String?
        var fullValue: String?
        var valueTotal = 0
        // a heading's number is its level; a container's number (Swing's 0 on every panel) says nothing
        let number = { if case .number = node.value { true } else { false } }()
        let quiet = number && (role == "heading" || containerRoles.contains(role))
        // a value repeating the name prints once
        let repeatsName = rawValue.map { $0.trimmed } == named?.0
        if let v = rawValue, !v.isEmpty, !toggle, !disclosed, !quiet, !repeatsName, role != "password" {
            // a prefix-read value: AX gives the whole length in UTF-16 units only, so the
            // unread part counts in scalars at the prefix's own ratio (exact for uniform text)
            let units = v.utf16.count, scalars = v.unicodeScalars.count
            let unread = node.valueLength.map { Swift.max(0, $0 - units) } ?? 0
            fullValue = v
            valueTotal = scalars + Int((Double(unread) * Double(scalars) / Double(Swift.max(units, 1))).rounded())
            shownValue = ctx.wholeValues ? v : Cut.value(v, total: valueTotal)
        }

        let focused = ctx.focusedID.map { $0 == node.id } ?? (node.flags.focused == true)
        var states: [String] = []
        if focused { states.append("focused") }
        if node.flags.selected == true { states.append("selected") }
        if node.flags.enabled == false { states.append("disabled") }
        if toggle { states.append(toggleState(node.value)) }
        if let e = expanded, e || collapsibleRoles.contains(role) { states.append(e ? "expanded" : "collapsed") }
        if node.flags.required == true { states.append("required") }
        if node.flags.invalid == true { states.append("invalid") }
        if node.flags.modal == true { states.append("modal") }
        if readOnlyRoles.contains(role), let settable = node.settable, !settable.contains("AXValue") { states.append("read-only") }
        if node.flags.minimized == true { states.append("minimized") }

        var caret: Int?
        var selection: [Int]?
        if focused, caretRoles.contains(role), let r = node.selectedTextRange, r.count == 2 {
            if r[1] == 0 { caret = r[0] } else { selection = [r[0], r[0] + r[1]] }
        }

        let defaults = Set(T.roleDefaults[role] ?? [])
        var actions: [String] = []
        for raw in node.actions where !ctx.ambient.contains(raw) {
            guard let word = actionWord(raw), !defaults.contains(word), !actions.contains(word) else { continue }
            actions.append(word)
        }

        var hash = StableHash()
        hash.add(rawValue ?? "\u{0}")
        hash.add(node.valueLength ?? -1)
        hash.add(node.selectedTextRange?.first ?? -1)
        hash.add(node.selectedTextRange?.last ?? -1)

        let roleDefault = hasRoleDefault(role)
        let cls: LineClass = roleDefault || !actions.isEmpty ? .interactive : textRoles.contains(role) ? .text : .other
        return ElementFacts(
            line: LineFacts(role: role, name: named.map { Cut.name($0.0) }, value: shownValue, states: states, caret: caret, selection: selection, actions: actions),
            rawName: named?.0,
            nameSource: named?.1,
            rawValue: rawValue.map { $0.trimmed }.flatMap { $0.isEmpty ? nil : $0 },
            fullValue: fullValue,
            valueTotal: valueTotal,
            valueHash: hash.value,
            hasRoleDefault: roleDefault,
            cls: cls
        )
    }

    /// The line after `[<index>] `: `button "Save" disabled actions: show menu`.
    public static func body(_ f: LineFacts) -> String {
        var s = f.role
        if let name = f.name { s += " " + Quote.json(name) }
        if let value = f.value { s += " = " + Quote.json(value) }
        for state in f.states { s += " " + state }
        if let caret = f.caret { s += " caret \(caret)" } else if let sel = f.selection { s += " selection \(sel[0])..\(sel[1])" }
        if !f.actions.isEmpty { s += " actions: " + f.actions.joined(separator: ", ") }
        return s
    }
}
