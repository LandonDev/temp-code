import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func spec(_ id: String, _ kind: BatchStepKind, name: String? = nil, run: String? = nil, cwd: String? = nil) -> BatchStepSpec {
    BatchStepSpec(id: id, name: name ?? id.capitalized, kind: kind, run: run, cwd: cwd)
}

@Suite struct RulesEditTests {
    @Test("one of each built-in kind, any number of shell steps") func addableKinds() {
        #expect(RulesEdit.addableKinds([]) == [.land, .gate, .release, .publish, .deploy, .shell])
        #expect(RulesEdit.addableKinds([spec("land", .land), spec("gate", .gate), spec("s", .shell, run: "x")]) == [.release, .publish, .deploy, .shell])
    }

    @Test("names, lines and fresh ids") func words() {
        #expect(RulesEdit.defaultName(.gate) == "Gate")
        #expect(RulesEdit.defaultName(.publish) == "Publish")
        #expect(RulesEdit.defaultName(.shell) == "")
        #expect(RulesEdit.stepLine(spec("g", .gate)) == "Gate the merged tree")
        #expect(RulesEdit.stepLine(spec("s", .shell, run: " ./smoke.sh ")) == "./smoke.sh")
        #expect(RulesEdit.stepLine(spec("s", .shell)) == "no command")
        #expect(RulesEdit.newStepId(.shell, in: []) == "shell")
        #expect(RulesEdit.newStepId(.shell, in: [spec("shell", .shell), spec("shell-2", .shell)]) == "shell-3")
    }

    @Test("adding a built-in kind and a shell command") func add() {
        let built = RulesEdit.add(.gate, to: [spec("land", .land)])
        #expect(built.map(\.id) == ["land", "gate"])
        #expect(built[1].name == "Gate")
        let shell = RulesEdit.add(.shell, to: built, shell: .init(name: " Smoke test ", run: " ./smoke.sh dev ", cwd: "  "))
        #expect(shell[2] == BatchStepSpec(id: "shell", name: "Smoke test", kind: .shell, run: "./smoke.sh dev"))
        let withCwd = RulesEdit.add(.shell, to: [], shell: .init(name: "Build", run: "make", cwd: " plugin "))
        #expect(withCwd[0].cwd == "plugin")
    }

    @Test("move, remove by id and rename by id") func edits() {
        let steps = [spec("land", .land), spec("gate", .gate), spec("release", .release)]
        #expect(RulesEdit.move(steps, from: IndexSet(integer: 2), to: 1).map(\.id) == ["land", "release", "gate"])
        #expect(RulesEdit.move(steps, from: IndexSet(integer: 0), to: 3).map(\.id) == ["gate", "release", "land"])
        #expect(RulesEdit.move(steps, from: IndexSet([0, 1]), to: 3).map(\.id) == ["release", "land", "gate"])
        #expect(RulesEdit.remove(steps, ids: ["gate"]).map(\.id) == ["land", "release"])
        let renamed = RulesEdit.rename(steps, id: "gate", to: "Check")
        #expect(renamed[1].name == "Check")
        #expect(renamed[1].kind == .gate)
        #expect(renamed[0] == steps[0])
    }

    @Test("stepsProblem refuses what the contract refuses, in its words", arguments: [
        ([BatchStepSpec(id: "-x", name: "X", kind: .gate)], "step id \"-x\" must be letters, digits, dots, dashes or underscores"),
        ([BatchStepSpec(id: "gaté", name: "X", kind: .gate)], "step id \"gaté\" must be letters, digits, dots, dashes or underscores"),
        ([BatchStepSpec(id: "a", name: "A", kind: .gate), BatchStepSpec(id: "a", name: "B", kind: .release)], "step id \"a\" is used twice"),
        ([BatchStepSpec(id: "s", name: "S", kind: .shell, run: "  ")], "shell step \"s\" has no run"),
        ([BatchStepSpec(id: "g1", name: "G", kind: .gate), BatchStepSpec(id: "g2", name: "G", kind: .gate)], "two gate steps; one per built-in kind"),
        ([BatchStepSpec(id: "g", name: "G", kind: .gate, run: "make")], "step \"g\" is gate, which takes no run")
    ])
    func stepsProblem(steps: [BatchStepSpec], message: String) {
        #expect(RulesEdit.stepsProblem(steps) == message)
    }

    @Test("a valid list has no problem; Save needs every name within its length") func valid() {
        let steps = [spec("land", .land), spec("gate.v2", .gate), spec("smoke_1", .shell, run: "./smoke.sh")]
        #expect(RulesEdit.stepsProblem(steps) == nil)
        #expect(RulesEdit.stepsValid(steps))
        #expect(!RulesEdit.stepsValid([spec("g", .gate, name: " ")]))
        #expect(!RulesEdit.stepsValid([spec("g", .gate, name: String(repeating: "a", count: 81))]))
        #expect(!RulesEdit.stepsValid((0..<33).map { spec("s\($0)", .shell, run: "x") }))
        #expect(RulesEdit.shellDraftValid(.init(name: "Smoke", run: "./smoke.sh")))
        #expect(!RulesEdit.shellDraftValid(.init(name: "Smoke", run: " ")))
        #expect(!RulesEdit.shellDraftValid(.init(name: "", run: "x")))
    }

    @Test("the saved rules trim the summary, and the params carry every field") func rulesAndParams() {
        let steps = [spec("land", .land)]
        #expect(RulesEdit.rules(land: .allAtOnce, steps: steps, then: .archiveChildren, summary: "  ").summary == nil)
        let rules = RulesEdit.rules(land: .allAtOnce, steps: steps, then: .archiveChildren, summary: " Land then tell me ")
        #expect(rules.summary == "Land then tell me")
        let params = RulesEdit.params(masterId: "m", rules: rules)
        #expect(params.masterId == "m")
        #expect(params.rules.land == .allAtOnce)
        #expect(params.rules.steps == steps)
        #expect(params.rules.then == .archiveChildren)
        #expect(params.rules.summary == "Land then tell me")
    }
}
