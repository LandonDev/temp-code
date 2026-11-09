@testable import AXText
import ComputerProtocol
import Testing

/// The lines after the header (and the other-windows line).
func body(_ s: AXSnapshot, budget: Int = 24_000) -> [String] {
    Array(text(s, budget: budget).split(separator: "\n").map(String.init).drop { !$0.hasPrefix("[") && !$0.hasPrefix(" ") })
}

func r(_ y: Double) -> Rect { Rect(x: 10, y: y, w: 100, h: 20) }

@Suite struct KeepTests {
    let t = Tree()

    @Test func theSpecSampleReadsAsTheSpecWritesIt() {
        let (s, _) = textEditSample(t)
        let lines = text(s).split(separator: "\n").map(String.init)
        #expect(lines[0] == "app \"TextEdit\" · window \"Untitled\" · 1280×1072 · focused [3]")
        #expect(lines[1] == "other windows: \"Notes.rtf\" minimized")
        #expect(lines[2] == "[1] window \"Untitled\"")
        #expect(lines.contains("    [3] text area = \"Hello from the probe\\nSecond line\" focused caret 0 actions: show menu"))
        #expect(lines.contains("    [9] button \"text color\" = \"Clear\" actions: show color panel"))
        #expect(lines.contains("    [13] combo box \"font size\" = \"12\" actions: confirm"))
        #expect(lines.contains("  [22] button \"full screen\" actions: zoom window"))
        // the scroll bar, the unnamed title-bar group and its text repeating the window's name are gone
        #expect(!lines.contains { $0.contains("scroll bar") || $0.contains("text \"Untitled\"") || $0.contains("= \"Untitled\"") })
    }

