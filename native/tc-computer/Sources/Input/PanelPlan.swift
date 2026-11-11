import ComputerProtocol

// `save_as` (docs/computer-protocol.md §26.7): the save panel's parts in a tree value, the flow
// from opening the panel to the file on disk as a state machine over what the live layer reads,
// and the disk's proof. Nothing here touches AX or the file system.

/// One AX element of the window as the panel search sees it; raw AX words.
public struct PanelNode: Equatable, Sendable {
    /// `AXSheet`, `AXWindow`, `AXButton`, `AXTextField`, `AXPopUpButton`, …
    public var role: String
    public var subrole: String?
    public var identifier: String?
    public var title: String?
    public var description: String?
    public var value: String?
    /// the window's or sheet's AXDefaultButton is this element
    public var isDefault: Bool
    public var children: [PanelNode]

    public init(role: String, subrole: String? = nil, identifier: String? = nil, title: String? = nil, description: String? = nil, value: String? = nil, isDefault: Bool = false, children: [PanelNode] = []) {
        self.role = role
        self.subrole = subrole
        self.identifier = identifier
        self.title = title
        self.description = description
        self.value = value
        self.isDefault = isDefault
        self.children = children
    }

    /// the node at an index path below this one
    public func at(_ path: [Int]) -> PanelNode? {
        var n = self
        for i in path {
            guard n.children.indices.contains(i) else { return nil }
            n = n.children[i]
        }
        return n
    }
}

/// The save panel's identifiers, as E4 read them on macOS 27.2.
public enum PanelIDs {
    public static let panel = "save-panel"
    public static let nameField = "saveAsNameTextField"
    public static let ok = "OKButton"
    public static let cancel = "CancelButton"
    public static let wherePopup = "where popup"
    public static let goTo = "GoToWindow"
    public static let pathField = "PathTextField"
}

/// Where each part sits, by index path from the root the search was given.
public struct SavePanelParts: Equatable, Sendable {
    public var panel: [Int]
    public var nameField: [Int]?
    /// `OKButton`, else the panel's AXDefaultButton
    public var ok: [Int]?
    public var cancel: [Int]?
    public var wherePopup: [Int]?
    /// the Go to Folder sheet and its path field, while it shows
    public var goTo: [Int]?
    public var pathField: [Int]?
    /// a Replace alert over the panel: its Replace and Cancel buttons
    public var replace: [Int]?
    public var replaceCancel: [Int]?

    /// The panel on a window: a sheet or dialog whose identifier is `save-panel`, searched depth
    /// first; nil when the window shows none.
    public static func find(in root: PanelNode) -> SavePanelParts? {
        guard let panel = first(root, [], { $0.identifier == PanelIDs.panel }) else { return nil }
        let node = root.at(panel)!
        func under(_ match: (PanelNode) -> Bool) -> [Int]? { first(node, panel, match) }
        var parts = SavePanelParts(panel: panel)
        parts.nameField = under { $0.identifier == PanelIDs.nameField }
        parts.ok = under { $0.identifier == PanelIDs.ok } ?? under { $0.role == "AXButton" && $0.isDefault }
        parts.cancel = under { $0.identifier == PanelIDs.cancel }
        parts.wherePopup = under { $0.role == "AXPopUpButton" && ($0.identifier == PanelIDs.wherePopup || $0.description == PanelIDs.wherePopup) }
        if let goTo = under({ $0.identifier == PanelIDs.goTo }) {
            parts.goTo = goTo
            parts.pathField = first(root.at(goTo)!, goTo) { $0.identifier == PanelIDs.pathField }
        }
        // the Replace alert: a sheet or dialog over the panel holding a Replace button
        if let alert = under({ ($0.role == "AXSheet" || $0.subrole == "AXDialog") && $0.identifier != PanelIDs.goTo && hasReplace($0) }) {
            let a = root.at(alert)!
            parts.replace = first(a, alert) { $0.role == "AXButton" && isReplaceTitle($0.title) }
            parts.replaceCancel = first(a, alert) { $0.role == "AXButton" && ($0.identifier == PanelIDs.cancel || $0.title == "Cancel") }
        }
        return parts
    }

    private static func isReplaceTitle(_ t: String?) -> Bool { t == "Replace" }

    private static func hasReplace(_ n: PanelNode) -> Bool {
        n.children.contains { ($0.role == "AXButton" && isReplaceTitle($0.title)) || hasReplace($0) }
    }

