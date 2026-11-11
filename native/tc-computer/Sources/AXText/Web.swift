import ComputerProtocol
import Foundation

// Web content in Chromium apps (docs/computer-protocol.md §25): which processes
// are Chromium, a browser window's tabs, which tab a window ref names, and the
// selected tab's page. Pure, so the box tests every rule; AXReader feeds them.

/// §25.1: a process is Chromium when its bundle holds a Chromium framework, whatever
/// AXManualAccessibility answers (Chrome refuses it with -25205, M1).
public enum ChromiumBundle {
    public enum Kind: Sendable, Equatable {
        /// a browser or any app shipping a `* Framework.framework` with a renderer helper (Chrome, Edge, Brave, Arc)
        case chrome
        case electron
        /// Chromium Embedded Framework
        case cef
        case native

        public var isChromium: Bool { self != .native }
    }

    /// One `Contents/Frameworks/*.framework` and the app names in its `Helpers/`.
    public struct Framework: Sendable, Equatable {
        public var name: String
        public var helpers: [String]

        public init(name: String, helpers: [String] = []) {
            self.name = name
            self.helpers = helpers
        }
    }

    public static let electron = "Electron Framework.framework"
    public static let cef = "Chromium Embedded Framework.framework"
    public static let rendererHelperSuffix = " Helper (Renderer).app"

    public static func kind(frameworks: [Framework]) -> Kind {
        if frameworks.contains(where: { $0.name == electron }) { return .electron }
        if frameworks.contains(where: { $0.name == cef }) { return .cef }
        let chrome = frameworks.contains { f in f.name.hasSuffix(".framework") && f.helpers.contains { $0.hasSuffix(rendererHelperSuffix) } }
        return chrome ? .chrome : .native
    }
}

/// §25.1: a browser window's tab strip, found breadth first. The scan stops at
/// `maxDepth` levels or `maxNodes` nodes and never enters an `AXWebArea`, so a
/// tab drawn by a page never counts; the web areas it meets are the window's
/// top-level ones (a nested web area is an iframe, inside another).
public enum TabScan {
    public static let maxDepth = ComputerDefaults.AXWalk.tabScanMaxDepth
    public static let maxNodes = ComputerDefaults.AXWalk.tabScanMaxNodes

    public struct Read<N> {
        public var role: String?
        public var subrole: String?
        public var children: [N]

        public init(role: String?, subrole: String?, children: [N]) {
            self.role = role
            self.subrole = subrole
            self.children = children
        }
    }

    public struct Found<N> {
        /// in strip order
        public var tabs: [N] = []
        /// the depth of each tab, the root at 0
        public var depths: [Int] = []
        /// top-level web areas, breadth first
        public var webAreas: [N] = []
        public var visited = 0
        /// a cap stopped the scan before the queue emptied
        public var capped = false
    }

    /// Chrome's tabs are `AXRadioButton` with subrole `AXTabButton` (M3).
    public static func isTab(role: String?, subrole: String?) -> Bool { subrole == "AXTabButton" }

    public static func find<N>(root: N, maxDepth: Int = maxDepth, maxNodes: Int = maxNodes, read: (N) -> Read<N>) -> Found<N> {
        var found = Found<N>()
        var queue: [(node: N, depth: Int)] = [(root, 0)]
        var at = 0
        while at < queue.count {
            if found.visited >= maxNodes {
                found.capped = true
                break
            }
            let (node, depth) = queue[at]
            at += 1
            found.visited += 1
            let r = read(node)
            if r.role == "AXWebArea" {
                found.webAreas.append(node)
                continue
            }
            if isTab(role: r.role, subrole: r.subrole) {
                found.tabs.append(node)
                found.depths.append(depth)
                continue
            }
            if depth < maxDepth {
                queue += r.children.map { ($0, depth + 1) }
            } else if !r.children.isEmpty {
                found.capped = true
            }
        }
        return found
    }
}

/// §2.1 as §25.4 widens it: which window, and which tab of it, a window ref names.
public enum TabMatch {
    public struct Window: Sendable, Equatable {
        /// nil when the caller did not read it (a ref without an id)
        public var id: Int?
        public var title: String
        /// empty for a window with no tab strip, or of an app that is not Chromium
        public var tabs: [TabInfo]

