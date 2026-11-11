@testable import AXText
import ComputerProtocol
import Foundation
import Testing

// Web content in Chromium apps (docs/computer-protocol.md §25): the bundle rule, the tab strip,
// which tab a ref names, the page rule, the read-ahead and its parity with the walker's cut.

func recorded(_ state: String) throws -> RawAXTree {
    try RawTree.decode(Data(contentsOf: Goldens.apps.appendingPathComponent("\(state)/tree.json")))
}

func rawRead(_ n: RawAXNode) -> TabScan.Read<RawAXNode> { TabScan.Read(role: n.role, subrole: n.subrole, children: n.children) }

@Suite struct ChromiumBundleTests {
    typealias F = ChromiumBundle.Framework

    @Test func aFrameworkWithARendererHelperIsChrome() {
        let chrome = [F(name: "Google Chrome Framework.framework", helpers: ["Google Chrome Helper.app", "Google Chrome Helper (GPU).app", "Google Chrome Helper (Renderer).app"])]
        #expect(ChromiumBundle.kind(frameworks: chrome) == .chrome)
        // Edge, Brave and Chrome for Testing ship the same shape under their own names
        #expect(ChromiumBundle.kind(frameworks: [F(name: "Microsoft Edge Framework.framework", helpers: ["Microsoft Edge Helper (Renderer).app"])]) == .chrome)
    }

    @Test func electronAndCEFAreNamedByTheirFramework() {
        #expect(ChromiumBundle.kind(frameworks: [F(name: "Squirrel.framework"), F(name: "Electron Framework.framework")]) == .electron)
        #expect(ChromiumBundle.kind(frameworks: [F(name: "Chromium Embedded Framework.framework")]) == .cef)
    }

    @Test func anythingElseIsNative() {
        #expect(ChromiumBundle.kind(frameworks: []) == .native)
        #expect(ChromiumBundle.kind(frameworks: [F(name: "Sparkle.framework", helpers: ["Updater.app"])]) == .native)
        #expect(ChromiumBundle.kind(frameworks: [F(name: "Helpers.bundle", helpers: ["X Helper (Renderer).app"])]) == .native)
        #expect(!ChromiumBundle.Kind.native.isChromium && ChromiumBundle.Kind.chrome.isChromium)
    }
}

@Suite struct TabScanTests {
    @Test func theRecordedChromeWindowHasItsTabEightLevelsDown() throws {
        let tree = try recorded("chrome/form")
        let found = TabScan.find(root: tree.root, read: rawRead)
        #expect(found.tabs.map(\.title) == ["Computer fixture form"])
        #expect(found.depths == [8])
        #expect(found.tabs.first?.selected == true)
        // the form's two radio buttons sit inside the page and never count; its one web area is the top-level one
        #expect(found.webAreas.map(\.title) == ["Computer fixture form"])
        #expect(!found.capped)
    }

    @Test func aTabInsideAWebAreaNeverCounts() {
        let t = Tree()
        let window = t.window([
            t.node("AXGroup", nil, [t.node("AXWebArea", title: "Page", [t.node("AXRadioButton", "AXTabButton", title: "Drawn by the page")])])
        ])
        let found = TabScan.find(root: window) { TabScan.Read(role: $0.role, subrole: $0.subrole, children: $0.children) }
        #expect(found.tabs.isEmpty)
        #expect(found.webAreas.count == 1)
        #expect(PageRule.read(window) == nil)
    }

    @Test func theScanStopsAtItsDepthAndItsNodes() {
        let t = Tree()
        var deep = t.node("AXRadioButton", "AXTabButton", title: "Deep")
        for _ in 0..<13 { deep = t.node("AXGroup", nil, [deep]) }
        let read = { (n: AXNode) in TabScan.Read(role: n.role, subrole: n.subrole, children: n.children) }
        let window = t.window([deep])
        // the tab is 14 levels down: past the 12 the scan reads
        #expect(TabScan.find(root: window, read: read).tabs.isEmpty)
        #expect(TabScan.find(root: window, read: read).capped)
        #expect(TabScan.find(root: window, maxDepth: 14, read: read).tabs.count == 1)
        let wide = t.window((0..<700).map { _ in t.node("AXGroup") } + [t.node("AXRadioButton", "AXTabButton", title: "Late")])
        let capped = TabScan.find(root: wide, read: read)
        #expect(capped.tabs.isEmpty && capped.capped && capped.visited == TabScan.maxNodes)
    }
}

