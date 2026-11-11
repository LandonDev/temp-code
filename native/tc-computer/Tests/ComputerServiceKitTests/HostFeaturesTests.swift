import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

/// Old peers never see what they cannot parse (docs/computer-protocol.md §3, plan decision 14).
@Suite struct HostFeaturesTests {
    private let hold = FrontHold(heldMs: 420, activateMs: 30, restoreMs: 20, restored: .restored)
    private let disk = DiskChange(saved: "~/run/Total.txt")

    private func frontStep(effect: StepEffect = .uncommitted, via: InputVia = .menu) -> StepResult {
        .ok(OkStep(index: 0, action: .key, tier: .front, effect: effect, input: .init(via: via, on: "File › Save"), front: hold, disk: disk))
    }

    @Test func theListIsReadByNameAndAnUnknownNameIsIgnored() {
        let some = HostFeatures(["front", "teleport"])
        #expect(some.front && !some.commit && !some.saveAs)
        #expect(HostFeatures(nil) == .none)
        #expect(HostFeatures([]) == .none)
        #expect(HostFeatures(["front", "commit", "save_as"]) == .all)
        #expect(HostFeatures.all.documentLine && !HostFeatures(["front"]).documentLine)
    }

    @Test func aHostThatListedEverythingGetsTheStepAsItIs() {
        #expect(HostFeatures.all.fit(frontStep()) == frontStep())
    }

    @Test func anOldHostReadsAFrontStepAsSessionAndAnUncommittedOneAsChanged() {
        guard case .ok(let ok) = HostFeatures.none.fit(frontStep()) else { Issue.record("not ok"); return }
        #expect(ok.tier == .session)
        #expect(ok.effect == .changed)
        #expect(ok.front == nil && ok.disk == nil)
        #expect(ok.input?.via == .menu && ok.input?.on == "File › Save")
    }

    @Test func eachFeatureKeepsItsOwnFields() {
        guard case .ok(let onlyFront) = HostFeatures(["front"]).fit(frontStep()) else { Issue.record("not ok"); return }
        #expect(onlyFront.tier == .front && onlyFront.front == hold)
        #expect(onlyFront.effect == .changed && onlyFront.disk == nil)
        guard case .ok(let onlyCommit) = HostFeatures(["commit"]).fit(frontStep()) else { Issue.record("not ok"); return }
        #expect(onlyCommit.tier == .session && onlyCommit.front == nil)
        #expect(onlyCommit.effect == .uncommitted && onlyCommit.disk == disk)
    }

    @Test func thePanelRouteGoesWithoutSaveAs() {
        guard case .ok(let ok) = HostFeatures(["front", "commit"]).fit(frontStep(effect: .changed, via: .panel)) else { Issue.record("not ok"); return }
        #expect(ok.input == nil)
        guard case .ok(let kept) = HostFeatures.all.fit(frontStep(effect: .changed, via: .panel)) else { Issue.record("not ok"); return }
        #expect(kept.input?.via == .panel)
    }

    @Test func aNeedsTierForFrontAsksAnOldHostForSession() {
        let error = ComputerError(kind: .needsTier, message: "File › Save is disabled in the background.", needed: .front, front: hold, menu: ["File", "Save"])
        let step = StepResult.failed(FailedStep(index: 1, action: .key, error: error))
        guard case .failed(let old) = HostFeatures.none.fit(step) else { Issue.record("not failed"); return }
        #expect(old.error.needed == .session && old.error.front == nil)
        #expect(old.error.menu == ["File", "Save"] && old.error.message == error.message && old.error.kind == .needsTier)
        guard case .failed(let new) = HostFeatures(["front"]).fit(step) else { Issue.record("not failed"); return }
        #expect(new.error == error)
    }

    @Test func theSavePanelsKindsReadActionUnsupportedWithoutSaveAs() {
        for kind in [ComputerErrorKind.notCommitted, .fileExists] {
            let error = ComputerError(kind: kind, message: "~/run/note.rtf exists; pass replace to overwrite it.")
            #expect(HostFeatures(["front", "commit"]).fit(error).kind == .actionUnsupported)
            #expect(HostFeatures(["front", "commit"]).fit(error).message == error.message)
            #expect(HostFeatures.all.fit(error) == error)
        }
        let plain = ComputerError(kind: .timeout, message: "TextEdit did not answer.")
        #expect(HostFeatures.none.fit(plain) == plain)
    }

    @Test func aResultFitsEveryStepAndItsObservationErrorAndKeepsTheRest() {
        let observationError = ComputerError(kind: .needsTier, message: "x", needed: .front)
        let batch = BatchResult(
            steps: [frontStep(), .notRun(NotRunStep(index: 1, action: .key))], observationError: observationError,
            waited: WaitRule.skipped().report, menusLeftOpen: ["Action"]
        )
        let old = HostFeatures.none.fit(batch)
        guard case .ok(let ok) = old.steps[0] else { Issue.record("not ok"); return }
        #expect(ok.tier == .session)
        #expect(old.steps[1] == batch.steps[1])
        #expect(old.observationError?.needed == .session)
        #expect(old.menusLeftOpen == ["Action"] && old.waited == batch.waited)
        let single = HostFeatures.none.fit(ActionResult(step: frontStep(), menusLeftOpen: ["Action"]))
        guard case .ok(let one) = single.step else { Issue.record("not ok"); return }
        #expect(one.effect == .changed && single.menusLeftOpen == ["Action"])
        #expect(HostFeatures.all.fit(batch) == batch)
    }
}

/// §26.11: the menus a call closed, and the way back to an item a later step names by index.
@Suite struct ClosedMenusTests {
    @Test func aClosedPopUpsItemReopensThroughItsOpener() {
        var book = ClosedMenus()
        book.saw(OpenedMenu(id: "0", title: "Action", opener: .popUp, items: ["New Folder", "Get Info"]), itemIndices: [41: "New Folder", 42: "Get Info"])
        #expect(book.nextClose("0", frontAllowed: true) == .cancel)
        // still open: nothing reaches it yet, the item answers as it is
        #expect(book.reach(index: 41) == nil)
        book.checked("0", gone: true)
        #expect(book.reach(index: 41) == .reopen(openerId: "0", item: "New Folder", on: "Action › New Folder"))
        #expect(book.reach(index: 7) == nil, "an index that was no item of the menu")
        #expect(book.leftOpen == nil)
    }

    @Test func aMenuBarItemIsPressedAsItIs() {
        var book = ClosedMenus()
        book.saw(OpenedMenu(id: "0", title: "File", opener: .menuBar, items: ["Save"]), itemIndices: [9: "Save"])
        _ = book.nextClose("0", frontAllowed: false)
        book.checked("0", gone: true)
        #expect(book.reach(index: 9) == .pressAsIs)
    }

    @Test func aMenuNoCloseRemovedIsNamedAndNeverReached() {
        var book = ClosedMenus()
        book.saw(OpenedMenu(id: "0", title: "Sort", opener: .popUp, items: ["Date"]), itemIndices: [3: "Date"])
        while let _ = book.nextClose("0", frontAllowed: false) { book.checked("0", gone: false) }
        #expect(book.leftOpen == ["Sort"])
        #expect(book.reach(index: 3) == nil)
    }
}