        public init(id: Int? = nil, title: String, tabs: [TabInfo] = []) {
            self.id = id
            self.title = title
            self.tabs = tabs
        }
    }

    public enum Pick: Sendable, Equatable {
        case window(Int)
        case tab(window: Int, tab: Int)

        public var window: Int {
            switch self {
            case .window(let w), .tab(let w, _): w
            }
        }
    }

    /// `id`; the window title exactly; a tab title exactly in any window; the window title as a
    /// substring; a tab title as a substring. The first of several wins, windows in AX order and
    /// tabs in strip order. Nil for a ref that names nothing (the caller's main-window default) or no match.
    public static func pick(windows: [Window], ref: WindowRef) -> Pick? {
        if let id = ref.id { return windows.firstIndex { $0.id == id }.map(Pick.window) }
        guard let title = ref.title else { return nil }
        if let w = windows.firstIndex(where: { $0.title == title }) { return .window(w) }
        if let hit = firstTab(windows, { $0 == title }) { return hit }
        if let w = windows.firstIndex(where: { $0.title.contains(title) }) { return .window(w) }
        return firstTab(windows) { $0.contains(title) }
    }

    private static func firstTab(_ windows: [Window], _ match: (String) -> Bool) -> Pick? {
        for (w, window) in windows.enumerated() {
            if let t = window.tabs.firstIndex(where: { match($0.title) }) { return .tab(window: w, tab: t) }
        }
        return nil
    }
}

/// A tab's title as the model reads it: its AXTitle less the memory status Chrome appends while a tab's
/// hover card shows (` - Memory usage - 36.4 MB`, recorded in chrome/loading), so the list and the match
/// see the page's title.
public enum TabTitle {
    public static func clean(_ title: String) -> String {
        guard let r = title.range(of: #" - Memory usage - [0-9][0-9.,]* ?[KMGT]?B$"#, options: .regularExpression) else { return title }
        return String(title[..<r.lowerBound])
    }
}

/// The tab list `apps.list` gives a browser window: at most `max`, then the count left out (§25.4).
public enum TabList {
    /// protocol.ts TAB_LIST_MAX
    public static let max = 50

    public static func cap(_ tabs: [TabInfo]) -> (tabs: [TabInfo], more: Int?) {
        tabs.count > max ? (Array(tabs.prefix(max)), tabs.count - max) : (tabs, nil)
    }
}

/// §25.2: the selected tab's page and its state.
public enum PageRule {
    /// While a Chromium window's selected tab has no web area, the reader reads again this long after
    /// the first read, at any time (this replaced §15's five seconds after the set).
    public static let rereadAfterMs: [Double] = [250, 500, 1_000, 1_500, 2_500, 3_500]

    public struct Tab: Sendable, Equatable {
        public var title: String
        /// AXSelected as read back; false right after a press that has not taken yet
        public var selected: Bool

        public init(title: String, selected: Bool = true) {
            self.title = title
            self.selected = selected
        }
    }

    public struct WebArea: Sendable, Equatable {
        /// live: the handle table's token, so CFEqual elements share one; offline: the node id
        public var id: NodeID
        public var title: String?
        /// AXURL, for a page with no `<title>`
        public var url: String?
        public var loaded: Bool?
        public var busy: Bool?
        /// inside another web area: an iframe, never the page
        public var nested: Bool

        public init(id: NodeID, title: String? = nil, url: String? = nil, loaded: Bool? = true, busy: Bool? = false, nested: Bool = false) {
            self.id = id
            self.title = title
            self.url = url
            self.loaded = loaded
            self.busy = busy
            self.nested = nested
        }
    }

    /// The top-level web area of the selected tab: the first in reading order not nested in another,
    /// whose title is the tab's (after collapsing white space); else the longest whose title the tab's
    /// begins with before ` - ` (Chrome adds a status to a tab's name: ` - Memory usage - 36.4 MB` in the
    /// recorded chrome/loading); else, for an untitled page, the one whose URL the tab shows.
    /// `previous`, the page the window held before a switch, never counts.
    public static func page(selectedTab tab: Tab, webAreas: [WebArea], previous: NodeID? = nil) -> WebArea? {
        let candidates = webAreas.filter { !$0.nested && $0.id != previous }
        let want = squeeze(tab.title)
        guard !want.isEmpty else { return nil }
        if let hit = candidates.first(where: { squeeze($0.title ?? "") == want }) { return hit }
        let prefixed = candidates.filter { a in
            let t = squeeze(a.title ?? "")
            return !t.isEmpty && want.hasPrefix(t + " - ")
        }
        if let hit = prefixed.max(by: { squeeze($0.title ?? "").count < squeeze($1.title ?? "").count }) { return hit }
        return candidates.first { squeeze($0.title ?? "").isEmpty && ($0.url.map { urlShown($0, as: tab.title) } ?? false) }
    }

