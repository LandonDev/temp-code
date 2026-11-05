import Testing
@testable import TempCodeClient

@Suite struct RowInitLedgerTests {
    @Test func aRowMadeOnceAndShownIsClean() {
        var ledger = RowInitLedger()
        ledger.inited("4", at: 0)
        ledger.appeared("4")
        #expect(ledger.rows["4"] == RowInitLedger.Count(inits: 1, appears: 1, disappears: 0))
        #expect(ledger.violations.isEmpty)
    }

    @Test func aRowMadeAgainAfterScrollingOffIsClean() {
        var ledger = RowInitLedger()
        ledger.inited("4", at: 0)
        ledger.appeared("4")
        ledger.disappeared("4")
        ledger.inited("4", at: 10)
        ledger.appeared("4")
        #expect(ledger.violations.isEmpty)
        #expect(ledger.inits == 2)
    }

    @Test func aRowMadeAgainWhileOnScreenIsAViolation() {
        var ledger = RowInitLedger()
        ledger.inited("7", at: 0)
        ledger.appeared("7")
        // The new instance is made and appears before the old one's disappear lands.
        ledger.inited("7", at: 120)
        ledger.appeared("7")
        ledger.disappeared("7")
        #expect(ledger.violations == [RowInitLedger.Violation(key: "7", at: 120, inits: 2)])
    }

    @Test func aRowMadeBeforeItAppearsIsClean() {
        // A list may make a row's state ahead of its appearance (prefetch).
        var ledger = RowInitLedger()
        ledger.inited("9", at: 0)
        ledger.inited("9", at: 5)
        ledger.appeared("9")
        #expect(ledger.violations.isEmpty)
    }

    @Test func theEndRowHasItsOwnKey() {
        #expect(RowInitLedger.key(TranscriptRowID(key: 12)) == "12")
        #expect(RowInitLedger.key(TranscriptRowID(key: 12, end: true)) == "12e")
    }
}
