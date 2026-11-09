#if canImport(ApplicationServices)
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
    static let lists: Set<String> = ["AXList", "AXOutline", "AXTable"]
    static let listExtra = ["AXVisibleRows", "AXVisibleChildren", "AXVisibleColumns"]
    static let windows: Set<String> = ["AXWindow", "AXSheet", "AXDialog"]
    static let formControls: Set<String> = ["AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXIncrementor", "AXStepper", "AXButton", "AXMenuButton", "AXColorWell", "AXLevelIndicator"]

    /// Stage B, a node inside its clip: one batch by its role's class.
    static func stageB(_ role: String) -> [String] {
        var out = always
        if textEntry.contains(role) { out += textEntryExtra } else { out.append("AXValue") }
        if expandable.contains(role) { out.append("AXExpanded") }
        if lists.contains(role) { out += listExtra }
        if role == "AXWebArea" { out += ["AXElementBusy", "AXLoaded"] }
        if windows.contains(role) { out.append("AXModal") }
        if formControls.contains(role) { out.append("AXTitleUIElement") }
        return out
    }

    /// What a resolve reads of an element: its place, then stage B.
    static func resolve(_ role: String) -> [String] { ["AXRole", "AXSubrole", "AXPosition", "AXSize"] + stageB(role) }
}
#endif
