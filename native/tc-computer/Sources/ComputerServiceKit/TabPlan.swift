import ComputerProtocol
import Foundation

/// §25.4 in the shell: which of the app's slots (§1) a call takes when its window ref may name a browser
/// tab, whether it selects that tab, and what the observation says of it. Resolution has no side effect;
/// a selection happens only under the exclusive slot, held from the selection through the wait, the steps
/// and the observation, so two sessions never switch each other's tab between a selection and a read.
public enum TabPlan {
    public enum Call: Sendable { case read, act }
    public enum Slot: Sendable, Equatable { case shared, exclusive }

    public struct Decision: Sendable, Equatable {
        public var slot: Slot
        /// press the matched tab once the slot is held
        public var select: Bool

        public init(slot: Slot, select: Bool) {
            self.slot = slot
            self.select = select
        }
    }

    /// `tabs` as the call sent it: absent (or a value this build does not know) is `background`.
    public static func mode(_ tabs: TabsMode?) -> TabsMode {
        tabs == .any ? .any : .background
    }

    /// `tabSelected`: nil when the ref matched no tab, else whether the matched tab read selected at resolution.
    /// An act always takes the exclusive slot and selects a tab that is not selected; a read takes the
    /// shared lease unless it must select, which takes the exclusive slot instead.
    public static func decide(_ call: Call, tabSelected: Bool?) -> Decision {
        let select = tabSelected == false
        switch call {
        case .act: return Decision(slot: .exclusive, select: select)
        case .read: return Decision(slot: select ? .exclusive : .shared, select: select)
        }
    }

    /// After the lease: a read that took the shared lease for a tab that was selected, and no longer is
    /// (another session's act switched it meanwhile), lets the lease go and comes back for the exclusive
    /// slot and a selection; nil when the decision stands.
    public static func recheck(_ decision: Decision, tabSelectedNow: Bool?) -> Decision? {
        guard decision.slot == .shared, tabSelectedNow == false else { return nil }
        return Decision(slot: .exclusive, select: true)
    }

    /// `Observation.selectedTab`: the tab's title only when this call switched to it.
    public static func selectedTab(switched: Bool, title: String) -> String? { switched ? title : nil }
}

/// Every element index a call names (§4.2): each action's `element` and `start_element`, and §25.9's
/// `expectFocus`; each is checked against the call's epoch before anything resolves.
public enum CallIndexes {
    public static func of(_ actions: [ComputerAction], expectFocus: Int? = nil) -> [Int] {
        actions.flatMap { [$0.element, $0.start_element].compactMap { $0 } } + (expectFocus.map { [$0] } ?? [])
    }

    /// The first failure among them (`EpochCheck`), nil when the call may go on.
    public static func check(_ actions: [ComputerAction], expectFocus: Int? = nil, epoch: String?, current: String) -> (any Error)? {
        for index in of(actions, expectFocus: expectFocus) {
            if let failure = EpochCheck.check(names: index, epoch: epoch, current: current) { return failure }
        }
        return nil
    }
}
