@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// The window actions' text rules (docs/computer-protocol.md §22): the title-bar buttons last in
/// a fixed order, the capture's sharing badge never a line, `minimized` on the window line.
@Suite struct TitleBarTests {
    let t = Tree()

    func button(_ subrole: String, x: Double, id: NodeID? = nil) -> AXNode {
        t.node("AXButton", subrole, id: id, frame: Rect(x: x, y: 9, w: 8, h: 8), actions: ["AXPress"])
    }

    func go(id: NodeID? = nil) -> AXNode { t.node("AXButton", id: id, title: "Go", frame: r(100), actions: ["AXPress"]) }

    let buttons = ["  [3] button \"close\"", "  [4] button \"minimize\"", "  [5] button \"full screen\"", "  [6] button \"zoom\""]

    @Test func theButtonsCloseTheWindowsChildrenInOneOrderWhereverAXListedThem() {
        let close = { self.button("AXCloseButton", x: 9) }, minimize = { self.button("AXMinimizeButton", x: 29) }
        let full = { self.button("AXFullScreenButton", x: 49) }, zoom = { self.button("AXZoomButton", x: 69) }
        let first = snapshot([t.window([zoom(), close(), full(), minimize(), go()])])
        let middle = snapshot([t.window([full(), go(), minimize(), zoom(), close()])])
        #expect(body(first) == ["[1] window \"Untitled\"", "  [2] button \"Go\""] + buttons)
        #expect(body(middle) == body(first))
        // a window that lists none (the walk found no attribute either) prints none
        #expect(body(snapshot([t.window([go()])])) == ["[1] window \"Untitled\"", "  [2] button \"Go\""])
    }

    @Test func theSharingBadgeOverAButtonIsDropped() {
        let badge = t.node("AXMenuButton", description: "Window sharing", frame: Rect(x: 4, y: 4, w: 68, h: 22), actions: ["AXPress", "AXShowMenu"])
        let s = snapshot([t.window([go(), badge, button("AXCloseButton", x: 9), button("AXMinimizeButton", x: 29)])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] button \"Go\"", "  [3] button \"close\"", "  [4] button \"minimize\""])
        #expect(Reader().read(s).stats.elements == 4)
    }

    @Test func aBadgeInTheCornerOfAWindowWithNoButtonsIsDroppedAndAnAppsOwnMenuButtonStays() {
        let badge = t.node("AXMenuButton", description: "Window sharing", frame: Rect(x: 4, y: 4, w: 68, h: 22), actions: ["AXPress"])
        let own = t.node("AXMenuButton", description: "document actions", frame: Rect(x: 300, y: 3, w: 10, h: 16), actions: ["AXPress", "AXShowMenu"])
        // a subrole says it is no badge, wherever it sits
        let named = t.node("AXMenuButton", "AXSomething", description: "share", frame: Rect(x: 8, y: 8, w: 20, h: 16), actions: ["AXPress"])
        let s = snapshot([t.window([badge, own, named])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] menu button \"document actions\"", "  [3] menu button \"share\""])
        // the app's own menu button beside the buttons stays too
        let beside = snapshot([t.window([button("AXCloseButton", x: 9), own])])
        #expect(body(beside) == ["[1] window \"Untitled\"", "  [2] menu button \"document actions\"", "  [3] button \"close\""])
    }

    @Test func aSheetsChildrenAreNotReordered() {
        let sheet = t.node("AXSheet", frame: r(0), [button("AXCloseButton", x: 9), go()])
        #expect(TitleBar.order(sheet).map(\.role) == ["AXButton", "AXButton"])
        #expect(TitleBar.order(sheet).first?.subrole == "AXCloseButton")
    }

    @Test func theBadgeComingAndGoingChangesNothingAndKeepsEveryIndex() {
        let tree = Tree(start: 5_000)
        let ids = (go: tree.id(), close: tree.id(), minimize: tree.id(), window: tree.id())
        func shot(shared: Bool) -> AXSnapshot {
            var kids = [go(id: ids.go)]
            if shared { kids.append(t.node("AXMenuButton", description: "Window sharing", frame: Rect(x: 4, y: 4, w: 68, h: 22))) }
            // AX lists the buttons first; under a capture the walk appends them after the badge
            let chrome = [button("AXCloseButton", x: 9, id: ids.close), button("AXMinimizeButton", x: 29, id: ids.minimize)]
            return snapshot([t.window(id: ids.window, shared ? kids + chrome : chrome + kids)])
        }
        let reader = Reader()
        let plain = reader.read(shot(shared: false))
        #expect(reader.read(shot(shared: true)).kind == .unchanged)
        #expect(reader.read(shot(shared: false)).kind == .unchanged)
        #expect(plain.briefs[3] == "button \"close\"" && plain.briefs[4] == "button \"minimize\"")
    }

    @Test func aMinimizedWindowSaysSoAndTheDiffShowsIt() {
        var minimized = sample()
        minimized.roots[0].flags.minimized = true
        #expect(body(minimized).first == "[1] window \"Untitled\" minimized")
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(minimized)
        #expect(built.kind == .diff)
        #expect(built.text == sampleHeader + " · changes since your last read\n~ [1] window \"Untitled\" minimized")
    }

    @Test func aRecordedMinimizedWindowReadsMinimized() throws {
        let json = """
        {"recordedAt":"2026-11-10T00:00:00Z","recorder":"test","app":{"name":"Probe","version":"1"},"os":"27.2",
         "window":{"title":"Plain","frame":{"x":0,"y":0,"w":400,"h":300}},"scale":2,"manualAccessibility":"refused",
         "walk":{"nodes":2,"depth":1,"ms":1,"capped":false},
         "root":{"role":"AXWindow","subrole":"AXStandardWindow","title":"Plain","minimized":true,"frame":{"x":0,"y":0,"w":400,"h":300},
                 "children":[{"role":"AXButton","subrole":"AXCloseButton","frame":{"x":8,"y":8,"w":14,"h":16},"actions":["AXPress"],"children":[]}]}}
        """
        let s = RawTree.snapshot(try RawTree.decode(Data(json.utf8)), ids: NodeIDSource())
        #expect(s.roots[0].flags.minimized == true)
        #expect(s.window.minimized)
        #expect(body(s) == ["[1] window \"Plain\" minimized", "  [2] button \"close\""])
    }

    @Test func theSignatureReadsTheWindowWithoutItsChrome() {
        struct Kid { var id: UInt64; var child: TitleBar.Child }
        let content = Kid(id: 1, child: TitleBar.Child(role: "AXGroup", subrole: nil, frame: r(100)))
        let close = Kid(id: 2, child: TitleBar.Child(role: "AXButton", subrole: "AXCloseButton", frame: Rect(x: 9, y: 9, w: 8, h: 8)))
        let badge = Kid(id: 3, child: TitleBar.Child(role: "AXMenuButton", subrole: nil, frame: Rect(x: 4, y: 4, w: 68, h: 22)))
        func sig(_ kids: [Kid], minimized: Bool = false) -> UInt64 {
            let shown = TitleBar.order(kids, window: windowFrame) { $0.child }.filter { !TitleBar.isButton(subrole: $0.child.subrole) }
            return Signature(focused: nil, value: nil, valueLength: nil, selection: nil, title: "Untitled", minimized: minimized,
                             windowChildren: shown.map(\.id), counts: [shown.count]).hash
        }
        #expect(sig([close, content]) == sig([content, badge]))
        #expect(sig([content]) == sig([content, badge, close]))
        #expect(sig([content]) != sig([content], minimized: true))
    }
}
