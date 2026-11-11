import ComputerCore
import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// `save_as`'s pure parts (docs/computer-protocol.md §26.7). Foundation only: the box runs this file
// from scripts/computer-text-test.sh, the Mac in InputTests.

private let home = "/Users/me"

private func button(_ id: String?, title: String? = nil, isDefault: Bool = false) -> PanelNode {
    PanelNode(role: "AXButton", identifier: id, title: title, isDefault: isDefault)
}

/// TextEdit's document window with the save sheet E4 read, optionally Go to Folder and a Replace alert over it.
private func window(goTo: Bool = false, replace: Bool = false, okID: String? = PanelIDs.ok) -> PanelNode {
    var sheet = PanelNode(role: "AXSheet", identifier: PanelIDs.panel, children: [
        PanelNode(role: "AXTextField", identifier: PanelIDs.nameField, value: "Untitled.txt"),
        PanelNode(role: "AXGroup", children: [
            PanelNode(role: "AXPopUpButton", description: PanelIDs.wherePopup, value: "Documents"),
            button("NS_OPEN_SAVE_DISCLOSURE_TRIANGLE")
        ]),
        button(PanelIDs.cancel, title: "Cancel"),
        button(okID, title: "Save", isDefault: true)
    ])
    if goTo {
        sheet.children.append(PanelNode(role: "AXSheet", identifier: PanelIDs.goTo, children: [
            PanelNode(role: "AXTextField", identifier: PanelIDs.pathField, value: "/"),
            PanelNode(role: "AXList", identifier: "/private/tmp")
        ]))
    }
    if replace {
        sheet.children.append(PanelNode(role: "AXSheet", children: [
            PanelNode(role: "AXStaticText", value: "“note.txt” already exists. Do you want to replace it?"),
            button(nil, title: "Cancel"),
            button(nil, title: "Replace")
        ]))
    }
    return PanelNode(role: "AXWindow", title: "Untitled", children: [
        PanelNode(role: "AXTextArea"),
        sheet
    ])
}

@Suite struct SavePanelPartsTests {
    @Test func findsThePartsE4Read() throws {
        let root = window()
        let p = try #require(SavePanelParts.find(in: root))
        #expect(p.panel == [1])
        #expect(root.at(p.nameField!)?.identifier == PanelIDs.nameField)
        #expect(root.at(p.ok!)?.title == "Save")
        #expect(root.at(p.cancel!)?.title == "Cancel")
        #expect(root.at(p.wherePopup!)?.value == "Documents")
        #expect(p.goTo == nil && p.pathField == nil && p.replace == nil)
    }

    @Test func theDefaultButtonStandsInForOKButton() throws {
        let root = window(okID: nil)
        let p = try #require(SavePanelParts.find(in: root))
        #expect(root.at(p.ok!)?.title == "Save")
    }

    @Test func goToFolderAndTheReplaceAlert() throws {
        let withGoTo = window(goTo: true)
        let g = try #require(SavePanelParts.find(in: withGoTo))
        #expect(withGoTo.at(g.goTo!)?.identifier == PanelIDs.goTo)
        #expect(withGoTo.at(g.pathField!)?.identifier == PanelIDs.pathField)
        let withAlert = window(replace: true)
        let r = try #require(SavePanelParts.find(in: withAlert))
        #expect(withAlert.at(r.replace!)?.title == "Replace")
        #expect(withAlert.at(r.replaceCancel!)?.title == "Cancel")
        // the alert's Cancel, not the panel's
        #expect(r.replaceCancel != r.cancel)
    }

    @Test func noPanelNoParts() {
        #expect(SavePanelParts.find(in: PanelNode(role: "AXWindow", children: [PanelNode(role: "AXTextArea")])) == nil)
    }
}