@Suite struct TabMatchTests {
    let windows = [
        TabMatch.Window(id: 11, title: "TC field front 1 - Google Chrome", tabs: [TabInfo(title: "TC field front 1", selected: true), TabInfo(title: "TC field report 1", selected: false)]),
        TabMatch.Window(id: 12, title: "Report - Google Chrome", tabs: [TabInfo(title: "Report", selected: true), TabInfo(title: "Inbox (3)", selected: false)]),
        TabMatch.Window(id: 13, title: "TC field report 1 notes", tabs: [])
    ]

    func pick(_ title: String) -> TabMatch.Pick? { TabMatch.pick(windows: windows, ref: WindowRef(title: title)) }

    @Test func anIdNamesItsWindowAlone() {
        #expect(TabMatch.pick(windows: windows, ref: WindowRef(id: 12)) == .window(1))
        #expect(TabMatch.pick(windows: windows, ref: WindowRef(id: 99, title: "Report")) == nil)
        #expect(TabMatch.pick(windows: windows, ref: WindowRef()) == nil)
    }

    @Test func aWindowTitleExactlyComesBeforeAnyTab() {
        #expect(pick("TC field report 1 notes") == .window(2))
        #expect(pick("Report - Google Chrome") == .window(1))
    }

    @Test func aTabTitleExactlyComesBeforeAWindowTitleAsASubstring() {
        // "TC field report 1" is in window 2's title, but it is window 0's tab exactly
        #expect(pick("TC field report 1") == .tab(window: 0, tab: 1))
        #expect(pick("Report") == .tab(window: 1, tab: 0))
        // the selected tab is a match too: the caller selects nothing then
        #expect(pick("TC field front 1") == .tab(window: 0, tab: 0))
    }

    @Test func thenAWindowTitleThenATabTitleAsASubstring() {
        #expect(pick("Google Chrome") == .window(0))
        #expect(pick("Inbox") == .tab(window: 1, tab: 1))
        #expect(pick("nowhere") == nil)
        #expect(pick("Inbox")?.window == 1)
    }

    @Test func theFirstOfSeveralWinsInAXOrder() {
        let twins = [TabMatch.Window(title: "A", tabs: [TabInfo(title: "Docs", selected: false)]), TabMatch.Window(title: "B", tabs: [TabInfo(title: "Docs", selected: true)])]
        #expect(TabMatch.pick(windows: twins, ref: WindowRef(title: "Docs")) == .tab(window: 0, tab: 0))
    }

    @Test func theTabListStopsAtFiftyAndCountsTheRest() {
        let many = (0..<53).map { TabInfo(title: "t\($0)", selected: $0 == 0) }
        let (tabs, more) = TabList.cap(many)
        #expect(tabs.count == 50 && more == 3)
        #expect(TabList.cap(Array(many.prefix(50))).more == nil)
    }
}

@Suite struct PageRuleTests {
    typealias Area = PageRule.WebArea
    let report = PageRule.Tab(title: "TC field report 1")

