import Input
import Testing

/// A sheet on the step's window holds AX's focused window and still counts as that window (§26.7).
@Suite struct FocusedWindowTests {
    private let roles = ["doc": "AXWindow", "files": "AXWindow", "save-panel": "AXSheet", "GoToWindow": "AXSheet", "field": "AXTextField"]
    private let parents = ["save-panel": "doc", "GoToWindow": "save-panel", "field": "files"]
    private func holds(_ focused: String, _ window: String) -> Bool {
        FocusedWindow.isOrSheetOf(focused, window, same: { $0 == $1 }, role: { roles[$0] }, parent: { parents[$0] })
    }

    @Test func theWindowAndTheSheetsOnItCount() {
        #expect(holds("doc", "doc"))
        #expect(holds("save-panel", "doc"))
        #expect(holds("GoToWindow", "doc"))
    }

    @Test func anotherWindowOrSomethingThatIsNoSheetDoesNot() {
        #expect(!holds("files", "doc"))
        #expect(!holds("GoToWindow", "files"))
        #expect(!holds("field", "files"))
    }
}
