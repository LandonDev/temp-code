import Foundation
import SwiftUI
import TempCodeContract

/// Where a tap goes. Each tab's stack resolves these in `RootView`.
enum Route: Hashable, Codable {
    /// `seq`: a row to land on (a search hit); L4 scrolls to it.
    case thread(environmentId: String, sessionId: String, seq: Int?)
    case archivedThreads(environmentId: String, projectId: String)
    case archivedProjects(environmentId: String, workspaceId: String)
    case inboxItem(environmentId: String, item: GithubInboxItem)
    case settings
    case hosts
}

enum AppTab: String, Hashable, Codable {
    case home
    case inbox
    case search
}

/// The row insets every content row shares: the text edge at 16 pt.
let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)

/// Where the person was: the tab and each tab's stack, written on every
/// change and read back before the first frame of a cold launch, so the app
/// opens on the screen it was killed on (the thread's segment is remembered
/// by the thread screen itself, per thread). The proof's launch routes
/// (`TC_TEST_ROUTE`) start clean instead.
enum NavigationMemory {
    struct Snapshot: Codable {
        var tab: AppTab = .home
        var home: NavigationPath.CodableRepresentation?
        var inbox: NavigationPath.CodableRepresentation?
        var search: NavigationPath.CodableRepresentation?
    }

    static let key = "navigation.memory"

    /// What to restore at launch, if anything.
    static func restore(defaults: UserDefaults = .standard) -> Snapshot? {
        #if DEBUG
        if let route = ProcessInfo.processInfo.environment["TC_TEST_ROUTE"], !route.isEmpty { return nil }
        #endif
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func save(_ snapshot: Snapshot, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: key)
    }

    static func path(_ representation: NavigationPath.CodableRepresentation?) -> NavigationPath {
        representation.map { NavigationPath($0) } ?? NavigationPath()
    }
}
