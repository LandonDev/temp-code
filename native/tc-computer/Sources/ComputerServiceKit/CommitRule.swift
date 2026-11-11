import ComputerProtocol
import Foundation

// What a step is expected to commit to disk, and the effect the commit check reports
// (docs/computer-protocol.md §26.8, §26.9; decisions 12, 17, 18). Pure: the live side reads the
// window's document, the element and the disk; this decides.

/// A key equivalent, from a `key` action's combo or a menu item's AX shortcut.
public struct CommitShortcut: Hashable, Sendable {
    /// a letter lower-cased, else the key's X11 name (`BackSpace`)
    public var key: String
    public var command: Bool
    public var shift: Bool
    public var option: Bool
    public var control: Bool

    public init(_ key: String, command: Bool = true, shift: Bool = false, option: Bool = false, control: Bool = false) {
        self.key = key
        self.command = command
        self.shift = shift
        self.option = option
        self.control = control
    }

    /// `super+shift+s`, `cmd+S` (an upper-case letter carries the shift), `super+BackSpace`;
    /// nil for text that names no key.
    public static func parse(_ text: String) -> CommitShortcut? {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let last = parts.last, !last.isEmpty else { return nil }
        var s = CommitShortcut("", command: false)
        for m in parts.dropLast() {
            switch m.lowercased() {
            case "super", "cmd", "command", "meta_l", "meta_r": s.command = true
            case "shift", "shift_l", "shift_r": s.shift = true
            case "alt", "opt", "option", "alt_l", "alt_r": s.option = true
            case "ctrl", "control", "control_l", "control_r": s.control = true
            default: return nil
            }
        }
        if last.count == 1, let c = last.first, c.isLetter {
            if c.isUppercase { s.shift = true }
            s.key = last.lowercased()
        } else {
            s.key = last.lowercased() == "backspace" ? "BackSpace" : last
        }
        return s
    }

    public static let save = CommitShortcut("s")
    public static let saveAs = CommitShortcut("s", shift: true)
    public static let saveAsOption = CommitShortcut("s", shift: true, option: true)
    public static let moveToTrash = CommitShortcut("BackSpace")
    public static let newFolder = CommitShortcut("n", shift: true)
}

/// The window's document as AXDocument names it (decision 16): a file, or a Finder window's folder.
public enum DocumentKind: Equatable, Sendable {
    case file(String)
    case folder(String)

    public var isFolder: Bool {
        if case .folder = self { return true }
        return false
    }
}

/// What the rule reads of the element a step acted on.
public struct CommitElement: Equatable, Sendable {
    /// the observation's role word: `input`, `button`, `menu item`, …
    public var role: String
    /// it sits inside a `row` or `cell` of a list or outline
    public var inRow: Bool
    /// a file panel's default button (AXDefaultButton of a save or open panel)
    public var isPanelDefault: Bool

    public init(role: String, inRow: Bool = false, isPanelDefault: Bool = false) {
        self.role = role
        self.inRow = inRow
        self.isPanelDefault = isPanelDefault
    }

    /// a text field that can hold a row's name while it is edited
    var isTextField: Bool { role == "input" || role == "search" }
}

/// One step as the commit check sees it.
public struct CommitContext: Equatable, Sendable {
    public var action: ComputerAction
    public var element: CommitElement?
    /// the menu item the step pressed, or that its key combo maps to (§24.2's index)
    public var menuPath: [String]?
    /// that item's key equivalent, when it has one
    public var menuShortcut: CommitShortcut?
    public var document: DocumentKind?
    /// the batch's next step, when there is one
    public var next: ComputerAction?

    public init(action: ComputerAction, element: CommitElement? = nil, menuPath: [String]? = nil, menuShortcut: CommitShortcut? = nil, document: DocumentKind? = nil, next: ComputerAction? = nil) {
        self.action = action
        self.element = element
        self.menuPath = menuPath
        self.menuShortcut = menuShortcut
        self.document = document
        self.next = next
    }
}

/// What a step is expected to do on disk.
public enum CommitKind: Equatable, Sendable {
    /// Save: the file written or the edited flag cleared (TextEdit autosaves in place, so ⌘S may write nothing)
    case save
    /// a command that writes, moves or makes a file
    case write
    /// an inline rename in a folder's list
    case rename
}

public enum CommitRule {
    /// The commit menu's titles in English, without a trailing ellipsis, lower-cased (§26.9).
    static let titles: [String: CommitKind] = [
        "save": .save, "save as": .write, "rename": .write, "move to": .write, "move to trash": .write,
        "new folder": .write, "export": .write, "revert to saved": .write
    ]

    /// The same items by key equivalent, so a localized menu still counts its common items.
    static let shortcuts: [CommitShortcut: CommitKind] = [
        .save: .save, .saveAs: .write, .saveAsOption: .write, .moveToTrash: .write, .newFolder: .write
    ]