@Suite struct SaveTargetTests {
    @Test func splitsAbsoluteAndHomePaths() throws {
        let t = try #require(SaveTarget.parse("~/run/note.rtf", home: home))
        #expect(t == SaveTarget(folder: "/Users/me/run", name: "note.rtf", display: "~/run/note.rtf", displayFolder: "~/run", full: "/Users/me/run/note.rtf"))
        #expect(t.folderName == "run")
        let abs = try #require(SaveTarget.parse("/tmp/a.txt", home: home + "/"))
        #expect(abs.folder == "/tmp" && abs.display == "/tmp/a.txt" && abs.folderName == "tmp")
        let root = try #require(SaveTarget.parse("/a.txt", home: home))
        #expect(root.folder == "/" && root.folderName == "/")
        #expect(SaveTarget.parse("~/run/", home: home) == nil)
        #expect(SaveTarget.parse("run/a.txt", home: home) == nil)
        #expect(SaveTarget.parse("", home: home) == nil)
        #expect(SaveTarget.parse("/" + String(repeating: "a", count: 1_024), home: home) == nil)
    }

    @Test func inputOnIsCutInTheMiddle() throws {
        let long = "~/" + String(repeating: "d", count: 300) + "/note.txt"
        let t = try #require(SaveTarget.parse(long, home: home))
        #expect(t.on.utf16.count == 200)
        #expect(t.on.hasPrefix("~/ddd") && t.on.hasSuffix("/note.txt") && t.on.contains("…"))
        #expect(middleCut("short", max: 200) == "short")
        #expect(tildePath("/Users/me", home: home) == "~")
        #expect(tildePath("/Users/meet/x", home: home) == "/Users/meet/x")
    }

    @Test func aPathInTheNameFieldIsRefused() {
        let e = nameFieldRefusal(identifier: PanelIDs.nameField, text: "/a/b/c.txt")
        #expect(e?.kind == .actionUnsupported)
        #expect(e?.message == "The save panel's name field takes a file name; a / becomes : on disk. Use save_as with the path.")
        #expect(nameFieldRefusal(identifier: PanelIDs.nameField, text: "c.txt") == nil)
        #expect(nameFieldRefusal(identifier: "other", text: "/a") == nil)
    }
}

/// Plays the flow against what a scripted window would show after each move.
private struct PanelRig {
    var flow: SavePanelFlow
    var now = 0
    var moves: [PanelMove] = []

    init(path: String = "~/run/note.txt", replace: Bool = false, frontAllowed: Bool = true, appActive: Bool = false) {
        flow = SavePanelFlow(target: SaveTarget.parse(path, home: home)!, replace: replace, app: "TextEdit", frontAllowed: frontAllowed, appActive: appActive)
    }

    mutating func step(_ o: PanelObservation) -> PanelMove {
        var o = o
        o.now = now
        let m = flow.next(o)
        moves.append(m)
        now += 10
        return m
    }
}

private func seen(_ root: PanelNode, name: String? = "Untitled.txt", path: String? = nil, whereValue: String? = "Documents", menu: [MenuItemFacts] = [], hasFile: Bool = false) -> PanelObservation {
    PanelObservation(now: 0, parts: SavePanelParts.find(in: root), nameValue: name, pathValue: path, whereValue: whereValue, fileMenu: menu, windowHasFile: hasFile)
}

private let noPanel = PanelNode(role: "AXWindow", children: [PanelNode(role: "AXTextArea")])

@Suite struct SavePanelFlowTests {
    @Test func theWholeFlowInItsOrder() {
        var r = PanelRig()
        let menu = [MenuItemFacts(title: "New"), MenuItemFacts(title: "Save…", enabled: true), MenuItemFacts(title: "Save As…", enabled: true)]
        #expect(r.step(seen(noPanel, menu: menu)) == .pressMenu(["File", "Save As…"], atFront: false))
        #expect(r.step(seen(noPanel)) == .read(afterMs: InputTiming.panelPollMs))
        #expect(r.step(seen(window())) == .insert(.nameField, "/", selectAll: true))
        #expect(r.step(seen(window(goTo: true), path: "/")) == .insert(.pathField, "/Users/me/run", selectAll: true))
        #expect(r.step(seen(window(goTo: true), path: "/Users/me/run")) == .confirmGoTo)
        #expect(r.flow.usedFront && r.flow.tier == .front)
        #expect(r.step(seen(window(goTo: true))) == .read(afterMs: InputTiming.panelPollMs))
        #expect(r.step(seen(window(), whereValue: "run")) == .setValue(.nameField, "note.txt"))
        #expect(r.step(seen(window(), name: "note.txt", whereValue: "run")) == .press(.ok))
        #expect(r.step(seen(window(), name: "note.txt", whereValue: "run")) == .read(afterMs: InputTiming.panelPollMs))
        #expect(r.step(seen(noPanel)) == .checkDisk)
    }

