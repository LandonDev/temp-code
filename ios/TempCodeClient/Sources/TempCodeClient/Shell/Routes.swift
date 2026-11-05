import Foundation
import TempCodeContract

/// Where a tap goes on Home and Search. The app's shell resolves these in
/// its split's two columns (`ShellPaths.column(of:)` says which); the values
/// live here so the navigation memory is a pure, tested value. The Inbox has
/// its own typed path (the app's `InboxRoute`).
public enum Route: Hashable, Codable, Sendable {
    /// `seq`: a row to land on (a search hit); the thread screen scrolls to it.
    case thread(environmentId: String, sessionId: String, seq: Int?)
    /// A workspace's projects and chats; `key` is `HomeSections.Entry.id`.
    case workspace(key: String)
    /// A project's shell in the detail: its strip over `thread` (the chip's
    /// id, `<environmentId>:<sessionId>`), or over the project's draft when
    /// `thread` is nil. `key` is the strip scope's key (`StripScope.key`): a
    /// project's `HomeProject.id`, or `loose:…` for a workspace's loose
    /// chats. `seq` is a row to land on, as on `thread`. The defaults keep
    /// the synthesized `Codable` decoding a route saved without them.
    case project(key: String, thread: String? = nil, seq: Int? = nil)
    case archivedThreads(environmentId: String, projectId: String)
    case archivedProjects(environmentId: String, workspaceId: String)
    case settings
    case hosts
}

/// The three tabs.
public enum AppTab: String, Hashable, Codable, Sendable, CaseIterable, CodingKeyRepresentable {
    case home
    case inbox
    case search
}
