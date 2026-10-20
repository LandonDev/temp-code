import Foundation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A ticket mint the test switches between answering and refusing.
private final class FakeMint: Sendable {
    private let state = Mutex<(count: Int, failure: RemoteAPIError?)>((0, nil))

    var count: Int { state.withLock { $0.count } }
    func fail(_ error: RemoteAPIError?) { state.withLock { $0.failure = error } }

    var mint: TicketMint {
        { [self] () throws(RemoteAPIError) -> String in
            let (n, failure) = state.withLock { state -> (Int, RemoteAPIError?) in
                state.count += 1
                return (state.count, state.failure)
            }
            if let failure { throw failure }
            return "ticket-\(n)"
        }
    }
}

private final class StatusLog: Sendable {
    let items = Mutex<[EnvironmentStatus]>([])
}

/// A socket under test: fake sockets, a manual clock, a scripted mint.
private final class Rig: Sendable {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let mint = FakeMint()
    let socket: TempCodeSocket
    let seen = StatusLog()
    let watcher: Task<Void, Never>

    init(environmentId: String = "env_test", configure: (inout SocketConfiguration) -> Void = { _ in }) {
        var config = SocketConfiguration()
        configure(&config)
        socket = TempCodeSocket(environmentId: environmentId, socketURL: URL(string: "wss://host.example/ws")!, mint: mint.mint, connect: sockets.factory, clock: clock, configuration: config)
        let statuses = socket.statuses
        let log = self.seen
        watcher = Task {
            for await status in statuses { log.items.withLock { $0.append(status) } }
        }
    }

    var states: [TransportState] { seen.items.withLock { $0.map(\.transport) } }

    func status() async -> EnvironmentStatus { await socket.status }

    /// Opens attempt `index`: waits for its socket and answers the hello.
    @discardableResult
    func open(_ index: Int, environmentId: String = "env_test", contract: Int = contractVersion) async -> FakeWebSocket {
        let fake = await sockets.socket(index)
        fake.hello(environmentId: environmentId, contract: contract)
        await clock.settle()
        return fake
    }

    /// Waits until the transport state is `state`.
    func wait(for state: TransportState) async -> Bool {
        await wait { $0.transport == state }
    }

    /// Waits until the status satisfies `predicate`.
    func wait(until predicate: @Sendable (EnvironmentStatus) -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate(await socket.status) { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }
}

@Suite struct TempCodeSocketTests {
    @Test func `start mints a ticket, opens the socket with it and goes open on the hello`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.sockets.socket(0)
        #expect(rig.mint.count == 1)
        #expect(rig.sockets.urls[0].absoluteString == "wss://host.example/ws?ticket=ticket-1")
        #expect(await rig.status().transport == .connecting)
        fake.hello(caps: ["read"])
        #expect(await rig.wait(for: .open))
        let status = await rig.status()
        #expect(status.lastHello?.caps == [.read])
        #expect(status.attempts == 0)
        #expect(await rig.socket.isOpen)
    }

    @Test func `a hello from another environment halts until an explicit retry`() async throws {
        let rig = Rig(environmentId: "env_paired")
        await rig.socket.start()
        let first = await rig.open(0, environmentId: "env_other")
        #expect(await rig.wait(for: .offline))
        let status = await rig.status()
        #expect(status.halt == .identityChanged(expected: "env_paired", got: "env_other"))
        #expect(first.cancelledWith?.reason == "protocol")
        await rig.clock.advance(ms: 600_000)
        #expect(rig.sockets.sockets.count == 1)        // nothing retried by itself
        await rig.socket.setForeground(true)             // a foreground probe does not lift the halt
        await rig.clock.settle()
        #expect(rig.sockets.sockets.count == 1)
        await rig.socket.retry()
        await rig.open(1, environmentId: "env_paired")
        #expect(await rig.wait(for: .open))
        #expect(await rig.status().halt == nil)
    }

    @Test func `a contract the app does not speak halts with both versions`() async throws {
        let rig = Rig()
        await rig.socket.start()
        await rig.open(0, contract: contractVersion + 1)
        #expect(await rig.wait(for: .offline))
        #expect(await rig.status().halt == .contractMismatch(app: contractVersion, host: contractVersion + 1))
    }