    /// `loaded` (the page, AXLoaded true and not busy), `loading` (the page loading, or none yet within
    /// the wait) or `not-drawn` (none at its end); nil for a window with no selected tab. After a switch
    /// the page counts only once `previous` is gone from the window, so a second tab of the same title
    /// never passes for the first; a selection that has not read back true waits.
    public static func state(selectedTab: Tab?, webAreas: [WebArea], waitedOut: Bool, previous: NodeID? = nil) -> PageState? {
        guard let tab = selectedTab else { return nil }
        let missing: PageState = waitedOut ? .notDrawn : .loading
        if let previous, webAreas.contains(where: { $0.id == previous }) { return missing }
        guard tab.selected, let area = page(selectedTab: tab, webAreas: webAreas, previous: previous) else { return missing }
        return area.loaded == false || area.busy == true ? .loading : .loaded
    }

    /// Whether a tab's title is how Chrome shows `url` for a page with no title: the URL, without its
    /// scheme, its host (and port), or its last path component.
    public static func urlShown(_ url: String, as title: String) -> Bool {
        let t = squeeze(title)
        guard !t.isEmpty else { return false }
        var forms = [url]
        let bare = url.range(of: "://").map { String(url[$0.upperBound...]) } ?? url
        forms += [bare, bare.hasSuffix("/") ? String(bare.dropLast()) : bare]
        if let c = URLComponents(string: url) {
            if let host = c.host, !host.isEmpty { forms.append(c.port.map { "\(host):\($0)" } ?? host) }
            if let last = c.path.split(separator: "/").last.map(String.init) { forms.append(last.removingPercentEncoding ?? last) }
        }
        return forms.contains(t)
    }

    static func squeeze(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// What a walked (or recorded) window says of its page: its tabs, the selected one, its top-level
    /// web areas, and the page found. A tab strip with no selected tab reads as no selected tab.
    public struct Reading: Sendable, Equatable {
        public var tabs: [TabInfo]
        public var selectedTab: Tab?
        public var webAreas: [WebArea]
        public var page: WebArea?

        public init(tabs: [TabInfo], selectedTab: Tab?, webAreas: [WebArea], page: WebArea?) {
            self.tabs = tabs
            self.selectedTab = selectedTab
            self.webAreas = webAreas
            self.page = page
        }

        /// a browser window whose selected tab has no web area: the reader reads again (§25.2) and the
        /// smart wait holds (`BusyRule.Kind.pageMissing`)
        public var missing: Bool { selectedTab != nil && page == nil }

        public func state(waitedOut: Bool, previous: NodeID? = nil) -> PageState? {
            PageRule.state(selectedTab: selectedTab, webAreas: webAreas, waitedOut: waitedOut, previous: previous)
        }
    }

    /// The reading of one window root, through `TabScan`'s caps. Nil when the window has no tab strip.
    public static func read(_ root: AXNode) -> Reading? {
        let found = TabScan.find(root: root) { TabScan.Read(role: $0.role, subrole: $0.subrole, children: $0.children) }
        guard !found.tabs.isEmpty else { return nil }
        let tabs = found.tabs.map { TabInfo(title: TabTitle.clean($0.title ?? ""), selected: $0.flags.selected == true) }
        let selected = tabs.first { $0.selected }.map { Tab(title: $0.title) }
        let areas = found.webAreas.map { WebArea(id: $0.id, title: $0.title, url: $0.url, loaded: $0.flags.loaded, busy: $0.flags.busy) }
        return Reading(tabs: tabs, selectedTab: selected, webAreas: areas, page: selected.flatMap { page(selectedTab: $0, webAreas: areas) })
    }
}
