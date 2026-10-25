import CoreGraphics
import Foundation
import Testing
@testable import TempCodeClient

@Suite struct ThreadPoseModeTests {
    @Test("the four Duo poses and the shell's columns", arguments: [
        // Folded portrait and folded landscape: compact width, the pager whatever the width.
        (466.0, false, ThreadLayoutMode.pager),
        (678.0, false, .pager),
        // Unfolded: regular width; the whole window or the column beside the sidebar.
        (951.0, true, .twoPane),
        (669.0, true, .twoPane),
        (631.0, true, .twoPane),
        // Unfolded portrait with the sidebar shown leaves about 350: the pager.
        (350.0, true, .pager),
        (599.0, true, .pager),
        (600.0, true, .twoPane)
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
        let beside = ThreadPose.columns(width: 631, hairline: hairline, division: nil)
        #expect(beside.hero == 315)
        #expect(beside.hero + beside.gap + beside.chat == 631)
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
    @Test("the side inset is the edge until the column passes the cap, then centres it") func theSideInsetIsTheEdgeUntilTheColumnPassesTheCap() {
        #expect(ReadingMeasure.sideInset(width: 466) == 16)
        #expect(ReadingMeasure.sideInset(width: 669) == 16, "669 − 640 leaves less than an edge each side")
        #expect(ReadingMeasure.sideInset(width: 951) == 155.5)
        #expect(ReadingMeasure.cap == 640)
    }

    @Test("the dock is the screen's width, or the cap plus its edges") func theDockIsTheScreenSWidthOrTheCapPlusItsEdges() {
        #expect(ReadingMeasure.dockWidth(width: 466) == 466)
        #expect(ReadingMeasure.dockWidth(width: 669) == 669)
        #expect(ReadingMeasure.dockWidth(width: 951) == 672)
    }
}

@Suite struct TranscriptReflowTests {
    @Test("the anchor is the end at the bottom, the top row otherwise, nil with neither") func theAnchorIsTheEndAtTheBottomTheTopRowOtherwise() {
        let row = TranscriptRowID(kind: .item, seq: 40)
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