    @Test func anOpenPanelIsUsedAsItIs() {
        var r = PanelRig()
        #expect(r.step(seen(window())) == .insert(.nameField, "/", selectAll: true))
    }

    @Test func saveForAWindowWithNoFileAndNothingElse() {
        var r = PanelRig()
        let menu = [MenuItemFacts(title: "New"), MenuItemFacts(title: "Save…")]
        #expect(r.step(seen(noPanel, menu: menu)) == .pressMenu(["File", "Save…"], atFront: false))
        var withFile = PanelRig()
        let m = withFile.step(seen(noPanel, menu: menu, hasFile: true))
        guard case .fail(let e) = m else { Issue.record("\(m)"); return }
        #expect(e.kind == .actionUnsupported)
        #expect(e.message == "TextEdit's File menu has no Save As…: New, Save….")
    }

    @Test func aDisabledItemGoesToFront() {
        let menu = [MenuItemFacts(title: "Save As…", enabled: false)]
        var r = PanelRig()
        #expect(r.step(seen(noPanel, menu: menu)) == .pressMenu(["File", "Save As…"], atFront: true))
        #expect(r.flow.tier == .front)
        var noFront = PanelRig(frontAllowed: false)
        #expect(noFront.step(seen(noPanel, menu: menu)) == .needsFront(menu: ["File", "Save As…"]))
        var active = PanelRig(appActive: true)
        guard case .fail(let e) = active.step(seen(noPanel, menu: menu)) else { Issue.record("no failure"); return }
        #expect(e.message == "File › Save As… is disabled." && e.menu == ["File", "Save As…"])
    }

    @Test func theGoToConfirmNeedsFront() {
        var r = PanelRig(frontAllowed: false)
        #expect(r.step(seen(window(goTo: true), path: "/")) == .insert(.pathField, "/Users/me/run", selectAll: true))
        #expect(r.step(seen(window(goTo: true), path: "/Users/me/run")) == .needsFront(menu: nil))
        #expect(!r.flow.usedFront)
    }

    @Test func readBacksRetryOnceThenCancelAndFail() {
        var r = PanelRig()
        _ = r.step(seen(window(goTo: true), path: "/"))
        #expect(r.step(seen(window(goTo: true), path: "/Users/me/ru")) == .insert(.pathField, "/Users/me/run", selectAll: true))
        #expect(r.step(seen(window(goTo: true), path: "/Users/me/ru")) == .press(.cancel))
        guard case .fail(let e) = r.step(seen(window())) else { Issue.record("no failure"); return }
        #expect(e.kind == .notCommitted)
        #expect(e.message == "TextEdit's save panel did not take the folder ~/run; nothing was saved.")
    }

    @Test func theFolderMustShowInTheWherePopup() {
        var r = PanelRig()
        _ = r.step(seen(window(goTo: true), path: "/"))
        _ = r.step(seen(window(goTo: true), path: "/Users/me/run"))
        #expect(r.step(seen(window(), whereValue: "Documents")) == .press(.cancel))
        guard case .fail(let e) = r.step(seen(window())) else { Issue.record("no failure"); return }
        #expect(e.message == "TextEdit's save panel did not go to ~/run; nothing was saved.")
    }