    @Test func theTopLevelWebAreaOfTheTabsTitleIsThePage() {
        let areas = [Area(id: 1, title: "Ad", nested: false), Area(id: 2, title: "TC field report 1"), Area(id: 3, title: "TC field report 1")]
        #expect(PageRule.page(selectedTab: report, webAreas: areas)?.id == 2)
        #expect(PageRule.state(selectedTab: report, webAreas: areas, waitedOut: false) == .loaded)
        // white space Chrome collapses in the tab's title
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "TC  field report 1 "), webAreas: areas)?.id == 2)
    }

    @Test func aNestedIframeOfThatTitleIsNotThePage() {
        let areas = [Area(id: 1, title: "Other"), Area(id: 2, title: "TC field report 1", nested: true)]
        #expect(PageRule.page(selectedTab: report, webAreas: areas) == nil)
        #expect(PageRule.state(selectedTab: report, webAreas: areas, waitedOut: false) == .loading)
        #expect(PageRule.state(selectedTab: report, webAreas: areas, waitedOut: true) == .notDrawn)
    }

    @Test func aStaleOldPageIsNotTheNewOneAndHoldsTheSwitch() {
        // two tabs of one title with different content: the switch counts only once the old page is gone
        let old = Area(id: 7, title: "Report"), new = Area(id: 8, title: "Report")
        let tab = PageRule.Tab(title: "Report")
        #expect(PageRule.state(selectedTab: tab, webAreas: [old], waitedOut: false, previous: 7) == .loading)
        #expect(PageRule.state(selectedTab: tab, webAreas: [old, new], waitedOut: false, previous: 7) == .loading)
        #expect(PageRule.state(selectedTab: tab, webAreas: [old], waitedOut: true, previous: 7) == .notDrawn)
        #expect(PageRule.state(selectedTab: tab, webAreas: [new], waitedOut: false, previous: 7) == .loaded)
        #expect(PageRule.page(selectedTab: tab, webAreas: [old, new], previous: 7)?.id == 8)
    }

    @Test func aSelectionThatHasNotReadBackTrueWaits() {
        let pressed = PageRule.Tab(title: "TC field report 1", selected: false)
        let areas = [Area(id: 2, title: "TC field report 1")]
        #expect(PageRule.state(selectedTab: pressed, webAreas: areas, waitedOut: false) == .loading)
        #expect(PageRule.state(selectedTab: pressed, webAreas: areas, waitedOut: true) == .notDrawn)
    }

    @Test func aPageStillLoadingOrBusyIsLoading() {
        #expect(PageRule.state(selectedTab: report, webAreas: [Area(id: 1, title: "TC field report 1", loaded: false)], waitedOut: true) == .loading)
        #expect(PageRule.state(selectedTab: report, webAreas: [Area(id: 1, title: "TC field report 1", busy: true)], waitedOut: false) == .loading)
        #expect(PageRule.state(selectedTab: report, webAreas: [Area(id: 1, title: "TC field report 1", loaded: nil, busy: nil)], waitedOut: false) == .loaded)
    }

    @Test func anUntitledPageMatchesByTheURLItsTabShows() {
        let file = Area(id: 1, title: "", url: "file:///tmp/tc-field/report%20long.html")
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "report long.html"), webAreas: [file])?.id == 1)
        let local = Area(id: 2, title: nil, url: "http://localhost:5173/")
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "localhost:5173"), webAreas: [local])?.id == 2)
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "localhost:5173/"), webAreas: [local])?.id == 2)
        // a titled page never matches by URL, and an empty tab title matches nothing
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "localhost:5173"), webAreas: [Area(id: 3, title: "Vite", url: "http://localhost:5173/")]) == nil)
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: ""), webAreas: [Area(id: 4, title: "")]) == nil)
    }

    @Test func aStatusChromeAddsToTheTabsNameStillFindsThePage() {
        // chrome/loading's tab: "Computer fixture form - Memory usage - 36.4 MB" over the page "Computer fixture form"
        let page = Area(id: 1, title: "Computer fixture form")
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "Computer fixture form - Memory usage - 36.4 MB"), webAreas: [page])?.id == 1)
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "Computer fixture form - Audio playing"), webAreas: [page])?.id == 1)
        // the exact title first, then the longest page title the tab's begins with
        let both = [Area(id: 2, title: "Report"), Area(id: 3, title: "Report - Q3")]
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "Report - Q3 - Audio playing"), webAreas: both)?.id == 3)
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "Report"), webAreas: both)?.id == 2)
        #expect(PageRule.page(selectedTab: PageRule.Tab(title: "Reports"), webAreas: both) == nil)
        #expect(TabTitle.clean("Computer fixture form - Memory usage - 36.4 MB") == "Computer fixture form")
        #expect(TabTitle.clean("Usage - Memory usage - 1,204 KB") == "Usage")
        #expect(TabTitle.clean("Memory usage - a guide") == "Memory usage - a guide")
    }

    @Test func theRecordedStatesReadTheirPageLoaded() throws {
        for state in ["chrome/form", "chrome/loading", "chrome/menu-open"] {
            let reading = try #require(PageRule.read(RawTree.snapshot(try recorded(state), ids: NodeIDSource()).roots[0]))
            #expect(reading.tabs == [TabInfo(title: "Computer fixture form", selected: true)], "\(state)")
            #expect(reading.state(waitedOut: true) == .loaded, "\(state)")
        }
    }

    @Test func noTabStripIsNoPageState() {
        #expect(PageRule.state(selectedTab: nil, webAreas: [Area(id: 1, title: "x")], waitedOut: true) == nil)
    }

    @Test func aWalkedWindowReadsItsTabsAndPage() {
        let t = Tree()
        let strip = t.node("AXTabGroup", nil, [
            t.node("AXRadioButton", "AXTabButton", title: "Front", flags: AXFlags(selected: false)),
            t.node("AXRadioButton", "AXTabButton", title: "Report", flags: AXFlags(selected: true))
        ])
        let page = t.node("AXWebArea", title: "Report", flags: AXFlags(busy: false, loaded: true), [t.node("AXWebArea", title: "Front", flags: AXFlags(loaded: true))])
        let reading = PageRule.read(t.window([t.node("AXGroup", nil, [strip]), t.node("AXScrollArea", nil, [page])]))
        #expect(reading?.tabs == [TabInfo(title: "Front", selected: false), TabInfo(title: "Report", selected: true)])
        #expect(reading?.selectedTab == PageRule.Tab(title: "Report"))
        // the iframe titled like the other tab is inside the page: never scanned
        #expect(reading?.webAreas.count == 1)
        #expect(reading?.page?.id == page.id && reading?.missing == false)
        #expect(reading?.state(waitedOut: true) == .loaded)
        let blank = PageRule.read(t.window([t.node("AXGroup", nil, [strip]), t.node("AXScrollArea")]))
        #expect(blank?.missing == true && blank?.state(waitedOut: false) == .loading && blank?.state(waitedOut: true) == .notDrawn)
    }

    @Test func theReReadScheduleIsTheSpecs() {
        #expect(PageRule.rereadAfterMs == [250, 500, 1_000, 1_500, 2_500, 3_500])
        #expect(ManualAccessibility.retryAfterMs == PageRule.rereadAfterMs)
    }
}

