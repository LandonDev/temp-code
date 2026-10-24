import Foundation
import Testing
@testable import TempCodeClient

private let fp = WindowClasses(horizontal: .compact, vertical: .regular)
private let fl = WindowClasses(horizontal: .compact, vertical: .compact)
private let ul = WindowClasses(horizontal: .regular, vertical: .regular)

/// One row per cell of the plan's sheet table: kind × pose → detents and sizing.
struct Cell: CustomTestStringConvertible {
    let kind: SheetKind
    let window: WindowClasses
    let detents: [SheetDetent]
    let sizing: SheetSizing

    var testDescription: String { "\(kind) in \(window.horizontal)×\(window.vertical)" }
}

let table: [Cell] = [
    Cell(kind: .form, window: fp, detents: [.medium, .large], sizing: .automatic),
    Cell(kind: .form, window: fl, detents: [.large], sizing: .automatic),
    Cell(kind: .form, window: ul, detents: [.large], sizing: .form),
    Cell(kind: .editor, window: fp, detents: [.large], sizing: .automatic),
    Cell(kind: .editor, window: fl, detents: [.large], sizing: .automatic),
    Cell(kind: .editor, window: ul, detents: [.large], sizing: .form),
    Cell(kind: .picker, window: fp, detents: [.medium, .large], sizing: .automatic),
    Cell(kind: .picker, window: fl, detents: [.large], sizing: .automatic),
    Cell(kind: .picker, window: ul, detents: [.large], sizing: .form),
    Cell(kind: .field, window: fp, detents: [.medium], sizing: .automatic),
    Cell(kind: .field, window: fl, detents: [.large], sizing: .automatic),
    Cell(kind: .field, window: ul, detents: [.large], sizing: .form),
    Cell(kind: .confirm, window: fp, detents: [.fitted], sizing: .automatic),
    Cell(kind: .confirm, window: fl, detents: [.fitted], sizing: .automatic),
    Cell(kind: .confirm, window: ul, detents: [.fitted], sizing: .formFitted),
    Cell(kind: .document, window: fp, detents: [.large], sizing: .automatic),
    Cell(kind: .document, window: fl, detents: [.large], sizing: .automatic),
    Cell(kind: .document, window: ul, detents: [.large], sizing: .page),
]

@Suite struct SheetRulesTests {
    @Test(arguments: table) func `each cell of the table`(cell: Cell) {
        let shape = SheetRules.shape(cell.kind, in: cell.window)
        #expect(shape.detents == cell.detents)
        #expect(shape.sizing == cell.sizing)
    }

    @Test func `the table covers every kind in every pose`() {
        for kind in SheetKind.allCases {
            for window in [fp, fl, ul] {
                #expect(table.contains { $0.kind == kind && $0.window == window }, "\(kind) \(window)")
            }
        }
    }

    @Test(arguments: SheetKind.allCases, [fp, fl, ul]) func `every sheet opts into horizontal bars`(kind: SheetKind, window: WindowClasses) {
        #expect(SheetRules.shape(kind, in: window).horizontalBars)
    }

    @Test(arguments: SheetKind.allCases, [fp, fl, ul]) func `the drag indicator shows only with two detents`(kind: SheetKind, window: WindowClasses) {
        let shape = SheetRules.shape(kind, in: window)
        #expect(shape.dragIndicator == (shape.detents.count == 2))
    }

    /// The sheets that offer medium on today's phone, by name: the four forms
    /// (Start a build, New thread, Add a Host, Milestone start) and the three
    /// pickers (Resources, Account, Adopt threads). Project settings, Rules and
    /// Add a thread are editors and stay large.
    @Test func `the sheets that offer medium in folded portrait`() {
        let medium: [(String, SheetKind)] = [
            ("Start a build", .form), ("New thread", .form), ("Add a Host", .form), ("Milestone start", .form),
            ("Resources", .picker), ("Account", .picker), ("Adopt threads", .picker),
        ]
        for (name, kind) in medium {
            #expect(SheetRules.shape(kind, in: fp).detents == [.medium, .large], "\(name)")
        }
        for (name, kind) in [("Project settings", SheetKind.editor), ("Rules", .editor), ("Add a thread", .editor)] {
            #expect(SheetRules.shape(kind, in: fp).detents == [.large], "\(name)")
        }
    }

    /// Unfolded portrait is the same pair of classes as unfolded landscape.
    @Test func `the unfolded poses read the same`() {
        for kind in SheetKind.allCases {
            #expect(SheetRules.shape(kind, in: ul) == SheetRules.shape(kind, in: WindowClasses(horizontal: .regular, vertical: .regular)))
        }
    }
}

@Suite struct InboxColumnsTests {
    @Test(arguments: [[], ["item"], ["item", "diff-a", "diff-b"]]) func `the path round trips through the columns`(path: [String]) {
        let split = InboxColumns.split(path)
        #expect(InboxColumns.path(selected: split.selected, detail: split.detail) == path)
    }

    @Test func `the first element is the selection and the rest the detail`() {
        let split = InboxColumns.split(["item", "diff"])
        #expect(split.selected == "item")
        #expect(split.detail == ["diff"])
        #expect(InboxColumns.split([String]()).selected == nil)
    }

    @Test func `nothing is pushed under no selection`() {
        #expect(InboxColumns.path(selected: nil, detail: ["diff"]) == [])
    }

    @Test func `a new selection clears the detail`() {
        let before = ["item", "diff"]
        let after = InboxColumns.path(selected: "other", detail: [])
        #expect(after == ["other"])
        #expect(InboxColumns.split(before).detail == ["diff"])
    }

    @Test func `the split needs a regular window and a regular column`() {
        #expect(InboxColumns.usesSplit(ul, screen: .regular))
        #expect(!InboxColumns.usesSplit(ul, screen: .compact))
        #expect(!InboxColumns.usesSplit(fp, screen: .regular))
        #expect(!InboxColumns.usesSplit(fl, screen: .compact))
        #expect(!InboxColumns.usesSplit(WindowClasses(horizontal: .regular, vertical: .compact), screen: .regular))
    }
}

@Suite struct ToastMeasureTests {
    @Test func `full width to 440 then capped`() {
        #expect(ToastMeasure.width(available: 320) == 320)
        #expect(ToastMeasure.width(available: 440) == 440)
        #expect(ToastMeasure.width(available: 951) == 440)
        #expect(ToastMeasure.maxWidth == 440)
    }
}
