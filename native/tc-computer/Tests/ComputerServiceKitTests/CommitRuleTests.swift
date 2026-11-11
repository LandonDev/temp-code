import ComputerProtocol
@testable import ComputerServiceKit
import Testing

// What a step is expected to commit, and the effect the check reports (§26.8, §26.9).

private let run = DocumentKind.folder("/Users/me/run")
private let doc = DocumentKind.file("/Users/me/run/Total.txt")
private let renameField = CommitElement(role: "input", inRow: true)

private func key(_ text: String) -> ComputerAction { ComputerAction(action: .key, text: text) }

@Suite struct CommitShortcutTests {
    @Test func parsesCombosAsTheMenuNamesThem() {
        #expect(CommitShortcut.parse("super+s") == .save)
        #expect(CommitShortcut.parse("cmd+S") == .saveAs)
        #expect(CommitShortcut.parse("super+shift+s") == .saveAs)
        #expect(CommitShortcut.parse("super+alt+shift+s") == .saveAsOption)
        #expect(CommitShortcut.parse("super+BackSpace") == .moveToTrash)
        #expect(CommitShortcut.parse("command+backspace") == .moveToTrash)
        #expect(CommitShortcut.parse("super+shift+n") == .newFolder)
        #expect(CommitShortcut.parse("Return") == CommitShortcut("Return", command: false))
        #expect(CommitShortcut.parse("hyper+s") == nil)
        #expect(CommitShortcut.parse("super+") == nil)
    }
}

@Suite struct CommitRuleExpectsTests {
    @Test func theCommitMenuByTitleAndByKey() {
        #expect(CommitRule.expects(CommitContext(action: key("super+s"), menuPath: ["File", "Save"], document: doc)) == .save)
        #expect(CommitRule.expects(CommitContext(action: key("super+s"), document: doc)) == .save)
        for (combo, title) in [("super+shift+s", "Save As…"), ("super+BackSpace", "Move to Trash"), ("super+shift+n", "New Folder")] {
            #expect(CommitRule.expects(CommitContext(action: key(combo), menuPath: ["File", title])) == .write, "\(title)")
            #expect(CommitRule.expects(CommitContext(action: key(combo))) == .write, "\(combo)")
        }
        let press = ComputerAction(action: .perform, element: 4, name: "press")
        for title in ["Save…", "Rename...", "Move To…", "Export…", "Revert To Saved", "Save As"] {
            #expect(CommitRule.expects(CommitContext(action: press, element: CommitElement(role: "menu item"), menuPath: ["File", title])) != nil, "\(title)")
        }
        // a localized title still counts by its key equivalent
        #expect(CommitRule.expects(CommitContext(action: press, element: CommitElement(role: "menu item"), menuPath: ["Ablage", "Sichern"], menuShortcut: .save)) == .save)
        // another item does not
        #expect(CommitRule.expects(CommitContext(action: key("super+n"), menuPath: ["File", "New"])) == nil)
        #expect(CommitRule.expects(CommitContext(action: press, element: CommitElement(role: "menu item"), menuPath: ["Edit", "Copy"], menuShortcut: CommitShortcut("c"))) == nil)
    }

    @Test func savePanelsAndSaveAs() {
        #expect(CommitRule.expects(CommitContext(action: ComputerAction(action: .saveAs, path: "~/run/a.txt"))) == .write)
        let ok = CommitElement(role: "button", isPanelDefault: true)
        #expect(CommitRule.expects(CommitContext(action: ComputerAction(action: .leftClick, element: 9), element: ok)) == .write)
        #expect(CommitRule.expects(CommitContext(action: ComputerAction(action: .perform, element: 9, name: "press"), element: ok)) == .write)
        #expect(CommitRule.expects(CommitContext(action: ComputerAction(action: .leftClick, element: 9), element: CommitElement(role: "button"))) == nil)
    }

    @Test func anInlineRenameInAFolderWindow() {
        for a in [key("Return"), key("Tab"), key("KP_Enter"), ComputerAction(action: .perform, element: 3, name: "confirm"), ComputerAction(action: .setValue, element: 3, value: "b.txt")] {
            #expect(CommitRule.expects(CommitContext(action: a, element: renameField, document: run)) == .rename, "\(a.action)")
        }
        // a set_value the batch commits next is not expected itself
        let set = ComputerAction(action: .setValue, element: 3, value: "b.txt")
        #expect(CommitRule.expects(CommitContext(action: set, element: renameField, document: run, next: key("Return"))) == nil)
        #expect(CommitRule.expects(CommitContext(action: set, element: renameField, document: run, next: ComputerAction(action: .wait, duration: 1))) == .rename)
        // a document window, a field outside a row, a repeated key: not a rename
        #expect(CommitRule.expects(CommitContext(action: key("Return"), element: renameField, document: doc)) == nil)
        #expect(CommitRule.expects(CommitContext(action: key("Return"), element: CommitElement(role: "input"), document: run)) == nil)
        #expect(CommitRule.expects(CommitContext(action: ComputerAction(action: .key, text: "Return", repeat: 2), element: renameField, document: run)) == nil)
    }

