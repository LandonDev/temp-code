import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The AX calls Input makes, each answering a Swift value or nil; attribute names are the
/// raw strings, so nothing depends on how the SDK imports its constants.
enum AX {
    static func copy(_ e: AXUIElement, _ attr: String) -> (CFTypeRef?, AXError) {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(e, attr as CFString, &value)
        return (value, err)
    }

    static func string(_ e: AXUIElement, _ attr: String) -> String? {
        copy(e, attr).0 as? String
    }

    static func bool(_ e: AXUIElement, _ attr: String) -> Bool? {
        (copy(e, attr).0 as? NSNumber)?.boolValue
    }

    static func number(_ e: AXUIElement, _ attr: String) -> Double? {
        (copy(e, attr).0 as? NSNumber)?.doubleValue
    }

    static func int(_ e: AXUIElement, _ attr: String) -> Int? {
        (copy(e, attr).0 as? NSNumber)?.intValue
    }

    /// AXValue as text: a string as it is, a number or a checkbox's state as its digits; nil for anything else.
    static func valueText(_ e: AXUIElement) -> String? {
        let v = copy(e, "AXValue").0
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    /// Inside an AXWebArea, the element itself counted; deep, since a page's tree is.
    static func inWebArea(_ e: AXUIElement) -> Bool {
        ancestor(e, role: "AXWebArea", maxDepth: 256) != nil
    }

    static func element(_ e: AXUIElement, _ attr: String) -> AXUIElement? {
        guard let v = copy(e, attr).0, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func elements(_ e: AXUIElement, _ attr: String) -> [AXUIElement] {
        guard let v = copy(e, attr).0 as? [AnyObject] else { return [] }
        return v.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }

    static func settable(_ e: AXUIElement, _ attr: String) -> Bool {
        var ok: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, attr as CFString, &ok) == .success && ok.boolValue
    }

    static func actions(_ e: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    @discardableResult
    static func set(_ e: AXUIElement, _ attr: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(e, attr as CFString, value)
    }

    @discardableResult
    static func perform(_ e: AXUIElement, _ action: String) -> AXError {
        AXUIElementPerformAction(e, action as CFString)
    }

    static func setTimeout(_ e: AXUIElement, seconds: Double) {
        AXUIElementSetMessagingTimeout(e, Float(seconds))
    }

    static func app(_ pid: pid_t) -> AXUIElement {
        let a = AXUIElementCreateApplication(pid)
        setTimeout(a, seconds: InputTiming.axTimeoutS)
        return a
    }

    static func same(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
        guard let a, let b else { return false }
        return CFEqual(a, b)
    }

    // MARK: values

    static func range(_ e: AXUIElement, _ attr: String = "AXSelectedTextRange") -> TextRange? {
        guard let v = copy(e, attr).0, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        guard AXValueGetValue(v as! AXValue, .cfRange, &r) else { return nil }
        return TextRange(location: r.location, length: r.length)
    }

    static func rangeValue(_ r: TextRange) -> AXValue {
        var cf = CFRange(location: r.location, length: r.length)
        return AXValueCreate(.cfRange, &cf)!
    }

    /// AXPosition and AXSize as one rect, global points.
    static func frame(_ e: AXUIElement) -> Rect? {
        guard let p = copy(e, "AXPosition").0, let s = copy(e, "AXSize").0,
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return Rect(x: point.x, y: point.y, w: size.width, h: size.height)
    }

    /// The screen rect of a run of text.
    static func bounds(_ e: AXUIElement, for r: TextRange) -> Rect? {
        var out: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(e, "AXBoundsForRange" as CFString, rangeValue(r), &out) == .success,
              let v = out, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(v as! AXValue, .cgRect, &rect) else { return nil }
        return Rect(x: rect.origin.x, y: rect.origin.y, w: rect.size.width, h: rect.size.height)
    }

    /// The nearest ancestor with this role, the element itself first.
    static func ancestor(_ e: AXUIElement, role: String, maxDepth: Int = 40) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0 ..< maxDepth {
            guard let c = cur else { return nil }
            if string(c, "AXRole") == role { return c }
            cur = element(c, "AXParent")
        }
        return nil
    }

    // MARK: errors

    /// An AX error as the protocol's: gone, unsupported, timeout or permission.
    static func failure(_ err: AXError, element index: Int?, available: [String] = [], what: String) -> ComputerFailure {
        let name = index.map { "[\($0)]" } ?? "The element"
        switch err {
        case .invalidUIElement:
            return ComputerFailure(ComputerError(kind: .staleElement, message: "\(name) is gone; observe again.", element: index, reason: .gone))
        case .actionUnsupported, .attributeUnsupported, .illegalArgument, .notImplemented:
            return ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(name) can't \(what).", element: index, available: available))
        case .cannotComplete:
            return ComputerFailure(ComputerError(kind: .timeout, message: "The app did not answer for \(Int(InputTiming.axTimeoutS)) s.", element: index))
        case .apiDisabled:
            return ComputerFailure(ComputerError(kind: .permissionMissing, message: "TempCode needs the Accessibility permission.", which: .accessibility))
        default:
            return ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(name) can't \(what) (AX error \(err.rawValue)).", element: index, available: available))
        }
    }
}
