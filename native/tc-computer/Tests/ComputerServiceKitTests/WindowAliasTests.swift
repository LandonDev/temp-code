@testable import ComputerServiceKit
import Testing

/// §27.6: a window keeps its old titles, consulted only after a live title or tab matched nothing.
@Suite struct WindowAliasTests {
    @Test func anAutosavedWindowStillAnswersToItsOldTitle() {
        var a = WindowAliases()
        a.answered(id: 301, title: "Untitled")
        a.answered(id: 301, title: "Notes.rtf")
        #expect(a.match("Untitled", live: [301, 302]) == 301)
        #expect(a.match("Notes.rtf", live: [301]) == 301)
    }

    @Test func aTitleReusedAfterTheLastReadMatchesTheLiveWindow() {
        var a = WindowAliases()
        a.answered(id: 301, title: "Untitled")
        // the window that had it closed; a new one took the title, and a live title wins before this step runs
        a.keep(live: [302])
        a.answered(id: 302, title: "Untitled")
        #expect(a.match("Untitled", live: [302]) == 302)
    }

    @Test func twoLiveWindowsThatSharedATitleMatchNeither() {
        var a = WindowAliases()
        a.answered(id: 301, title: "Untitled")
        a.answered(id: 302, title: "Untitled")
        a.answered(id: 301, title: "A.rtf")
        a.answered(id: 302, title: "B.rtf")
        #expect(a.match("Untitled", live: [301, 302]) == nil)
        #expect(a.match("A.rtf", live: [301, 302]) == 301)
    }

    @Test func aGoneWindowsTitleMatchesNothing() {
        var a = WindowAliases()
        a.answered(id: 301, title: "Untitled")
        #expect(a.match("Untitled", live: [302]) == nil)
        a.keep(live: [302])
        #expect(a.match("Untitled", live: [301]) == nil)
    }

    @Test func theRecordIsBounded() {
        var a = WindowAliases()
        for id in 0..<(WindowAliases.maxWindows + 5) { a.answered(id: id, title: "W\(id)") }
        #expect(a.match("W0", live: [0]) == nil)
        #expect(a.match("W\(WindowAliases.maxWindows + 4)", live: [WindowAliases.maxWindows + 4]) == WindowAliases.maxWindows + 4)
        a.answered(id: 1, title: "")
        #expect(a.match("", live: [1]) == nil)
    }
}
