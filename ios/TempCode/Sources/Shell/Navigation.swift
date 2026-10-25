import Foundation
import SwiftUI
import TempCodeClient

/// The row insets every content row shares: the text edge at 16 pt.
let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)

/// Where the person was: the tab and, per tab, the sidebar's routes, the
/// detail's root and what it pushed, plus the overlay pose's toggle
/// (`NavigationSnapshot`, the client package's). Written on every change and
/// read back before the first frame of a cold launch, so the app opens on
/// the screen it was killed on, folded or unfolded: one snapshot opens a
/// thread on top of the Project list in compact and in the detail beside it
/// in the split (the thread's segment is remembered by the thread screen
/// itself, per thread). The old `navigation.memory` key is ignored, not
/// migrated. The proof's launch routes (`TC_TEST_ROUTE`) start clean instead.
enum NavigationMemory {
    struct Restored {
        var snapshot: NavigationSnapshot
        /// The Inbox's typed path, the item alone (InboxRoute.remembered): the
        /// Inbox keeps its own split (InboxScreen), so its place has its own key.
        var inbox: [InboxRoute]?
        /// A sheet that was up, restored by the view that owns it.
        var sheet: SheetMemory?
    }

    /// The sheet's own key: the stacks and the sheet are written by different
    /// views at different moments, so neither write can drop the other's.
    static let sheetKey = "navigation.sheet"
    static let inboxKey = "navigation.inbox.v2"

    /// What to restore at launch, if anything.
    static func restore(defaults: UserDefaults = .standard) -> Restored? {
        #if DEBUG
        if let route = ProcessInfo.processInfo.environment["TC_TEST_ROUTE"], !route.isEmpty { return nil }
        #endif
        guard let data = defaults.data(forKey: NavigationSnapshot.key),
              let snapshot = try? JSONDecoder().decode(NavigationSnapshot.self, from: data) else { return nil }
        let sheet = defaults.data(forKey: sheetKey).flatMap { try? JSONDecoder().decode(SheetMemory.self, from: $0) }
        let inbox = defaults.data(forKey: inboxKey).flatMap { try? JSONDecoder().decode([InboxRoute].self, from: $0) }
        return Restored(snapshot: snapshot, inbox: inbox, sheet: sheet)
    }

    static func save(_ snapshot: NavigationSnapshot, inbox: [InboxRoute], defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(snapshot) { defaults.set(data, forKey: NavigationSnapshot.key) }
        if let data = try? JSONEncoder().encode(inbox) { defaults.set(data, forKey: inboxKey) }
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

    /// A detail stack as the snapshot carries it: its codable form as JSON,
    /// nil when a pushed value is not codable.
    static func encode(_ path: NavigationPath) -> Data? {
        path.codable.flatMap { try? JSONEncoder().encode($0) }
    }

    static func path(_ data: Data?) -> NavigationPath {
        guard let data, let representation = try? JSONDecoder().decode(NavigationPath.CodableRepresentation.self, from: data) else { return NavigationPath() }
        return NavigationPath(representation)
    }
}

/// A sheet worth coming back to after a kill: composing a new thread, or
/// starting a build from a plan. The pairing sheets are single-use flows
/// and start clean.
enum SheetMemory: Codable, Hashable, Sendable {
    case newThread(environmentId: String, workspaceId: String, projectId: String?)
    case startBuild(environmentId: String, sessionId: String)
}

/// The cold launch's restore: true from the process's start until the root
/// view's first task, while the saved stacks are rebuilt. A thread screen
/// built then is a restored one and opens at the bottom whatever row its
/// route named (`TranscriptLanding.onOpen`); a launch route (a notification,
/// the proof's) is followed after it ends, so it keeps its row. The
/// transcript keeps no scroll memory: it always opens at its newest row.
@MainActor
enum LaunchRestore {
    private(set) static var active = true

    static func end() { active = false }
}