    /// depth first, the node itself excluded; paths are from the search's root
    private static func first(_ n: PanelNode, _ at: [Int], _ match: (PanelNode) -> Bool) -> [Int]? {
        for (i, c) in n.children.enumerated() {
            if match(c) { return at + [i] }
            if let p = first(c, at + [i], match) { return p }
        }
        return nil
    }
}

/// `save_as`'s path, split and worded (§26.7): absolute or `~/…`, file name included.
public struct SaveTarget: Equatable, Sendable {
    /// absolute, no trailing slash (`/` for the root)
    public var folder: String
    public var name: String
    /// the path as the step line and `input.on` show it: `~`-relative
    public var display: String
    /// `display`'s folder
    public var displayFolder: String
    /// the absolute path, `disk.saved`
    public var full: String

    /// nil for a path that is not absolute or `~/…`, names no file, or is too long
    public static func parse(_ path: String, home: String) -> SaveTarget? {
        guard !path.isEmpty, path.utf16.count <= ComputerDefaults.Front.pathMaxUnits else { return nil }
        let home = home.hasSuffix("/") && home.count > 1 ? String(home.dropLast()) : home
        let abs: String
        if path.hasPrefix("~/") { abs = home + path.dropFirst(1) } else if path.hasPrefix("/") { abs = path } else { return nil }
        guard !abs.hasSuffix("/"), let slash = abs.lastIndex(of: "/") else { return nil }
        let name = String(abs[abs.index(after: slash)...])
        guard !name.isEmpty, name != ".", name != ".." else { return nil }
        let folder = slash == abs.startIndex ? "/" : String(abs[..<slash])
        return SaveTarget(folder: folder, name: name, display: tildePath(abs, home: home), displayFolder: tildePath(folder, home: home), full: abs)
    }

    /// `input.on`: the display path cut to 200 UTF-16 units with … in the middle (Sol S8)
    public var on: String { middleCut(display, max: 200) }

    /// the name the `where popup` shows for the folder: its last component
    public var folderName: String {
        folder == "/" ? "/" : String(folder[folder.index(after: folder.lastIndex(of: "/")!)...])
    }
}

/// A path under `home` as `~/…`, else as it is.
public func tildePath(_ path: String, home: String) -> String {
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
}

/// `s` at most `max` UTF-16 units, the cut in the middle marked with …
public func middleCut(_ s: String, max: Int) -> String {
    guard s.utf16.count > max, max > 1 else { return s }
    let chars = Array(s)
    var head = 0, tail = 0, units = 1
    // take from each end in turn while the whole fits
    while true {
        let fromHead = head <= tail
        let c = fromHead ? chars[head] : chars[chars.count - 1 - tail]
        let w = String(c).utf16.count
        if units + w > max || head + tail >= chars.count { break }
        units += w
        if fromHead { head += 1 } else { tail += 1 }
    }
    return String(chars[..<head]) + "…" + String(chars[(chars.count - tail)...])
}

/// Decision 23: a path typed into the save panel's name field becomes a file named with colons.
public func nameFieldRefusal(identifier: String?, text: String) -> ComputerError? {
    guard identifier == PanelIDs.nameField, text.contains("/") else { return nil }
    return ComputerError(kind: .actionUnsupported, message: "The save panel's name field takes a file name; a / becomes : on disk. Use save_as with the path.")
}

/// What the live layer read for the flow's next move.
public struct PanelObservation: Equatable, Sendable {
    public var now: Int
    /// nil: no save panel on the window
    public var parts: SavePanelParts?
    public var nameValue: String?
    public var pathValue: String?
    public var whereValue: String?
    /// the File menu's items, read only while the flow has to open the panel
    public var fileMenu: [MenuItemFacts]
    /// the window's AXDocument names a file
    public var windowHasFile: Bool

    public init(now: Int, parts: SavePanelParts? = nil, nameValue: String? = nil, pathValue: String? = nil, whereValue: String? = nil, fileMenu: [MenuItemFacts] = [], windowHasFile: Bool = false) {
        self.now = now
        self.parts = parts
        self.nameValue = nameValue
        self.pathValue = pathValue
        self.whereValue = whereValue
        self.fileMenu = fileMenu
        self.windowHasFile = windowHasFile
    }
}

public enum PanelPart: Equatable, Sendable {
    case nameField, pathField, ok, cancel, replace, replaceCancel
}

