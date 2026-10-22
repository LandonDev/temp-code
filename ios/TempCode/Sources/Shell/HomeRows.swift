import Foundation
import TempCodeClient
import TempCodeContract

/// The adapter from the live clients to `HomeSections`: value copies of each
/// host's shell in, sections out. The rules live in the client package where
/// the tests run; nothing here decides anything.
enum HomeRows {
    static func inputs(_ clients: [EnvironmentClient], notes: (EnvironmentClient) -> [HomeNote]) -> [HomeHostInput] {
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
                notes: notes(client)
            )
        }
    }

    static func build(clients: [EnvironmentClient], folded: Set<String>, slots: HomeSlots) -> [HomeSection] {
        HomeSections.build(hosts: inputs(clients, notes: slots.hostNotes), folded: folded)
    }
}
