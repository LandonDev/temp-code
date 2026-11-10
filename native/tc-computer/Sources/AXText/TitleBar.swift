import ComputerProtocol
import Foundation

private typealias T = ObservationTables

/// A window's title-bar buttons and the system's sharing badge (docs/computer-protocol.md §22).
/// While a capture runs on a window, macOS draws a "Window sharing" badge over the traffic
/// lights, drops the buttons from AXChildren and lists an `AXMenuButton` in their place; the
/// walker adds the buttons back from the window's attributes. The text and the change monitor
/// read the window's children through this one rule, so a capture starting or stopping changes
/// nothing a model sees and nothing the smart wait counts.
public enum TitleBar {
    /// What the rule reads of one direct child of a window.
    public struct Child: Sendable, Equatable {
        public var role: String
        public var subrole: String?
        /// global points
        public var frame: Rect?

        public init(role: String, subrole: String?, frame: Rect?) {
            self.role = role
            self.subrole = subrole
            self.frame = frame
        }
    }

    /// Where a title-bar button goes among the window's last children; nil for any other subrole.
    public static func rank(subrole: String?) -> Int? {
        subrole.flatMap { T.titleBarSubroles.firstIndex(of: $0) }
    }

    public static func isButton(subrole: String?) -> Bool { rank(subrole: subrole) != nil }

    /// The corner a badge sits in on a window with no title-bar buttons, and the pixel watch looks away from.
    public static func corner(of window: Rect) -> Rect {
        Rect(x: window.x, y: window.y, w: T.titleBarCornerWidth, h: T.titleBarCornerHeight)
    }

    /// §22.2: an `AXMenuButton` with no subrole over the centre of one of the window's
    /// title-bar buttons, or, on a window with none, inside the title-bar corner.
    public static func isSharingBadge(_ c: Child, window: Rect?, buttons: [Rect]) -> Bool {
        guard c.role == "AXMenuButton", (c.subrole ?? "").isEmpty, let f = c.frame else { return false }
        if !buttons.isEmpty {
            return buttons.contains { b in
                let x = b.x + b.w / 2, y = b.y + b.h / 2
                return x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h
            }
        }
        guard let window else { return false }
        let k = corner(of: window)
        return f.x >= k.x && f.y >= k.y && f.x + f.w <= k.x + k.w && f.y + f.h <= k.y + k.h
    }

    /// A window's children as the text and the signature read them (§22.1, §22.2): the badge
    /// dropped, the title-bar buttons last in the order close, minimize, full screen, zoom,
    /// every other child where AX listed it.
    public static func order<N>(_ children: [N], window: Rect?, read: (N) -> Child) -> [N] {
        let facts = children.map(read)
        let buttons = facts.compactMap { isButton(subrole: $0.subrole) ? $0.frame : nil }
        var rest: [N] = []
        var chrome: [(rank: Int, at: Int, node: N)] = []
        for (i, (child, f)) in zip(children, facts).enumerated() {
            if let r = rank(subrole: f.subrole) {
                chrome.append((r, i, child))
            } else if !isSharingBadge(f, window: window, buttons: buttons) {
                rest.append(child)
            }
        }
        return rest + chrome.sorted { ($0.rank, $0.at) < ($1.rank, $1.at) }.map(\.node)
    }

    /// The children of a snapshot root, when the root is a window (a dialog subrole included; never a sheet).
    public static func order(_ window: AXNode) -> [AXNode] {
        guard window.role == "AXWindow" else { return window.children }
        return order(window.children, window: window.frame) { Child(role: $0.role, subrole: $0.subrole, frame: $0.frame) }
    }
}
