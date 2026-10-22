import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct DiffDocumentTests {
    private func wire(_ number: Double?, _ kind: ToolPreview.Line.Kind, _ text: String) -> ToolPreview.Line {
        ToolPreview.Line(number: number, kind: kind, text: text)
    }

    // MARK: - hunks from an edit's lines

    @Test func `a jump on the new side starts a hunk`() {
        let document = DiffDocument.from(edits: [[
            wire(1, .context, "a"), wire(2, .add, "b"), wire(3, .context, "c"),
            wire(10, .context, "j"), wire(11, .add, "k")
        ]])
        #expect(document.hunks.map { $0.lines.map(\.newNo) } == [[1, 2, 3], [10, 11]])
        #expect(document.hunks.map(\.id) == [0, 1])
    }

    @Test func `a step back on the new side starts a hunk`() {
        let document = DiffDocument.from(edits: [[
            wire(5, .context, "e"), wire(6, .add, "f"), wire(3, .context, "c")
        ]])
        #expect(document.hunks.map { $0.lines.map(\.newNo) } == [[5, 6], [3]])
    }

    @Test func `each edit starts a hunk even when its numbers continue`() {
        let document = DiffDocument.from(edits: [
            [wire(1, .add, "a"), wire(2, .add, "b")],
            [wire(3, .add, "c")]
        ])
        #expect(document.hunks.count == 2)
        #expect(document.hunks[1].lines.map(\.newNo) == [3])
    }

    @Test func `a replacement's deletes stay with its adds across a boundary`() {
        let across = DiffDocument.from(edits: [[
            wire(1, .context, "a"), wire(2, .del, "old"), wire(10, .add, "new")
        ]])
        #expect(across.hunks.map { $0.lines.map(\.kind) } == [[.context], [.del, .add]])
        #expect(across.hunks[1].lines[0].oldNo == 2)

        let within = DiffDocument.from(edits: [[
            wire(1, .context, "a"), wire(2, .del, "old"), wire(2, .add, "new")
        ]])
        #expect(within.hunks.map { $0.lines.map(\.kind) } == [[.context, .del, .add]])

        let trailing = DiffDocument.from(edits: [[wire(1, .context, "a"), wire(2, .del, "old")]])
        #expect(trailing.hunks.map { $0.lines.map(\.kind) } == [[.context, .del]])
    }

    @Test func `a line of an unknown kind draws as context`() {
        let document = DiffDocument.from(edits: [[wire(4, .unknown("weird"), "x")]])
        #expect(document.hunks[0].lines[0].kind == .context)
        #expect(document.hunks[0].lines[0].newNo == 4)
        #expect(document.adds == 0)
    }

    @Test func `a tab becomes four spaces`() {
        let document = DiffDocument.from(edits: [[wire(1, .add, "\tif x {\n")]])
        #expect(document.hunks[0].lines[0].text == "    if x {\n")
        #expect(DiffDocument.tidy("no tabs") == "no tabs")
    }

    @Test func `the wire's Double becomes an exact Int and a fraction is nil`() {
        let document = DiffDocument.from(edits: [[
            wire(12, .context, "a"), wire(12.5, .add, "b"), wire(nil, .add, "c"), wire(13, .context, "d")
        ]])
        let lines = document.hunks[0].lines
        #expect(lines.map(\.newNo) == [12, nil, nil, 13])
        #expect(document.hunks.count == 1)
    }

    @Test func `counts adds, dels, lines and the gutter's digits`() {
        let document = DiffDocument.from(edits: [[
            wire(5, .del, "x"), wire(998, .add, "a"), wire(999, .add, "b"), wire(1000, .add, "c")
        ]])
        #expect(document.adds == 3)
        #expect(document.dels == 1)
        #expect(document.lineCount == 4)
        #expect(document.digits == 4)
        #expect(DiffDocument.from(edits: [[wire(7, .add, "a")]]).digits == 2)
        #expect(DiffDocument(hunks: []).digits == 2)
        #expect(DiffDocument(hunks: []).isEmpty)
    }

    @Test func `the gutter number is the old side of a delete and the new side otherwise`() {
        let del = DiffLine(id: 0, kind: .del, oldNo: 3, newNo: nil, text: "")
        let add = DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 9, text: "")
        let context = DiffLine(id: 2, kind: .context, oldNo: 4, newNo: 9, text: "")
        #expect(del.number == 3)
        #expect(add.number == 9)
        #expect(context.number == 9)
    }

    @Test func `widestChars counts a non-ASCII scalar as two columns`() {
        let document = DiffDocument.from(edits: [[wire(1, .add, "abc"), wire(2, .add, "éé")]])
        #expect(document.hunks[0].widestChars == 4)
        #expect(DiffDocument(hunks: [DiffHunk(id: 0, file: nil, lines: [])]).hunks[0].widestChars == 0)
    }

    @Test func `range wording for new, single, removed and removed-single`() {
        #expect(DiffDocument.from(edits: [[wire(12, .context, "a"), wire(13, .add, "b"), wire(40, .context, "c")]]).hunks.map(\.range) == ["Lines 12–13", "Line 40"])
        #expect(DiffDocument.from(edits: [[wire(3, .del, "a"), wire(4, .del, "b"), wire(5, .del, "c")]]).hunks[0].range == "Lines 3–5 removed")
        #expect(DiffDocument.from(edits: [[wire(3, .del, "a")]]).hunks[0].range == "Line 3 removed")
        #expect(DiffDocument.from(edits: [[wire(nil, .add, "a")]]).hunks[0].range == "Lines")
    }

    @Test func `unified writes the signs back`() {
        let document = DiffDocument.from(edits: [[wire(1, .context, "c"), wire(2, .del, "b"), wire(2, .add, "a")]])
        #expect(document.hunks[0].unified == " c\n-b\n+a")
        #expect(document.hunks[0].accessibilityLabel == "Lines 1–2, 1 added, 1 removed")
    }

    // MARK: - hunks from a unified patch

    private let twoFiles = """
    diff --git a/src/a.ts b/src/a.ts
    index 1111111..2222222 100644
    --- a/src/a.ts
    +++ b/src/a.ts
    @@ -1,3 +1,4 @@
     one
    +two
     three
     four
    diff --git a/src/b.ts b/src/b.ts
    --- a/src/b.ts
    +++ b/src/b.ts
    @@ -10,2 +10,1 @@
     keep
    -gone
    """

    @Test func `a patch of two files parses with each hunk's file`() {
        let document = DiffDocument.from(patch: twoFiles)
        #expect(document.hunks.map(\.file) == ["src/a.ts", "src/b.ts"])
        #expect(document.multiFile)
        #expect(document.hunks[0].lines.map(\.kind) == [.context, .add, .context, .context])
        #expect(document.hunks[0].lines.map(\.oldNo) == [1, nil, 2, 3])
        #expect(document.hunks[0].lines.map(\.newNo) == [1, 2, 3, 4])
        #expect(document.hunks[1].lines.map(\.kind) == [.context, .del])
        #expect(document.hunks[1].lines.map(\.oldNo) == [10, 11])
        #expect(document.hunks[1].range == "Line 10")
        #expect(document.adds == 1)
        #expect(document.dels == 1)
        #expect(document.hunks[1].accessibilityLabel == "b.ts, Line 10, 1 removed")
    }

    @Test func `the header's counts are spent so a +++ line inside a hunk is content`() {
        let document = DiffDocument.from(patch: """
        @@ -1,2 +1,3 @@
         a
        +++ marker
         c
        """)
        #expect(document.hunks.count == 1)
        #expect(document.hunks[0].file == nil)
        #expect(document.hunks[0].lines.map(\.kind) == [.context, .add, .context])
        #expect(document.hunks[0].lines[1].text == "++ marker")
    }

    @Test func `a header without counts means one line each side and the hunk ends there`() {
        let document = DiffDocument.from(patch: """
        @@ -3 +3 @@
        -old
        +new
         not a row: the hunk is spent
        """)
        #expect(document.hunks[0].lines.map(\.kind) == [.del, .add])
        #expect(document.hunks[0].lines.map(\.oldNo) == [3, nil])
        #expect(document.hunks[0].lines.map(\.newNo) == [nil, 3])
        #expect(document.lineCount == 2)
    }

    @Test func `a no-newline marker is skipped`() {
        let document = DiffDocument.from(patch: """
        @@ -1 +1 @@
        -a
        \\ No newline at end of file
        +b
        \\ No newline at end of file
        """)
        #expect(document.hunks[0].lines.map(\.text) == ["a", "b"])
    }

    @Test func `a trailing newline adds no row`() {
        let document = DiffDocument.from(patch: "@@ -1 +1 @@\n-a\n+b\n")
        #expect(document.lineCount == 2)
    }

    @Test func `a truncated patch closes at the next header`() {
        let document = DiffDocument.from(patch: """
        @@ -1,5 +1,5 @@
         a
         b
        @@ -20,2 +20,2 @@
         c
         d
        diff --git a/x b/x
        """)
        #expect(document.hunks.map { $0.lines.map(\.text) } == [["a", "b"], ["c", "d"]])
        #expect(document.hunks[1].lines.map(\.newNo) == [20, 21])
    }

    @Test func `one file of a many-file patch keeps that file's hunks without a file of their own`() {
        let one = DiffDocument.from(patch: twoFiles, file: "src/b.ts")
        #expect(one.hunks.count == 1)
        #expect(one.hunks[0].file == nil)
        #expect(one.hunks[0].id == 0)
        #expect(one.hunks[0].lines.map(\.text) == ["keep", "gone"])
        #expect(!one.multiFile)
        #expect(one.adds == 0)
        #expect(one.dels == 1)
        #expect(DiffDocument.from(patch: twoFiles, file: "src/zzz.ts").isEmpty)
    }

    @Test func `a patch with headers and no hunk is empty`() {
        #expect(DiffDocument.from(patch: "diff --git a/x.bin b/x.bin\nBinary files differ\n").isEmpty)
        #expect(DiffDocument.from(patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n").isEmpty)
        #expect(DiffDocument.from(patch: "").isEmpty)
    }

    // MARK: - the column's geometry

    private let layout = DiffLayout(rowHeight: 20, headerHeight: 30)

    private var twoHunks: DiffDocument {
        DiffDocument.from(edits: [
            [wire(1, .add, "a"), wire(2, .add, "b")],
            [wire(1, .add, "c"), wire(2, .add, "d"), wire(3, .add, "e")]
        ])
    }

    @Test func `hunkStarts accumulates each header and its rows`() {
        let starts = layout.hunkStarts(twoHunks)
        #expect(starts == [0, 70])
        #expect(layout.height(twoHunks) == 160)
        #expect(layout.height(twoHunks.hunks[1]) == 90)
        #expect(layout.hunkStarts(DiffDocument(hunks: [])) == [])
    }

    @Test func `hunkIndex at the top, at a boundary, past the end and on an empty document`() {
        let starts = layout.hunkStarts(twoHunks)
        #expect(layout.hunkIndex(at: 0, starts: starts) == 0)
        #expect(layout.hunkIndex(at: -40, starts: starts) == 0)
        #expect(layout.hunkIndex(at: 68, starts: starts) == 0)
        #expect(layout.hunkIndex(at: 69, starts: starts) == 1)
        #expect(layout.hunkIndex(at: 70, starts: starts) == 1)
        #expect(layout.hunkIndex(at: 10_000, starts: starts) == 1)
        #expect(layout.hunkIndex(at: 50, starts: []) == 0)
    }
}
