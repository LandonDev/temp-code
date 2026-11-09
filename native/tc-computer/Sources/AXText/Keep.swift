import ComputerProtocol
import Foundation

private typealias T = ObservationTables

/// One element the observation keeps, or a stub container printed as one line (plan §3).
public struct KeptNode: Sendable {
    public enum Kind: Sendable, Equatable { case element, stub }

    public var id: NodeID
    public var kind: Kind
    public var facts: ElementFacts
    /// raw AX subrole, for the rebuilt-element match
    public var subrole: String?
    public var domIdentifier: String?
    /// global points
    public var frame: Rect?
    /// rows of a list, outline or table left unread by the viewport cut, with those of dropped descendants
    public var hidden: Hidden?
    public var children: [KeptNode]

    public var isList: Bool { kind == .element && Facts.listRoles.contains(facts.line.role) }
}

public struct KeptTree: Sendable {
    public var roots: [KeptNode]
    public var thin: Bool
}

public struct KeepOptions: Sendable {
    /// a subtree read: values whole
    public var wholeValues: Bool

    public init(wholeValues: Bool = false) {
        self.wholeValues = wholeValues
    }
}

/// Spec §4.1 and §4.3, read as plan §3 fixes them. The keep rule wins over the
/// drop list: an element is kept when it has a name, a value, a role-default or
/// listed action, a state word, or a structural role; anything else lets its
/// kept children rise to its parent's depth.
public enum Keep {
    public static func tree(_ s: AXSnapshot, _ options: KeepOptions = KeepOptions()) -> KeptTree {
        var walk = Walk(snapshot: s, options: options)
        var roots: [KeptNode] = []
        for root in s.roots { roots += walk.visit(root, inWeb: false, ancestor: (nil, nil), root: true, inMenuBar: false).kept }
        if let bar = s.menuBar { roots += walk.visit(bar, inWeb: false, ancestor: (nil, nil), root: true, inMenuBar: true).kept }
        return KeptTree(roots: roots, thin: thin(roots, window: s.window.frame))
    }

    struct Walk {
        let snapshot: AXSnapshot
        let options: KeepOptions

        func facts(_ n: AXNode, inWeb: Bool) -> ElementFacts {
            Facts.of(n, FactContext(focusedID: snapshot.focusedID, ambient: inWeb ? snapshot.ambientActions : [], wholeValues: options.wholeValues))
        }

        func isFocused(_ n: AXNode) -> Bool { snapshot.focusedID.map { $0 == n.id } ?? (n.flags.focused == true) }

        /// The nodes this subtree keeps at this depth, and the hidden counts that rise with them.
        mutating func visit(_ n: AXNode, inWeb: Bool, ancestor: (name: String?, value: String?), root: Bool, inMenuBar: Bool) -> (kept: [KeptNode], hidden: Hidden) {
            let web = inWeb || n.role == "AXWebArea"
            if !root, n.role == "AXScrollBar", !isFocused(n) { return ([], Hidden()) }
            let f = facts(n, inWeb: web)
            let role = f.line.role
            // a zero-size element is walked through, never kept; a closed menu's items have no usable frame
            let zero = !root && !inMenuBar && (n.frame.map(Viewport.isZero) ?? false)
            if !zero, !root, Facts.listRoles.contains(role), !n.children.isEmpty, !subtreeHasText(n) {
                return ([KeptNode(id: n.id, kind: .stub, facts: f, subrole: n.subrole, domIdentifier: n.domIdentifier, frame: n.frame, hidden: nil, children: [])], Hidden())
            }
            var kept = root || (!zero && isKept(f))
            if kept, !root, role == "text", let s = f.rawValue ?? f.rawName, s == ancestor.name || s == ancestor.value { kept = false }

            var hidden = n.hidden ?? Hidden()
            var children: [KeptNode] = []
            let next = kept ? (f.rawName, f.rawValue) : ancestor
            for child in n.children {
                let (k, h) = visit(child, inWeb: web, ancestor: next, root: false, inMenuBar: inMenuBar)
                children += k
                hidden = hidden + h
            }
            guard kept else { return (children, hidden) }
            // A8: a label already names the control beside it (by AXTitleUIElement in AppKit, AXTitle in Chrome)
            let labels = Set(children.compactMap { c in
                c.kind == .element && (c.facts.nameSource == .titleElement || c.facts.hasRoleDefault || !c.facts.line.actions.isEmpty) ? c.facts.rawName : nil
            })
            if !labels.isEmpty {
                children.removeAll { c in
                    c.kind == .element && c.facts.line.role == "text" && c.children.isEmpty && (c.facts.rawValue ?? c.facts.rawName).map(labels.contains) == true
                }
            }
            let node = KeptNode(id: n.id, kind: .element, facts: f, subrole: n.subrole, domIdentifier: n.domIdentifier, frame: n.frame,
                                hidden: hidden.isEmpty ? nil : hidden, children: children)
            return ([node], Hidden())
        }
    }

    static func isKept(_ f: ElementFacts) -> Bool {
        let l = f.line
        return l.name != nil || l.value != nil || f.hasRoleDefault || !l.actions.isEmpty || !l.states.isEmpty || T.structuralRoles.contains(l.role)
    }

    /// The appshot helper's probe, kept as written: does any of the first 200
    /// descendants carry a title, description or value longer than one character?
    public static func subtreeHasText(_ root: AXNode, budget: Int = 200) -> Bool {
        var stack = root.children
        var visited = 0
        while visited < budget, let el = stack.popLast() {
            visited += 1
            var strings = [el.title, el.description]
            switch el.value {
            case .string(let s), .number(let s): strings.append(s)
            default: break
            }
            for s in strings {
                if let s, s.trimmingCharacters(in: .whitespacesAndNewlines).count > 1 { return true }
            }
            stack.append(contentsOf: el.children)
        }
        return false
    }

    /// Spec §4.5: fewer than 3 elements with a role-default action and under 200
    /// bytes of names and values, or a stub container covering half the window.
    static func thin(_ roots: [KeptNode], window: Rect) -> Bool {
        var actionable = 0
        var bytes = 0
        var stubArea = false
        let windowArea = window.w * window.h
        func walk(_ n: KeptNode) {
            if n.kind == .stub {
                if let f = n.frame, windowArea > 0, f.w * f.h >= windowArea / 2 { stubArea = true }
                return
            }
            if n.facts.hasRoleDefault { actionable += 1 }
            bytes += (n.facts.line.name?.utf8.count ?? 0) + (n.facts.line.value?.utf8.count ?? 0)
            n.children.forEach(walk)
        }
        roots.forEach(walk)
        return stubArea || (actionable < ComputerDefaults.ObservationText.thinActionable && bytes < ComputerDefaults.ObservationText.thinTextBytes)
    }
}
