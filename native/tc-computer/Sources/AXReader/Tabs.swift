#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// §25.1's bundle rule, live: an app's `Contents/Frameworks` read once per bundle (so once per pid at most)
/// and judged by `ChromiumBundle.kind`.
enum LiveBundles {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var kinds: [String: ChromiumBundle.Kind] = [:]

    static func kind(_ pid: pid_t) -> ChromiumBundle.Kind {
        guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return .native }
        lock.lock()
        let known = kinds[bundle.path]
        lock.unlock()
        if let known { return known }
        let kind = ChromiumBundle.kind(frameworks: frameworks(bundle))
        lock.lock()
        kinds[bundle.path] = kind
        lock.unlock()
        return kind
    }

    /// Each `*.framework` and the names in its `Helpers/` (Chrome links it at the framework's root; else the current version's).
    static func frameworks(_ bundle: URL) -> [ChromiumBundle.Framework] {
        let fm = FileManager.default
        let dir = bundle.appendingPathComponent("Contents/Frameworks")
        let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".framework") }.sorted().map { name in
            let framework = dir.appendingPathComponent(name)
            let helpers = ["Helpers", "Versions/Current/Helpers"].lazy
                .compactMap { try? fm.contentsOfDirectory(atPath: framework.appendingPathComponent($0).path) }.first ?? []
            return ChromiumBundle.Framework(name: name, helpers: helpers)
        }
    }
}

/// A browser window's tabs and top-level web areas, live, through `TabScan` and `PageRule`.
enum LiveTabs {
    static func scan(_ window: AXUIElement) -> TabScan.Found<AXUIElement> {
        TabScan.find(root: window) { el in
            let a = AX.batch(el, ["AXRole", "AXSubrole", "AXChildren"])
            return TabScan.Read(role: AX.string(a["AXRole"]?.value), subrole: AX.string(a["AXSubrole"]?.value), children: AX.elements(a["AXChildren"]?.value))
        }
    }

    static func info(_ tab: AXUIElement) -> TabInfo {
        let a = AX.batch(tab, ["AXTitle", "AXSelected"])
        return TabInfo(title: TabTitle.clean(AX.string(a["AXTitle"]?.value) ?? ""), selected: AX.bool(a["AXSelected"]?.value) == true)
    }

    static func webArea(_ el: AXUIElement, ids: HandleTable) -> PageRule.WebArea {
        let a = AX.batch(el, ["AXTitle", "AXURL", "AXLoaded", "AXElementBusy"])
        return PageRule.WebArea(id: ids.intern(el), title: AX.string(a["AXTitle"]?.value), url: AX.string(a["AXURL"]?.value),
                                loaded: AX.bool(a["AXLoaded"]?.value), busy: AX.bool(a["AXElementBusy"]?.value))
    }

    /// The window's page reading: nil when it has no tab strip. `ids` gives each web area its identity
    /// (CFEqual elements share one), so a page kept from before a switch is told from a new one.
    static func reading(_ window: AXUIElement, ids: HandleTable) -> (PageRule.Reading, TabScan.Found<AXUIElement>)? {
        let found = scan(window)
        guard !found.tabs.isEmpty else { return nil }
        let tabs = found.tabs.map(info)
        let selected = tabs.first { $0.selected }.map { PageRule.Tab(title: $0.title) }
        let areas = found.webAreas.map { webArea($0, ids: ids) }
        let page = selected.flatMap { PageRule.page(selectedTab: $0, webAreas: areas) }
        return (PageRule.Reading(tabs: tabs, selectedTab: selected, webAreas: areas, page: page), found)
    }
}

/// §25.4's tab selection, for the ComputerService handlers: they call it under the app's exclusive action
/// slot (§1), held from the selection through the wait, the steps and the observation, so two threads
/// never switch each other's tab between a selection and a read. Resolution (`AppWindows.resolveTarget`)
/// has no side effect; this is the one that presses.
public enum TabSelect {
    public struct Outcome: Sendable, Equatable, Codable {
        /// the tab's title, for `Observation.selectedTab`
        public let title: String
        /// false when the tab was already selected
        public let switched: Bool
        /// the page as the wait left it
        public let page: Page?
    }

    /// How long the press has to read back AXSelected true.
    public static let selectMs = 1_000
    static let pollMs = 50

    /// Select `tab` in `window` of `pid`: nothing when it is selected already; `tab_in_use` when `tabs` is
    /// not `any` and the person is looking at that window (the app active and the window its
    /// AXFocusedWindow); else AXPress on the tab, AXSelected read back, then the page wait of §25.2 up to
    /// `waitMs` (`busyMaxMs`): the page counts once the web area the window held before is gone.
    public static func select(pid: pid_t, window: AXUIElement, tab: AXUIElement, tabs mode: TabsMode = .background,
                              waitMs: Int = ComputerDefaults.Wait.action.busyMaxMs) throws -> Outcome {
        let want = LiveTabs.info(tab)
        let ids = HandleTable(capacity: 64)
        let before = LiveTabs.reading(window, ids: ids)
        if want.selected {
            return Outcome(title: want.title, switched: false, page: before.flatMap { r in r.0.state(waitedOut: false).map { Page(tab: want.title, state: $0) } })
        }
        let app = AppWindows.appElement(pid)
        let running = NSRunningApplication(processIdentifier: pid)
        if mode != .any, running?.isActive == true, let front = AX.element(AX.copy(app, "AXFocusedWindow").value), CFEqual(front, window) {
            let name = running?.localizedName ?? "The app"
            let title = AX.string(AX.copy(window, "AXTitle").value) ?? ""
            let showing = before?.0.selectedTab?.title ?? ""
            throw ComputerFailure(ComputerError(kind: .tabInUse, message: "\(name)'s window \(Quote.json(title)) is in front, on tab \(Quote.json(showing)); switch tabs with an act, which waits for the Mac to be free"))
        }
        let previous = before?.0.page?.id
        let e = AXUIElementPerformAction(tab, "AXPress" as CFString)
        guard e == .success else {
            if let failure = AXErrorMap.failure(AXErrorMap.slot(e), what: "The tab") { throw failure }
            throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "The tab \(Quote.json(want.title)) did not take AXPress (AX answered \(e.rawValue))", available: ["AXPress"]))
        }
        let start = DispatchTime.now().uptimeNanoseconds
        let elapsed = { Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000) }
        while !LiveTabs.info(tab).selected {
            guard elapsed() < selectMs else {
                throw ComputerFailure(ComputerError(kind: .timeout, message: "The tab \(Quote.json(want.title)) did not read back selected within \(selectMs) ms"))
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1_000)
        }
        // the page wait: the selected tab's page, with the one held before gone (a loading page ends it: the smart wait holds on that)
        var state: PageState?
        while true {
            let now = LiveTabs.reading(window, ids: ids)?.0
            let gone = now.map { r in !r.webAreas.contains { $0.id == previous } } ?? true
            let out = elapsed() >= waitMs
            if (now?.page != nil && gone) || out {
                state = now?.state(waitedOut: out, previous: previous) ?? .notDrawn
                break
            }
            Thread.sleep(forTimeInterval: Double(pollMs * 2) / 1_000)
        }
        return Outcome(title: want.title, switched: true, page: state.map { Page(tab: want.title, state: $0) })
    }
}
#endif
