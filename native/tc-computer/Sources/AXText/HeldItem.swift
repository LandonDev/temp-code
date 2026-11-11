/// §27.7 (b): a table, outline, list or browser holding the focus holds the row or cell an earlier step targeted
/// inside it. AppKit selects a clicked row and focuses its table, never the row, and keys act on the selection
/// (TC Probe's Notes: a click on a row, then Return to rename it, 2026-11-11).
public enum HeldItem {
    public static let containers: Set<String> = ["AXTable", "AXOutline", "AXList", "AXBrowser"]
    public static let items: Set<String> = ["AXRow", "AXCell"]

    /// `focusedIsAncestor`: the focused element is among the targeted one's ancestors.
    public static func held(focusedRole: String, targetRole: String, focusedIsAncestor: Bool) -> Bool {
        focusedIsAncestor && containers.contains(focusedRole) && items.contains(targetRole)
    }
}
