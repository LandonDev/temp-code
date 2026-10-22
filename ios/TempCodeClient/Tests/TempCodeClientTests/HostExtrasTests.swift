import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A client on fake sockets with a manual clock, its socket opened with a
/// hello, for the host detail's stores (Client/HostExtras.swift).
@MainActor
private final class ExtrasRig {
    let clock = ManualClock(now: 1_000_000, random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let client: EnvironmentClient
    var extras: HostExtras { client.extras }

    init(caps: [Capability]) throws {
        try keys.set("tc_K1.secret", for: "env_test")
        let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            let body = #"{"ticket":"t","expiresIn":30}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    /// Starts the client and opens its first socket.
    func open(caps: [String]) async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: caps)
        _ = await waitAsync { await self.client.socket.isOpen }
        return fake
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    func waitAsync(_ predicate: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    /// The `count`-th request of `method` on `fake`, once it was sent.
    func request(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            let matching = fake.sentRequests.filter { $0.method == method }
            if matching.count >= count { return matching[count - 1] }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }

    func sentCount(_ fake: FakeWebSocket, _ method: String) -> Int {
        fake.sentRequests.filter { $0.method == method }.count
    }
}

private func report(_ mac: String, load: Double) -> HostDevicesReport {
    HostDevicesReport(
        environmentId: mac,
        at: 1,
        simulators: [Simulator(udid: "U1", name: "iPhone 17 Pro", runtime: "iOS 26.0", state: .booted, cpu: 12, holder: nil)],
        phones: [],
        xcode: nil,
        load: HostLoad(oneMinute: load, cores: 10),
        problems: []
    )
}

private func status(_ phase: String, exit: String = "null", startedAt: String = "100") -> String {
    #"{"job":"deploy","phase":"\#(phase)","target":"master","startedAt":\#(startedAt),"finishedAt":null,"exit":\#(exit),"stoppable":false}"#
}

private func deployStatus(_ phase: String, exit: String = "null") -> String {
    #"{"job":"deploy","phase":"\#(phase)","target":"master","startedAt":100,"finishedAt":null,"exit":\#(exit),"stoppable":false,"installed":true,"installHint":"x","version":"1.0.270"}"#
}

private let forbiddenDeploy = "forbidden: host.deployStatus needs admin"

/// Set when a poll loop returned on its own.
@MainActor
private final class Flag {
    var on = false
}

@MainActor
@Suite struct HostExtrasTests {
    @Test func `the devices watch names the Mac, lands its report and the pushes, and unwatches on cancel`() async throws {
        let rig = try ExtrasRig(caps: [.read])
        let fake = await rig.open(caps: ["read"])
        let run = Task { await rig.extras.run(.devices("env_mac")) }
        let watch = try #require(await rig.request(fake, "host.devices.watch"))
        #expect(watch.params == .object(["environmentId": .string("env_mac")]))
        fake.answer(id: watch.id, result: json(report("env_mac", load: 2.1)))
        #expect(await rig.wait { rig.extras.devices["env_mac"]?.report?.load.oneMinute == 2.1 })
        #expect(rig.extras.devices["env_mac"]?.lastReportAt == rig.clock.now)
        fake.deliver(#"{"push":"host.devices","report":\#(json(report("env_mac", load: 3.4)))}"#)
        #expect(await rig.wait { rig.extras.devices["env_mac"]?.report?.load.oneMinute == 3.4 })
        // Fresh reports: no second watch on the next round.
        await rig.clock.advance(ms: HostExtras.devicesEveryMs)
        #expect(rig.sentCount(fake, "host.devices.watch") == 1)
        run.cancel()
        let unwatch = try #require(await rig.request(fake, "host.devices.unwatch"))
        #expect(unwatch.params == .object(["environmentId": .string("env_mac")]))
    }

    @Test func `a lost watch is sent again once the reports go stale`() async throws {
        let rig = try ExtrasRig(caps: [.read])
        let fake = await rig.open(caps: ["read"])
        let run = Task { await rig.extras.run(.devices("env_mac")) }
        let first = try #require(await rig.request(fake, "host.devices.watch"))
        fake.answer(id: first.id, result: json(report("env_mac", load: 2.1)))
        #expect(await rig.wait { rig.extras.devices["env_mac"]?.report != nil })
        await rig.clock.advance(ms: HostExtras.devicesEveryMs)
        await rig.clock.advance(ms: HostExtras.devicesEveryMs)
        #expect(await rig.request(fake, "host.devices.watch", count: 2) != nil)
        run.cancel()
    }

    @Test func `the deploy poll runs on its cadence and stops at a forbidden answer`() async throws {
        let rig = try ExtrasRig(caps: [.read])
        let fake = await rig.open(caps: ["read"])
        let finished = Flag()
        let run = Task {
            await rig.extras.run(.deploy)
            finished.on = true
        }
        let first = try #require(await rig.request(fake, "host.deployStatus"))
        fake.answer(id: first.id, result: deployStatus("idle"))
        #expect(await rig.wait { rig.extras.deploy?.phase == .idle })
        await rig.clock.advance(ms: HostExtras.deployEveryMs)
        let second = try #require(await rig.request(fake, "host.deployStatus", count: 2))
        fake.refuse(id: second.id, error: forbiddenDeploy)
        #expect(await rig.wait { finished.on })
        #expect(rig.extras.deployForbidden)
        // An idle deploy never asked for the log.
        #expect(rig.sentCount(fake, "host.log") == 0)
        _ = run
    }

    @Test func `a deploy with a run takes its log, and the pushes reset and append it`() async throws {
        let rig = try ExtrasRig(caps: [.read, .admin])
        let fake = await rig.open(caps: ["read", "admin"])
        let run = Task { await rig.extras.run(.deploy) }
        let poll = try #require(await rig.request(fake, "host.deployStatus"))
        fake.answer(id: poll.id, result: deployStatus("running"))
        let log = try #require(await rig.request(fake, "host.log"))
        #expect(log.params == .object(["job": .string("deploy")]))
        fake.answer(id: log.id, result: #"{"text":"one\ntwo\n","status":\#(status("running"))}"#)
        #expect(await rig.wait { rig.extras.log.text == "one\ntwo\n" })
        #expect(rig.extras.log.following)
        #expect(rig.extras.deployJob?.phase == .running)
        fake.deliver(#"{"push":"host-log","job":"deploy","append":"three\n","status":\#(status("running"))}"#)
        #expect(await rig.wait { rig.extras.log.text == "one\ntwo\nthree\n" })
        fake.deliver(#"{"push":"host-log","job":"deploy","append":"fresh\n","reset":true,"status":\#(status("running", startedAt: "200"))}"#)
        #expect(await rig.wait { rig.extras.log.text == "fresh\n" })
        // The publish job's log is not the phone's.
        fake.deliver(#"{"push":"host-log","job":"publish","append":"nope\n","status":{"job":"publish","phase":"running","target":null,"startedAt":null,"finishedAt":null,"exit":null,"stoppable":true}}"#)
        fake.deliver(#"{"push":"host-log","job":"deploy","status":\#(status("done", exit: "0", startedAt: "200"))}"#)
        #expect(await rig.wait { rig.extras.deployJob?.phase == .done })
        #expect(rig.extras.log.text == "fresh\n")
        // Following already: the next poll does not ask the log again.
        await rig.clock.advance(ms: HostExtras.deployEveryMs)
        let next = try #require(await rig.request(fake, "host.deployStatus", count: 2))
        fake.answer(id: next.id, result: deployStatus("done", exit: "0"))
        await rig.clock.settle()
        #expect(rig.sentCount(fake, "host.log") == 1)
        run.cancel()
    }

    @Test func `startDeploy asks for master and follows the log; a lesser key is refused before the wire`() async throws {
        let rig = try ExtrasRig(caps: [.read, .operate, .approve, .admin])
        let fake = await rig.open(caps: ["read", "operate", "approve", "admin"])
        let start = Task { try await rig.extras.startDeploy() }
        let deploy = try #require(await rig.request(fake, "host.deploy"))
        #expect(deploy.params == .object(["ref": .string("master")]))
        fake.answer(id: deploy.id, result: deployStatus("pending"))
        let log = try #require(await rig.request(fake, "host.log"))
        fake.answer(id: log.id, result: #"{"text":"","status":\#(status("pending"))}"#)
        try await start.value
        #expect(rig.extras.deploy?.phase == .pending)
        #expect(rig.extras.log.following)

        let reader = try ExtrasRig(caps: [.read, .operate])
        let readerSocket = await reader.open(caps: ["read", "operate"])
        await #expect(throws: ActionError.refused(message: HostExtrasAccess.deploy.reason, forbidden: true)) {
            try await reader.extras.startDeploy()
        }
        #expect(reader.sentCount(readerSocket, "host.deploy") == 0)
    }

    @Test func `stopMacCall sends macBridge.stop with the id, then refreshes the activity`() async throws {
        let rig = try ExtrasRig(caps: [.read, .operate])
        let fake = await rig.open(caps: ["read", "operate"])
        let stop = Task { try await rig.extras.stopMacCall(id: "mb_1") }
        let sent = try #require(await rig.request(fake, "macBridge.stop"))
        #expect(sent.params == .object(["id": .string("mb_1")]))
        fake.answer(id: sent.id, result: #"{"ok":true}"#)
        let activity = try #require(await rig.request(fake, "macBridge.activity"))
        fake.answer(id: activity.id, result: #"{"hosts":[],"load":{"load":1.5,"cores":10,"limit":20,"pinned":false,"resumeBelow":15,"busy":false,"sampledAt":1},"calls":[],"at":2}"#)
        try await stop.value
        #expect(rig.extras.macBridge?.load.load == 1.5)
    }

    @Test func `the Mac bridge poll stops when the key may not read it`() async throws {
        let rig = try ExtrasRig(caps: [.read])
        let fake = await rig.open(caps: ["read"])
        let finished = Flag()
        let run = Task {
            await rig.extras.run(.macBridge)
            finished.on = true
        }
        let first = try #require(await rig.request(fake, "macBridge.activity"))
        fake.refuse(id: first.id, error: "forbidden: macBridge.activity is local-only")
        #expect(await rig.wait { finished.on })
        #expect(rig.extras.macBridgeForbidden)
        _ = run
    }

    @Test func `syncNow syncs harness and memory for the peer and lands the answers`() async throws {
        let rig = try ExtrasRig(caps: [.read, .admin])
        let fake = await rig.open(caps: ["read", "admin"])
        let sync = Task { try await rig.extras.syncNow(environmentId: "env_box") }
        let harness = try #require(await rig.request(fake, "harness.sync"))
        let memory = try #require(await rig.request(fake, "memory.sync"))
        #expect(harness.params == .object(["environmentId": .string("env_box")]))
        #expect(memory.params == .object(["environmentId": .string("env_box")]))
        #expect(rig.extras.sync.syncing == ["env_box"])
        fake.answer(id: harness.id, result: #"{"enabled":true,"skipped":0,"environments":[{"id":"env_box","name":"box","connected":true,"running":false,"files":143,"sets":null,"syncedAt":5,"lastAttemptAt":5,"error":null}],"pathMap":{"roots":{},"prefixes":{}}}"#)
        fake.answer(id: memory.id, result: #"{"enabled":true,"skipped":0,"environments":[],"conflicts":[]}"#)
        try await sync.value
        #expect(rig.extras.sync.harness?.environments.first?.files == 143)
        #expect(rig.extras.sync.memory?.enabled == true)
        #expect(rig.extras.sync.syncing.isEmpty)
        #expect(rig.extras.syncLoaded)
    }

    @Test func `a sync read the key may not make marks the section forbidden and stops`() async throws {
        let rig = try ExtrasRig(caps: [.read])
        let fake = await rig.open(caps: ["read"])
        let finished = Flag()
        let run = Task {
            await rig.extras.run(.sync)
            finished.on = true
        }
        let harness = try #require(await rig.request(fake, "harness.status"))
        let memory = try #require(await rig.request(fake, "memory.status"))
        fake.refuse(id: harness.id, error: "forbidden: harness.status needs admin")
        fake.refuse(id: memory.id, error: "forbidden: memory.status needs admin")
        #expect(await rig.wait { finished.on })
        #expect(rig.extras.sync.forbidden)
        #expect(rig.extras.syncLoaded)
        _ = run
    }

    @Test func `a device action marks the device busy and lands the report after it`() async throws {
        let rig = try ExtrasRig(caps: [.read, .operate])
        let fake = await rig.open(caps: ["read", "operate"])
        let act = Task { try await rig.extras.shutdownSimulator(mac: "env_mac", udid: "U1") }
        let sent = try #require(await rig.request(fake, "host.simulator.shutdown"))
        #expect(sent.params == .object(["environmentId": .string("env_mac"), "udid": .string("U1")]))
        #expect(rig.extras.devices["env_mac"]?.busy == "U1")
        fake.answer(id: sent.id, result: json(report("env_mac", load: 1.0)))
        try await act.value
        #expect(rig.extras.devices["env_mac"]?.busy == nil)
        #expect(rig.extras.devices["env_mac"]?.report?.load.oneMinute == 1.0)
    }
}
