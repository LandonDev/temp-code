#if canImport(ApplicationServices)
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

struct WalkCaps: Sendable {
    var maxNodes = ComputerDefaults.AXWalk.maxNodes
    var maxMs = ComputerDefaults.AXWalk.maxMs
    var maxDepth = 64

    static let `default` = WalkCaps()
}

/// What a walk saw that the change monitor watches next (plan §5.5).
struct WalkNotes {
    /// the scroll areas walked, in reading order, at most `Signature.maxScrollAreas`
    var scrollAreas: [AXUIElement] = []
    /// busy indicators, progress bars and web areas, with the containers above each (at most 8)
    var busy: [(element: AXUIElement, kind: BusyRule.Kind, containers: [AXUIElement])] = []
    /// the target window's document (§26.8): its `AXDocument` and its close button's `AXEdited`
    var document = WindowDocument()
    /// every open menu the walk read (§26.11), with what opened it when the walk came through it
    var menus: [OpenMenu] = []
}

/// What the target window says of its file (docs/computer-protocol.md §26.8, E5): the `AXDocument` URL as
/// AX gave it (a `file://` URL; a Finder window's names its folder) and the close button's `AXEdited`.
/// Either is nil when the app does not say: a window with no file, or no close button.
public struct WindowDocument: Hashable, Sendable {
    public var url: String?
    public var edited: Bool?

    public init(url: String? = nil, edited: Bool? = nil) {
        self.url = url
        self.edited = edited
    }
}

/// What one walk counted, for `tc-ax bench`.
struct WalkCounts {
    var nodes = 0
    var calls = 0
    var attributes = 0
    var stageC = 0
}

/// One read of one window's tree (plan §5.2): every node reached is placed
/// with one batch, a node inside its clip is read with one batch by class,
/// then its actions and what its line needs; a container's rows outside the
/// visible rect are counted, never read.
final class Walker {
    let handles: HandleTable
    let caps: WalkCaps
    /// a text value longer than this many UTF-16 units is read as a prefix
    var valueUnits = 2_000
    /// false for a subtree read: every child, whole
    var cut = true
    /// false for a resolve: the element alone
    var descend = true
    private(set) var partial = false
    private(set) var notes = WalkNotes()
    private(set) var counts = WalkCounts()
    private var deadline: UInt64 = 0
    private var seen = Set<NodeID>()
    private var stopped = false
    /// the target window's close button, from its stage B, so the button's own batch reads the flag
    private var closeButton: AXUIElement?

    init(handles: HandleTable, caps: WalkCaps = .default) {
        self.handles = handles
        self.caps = caps
    }

    private static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

    /// Start a walk's clock; one deadline covers every root of one read.
    func begin() {
        deadline = Self.now() + UInt64(caps.maxMs) * 1_000_000
        partial = false
        stopped = false
        seen = []
        notes = WalkNotes()
        counts = WalkCounts()
        closeButton = nil
    }

    /// A root (the window, an open menu, a popover, the menu bar). The window's
    /// own failures end the read; another root that fails is left out.
    func walk(root el: AXUIElement, clip: ComputerProtocol.Rect?, menuBar: Bool, isWindow: Bool) throws -> AXNode? {
        let out = try node(el, clip: clip, scope: .window, depth: 0, menuBar: menuBar, containers: [], root: true, isWindow: isWindow)
        // a walk cut short before the close button: its flag in one read of its own
        if isWindow, notes.document.edited == nil, let closeButton {
            notes.document.edited = AX.bool(AX.copy(closeButton, Attributes.edited).value)
            counts.calls += 1
            counts.attributes += 1
        }
        switch out {
        case .node(let n): return n
        default: return nil
        }
    }

    typealias Outcome = ViewportCut.Outcome<AXNode>

    private func stop() {
        partial = true
        stopped = true
    }

