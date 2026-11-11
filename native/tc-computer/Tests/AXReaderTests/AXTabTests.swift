#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
@testable import AXReader
import AXText
import ComputerCore
import ComputerProtocol
import Foundation
import Testing

// §25's live seams. The bundle rule runs anywhere on the Mac (a scratch bundle under the temp dir);
// the tab cases need a scratch Chrome the caller launched and named, with two tabs of the field rig's
// pages and nothing of the person's: TC_AX_TEST_CHROME_PID=<pid>, TC_AX_TEST_CHROME_WINDOW=<its window's
// exact title>, TC_AX_TEST_CHROME_TAB=<the background tab's title>, and Accessibility granted to the
// test runner. Without them they skip; they never launch, raise or activate anything themselves.

enum ScratchChrome {
    static let env = ProcessInfo.processInfo.environment
    static var pid: pid_t? { env["TC_AX_TEST_CHROME_PID"].flatMap { pid_t($0) } }
    static var window: String? { env["TC_AX_TEST_CHROME_WINDOW"] }
    static var tab: String? { env["TC_AX_TEST_CHROME_TAB"] }
    static var ready: Bool { pid != nil && window != nil && tab != nil && AXIsProcessTrusted() }
}

@Suite struct LiveBundleTests {
    /// A bundle laid out as Chrome's: the framework's `Helpers` a link to its current version's.
    func scratchBundle(_ name: String, framework: String, helper: String?, linked: Bool) throws -> URL {
        let fm = FileManager.default
        let app = fm.temporaryDirectory.appendingPathComponent("tc-ax-\(UUID().uuidString)/\(name).app")
        let fw = app.appendingPathComponent("Contents/Frameworks/\(framework)")
        let helpers = fw.appendingPathComponent(linked ? "Versions/A/Helpers" : "Helpers")
        try fm.createDirectory(at: helpers, withIntermediateDirectories: true)
        if let helper { try fm.createDirectory(at: helpers.appendingPathComponent(helper), withIntermediateDirectories: true) }
        if linked {
            try fm.createSymbolicLink(atPath: fw.appendingPathComponent("Versions/Current").path, withDestinationPath: "A")
            try fm.createSymbolicLink(atPath: fw.appendingPathComponent("Helpers").path, withDestinationPath: "Versions/Current/Helpers")
        }
        return app
    }

    @Test func aChromeShapedBundleIsChromeAndAPlainOneNative() throws {
        let chrome = try scratchBundle("Scratch", framework: "Scratch Framework.framework", helper: "Scratch Helper (Renderer).app", linked: true)
        defer { try? FileManager.default.removeItem(at: chrome.deletingLastPathComponent()) }
        let frameworks = LiveBundles.frameworks(chrome)
        #expect(frameworks == [ChromiumBundle.Framework(name: "Scratch Framework.framework", helpers: ["Scratch Helper (Renderer).app"])])
        #expect(ChromiumBundle.kind(frameworks: frameworks) == .chrome)
        let plain = try scratchBundle("Plain", framework: "Sparkle.framework", helper: nil, linked: false)
        defer { try? FileManager.default.removeItem(at: plain.deletingLastPathComponent()) }
        #expect(ChromiumBundle.kind(frameworks: LiveBundles.frameworks(plain)) == .native)
    }

    @Test func thisTestRunnerIsNotChromium() {
        #expect(LiveBundles.kind(getpid()) == .native)
    }
}

@Suite(.enabled(if: ScratchChrome.ready, "needs a scratch Chrome: TC_AX_TEST_CHROME_PID, _WINDOW and _TAB"))
struct AXTabTests {
    let pid = ScratchChrome.pid ?? 0

    @Test func chromeIsChromiumByItsBundleThoughItRefusesTheSet() {
        #expect(LiveBundles.kind(pid) == .chrome)
        #expect(ManualAccessibility.live().prepare(pid) != .native)
    }

    @Test func theListGivesTheBrowserWindowsTabs() throws {
        let window = try #require(AppWindows.list(pid: pid).first { $0.title == ScratchChrome.window })
        let tabs = try #require(window.tabs)
        #expect(tabs.contains { $0.title == ScratchChrome.tab && !$0.selected })
        #expect(tabs.filter(\.selected).count == 1)
        #expect(window.moreTabs == nil)
    }

    @Test func aRefNamingABackgroundTabResolvesItsWindowAndSelectsNothing() throws {
        let target = try AppWindows.resolveTarget(pid: pid, ref: WindowRef(title: ScratchChrome.tab))
        #expect(target.info.title == ScratchChrome.window)
        let tab = try #require(target.tab)
        #expect(tab.title == ScratchChrome.tab && !tab.selected)
        // no side effect: the tab still reads unselected
        #expect(!LiveTabs.info(tab.element).selected)
    }

    @Test func selectingTheTabWaitsForItsPageThenReadsIt() throws {
        let target = try AppWindows.resolveTarget(pid: pid, ref: WindowRef(title: ScratchChrome.tab))
        let tab = try #require(target.tab)
        let front = NSRunningApplication(processIdentifier: pid)?.isActive == true
        if front {
            // the person's own window: a read-shaped call is refused
            #expect(throws: ComputerFailure.self) { try TabSelect.select(pid: pid, window: target.element, tab: tab.element, tabs: .background) }
        }
        let outcome = try TabSelect.select(pid: pid, window: target.element, tab: tab.element, tabs: .any)
        #expect(outcome.switched && outcome.title == ScratchChrome.tab)
        #expect(outcome.page?.state == .loaded || outcome.page?.state == .loading)
        #expect(LiveTabs.info(tab.element).selected)
        // a second selection of the same tab presses nothing
        #expect(!(try TabSelect.select(pid: pid, window: target.element, tab: tab.element, tabs: .any).switched))
        let reader = try AXReaders().reader(session: "ax-tab-tests", pid: pid)
        defer { reader.close() }
        _ = try reader.observe(ObserveRequest(window: WindowRef(id: target.info.id), mode: .full, element: nil, budgetBytes: 24_000, geometry: false,
                                              menus: false, space: CoordinateSpace(width: 1280, height: 800, scale: 1)))
        #expect(reader.lastPage?.tab == ScratchChrome.tab)
        #expect(reader.lastPage?.state == .loaded)
    }
}
#endif
