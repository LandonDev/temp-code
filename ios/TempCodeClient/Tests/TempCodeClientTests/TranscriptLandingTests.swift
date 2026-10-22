import Testing
@testable import TempCodeClient

@Suite struct TranscriptLandingTests {
    @Test func `a thread opens at the bottom unless the launch or tap named a row`() {
        #expect(TranscriptLanding.onOpen(targetSeq: nil, restoredAtLaunch: false) == .bottom)
        #expect(TranscriptLanding.onOpen(targetSeq: 812, restoredAtLaunch: false) == .row(812), "a search hit or a notification lands on its row")
        #expect(TranscriptLanding.onOpen(targetSeq: 812, restoredAtLaunch: false).seq == 812)
        #expect(TranscriptLanding.bottom.seq == nil)
    }

    @Test func `a cold launch that restores a pushed thread lands at the bottom, even when its route named a row`() {
        #expect(TranscriptLanding.onOpen(targetSeq: 812, restoredAtLaunch: true) == .bottom)
        #expect(TranscriptLanding.onOpen(targetSeq: nil, restoredAtLaunch: true) == .bottom)
    }

    @Test func `leaving the app scrolled up snaps the transcript to the bottom, so the return shows the latest`() {
        #expect(TranscriptLanding.snapsToBottom(enteringBackground: true, atBottom: false))
        #expect(!TranscriptLanding.snapsToBottom(enteringBackground: true, atBottom: true), "already at the bottom: nothing moves")
        #expect(!TranscriptLanding.snapsToBottom(enteringBackground: false, atBottom: false), "within a session the reader keeps their place and the Jump pill")
    }
}
