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
        /// A sheet that was up, restored by the view that owns it.
        var sheet: SheetMemory?
    }

    static let key = "navigation.memory"
    /// The sheet's own key: the stacks and the sheet are written by different
    /// views at different moments, so neither write can drop the other's.
    static let sheetKey = "navigation.sheet"

    /// What to restore at launch, if anything.
    static func restore(defaults: UserDefaults = .standard) -> Snapshot? {
        #if DEBUG
        if let route = ProcessInfo.processInfo.environment["TC_TEST_ROUTE"], !route.isEmpty { return nil }
        #endif
        guard let data = defaults.data(forKey: key) else { return nil }
        guard var snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return nil }
        snapshot.sheet = defaults.data(forKey: sheetKey).flatMap { try? JSONDecoder().decode(SheetMemory.self, from: $0) }
        return snapshot
    }

    static func save(_ snapshot: Snapshot, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: key)
    }

    /// The view that owns a sheet says it is up (or, with nil, down).
    static func rememberSheet(_ sheet: SheetMemory?, defaults: UserDefaults = .standard) {
        guard let sheet, let data = try? JSONEncoder().encode(sheet) else {
            defaults.removeObject(forKey: sheetKey)
            return
        }
        defaults.set(data, forKey: sheetKey)
    }

    static func forgetSheet(defaults: UserDefaults = .standard) {
        rememberSheet(nil, defaults: defaults)
    }

    static func path(_ representation: NavigationPath.CodableRepresentation?) -> NavigationPath {
        representation.map { NavigationPath($0) } ?? NavigationPath()
    }
}

/// A sheet worth coming back to after a kill: composing a new thread, or
/// starting a build from a plan. The pairing sheets are single-use flows
/// and start clean.
enum SheetMemory: Codable, Hashable, Sendable {
    case newThread(environmentId: String, workspaceId: String, projectId: String?)
    case startBuild(environmentId: String, sessionId: String)
}

/// Where the person was in a thread: the id of the transcript item at the
/// top of the screen while they were scrolled up, nothing while they were at
/// the bottom. Written as the transcript scrolls, read on its first paint so
/// a relaunch opens the thread on the same row (within the process the rows
/// above are the same objects, and SwiftUI keeps the offset itself).
enum ScrollMemory {
    static func key(_ sessionId: String) -> String { "thread.anchor.\(sessionId)" }

    static func anchor(for sessionId: String, defaults: UserDefaults = .standard) -> Int? {
        defaults.object(forKey: key(sessionId)) as? Int
    }

    static func set(_ anchor: Int?, for sessionId: String, defaults: UserDefaults = .standard) {
        if let anchor {
            guard defaults.object(forKey: key(sessionId)) as? Int != anchor else { return }
            defaults.set(anchor, forKey: key(sessionId))
        } else {
            guard defaults.object(forKey: key(sessionId)) != nil else { return }
            defaults.removeObject(forKey: key(sessionId))
        }
    }
}