@Suite struct PageBusyAndBundleRetryTests {
    final class Clock: @unchecked Sendable {
        var now: Double = 10_000
    }

    @Test func theBundleDecidesChromiumWhateverTheSetAnswers() {
        let c = Clock()
        let chrome = ManualAccessibility(set: { _ in false }, kind: { _ in .chrome }, clock: { c.now })
        #expect(chrome.prepare(7) == .chromium(setAt: 10_000))
        let native = ManualAccessibility(set: { _ in false }, kind: { _ in .native }, clock: { c.now })
        #expect(native.prepare(8) == .native)
        // an Electron set that took still counts, bundle or not
        #expect(ManualAccessibility(set: { _ in true }, kind: { _ in .native }, clock: { c.now }).prepare(9) == .chromium(setAt: 10_000))
    }

    @Test func aMissingPageRereadsFromTheReadAtAnyTime() {
        let c = Clock()
        let m = ManualAccessibility(set: { _ in false }, kind: { _ in .chrome }, clock: { c.now })
        _ = m.prepare(7)
        c.now = 70_000
        // a minute after the set: the thin rule is over, the page rule is not
        #expect(m.retries(7, thin: true).isEmpty)
        #expect(m.retries(7, thin: false, pageMissing: true) == [70_250, 70_500, 71_000, 71_500, 72_500, 73_500])
        c.now = 70_600
        #expect(m.retries(7, thin: false, pageMissing: true, readAt: 70_000) == [71_000, 71_500, 72_500, 73_500])
        let native = ManualAccessibility(set: { _ in false }, clock: { c.now })
        _ = native.prepare(8)
        #expect(native.retries(8, thin: true, pageMissing: true).isEmpty)
    }

