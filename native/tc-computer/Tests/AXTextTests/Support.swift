@testable import AXText
import ComputerProtocol
import Foundation

// Hand-built snapshots for the rules' tests: one node builder, one window, one read.

final class Tree {
    private var next: NodeID

    /// `start` sets the id space: two trees with different starts share no element, as after a rebuild.
    init(start: NodeID = 0) {
        next = start
    }

    func id() -> NodeID {
        next += 1
        return next
    }

    func node(_ role: String, _ subrole: String? = nil, id: NodeID? = nil, title: String? = nil, description: String? = nil, label: String? = nil,
              placeholder: String? = nil, value: AXScalar? = nil, valueLength: Int? = nil, dom: String? = nil, flags: AXFlags = AXFlags(),
              frame: Rect? = nil, actions: [String] = [], settable: Set<String>? = nil, range: [Int]? = nil, hidden: Hidden? = nil,
              _ children: [AXNode] = []) -> AXNode {
        AXNode(id: id ?? self.id(), role: role, subrole: subrole, title: title, description: description, titleElementValue: label, placeholder: placeholder,
               value: value, valueLength: valueLength, domIdentifier: dom, flags: flags, frame: frame, actions: actions, settable: settable,
               selectedTextRange: range, children: children, hidden: hidden)
    }

    func window(title: String = "Untitled", id: NodeID? = nil, frame: Rect = windowFrame, _ children: [AXNode]) -> AXNode {
        node("AXWindow", "AXStandardWindow", id: id, title: title, frame: frame, actions: ["AXRaise"], children)
    }
}

let windowFrame = Rect(x: 0, y: 0, w: 640, h: 536)
let space = CoordinateSpace(width: 1280, height: 1072, scale: 2)

func snapshot(_ roots: [AXNode], app: String = "TextEdit", windowID: Int = 7, frame: Rect = windowFrame, focused: NodeID? = nil,
              others: [OtherWindow] = [], ambient: Set<String> = [], menuBar: AXNode? = nil) -> AXSnapshot {
    let title = roots.first?.title ?? "Untitled"
    let info = WindowInfo(id: windowID, title: title, frame: frame, main: true, focused: true, minimized: false, onScreen: true, space: .current)
    return AXSnapshot(app: AppFacts(pid: 42, bundleId: "com.apple.TextEdit", name: app), window: info, otherWindows: others, roots: roots,
                      menuBar: menuBar, focusedID: focused, ambientActions: ambient)
}

/// One reader's state across reads: its book and its base. `noteThin` is off unless a test asks: a small
/// hand-built tree is often thin, and under `noteThin` a thin tree's lines carry geometry (shell A12).
final class Reader {
    let book: IndexBook
    var base: Base?

    init(allocator: IndexAllocator = IndexAllocator(), capacity: Int = 20_000) {
        book = IndexBook(allocator: allocator, capacity: capacity)
    }

    @discardableResult
    func read(_ s: AXSnapshot, mode: ObservationMode = .auto, budget: Int = 24_000, geometry: Bool = false, subtree: Int? = nil,
              loading: Bool = false, noteThin: Bool = false, space: CoordinateSpace = space, page: PageState? = nil, opened: [StepMenu] = []) -> Built {
        var request = BuildRequest(mode: mode, subtreeOf: subtree, budgetBytes: budget, geometry: geometry, space: space, loading: loading, noteThin: noteThin, page: page)
        request.openedMenus = opened
        let (built, next) = Builder.build(s, request, book: book, base: base)
        if let next { base = next }
        return built
    }
}

/// The text of one fresh full read.
func text(_ s: AXSnapshot, budget: Int = 24_000, geometry: Bool = false) -> String {
    Reader().read(s, budget: budget, geometry: geometry).text
}

/// The TextEdit window the Mac probe walked (docs/computer-protocol.md §4.1).
func textEditSample(_ t: Tree, focusedArea: NodeID = 1000, value: String = "Hello from the probe\nSecond line") -> (AXSnapshot, AXNode) {
    let markers = (0..<15).map { _ in t.node("AXRulerMarker", frame: Rect(x: 10, y: 60, w: 6, h: 8)) }
    let check = { (name: String) in t.node("AXCheckBox", description: name, value: .number("0"), frame: Rect(x: 200, y: 26, w: 13, h: 11), actions: ["AXPress"]) }
    let colour = { (name: String) in t.node("AXButton", description: name, value: .string("Clear"), frame: Rect(x: 300, y: 26, w: 20, h: 11), actions: ["AXPress", "Name:Show color panel\nTarget:0x0\nSelector:(null)"]) }
    let popup = { (name: String, v: String) in t.node("AXPopUpButton", description: name, value: .string(v), frame: Rect(x: 330, y: 26, w: 60, h: 11), actions: ["AXPress", "AXShowMenu"]) }
    let area = t.node("AXTextArea", id: focusedArea, value: .string(value), frame: Rect(x: 0, y: 45, w: 632, h: 491), actions: ["AXShowMenu"],
                      settable: ["AXValue", "AXSelectedTextRange"], range: [0, 0])
    let window = t.window([
        t.node("AXScrollArea", frame: Rect(x: 0, y: 45, w: 640, h: 491), [
            area,
            t.node("AXRuler", frame: Rect(x: 0, y: 45, w: 640, h: 20), markers),
            t.node("AXScrollBar", frame: Rect(x: 632, y: 45, w: 8, h: 491), [t.node("AXValueIndicator", frame: Rect(x: 632, y: 45, w: 8, h: 30))])
        ]),
        t.node("AXGroup", title: "Formatting", frame: Rect(x: 0, y: 22, w: 640, h: 22), [
            check("bold"), check("italic"), check("underline"), check("strikethrough"),
            colour("text color"), colour("text background color"),
            popup("typeface", "Helvetica"), popup("style", "Regular"),
            t.node("AXComboBox", description: "font size", value: .string("12"), frame: Rect(x: 400, y: 26, w: 40, h: 11), actions: ["AXConfirm", "AXShowMenu"], settable: ["AXValue"], [
                t.node("AXButton", description: "font size", frame: Rect(x: 430, y: 26, w: 10, h: 11), actions: ["AXPress"])
            ]),
            check("align left"), check("align center"), check("align right"), check("fully justify"),
            t.node("AXMenuButton", description: "list style", frame: Rect(x: 500, y: 26, w: 20, h: 11), actions: ["AXPress", "AXShowMenu"]),
            popup("line spacing", "1.0")
        ]),
        t.node("AXGroup", frame: Rect(x: 0, y: 0, w: 640, h: 22), [t.node("AXStaticText", value: .string("Untitled"), frame: Rect(x: 300, y: 3, w: 50, h: 16))]),
        t.node("AXButton", "AXCloseButton", frame: Rect(x: 9, y: 9, w: 8, h: 8), actions: ["AXPress"]),
        t.node("AXButton", "AXFullScreenButton", frame: Rect(x: 49, y: 9, w: 8, h: 8), actions: ["AXPress", "AXZoomWindow"]),
        t.node("AXButton", "AXMinimizeButton", frame: Rect(x: 29, y: 9, w: 8, h: 8), actions: ["AXPress"]),
        t.node("AXMenuButton", description: "document actions", frame: Rect(x: 340, y: 3, w: 10, h: 16), actions: ["AXPress", "AXShowMenu"])
    ])
    return (snapshot([window], focused: focusedArea, others: [OtherWindow(title: "Notes.rtf", minimized: true)]), area)
}
