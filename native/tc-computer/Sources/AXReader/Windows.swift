#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// An AX window's CGWindowID. `_AXUIElementGetWindow` is the one private
/// symbol tc-computer uses (the person's ruling, 2026-11-08; native/tc-computer/README.md):
/// read-only, resolved by name at run time, so a missing symbol only means the
/// public match by pid, title and frame (`WindowMatch.pick`) answers instead.
struct WindowIDLookup: Sendable {
    typealias Fn = @Sendable (AXUIElement) -> CGWindowID?
    let lookup: Fn

    /// The symbol, held once; a C function pointer the lookup calls from any thread.
    private final class Symbol: @unchecked Sendable {
        typealias Raw = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
        let fn: Raw

        init?(name: String) {
            guard let handle = dlopen(nil, RTLD_NOW), let sym = dlsym(handle, name) else { return nil }
            fn = unsafeBitCast(sym, to: Raw.self)
        }
    }

    /// The private symbol when this macOS has it; a lookup that always misses when it does not.
    static let live: WindowIDLookup = {
        guard let symbol = Symbol(name: "_AXUIElementGetWindow") else { return WindowIDLookup { _ in nil } }
        return WindowIDLookup { el in
            var id: CGWindowID = 0
            return symbol.fn(el, &id) == .success && id != 0 ? id : nil
        }
    }()

    /// A lookup that never finds the symbol: the public fallback alone (the unit test's forced miss).
    static let missing = WindowIDLookup { _ in nil }

    /// The id by the private symbol, else by the window list; nil when neither gives exactly one.
    func id(of window: AXUIElement, pid: pid_t, title: String, frame: ComputerProtocol.Rect, list: () -> [WindowListEntry]) -> Int? {
        if let id = lookup(window) { return Int(id) }
        return WindowMatch.pick(list(), pid: pid, title: title, frame: frame)
    }
}

enum WindowList {
    /// Every window CG knows of, on screen or not.
    static func entries() -> [WindowListEntry] {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard let id = w[kCGWindowNumber as String] as? Int, let pid = w[kCGWindowOwnerPID as String] as? Int32,
                  let b = w[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
            return WindowListEntry(id: id, pid: pid, title: w[kCGWindowName as String] as? String ?? "",
                                   bounds: ComputerProtocol.Rect(x: bounds.minX, y: bounds.minY, w: bounds.width, h: bounds.height),
                                   onScreen: w[kCGWindowIsOnscreen as String] as? Bool ?? false, layer: w[kCGWindowLayer as String] as? Int ?? 0)
        }
    }
}

/// One AX window and what the wire says of it.
struct ResolvedWindow {
    let element: AXUIElement
    let info: WindowInfo
}

/// Spec §2.1: by id, then exact title, then substring; else AXMainWindow,
/// AXFocusedWindow, the first standard window. No window is ever read without
/// a unique id, so a base's window key always tells two windows apart.
struct WindowResolver {
    let lookup: WindowIDLookup

    func windows(of app: AXUIElement) -> [AXUIElement] { AX.elements(AX.copy(app, "AXWindows").value) }

    func describe(_ w: AXUIElement, app: AXUIElement, pid: pid_t, list: [WindowListEntry]) throws -> WindowInfo {
        let a = AX.batch(w, ["AXTitle", "AXPosition", "AXSize", "AXMain", "AXFocused", "AXMinimized"])
        if let failure = AXErrorMap.failure(a["AXPosition"] ?? .absent, what: "The window") { throw failure }
        let title = AX.string(a["AXTitle"]?.value) ?? ""
        guard let frame = AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value),
              let id = lookup.id(of: w, pid: pid, title: title, frame: frame, list: { list }) else {
            throw ComputerFailure(ComputerError(kind: .windowNotFound, message: "Can't tell which window \"\(title)\" is", candidates: titles(app)))
        }
        let minimized = AX.bool(a["AXMinimized"]?.value) ?? false
        let onScreen = list.first { $0.id == id }?.onScreen ?? false
        return WindowInfo(id: id, title: title, frame: frame, main: AX.bool(a["AXMain"]?.value) ?? false, focused: AX.bool(a["AXFocused"]?.value) ?? false,
                          minimized: minimized, onScreen: onScreen, space: onScreen ? .current : minimized ? .unknown : .other)
    }

    func titles(_ app: AXUIElement) -> [String] { windows(of: app).compactMap { AX.string(AX.copy($0, "AXTitle").value) } }

    func resolve(app: AXUIElement, pid: pid_t, ref: ComputerProtocol.WindowRef?) throws -> ResolvedWindow {
        let list = WindowList.entries()
        let all = windows(of: app)
        if case .disabled = AX.copy(app, "AXWindows") { throw AXErrorMap.permissionMissing() }
        var pick: AXUIElement?
        if let id = ref?.id {
            pick = all.first { w in
                let a = AX.batch(w, ["AXTitle", "AXPosition", "AXSize"])
                guard let f = AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value) else { return false }
                return lookup.id(of: w, pid: pid, title: AX.string(a["AXTitle"]?.value) ?? "", frame: f, list: { list }) == id
            }
        } else if let title = ref?.title {
            let named = all.map { ($0, AX.string(AX.copy($0, "AXTitle").value) ?? "") }
            pick = named.first { $0.1 == title }?.0 ?? named.first { $0.1.contains(title) }?.0
        } else {
            pick = AX.element(AX.copy(app, "AXMainWindow").value) ?? AX.element(AX.copy(app, "AXFocusedWindow").value)
                ?? all.first { AX.string(AX.copy($0, "AXSubrole").value) == "AXStandardWindow" }
        }
        guard let window = pick else {
            throw ComputerFailure(ComputerError(kind: .windowNotFound, message: "No such window", candidates: titles(app)))
        }
        return ResolvedWindow(element: window, info: try describe(window, app: app, pid: pid, list: list))
    }
}

/// Every window of an app, for `apps.list { windows: true }` (offered to the Service shell).
public enum AppWindows {
    public static func list(pid: pid_t) -> [WindowInfo] {
        let app = AXUIElementCreateApplication(pid)
        let resolver = WindowResolver(lookup: .live)
        let entries = WindowList.entries()
        return resolver.windows(of: app).compactMap { try? resolver.describe($0, app: app, pid: pid, list: entries) }
    }
}
#endif