    @Test func aSelectedTabWithoutItsPageHoldsTheWait() {
        #expect(BusyRule.showing(.pageMissing, frame: nil, hasValue: false, busy: nil, loaded: false, clips: []))
        #expect(!BusyRule.showing(.pageMissing, frame: nil, hasValue: false, busy: nil, loaded: true, clips: []))
        #expect(BusyRule.pageMissing(.loading) && BusyRule.pageMissing(.notDrawn) && !BusyRule.pageMissing(.loaded) && !BusyRule.pageMissing(nil))
    }
}

@Suite struct ViewportReadAheadTests {
    /// window 800×600 at 0,0; the page's visible rect y 100 to 600; rows 20 pt from y 100
    static let window = Rect(x: 0, y: 0, w: 800, h: 600)
    static let pageFrame = Rect(x: 0, y: 100, w: 800, h: 500)

    static func row(_ i: Int, top: Double = 100, visible: Bool?) -> RawAXNode {
        RawAXNode(role: "AXRow", visible: visible, frame: Rect(x: 0, y: top + Double(i) * 20, w: 800, h: 20),
                  children: [RawAXNode(role: "AXCell", frame: Rect(x: 0, y: top + Double(i) * 20, w: 200, h: 20), children: [
                      RawAXNode(role: "AXStaticText", value: RawAXValue(type: .string, text: "City \(i)"), frame: Rect(x: 0, y: top + Double(i) * 20, w: 200, h: 20), children: [])
                  ])])
    }

    /// A page with a 120-row table in its own flow (its visible-rows list names the physical viewport only)
    /// and an overflow box: a scroll area of 30 rows of which it lists 10, the rest parked as slivers.
    static func longPage() -> RawAXTree {
        let table = RawAXNode(role: "AXTable", title: "Revenue", frame: Rect(x: 0, y: 100, w: 800, h: 2400),
                              children: (0..<120).map { row($0, visible: $0 < 25) })
        let boxRows = (0..<30).map { i -> RawAXNode in
            let top = 2600 + Double(i) * 20
            let frame = i < 10 ? Rect(x: 0, y: top, w: 400, h: 20) : Rect(x: 0, y: 2800, w: 400, h: 1)
            return RawAXNode(role: "AXGroup", visible: true, frame: frame, children: [RawAXNode(role: "AXStaticText", value: RawAXValue(type: .string, text: "Note \(i)"), frame: frame, children: [])])
        }
        let box = RawAXNode(role: "AXScrollArea", frame: Rect(x: 0, y: 2600, w: 400, h: 200), children: [
            RawAXNode(role: "AXList", frame: Rect(x: 0, y: 2600, w: 400, h: 200), children: boxRows)
        ])
        let far = RawAXNode(role: "AXHeading", title: "Far below", frame: Rect(x: 0, y: 9000, w: 800, h: 30), children: [])
        let page = RawAXNode(role: "AXWebArea", title: "Report", loaded: true, frame: pageFrame, children: [table, box, far])
        let tab = RawAXNode(role: "AXRadioButton", subrole: "AXTabButton", title: "Report", selected: true, frame: Rect(x: 80, y: 0, w: 200, h: 40), children: [])
        let root = RawAXNode(role: "AXWindow", subrole: "AXStandardWindow", title: "Report - Google Chrome", frame: window, children: [
            RawAXNode(role: "AXGroup", frame: Rect(x: 0, y: 0, w: 800, h: 100), children: [RawAXNode(role: "AXTabGroup", frame: Rect(x: 80, y: 0, w: 400, h: 40), children: [tab])]),
            RawAXNode(role: "AXScrollArea", frame: pageFrame, children: [page])
        ])
        return RawAXTree(recordedAt: "2026-11-10T00:00:00Z", recorder: "hand", app: .init(name: "Google Chrome", bundleId: "com.google.Chrome", version: "156"),
                         os: "macOS 27.2.0", window: .init(title: "Report - Google Chrome", frame: window), scale: 2, manualAccessibility: .init(rawValue: "refused"),
                         walk: .init(nodes: 0, depth: 7, ms: 1, capped: false), root: root)
    }

