@testable import AXText
import Testing

/// §27.4: the call's record of what its steps opened.
@Suite struct CallRecordTests {
    @Test func eachEntryKeepsTheStepItCameDuring() {
        var r = CallRecord<Int>()
        r.begin()
        let before = r.note(.menu, 1, same: ==)
        #expect(!before)
        r.record(step: 0)
        r.note(.menu, 7, same: ==)
        r.record(step: 2)
        r.note(.window, 9, same: ==)
        r.note(.menu, 7, same: ==)
        #expect(r.entries.map(\.step) == [0, 2])
        #expect(r.entries.map(\.kind) == [.menu, .window])
        r.end()
        let after = r.note(.sheet, 11, same: ==)
        #expect(!after)
        r.begin()
        #expect(r.entries.isEmpty)
    }

    @Test func itHoldsAtMostThirtyTwo() {
        var r = CallRecord<Int>()
        r.begin()
        r.record(step: 0)
        for e in 0..<40 { r.note(.menu, e, same: ==) }
        #expect(r.entries.count == CallRecord<Int>.max)
    }
}
