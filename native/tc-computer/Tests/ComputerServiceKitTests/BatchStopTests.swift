import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

/// src/main/server/computer/fixtures/batch-stop.json, read in place: the same table batchStop.test.ts holds the host to.
enum BatchStopTable {
    struct Case: Decodable, Sendable, CustomTestStringConvertible {
        var name: String
        var lastEffect: StepEffect?
        var action: ComputerAction
        var stops: Bool
        var testDescription: String { name }
    }

    static let file = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("src/main/server/computer/fixtures/batch-stop.json")

    static func cases() -> [Case] {
        struct Table: Decodable { var cases: [Case] }
        return (try? JSONDecoder().decode(Table.self, from: Data(contentsOf: file)).cases) ?? []
    }
}

@Suite struct BatchStopTests {
    @Test func theTableIsThere() {
        #expect(BatchStopTable.cases().count >= 10)
    }

    @Test(arguments: BatchStopTable.cases())
    func eachCaseStopsAsTheHostsDoes(_ c: BatchStopTable.Case) {
        #expect(BatchStop.stopsHere(lastEffect: c.lastEffect, c.action) == c.stops)
    }

    @Test func aRequestStopsAfterAClickThatChangedNothingAndNamesIt() {
        var t = BatchStop.Tracker()
        t.ran(0, ComputerAction(action: .leftClick, element: 3), effect: .changed)
        t.ran(1, ComputerAction(action: .leftClick, element: 4), effect: .none)
        #expect(t.stop(before: ComputerAction(action: .leftClick, element: 5)) == nil)
        #expect(t.stop(before: ComputerAction(action: .key, text: "Tab")) == NotRunStep.Stopped(afterStep: 1, reason: "no-change"))
    }

    @Test func aWaitOrAScreenshotIsNeverTheStepBefore() {
        var t = BatchStop.Tracker()
        t.ran(0, ComputerAction(action: .leftClick, element: 3), effect: .none)
        t.ran(1, ComputerAction(action: .wait, duration: 1), effect: .changed)
        t.ran(2, ComputerAction(action: .screenshot), effect: .unknown)
        #expect(t.stop(before: ComputerAction(action: .type, text: "x"))?.afterStep == 0)
    }

    @Test func aLaterSegmentReadsPriorAsTheStepBefore() {
        let none = BatchStop.Tracker(prior: Prior(effect: .none, targeted: [3]))
        #expect(none.stop(before: ComputerAction(action: .type, text: "x")) == NotRunStep.Stopped(afterStep: 0, reason: "no-change"))
        #expect(none.stop(before: ComputerAction(action: .type, text: "x", named: "Search")) == nil)
        #expect(BatchStop.Tracker(prior: Prior(effect: .changed, targeted: [])).stop(before: ComputerAction(action: .key, text: "Return")) == nil)
        // a step of this request that changed something clears prior's none
        var t = none
        t.ran(0, ComputerAction(action: .leftClick, element: 3), effect: .changed)
        #expect(t.stop(before: ComputerAction(action: .key, text: "Return")) == nil)
    }
}