    @Test func aTopLevelWebAreaReadsOneScreenAboveAndThreeBelow() {
        let clip = Viewport.childClip(role: "AXWebArea", frame: Self.pageFrame, clip: Self.window, scope: .window)
        #expect(clip == Rect(x: 0, y: -400, w: 800, h: 2_000 + 500))
        // a nested web area (an iframe) and the busy scan (no scope) keep the physical cut
        #expect(Viewport.childClip(role: "AXWebArea", frame: Self.pageFrame, clip: Self.window, scope: Viewport.Scope(page: true, inFlow: true)) == Rect(x: 0, y: 100, w: 800, h: 500))
        #expect(Viewport.childClip(role: "AXWebArea", frame: Self.pageFrame, clip: Self.window) == Rect(x: 0, y: 100, w: 800, h: 500))
        #expect(Viewport.Scope.window.inside("AXWebArea").inside("AXGroup").trustsVisibleLists == false)
        #expect(Viewport.Scope.window.inside("AXWebArea").inside("AXScrollArea").trustsVisibleLists)
        #expect(Viewport.Scope.window.trustsVisibleLists)
    }

    func table(_ s: AXSnapshot) -> AXNode? {
        func find(_ n: AXNode) -> AXNode? { n.role == "AXTable" ? n : n.children.lazy.compactMap(find).first }
        return find(s.roots[0])
    }

    @Test func rowsOfThePagesOwnFlowAreReadPastThePhysicalViewport() throws {
        let s = RawTree.snapshot(Self.longPage(), ids: NodeIDSource())
        let t = try #require(table(s))
        // rows from y 100 to the read-ahead's end at 2,100: 100 of them, though the list named 25
        #expect(t.children.count == 100)
        #expect(t.hidden == Hidden(above: 0, below: 20))
        let text = Reader().read(s, budget: 96_000).text
        #expect(text.contains("\"City 99\"") && !text.contains("\"City 100\""))
        #expect(text.contains("… 20 more below"))
        #expect(!text.contains("Far below"))
    }

    /// The page as Chrome 156 gives it (measured 2026-11-11): the table's frame cut to the visible page, and each
    /// off-screen row's text cut to 0 pt high at the visible page's bottom edge; the rows keep their layout frames.
    static func clippedPage() -> RawAXTree {
        let rows = (0..<120).map { i -> RawAXNode in
            let top = 100 + Double(i) * 20
            let onScreen = top + 20 <= 600
            let text = RawAXNode(role: "AXStaticText", value: RawAXValue(type: .string, text: "City \(i)"),
                                 frame: onScreen ? Rect(x: 0, y: top, w: 200, h: 20) : Rect(x: 0, y: 600, w: 200, h: 0), children: [])
            return RawAXNode(role: "AXRow", frame: Rect(x: 0, y: top, w: 800, h: 20), children: [
                RawAXNode(role: "AXCell", frame: Rect(x: 0, y: top, w: 200, h: 20), children: [text])
            ])
        }
        let table = RawAXNode(role: "AXTable", title: "Revenue", frame: Rect(x: 0, y: 100, w: 800, h: 500), children: rows)
        let page = RawAXNode(role: "AXWebArea", title: "Report", loaded: true, frame: pageFrame, children: [table])
        let tab = RawAXNode(role: "AXRadioButton", subrole: "AXTabButton", title: "Report", selected: true, frame: Rect(x: 80, y: 0, w: 200, h: 40), children: [])
        let root = RawAXNode(role: "AXWindow", subrole: "AXStandardWindow", title: "Report - Google Chrome", frame: window, children: [
            RawAXNode(role: "AXGroup", frame: Rect(x: 0, y: 0, w: 800, h: 100), children: [RawAXNode(role: "AXTabGroup", frame: Rect(x: 80, y: 0, w: 400, h: 40), children: [tab])]),
            RawAXNode(role: "AXScrollArea", frame: pageFrame, children: [page])
        ])
        return RawAXTree(recordedAt: "2026-11-11T00:00:00Z", recorder: "hand", app: .init(name: "Google Chrome for Testing", bundleId: "com.google.chrome.for.testing", version: "156"),
                         os: "macOS 27.2.0", window: .init(title: "Report - Google Chrome", frame: window), scale: 2, manualAccessibility: .init(rawValue: "refused"),
                         walk: .init(nodes: 0, depth: 7, ms: 1, capped: false), root: root)
    }

