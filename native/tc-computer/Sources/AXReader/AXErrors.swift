#if canImport(ApplicationServices)
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// What one AX attribute slot, or one whole call, came back as (plan §5.2).
enum Slot {
    case value(CFTypeRef)
    /// no value, unsupported, or a plain failure: read as absent
    case absent
    /// kAXErrorInvalidUIElement: the element went away
    case gone
    /// kAXErrorCannotComplete: the app did not answer inside the messaging timeout
    case timeout
    /// kAXErrorAPIDisabled: Accessibility is not granted
    case disabled

    var value: CFTypeRef? { if case .value(let v) = self { v } else { nil } }
}

enum AXErrorMap {
    /// A whole call's or a slot's error, read the one way.
    static func slot(_ error: AXError) -> Slot {
        switch error {
        case .success, .noValue, .attributeUnsupported, .failure, .parameterizedAttributeUnsupported, .actionUnsupported, .notImplemented, .illegalArgument:
            return .absent
        case .invalidUIElement, .invalidUIElementObserver: return .gone
        case .cannotComplete: return .timeout
        case .apiDisabled: return .disabled
        default: return .absent
        }
    }

    /// One slot of `AXUIElementCopyMultipleAttributeValues`: a value, or an AXValue of type `.axError`.
    static func slot(_ v: CFTypeRef?) -> Slot {
        guard let v else { return .absent }
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError {
            var raw = AXError.success
            AXValueGetValue(v as! AXValue, .axError, &raw)
            return slot(raw)
        }
        if CFGetTypeID(v) == CFNullGetTypeID() { return .absent }
        return .value(v)
    }

    static func permissionMissing() -> ComputerFailure {
        ComputerFailure(ComputerError(kind: .permissionMissing, message: "Accessibility is off for TempCode; turn it on in System Settings › Privacy & Security", which: .accessibility))
    }

    static func timeout(_ what: String) -> ComputerFailure {
        ComputerFailure(.timeout, "\(what) did not answer in 2 s")
    }

    /// A failure for a slot that ends the read: the window gone, a timeout, the grant off.
    static func failure(_ slot: Slot, what: String) -> ComputerFailure? {
        switch slot {
        case .gone: ComputerFailure(.windowNotFound, "\(what) is gone")
        case .timeout: timeout(what)
        case .disabled: permissionMissing()
        case .value, .absent: nil
        }
    }
}

/// Small typed reads over one AX element; every one maps its error the plan's way.
enum AX {
    static func copy(_ el: AXUIElement, _ attr: String) -> Slot {
        var v: CFTypeRef?
        let e = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
        return e == .success ? AXErrorMap.slot(v) : AXErrorMap.slot(e)
    }

    /// Several attributes in one call; the whole call's error fills every slot.
    static func batch(_ el: AXUIElement, _ attrs: [String]) -> [String: Slot] {
        var values: CFArray?
        let e = AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard e == .success, let list = values as [AnyObject]? else {
            let s = AXErrorMap.slot(e)
            return Dictionary(uniqueKeysWithValues: attrs.map { ($0, s) })
        }
        var out: [String: Slot] = [:]
        for (i, a) in attrs.enumerated() { out[a] = i < list.count ? AXErrorMap.slot(list[i] as CFTypeRef) : .absent }
        return out
    }

    static func string(_ v: CFTypeRef?) -> String? {
        guard let v else { return nil }
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() { return (v as! String) }
        if t == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
        if t == CFURLGetTypeID() { return (v as! URL).absoluteString }
        return nil
    }

    static func bool(_ v: CFTypeRef?) -> Bool? {
        guard let v else { return nil }
        let t = CFGetTypeID(v)
        if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
        if t == CFNumberGetTypeID() { return (v as! NSNumber).boolValue }
        return nil
    }

    static func int(_ v: CFTypeRef?) -> Int? {
        guard let v, CFGetTypeID(v) == CFNumberGetTypeID() else { return nil }
        return (v as! NSNumber).intValue
    }

    static func element(_ v: CFTypeRef?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func elements(_ v: CFTypeRef?) -> [AXUIElement] {
        guard let v, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
        return (v as! [AnyObject]).compactMap { element($0 as CFTypeRef) }
    }

    static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgPoint else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgSize else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func range(_ v: CFTypeRef?) -> [Int]? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cfRange else { return nil }
        var r = CFRange()
        return AXValueGetValue(v as! AXValue, .cfRange, &r) ? [r.location, r.length] : nil
    }

    static func frame(_ position: CFTypeRef?, _ extent: CFTypeRef?) -> ComputerProtocol.Rect? {
        guard let p = point(position), let s = size(extent) else { return nil }
        return ComputerProtocol.Rect(x: Double(p.x), y: Double(p.y), w: Double(s.width), h: Double(s.height))
    }

    /// AXValue as the node model holds it.
    static func scalar(_ v: CFTypeRef?) -> AXScalar? {
        guard let v else { return nil }
        if let s = string(v) { return .string(s) }
        let t = CFGetTypeID(v)
        if t == CFBooleanGetTypeID() { return .bool(CFBooleanGetValue((v as! CFBoolean))) }
        if t == CFNumberGetTypeID() { return .number((v as! NSNumber).stringValue) }
        return .other
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    static func settable(_ el: AXUIElement, _ attr: String) -> Bool {
        var ok: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(el, attr as CFString, &ok) == .success && ok.boolValue
    }

    static func count(_ el: AXUIElement, _ attr: String) -> Int? {
        var n: CFIndex = 0
        return AXUIElementGetAttributeValueCount(el, attr as CFString, &n) == .success ? n : nil
    }

    /// The first `units` UTF-16 units of a long text value, through AXStringForRange.
    static func prefix(_ el: AXUIElement, units: Int) -> String? {
        var range = CFRange(location: 0, length: units)
        guard let arg = AXValueCreate(.cfRange, &range) else { return nil }
        var v: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(el, "AXStringForRange" as CFString, arg, &v) == .success else { return nil }
        // a cut through a surrogate pair leaves a lone half, which bridges as U+FFFD
        return string(v).map { $0.hasSuffix("\u{FFFD}") ? String($0.dropLast()) : $0 }
    }
}
#endif
