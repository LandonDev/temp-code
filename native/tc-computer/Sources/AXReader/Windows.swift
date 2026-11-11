#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// An AX window's CGWindowID. `_AXUIElementGetWindow` is the one private
/// symbol tc-computer uses (the person's ruling, 2026-11-08; native/tc-computer/README.md):
/// read-only, resolved by name at run time through `PrivateSymbol`, so a missing symbol only
/// means the public match by pid, title and frame (`WindowMatch.pick`) answers instead.
struct WindowIDLookup: Sendable {
    typealias Fn = @Sendable (AXUIElement) -> CGWindowID?
    let lookup: Fn

    /// The symbol, held once; a C function pointer the lookup calls from any thread.
    private final class Symbol: @unchecked Sendable {
        typealias Raw = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
        let fn: Raw
        init(_ fn: Raw) { self.fn = fn }
    }

    /// The private symbol when this macOS has it and `missing` does not name it; a lookup that
    /// always misses otherwise, leaving the window list to answer.
    static func resolve(missing: Set<String> = PrivateSymbol.forcedMisses) -> WindowIDLookup {
        guard let fn = PrivateSymbol.lookup("_AXUIElementGetWindow", as: Symbol.Raw.self, missing: missing) else {
            return WindowIDLookup { _ in nil }
        }
        let symbol = Symbol(fn)
        return WindowIDLookup { el in
            var id: CGWindowID = 0
            return symbol.fn(el, &id) == .success && id != 0 ? id : nil
        }
    }

    static let live = resolve()

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

/// A tab a window ref named (§25.4): the element to press, as resolution found it.
public struct TabTarget {
    public let element: AXUIElement
    public let title: String
    public let selected: Bool
}

/// One AX window and what the wire says of it; `tab` when the ref matched one of its tabs.
struct ResolvedWindow {
    let element: AXUIElement
    let info: WindowInfo
    var tab: TabTarget?
}

/// Spec §2.1 as §25.4 widens it: by id; the window title exactly; a tab title exactly, in any of a
/// Chromium app's browser windows; the window title as a substring; a tab title as a substring
/// (`TabMatch`); else AXMainWindow, AXFocusedWindow, the first standard window. No window is ever read
/// without a unique id, so a base's window key always tells two windows apart. Resolution has no side
/// effect: a tab match returns its window and the tab, which `TabSelect` presses.
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

    /// `chromium`: tabs are matched (a Chromium process, `ChromiumBundle`).
    func resolve(app: AXUIElement, pid: pid_t, ref: ComputerProtocol.WindowRef?, chromium: Bool = false) throws -> ResolvedWindow {
        // the first call decides: a hung app answers `timeout` after one 2 s wait, not one per call
        let first = AX.copy(app, "AXWindows")
        if let failure = AXErrorMap.failure(first, what: "The app") { throw failure }
        let list = WindowList.entries()
        let all = AX.elements(first.value)
        var pick: AXUIElement?
        var tab: TabTarget?
        if let id = ref?.id {
            pick = all.first { w in
                let a = AX.batch(w, ["AXTitle", "AXPosition", "AXSize"])
                guard let f = AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value) else { return false }
                return lookup.id(of: w, pid: pid, title: AX.string(a["AXTitle"]?.value) ?? "", frame: f, list: { list }) == id
            }
        } else if let title = ref?.title {
            let named = all.map { ($0, AX.string(AX.copy($0, "AXTitle").value) ?? "") }
            // the tab strips are scanned only when no window title matches exactly, and only in a Chromium app
            let scanTabs = chromium && !named.contains { $0.1 == title }
            let found = named.map { scanTabs ? LiveTabs.scan($0.0).tabs : [] }
            let windows = named.indices.map { TabMatch.Window(title: named[$0].1, tabs: found[$0].map(LiveTabs.info)) }
            if let hit = TabMatch.pick(windows: windows, ref: ComputerProtocol.WindowRef(title: title)) {
                pick = named[hit.window].0
                if case .tab(let w, let t) = hit {
                    tab = TabTarget(element: found[w][t], title: windows[w].tabs[t].title, selected: windows[w].tabs[t].selected)
                }
            }
        } else {
            pick = AX.element(AX.copy(app, "AXMainWindow").value) ?? AX.element(AX.copy(app, "AXFocusedWindow").value)
                ?? all.first { AX.string(AX.copy($0, "AXSubrole").value) == "AXStandardWindow" }
        }
        guard let window = pick else {
            throw ComputerFailure(ComputerError(kind: .windowNotFound, message: "No such window", candidates: titles(app)))
        }
        return ResolvedWindow(element: window, info: try describe(window, app: app, pid: pid, list: list), tab: tab)
    }
}

