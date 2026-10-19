import SwiftUI
import TempCodeContract

/// Where a tap goes. Each tab's stack resolves these in `RootView`.
enum Route: Hashable {
    /// `seq`: a row to land on (a search hit); L4 scrolls to it.
    case thread(environmentId: String, sessionId: String, seq: Int?)
    case archivedThreads(environmentId: String, projectId: String)
    case archivedProjects(environmentId: String, workspaceId: String)
    case inboxItem(environmentId: String, item: GithubInboxItem)
    case settings
    case hosts
}

enum AppTab: String, Hashable {
    case home
    case inbox
    case search
}

/// The row insets every content row shares: the text edge at 16 pt.
let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