/// The flow's next move; the live layer does it, reads again and asks for the next.
public enum PanelMove: Equatable, Sendable {
    /// press File › … through the menu route; `atFront` inside a hold (the item is disabled in the background)
    case pressMenu([String], atFront: Bool)
    /// read the window again after this long
    case read(afterMs: Int)
    /// select the part's whole value (when `selectAll`) and insert through AXSelectedText
    case insert(PanelPart, String, selectAll: Bool)
    case setValue(PanelPart, String)
    case press(PanelPart)
    /// the one part that needs `front` (E4'): bring the app forward, AXConfirm the path field, else
    /// Return posted to the panel's pid, restore
    case confirmGoTo
    /// a part needs `front` and the step's tiers lack it: fall through to the front route, else `needs_tier`
    case needsFront(menu: [String]?)
    /// the panel closed: judge the disk with SaveProof
    case checkDisk
    case fail(ComputerError)
}

/// The steps of §26.7 with their read-backs.
public struct SavePanelFlow: Equatable, Sendable {
    enum Stage: Equatable, Sendable {
        case find, opening, goTo, goToOpening, path, pathCheck, confirm, confirmWait, folder, name, nameCheck, save, closing, done
    }

    public let target: SaveTarget
    public let replace: Bool
    public let app: String
    public let frontAllowed: Bool
    public let appActive: Bool
    var stage: Stage = .find
    var since = 0
    var retried: Set<String> = []
    var replaced = false
    /// moves still to make before the failure, then the failure
    var failing: [PanelMove] = []
    /// a part of the flow ran at `front`: the step's tier
    public private(set) var usedFront = false

    public init(target: SaveTarget, replace: Bool, app: String, frontAllowed: Bool, appActive: Bool) {
        self.target = target
        self.replace = replace
        self.app = app
        self.frontAllowed = frontAllowed
        self.appActive = appActive
    }

    /// The step's tier: `front` when any part ran there, else `ax`.
    public var tier: Tier { usedFront ? .front : .ax }

    public mutating func next(_ o: PanelObservation) -> PanelMove {
        if !failing.isEmpty { return failing.removeFirst() }
        switch stage {
        case .find:
            if o.parts != nil { stage = .goTo; return next(o) }
            return open(o)
        case .opening:
            if o.parts != nil { stage = .goTo; return next(o) }
            if o.now - since >= InputTiming.panelOpenMaxMs {
                return .fail(ComputerError(kind: .timeout, message: "\(app)'s save panel did not open within \(InputTiming.panelOpenMaxMs / 1000) s."))
            }
            return .read(afterMs: InputTiming.panelPollMs)
        case .goTo:
            guard let parts = o.parts else { return lost() }
            if parts.goTo != nil { stage = .path; return next(o) }
            guard parts.nameField != nil else { return fail(unsupported("\(app)'s save panel has no name field.")) }
            // a / inserted into the name field opens the panel's Go to Folder sheet (E4)
            stage = .goToOpening
            since = o.now
            return .insert(.nameField, "/", selectAll: true)
        case .goToOpening:
            guard let parts = o.parts else { return lost() }
            if parts.goTo != nil { stage = .path; return next(o) }
            if o.now - since >= InputTiming.panelOpenMaxMs { return fail(unsupported("\(app)'s save panel did not open Go to Folder.")) }
            return .read(afterMs: InputTiming.panelPollMs)
        case .path:
            guard let parts = o.parts else { return lost() }
            guard parts.pathField != nil else { return fail(unsupported("\(app)'s Go to Folder has no path field.")) }
            stage = .pathCheck
            return .insert(.pathField, target.folder, selectAll: true)
        case .pathCheck:
            if o.pathValue == target.folder || o.pathValue == target.folder + "/" { stage = .confirm; return next(o) }
            if retried.insert("path").inserted { return .insert(.pathField, target.folder, selectAll: true) }
            return fail(notCommitted("\(app)'s save panel did not take the folder \(target.displayFolder); nothing was saved."))
        case .confirm:
            guard frontAllowed else { return .needsFront(menu: nil) }
            usedFront = true
            stage = .confirmWait
            since = o.now
            return .confirmGoTo
        case .confirmWait:
            guard let parts = o.parts else { return lost() }
            if parts.goTo == nil { stage = .folder; return next(o) }
            if o.now - since >= InputTiming.panelOpenMaxMs { return fail(notCommitted("\(app)'s save panel did not go to \(target.displayFolder); nothing was saved.")) }
            return .read(afterMs: InputTiming.panelPollMs)
        case .folder:
            if target.folder == "/" || o.whereValue == target.folderName { stage = .name; return next(o) }
            return fail(notCommitted("\(app)'s save panel did not go to \(target.displayFolder); nothing was saved."))
        case .name:
            // after the folder: a folder change resets the name field
            stage = .nameCheck
            return .setValue(.nameField, target.name)
        case .nameCheck:
            if o.nameValue == target.name { stage = .save; return next(o) }
            if retried.insert("name").inserted { return .setValue(.nameField, target.name) }
            return fail(notCommitted("\(app)'s save panel did not take the name \(target.name); nothing was saved."))
        case .save:
            guard o.parts?.ok != nil else { return fail(unsupported("\(app)'s save panel has no Save button.")) }
            stage = .closing
            since = o.now
            return .press(.ok)
        case .closing:
            guard let parts = o.parts else { stage = .done; return .checkDisk }
            if parts.replace != nil {
                if replace, !replaced {
                    replaced = true
                    since = o.now
                    return .press(.replace)
                }
                if !replace {
                    failing = [.press(.cancel), .fail(ComputerError(kind: .fileExists, message: "\(target.display) exists; pass replace to overwrite it."))]
                    return .press(.replaceCancel)
                }
            }
            if o.now - since >= InputTiming.panelOpenMaxMs { return fail(notCommitted("\(app)'s save panel stayed open; nothing was saved.")) }
            return .read(afterMs: InputTiming.panelPollMs)
        case .done:
            return .checkDisk
        }
    }

