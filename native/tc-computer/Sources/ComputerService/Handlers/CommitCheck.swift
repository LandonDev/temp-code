import ApplicationServices
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation
import Input

/// What the window says of its file now: its AXDocument and its close button's AXEdited (§26.8, E5).
struct DocumentState: Equatable, Sendable {
    var url: String?
    var edited: Bool?

    /// Two reads on the window: the document, then the close button's flag.
    static func read(_ window: AXUIElement) -> DocumentState? {
        var doc: CFTypeRef?
        let docErr = AXUIElementCopyAttributeValue(window, "AXDocument" as CFString, &doc)
        var url: String?
        if docErr == .success, let doc {
            if CFGetTypeID(doc) == CFStringGetTypeID() { url = doc as? String } else if CFGetTypeID(doc) == CFURLGetTypeID() { url = (doc as! URL).absoluteString }
        }
        var button: CFTypeRef?
        var edited: Bool?
        if AXUIElementCopyAttributeValue(window, "AXCloseButton" as CFString, &button) == .success, let button, CFGetTypeID(button) == AXUIElementGetTypeID() {
            var flag: CFTypeRef?
            if AXUIElementCopyAttributeValue(button as! AXUIElement, "AXEdited" as CFString, &flag) == .success, let flag {
                edited = (flag as? NSNumber)?.boolValue
            }
        }
        return url == nil && edited == nil ? nil : DocumentState(url: url, edited: edited)
    }
}

/// The commit check around one acting step (docs/computer-protocol.md §26.8): the file (or the folder's
/// listing) behind the window before the step, and again after its wait; the difference is `step.disk`
/// and decides `uncommitted`. Only a window whose AXDocument is a `file://` URL is checked.
struct CommitCheck: Sendable {
    let context: CommitContext
    let expected: CommitKind?
    let document: DocumentKind
    let state0: DocumentState
    let before: DiskSnapshot

    /// Whether the step is expected to commit before it acts: a background app's commit skips `process`.
    var expectsBefore: Bool { CommitRule.expectsBefore(context) }

    /// The check for a step on a window with a file behind it; nil without one.
    static func begin(_ context: CommitContext, state: DocumentState?) -> CommitCheck? {
        guard let state, let url = state.url, let path = DiskFacts.path(fromDocument: url) else { return nil }
        let document = kind(path, url: url)
        var c = context
        c.document = document
        return CommitCheck(context: c, expected: CommitRule.expects(c), document: document, state0: state, before: snapshot(document))
    }

    /// A folder by its URL's slash or its stat; else a file, there or not yet.
    static func kind(_ path: String, url: String) -> DocumentKind {
        if url.hasSuffix("/") { return .folder(path) }
        if case .present(let st) = DiskFacts.stat(path), st.isDirectory { return .folder(path) }
        return .file(path)
    }

    static func snapshot(_ document: DocumentKind) -> DiskSnapshot {
        switch document {
        case .file(let path):
            switch DiskFacts.stat(path) {
            case .present(let st): return .file(path: path, FileStamp(size: st.size, mtime: st.mtime, inode: st.inode))
            case .missing: return .file(path: path, nil)
            case .unknown: return .unknown
            }
        case .folder(let path):
            switch DiskFacts.list(path) {
            case .listed(let entries): return .folder(path: path, entries.mapValues { FolderEntry(inode: $0.inode, mtime: $0.mtime) })
            case .unknown: return .unknown
            }
        }
    }

    /// The difference now, read against the snapshot before the step.
    func diff(_ state1: DocumentState?, home: String = NSHomeDirectory()) -> DiskChange? {
        let after = Self.snapshot(document)
        let edited = state0.edited.map { ($0, state1?.edited ?? $0) }
        let urls = (from: state0.url.flatMap(DiskFacts.path(fromDocument:)), to: state1?.url.flatMap(DiskFacts.path(fromDocument:)) ?? state0.url.flatMap(DiskFacts.path(fromDocument:)))
        return DiskDiff.diff(before: before, after: after, edited: edited, document: urls, expected: expected != nil, home: home)
    }

    /// Whether a step expected to commit has nothing to show yet: the check polls on.
    func waiting(_ disk: DiskChange?) -> Bool {
        guard expected != nil else { return false }
        guard let disk else { return true }
        if disk.unknown == true { return false }
        let cleared = disk.edited.map { $0.before && !$0.after } ?? false
        return !CommitRule.reachedDisk(disk) && !cleared
    }

    /// The step's effect and disk part from the window's effect and the last difference.
    func judge(window: StepEffect, disk: DiskChange?) -> (StepEffect, DiskChange?) {
        let effect = CommitRule.effect(expected: expected, window: window, disk: disk)
        return (effect, CommitRule.hinted(disk, effect: effect, context: context))
    }
}

extension CommitElement {
    /// What the rule reads of the element a step names: its role word, a row above it, and whether it is
    /// its panel's default button.
    static func of(_ e: ResolvedElement) -> CommitElement {
        var inRow = false
        var node = parent(e.element)
        var sheetOrWindow: AXUIElement?
        for _ in 0 ..< 12 {
            guard let n = node else { break }
            let role = string(n, "AXRole") ?? ""
            if role == "AXRow" || role == "AXCell" { inRow = true }
            if role == "AXSheet" || role == "AXWindow" {
                sheetOrWindow = n
                break
            }
            node = parent(n)
        }
        var isDefault = false
        if let w = sheetOrWindow {
            var d: CFTypeRef?
            if AXUIElementCopyAttributeValue(w, "AXDefaultButton" as CFString, &d) == .success, let d, CFGetTypeID(d) == AXUIElementGetTypeID() {
                isDefault = CFEqual(d, e.element)
            }
        }
        return CommitElement(role: e.role, inRow: inRow, isPanelDefault: isDefault)
    }

    private static func parent(_ e: AXUIElement) -> AXUIElement? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, "AXParent" as CFString, &v) == .success, let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    private static func string(_ e: AXUIElement, _ a: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success else { return nil }
        return v as? String
    }
}
