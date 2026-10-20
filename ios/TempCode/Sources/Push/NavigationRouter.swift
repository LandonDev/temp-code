import Foundation
import Observation
import TempCodeClient

/// A thread on a host, as the screens name what they show.
struct ThreadKey: Hashable {
    let environmentId: String
    let sessionId: String
}

/// Where a notification or Live Activity tap goes, and what is on screen
/// now. `RootView` consumes `pending` by replacing the Home stack with the
/// thread; `ThreadScreen` keeps `visible` current so a notification for the
/// thread on screen shows nothing extra.
@MainActor @Observable
final class NavigationRouter {
    var pending: Route?
    var visible: ThreadKey?

    /// Open the thread and land on the card the push named.
    func open(_ target: PushTarget) {
        pending = .thread(environmentId: target.environmentId, sessionId: target.sessionId, seq: target.seq)
    }

    func isVisible(_ target: PushTarget) -> Bool {
        visible == ThreadKey(environmentId: target.environmentId, sessionId: target.sessionId)
    }
}