    @Test func unnamedGroupsFlattenAndAGroupWithAnActionStays() {
        let s = snapshot([t.window([
            t.node("AXGroup", frame: r(0), [t.node("AXButton", title: "A", frame: r(0), actions: ["AXPress"])]),
            t.node("AXGroup", frame: r(30), actions: ["AXPress", "AXShowMenu"], [t.node("AXStaticText", value: .string("Clickable div"), frame: r(30))])
        ])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] button \"A\"", "  [3] group actions: press, show menu", "    [4] text = \"Clickable div\""])
    }

    @Test func aNamedElementOfAnUnknownRoleStays() {
        let s = snapshot([t.window([t.node("AXRulerMarker", title: "Tab stop", frame: r(0)), t.node("AXRulerMarker", frame: r(30))])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] ruler marker \"Tab stop\""])
    }

    @Test func scrollBarsDropUnlessFocused() {
        let bar = t.node("AXScrollBar", frame: r(0), [t.node("AXValueIndicator", value: .number("0.5"), frame: r(0))])
        let focused = t.node("AXScrollBar", description: "rows", frame: r(30))
        let s = snapshot([t.window([bar, focused])], focused: focused.id)
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] scroll bar \"rows\" focused"])
    }

    @Test func aZeroSizeWrapperDropsWhileItsChildrenRise() {
        let s = snapshot([t.window([t.node("AXGroup", title: "Contents", frame: Rect(x: 0, y: 0, w: 0, h: 0), [t.node("AXButton", title: "Go", frame: r(0), actions: ["AXPress"])])])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] button \"Go\""])
    }

    @Test func textRepeatingItsParentOrAnInputsLabelDrops() {
        let s = snapshot([t.window([
            t.node("AXLink", title: "Order history", frame: r(0), actions: ["AXPress"], [t.node("AXStaticText", value: .string("Order history"), frame: r(0))]),
            t.node("AXGroup", title: "Form", frame: r(30), [
                t.node("AXStaticText", value: .string("Email"), frame: r(30)),
                t.node("AXTextField", label: "Email", frame: r(60), settable: ["AXValue"]),
                t.node("AXStaticText", value: .string("Note"), frame: r(90))
            ])
        ])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] link \"Order history\"", "  [3] group \"Form\"", "    [4] input \"Email\"", "    [5] text = \"Note\""])
    }

    @Test func aPlaceholderNamesOnlyAnEmptyInput() {
        let s = snapshot([t.window([
            t.node("AXTextField", placeholder: "Search", value: .string(""), frame: r(0), settable: ["AXValue"]),
            t.node("AXTextField", placeholder: "Search", value: .string("cats"), frame: r(30), settable: ["AXValue"])
        ])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] input \"Search\"", "  [3] input = \"cats\""])
    }

    @Test func windowButtonsAreNamedByTheirSubrole() {
        let s = snapshot([t.window(["AXCloseButton", "AXMinimizeButton", "AXFullScreenButton", "AXZoomButton"].map { t.node("AXButton", $0, frame: r(0), actions: ["AXPress"]) })])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] button \"close\"", "  [3] button \"minimize\"", "  [4] button \"full screen\"", "  [5] button \"zoom\""])
    }

    @Test func aPasswordNeverShowsItsValue() {
        let s = snapshot([t.window([t.node("AXTextField", "AXSecureTextField", title: "Password", value: .string("hunter2"), frame: r(0), settable: ["AXValue"])])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] password \"Password\""])
    }

    @Test func togglesPrintTheirValueAsAState() {
        let s = snapshot([t.window([
            t.node("AXCheckBox", title: "a", value: .number("0"), frame: r(0)), t.node("AXCheckBox", title: "b", value: .number("1"), frame: r(0)),
            t.node("AXCheckBox", title: "c", value: .number("2"), frame: r(0)), t.node("AXRadioButton", title: "d", value: .bool(true), frame: r(0)),
            t.node("AXCheckBox", "AXSwitch", title: "e", frame: r(0))
        ])])
        #expect(body(s).dropFirst() == ["  [2] checkbox \"a\" unchecked", "  [3] checkbox \"b\" checked", "  [4] checkbox \"c\" mixed", "  [5] radio \"d\" checked", "  [6] switch \"e\" unchecked"])
    }

    @Test func statesPrintInOrderAndReadOnlyNeedsAnUnsettableValue() {
        let row = t.node("AXRow", flags: AXFlags(enabled: false, selected: true, expanded: false), frame: r(0), actions: ["AXPress"])
        let s = snapshot([t.window([
            row,
            t.node("AXTextField", title: "Locked", value: .string("x"), flags: AXFlags(required: true, invalid: true), frame: r(30), settable: []),
            t.node("AXTextField", title: "Unknown", value: .string("y"), frame: r(60))
        ])])
        #expect(body(s).dropFirst() == ["  [2] row selected disabled collapsed", "  [3] input \"Locked\" = \"x\" required invalid read-only", "  [4] input \"Unknown\" = \"y\""])
    }

    @Test func theFocusedTextElementShowsItsCaretOrSelection() {
        let caret = t.node("AXTextField", title: "A", value: .string("hello"), frame: r(0), settable: ["AXValue"], range: [3, 0])
        let other = t.node("AXTextArea", title: "B", value: .string("hello"), frame: r(30), settable: ["AXValue"], range: [1, 2])
        #expect(body(snapshot([t.window([caret, other])], focused: caret.id)).dropFirst() == ["  [2] input \"A\" = \"hello\" focused caret 3", "  [3] text area \"B\" = \"hello\""])
        #expect(body(snapshot([t.window([caret, other])], focused: other.id)).dropFirst() == ["  [2] input \"A\" = \"hello\"", "  [3] text area \"B\" = \"hello\" focused selection 1..3"])
    }

    @Test func actionsListOnlyWhatTheRoleDoesNotTake() {
        let s = snapshot([t.window([
            t.node("AXButton", title: "Save", frame: r(0), actions: ["AXPress", "AXShowMenu", "AXShowAlternateUI", "AXShowDefaultUI"]),
            t.node("AXRuler", frame: r(30), actions: ["AXPress"]),
            t.node("AXPopUpButton", title: "Size", value: .string("M"), frame: r(60), actions: ["AXPress", "AXShowMenu"]),
            t.node("AXButton", title: "Colour", frame: r(90), actions: ["AXPress", "Name:Show color panel\nTarget:0x1\nSelector:(null)", "Name:\nTarget:0x2"]),
            t.node("AXCell", title: "a.txt", frame: r(120), actions: ["AXOpen", "AXOpen"])
        ])])
        #expect(body(s).dropFirst() == [
            "  [2] button \"Save\" actions: show menu", "  [3] ruler actions: press", "  [4] pop up \"Size\" = \"M\"",
            "  [5] button \"Colour\" actions: show color panel", "  [6] cell \"a.txt\" actions: open"
        ])
    }

    @Test func ambientActionsCountOnlyInsideAWebArea() {
        let ambient: Set<String> = ["AXShowMenu", "AXScrollToVisible"]
        let s = snapshot([t.window([
            t.node("AXToolbar", title: "Tabs", frame: r(0), [t.node("AXButton", title: "Reload", frame: r(0), actions: ["AXPress", "AXShowMenu"])]),
            t.node("AXWebArea", title: "Page", frame: Rect(x: 0, y: 40, w: 640, h: 496), actions: ["AXShowMenu", "AXScrollToVisible"], [
                t.node("AXGroup", frame: r(50), actions: ["AXShowMenu", "AXScrollToVisible"], [t.node("AXGroup", frame: r(50), actions: ["AXShowMenu", "AXScrollToVisible"])]),
                t.node("AXLink", title: "Next", frame: r(80), actions: ["AXPress", "AXShowMenu", "AXScrollToVisible"])
            ])
        ])], ambient: ambient)
        #expect(body(s) == [
            "[1] window \"Untitled\"", "  [2] toolbar \"Tabs\"", "    [3] button \"Reload\" actions: show menu",
            "  [4] web area \"Page\"", "    [5] link \"Next\""
        ])
    }

    @Test func menusAndPopoversAreRootsAfterTheWindowAndTheMenuBarComesLast() {
        let menu = t.node("AXMenu", frame: Rect(x: 700, y: 40, w: 200, h: 100), [t.node("AXMenuItem", title: "Copy", frame: Rect(x: 700, y: 44, w: 200, h: 20), actions: ["AXPress"])])
        let bar = t.node("AXMenuBar", frame: Rect(x: 0, y: 0, w: 1440, h: 24), [
            t.node("AXMenuBarItem", title: "File", frame: Rect(x: 0, y: 0, w: 0, h: 0), actions: ["AXPress"]),
            t.node("AXMenuBarItem", title: "Edit", actions: ["AXPress"])
        ])
        let s = snapshot([t.window([t.node("AXButton", title: "OK", frame: r(0), actions: ["AXPress"])]), menu], menuBar: bar)
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] button \"OK\"", "[3] menu", "  [4] menu item \"Copy\"", "[5] menu bar", "  [6] menu item \"File\"", "  [7] menu item \"Edit\""])
        #expect(!body(snapshot([t.window([])])).contains { $0.contains("menu bar") })
    }

    @Test func thinCountsRoleDefaultsAndTextOnly() {
        let thin = snapshot([t.window([t.node("AXGroup", title: "Canvas", frame: r(0), actions: ["AXShowMenu"]), t.node("AXButton", "AXCloseButton", frame: r(0), actions: ["AXPress"])])])
        #expect(Keep.tree(thin).thin)
        #expect(text(thin).hasPrefix("app \"TextEdit\" · window \"Untitled\" · 1280×1072 · thin tree, see the screenshot"))
        let rich = snapshot([t.window((0..<3).map { t.node("AXButton", title: "B\($0)", frame: r(0), actions: ["AXPress"]) })])
        #expect(!Keep.tree(rich).thin)
        let wordy = snapshot([t.window((0..<3).map { _ in t.node("AXStaticText", value: .string(String(repeating: "word ", count: 20)), frame: r(0)) })])
        #expect(!Keep.tree(wordy).thin)
        #expect(!Reader().read(thin, noteThin: false).text.contains("thin tree"))
    }

    @Test func aContainerOfTextlessRowsIsAStubAndThinWhenItCoversTheWindow() {
        let rows = (0..<30).map { _ in t.node("AXRow", frame: r(0), actions: ["AXPress"], [t.node("AXCell", frame: r(0))]) }
        let s = snapshot([t.window([
            t.node("AXScrollArea", title: "Project", frame: Rect(x: 0, y: 0, w: 640, h: 536), [t.node("AXOutline", title: "Project", frame: Rect(x: 0, y: 0, w: 640, h: 536), rows)])
        ])])
        #expect(body(s) == ["[1] window \"Untitled\"", "  [2] scroll area \"Project\"", "    (outline \"Project\": items not exposed to accessibility; see the screenshot)"])
        #expect(Keep.tree(s).thin)
    }
}