    /// Step 2: File › Save As… when listed, else File › Save… for a window with no file; a
    /// disabled item goes to `front` in a background app.
    private mutating func open(_ o: PanelObservation) -> PanelMove {
        let titles = o.fileMenu.filter { !$0.isSeparator }.map(\.title)
        let pick = o.fileMenu.first { isTitle($0.title, "Save As") } ?? (o.windowHasFile ? nil : o.fileMenu.first { isTitle($0.title, "Save") })
        guard let item = pick else {
            let listed = titles.isEmpty ? "" : ": \(titles.joined(separator: ", "))"
            return .fail(unsupported("\(app)'s File menu has no Save As…\(o.windowHasFile ? "" : " or Save…")\(listed)."))
        }
        let path = ["File", item.title]
        // an active app's disabled item may only be unvalidated: the live layer opens its menu before it
        // counts as disabled (MenuValidation), in a hold for an app in the background
        let atFront = !item.enabled && !appActive
        if atFront {
            guard frontAllowed else { return .needsFront(menu: path) }
            usedFront = true
        }
        stage = .opening
        since = o.now
        return .pressMenu(path, atFront: atFront)
    }

    /// `Save As…`, `Save As...` and `Save As` all name the item
    private func isTitle(_ title: String, _ word: String) -> Bool {
        title == word + "…" || title == word + "..." || title == word
    }

    /// the panel closed before the flow got to its Save: nothing of the step's reached the disk
    private mutating func lost() -> PanelMove {
        stage = .done
        return .fail(notCommitted("\(app) closed the save panel and no file appeared in \(target.displayFolder)."))
    }

    /// cancel the panel, then fail: the panel never stays open behind a failed step
    private mutating func fail(_ e: ComputerError) -> PanelMove {
        stage = .done
        failing = [.fail(e)]
        return .press(.cancel)
    }

    private func unsupported(_ m: String) -> ComputerError { ComputerError(kind: .actionUnsupported, message: m) }
    private func notCommitted(_ m: String) -> ComputerError { ComputerError(kind: .notCommitted, message: m) }
}

/// §26.7 (6): what proves the save, from the destination folder's listing after the panel closed.
public enum SaveProof {
    /// `after`: each file in the destination folder with its mtime (seconds); `startedAt`: when the
    /// step began, same clock; `documentAfter`: the window's AXDocument path after the save.
    /// The file at exactly the path, written after the step began; else, only when AXDocument names
    /// it, the requested name plus the extension the app chose (`note` → `note.rtf`, `note.txt` →
    /// `note.txt.rtf`). Anything else, a different name or another writer's file, is no proof.
    public static func judge(_ target: SaveTarget, after: [String: Double], startedAt: Double, documentAfter: String?, app: String) -> Result<String, ComputerError> {
        if let m = after[target.name], m >= startedAt { return .success(target.full) }
        if let doc = documentAfter, let slash = doc.lastIndex(of: "/") {
            let folder = slash == doc.startIndex ? "/" : String(doc[..<slash])
            let name = String(doc[doc.index(after: slash)...])
            let ext = name.dropFirst(target.name.count + 1)
            if folder == target.folder, name.hasPrefix(target.name + "."), !ext.isEmpty, !ext.contains("."),
               let m = after[name], m >= startedAt {
                return .success(doc)
            }
        }
        return .failure(ComputerError(kind: .notCommitted, message: "\(app) closed the save panel and no file appeared in \(target.displayFolder)."))
    }
}
