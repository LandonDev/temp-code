#if canImport(ApplicationServices)
import AXText
import Foundation

/// What each stage asks of a node (plan §5.2): the cost of a read is per
/// attribute served, so a node is asked only for what its role uses.
/// `tc-ax bench` counts calls and attributes per node; the third cheap fix
/// moves attributes between stage B and stage C by what it measures.
enum Attributes {
    /// Stage A, every node reached: enough to place it and to decide whether to read more.
    static let stageA = ["AXRole", "AXSubrole", "AXPosition", "AXSize", "AXChildren"]

    static let always = ["AXTitle", "AXDescription", "AXIdentifier", "AXDOMIdentifier", "AXEnabled", "AXFocused", "AXSelected"]
    static let textEntry: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXDateField", "AXSearchField"]
    static let textEntryExtra = ["AXNumberOfCharacters", "AXSelectedTextRange", "AXPlaceholderValue", "AXRequired", "AXInvalid", "AXTitleUIElement"]
    static let expandable: Set<String> = ["AXCheckBox", "AXRadioButton", "AXRow", "AXCell", "AXDisclosureTriangle", "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXMenuBarItem", "AXButton"]
    static let lists: Set<String> = Viewport.listRoles
    static let listExtra = ["AXVisibleRows", "AXVisibleChildren", "AXVisibleColumns"]
    static let windows: Set<String> = ["AXWindow", "AXSheet", "AXDialog"]
    static let formControls: Set<String> = ["AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXIncrementor", "AXStepper", "AXButton", "AXMenuButton", "AXColorWell", "AXLevelIndicator"]

    /// Stage B, a node inside its clip: one batch by its role's class (and, for the close button, its subrole).
    static func stageB(_ role: String, subrole: String? = nil) -> [String] {
        var out = always
        if textEntry.contains(role) { out += textEntryExtra } else { out.append("AXValue") }
        if expandable.contains(role) { out.append("AXExpanded") }
        if lists.contains(role) { out += listExtra }
        // AXURL matches an untitled page to its tab (§25.2)
        if role == "AXWebArea" { out += ["AXElementBusy", "AXLoaded", "AXURL"] }
        if windows.contains(role) { out.append("AXModal") }
        // §22.1, §22.4: a window's buttons answer here whether or not a capture hid them from AXChildren
        if role == "AXWindow" { out += ["AXMinimized"] + TitleBar.attributes }
        // §26.8, E5: the window's file (a file:// URL; a Finder window's is its folder) and the edited flag,
        // which is the close button's own attribute: each in a batch the walk already makes
        if role == "AXWindow" { out.append("AXDocument") }
        if subrole == "AXCloseButton" { out.append("AXEdited") }
        if formControls.contains(role) { out.append("AXTitleUIElement") }
        return out
    }

    /// What a resolve reads of an element: its place, then stage B.
    static func resolve(_ role: String) -> [String] { ["AXRole", "AXSubrole", "AXPosition", "AXSize"] + stageB(role) }

    /// The close button's flag on its own, for a walk that never reached the button.
    static let edited = "AXEdited"
}
#endif
