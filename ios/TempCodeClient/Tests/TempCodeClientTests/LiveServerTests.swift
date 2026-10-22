import Foundation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The real pieces against a real server (scripts/ios-client-test-server.ts,
/// started by `bun run ios:test:client`): URLSession sockets, the http
/// client, the system clock. The server's address and key arrive in the
/// process environment; without them this suite is skipped.
enum LiveServer {
    static let environment = ProcessInfo.processInfo.environment
    static var isConfigured: Bool { environment["TC_TEST_BASE_URL"] != nil && environment["TC_TEST_KEY"] != nil }
    static var baseURL: URL { URL(string: environment["TC_TEST_BASE_URL"]!)! }
    static var controlURL: URL { URL(string: environment["TC_TEST_CONTROL_URL"]!)! }
    static var environmentId: String { environment["TC_TEST_ENVIRONMENT_ID"]! }
    static var key: String { environment["TC_TEST_KEY"]! }
    static var keyId: String { environment["TC_TEST_KEY_ID"]! }
    static var threadA: String { environment["TC_TEST_THREAD_A"]! }
    static var threadB: String { environment["TC_TEST_THREAD_B"]! }
    /// The second host (the same project on another machine) and the thread whose subagent runs there;
    /// absent, the two-host test is skipped.
    static var hasSecondHost: Bool {
        ["TC_TEST_SECOND_BASE_URL", "TC_TEST_SECOND_ENVIRONMENT_ID", "TC_TEST_SECOND_KEY", "TC_TEST_THREAD_CROSS_HOST", "TC_TEST_THREAD_CHAT"].allSatisfy { environment[$0] != nil }
    }
    static var secondBaseURL: URL { URL(string: environment["TC_TEST_SECOND_BASE_URL"]!)! }
    static var secondEnvironmentId: String { environment["TC_TEST_SECOND_ENVIRONMENT_ID"]! }
    static var secondKey: String { environment["TC_TEST_SECOND_KEY"]! }
    static var threadCrossHost: String { environment["TC_TEST_THREAD_CROSS_HOST"]! }
    static var threadChat: String { environment["TC_TEST_THREAD_CHAT"]! }

    /// One control call; answers the JSON object.
    static func control(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: controlURL.appending(path: path))
        request.httpMethod = body == nil ? "GET" : "POST"
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    static func environment(expectedId: String? = nil) -> PairedEnvironment {
        PairedEnvironment(id: expectedId ?? environmentId, name: "test host", origin: baseURL, caps: [.read], keyId: keyId, keyName: "ios-test", addedAt: 0)
    }

    static func keys() throws -> InMemoryKeyStore {
        let keys = InMemoryKeyStore()
        try keys.set(key, for: environmentId)
        return keys
    }

    static func secondEnvironment() -> PairedEnvironment {
        PairedEnvironment(id: secondEnvironmentId, name: "second host", origin: secondBaseURL, caps: [.read], keyId: "second", keyName: "ios-test-second", addedAt: 0)
    }

    static func secondKeys() throws -> InMemoryKeyStore {
        let keys = InMemoryKeyStore()
        try keys.set(secondKey, for: secondEnvironmentId)
        return keys
    }

    /// Waits up to `seconds` for the predicate.
    static func until(_ seconds: Double = 10, _ predicate: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return false
    }
}

@Suite(.enabled(if: LiveServer.isConfigured, "needs the live server: bun run ios:test:client"), .serialized)
struct LiveServerTests {
    @Test func `hello over http names the environment and what the key may do`() async throws {
        let api = RemoteAPI()
        let hello = try await api.hello(origin: LiveServer.baseURL, key: LiveServer.key)
        #expect(hello.environmentId == LiveServer.environmentId)
        #expect(hello.contract == contractVersion)
        #expect(hello.key?.caps == [.read])
        #expect(hello.key?.audience == .client)
        await #expect(throws: RemoteAPIError.unauthorized("invalid key")) {
            _ = try await api.ticket(origin: LiveServer.baseURL, key: "tc_NOPE.nope")
        }
    }

    @Test func `the socket opens on a fresh ticket, the hello is first, and the server negotiated deflate`() async throws {
        let keys = try LiveServer.keys()
        let socket = TempCodeSocket(environment: LiveServer.environment(), keys: keys)
        await socket.start()
        #expect(await LiveServer.until { await socket.status.transport == .open })
        let status = await socket.status
        #expect(status.lastHello?.environmentId == LiveServer.environmentId)
        #expect(status.lastHello?.key?.name == "ios-test")
        let workspaces = try await socket.request(Methods.WorkspaceList.self, NoParams())
        #expect(workspaces.map(\.name).contains("ios-workspace"))
        let state = try await LiveServer.control("/state")
        let sockets = state["sockets"] as? [[String: Any]] ?? []
        let mine = sockets.first { $0["keyId"] as? String == LiveServer.keyId }
        #expect(mine != nil)
        #expect((mine?["extensions"] as? String)?.contains("permessage-deflate") == true, "extensions: \(mine?["extensions"] ?? "none")")
        // A read key is refused an operate call with a typed error.
        do {
            _ = try await socket.request(Methods.SessionInterrupt.self, .init(sessionId: LiveServer.threadA))
            Issue.record("interrupt went through on a read key")
        } catch let error as TransportError {
            #expect(error.isForbidden)
        }
        await socket.stop()
    }

    @Test func `a hello from another environment halts the socket`() async throws {
        let keys = try LiveServer.keys()
        let other = PairedEnvironment(id: "env_someone_else", name: "x", origin: LiveServer.baseURL, caps: [.read], keyId: LiveServer.keyId, keyName: "k", addedAt: 0)
        try keys.set(LiveServer.key, for: other.id)
        let socket = TempCodeSocket(environment: other, keys: keys)
        await socket.start()
        #expect(await LiveServer.until { await socket.status.halt != nil })
        let status = await socket.status
        #expect(status.transport == .offline)
        #expect(status.halt == .identityChanged(expected: "env_someone_else", got: LiveServer.environmentId))
        await socket.stop()
    }

    @Test func `a contract the app does not speak halts the socket`() async throws {
        var config = SocketConfiguration()
        config.expectedContract = contractVersion + 7
        let socket = TempCodeSocket(environment: LiveServer.environment(), keys: try LiveServer.keys(), configuration: config)
        await socket.start()
        #expect(await LiveServer.until { await socket.status.halt != nil })
        #expect(await socket.status.halt == .contractMismatch(app: contractVersion + 7, host: contractVersion))
        await socket.stop()
    }

    @Test func `an expired or used ticket is refused as unauthorized and a fresh one opens`() async throws {
        let api = RemoteAPI()
        let ticket = try await api.ticket(origin: LiveServer.baseURL, key: LiveServer.key)
        #expect(ticket.expiresIn == 30)
        _ = try await LiveServer.control("/clock", ["offsetMs": 31_000])
        defer { Task { _ = try? await LiveServer.control("/clock", ["offsetMs": 0]) } }
        let url = LiveServer.environment().socketURL.appending(queryItems: [URLQueryItem(name: "ticket", value: ticket.ticket)])
        let expired = Transport(url: url, connect: URLSessionWebSocket.factory())
        do {
            _ = try await expired.open()
            Issue.record("an expired ticket opened a socket")
        } catch let error as TransportError {
            guard case .closed(let reason) = error else {
                Issue.record("wrong error \(error)")
                return
            }
            #expect(reason.kind == .unauthorized)
            #expect(reason.code == 401)
        }
        _ = try await LiveServer.control("/clock", ["offsetMs": 0])
        // A ticket is single use: the second upgrade with the same one is refused.
        let fresh = try await api.ticket(origin: LiveServer.baseURL, key: LiveServer.key)
        let freshURL = LiveServer.environment().socketURL.appending(queryItems: [URLQueryItem(name: "ticket", value: fresh.ticket)])
        let first = Transport(url: freshURL, connect: URLSessionWebSocket.factory())
        let hello = try await first.open()
        #expect(hello.environmentId == LiveServer.environmentId)
        let again = Transport(url: freshURL, connect: URLSessionWebSocket.factory())
        await #expect(throws: TransportError.self) { _ = try await again.open() }
        #expect(await again.closeReason?.kind == .unauthorized)
        await first.close()
    }

    @MainActor
    @Test func `a dropped link resumes from the last seq without duplicating or losing rows`() async throws {
        let client = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: try SessionCache.inMemory())
        await client.start()
        #expect(await LiveServer.until { client.status.fresh })
        #expect(Set(client.sessions.map(\.id)).isSuperset(of: [LiveServer.threadA, LiveServer.threadB]))
        await client.openThread(LiveServer.threadA)
        #expect(await LiveServer.until { client.threads[LiveServer.threadA]?.isLive == true && (client.threads[LiveServer.threadA]?.rows.count ?? 0) >= 9 })
        let seeded = client.threads[LiveServer.threadA]!.rows
        // The long tool output came as an omitted body on the remote profile; the whole row is one request away.
        let omitted = seeded.first { if case .toolResult(let result) = $0.event, case .omittedBody = result.output { return true } else { return false } }
        let omittedRow = try #require(omitted)
        let whole = try #require(await client.body(sessionId: LiveServer.threadA, seq: omittedRow.seq))
        if case .toolResult(let result) = whole.event, case .string(let text) = result.output { #expect(text.hasPrefix("line 000")) } else { Issue.record("the body did not come back whole") }

        let before = seeded.count
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadA, "count": 3])
        #expect(await LiveServer.until { (client.threads[LiveServer.threadA]?.rows.count ?? 0) == before + 3 })

        let dropped = try await LiveServer.control("/drop", [:])
        #expect((dropped["dropped"] as? Int ?? 0) >= 1, "\(dropped)")
        #expect(await LiveServer.until { client.status.transport == .reconnecting })
        // Rows written while the link is down.
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadA, "count": 4])
        #expect(await LiveServer.until(15) { client.status.transport == .open && client.threads[LiveServer.threadA]?.isLive == true })
        #expect(await LiveServer.until { (client.threads[LiveServer.threadA]?.rows.count ?? 0) == before + 7 })
        let rows = client.threads[LiveServer.threadA]!.rows
        let seqs = rows.map(\.seq)
        #expect(seqs == seqs.sorted())
        #expect(Set(seqs).count == seqs.count)
        #expect(seqs.last! - seqs.first! + 1 == seqs.count, "no gap in \(seqs)")
        // The newest rows carry the text appended after the drop.
        let texts = rows.suffix(4).compactMap { if case .assistantText(let t) = $0.event { return t.text } else { return nil } }
        #expect(texts.count == 4 && texts.allSatisfy { $0.hasPrefix("appended") })
        await client.stop()
    }

    // MARK: - leaving and coming back

    @Test @MainActor func `the background closes the socket after the grace and coming back lands the rows appended while away, once`() async throws {
        var configuration = SocketConfiguration()
        configuration.backgroundGraceMs = 300
        let client = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: try SessionCache.inMemory(), configuration: configuration)
        var quiet = 0
        client.quietly = { body in
            quiet += 1
            body()
        }
        await client.start()
        #expect(await LiveServer.until { client.status.fresh })
        await client.openThread(LiveServer.threadB)
        client.visibleThread = LiveServer.threadB
        #expect(await LiveServer.until { client.threads[LiveServer.threadB]?.isLive == true && (client.threads[LiveServer.threadB]?.rows.count ?? 0) >= 3 })
        let before = client.threads[LiveServer.threadB]!.rows
        let quietBefore = quiet

        await client.setForeground(false)
        #expect(await LiveServer.until { client.status.transport == .suspended })
        #expect(client.threads[LiveServer.threadB]?.isLive == false)
        #expect(client.threads[LiveServer.threadB]?.rows.count == before.count, "the screen keeps what it had")
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadB, "count": 5])

        await client.setForeground(true)
        #expect(await LiveServer.until(15) { client.status.transport == .open && client.threads[LiveServer.threadB]?.isLive == true })
        #expect(await LiveServer.until { (client.threads[LiveServer.threadB]?.rows.count ?? 0) == before.count + 5 })
        #expect(await LiveServer.until { client.status.fresh })
        let rows = client.threads[LiveServer.threadB]!.rows
        let seqs = rows.map(\.seq)
        #expect(seqs == seqs.sorted())
        #expect(Set(seqs).count == seqs.count)
        #expect(seqs.last! - seqs.first! + 1 == seqs.count, "no gap in \(seqs)")
        #expect(Array(rows.prefix(before.count)) == before, "the rows that were there are the same rows")
        #expect(quiet == quietBefore + 1, "the thread on screen caught up with its own motion; only the list, which nobody is looking at, republished quietly (the thread's meta moved)")
        await client.stop()
    }

    @Test @MainActor func `a cold launch paints the thread you left from the cache and the catch-up applies as a diff`() async throws {
        let cache = try SessionCache.inMemory()
        let first = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: cache)
        await first.start()
        #expect(await LiveServer.until { first.status.fresh })
        await first.openThread(LiveServer.threadB)
        #expect(await LiveServer.until { first.threads[LiveServer.threadB]?.isLive == true })
        let left = first.threads[LiveServer.threadB]!.rows
        let listed = first.sessions
        await first.stop()
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadB, "count": 3])

        // The next launch: the screen is painted from the cache before anything connects.
        let next = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: cache)
        await next.openThread(LiveServer.threadB)
        #expect(next.threads[LiveServer.threadB]?.rows == left)
        #expect(next.threads[LiveServer.threadB]?.isLoading == false)
        #expect(next.threads[LiveServer.threadB]?.isLive == false)
        await next.start()
        #expect(next.sessions == listed, "the shell is the one the last run saw")
        #expect(await LiveServer.until(15) { next.threads[LiveServer.threadB]?.isLive == true && (next.threads[LiveServer.threadB]?.rows.count ?? 0) == left.count + 3 })
        let rows = next.threads[LiveServer.threadB]!.rows
        #expect(Array(rows.prefix(left.count)) == left)
        #expect(Set(rows.map(\.seq)).count == rows.count)
        await next.stop()
    }

    @Test @MainActor func `a second launch reconciles the list from the saved cursor`() async throws {
        let cache = try SessionCache.inMemory()
        let first = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: cache)
        await first.start()
        #expect(await LiveServer.until { first.status.fresh })
        #expect(first.shellSource == .list, "the first launch has no cursor and lists whole")
        let head = try #require(first.listCursor)
        let listedB = try #require(first.session(LiveServer.threadB))
        await first.stop()
        #expect(try await cache.cursor(LiveServer.environmentId) == head)
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadB, "count": 2])

        let next = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: cache)
        await next.start()
        #expect(next.shellSource == .cache, "the shell painted from the cache before anything connected")
        #expect(next.listCursor == head)
        #expect(await LiveServer.until(15) { next.status.fresh })
        #expect(next.shellSource == .changes, "the list reconciled from the cursor instead of listing whole")
        let reconciled = try #require(next.session(LiveServer.threadB))
        #expect(reconciled.updatedAt > listedB.updatedAt, "the thread that moved while away carries its new updatedAt")
        #expect(Set(next.sessions.map(\.id)).isSuperset(of: [LiveServer.threadA, LiveServer.threadB]))
        let cursor = try #require(next.listCursor)
        #expect(cursor.generation == head.generation)
        #expect(cursor.seq > head.seq, "the cursor moved past the append")
        #expect(await LiveServer.until { (try? await cache.cursor(LiveServer.environmentId)) == cursor })
        await next.stop()
    }

    @Test @MainActor func `a host that is down leaves the other host's client untouched`() async throws {
        let live = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: try SessionCache.inMemory())
        let keys = InMemoryKeyStore()
        try keys.set("tc_dead.secret", for: "env_dead")
        let dead = EnvironmentClient(environment: PairedEnvironment(id: "env_dead", name: "dead host", origin: URL(string: "http://127.0.0.1:9")!, caps: [.read], keyId: "dead", keyName: "ios-test", addedAt: 0), keys: keys, cache: try SessionCache.inMemory())
        await live.start()
        await dead.start()
        #expect(await LiveServer.until { live.status.fresh })
        #expect(await LiveServer.until(15) { dead.status.attempts >= 1 && dead.status.nextRetryAt != nil })
        #expect(dead.status.transport == .connecting)
        await live.openThread(LiveServer.threadB)
        #expect(await LiveServer.until { live.threads[LiveServer.threadB]?.isLive == true })
        let before = live.threads[LiveServer.threadB]?.rows.count ?? 0
        _ = try await LiveServer.control("/append", ["sessionId": LiveServer.threadB, "count": 2])
        #expect(await LiveServer.until { (live.threads[LiveServer.threadB]?.rows.count ?? 0) == before + 2 })
        #expect(live.status.fresh)
        await dead.stop()
        await live.stop()
    }

    @Test func `revoking the key closes the socket as unauthorized and nothing retries`() async throws {
        // A second key so the suite's own key survives.
        let api = RemoteAPI()
        let hello = try await api.hello(origin: LiveServer.baseURL, key: LiveServer.key)
        #expect(hello.key != nil)
        let state = try await LiveServer.control("/state")
        _ = state
        let keys = try LiveServer.keys()
        let socket = TempCodeSocket(environment: LiveServer.environment(), keys: keys)
        await socket.start()
        #expect(await LiveServer.until { await socket.status.transport == .open })
        // Revoke through the control panel; this is the suite's only key, so run last.
        _ = try await LiveServer.control("/revoke", ["keyId": LiveServer.keyId])
        #expect(await LiveServer.until { await socket.status.transport == .unauthorized })
        let status = await socket.status
        #expect(status.lastError == "the key was revoked" || status.lastError?.contains("credential") == true, "\(status.lastError ?? "")")
        #expect(status.nextRetryAt == nil)
        await socket.stop()
    }

    @MainActor
    @Test(.enabled(if: LiveServer.hasSecondHost, "needs the second test host: bun run ios:test:client"))
    func `two hosts: one project paired by folder name, a cross-host child placed on the second host, media stamped with its host`() async throws {
        let primary = EnvironmentClient(environment: LiveServer.environment(), keys: try LiveServer.keys(), cache: try SessionCache.inMemory())
        let second = EnvironmentClient(environment: LiveServer.secondEnvironment(), keys: try LiveServer.secondKeys(), cache: try SessionCache.inMemory())
        await primary.start()
        await second.start()
        #expect(await LiveServer.until { primary.status.fresh && second.status.fresh })

        // The same folder name on both hosts: one pair with two members.
        let pairs = ProjectPairs.pairs([
            HostWorkspaces(environmentId: primary.environment.id, workspaces: primary.workspaces),
            HostWorkspaces(environmentId: second.environment.id, workspaces: second.workspaces)
        ])
        let pair = try #require(pairs.first { $0.id == "name:ios-workspace" })
        #expect(pair.isPaired)
        #expect(pair.members.map(\.environmentId) == [primary.environment.id, second.environment.id])
        #expect(pair.members.allSatisfy { $0.name == "ios-workspace" })
        let paired: Set<String> = [primary.environment.id, second.environment.id]

        // The primary's thread spawned one child on the second host and one on a host nobody pairs.
        await primary.openThread(LiveServer.threadCrossHost)
        #expect(await LiveServer.until { CrossHost.hosts(in: primary.threads[LiveServer.threadCrossHost]?.rows ?? []).count == 2 })
        let hosts = CrossHost.hosts(in: primary.threads[LiveServer.threadCrossHost]?.rows ?? [])
        #expect(hosts["ios-xhost-child"] == second.environment.id)
        #expect(hosts["ios-ghost-child"] == "env_" + String(repeating: "a", count: 22))
        let child = CrossHost.placement(childSessionId: "ios-xhost-child", environmentId: hosts["ios-xhost-child"], home: primary.environment.id, paired: paired)
        #expect(child.remote && child.paired && child.environmentId == second.environment.id)
        let ghost = CrossHost.placement(childSessionId: "ios-ghost-child", environmentId: hosts["ios-ghost-child"], home: primary.environment.id, paired: paired)
        #expect(ghost.remote && !ghost.paired)
        #expect(second.sessions.contains { $0.id == "ios-xhost-child" && $0.parentId == LiveServer.threadCrossHost })
        #expect(!primary.sessions.contains { $0.id == "ios-xhost-child" })

        // fs.media stamps the minting host on every URL.
        await primary.openThread(LiveServer.threadChat)
        #expect(await LiveServer.until { primary.threads[LiveServer.threadChat]?.rows.contains { if case .userText(let t) = $0.event { return t.attachments?.isEmpty == false } else { return false } } == true })
        let attachment = try #require(primary.threads[LiveServer.threadChat]?.rows.lazy.compactMap { row -> Attachment? in
            if case .userText(let t) = row.event { return t.attachments?.first } else { return nil }
        }.first)
        let media = try #require(try await primary.request(Methods.FsMedia.self, .init(path: attachment.path)))
        let url = try #require(URL(string: media.url))
        #expect(PathHost.environment(ofMediaURL: url) == primary.environment.id)
        await primary.stop()
        await second.stop()
    }
}
