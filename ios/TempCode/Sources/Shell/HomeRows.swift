import Foundation
import TempCodeClient
import TempCodeContract

/// The adapter from the live clients to `HomeSections`: value copies of each
/// host's shell in, the three levels out. The rules live in the client
/// package; nothing here decides anything.
enum HomeRows {
    /// `current`: the sessions and seen marks as the hosts hold them now,
    /// read with nothing tracked, for code that acts (a thread's placing,
    /// a launch route) or follows `liveRevision` off a body (`KeptScope`).
    /// Without it, the list screens' copy, which a body may read: it trails
    /// by a quarter of a second at most while no list is on screen.
    static func inputs(_ clients: [EnvironmentClient], notes: (EnvironmentClient) -> [HomeNote] = { _ in [] }, current: Bool = false) -> [HomeHostInput] {
        clients.map { client in
            HomeHostInput(
                environmentId: client.environment.id,
                name: client.environment.name,
                troubled: HomeSections.troubled(client.status),
                hasShell: client.hasShell,
                floor: Int(client.environment.addedAt),
                workspaces: client.workspaces,
                projects: client.projects,
                sessions: current ? client.currentSessions : client.listedSessions,
                seen: current ? client.currentSeen : client.seen,
                notes: notes(client),
                via: client.environment.via
            )
        }
    }
}
