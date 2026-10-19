import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct TransportTests {
    let url = URL(string: "wss://host.example/ws?ticket=x")!

    private func transport(_ socket: FakeWebSocket, clock: ManualClock = ManualClock()) -> Transport {
        Transport(url: url, connect: { _ in socket }, clock: clock)
    }

    @Test func `open resolves on the hello and nothing before it counts`() async throws {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        await Task.yield()
        socket.deliver(#"{"push":"sessions","sessions":[]}"#)   // before hello: not the hello
        socket.hello(environmentId: "env_A", caps: ["operate", "read"])
        let hello = try await opening.value
        #expect(hello.environmentId == "env_A")
        #expect(hello.caps == [.operate, .read])
        #expect(await transport.state == .open)
    }

    @Test func `no hello within the timeout closes with a protocol reason`() async throws {
        let clock = ManualClock()
        let socket = FakeWebSocket()
        let transport = transport(socket, clock: clock)
        let opening = Task { try await transport.open() }
        await clock.settle()
        await clock.advance(ms: 9_999)
        #expect(await transport.state == .opening)
        await clock.advance(ms: 1)
        await #expect(throws: TransportError.closed(CloseReason(kind: .protocol, message: "no hello from the server"))) {
            try await opening.value
        }
        #expect(await transport.closeReason?.kind == .protocol)
        #expect(socket.cancelledWith?.reason == "protocol")
    }

    @Test func `requests correlate by id and errors come back typed`() async throws {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        socket.hello()
        _ = try await opening.value

        let first = Task { try await transport.request(Methods.WorkspaceList.self, NoParams()) }
        let second = Task { try await transport.request(Methods.ProjectList.self, NoParams()) }
        await socket.waitForSent(2)
        // Two tasks send in whichever order they run; each answer finds its request by id.
        let sent = socket.sentRequests
        let workspaces = try #require(sent.first { $0.method == "workspace.list" })
        let projects = try #require(sent.first { $0.method == "project.list" })
        #expect(Set(await transport.pendingMethods) == ["workspace.list", "project.list"])

        socket.answer(id: projects.id, result: "[]")
        socket.refuse(id: workspaces.id, error: "forbidden: workspace.list needs read")
        #expect(try await second.value.isEmpty)
        await #expect(throws: TransportError.server(method: "workspace.list", message: "forbidden: workspace.list needs read")) {
            try await first.value
        }
        #expect(await transport.pendingMethods.isEmpty)
    }

    @Test func `a result that is not the method's output is a decoding error`() async throws {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        socket.hello()
        _ = try await opening.value
        let call = Task { try await transport.request(Methods.WorkspaceList.self, NoParams()) }
        await socket.waitForSent(1)
        socket.answer(id: socket.sentRequests[0].id, result: #"{"not":"a list"}"#)
        do {
            _ = try await call.value
            Issue.record("decoded a non-list")
        } catch let error as TransportError {
            guard case .decoding(let method, _) = error else {
                Issue.record("wrong error \(error)")
                return
            }
            #expect(method == "workspace.list")
        }
    }

    @Test func `pushes stream in order and the stream ends on close`() async throws {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        socket.hello()
        _ = try await opening.value
        socket.deliver(#"{"push":"sessions","sessions":[]}"#)
        socket.deliver(#"{"push":"session-removed","sessionIds":["s1"]}"#)
        socket.deliver(#"{"push":"something-new","x":1}"#)
        // A round trip after the pushes proves the reader has folded them in order.
        let call = Task { try await transport.request(Methods.WorkspaceList.self, NoParams()) }
        await socket.waitForSent(1)
        socket.answer(id: socket.sentRequests[0].id, result: "[]")
        _ = try await call.value
        await transport.close()
        var kinds: [String] = []
        for await push in transport.pushes {
            switch push {
            case .sessions: kinds.append("sessions")
            case .sessionRemoved(let removed): kinds.append("removed:\(removed.sessionIds.joined())")
            case .unknown: kinds.append("unknown")
            default: kinds.append("other")
            }
        }
        #expect(kinds == ["sessions", "removed:s1", "unknown"])
    }

    @Test func `a server close maps to the desktop's reasons and settles everything once`() async throws {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        socket.hello()
        _ = try await opening.value
        let waiting = Task { try await transport.request(Methods.WorkspaceList.self, NoParams()) }
        await socket.waitForSent(1)
        let closedA = Task { await transport.closed() }
        let closedB = Task { await transport.closed() }
        socket.serverClose(code: 4001)
        let reason = await closedA.value
        #expect(reason.kind == .unauthorized)
        #expect(reason.code == 4001)
        #expect(await closedB.value == reason)
        await #expect(throws: TransportError.closed(reason)) { try await waiting.value }
        #expect(await transport.closed() == reason)
        await #expect(throws: TransportError.notConnected) {
            try await transport.request(Methods.WorkspaceList.self, NoParams())
        }
    }

    @Test(arguments: [
        (4401, nil, CloseReason.Kind.unauthorized),
        (4403, nil, .unauthorized),
        (1000, nil, .server),
        (1006, nil, .network),
        (nil, 401, .unauthorized),
        (nil, 403, .unauthorized),
        (nil, 429, .network),
        (nil, nil, .network)
    ] as [(Int?, Int?, CloseReason.Kind)])
    func `close codes and upgrade statuses classify`(code: Int?, status: Int?, kind: CloseReason.Kind) {
        let reason = Transport.reason(error: URLError(.networkConnectionLost), closeCode: code, upgradeStatus: status, hadHello: false)
        #expect(reason.kind == kind)
    }

    @Test func `a refused upgrade is unauthorized before any hello`() async {
        let socket = FakeWebSocket()
        let transport = transport(socket)
        let opening = Task { try await transport.open() }
        await Task.yield()
        socket.refuseUpgrade(status: 401)
        do {
            _ = try await opening.value
            Issue.record("opened without a hello")
        } catch let error as TransportError {
            guard case .closed(let reason) = error else {
                Issue.record("wrong error \(error)")
                return
            }
            #expect(reason.kind == .unauthorized)
            #expect(reason.code == 401)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }
}