@Suite struct ViewportTests {
    func raw(_ role: String, title: String? = nil, frame: Rect? = nil, visible: Bool? = nil, actions: [String]? = nil, _ children: [RawAXNode] = []) -> RawAXNode {
        RawAXNode(role: role, title: title, visible: visible, frame: frame, actions: actions, children: children)
    }

    func tree(_ root: RawAXNode, attached: [RawAXNode]? = nil) -> RawAXTree {
        RawAXTree(recordedAt: "2026-11-08T00:00:00Z", recorder: "test", app: .init(name: "Finder", version: "1"), os: "15", window: .init(title: "Downloads", frame: windowFrame),
                  scale: 2, manualAccessibility: .refused, walk: .init(nodes: 0, depth: 0, ms: 0, capped: false), root: root, attached: attached)
    }

    @Test func visibleRowsKeepTheirPlaceAndTheRestAreCountedAboveAndBelow() {
        let rows = (0..<10).map { i in raw("AXRow", title: "r\(i)", frame: Rect(x: 0, y: Double(i) * 20, w: 100, h: 20), visible: (3...5).contains(i), actions: ["AXPress"]) }
        let column = raw("AXColumn", title: "Name", frame: Rect(x: 0, y: 0, w: 100, h: 200), visible: false)
        let s = RawTree.snapshot(tree(raw("AXWindow", title: "Downloads", frame: windowFrame, [raw("AXOutline", title: "Files", frame: Rect(x: 0, y: 0, w: 640, h: 536), rows + [column])])), ids: NodeIDSource())
        #expect(body(s) == ["[1] window \"Downloads\"", "  [2] outline \"Files\"", "    [3] row \"r3\"", "    [4] row \"r4\"", "    [5] row \"r5\"", "    [6] column \"Name\"", "    … 4 more below, 3 above"])
    }

