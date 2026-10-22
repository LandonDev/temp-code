import SwiftUI
import TempCodeClient
import TempCodeContract

/// What sibling threads plug into Home. Every slot is optional; a nil slot
/// draws nothing, so no menu is ever empty. `RootView` passes one value:
/// `HomeView(path: $homePath, slots: …)`. The `AnyView` slots are menu
/// contents and trailing marks, built on open; never a list row.
struct HomeSlots {
    /// Paired projects: the pairing key selector (same GitHub repo, else the
    /// same folder name). Home draws one row for both copies, a connection dot
    /// per member host beside the logo, the project headers naming the host.
    var pairing: HomePairing = .none
    /// Fleet switches: a host's one-off lines, the boot-resume note
    /// ("3 threads resumed after restart") once per boot, drawn as quiet notes
    /// under the host header with the event motion and no action.
    var hostNotes: (EnvironmentClient) -> [HomeNote] = { _ in [] }
    /// Fleet switches: Pause all, Resume all, Stop all, Archive done for a
    /// host, drawn inside a `Menu` on the host header (several hosts) or in
    /// the navigation bar (one host).
    var hostMenu: ((EnvironmentClient) -> AnyView)?
    /// Fleet switches: the same four for a project, drawn after the settings
    /// entry in the project header's menu.
    var projectBatch: ((EnvironmentClient, ProjectMeta) -> AnyView)?
    /// Project settings: the entry (preamble, reviews, plans) in the project
    /// header's menu.
    var projectSettings: ((EnvironmentClient, ProjectMeta) -> AnyView)?
    /// Deploy drift: the "+N" mark, trailing on the host status row and the
    /// host header.
    var hostTrailing: ((EnvironmentClient) -> AnyView)?
    /// The project plan: the "Plan" / "Plan · 3/7" chip before the plus in a
    /// project header (ProjectPlanChip.swift).
    var projectTrailing: ((EnvironmentClient, ProjectMeta) -> AnyView)?

    /// A project header gets a menu only when something fills it.
    var hasProjectMenu: Bool { projectBatch != nil || projectSettings != nil }
}
