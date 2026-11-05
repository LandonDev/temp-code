import CoreGraphics
import Foundation
import Testing
@testable import TempCodeClient

@Suite struct ThreadPoseModeTests {
    @Test("the four Duo poses and the shell's columns", arguments: [
        // Folded portrait and folded landscape: compact width, the pager whatever the width.
        (466.0, false, ThreadLayoutMode.pager),
        (678.0, false, .pager),
        // Unfolded: regular width; the whole window or the column beside the 260 pt sidebar.
        (951.0, true, .twoPane),
        (690.0, true, .twoPane),
        // Two panes only when the hero gets 320 and the chat 360: the 680 boundary.
        (680.0, true, .twoPane),
        (679.0, true, .pager),
        (631.0, true, .pager),
        (350.0, true, .pager)
    ])
    func theFourDuoPosesAndTheShellSColumns(width: Double, regular: Bool, mode: ThreadLayoutMode) {
        #expect(ThreadPose.mode(segments: 2, regularWidth: regular, width: CGFloat(width)) == mode)
    }

    @Test("one segment is single at any width") func oneSegmentIsSingleAtAnyWidth() {
        for width: CGFloat in [320, 466, 678, 951] {
            #expect(ThreadPose.mode(segments: 1, regularWidth: true, width: width) == .single)
            #expect(ThreadPose.mode(segments: 1, regularWidth: false, width: width) == .single)
        }
        #expect(ThreadPose.mode(segments: 0, regularWidth: true, width: 951) == .single)
    }

    @Test("the segment bar shows only in the pager, and leaves in compact height while the composer has focus") func theSegmentBarShowsOnlyInThePager() {
        for compact in [false, true] {
            for focused in [false, true] {
                #expect(!ThreadPose.segmentBarShown(mode: .single, compactHeight: compact, composerFocused: focused))
                #expect(!ThreadPose.segmentBarShown(mode: .twoPane, compactHeight: compact, composerFocused: focused))
            }
        }
        #expect(ThreadPose.segmentBarShown(mode: .pager, compactHeight: false, composerFocused: false))
        #expect(ThreadPose.segmentBarShown(mode: .pager, compactHeight: false, composerFocused: true), "a tall screen keeps the bar with the keyboard up")
        #expect(ThreadPose.segmentBarShown(mode: .pager, compactHeight: true, composerFocused: false))
        #expect(!ThreadPose.segmentBarShown(mode: .pager, compactHeight: true, composerFocused: true))
    }
}

@Suite struct TwoPaneColumnsTests {
    private let hairline: CGFloat = 1 / 3

    @Test("equal halves around the hairline by default") func equalHalvesAroundTheHairlineByDefault() {
        let wide = ThreadPose.columns(width: 951, hairline: hairline, division: nil)
        #expect(wide.hero == 475)
        #expect(wide.gap == hairline)
        #expect(wide.hero + wide.gap + wide.chat == 951)
        #expect(!wide.gapIsDivision)
        // Beside the 260 pt sidebar the chat keeps its 360 and the hero yields.
        let beside = ThreadPose.columns(width: 690, hairline: hairline, division: nil)
        #expect(beside.hero == 329)
        #expect(beside.hero + beside.gap + beside.chat == 690)
    }

    @Test("a vertical band inside the minimum on both sides is the gap, and nothing is drawn in it") func aVerticalBandInsideTheMinimumOnBothSidesIsTheGap() {
        let band = CGRect(x: 470, y: 0, width: 12, height: 669)
        let columns = ThreadPose.columns(width: 951, hairline: hairline, division: band)
        #expect(columns == TwoPaneColumns(hero: 470, gap: 12, chat: 951 - 482, gapIsDivision: true))
    }

    @Test("a band too close to an edge is ignored") func aBandTooCloseToAnEdgeIsIgnored() {
        let near = CGRect(x: 100, y: 0, width: 12, height: 669)
        #expect(ThreadPose.columns(width: 951, hairline: hairline, division: near) == ThreadPose.columns(width: 951, hairline: hairline, division: nil))
        let far = CGRect(x: 800, y: 0, width: 12, height: 669)
        #expect(ThreadPose.columns(width: 951, hairline: hairline, division: far) == ThreadPose.columns(width: 951, hairline: hairline, division: nil))
        // Exactly the minimum on both sides counts.
        let edge = CGRect(x: 280, y: 0, width: 10, height: 669)
        #expect(ThreadPose.columns(width: 570, hairline: hairline, division: edge).gapIsDivision)
    }

    @Test("a horizontal band (unfolded portrait partly open) changes no column") func aHorizontalBandChangesNoColumn() {
        let band = CGRect(x: 0, y: 470, width: 669, height: 12)
        #expect(ThreadPose.columns(width: 669, hairline: hairline, division: band) == ThreadPose.columns(width: 669, hairline: hairline, division: nil))
    }
}

