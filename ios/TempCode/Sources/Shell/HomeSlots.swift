import SwiftUI
import TempCodeClient
import TempCodeContract

/// What sibling threads plug into Home. Every slot is optional; a nil slot
/// draws nothing, so no menu is ever empty. `RootView` passes one value:
/// `HomeView(path: $homePath, slots: …)`. The `AnyView` slots are menu
/// contents and trailing marks, built on open; never a list row.
struct HomeSlots {
    /// Fleet switches: a host's one-off lines, the boot-resume note
    /// ("3 threads resumed after restart") once per boot, drawn as quiet notes
    /// at the top of Home with the event motion and no action.
    var hostNotes: (EnvironmentClient) -> [HomeNote] = { _ in [] }
    /// Fleet switches: Pause all, Resume all, Stop all, Archive done for a
    /// host, the menu of its row at Home's foot (several hosts) or in Home's
    /// navigation bar (one host).
    var hostMenu: ((EnvironmentClient) -> AnyView)?
    /// Fleet switches: the same four for a project, drawn after the settings
    /// entry in the project's menu (its row on the workspace screen, the
    /// project screen's bar).
    var projectBatch: ((EnvironmentClient, ProjectMeta) -> AnyView)?
    /// Project settings: the entry (preamble, reviews, plans) in the project's menu.
    var projectSettings: ((EnvironmentClient, ProjectMeta) -> AnyView)?
    /// Deploy drift: the "+N" mark, trailing on the host status row and the
    /// host's row at Home's foot.
    var hostTrailing: ((EnvironmentClient) -> AnyView)?
    /// The project plan: the "Plan" / "3/7" chip before the plus on a
    /// project row, and in the project screen's bar (ProjectPlanChip.swift).
    var projectTrailing: ((EnvironmentClient, ProjectMeta) -> AnyView)?
    /// Relayed hosts (thread 29): one dim line under a host row's name,
    /// "through box, locked since 9:14" for a host reached through another;
    /// nothing for a paired one.
    var hostSubline: ((EnvironmentClient) -> AnyView)?

    /// A project gets a menu only when something fills it.
    var hasProjectMenu: Bool { projectBatch != nil || projectSettings != nil }
}
