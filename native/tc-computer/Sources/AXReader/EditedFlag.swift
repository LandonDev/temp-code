import Foundation

/// The window's edited flag (docs/computer-protocol.md §26.8, E5). The close button's `AXEdited` says it for a
/// document that saves on request, but stays 0 for one that autosaves in place (TextEdit, TC Probe's `--active`
/// document, macOS 27.2): AppKit says that one only as the title bar's status, a menu button of the window whose
/// title is AppKit's own word, "Edited" ("Bearbeitet" in German), empty while the document is clean.
public enum EditedFlag {
    /// AppKit's word for an edited document's title-bar status in the person's language (its `AutosaveButton` table).
    public static let word: String = Bundle(path: "/System/Library/Frameworks/AppKit.framework")?
        .localizedString(forKey: "Edited", value: "Edited", table: "AutosaveButton") ?? "Edited"

    /// The flag from the close button's `AXEdited` and the titles of the window's own menu buttons: set when either
    /// says so; else the close button's word, nil when the window has none.
    public static func of(closeButton: Bool?, statusTitles: [String], word: String = word) -> Bool? {
        if closeButton == true { return true }
        if statusTitles.contains(where: { $0 == word || $0 == "Edited" }) { return true }
        return closeButton
    }
}
