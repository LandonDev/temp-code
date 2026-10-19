import SwiftUI
import TempCodeClient

/// The thread screen's one entry point. L4 fills it with the header, the
/// segments and the five bodies; until then L2's transcript stands in.
/// Opening a thread marks its newest work seen, and so does leaving it.
struct ThreadScreen: View {
    let client: EnvironmentClient
    let sessionId: String
    /// A row to land on (a search hit, a needs-you card); L4 scrolls to it.
    var targetSeq: Int? = nil

    var body: some View {
        ThreadView(client: client, sessionId: sessionId)
            .onAppear { client.markSeen(sessionId) }
            .onDisappear { client.markSeen(sessionId) }
    }
}
