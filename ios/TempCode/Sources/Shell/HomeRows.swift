import Foundation
import TempCodeClient
import TempCodeContract

/// The adapter from the live clients to `HomeSections`: value copies of each
/// host's shell in, the three levels out. The rules live in the client
/// package; nothing here decides anything.
enum HomeRows {
    static func inputs(_ clients: [EnvironmentClient], notes: (EnvironmentClient) -> [HomeNote] = { _ in [] }) -> [HomeHostInput] {
        clients.map { client in
            HomeHostInput(
                environmentId: client.environment.id,
                name: client.environment.name,
                troubled: HomeSections.troubled(client.status),
                hasShell: client.hasShell,
                floor: Int(client.environment.addedAt),
                workspaces: client.workspaces,
                projects: client.projects,
                sessions: client.sessions,
                seen: client.seen,
                notes: notes(client),
                via: client.environment.via
            )
        }
    }
}
