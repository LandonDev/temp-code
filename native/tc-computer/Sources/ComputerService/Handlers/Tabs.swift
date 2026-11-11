import ApplicationServices
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// A read's hold on its app (§25.4): the slot its `TabPlan` named and the tab it switched to, if any.
struct ReadHold: Sendable {
    let lease: SlotLease
    /// `Observation.selectedTab`
    let selectedTab: String?
}

extension ComputerService {
    /// A read's slot (`state.get`, `capture.screenshot`): the shared lease, unless the ref matched a tab that is
    /// not selected, which takes the exclusive slot and selects it (`tab_in_use` for the person's front window
    /// with `tabs` background). A read that took the shared lease for a selected tab looks again once it holds
    /// it, and comes back exclusive when another session's act switched the tab meanwhile.
    func readHold(_ target: Resolved, tabs: TabsMode?, waitMs: Int) async throws -> ReadHold {
        var decision = TabPlan.decide(.read, tabSelected: target.tab?.selected)
        guard var lease = await take(target, decision) else { throw Router.cancelledError }
        if decision.slot == .shared, target.tab != nil, let again = TabPlan.recheck(decision, tabSelectedNow: await tabSelectedNow(target)) {
            lease.release()
            decision = again
            guard let exclusive = await take(target, decision) else { throw Router.cancelledError }
            lease = exclusive
        }
        do {
            var selection: TabSelection?
            if decision.select { selection = try await selectTab(target, tabs: tabs, waitMs: waitMs) }
            return ReadHold(lease: lease, selectedTab: selection.flatMap { TabPlan.selectedTab(switched: $0.switched, title: $0.title) })
        } catch {
            lease.release()
            throw error
        }
    }

    /// The slot a decision names, waited for with no limit (a read waits out an act).
    private func take(_ target: Resolved, _ decision: TabPlan.Decision) async -> SlotLease? {
        let mode: AppSlot.Mode = decision.slot == .shared ? .shared : .exclusive(session: target.session)
        return await slots.slot(target.pid).acquire(mode, timeout: nil)
    }

    /// Whether the tab the ref matched reads selected now; nil when it matched none.
    private func tabSelectedNow(_ target: Resolved) async -> Bool? {
        let source = modules.windows
        let windowID = target.windowID
        return try? await target.worker.run { state in state.tabs[windowID].map { source.tabSelected($0) } }
    }

    /// Selects the tab the ref matched, under the exclusive slot the caller holds (§25.4): AXPress, AXSelected
    /// read back, the page wait up to `waitMs`. A switched window's page then holds the smart wait until it is
    /// there and loaded. Throws `tab_in_use`, `timeout` or `action_unsupported` as a request error.
    func selectTab(_ target: Resolved, tabs: TabsMode?, waitMs: Int) async throws -> TabSelection? {
        let source = modules.windows
        let windowID = target.windowID
        let pid = target.pid
        let mode = TabPlan.mode(tabs)
        let selection = try await target.worker.run { state -> TabSelection? in
            guard let window = state.windows[windowID], let tab = state.tabs[windowID] else { return nil }
            let done = try source.selectTab(pid: pid, window: window, tab: tab, mode: mode, waitMs: waitMs)
            // the tab is selected now: a later read of this window with the same ref takes the shared lease
            state.tabs[windowID] = TabHandle(element: tab.element, title: tab.title, selected: true)
            if done.switched { state.reader?.watchPage(window: window) }
            return done
        }
        if let selection { trace.note("tab \(selection.switched ? "selected" : "already selected") page=\(selection.page?.state.rawValue ?? "-")") }
        return selection
    }
}
