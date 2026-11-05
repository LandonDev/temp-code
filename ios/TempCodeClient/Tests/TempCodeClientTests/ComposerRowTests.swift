import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ComposerRowTests {
    @Test func `a narrow row gives way in the desktop's order: the percent, the effort, the mode's label, the model's name`() {
        #expect(ComposerRow.fit(width: 640) == .init(percent: true, effort: true, modeLabel: true, modelName: true))
        #expect(ComposerRow.fit(width: 400) == .init(percent: true, effort: true, modeLabel: true, modelName: true))
        #expect(ComposerRow.fit(width: 399) == .init(percent: false, effort: true, modeLabel: true, modelName: true))
        #expect(ComposerRow.fit(width: 368) == .init(percent: false, effort: true, modeLabel: true, modelName: true))
        #expect(ComposerRow.fit(width: 367) == .init(percent: false, effort: false, modeLabel: true, modelName: true))
        #expect(ComposerRow.fit(width: 319) == .init(percent: false, effort: false, modeLabel: false, modelName: true))
        #expect(ComposerRow.fit(width: 144) == .init(percent: false, effort: false, modeLabel: false, modelName: true))
        #expect(ComposerRow.fit(width: 143) == .init(percent: false, effort: false, modeLabel: false, modelName: false))
        // An iPhone 17 Pro's box (402 less the 16 pt edges) keeps the effort and the label but not the percent.
        #expect(ComposerRow.fit(width: 370) == .init(percent: false, effort: true, modeLabel: true, modelName: true))
        #expect(ComposerRow.height == 24 && ComposerRow.gap == 4)
    }

    @Test func `at a large text size the row keeps giving way in the same order, the name truncating last`() {
        let all = ComposerRow.Fit(percent: true, effort: true, modeLabel: true, modelName: true)
        #expect(ComposerRow.steps(from: all) == [
            all,
            .init(percent: false, effort: true, modeLabel: true, modelName: true),
            .init(percent: false, effort: false, modeLabel: true, modelName: true),
            .init(percent: false, effort: false, modeLabel: false, modelName: true),
        ])
        // A phone's box has given up the percent already: three steps from there.
        #expect(ComposerRow.steps(from: ComposerRow.fit(width: 370)).count == 3)
        #expect(ComposerRow.steps(from: ComposerRow.fit(width: 100)) == [ComposerRow.fit(width: 100)], "nothing left to give up")
    }

    @Test func `the meter is secondary below 85 percent and amber from it, never red`() {
        #expect(ComposerRow.tone(ratio: 0) == .muted)
        #expect(ComposerRow.tone(ratio: 0.849) == .muted)
        #expect(ComposerRow.tone(ratio: 0.85) == .warning)
        #expect(ComposerRow.tone(ratio: 1) == .warning)
        let full = try! #require(ComposerRow.meter(.init(tokens: 190_000, window: 200_000), compacting: false))
        #expect(full.percent == 95 && full.tone == .warning)
        #expect(full.label == "190K of 200K tokens")
        let low = try! #require(ComposerRow.meter(.init(tokens: 124_000, window: 200_000), compacting: false))
        #expect(low.percent == 62 && low.tone == .muted && !low.compacting)
        #expect(ComposerRow.meter(.init(tokens: 300_000, window: 200_000), compacting: false)?.ratio == 1, "an overfull report caps at the window")
    }

    @Test func `the meter draws only once the host reports the level and the window; compacting turns the ring to a spinner`() {
        #expect(ComposerRow.meter(nil, compacting: false) == nil)
        #expect(ComposerRow.meter(.init(tokens: 1_000, window: nil), compacting: false) == nil, "a harness that reports no window")
        #expect(ComposerRow.meter(.init(tokens: 1_000, window: 0), compacting: true) == nil)
        let squeezing = ComposerRow.meter(.init(tokens: 150_000, window: 200_000), compacting: true)
        #expect(squeezing?.compacting == true)
        #expect(squeezing?.label == "Compacting context")
    }

    @Test func `token counts read short as the desktop's do`() {
        #expect(ComposerRow.tokens(980) == "980")
        #expect(ComposerRow.tokens(1_000) == "1K")
        #expect(ComposerRow.tokens(7_500) == "7.5K")
        #expect(ComposerRow.tokens(176_400) == "176K")
        #expect(ComposerRow.tokens(1_048_576) == "1M")
        #expect(ComposerRow.tokens(1_250_000) == "1.3M")
        #expect(ComposerRow.tokens(-3) == "0")
    }

    @Test func `a key that operates picks the model; only approve changes the mode, a lesser key reads it`() {
        #expect(ComposerRow.modelAccess(operate: true) == .editable)
        #expect(ComposerRow.modelAccess(operate: false) == .readOnly)
        #expect(ComposerRow.modeAccess(hasThread: true, approve: true) == .editable)
        #expect(ComposerRow.modeAccess(hasThread: true, approve: false) == .readOnly)
        #expect(ComposerRow.modeAccess(hasThread: false, approve: true) == .hidden)
    }

    @Test func `the modes read in the desktop's words`() {
        #expect(PermissionWords.choices.map(PermissionWords.label) == ["Supervised", "Auto-accept edits", "Full access"])
        #expect(PermissionWords.hint(.auto) == "Allow commands and edits without prompts.")
    }
}

@MainActor
@Suite struct PermissionActionTests {
    @Test func `the mode is session.permission and needs approve`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let setting = Task { try await rig.client.setPermission("s1", .auto) }
        let request = try #require(await rig.request(fake, "session.permission"))
        #expect(request.params == .object(["sessionId": .string("s1"), "permission": .string("auto")]))
        fake.answer(id: request.id, result: "null")
        try await setting.value
        await rig.client.stop()
        let operateOnly = try ActingRig(caps: [.read, .operate])
        _ = try await operateOnly.open()
        await #expect(throws: ActionError.blocked(.noApprove)) { try await operateOnly.client.setPermission("s1", .safe) }
        await operateOnly.client.stop()
    }
}