    @Test func aTableChromeCutToTheVisiblePageStillReadsAheadWithItsOffScreenText() throws {
        let s = RawTree.snapshot(Self.clippedPage(), ids: NodeIDSource())
        let t = try #require(table(s))
        // the page's read-ahead ends at 2,100, past the table's cut frame (600): 100 rows read, 20 below
        #expect(t.children.count == 100)
        #expect(t.hidden == Hidden(above: 0, below: 20))
        let text = Reader().read(s, budget: 96_000).text
        // the zero-height texts of off-screen rows are kept in web content
        #expect(text.contains("\"City 30\"") && text.contains("\"City 99\"") && !text.contains("\"City 100\""))
        // a list or table inside an overflow box keeps its own clip, and a native window keeps the zero-size rule
        #expect(Viewport.childClip(role: "AXTable", frame: Rect(x: 0, y: 100, w: 800, h: 500), clip: Rect(x: 0, y: -400, w: 800, h: 2_500),
                                   scope: Viewport.Scope(page: true, inFlow: true)) == Rect(x: 0, y: -400, w: 800, h: 2_500))
        #expect(Viewport.childClip(role: "AXTable", frame: Rect(x: 0, y: 100, w: 800, h: 500), clip: Rect(x: 0, y: -400, w: 800, h: 2_500),
                                   scope: Viewport.Scope(page: true, inFlow: false)) == Rect(x: 0, y: 100, w: 800, h: 500))
    }

    @Test func anElementReadOfAPageTableReadsAsThePage() throws {
        var s = RawTree.snapshot(Self.clippedPage(), ids: NodeIDSource())
        let t = try #require(table(s))
        s.roots = [t]
        s.ambientActions = ["AXShowMenu"]
        // not known as web content: the zero-height texts of the off-screen rows are walked through
        #expect(!Reader().read(s, budget: 96_000).text.contains("\"City 99\""))
        s.rootsInWeb = true
        let text = Reader().read(s, budget: 96_000).text
        #expect(text.contains("\"City 30\"") && text.contains("\"City 99\""))
    }

    @Test func aScrollAreaInThePageKeepsItsOwnClipListAndSlivers() throws {
        let s = RawTree.snapshot(Self.longPage(), ids: NodeIDSource())
        func find(_ n: AXNode) -> AXNode? { n.role == "AXList" ? n : n.children.lazy.compactMap(find).first }
        // the box is at 2,600, outside the extended clip's 2,100: the page counts it below and never reads it
        #expect(find(s.roots[0]) == nil)
        var tree = Self.longPage()
        // move the box into the read-ahead: its 10 rows read, its 20 slivers counted below
        tree = RawAXTree(recordedAt: tree.recordedAt, recorder: tree.recorder, app: tree.app, os: tree.os, window: tree.window, scale: tree.scale,
                         manualAccessibility: tree.manualAccessibility, walk: tree.walk, root: shifted(tree.root, by: -1_000))
        let near = try #require(find(RawTree.snapshot(tree, ids: NodeIDSource()).roots[0]))
        #expect(near.children.count == 10)
        #expect(near.hidden == Hidden(above: 0, below: 20))
    }

    /// Everything under the page's scroll area at y ≥ 2,600 moved by `dy`.
    func shifted(_ n: RawAXNode, by dy: Double) -> RawAXNode {
        let f = n.frame.map { $0.y >= 2_600 ? Rect(x: $0.x, y: $0.y + dy, w: $0.w, h: $0.h) : $0 }
        return RawAXNode(role: n.role, subrole: n.subrole, title: n.title, value: n.value, selected: n.selected, loaded: n.loaded, visible: n.visible,
                         frame: f, children: n.children.map { shifted($0, by: dy) })
    }

    @Test func theRecordedFormPageReadsAhead() throws {
        // chrome/form's 60-row overflow box parks its rows as slivers: the read-ahead leaves that box as it was
        let s = RawTree.snapshot(try recorded("chrome/form"), ids: NodeIDSource())
        func find(_ n: AXNode) -> AXNode? { n.role == "AXList" ? n : n.children.lazy.compactMap(find).first }
        let list = try #require(find(s.roots[0]))
        #expect(list.children.count + (list.hidden?.below ?? 0) + (list.hidden?.above ?? 0) == 60)
    }

    // MARK: the walker's cut and RawTree's, held equal

    /// What the parity compares: role, name, children and the counts left unread.
    struct Shape: Equatable, CustomStringConvertible {
        var role: String
        var name: String?
        var hidden: Hidden?
        var children: [Shape]

        init(_ n: AXNode) {
            role = n.role
            name = n.title ?? n.description
            hidden = n.hidden
            children = n.children.map(Shape.init)
        }

        init(raw: RawAXNode, hidden: Hidden?, children: [Shape]) {
            role = raw.role
            name = raw.title ?? raw.description
            self.hidden = hidden
            self.children = children
        }

        var description: String { "\(role)\(name.map { " \"\($0)\"" } ?? "")\(hidden.map { " -\($0.above)/+\($0.below)" } ?? "")[\(children.map(\.description).joined(separator: ", "))]" }
    }

    /// The live walker's cut (AXReader/Walker.swift `node`), over a recorded tree answered the way AX
    /// answers the walk: a child's stage-A frame against its clip (`Viewport.cut`), and for the roles the
    /// walker asks (`Viewport.listRoles`) only, AXVisibleChildren or AXVisibleRows with AXRows as lists of
    /// child identities. Its own decisions are the shared ones (`Scope`, `childClip`, `ViewportCut`).
    func walk(_ raw: RawAXNode, clip: Rect?, scope: Viewport.Scope, root: Bool, sliver: Bool) -> ViewportCut.Outcome<Shape> {
        if !root, let side = Viewport.cut(role: raw.role, frame: raw.frame, clip: clip, sliver: sliver) { return .hidden(side) }
        let floats = raw.role == "AXPopover" || raw.role == "AXMenu"
        let inner = Viewport.childClip(role: raw.role, frame: raw.frame, clip: floats ? raw.frame : clip, scope: scope)
        let keys = Array(raw.children.indices)
        var lists: ViewportCut.Lists<Int>?
        if Viewport.listRoles.contains(raw.role), scope.trustsVisibleLists {
            let shown = keys.filter { raw.children[$0].visible == true }
            let rows = keys.filter { raw.children[$0].role == "AXRow" }
            lists = raw.role == "AXList" ? ViewportCut.Lists(visibleChildren: shown) : ViewportCut.Lists(visibleRows: shown.filter(rows.contains), rows: rows)
        }
        let (kept, hidden) = ViewportCut.children(raw.children, marks: ViewportCut.marks(keys, lists: lists, scope: scope)) { _, child in
            walk(child, clip: inner, scope: scope.inside(raw.role), root: false, sliver: Viewport.clipRoles.contains(raw.role))
        }
        return .node(Shape(raw: raw, hidden: hidden.isEmpty ? nil : hidden, children: kept))
    }

    func parity(_ tree: RawAXTree) -> (walker: Shape?, raw: Shape) {
        let raw = Shape(RawTree.snapshot(tree, ids: NodeIDSource()).roots[0])
        guard case .node(let w) = walk(tree.root, clip: tree.root.frame ?? tree.window.frame, scope: .window, root: true, sliver: false) else { return (nil, raw) }
        return (w, raw)
    }

    @Test func theWalkerAndRawTreeCutAPageAlikePastThePhysicalViewport() {
        let (walker, raw) = parity(Self.longPage())
        #expect(walker == raw)
    }

    @Test(arguments: ["chrome/form", "chrome/loading", "chrome/menu-open", "chrome/not-drawn"])
    func theWalkerAndRawTreeCutTheRecordedChromeAlike(_ state: String) throws {
        let (walker, raw) = parity(try recorded(state))
        #expect(walker == raw, "\(state)")
    }
}
