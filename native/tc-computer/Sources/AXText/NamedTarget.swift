import ComputerProtocol
import Foundation

/// §27.9: a target by its name, resolved when the step runs. Among the elements an earlier step of the call made
/// appear (an opened menu, a new window or sheet) first, then the target window; in each, an exact name before a
/// case-blind one; among several, one with a role-default action before one without; still several, the step
/// fails `named_target` `several` with up to five of them; none, `no-match`.
public enum NamedTarget {
    public struct Candidate: Sendable, Equatable {
        public var id: NodeID
        /// the quoted name of its line (a menu item's title), uncut
        public var name: String
        public var actionable: Bool
        /// an earlier step of the call made it appear
        public var madeAppear: Bool
        /// AXSecureTextField (§27.7a)
        public var secure: Bool

        public init(id: NodeID, name: String, actionable: Bool, madeAppear: Bool, secure: Bool = false) {
            self.id = id
            self.name = name
            self.actionable = actionable
            self.madeAppear = madeAppear
            self.secure = secure
        }
    }

    public enum Answer: Sendable, Equatable {
        case one(Candidate)
        /// in reading order, at most `candidatesMax`
        case several([Candidate])
        case none
    }

    public static let candidatesMax = 5

    /// A name as matched: trimmed, three dots read as an ellipsis, so `Save...` finds `Save…`.
    public static func normal(_ s: String) -> String {
        s.trimmed.replacingOccurrences(of: "...", with: "…")
    }

    public static func match(_ name: String, among candidates: [Candidate]) -> Answer {
        let want = normal(name)
        guard !want.isEmpty else { return .none }
        let folded = want.lowercased()
        for appeared in [true, false] {
            let scope = candidates.filter { $0.madeAppear == appeared }
            for exact in [true, false] {
                let hits = scope.filter { exact ? normal($0.name) == want : normal($0.name).lowercased() == folded }
                guard !hits.isEmpty else { continue }
                let acting = hits.filter(\.actionable)
                let pool = acting.isEmpty ? hits : acting
                return pool.count == 1 ? .one(pool[0]) : .several(Array(pool.prefix(candidatesMax)))
            }
        }
        return .none
    }

    /// Every named element of a snapshot root, in reading order: the reader's keep rule's names, a zero-size element
    /// walked through but never a candidate (a closed menu's items), scroll bars left out.
    public static func candidates(_ root: AXNode, madeAppear: Bool) -> [Candidate] {
        var out: [Candidate] = []
        func visit(_ n: AXNode, root: Bool) {
            if !root, n.role == "AXScrollBar" { return }
            let zero = !root && (n.frame.map(Viewport.isZero) ?? false)
            if !zero {
                let f = Facts.of(n, FactContext(focusedID: nil))
                if let name = f.rawName {
                    out.append(Candidate(id: n.id, name: name, actionable: f.hasRoleDefault, madeAppear: madeAppear, secure: n.subrole == "AXSecureTextField"))
                }
            }
            for c in n.children { visit(c, root: false) }
        }
        visit(root, root: true)
        return out
    }
}
