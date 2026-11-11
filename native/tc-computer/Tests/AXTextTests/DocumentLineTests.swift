@testable import AXText
import ComputerProtocol
import Foundation
import Testing

// The document line (docs/computer-protocol.md §25.10) and the closed-menu note (§25.11), as
// src/shared/computer/observation.ts formatDocumentLine and its parser write them.

private let utc = TimeZone(identifier: "UTC")!
private let home = "/Users/me"
/// 2026-11-10 14:02:11 UTC
private let mtime = 1_794_319_331.0

private func doc(_ url: String?, edited: Bool = false, mtime: Double? = mtime) -> WindowDocument? {
    WindowDocument.from(url: url, mtime: mtime, edited: edited, home: home, timeZone: utc)
}

@Suite struct DocumentLineTests {
    @Test func theThreeKindsAsTheGrammarWritesThem() {
        #expect(doc("file:///Users/me/run/Total.txt", edited: true)?.line() == #"file "~/run/Total.txt" written 14:02:11 · edited"#)
        #expect(doc("file:///Users/me/run/Total.txt")?.line() == #"file "~/run/Total.txt" written 14:02:11"#)
        #expect(doc(nil, edited: true)?.line() == "file: not saved yet · edited")
        #expect(doc("file:///Users/me/run/")?.line() == #"folder "~/run""#)
        #expect(doc("file:///Users/me/run/Total.txt", mtime: nil)?.line() == #"file "~/run/Total.txt""#)
        // a diff's form
        #expect(doc("file:///Users/me/run/Total.txt")?.line(changed: true) == #"~ file "~/run/Total.txt" written 14:02:11"#)
    }

    @Test func aFolderIsNeverEditedAndNothingIsSaidOfNothing() {
        #expect(doc("file:///Users/me/run/", edited: true)?.line() == #"folder "~/run""#)
        #expect(WindowDocument(kind: .folder, path: "~/run", edited: true).line() == #"folder "~/run""#)
        #expect(doc(nil) == nil)
        #expect(doc("https://example.com/a.txt", edited: true) == nil)
    }

    @Test func urlsDecodeAndPathsOutsideHomeStayWhole() {
        #expect(doc("file:///Users/me/My%20Notes/a%C3%A9.txt")?.path == "~/My Notes/aé.txt")
        #expect(doc("file://localhost/private/tmp/x.txt")?.path == "/private/tmp/x.txt")
        #expect(doc("file:///Users/me/")?.path == "~")
        #expect(doc("file:///")?.path == "/")
        #expect(doc("file:///Users/meg/a.txt")?.path == "/Users/meg/a.txt")
        // a path the JSON quote escapes
        #expect(doc(#"file:///Users/me/say%22hi%22.txt"#)?.line() == #"file "~/say\"hi\".txt" written 14:02:11"#)
    }

    @Test func writtenIsTheLocalClock() {
        #expect(WindowDocument.clock(mtime, timeZone: utc) == "14:02:11")
        #expect(WindowDocument.clock(mtime, timeZone: TimeZone(secondsFromGMT: -5 * 3600)!) == "09:02:11")
        #expect(WindowDocument.clock(0, timeZone: utc) == "00:00:00")
    }

    @Test func theLineSitsAfterTheHeaderAndBeforeOtherWindows() {
        let t = Tree()
        var s = snapshot([t.window(title: "Total.txt", [t.node("AXTextArea", value: .string("hi"), frame: Rect(x: 0, y: 40, w: 600, h: 400))])],
                         others: [OtherWindow(title: "Notes")])
        s.document = doc("file:///Users/me/run/Total.txt", edited: true)
        let lines = text(s).split(separator: "\n").map(String.init)
        #expect(lines[1] == #"file "~/run/Total.txt" written 14:02:11 · edited"#)
        #expect(lines[2] == #"other windows: "Notes""#)
        #expect(lines[3].hasPrefix("[1] window"))
    }

