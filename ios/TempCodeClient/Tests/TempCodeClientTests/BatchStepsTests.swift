import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func spec(_ id: String, _ kind: BatchStepKind, name: String? = nil, run: String? = nil) -> BatchStepSpec {
    BatchStepSpec(id: id, name: name ?? id.capitalized, kind: kind, run: run)
}

private func step(_ id: String, _ kind: BatchStepKind, _ status: BatchStepStatus, name: String = "", at: Int? = nil, startedAt: Int? = nil, endedAt: Int? = nil, progress: BatchStep.Progress? = nil, log: [String] = []) -> BatchStep {
    BatchStep(id: id, name: name, kind: kind, status: status, detail: "", at: at, startedAt: startedAt, endedAt: endedAt, progress: progress, log: log)
}

private func state(rules: [BatchStepSpec], steps: [BatchStep], landed: [String] = [], pending: [String] = []) -> BatchState {
    BatchState(masterId: "m", rules: BatchRules(land: .asTheyFinish, steps: rules, then: .notify), steps: steps, landed: landed, pending: pending, held: [], blocked: nil, finishedAt: nil)
}

@Suite struct BatchStepsTests {
    @Test("the state's order and its own names win; a rules step the state lacks is pending at the end") func liveSteps() {
        let s = state(
            rules: [spec("land", .land), spec("smoke", .shell, name: "Smoke test", run: "./smoke.sh"), spec("gate", .gate)],
            steps: [step("land", .land, .passed, name: "Land"), step("gate", .gate, .running, name: "Gate the tree")]
        )
        let live = BatchSteps.liveSteps(s)
        #expect(live.map(\.id) == ["land", "gate", "smoke"])
        #expect(live[1].name == "Gate the tree")
        #expect(live[2].status == .pending)
        #expect(live[2].run == "./smoke.sh")
    }

    @Test("a blank name falls to the rules' row; an id that is a kind becomes that kind, another a shell step") func describes() {
        let s = state(rules: [spec("land", .land, name: "Merge")], steps: [step("land", .land, .pending), step("deploy", .unknown("later"), .pending), step("lint", .unknown("x"), .pending)])
        let live = BatchSteps.liveSteps(s)
        #expect(live[0].name == "Merge")
        #expect(live[1].kind == .deploy)
        #expect(live[2].kind == .shell)
    }

    @Test("a land step with no progress borrows landed of all; times come from at when the host sent none") func borrows() {
        let s = state(rules: [spec("land", .land)], steps: [step("land", .land, .running, at: 1_000)], landed: ["a"], pending: ["b", "c"])
        let land = BatchSteps.liveSteps(s)[0]
        #expect(land.progress == BatchStep.Progress(done: 1, total: 3))
        #expect(land.startedAt == 1_000)
        let none = BatchSteps.liveSteps(state(rules: [spec("land", .land)], steps: [step("land", .land, .pending)]))[0]
        #expect(none.progress == nil)
        let passed = BatchSteps.liveSteps(state(rules: [spec("gate", .gate)], steps: [step("gate", .gate, .passed, at: 9_000)]))[0]
        #expect(passed.endedAt == 9_000)
    }

    @Test("an empty rules list adds nothing") func emptyRules() {
        #expect(BatchSteps.liveSteps(state(rules: [], steps: [])).isEmpty)
        #expect(BatchSteps.specs(BatchRules(land: .asTheyFinish, steps: [], then: .notify)).isEmpty)
    }

    @Test("time, progress, the console step, the tail, the words and Stop") func pieces() {
        let running = BatchSteps.LiveStep(id: "s", name: "Smoke", kind: .shell, status: .running, startedAt: 0, progress: .init(done: 3, total: 7, label: " step 3 "), log: ["a", "b"])
        let done = BatchSteps.LiveStep(id: "g", name: "Gate", kind: .gate, status: .passed, startedAt: 0, endedAt: 252_000)
        let failed = BatchSteps.LiveStep(id: "f", name: "Deploy", kind: .deploy, status: .failed)
        let pending = BatchSteps.LiveStep(id: "p", name: "Release", kind: .release, status: .pending)
        #expect(BatchSteps.time(running, now: 12_000) == "12s")
        #expect(BatchSteps.time(done, now: 999_999) == "4m 12s")
        #expect(BatchSteps.time(pending, now: 1) == nil)
        #expect(BatchSteps.progress(running) == .init(count: "3 of 7", label: "step 3", fraction: 3.0 / 7.0))
        #expect(BatchSteps.progress(BatchSteps.LiveStep(id: "x", name: "x", kind: .publish, status: .running, progress: .init(done: 2, total: 0))) == .init(count: "2", label: nil, fraction: nil))
        #expect(BatchSteps.progress(pending) == nil)
        #expect(BatchSteps.consoleStep([done, failed, running], folded: []) == running)
        #expect(BatchSteps.consoleStep([done, failed], folded: []) == failed)
        #expect(BatchSteps.consoleStep([done, failed], folded: ["f"]) == nil)
        #expect(BatchSteps.tail((1...250).map(String.init)).first == "51")
        #expect(BatchSteps.tail(["a"]) == ["a"])
        #expect(BatchSteps.statusWord(.failed) == "failed")
        #expect(BatchSteps.statusWord(.skipped) == "skipped")
        #expect(BatchSteps.statusWord(.passed) == nil)
        #expect(BatchSteps.stoppable(running))
        #expect(BatchSteps.stoppable(BatchSteps.LiveStep(id: "pub", name: "Publish", kind: .publish, status: .running)))
        #expect(!BatchSteps.stoppable(BatchSteps.LiveStep(id: "g", name: "Gate", kind: .gate, status: .running)))
        #expect(!BatchSteps.stoppable(pending))
    }

    @Test("the console follows the count and the newest line, so a full ring still moves") func logKey() {
        let full = (1...200).map(String.init)
        let next = Array(full.dropFirst()) + ["201"]
        #expect(BatchSteps.logKey(full) != BatchSteps.logKey(next))
        #expect(BatchSteps.logKey([]) == "0|")
    }
}
