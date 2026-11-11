@testable import AXText
import ComputerProtocol
import Foundation

// §27's fixtures: the first node a test looks for, and TextEdit's menu bar.

func first(_ n: AXNode, where match: (AXNode) -> Bool) -> AXNode? {
    if match(n) { return n }
    for c in n.children { if let hit = first(c, where: match) { return hit } }
    return nil
}

/// TextEdit's menu bar as macOS 27 lays it out (no recorded menu-bar tree exists: the recorder reads windows). Closed
/// menus' items have no frame, as AX reports them.
func textEditMenuBar(_ t: Tree) -> AXNode {
    func item(_ title: String, enabled: Bool = true, _ sub: [AXNode]? = nil) -> AXNode {
        t.node("AXMenuItem", title: title, flags: AXFlags(enabled: enabled), actions: ["AXPress", "AXCancel"], sub.map { [t.node("AXMenu", nil, $0)] } ?? [])
    }
    func separator() -> AXNode { t.node("AXMenuItem", flags: AXFlags(enabled: false)) }
    func bar(_ title: String, _ items: [AXNode]) -> AXNode {
        t.node("AXMenuBarItem", title: title, actions: ["AXPress", "AXCancel"], [t.node("AXMenu", nil, items)])
    }
    return t.node("AXMenuBar", nil, [
        bar("Apple", [item("About This Mac"), separator(), item("System Settings…")]),
        bar("TextEdit", [item("About TextEdit"), item("Settings…"), separator(), item("Quit TextEdit")]),
        bar("File", [
            item("New"), item("Open…"), item("Open Recent", [item("Notes.rtf"), separator(), item("Clear Menu")]), separator(),
            item("Close"), item("Save…", enabled: false), item("Duplicate"), item("Rename…"), item("Move To…"),
            item("Export as PDF…"), separator(), item("Print…")
        ]),
        bar("Edit", [
            item("Undo"), item("Redo", enabled: false), separator(), item("Cut"), item("Copy"), item("Paste"),
            item("Find", [item("Find…"), item("Find and Replace…"), item("Find Next")])
        ]),
        bar("Format", [item("Font", [item("Show Fonts"), item("Bold")]), item("Make Plain Text", enabled: false)])
    ])
}
