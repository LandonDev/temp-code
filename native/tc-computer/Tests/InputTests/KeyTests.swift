import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

private struct Vector: Decodable {
    let input: String
    let ok: Bool
    let modifiers: [String]?
    let key: String?
}

private struct Vectors: Decodable { let vectors: [Vector] }

private func vectors() throws -> [Vector] {
    let url = repoRoot().appendingPathComponent("src/main/server/computer/fixtures/keys/combos.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).vectors
}

@Suite struct KeyComboTests {
    @Test func matchesEveryVector() throws {
        let all = try vectors()
        #expect(all.count > 100)
        for v in all {
            if !v.ok {
                #expect(throws: ComputerFailure.self, "\(v.input.debugDescription)") { try parseKeyCombo(v.input) }
                continue
            }
            let c = try parseKeyCombo(v.input)
            #expect(c.modifiers.names == v.modifiers, "\(v.input)")
            #expect(c.key.text == v.key, "\(v.input)")
        }
    }

    @Test func refusesWithInvalidKey() {
        #expect(throws: ComputerFailure.self) { try parseKeyCombo("ctrl+foo") }
        do { _ = try parseKeyCombo("hyper+a") } catch { #expect(kind(error) == .invalidKey) }
    }

    @Test func parsesModifiersWithEveryAlias() throws {
        #expect(try parseModifiers(nil) == [])
        #expect(try parseModifiers("shift") == .shift)
        for a in ["ctrl", "control", "Ctrl"] { #expect(try parseModifiers(a) == .control) }
        for a in ["alt", "opt", "option"] { #expect(try parseModifiers(a) == .option) }
        for a in ["super", "cmd", "command", "CMD"] { #expect(try parseModifiers(a) == .command) }
        #expect(try parseModifiers("ctrl+alt") == [.control, .option])
        #expect(throws: ComputerFailure.self) { try parseModifiers("ctrl+") }
        #expect(throws: ComputerFailure.self) { try parseModifiers("a") }
        #expect(throws: ComputerFailure.self) { try parseModifiers("cmd+super") }
        #expect(throws: ComputerFailure.self) { try parseModifiers("") }
    }
}

@Suite struct KeyCodesTests {
    @Test func everyKeyNameHasAKey() {
        let layout = USANSILayout()
        for canonical in Set(InputTables.keyNames.values) {
            let typed = KeyCodes.character(canonical).flatMap { layout.stroke(for: $0) }
            #expect(KeyCodes.code(canonical) != nil || typed != nil, "\(canonical)")
        }
    }

    @Test func pinsTheFixedKeys() {
        let f: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        for (i, code) in f.enumerated() { #expect(KeyCodes.code("F\(i + 1)") == code) }
        #expect(KeyCodes.code("Return") == 36)
        #expect(KeyCodes.code("Tab") == 48)
        #expect(KeyCodes.code("Escape") == 53)
        #expect(KeyCodes.code("Delete") == 117)
        #expect(KeyCodes.code("super") == 55)
        // the keypad's Enter is the grammar's Return (kp_enter is an alias)
        #expect(InputTables.keyNames["kp_enter"] == "Return")
    }
}

@Suite struct KeyLayoutTests {
    @Test func usANSIStrokes() {
        let l = USANSILayout()
        #expect(l.stroke(for: "a") == KeyStroke(code: 0))
        #expect(l.stroke(for: "A") == KeyStroke(code: 0, modifiers: .shift))
        #expect(l.stroke(for: "?") == KeyStroke(code: 44, modifiers: .shift))
        #expect(l.stroke(for: "1") == KeyStroke(code: 18))
        #expect(l.stroke(for: "!") == KeyStroke(code: 18, modifiers: .shift))
        #expect(l.stroke(for: " ") == KeyStroke(code: 49))
        #expect(l.stroke(for: "é") == nil)
    }
}