    /// `scope`: where the node sits relative to web content, for the read-ahead (§25.5).
    private func node(_ el: AXUIElement, clip: ComputerProtocol.Rect?, scope: Viewport.Scope, depth: Int, menuBar: Bool, containers: [AXUIElement], root: Bool, isWindow: Bool, sliver: Bool = false) throws -> Outcome {
        if stopped { return .skip }
        if counts.nodes >= caps.maxNodes || Self.now() > deadline {
            if root && isWindow && counts.nodes == 0 { throw AXErrorMap.timeout("The window") }
            stop()
            return .skip
        }
        counts.nodes += 1
        // stage A
        let a = AX.batch(el, Attributes.stageA)
        counts.calls += 1
        counts.attributes += Attributes.stageA.count
        let roleSlot = a["AXRole"] ?? .absent
        if let failure = AXErrorMap.failure(roleSlot, what: "The window") {
            if isWindow { throw failure }
            if case .disabled = roleSlot { throw failure }
            if case .timeout = roleSlot { stop() }
            return .skip
        }
        guard let role = AX.string(roleSlot.value) else { return .skip }
        let frame = AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value)
        // a popover or a menu may hang outside its window: it is judged by its own frame
        let floats = role == "AXPopover" || role == "AXMenu"
        if !root, cut, !menuBar, let side = Viewport.cut(role: role, frame: frame, clip: clip, sliver: sliver) { return .hidden(side) }
        let id = handles.intern(el)
        if seen.contains(id) || depth > caps.maxDepth { return .skip }
        seen.insert(id)

        // stage B
        let subrole = AX.string(a["AXSubrole"]?.value)
        let attrs = Attributes.stageB(role, subrole: subrole)
        let b = AX.batch(el, attrs)
        counts.calls += 1
        counts.attributes += attrs.count
        if case .timeout? = b["AXTitle"] {
            if isWindow { throw AXErrorMap.timeout("The window") }
            stop()
        }
        let s = { (k: String) in b[k]?.value }
        if root, isWindow, role == "AXWindow" {
            notes.document.url = AX.string(s("AXDocument"))
            closeButton = AX.element(s("AXCloseButton"))
        } else if subrole == "AXCloseButton", let closeButton, CFEqual(el, closeButton) {
            notes.document.edited = AX.bool(s(Attributes.edited))
        }
        var n = AXNode(
            id: id, role: role, subrole: subrole, title: AX.string(s("AXTitle")), description: AX.string(s("AXDescription")),
            placeholder: AX.string(s("AXPlaceholderValue")), value: AX.scalar(s("AXValue")),
            identifier: AX.string(s("AXIdentifier")), domIdentifier: AX.string(s("AXDOMIdentifier")),
            flags: AXFlags(enabled: AX.bool(s("AXEnabled")), focused: AX.bool(s("AXFocused")), selected: AX.bool(s("AXSelected")),
                           expanded: AX.bool(s("AXExpanded")), required: AX.bool(s("AXRequired")), invalid: AX.bool(s("AXInvalid")),
                           modal: AX.bool(s("AXModal")), minimized: AX.bool(s("AXMinimized")), busy: AX.bool(s("AXElementBusy")), loaded: AX.bool(s("AXLoaded"))),
            frame: frame, selectedTextRange: AX.range(s("AXSelectedTextRange")),
            url: role == "AXWebArea" ? AX.string(s("AXURL")) : nil
        )

