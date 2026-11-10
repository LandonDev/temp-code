import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The app's menu bar over AX (docs/computer-protocol.md §24.2): AXMenuBar → AXMenuBarItem →
/// AXMenu → AXMenuItem, a submenu an item's AXMenu child. Each item's facts in one batched read.
struct LiveMenuSource: MenuSource {
    let app: AXUIElement

    static let factAttributes = ["AXTitle", "AXEnabled", "AXMenuItemCmdChar", "AXMenuItemCmdVirtualKey", "AXMenuItemCmdGlyph", "AXMenuItemCmdModifiers", "AXChildren"]

    func barItems() -> [AXUIElement] {
        guard let bar = AX.element(app, "AXMenuBar") else { return [] }
        AX.setTimeout(bar, seconds: InputTiming.axTimeoutS)
        return AX.elements(bar, "AXChildren")
    }

    /// The items of a bar item's or an item's menu: the AXMenu child's children.
    func items(_ node: AXUIElement) -> [AXUIElement] {
        guard let menu = AX.elements(node, "AXChildren").first(where: { AX.string($0, "AXRole") == "AXMenu" }) else { return [] }
        return AX.elements(menu, "AXChildren")
    }

    func facts(_ node: AXUIElement) -> MenuItemFacts {
        Self.facts(AX.many(node, Self.factAttributes).map { $0 as Any? })
    }

    /// One item's facts from its batched read, in `factAttributes`' order.
    static func facts(_ v: [Any?]) -> MenuItemFacts {
        let title = v[0] as? String ?? ""
        let enabled = (v[1] as? NSNumber)?.boolValue ?? false
        let char = v[2] as? String
        let key = (v[3] as? NSNumber)?.intValue
        let glyph = (v[4] as? NSNumber)?.intValue
        let mods = (v[5] as? NSNumber)?.intValue ?? 0
        let children = (v[6] as? [Any]) ?? []
        let hasShortcut = (char.map { !$0.isEmpty } ?? false) || (glyph ?? 0) != 0
        let shortcut = hasShortcut ? MenuItemShortcut(cmdChar: char, virtualKey: key, glyph: glyph, modifiers: mods) : nil
        // a separator is an untitled item with nothing under it
        return MenuItemFacts(title: title, enabled: enabled, shortcut: shortcut, isSeparator: title.isEmpty && children.isEmpty, hasSubmenu: !children.isEmpty)
    }
}

/// Each pid's index of key equivalents, kept `menuIndexMaxAgeS` (§24.2).
final class MenuIndexCache: @unchecked Sendable {
    private var byPid: [pid_t: MenuIndex] = [:]
    private let lock = NSLock()

    func take(_ pid: pid_t) -> MenuIndex? {
        lock.lock()
        defer { lock.unlock() }
        return byPid[pid]
    }

    func put(_ pid: pid_t, _ index: MenuIndex?) {
        lock.lock()
        defer { lock.unlock() }
        byPid[pid] = index
    }
}

extension AX {
    /// Several attributes in one round trip; an attribute the element lacks answers nil.
    static func many(_ e: AXUIElement, _ attrs: [String]) -> [CFTypeRef?] {
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let values = out as? [AnyObject], values.count == attrs.count else {
            return attrs.map { copy(e, $0).0 }
        }
        // a missing attribute comes back as an AXValue wrapping its AXError
        return values.map { v in
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            return v
        }
    }
}
