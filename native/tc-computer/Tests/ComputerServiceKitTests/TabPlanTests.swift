import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

@Suite struct TabPlanTests {
    @Test func aReadTakesTheSharedLeaseUnlessItMustSelect() {
        #expect(TabPlan.decide(.read, tabSelected: nil) == .init(slot: .shared, select: false))
        #expect(TabPlan.decide(.read, tabSelected: true) == .init(slot: .shared, select: false))
        #expect(TabPlan.decide(.read, tabSelected: false) == .init(slot: .exclusive, select: true))
    }

    @Test func anActAlwaysTakesTheExclusiveSlotAndSelectsABackgroundTab() {
        #expect(TabPlan.decide(.act, tabSelected: nil) == .init(slot: .exclusive, select: false))
        #expect(TabPlan.decide(.act, tabSelected: true) == .init(slot: .exclusive, select: false))
        #expect(TabPlan.decide(.act, tabSelected: false) == .init(slot: .exclusive, select: true))
    }

    @Test func aSharedReadWhoseTabWasSwitchedAwayComesBackExclusive() {
        let shared = TabPlan.decide(.read, tabSelected: true)
        #expect(TabPlan.recheck(shared, tabSelectedNow: true) == nil)
        #expect(TabPlan.recheck(shared, tabSelectedNow: false) == .init(slot: .exclusive, select: true))
        #expect(TabPlan.recheck(TabPlan.decide(.read, tabSelected: nil), tabSelectedNow: nil) == nil)
        // the exclusive slot already holds off every other act: nothing to recheck
        #expect(TabPlan.recheck(TabPlan.decide(.act, tabSelected: true), tabSelectedNow: false) == nil)
    }

    @Test func tabsDefaultsToBackgroundAndTheObservationNamesOnlyASwitch() {
        #expect(TabPlan.mode(nil) == .background)
        #expect(TabPlan.mode(.background) == .background)
        #expect(TabPlan.mode(.any) == .any)
        #expect(TabPlan.mode(TabsMode(rawValue: "later")) == .background)
        #expect(TabPlan.selectedTab(switched: true, title: "Report") == "Report")
        #expect(TabPlan.selectedTab(switched: false, title: "Report") == nil)
    }
}

@Suite struct CallIndexesTests {
    @Test func expectFocusIsAnIndexLikeAnyOther() {
        let actions = [ComputerAction(action: .leftClickDrag, element: 3, start_element: 2), ComputerAction(action: .type, text: "hi")]
        #expect(CallIndexes.of(actions, expectFocus: 9) == [3, 2, 9])
        #expect(CallIndexes.check(actions, expectFocus: 9, epoch: "e1", current: "e1") == nil)
        let stale = CallIndexes.check([ComputerAction(action: .type, text: "hi")], expectFocus: 9, epoch: "e0", current: "e1") as? ComputerError
        #expect(stale?.kind == .staleElement && stale?.element == 9 && stale?.reason == .serviceRestarted)
        // an index with no epoch is refused as before
        #expect(CallIndexes.check([], expectFocus: 9, epoch: nil, current: "e1") != nil)
        #expect(CallIndexes.check([ComputerAction(action: .type, text: "hi")], epoch: nil, current: "e1") == nil)
    }
}