        // stage C: actions, a text value whole or as a prefix, its settable check, the label's text
        n.actions = AX.actions(el)
        counts.calls += 1
        counts.stageC += 1
        if Attributes.textEntry.contains(role) {
            let length = AX.int(s("AXNumberOfCharacters"))
            if let length, length > valueUnits, let prefix = AX.prefix(el, units: valueUnits) {
                n.value = .string(prefix)
                n.valueLength = length
            } else {
                n.value = AX.scalar(AX.copy(el, "AXValue").value)
            }
            n.settable = AX.settable(el, "AXValue") ? ["AXValue"] : []
            counts.calls += 2
            counts.stageC += 2
        }
        let ownName = [n.title, n.description].contains { !($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !ownName, let label = AX.element(s("AXTitleUIElement")) {
            let t = AX.batch(label, ["AXValue", "AXTitle"])
            n.titleElementValue = AX.string(t["AXValue"]?.value) ?? AX.string(t["AXTitle"]?.value)
            counts.calls += 1
            counts.stageC += 1
        }

        // notes for the change monitor
        let isContainer = Viewport.clipRoles.contains(role)
        if role == "AXScrollArea", notes.scrollAreas.count < Signature.maxScrollAreas { notes.scrollAreas.append(el) }
        let busyKind: BusyRule.Kind? = role == "AXBusyIndicator" ? .busy : role == "AXProgressIndicator" ? .progress : role == "AXWebArea" ? .webArea : nil
        if let busyKind { notes.busy.append((el, busyKind, Array(containers.suffix(8)))) }

        // children: the visible ones only, the rest counted by position; a window's title-bar buttons
        // a capture took out of AXChildren come back from its attributes, after the rest (§22.1)
        var children = descend ? AX.elements(a["AXChildren"]?.value) : []
        if descend, root, role == "AXWindow" {
            children += TitleBar.missing(children, answered: TitleBar.attributes.map { AX.element(s($0)) }, same: { CFEqual($0, $1) })
        }
        let inner = cut ? Viewport.childClip(role: role, frame: frame, clip: floats ? frame : clip, scope: scope) : nil
        let below = isContainer ? containers + [el] : containers
        let inside = scope.inside(role)
        // a list's visible children or rows, as the cut reads them (`ViewportCut.marks`): never in the page's own
        // flow, where they describe the physical viewport, not the read-ahead
        var lists: ViewportCut.Lists<ElementKey>?
        if cut, Viewport.listRoles.contains(role), scope.trustsVisibleLists {
            let shownChildren = AX.elements(s("AXVisibleChildren"))
            let shownRows = AX.elements(s("AXVisibleRows")) + AX.elements(s("AXVisibleColumns"))
            if !shownChildren.isEmpty {
                lists = ViewportCut.Lists(visibleChildren: shownChildren.map(ElementKey.init))
            } else if !shownRows.isEmpty {
                // rows and columns: their order comes from AXRows and AXColumns; other children are judged by frame
                let lines = AX.elements(AX.copy(el, "AXRows").value) + AX.elements(AX.copy(el, "AXColumns").value)
                counts.calls += 2
                lists = ViewportCut.Lists(visibleRows: shownRows.map(ElementKey.init), rows: lines.map(ElementKey.init))
            }
        }
        let marks = ViewportCut.marks(children.map(ElementKey.init), lists: lists, scope: scope)
        let opener = n
        let (kept, hidden) = try ViewportCut.children(children, marks: marks, stop: { stopped }) { _, child in
            let out = try node(child, clip: inner, scope: inside, depth: depth + 1, menuBar: menuBar, containers: below, root: false, isWindow: false, sliver: isContainer)
            // an open menu, with what opened it (§26.11)
            if case .node(let c) = out, c.role == "AXMenu" { notes.menus.append(OpenMenu.of(c, element: child, opener: el, openerNode: opener)) }
            return out
        }
        n.children = kept
        if !hidden.isEmpty { n.hidden = hidden }
        return .node(n)
    }
}
#endif

#if canImport(ApplicationServices)
extension OpenMenu {
    /// A menu the walk reached through its opener's children: a pop-up's, a menu button's, an open
    /// menu bar item's.
    static func of(_ node: AXNode, element: AXUIElement, opener: AXUIElement, openerNode: AXNode) -> OpenMenu {
        let kind: Opener = openerNode.role == "AXMenuBarItem" ? .menuBar : .popUp
        let title = [openerNode.title, openerNode.description, openerNode.value.flatMap { if case .string(let s) = $0 { s } else { nil } }]
            .compactMap { $0 }.first { !$0.isEmpty } ?? "menu"
        return OpenMenu(menu: element, opener: opener, kind: kind, title: title, items: items(node), itemIDs: named(node).map(\.0))
    }

    /// A menu read as a root of its own: a context menu, or a selected menu bar item's menu.
    static func ofRoot(_ node: AXNode, element: AXUIElement) -> OpenMenu {
        if let parent = AX.element(AX.copy(element, "AXParent").value), AX.string(AX.copy(parent, "AXRole").value) == "AXMenuBarItem" {
            return OpenMenu(menu: element, opener: parent, kind: .menuBar, title: AX.string(AX.copy(parent, "AXTitle").value) ?? "menu", items: items(node), itemIDs: named(node).map(\.0))
        }
        return OpenMenu(menu: element, opener: nil, kind: .context, title: "context menu", items: items(node), itemIDs: named(node).map(\.0))
    }

    private static func items(_ node: AXNode) -> [String] {
        named(node).map(\.1)
    }

    /// The titled items with their nodes.
    static func named(_ node: AXNode) -> [(NodeID, String)] {
        node.children.filter { $0.role == "AXMenuItem" }.compactMap { c in c.title.flatMap { $0.isEmpty ? nil : (c.id, $0) } }
    }
}
#endif
