import Foundation
import Testing
@testable import TempCodeClient

/// The port of src/shared/notes.ts against the cases of threadNotes.test.ts "note sections".
@Suite struct NotesTests {
    @Test func `an empty file carries every fixed heading in order`() {
        #expect(Notes.empty() == "## Goal\n\n## Decisions\n\n## State\n\n## Pointers\n\n## Open questions\n")
        #expect(Notes.isEmpty(Notes.empty()))
        #expect(Notes.isEmpty(""))
    }

    @Test func `replace swaps one section body and creates a missing heading in its place`() {
        let a = Notes.apply("", section: "state", content: "Done: parser.\nIn flight: tests.")
        #expect(Notes.body(of: a, section: "State") == "Done: parser.\nIn flight: tests.")
        #expect(a.hasPrefix("## Goal\n\n## Decisions\n\n## State\n\nDone: parser."))
        let b = Notes.apply(a, section: "State", mode: .replace, content: "Done: everything.")
        #expect(Notes.body(of: b, section: "State") == "Done: everything.")
        #expect(Notes.body(of: b, section: "Goal") == "")
        #expect(!Notes.isEmpty(b))
    }

    @Test func `append adds a paragraph under the heading and keeps the rest`() {
        let a = Notes.apply(Notes.empty(), section: "Decisions", content: "- Use SQLite.")
        let b = Notes.apply(a, section: "decisions", mode: .append, content: "- One file per thread.")
        #expect(Notes.body(of: b, section: "Decisions") == "- Use SQLite.\n\n- One file per thread.")
        #expect(Notes.body(of: b, section: "State") == "")
    }

    @Test func `a heading the thread invented survives after the fixed ones, a preamble stays first`() {
        let text = "Scratch line.\n\n## Risks\n\n- flaky test\n\n## Goal\n\nShip notes.\n"
        let out = Notes.apply(text, section: "Pointers", content: "src/x.ts")
        #expect(Notes.parse(out).preamble == "Scratch line.")
        #expect(Notes.parse(out).sections.map(\.heading) == ["Goal", "Decisions", "State", "Pointers", "Open questions", "Risks"])
        #expect(Notes.body(of: out, section: "Risks") == "- flaky test")
    }

    @Test func `duplicate headings merge and CRLF input normalizes`() {
        let out = Notes.apply("## State\r\n\r\none\r\n\r\n## State\r\n\r\ntwo\r\n", section: "Goal", content: "g")
        #expect(Notes.body(of: out, section: "State") == "one\n\ntwo")
        #expect(!out.contains("\r"))
    }

    @Test func `the State line is the first non-empty line without its list marker`() {
        #expect(Notes.stateLine(Notes.empty()) == nil)
        let t = Notes.apply("", section: "State", content: "\n- [ ] **Blocked**: waiting on the API key\n- next")
        #expect(Notes.stateLine(t) == "Blocked: waiting on the API key")
        #expect(Notes.stateLine(Notes.apply("", section: "State", content: "1. tests red")) == "tests red")
        #expect(Notes.stateLine(Notes.apply("", section: "State", content: "* [x] shipped")) == "shipped")
        #expect(Notes.stateLine(Notes.apply("", section: "State", content: "**Done** all of it")) == "Done: all of it")
        #expect(Notes.stateLine(Notes.apply("", section: "State", content: "plain line\nsecond")) == "plain line")
    }

    @Test func `compact notes drop empty headings and keep the preamble`() {
        let t = Notes.apply("Scratch.\n\n## State\n\n- half", section: "Pointers", content: "src/a.ts")
        #expect(Notes.compact(t) == "Scratch.\n\n## State\n\n- half\n\n## Pointers\n\nsrc/a.ts")
        #expect(Notes.compact(Notes.empty()) == "")
    }

    @Test func `headings demote for embedding and the brief names the thread`() {
        let t = Notes.apply(Notes.apply("", section: "Goal", content: "Ship it."), section: "Open questions", content: "- Which port?")
        #expect(Notes.demoteHeadings(t).contains("### Goal\n\nShip it."))
        #expect(!Notes.demoteHeadings(t).components(separatedBy: "\n").contains { $0.hasPrefix("## ") })
        let brief = Notes.brief(t, title: "Notes feature")
        #expect(brief.hasPrefix("Continue the work of thread \"Notes feature\"."))
        #expect(brief.contains("**Goal**\n\nShip it."))
        #expect(brief.contains("**Open questions**\n\n- Which port?"))
        #expect(!brief.contains("**Decisions**"))
        #expect(brief.hasSuffix("the Pointers name the files and commands that matter."))
    }

    @Test func `display is the five fixed sections in order, then the extras`() {
        let blank = Notes.display("")
        #expect(blank.preamble == "")
        #expect(blank.sections.map(\.heading) == Notes.sections)
        #expect(blank.sections.allSatisfy { $0.body.isEmpty })
        let some = Notes.display("## State\n\n- half\n\n## Risks\n\n- none\n\n## Goal\n\nShip.\n")
        #expect(some.sections.map(\.heading) == ["Goal", "Decisions", "State", "Pointers", "Open questions", "Risks"])
        #expect(some.sections[0].body == "Ship.")
        #expect(some.sections[2].body == "- half")
        #expect(some.sections[5].body == "- none")
    }

    @Test func `unread is a change after this device last read`() {
        #expect(!Notes.unread(updatedAt: nil, readAt: nil))
        #expect(Notes.unread(updatedAt: 5, readAt: nil))
        #expect(!Notes.unread(updatedAt: 5, readAt: 5))
        #expect(Notes.unread(updatedAt: 6, readAt: 5))
    }

    @Test func `the needs-you line is the State line of a waiting thread only`() {
        let t = Notes.apply("", section: "State", content: "- Blocked: `bun test` needs your approval")
        #expect(Notes.needsYouLine(waiting: true, text: t) == "Blocked: `bun test` needs your approval")
        #expect(Notes.needsYouLine(waiting: true, text: Notes.empty()) == nil)
        #expect(Notes.needsYouLine(waiting: true, text: nil) == nil)
        #expect(Notes.needsYouLine(waiting: false, text: t) == nil)
    }
}