@Suite struct ReadingMeasureTests {
    @Test("by kind: the plan page at 640, the chat and the log at 768") func byKind() {
        #expect(ReadingMeasure.cap(for: .plan) == 640)
        #expect(ReadingMeasure.cap(for: .chat) == 768)
        #expect(ReadingMeasure.cap(for: .log) == 768)
        #expect(ReadingMeasure.columnFrame(width: 951 - 260, cap: ReadingMeasure.cap(for: .chat)) == 691)
        #expect(ReadingMeasure.columnFrame(width: 1200, cap: ReadingMeasure.cap(for: .plan)) == 672)
    }

    @Test("a transcript reads at 768, a document at 640, centred past the column") func aTranscriptReadsAt768ADocumentAt640() {
        #expect(ReadingMeasure.cap == 768)
        #expect(ReadingMeasure.documentCap == 640)
        #expect(ReadingMeasure.sideInset(width: 466) == 16)
        #expect(ReadingMeasure.sideInset(width: 690) == 16)
        #expect(ReadingMeasure.sideInset(width: 951) == 91.5)
        #expect(ReadingMeasure.sideInset(width: 951, cap: ReadingMeasure.documentCap) == 155.5)
    }

    @Test("the composer's box takes the column and its edges, flush with the text") func theComposerSBoxTakesTheColumn() {
        #expect(ReadingMeasure.columnFrame(width: 466) == 466)
        #expect(ReadingMeasure.columnFrame(width: 690) == 690)
        #expect(ReadingMeasure.columnFrame(width: 951) == 800)
        // The box's edge sits on the text's: the frame's inset is the side inset.
        let width: CGFloat = 951
        #expect((width - ReadingMeasure.columnFrame(width: width)) / 2 + ReadingMeasure.edge == ReadingMeasure.sideInset(width: width))
    }
}

@Suite struct TwoPaneSplitTests {
    private let hairline: CGFloat = 1 / 3

    @Test("the chat keeps 360 and the hero yields first") func theChatKeeps360() {
        let narrow = ThreadPose.columns(width: 690, hairline: hairline, division: nil)
        #expect(narrow.chat >= 360)
        #expect(narrow.hero == 329)
        #expect(narrow.hero + narrow.gap + narrow.chat == 690)
    }

    @Test("a board fits its widest task within 320, half the body and 672") func aBoardFitsItsWidestTask() {
        #expect(ThreadPose.columns(width: 951, hairline: hairline, division: nil, fit: 200).hero == 320)
        #expect(ThreadPose.columns(width: 951, hairline: hairline, division: nil, fit: 400).hero == 400)
        #expect(ThreadPose.columns(width: 951, hairline: hairline, division: nil, fit: 900).hero == 475)
        #expect(ThreadPose.columns(width: 1_600, hairline: hairline, division: nil, fit: 900).hero == 672)
        #expect(ThreadPose.columns(width: 690, hairline: hairline, division: nil, fit: 900).chat >= 360)
    }

    @Test("the fit grows with the longest label and is nil with none") func theFitGrowsWithTheLongestLabel() {
        #expect(ThreadPose.boardFit(labels: []) == nil)
        let short = ThreadPose.boardFit(labels: ["Run tests"])!
        let long = ThreadPose.boardFit(labels: ["Run tests", "Add the dark palette to Theme.ts and the settings screen"])!
        #expect(long > short)
    }

    @Test("a vertical band still sets the gap when both sides keep 280") func aVerticalBandStillSetsTheGap() {
        let band = CGRect(x: 470, y: 0, width: 12, height: 900)
        let columns = ThreadPose.columns(width: 951, hairline: hairline, division: band, fit: 600)
        #expect(columns.gapIsDivision)
        #expect(columns.hero == 470)
    }
}

@Suite struct TranscriptReflowTests {
    @Test("the anchor is the end at the bottom, the top row otherwise, nil with neither") func theAnchorIsTheEndAtTheBottomTheTopRowOtherwise() {
        let row = TranscriptRowID(key: 40)
        #expect(TranscriptReflow.anchor(atBottom: true, topRow: row) == .end)
        #expect(TranscriptReflow.anchor(atBottom: true, topRow: nil) == .end)
        #expect(TranscriptReflow.anchor(atBottom: false, topRow: row) == .row(row))
        #expect(TranscriptReflow.anchor(atBottom: false, topRow: nil) == nil)
    }

    @Test("a width change is more than a point") func aWidthChangeIsMoreThanAPoint() {
        #expect(!TranscriptReflow.widthChanged(466, 467))
        #expect(!TranscriptReflow.widthChanged(466, 466.5))
        #expect(TranscriptReflow.widthChanged(466, 468))
        #expect(TranscriptReflow.widthChanged(951, 466))
    }

    @Test("the restore runs at once, then twice more past the fold's steps") func theRestoreRunsAtOnceThenTwiceMore() {
        #expect(TranscriptReflow.restoreDelaysMs == [0, 250, 600])
    }
}