    @Test func `a failed connect retries on the backoff and the count resets after 30 s up`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let first = await rig.sockets.socket(0)
        first.drop()
        #expect(await rig.wait { $0.attempts == 1 })
        var status = await rig.status()
        #expect(status.transport == .connecting)
        #expect(status.nextRetryAt == 750.0)             // 1 s × 0.75 at random 0
        #expect(status.lastError == "could not connect")

        await rig.clock.advance(ms: 749)
        #expect(rig.sockets.sockets.count == 1)
        await rig.clock.advance(ms: 1)
        let second = await rig.sockets.socket(1)
        second.drop()
        #expect(await rig.wait { $0.attempts == 2 })
        status = await rig.status()
        #expect(status.transport == .connecting)
        #expect(status.nextRetryAt == 2_250.0)           // 750 + 2 s × 0.75

        await rig.clock.advance(ms: 1_500)
        await rig.open(2)
        #expect(await rig.wait(for: .open))
        #expect(await rig.status().attempts == 2)        // not yet: the session has to stay up
        await rig.clock.advance(ms: 29_999)
        #expect(await rig.status().attempts == 2)
        await rig.clock.advance(ms: 1)
        #expect(await rig.status().attempts == 0)

        // A drop after a session was up is `reconnecting`, from the first step again.
        let third = await rig.sockets.socket(2)
        third.serverClose(code: 1006)
        #expect(await rig.wait { $0.attempts == 1 })
        status = await rig.status()
        #expect(status.transport == .reconnecting)
        #expect(status.lastError == "the socket dropped")
        #expect(status.nextRetryAt == rig.clock.now + 750)
    }

    @Test func `the delay caps at five minutes`() async throws {
        let rig = Rig()
        await rig.socket.start()
        var expected = 0.0
        for attempt in 0..<12 {
            let fake = await rig.sockets.socket(attempt)
            fake.drop()
            #expect(await rig.wait { $0.attempts == attempt + 1 })
            // The jitter applies to the capped step: at random 0 the longest wait is 225 s.
            let delay = min(300_000, 1_000 * pow(2, Double(attempt))) * 0.75
            expected += delay
            let next = await rig.status().nextRetryAt
            #expect(next == expected)
            await rig.clock.advance(ms: delay)
        }
        #expect(await rig.status().attempts == 12)
    }

    @Test func `an unauthorized ticket stops the retries; retry mints again`() async throws {
        let rig = Rig()
        rig.mint.fail(.unauthorized("credential required"))
        await rig.socket.start()
        #expect(await rig.wait(for: .unauthorized))
        #expect(await rig.status().lastError == "credential required")
        await rig.clock.advance(ms: 600_000)
        #expect(rig.mint.count == 1)
        await rig.socket.setForeground(true)
        await rig.clock.settle()
        #expect(rig.mint.count == 1)
        rig.mint.fail(nil)
        await rig.socket.retry()
        await rig.open(0)
        #expect(await rig.wait(for: .open))
        #expect(rig.mint.count == 2)
    }

    @Test func `a refused upgrade is unauthorized too`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.sockets.socket(0)
        fake.refuseUpgrade(status: 401)
        #expect(await rig.wait(for: .unauthorized))
        await rig.clock.advance(ms: 600_000)
        #expect(rig.sockets.sockets.count == 1)
    }

    @Test func `a rate-limited mint waits at least Retry-After`() async throws {
        let rig = Rig()
        rig.mint.fail(.rateLimited(retryAfterSeconds: 20))
        await rig.socket.start()
        #expect(await rig.wait { $0.attempts == 1 })
        #expect(await rig.status().nextRetryAt == 20_000)
    }

    @Test func `a good probe marks fresh and a failed probe reconnects at once`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.open(0)
        #expect(await rig.wait(for: .open))

        await rig.socket.probe(.foreground)
        await fake.waitForSent(1)
        #expect(fake.sentRequests[0].method == "workspace.list")
        fake.answer(id: fake.sentRequests[0].id, result: "[]")
        #expect(await rig.wait { $0.fresh })

        await rig.socket.probe(.foreground)
        await fake.waitForSent(2)
        await rig.clock.advance(ms: 4_999)
        #expect(await rig.status().transport == .open)
        await rig.clock.advance(ms: 1)
        // The failed probe closed the session and a new attempt started with no delay.
        let next = await rig.sockets.socket(1)
        #expect(fake.cancelledWith?.reason == "local")
        #expect(await rig.status().transport == .reconnecting)
        #expect(await rig.status().nextRetryAt == nil)
        next.hello()
        #expect(await rig.wait(for: .open))
        #expect(await rig.status().fresh == false)
    }

    @Test func `the background closes the socket after the grace and the foreground reopens it`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.open(0)
        #expect(await rig.wait(for: .open))

        await rig.socket.setForeground(false)
        await rig.clock.advance(ms: 9_999)
        #expect(await rig.status().transport == .open)
        await rig.clock.advance(ms: 1)
        #expect(await rig.wait(for: .suspended))
        #expect(fake.cancelledWith?.reason == "local")
        await rig.clock.advance(ms: 600_000)
        #expect(rig.sockets.sockets.count == 1)         // nothing while in the background

        await rig.socket.setForeground(true)
        let next = await rig.open(1)
        #expect(await rig.wait(for: .open))
        _ = next
        #expect(rig.states.contains(.suspended))
    }

    @Test func `coming forward before the grace ends only probes`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.open(0)
        #expect(await rig.wait(for: .open))
        await rig.socket.setForeground(false)
        await rig.clock.advance(ms: 5_000)
        await rig.socket.setForeground(true)
        await fake.waitForSent(1)
        #expect(fake.sentRequests[0].method == "workspace.list")
        fake.answer(id: fake.sentRequests[0].id, result: "[]")
        #expect(await rig.wait { $0.fresh })
        await rig.clock.advance(ms: 20_000)
        #expect(rig.sockets.sockets.count == 1)
        #expect(fake.cancelledWith == nil)
        #expect(await rig.status().transport == .open)
    }

    @Test func `offline waits and online probes`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.sockets.socket(0)
        fake.drop()
        // Wait for the failed attempt, rather than the initial connecting state.
        #expect(await rig.wait { $0.attempts == 1 })
        await rig.socket.setOnline(false)
        #expect(await rig.wait(for: .offline))
        await rig.clock.advance(ms: 600_000)
        #expect(rig.sockets.sockets.count == 1)
        await rig.socket.setOnline(true)
        await rig.open(1)
        let opened = await rig.wait(for: .open)
        let status = await rig.status()
        #expect(opened, "states \(rig.states) status \(status)")
    }

    @Test func `stop closes the session and nothing comes back`() async throws {
        let rig = Rig()
        await rig.socket.start()
        let fake = await rig.open(0)
        #expect(await rig.wait(for: .open))
        await rig.socket.stop()
        #expect(await rig.wait(for: .offline))
        for _ in 0..<50 where fake.cancelledWith == nil { await Task.yield() }
        #expect(fake.cancelledWith?.reason == "local")
        await rig.clock.advance(ms: 600_000)
        #expect(rig.sockets.sockets.count == 1)
    }

    @Test func `pushes and session events reach the owner across a replacement`() async throws {
        let rig = Rig()
        let events = Mutex<[String]>([])
        let sessions = rig.socket.sessions
        let pushes = rig.socket.pushes
        let collecting = Task {
            for await event in sessions {
                switch event {
                case .opened(let hello): events.withLock { $0.append("opened:\(hello.environmentId)") }
                case .closed(let reason): events.withLock { $0.append("closed:\(reason.kind.rawValue)") }
                }
            }
        }
        let pushing = Task {
            for await push in pushes {
                if case .sessionRemoved(let removed) = push { events.withLock { $0.append("removed:\(removed.sessionIds.joined())") } }
            }
        }
        await rig.socket.start()
        let first = await rig.open(0)
        #expect(await rig.wait(for: .open))
        first.deliver(#"{"push":"session-removed","sessionIds":["a"]}"#)
        await rig.clock.settle()
        first.serverClose(code: 1006)
        #expect(await rig.wait(for: .reconnecting))
        await rig.clock.advance(ms: 750)
        let second = await rig.open(1)
        #expect(await rig.wait(for: .open))
        second.deliver(#"{"push":"session-removed","sessionIds":["b"]}"#)
        await rig.clock.settle()
        for _ in 0..<50 where events.withLock({ $0.count }) < 5 { await Task.yield() }
        #expect(events.withLock { $0 } == ["opened:env_test", "removed:a", "closed:network", "opened:env_test", "removed:b"])
        collecting.cancel()
        pushing.cancel()
    }
}