    @Test func theNameIsSetAfterTheFolderAndReadBack() {
        var r = PanelRig()
        _ = r.step(seen(window(goTo: true), path: "/"))
        _ = r.step(seen(window(goTo: true), path: "/Users/me/run"))
        #expect(r.step(seen(window(), whereValue: "run")) == .setValue(.nameField, "note.txt"))
        // the folder change reset it: set once more
        #expect(r.step(seen(window(), name: "Untitled.txt", whereValue: "run")) == .setValue(.nameField, "note.txt"))
        #expect(r.step(seen(window(), name: "note.txt", whereValue: "run")) == .press(.ok))
    }

    @Test func aReplaceAlertIsAnsweredOnlyWithReplace() {
        var keep = PanelRig()
        keep.flow.stage = .save
        #expect(keep.step(seen(window())) == .press(.ok))
        #expect(keep.step(seen(window(replace: true))) == .press(.replaceCancel))
        #expect(keep.step(seen(window())) == .press(.cancel))
        guard case .fail(let e) = keep.step(seen(noPanel)) else { Issue.record("no failure"); return }
        #expect(e.kind == .fileExists)
        #expect(e.message == "~/run/note.txt exists; pass replace to overwrite it.")

        var over = PanelRig(replace: true)
        over.flow.stage = .save
        #expect(over.step(seen(window())) == .press(.ok))
        #expect(over.step(seen(window(replace: true))) == .press(.replace))
        #expect(over.step(seen(noPanel)) == .checkDisk)
    }

    @Test func waitsAreBounded() {
        var r = PanelRig()
        _ = r.step(seen(noPanel, menu: [MenuItemFacts(title: "Save As…")]))
        r.now = InputTiming.panelOpenMaxMs
        guard case .fail(let e) = r.step(seen(noPanel)) else { Issue.record("no failure"); return }
        #expect(e.kind == .timeout)
        #expect(e.message == "TextEdit's save panel did not open within 3 s.")
    }

    @Test func aPanelThatClosesEarlySavedNothing() {
        var r = PanelRig()
        _ = r.step(seen(window()))
        guard case .fail(let e) = r.step(seen(noPanel)) else { Issue.record("no failure"); return }
        #expect(e.kind == .notCommitted)
        #expect(e.message == "TextEdit closed the save panel and no file appeared in ~/run.")
    }
}

@Suite struct SaveProofTests {
    let t = SaveTarget.parse("~/run/note.txt", home: home)!

    @Test func theFileAtThePathWrittenAfterTheStepBegan() {
        #expect(SaveProof.judge(t, after: ["note.txt": 105], startedAt: 100, documentAfter: nil, app: "TextEdit") == .success("/Users/me/run/note.txt"))
        // an older file of that name is no proof
        guard case .failure(let e) = SaveProof.judge(t, after: ["note.txt": 90], startedAt: 100, documentAfter: nil, app: "TextEdit") else { Issue.record("passed"); return }
        #expect(e.kind == .notCommitted)
    }

    @Test func theAppsExtensionOnlyWhenTheDocumentNamesIt() {
        // note.txt saved as rich text: TextEdit writes note.txt.rtf and the window names it
        #expect(SaveProof.judge(t, after: ["note.txt.rtf": 105], startedAt: 100, documentAfter: "/Users/me/run/note.txt.rtf", app: "TextEdit") == .success("/Users/me/run/note.txt.rtf"))
        let bare = SaveTarget.parse("~/run/note", home: home)!
        #expect(SaveProof.judge(bare, after: ["note.rtf": 105], startedAt: 100, documentAfter: "/Users/me/run/note.rtf", app: "TextEdit") == .success("/Users/me/run/note.rtf"))
        // the same file with no document naming it, another writer's file, another folder: no proof
        for (after, doc) in [(["note.txt.rtf": 105.0], nil), (["other.txt": 105.0], "/Users/me/run/other.txt"), (["note.txt.rtf": 105.0], "/Users/me/elsewhere/note.txt.rtf"), (["note.txt.tar.gz": 105.0], "/Users/me/run/note.txt.tar.gz")] as [([String: Double], String?)] {
            if case .success = SaveProof.judge(t, after: after, startedAt: 100, documentAfter: doc, app: "TextEdit") { Issue.record("\(after) \(String(describing: doc))") }
        }
    }
}