    @Test func childrenOutsideTheirClipAreCountedNotRead() {
        let list = raw("AXList", title: "Past orders", frame: Rect(x: 0, y: 100, w: 640, h: 100),
                       (0..<8).map { i in raw("AXStaticText", title: "Order \(i)", frame: Rect(x: 0, y: 60 + Double(i) * 30, w: 100, h: 20)) })
        let s = RawTree.snapshot(tree(raw("AXWindow", title: "Downloads", frame: windowFrame, [list])), ids: NodeIDSource())
        #expect(body(s) == ["[1] window \"Downloads\"", "  [2] list \"Past orders\"", "    [3] text \"Order 1\"", "    [4] text \"Order 2\"", "    [5] text \"Order 3\"", "    [6] text \"Order 4\"", "    … 3 more below, 1 above"])
    }

    @Test func aZeroSizeScrollAreaHidesNothingAndAPopoverOutsideTheWindowKeepsItsOwnClip() {
        let wrapper = raw("AXScrollArea", frame: Rect(x: 0, y: 0, w: 0, h: 0), [raw("AXButton", title: "Inside", frame: Rect(x: 10, y: 10, w: 50, h: 20), actions: ["AXPress"])])
        let popover = raw("AXPopover", title: "Info", frame: Rect(x: 900, y: 50, w: 200, h: 100), [raw("AXButton", title: "Done", frame: Rect(x: 910, y: 60, w: 50, h: 20), actions: ["AXPress"])])
        let s = RawTree.snapshot(tree(raw("AXWindow", title: "Downloads", frame: windowFrame, [wrapper]), attached: [popover]), ids: NodeIDSource())
        #expect(body(s) == ["[1] window \"Downloads\"", "  [2] button \"Inside\"", "[3] popover \"Info\"", "  [4] button \"Done\""])
    }

    @Test func partitionCountsBeforeTheFirstVisibleAboveAndTheRestBelow() {
        #expect(Viewport.partition(childCount: 10, visible: [3, 4, 5]) == Hidden(above: 3, below: 4))
        #expect(Viewport.partition(childCount: 4, visible: []) == Hidden(above: 0, below: 4))
    }
}