    @Test func aDiffNamesTheDocumentOnlyWhenItChanged() {
        // the sample's ids come from a fresh Tree each time, so every read is the same window
        let sample = { (value: String) in textEditSample(Tree(), value: value).0 }
        var s = sample("hi")
        s.document = doc("file:///Users/me/run/Total.txt", edited: true)
        let reader = Reader()
        #expect(reader.read(s).kind == .full)
        // the same document: unchanged, no line
        #expect(reader.read(s).kind == .unchanged)
        // saved: written moved, edited cleared
        s.document = doc("file:///Users/me/run/Total.txt", mtime: mtime + 8)
        let saved = reader.read(s)
        #expect(saved.kind == .diff)
        #expect(saved.text.split(separator: "\n").dropFirst().map(String.init) == [#"~ file "~/run/Total.txt" written 14:02:19"#])
        // the window's other changes come after it
        var typed = sample("hi!")
        typed.document = doc("file:///Users/me/run/Total.txt", edited: true, mtime: mtime + 8)
        let next = reader.read(typed).text.split(separator: "\n").map(String.init)
        #expect(next[1] == #"~ file "~/run/Total.txt" written 14:02:19 · edited"#)
        #expect(next[2].hasPrefix("~ [") && next[2].contains("text area"))
        // a document that went away cannot be said in a diff
        typed.document = nil
        let gone = reader.read(typed)
        #expect(gone.kind == .full)
        #expect(!gone.text.contains("file "))
    }

    @Test func theBudgetCountsTheLine() {
        let t = Tree()
        var s = snapshot([t.window([t.node("AXTextArea", value: .string("hi"), frame: Rect(x: 0, y: 40, w: 600, h: 400))])])
        let bare = Reader().read(s).stats.bytes
        s.document = doc("file:///Users/me/run/Total.txt")
        let line = #"file "~/run/Total.txt" written 14:02:11"#
        #expect(Reader().read(s).stats.bytes == bare + 1 + line.utf8.count)
    }
}

@Suite struct MenuNoteTests {
    /// The TextEdit sample with a pop up's menu open as the snapshot's second root (§2.1).
    private func withMenu() -> (AXSnapshot, NodeID) {
        let t = Tree(start: 10_000)
        let menuID: NodeID = 900
        let menu = t.node("AXMenu", id: menuID, frame: Rect(x: 100, y: 100, w: 200, h: 60), [
            t.node("AXMenuItem", id: 901, title: "New Folder", frame: Rect(x: 100, y: 100, w: 200, h: 20), actions: ["AXPress", "AXCancel"]),
            t.node("AXMenuItem", id: 902, title: "Get Info", frame: Rect(x: 100, y: 120, w: 200, h: 20), actions: ["AXPress", "AXCancel"])
        ])
        var s = textEditSample(Tree()).0
        s.roots.append(menu)
        return (s, menuID)
    }

    @Test func aMenuTheCallClosesCarriesTheNoteUnderItsItems() {
        var (s, menuID) = withMenu()
        let plain = text(s)
        #expect(!plain.contains(ObservationTables.menuClosedNote))
        s.closingMenus = [menuID]
        let lines = text(s).split(separator: "\n").map(String.init)
        let item = lines.firstIndex { $0.contains(#"menu item "Get Info""#) }!
        let itemIndent = lines[item].prefix { $0 == " " }.count
        #expect(lines[item + 1] == String(repeating: " ", count: itemIndent) + ObservationTables.menuClosedNote)
        #expect(lines.last == lines[item + 1])
    }

    @Test func aDiffSaysTheNoteUnderTheMenusChangedLine() {
        var (s, menuID) = withMenu()
        let reader = Reader()
        reader.read(s)
        s.closingMenus = [menuID]
        let d = reader.read(s)
        #expect(d.kind == .diff)
        let lines = d.text.split(separator: "\n").map(String.init)
        #expect(lines.count == 3)
        #expect(lines[1].hasPrefix("~ [") && lines[1].contains("menu"))
        #expect(lines[2] == Layout.indent(1) + ObservationTables.menuClosedNote)
    }
}
