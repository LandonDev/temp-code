import ComputerProtocol
import Foundation

// One snapshot type for the live walk and the recorded fixtures, so every rule
// after the walk is the same code online and offline (plan §2).

/// Live: the handle table's token for one AXUIElement. Offline: the fixture's
/// recorded id (hashed), else a fresh number per node per state.
public typealias NodeID = UInt64

/// AXValue as read: a string, a number as AX wrote it, a boolean, or something
/// else (an AXValueRef point or size) that never prints.
public enum AXScalar: Sendable, Equatable {
    case string(String)
    case number(String)
    case bool(Bool)
    case other
}

public struct AXFlags: Sendable, Equatable {
    public var enabled: Bool?
    public var focused: Bool?
    public var selected: Bool?
    public var expanded: Bool?
    public var required: Bool?
    public var invalid: Bool?
    public var modal: Bool?
    /// AXElementBusy
    public var busy: Bool?
    /// AXLoaded
    public var loaded: Bool?

    public init(enabled: Bool? = nil, focused: Bool? = nil, selected: Bool? = nil, expanded: Bool? = nil, required: Bool? = nil, invalid: Bool? = nil, modal: Bool? = nil, busy: Bool? = nil, loaded: Bool? = nil) {
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.expanded = expanded
        self.required = required
        self.invalid = invalid
        self.modal = modal
        self.busy = busy
        self.loaded = loaded
    }
}

/// Children counted, never read: outside their container's visible rect.
public struct Hidden: Sendable, Equatable {
    public var above: Int
    public var below: Int

    public init(above: Int = 0, below: Int = 0) {
        self.above = above
        self.below = below
    }

    public var isEmpty: Bool { above == 0 && below == 0 }

    public static func + (a: Hidden, b: Hidden) -> Hidden { Hidden(above: a.above + b.above, below: a.below + b.below) }
}

public struct AXNode: Sendable {
    public var id: NodeID
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    /// the value of the element AXTitleUIElement names (an input's label)
    public var titleElementValue: String?
    public var placeholder: String?
    public var value: AXScalar?
    /// the value's whole length in UTF-16 units when only a prefix was read (§5.2)
    public var valueLength: Int?
    public var identifier: String?
    public var domIdentifier: String?
    public var flags: AXFlags
    /// global points
    public var frame: Rect?
    /// raw CopyActionNames, custom ones included
    public var actions: [String]
    /// which of AXValue, AXSelectedText, AXSelectedTextRange, AXFocused, AXSelected are settable; nil when not read
    public var settable: Set<String>?
    /// `[location, length]` in UTF-16 units
    public var selectedTextRange: [Int]?
    public var children: [AXNode]
    /// children of this node left unread by the viewport cut
    public var hidden: Hidden?

    public init(id: NodeID, role: String, subrole: String? = nil, title: String? = nil, description: String? = nil, titleElementValue: String? = nil, placeholder: String? = nil, value: AXScalar? = nil, valueLength: Int? = nil, identifier: String? = nil, domIdentifier: String? = nil, flags: AXFlags = AXFlags(), frame: Rect? = nil, actions: [String] = [], settable: Set<String>? = nil, selectedTextRange: [Int]? = nil, children: [AXNode] = [], hidden: Hidden? = nil) {
        self.id = id
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.titleElementValue = titleElementValue
        self.placeholder = placeholder
        self.value = value
        self.valueLength = valueLength
        self.identifier = identifier
        self.domIdentifier = domIdentifier
        self.flags = flags
        self.frame = frame
        self.actions = actions
        self.settable = settable
        self.selectedTextRange = selectedTextRange
        self.children = children
        self.hidden = hidden
    }
}

public struct AppFacts: Sendable, Equatable {
    public var pid: Int32
    public var bundleId: String?
    public var name: String

    public init(pid: Int32, bundleId: String?, name: String) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
    }
}

/// A window of the app other than the target, for the header's second line.
public struct OtherWindow: Sendable, Equatable {
    public var title: String
    public var minimized: Bool
    public var otherSpace: Bool

    public init(title: String, minimized: Bool = false, otherSpace: Bool = false) {
        self.title = title
        self.minimized = minimized
        self.otherSpace = otherSpace
    }
}

public struct AXSnapshot: Sendable {
    public var app: AppFacts
    public var window: WindowInfo
    public var otherWindows: [OtherWindow]
    /// `[0]` the target window; then open menus, popovers and the focused dialog (spec §2.1), in that order
    public var roots: [AXNode]
    /// only when the request asked for menus; printed after the roots
    public var menuBar: AXNode?
    public var focusedID: NodeID?
    /// actions every web-content node carries (A5, `ObservationTables.ambientActions`); applied inside web areas only
    public var ambientActions: Set<String>
    public var visited: Int
    public var partial: Bool
    public var walkMs: Int

    public init(app: AppFacts, window: WindowInfo, otherWindows: [OtherWindow] = [], roots: [AXNode], menuBar: AXNode? = nil, focusedID: NodeID? = nil, ambientActions: Set<String> = [], visited: Int = 0, partial: Bool = false, walkMs: Int = 0) {
        self.app = app
        self.window = window
        self.otherWindows = otherWindows
        self.roots = roots
        self.menuBar = menuBar
        self.focusedID = focusedID
        self.ambientActions = ambientActions
        self.visited = visited
        self.partial = partial
        self.walkMs = walkMs
    }
}