    /// Decision 18: the step is expected to reach the disk.
    public static func expects(_ c: CommitContext) -> CommitKind? {
        let a = c.action
        if a.action == .saveAs { return .write }
        if let kind = menuKind(c) { return kind }
        if c.element?.isPanelDefault == true, isPress(a) { return .write }
        if inlineRename(c) { return .rename }
        return nil
    }

    /// Decision 12: known before the step acts, so a background app's commit skips `process`: a
    /// commit key on an inline rename's field, or a combo or menu press on the commit list.
    public static func expectsBefore(_ c: CommitContext) -> Bool {
        switch c.action.action {
        case .key:
            return menuKind(c) != nil || (isCommitKey(c.action) && renameField(c))
        case .perform, .leftClick:
            return c.element?.role == "menu item" && menuKind(c) != nil
        default:
            return false
        }
    }

    /// §26.8: anything on disk is `changed`, whatever the window did; a Save that cleared the edited
    /// flag is `changed`; an expected commit that changed the window and nothing on disk is
    /// `uncommitted`; else the window's effect. `disk` nil: the check read both times and nothing
    /// moved; a check that could not read the disk (`unknown`) changes nothing.
    public static func effect(expected: CommitKind?, window: StepEffect, disk: DiskChange?) -> StepEffect {
        let disk = disk ?? DiskChange()
        if disk.unknown == true { return window }
        if reachedDisk(disk) { return .changed }
        let cleared = disk.edited.map { $0.before && !$0.after } ?? false
        if cleared { return expected == .save ? .changed : window }
        if expected != nil, window == .changed { return .uncommitted }
        return window
    }

    /// The disk part with the hint an `uncommitted` step carries (§26.12): what commits it instead.
    public static func hinted(_ disk: DiskChange?, effect: StepEffect, context c: CommitContext) -> DiskChange? {
        guard effect == .uncommitted, let h = hint(c) else { return disk }
        let d = disk ?? DiskChange()
        return DiskChange(saved: d.saved, renamed: d.renamed, added: d.added, removed: d.removed, edited: d.edited, document: d.document, unexpected: d.unexpected, hint: h, unknown: d.unknown)
    }

    /// By the element: a text field in a file row says key Return; a menu item says its path.
    public static func hint(_ c: CommitContext) -> String? {
        if renameField(c) { return "commit it with key Return in the field" }
        if let path = c.menuPath, !path.isEmpty { return String("commit it with \(path.joined(separator: " › "))".prefix(200)) }
        return nil
    }

    /// A change on disk beyond the edited flag.
    public static func reachedDisk(_ d: DiskChange) -> Bool {
        d.saved != nil || !(d.renamed ?? []).isEmpty || !(d.added ?? []).isEmpty || !(d.removed ?? []).isEmpty
    }

    // MARK: parts

    private static func menuKind(_ c: CommitContext) -> CommitKind? {
        let a = c.action
        let pressesItem: Bool = switch a.action {
        case .key: true
        case .perform: a.name == "press" || a.name == "pick"
        case .leftClick: c.element?.role == "menu item"
        default: false
        }
        guard pressesItem else { return nil }
        if let title = c.menuPath?.last, let k = titles[normalized(title)] { return k }
        if let s = c.menuShortcut, let k = shortcuts[s] { return k }
        if a.action == .key, let s = CommitShortcut.parse(a.text ?? ""), let k = shortcuts[s] { return k }
        return nil
    }

    private static func normalized(_ title: String) -> String {
        var t = title.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix("…") { t.removeLast() } else if t.hasSuffix("...") { t.removeLast(3) }
        return t.lowercased()
    }

    private static func isPress(_ a: ComputerAction) -> Bool {
        switch a.action {
        case .leftClick: true
        case .perform: a.name == "press"
        case .key: ["Return", "KP_Enter", "Enter"].contains(a.text ?? "")
        default: false
        }
    }

    /// Return, Enter or Tab alone
    private static func isCommitKey(_ a: ComputerAction) -> Bool {
        guard a.action == .key, (a.repeat ?? 1) == 1 else { return false }
        return ["Return", "Enter", "KP_Enter", "Tab", "return", "enter", "tab"].contains(a.text ?? "")
    }

    /// a text field inside a row of a window whose document is a folder
    private static func renameField(_ c: CommitContext) -> Bool {
        guard let e = c.element, e.isTextField, e.inRow, c.document?.isFolder == true else { return false }
        return true
    }

    /// `key Return`/`Tab`, `perform confirm`, or a `set_value` the batch commits nothing after
    private static func inlineRename(_ c: CommitContext) -> Bool {
        guard renameField(c) else { return false }
        let a = c.action
        switch a.action {
        case .key: return isCommitKey(a)
        case .perform: return a.name == "confirm"
        case .setValue:
            guard let n = c.next else { return true }
            return !(isCommitKey(n) || (n.action == .perform && n.name == "confirm"))
        default: return false
        }
    }
}
