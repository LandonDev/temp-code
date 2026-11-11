import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The hit route's reads (docs/computer-protocol.md §24.3, §24.4, §24.5): the element under a
/// screen point, the chain the walk looks at, whether an element is in the target window, the
/// character under a point.
enum AXHit {
    /// What `chooseHit` reads, beside the elements it is about.
    struct Chain {
        var elements: [AXUIElement]
        var facts: [HitFacts]
    }

    /// The app's element at a screen point, kept only when it is in the target window or a sheet of it;
    /// when the system's hit test lands anywhere else (a covered window, or one that takes no mouse, gets
    /// another app's element or its own app's menu bar), the target window's tree walked by frames.
    static func element(at p: ScreenPoint, pid: pid_t, window: AXUIElement) -> AXUIElement? {
        let app = AX.app(pid)
        var out: AXUIElement?
        if AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &out) == .success, let e = out {
            AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
            if inWindow(e, window) { return e }
        }
        return walkHit(root: window, point: p, children: { e in
            AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
            return AX.elements(e, "AXChildren")
        }, frame: { AX.frame($0) })
    }

    /// Its AXWindow is the target, or a sheet whose AXParent is the target.
    static func inWindow(_ e: AXUIElement, _ window: AXUIElement) -> Bool {
        if AX.same(e, window) { return true }
        guard let w = AX.element(e, "AXWindow") else { return false }
        if AX.same(w, window) { return true }
        return AX.string(w, "AXRole") == "AXSheet" && AX.same(AX.element(w, "AXParent"), window)
    }

    /// The start and its ancestors, at most `hitAncestors` of them, each with its facts.
    static func chain(from start: AXUIElement, window: AXUIElement) -> Chain {
        var elements: [AXUIElement] = []
        var cur: AXUIElement? = start
        while let c = cur, elements.count <= InputTiming.hitAncestors {
            AX.setTimeout(c, seconds: InputTiming.axTimeoutS)
            elements.append(c)
            cur = AX.element(c, "AXParent")
        }
        let inTarget = inWindow(start, window)
        return Chain(elements: elements, facts: elements.map { facts($0, inTarget: inTarget) })
    }

    /// the AX roles of text a caret goes into (a search field is an AXTextField by its subrole)
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

    static func facts(_ e: AXUIElement, inTarget: Bool) -> HitFacts {
        let axRole = AX.string(e, "AXRole") ?? ""
        var selectableRow = false
        if axRole == "AXRow" || axRole == "AXCell" {
            let table = AX.ancestor(e, role: "AXTable") ?? AX.ancestor(e, role: "AXOutline")
            selectableRow = AX.settable(e, "AXSelected") || table.map { AX.settable($0, "AXSelectedRows") } == true
        }
        let isText = textRoles.contains(axRole) && AX.settable(e, "AXSelectedTextRange")
        return HitFacts(role: AXTier.roleWord(e, fallback: nil), actions: Set(AX.actions(e)), isIncrementor: axRole == "AXIncrementor",
                        selectableRow: selectableRow, isText: isText, frame: AX.frame(e), inTargetWindow: inTarget)
    }

    /// The character under a point: AXRangeForPosition's location.
    static func characterIndex(_ e: AXUIElement, at p: ScreenPoint) -> Int? {
        var point = CGPoint(x: p.x, y: p.y)
        guard let value = AXValueCreate(.cgPoint, &point) else { return nil }
        var out: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(e, "AXRangeForPosition" as CFString, value, &out) == .success,
              let v = out, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        guard AXValueGetValue(v as! AXValue, .cfRange, &r) else { return nil }
        return r.location
    }

    /// The scroll area a scroll acts on (§24.5): the named element's own or nearest, else the one under
    /// the point in the target window, else the window's only one.
    static func scrollArea(element: AXUIElement?, point: ScreenPoint?, pid: pid_t, window: AXUIElement) -> AXUIElement? {
        if let element, let a = AX.ancestor(element, role: "AXScrollArea") { return a }
        if element == nil, let point, let under = self.element(at: point, pid: pid, window: window), let a = AX.ancestor(under, role: "AXScrollArea") { return a }
        let all = descendants(window, role: "AXScrollArea", limit: 2)
        return all.count == 1 ? all[0] : nil
    }

    /// Elements of a role under a root, breadth first, at most `limit` of them and 400 nodes read.
    private static func descendants(_ root: AXUIElement, role: String, limit: Int) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var queue = AX.elements(root, "AXChildren")
        var read = 0
        while !queue.isEmpty, out.count < limit, read < 400 {
            let e = queue.removeFirst()
            read += 1
            if AX.string(e, "AXRole") == role { out.append(e); continue }
            queue += AX.elements(e, "AXChildren")
        }
        return out
    }

    /// `button "Save"`, as a step's `input.on` names what it acted on.
    static func line(_ e: AXUIElement) -> String {
        line(role: AXTier.roleWord(e, fallback: nil), names: [AX.string(e, "AXTitle"), AX.string(e, "AXDescription"), AX.string(e, "AXPlaceholderValue")])
    }

    /// The role and the first non-empty name, quoted as a line quotes it, the name cut at 80 characters.
    static func line(role: String, names: [String?]) -> String {
        let name = names.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        guard let name else { return role }
        let quoted = name.prefix(80).replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "\(role) \"\(quoted)\""
    }
}