    @Test func expectsBeforeIsWhatDecision12Names() {
        #expect(CommitRule.expectsBefore(CommitContext(action: key("Return"), element: renameField, document: run)))
        #expect(CommitRule.expectsBefore(CommitContext(action: key("super+s"), document: doc)))
        #expect(CommitRule.expectsBefore(CommitContext(action: ComputerAction(action: .perform, element: 4, name: "pick"), element: CommitElement(role: "menu item"), menuPath: ["File", "New Folder"])))
        // set_value acts at ax; a panel's button and save_as have their own routes
        #expect(!CommitRule.expectsBefore(CommitContext(action: ComputerAction(action: .setValue, element: 3, value: "b"), element: renameField, document: run)))
        // Finder's rename: a background AXConfirm on the name field did nothing, so the confirm goes to front
        #expect(CommitRule.expectsBefore(CommitContext(action: ComputerAction(action: .perform, element: 6, name: "confirm"), element: renameField, document: run)))
        #expect(!CommitRule.expectsBefore(CommitContext(action: ComputerAction(action: .perform, element: 6, name: "confirm"), element: renameField, document: doc)))
        #expect(!CommitRule.expectsBefore(CommitContext(action: ComputerAction(action: .saveAs, path: "~/a"))))
        #expect(!CommitRule.expectsBefore(CommitContext(action: key("Return"), element: renameField, document: doc)))
        #expect(!CommitRule.expectsBefore(CommitContext(action: key("a"), document: doc)))
    }
}

@Suite struct CommitRuleEffectTests {
    @Test func anythingOnDiskIsChanged() {
        let disk = DiskChange(renamed: [DiskChange.Renamed(from: "~/run/a.txt", to: "~/run/b.txt")])
        #expect(CommitRule.effect(expected: .rename, window: .none, disk: disk) == .changed)
        #expect(CommitRule.effect(expected: nil, window: .unknown, disk: DiskChange(saved: "~/run/Total.txt", unexpected: true)) == .changed)
    }

    @Test func expectedWindowChangedNothingOnDiskIsUncommitted() {
        #expect(CommitRule.effect(expected: .rename, window: .changed, disk: nil) == .uncommitted)
        #expect(CommitRule.effect(expected: .write, window: .changed, disk: DiskChange(edited: DiskChange.Edited(before: false, after: true))) == .uncommitted)
        // the window did not change: the step's own effect stands
        #expect(CommitRule.effect(expected: .rename, window: .none, disk: nil) == .none)
        // nothing expected: the window's effect
        #expect(CommitRule.effect(expected: nil, window: .changed, disk: nil) == .changed)
    }

    @Test func aSaveIsSatisfiedByTheEditedFlagClearing() {
        let cleared = DiskChange(edited: DiskChange.Edited(before: true, after: false))
        #expect(CommitRule.effect(expected: .save, window: .changed, disk: cleared) == .changed)
        #expect(CommitRule.effect(expected: .save, window: .none, disk: cleared) == .changed)
        // another kind with the flag cleared is not uncommitted, nor promoted
        #expect(CommitRule.effect(expected: .rename, window: .changed, disk: cleared) == .changed)
        #expect(CommitRule.effect(expected: .rename, window: .none, disk: cleared) == .none)
    }

    @Test func anUnknownDiskChangesNothing() {
        #expect(CommitRule.effect(expected: .rename, window: .changed, disk: DiskChange(unknown: true)) == .changed)
    }

    @Test func theHintByTheElement() {
        let rename = CommitContext(action: ComputerAction(action: .setValue, element: 3, value: "b.txt"), element: renameField, document: run)
        #expect(CommitRule.hint(rename) == "commit it with key Return in the field")
        let menu = CommitContext(action: ComputerAction(action: .perform, element: 4, name: "press"), element: CommitElement(role: "menu item"), menuPath: ["File", "Save"])
        #expect(CommitRule.hint(menu) == "commit it with File › Save")
        #expect(CommitRule.hint(CommitContext(action: key("a"))) == nil)
        let d = CommitRule.hinted(nil, effect: .uncommitted, context: rename)
        #expect(d == DiskChange(hint: "commit it with key Return in the field"))
        #expect(CommitRule.hinted(nil, effect: .changed, context: rename) == nil)
    }
}