/// Every window of an app, for `apps.list { windows: true }`, and the window resolution the Service shell's
/// `WindowSource` answers with.
public enum AppWindows {
    /// The app's element under the walk's messaging timeout (process-wide too), so a hung app answers
    /// `timeout` after one wait even before any `AppReader` set it.
    static func appElement(_ pid: pid_t) -> AXUIElement {
        _ = timeoutSet
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Float(ComputerDefaults.AXWalk.messagingTimeoutMs) / 1_000)
        return app
    }

    private static let timeoutSet: Void = {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Float(ComputerDefaults.AXWalk.messagingTimeoutMs) / 1_000)
    }()

    /// spec §2.1's pick of `ref` among the app's windows (§25.4's order, tabs included), else main, focused, the
    /// first standard window. A ref naming a tab resolves to its window; `resolveTarget` also gives the tab.
    public static func resolve(pid: pid_t, ref: ComputerProtocol.WindowRef?) throws -> (element: AXUIElement, info: WindowInfo) {
        let resolved = try resolveTarget(pid: pid, ref: ref)
        return (resolved.element, resolved.info)
    }

    /// The window and, for a ref that matched a tab of a browser window, that tab: no side effect. A tab
    /// that is not selected is the handlers' to select (`TabSelect.select`).
    public static func resolveTarget(pid: pid_t, ref: ComputerProtocol.WindowRef?) throws -> (element: AXUIElement, info: WindowInfo, tab: TabTarget?) {
        let resolved = try WindowResolver(lookup: .live).resolve(app: appElement(pid), pid: pid, ref: ref, chromium: LiveBundles.kind(pid).isChromium)
        return (resolved.element, resolved.info, resolved.tab)
    }

    /// §25.1: whether the pid is a Chromium process, by its bundle (read once per bundle).
    public static func isChromium(pid: pid_t) -> Bool { LiveBundles.kind(pid).isChromium }

    /// Whether a tab element reads AXSelected true now.
    public static func tabSelected(_ tab: AXUIElement) -> Bool { LiveTabs.info(tab).selected }

    /// The tab of the window with this id whose title is `title` exactly, else contains it (`tc-ax select-tab`).
    public static func tab(pid: pid_t, windowID: Int, title: String) throws -> (window: AXUIElement, tab: TabTarget)? {
        let window = try resolveTarget(pid: pid, ref: ComputerProtocol.WindowRef(id: windowID)).element
        let tabs = LiveTabs.scan(window).tabs.map { ($0, LiveTabs.info($0)) }
        guard let hit = tabs.first(where: { $0.1.title == title }) ?? tabs.first(where: { $0.1.title.contains(title) }) else { return nil }
        return (window, TabTarget(element: hit.0, title: hit.1.title, selected: hit.1.selected))
    }

    /// One AX window's CGWindowID: the private symbol, else the window list's one match by title and frame.
    public static func windowID(of window: AXUIElement, pid: pid_t) -> Int? {
        _ = timeoutSet
        if let id = WindowIDLookup.live.lookup(window) { return Int(id) }
        let a = AX.batch(window, ["AXTitle", "AXPosition", "AXSize"])
        guard let frame = AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value) else { return nil }
        return WindowMatch.pick(WindowList.entries(), pid: pid, title: AX.string(a["AXTitle"]?.value) ?? "", frame: frame)
    }

    /// Every window, a Chromium app's browser windows with their tabs in strip order (`TabList.max`, then
    /// `moreTabs`, §25.4).
    public static func list(pid: pid_t) -> [WindowInfo] {
        let app = appElement(pid)
        let resolver = WindowResolver(lookup: .live)
        let entries = WindowList.entries()
        let chromium = LiveBundles.kind(pid).isChromium
        return resolver.windows(of: app).compactMap { w -> WindowInfo? in
            guard let info = try? resolver.describe(w, app: app, pid: pid, list: entries) else { return nil }
            guard chromium else { return info }
            let tabs = LiveTabs.scan(w).tabs
            guard !tabs.isEmpty else { return info }
            let shown = tabs.prefix(TabList.max).map(LiveTabs.info)
            return WindowInfo(id: info.id, title: info.title, frame: info.frame, main: info.main, focused: info.focused, minimized: info.minimized,
                              onScreen: info.onScreen, space: info.space, tabs: shown, moreTabs: tabs.count > TabList.max ? tabs.count - TabList.max : nil)
        }
    }

    /// Whether the window with this id holds an element of `role` whose title, description or value is `name`,
    /// within the first `limit` elements breadth first: how a proof tells one of several same-titled windows from another.
    public static func contains(pid: pid_t, windowID: Int, role: String, name: String, limit: Int = 600) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        let resolver = WindowResolver(lookup: .live)
        let entries = WindowList.entries()
        guard let window = resolver.windows(of: app).first(where: { (try? resolver.describe($0, app: app, pid: pid, list: entries))?.id == windowID }) else { return false }
        var queue = [window]
        var seen = 0
        while !queue.isEmpty, seen < limit {
            let el = queue.removeFirst()
            seen += 1
            let a = AX.batch(el, ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXChildren"])
            if AX.string(a["AXRole"]?.value) == role,
               [a["AXTitle"], a["AXDescription"], a["AXValue"]].contains(where: { AX.string($0?.value) == name }) { return true }
            queue += AX.elements(a["AXChildren"]?.value)
        }
        return false
    }
}
#endif
