import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A client on a fake socket whose host answers the shell and the push calls.
@MainActor
private final class PushRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let cache: SessionCache
    let defaults: UserDefaults
    let registrar: PushRegistrar
    let environment = PairedEnvironment(id: "env_push", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
    let client: EnvironmentClient

    init() throws {
        cache = try SessionCache.inMemory()
        defaults = UserDefaults(suiteName: "push-tests-\(UUID().uuidString)")!
        registrar = PushRegistrar(defaults: defaults)
        try keys.set("tc_K1.secret", for: "env_push")
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: cache, api: api, connect: sockets.factory, clock: clock)
        client.push = registrar
    }

    /// Opens the socket and answers the shell listing and every push call as the host would.
    func open(status: PushStatus) async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(environmentId: "env_push")
        Task { await self.answer(fake, status: status) }
        return fake
    }

    private func answer(_ fake: FakeWebSocket, status: PushStatus) async {
        var answered: Set<String> = []
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                // The client asks for the change log at open; reset makes it list whole.
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [], cursor: nil)))
                case "remote.push.register", "remote.push.status": fake.answer(id: sent.id, result: json(status))
                case "remote.push.unregister": fake.answer(id: sent.id, result: json(PushStatus(registered: false, relay: .none, error: nil, events: [], updatedAt: nil)))
                case "remote.push.activity": fake.answer(id: sent.id, result: "null")
                default: continue
                }
                answered.insert(sent.id)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func waitFor(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            let matching = fake.sentRequests.filter { $0.method == method }
            if matching.count >= count { return matching[count - 1] }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }
}

private let device = PushRegistrar.Device(token: String(repeating: "ab", count: 32), bundleId: "dev.landon.tempcode.ios", environment: .sandbox)
private let registered = PushStatus(registered: true, relay: .ok, error: nil, events: [.needsYou], updatedAt: 1)

@Suite("PushTarget")
struct PushTargetTests {
    @Test func readsTheHubPayloadAndTheActivityURL() {
        let payload: [AnyHashable: Any] = ["aps": ["alert": ["title": "t"]], "tc": ["event": "needs_you", "hostId": "box", "environmentId": "env_box", "threadId": "s1", "seq": 42, "ts": 1]]
        #expect(PushTarget(userInfo: payload) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 42))
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1", "seq": "7"]]) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 7))
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1"]])?.seq == nil)
        // A host-down notice names no thread: nothing to open.
        #expect(PushTarget(userInfo: ["tc": ["event": "host_down", "hostId": "box", "environmentId": "env_box"]]) == nil)
        #expect(PushTarget(userInfo: [:]) == nil)
        #expect(PushTarget(url: URL(string: "tempcode://thread/env_box/s1?seq=12")!) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 12))
        #expect(PushTarget(url: URL(string: "tempcode://thread/env_box/s1")!) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: nil))
        #expect(PushTarget(url: URL(string: "tempcode://settings")!) == nil)
        #expect(PushTarget(url: URL(string: "https://box.example/thread/env/s1")!) == nil)
    }
}

@Suite("PushRegistrar")
struct PushRegistrarTests {
    @Test func summaryReadsTheSwitchThePermissionTheTokenAndTheHosts() {
        let off = PushStatus(registered: true, relay: .none, error: nil, events: [], updatedAt: nil)
        let failed = PushStatus(registered: true, relay: .failed, error: "HTTP 503", events: [], updatedAt: nil)
        #expect(PushRegistrar.summary(enabled: false, permission: .granted, hasDevice: true, tokenError: nil, statuses: [registered], failures: []) == "Off")
        #expect(PushRegistrar.summary(enabled: true, permission: .denied, hasDevice: false, tokenError: nil, statuses: [], failures: []) == "Not allowed")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: false, tokenError: nil, statuses: [], failures: []) == "Registering…")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: false, tokenError: "no network", statuses: [], failures: []) == "Failed")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: true, tokenError: nil, statuses: [], failures: []) == "Registering…")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: true, tokenError: nil, statuses: [off, registered], failures: []) == "On")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: true, tokenError: nil, statuses: [off], failures: []) == "No relay")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: true, tokenError: nil, statuses: [failed], failures: []) == "Failed")
        #expect(PushRegistrar.summary(enabled: true, permission: .granted, hasDevice: true, tokenError: nil, statuses: [], failures: ["This key can read but not act"]) == "Failed")
    }

    @Test @MainActor func registersOnceAtOpenAndAgainOnlyForANewToken() async throws {
        let rig = try PushRig()
        await rig.registrar.setEnabled(true, clients: [])
        await rig.registrar.setDevice(device, clients: [])
        let fake = await rig.open(status: registered)
        let sent = await rig.waitFor(fake, "remote.push.register")
        #expect(sent != nil)
        if case .object(let fields)? = sent?.params {
            #expect(fields["token"] == .string(device.token))
            #expect(fields["bundleId"] == .string("dev.landon.tempcode.ios"))
            #expect(fields["environment"] == .string("sandbox"))
        } else {
            Issue.record("no params")
        }
        #expect(await rig.wait { rig.registrar.statuses["env_push"] == registered })
        #expect(rig.registrar.summary == "On")
        // The same token again is a status read, not a second registration.
        await rig.registrar.sync(rig.client)
        #expect(await rig.waitFor(fake, "remote.push.status") != nil)
        #expect(fake.sentRequests.filter { $0.method == "remote.push.register" }.count == 1)
        // A rotated token registers again; the switch off unregisters.
        let rotated = PushRegistrar.Device(token: String(repeating: "cd", count: 32), bundleId: device.bundleId, environment: .sandbox)
        await rig.registrar.setDevice(rotated, clients: [rig.client])
        #expect(await rig.waitFor(fake, "remote.push.register", count: 2) != nil)
        await rig.registrar.setEnabled(false, clients: [rig.client])
        #expect(await rig.waitFor(fake, "remote.push.unregister") != nil)
        #expect(rig.registrar.summary == "Off")
        // What a host holds survives a relaunch of the registrar on the same defaults.
        await rig.registrar.setEnabled(true, clients: [])
        await rig.registrar.setDevice(device, clients: [rig.client])
        #expect(await rig.waitFor(fake, "remote.push.register", count: 3) != nil)
        let again = PushRegistrar(defaults: rig.defaults)
        #expect(again.enabled)
        await again.setDevice(device, clients: [])
        rig.client.push = again
        await again.sync(rig.client)
        #expect(await rig.waitFor(fake, "remote.push.status", count: 2) != nil)
        #expect(fake.sentRequests.filter { $0.method == "remote.push.register" }.count == 3)
        // The activity token rides the same socket.
        await again.setActivityToken(rig.client, sessionId: "s1", token: device.token)
        let activity = await rig.waitFor(fake, "remote.push.activity")
        if case .object(let fields)? = activity?.params {
            #expect(fields["sessionId"] == .string("s1"))
            #expect(fields["token"] == .string(device.token))
        } else {
            Issue.record("no activity params")
        }
        await again.setActivityToken(rig.client, sessionId: "s1", token: nil)
        let ended = await rig.waitFor(fake, "remote.push.activity", count: 2)
        if case .object(let fields)? = ended?.params {
            #expect(fields["token"] == .null)
        } else {
            Issue.record("no end params")
        }
        await rig.client.stop()
    }
}
