import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private let mac = "env_" + String(repeating: "m", count: 22)
private let box = "env_" + String(repeating: "b", count: 22)
private let ghost = "env_" + String(repeating: "a", count: 22)

private func spawned(_ child: String, on host: String? = nil) -> AgentEvent {
    .agentSpawned(AgentSpawnedEvent(childSessionId: child, environmentId: host))
}

@Suite struct CrossHostTests {
    @Test func `decodes a remote id and refuses a local or malformed one`() {
        #expect(CrossHost.decode("\(mac):abc_DEF-123") == RemoteAgentId(environmentId: mac, sessionId: "abc_DEF-123"))
        #expect(CrossHost.decode("abc_DEF-123") == nil)
        #expect(CrossHost.decode("env_short:abc") == nil)
        #expect(CrossHost.decode("\(mac):") == nil)
    }

    @Test func `the first colon splits, so a colon in the session part fails the session rule`() {
        #expect(CrossHost.decode("\(mac):a:b") == nil)
    }

    @Test(arguments: ["abc", "A-b_C", String(repeating: "x", count: 200)])
    func `encode round-trips through decode`(sessionId: String) {
        let encoded = CrossHost.encode(box, sessionId)
        #expect(encoded == "\(box):\(sessionId)")
        #expect(CrossHost.decode(encoded) == RemoteAgentId(environmentId: box, sessionId: sessionId))
    }

    @Test func `a spawn row without a host places the child at home, paired`() {
        let p = CrossHost.placement(childSessionId: "c1", environmentId: nil, home: box, paired: [])
        #expect(p == CrossHost.Placement(environmentId: box, sessionId: "c1", remote: false, paired: true))
    }

    @Test func `a spawn row naming the parent's own host is local`() {
        let p = CrossHost.placement(childSessionId: "c1", environmentId: box, home: box, paired: [])
        #expect(!p.remote)
        #expect(p.paired)
    }

    @Test func `a spawn row naming another host is remote, paired when the registry has it`() {
        let paired = CrossHost.placement(childSessionId: "c1", environmentId: mac, home: box, paired: [box, mac])
        #expect(paired == CrossHost.Placement(environmentId: mac, sessionId: "c1", remote: true, paired: true))
        let unpaired = CrossHost.placement(childSessionId: "c2", environmentId: ghost, home: box, paired: [box, mac])
        #expect(unpaired == CrossHost.Placement(environmentId: ghost, sessionId: "c2", remote: true, paired: false))
    }

    @Test func `an encoded id places the child on its host and a plain id at home`() {
        #expect(CrossHost.placement(agentId: "\(mac):c1", home: box, paired: [mac]) == CrossHost.Placement(environmentId: mac, sessionId: "c1", remote: true, paired: true))
        #expect(CrossHost.placement(agentId: "\(ghost):c1", home: box, paired: [mac]).paired == false)
        #expect(CrossHost.placement(agentId: "c1", home: box, paired: [mac]) == CrossHost.Placement(environmentId: box, sessionId: "c1", remote: false, paired: true))
        #expect(CrossHost.placement(agentId: "bad:c1", home: box, paired: [mac]) == CrossHost.Placement(environmentId: box, sessionId: "bad:c1", remote: false, paired: true))
    }

    @Test func `hosts in rows maps only the spawns that name a host`() {
        let log = rows([
            user("go"),
            spawned("local-child"),
            spawned("mac-child", on: mac),
            call("c1", "Read"),
            spawned("ghost-child", on: ghost)
        ])
        #expect(CrossHost.hosts(in: log) == ["mac-child": mac, "ghost-child": ghost])
    }

    @Test func `the host word names a remote paired child's host and nothing else`() {
        let names = [mac: "Mac", box: "The box"]
        #expect(CrossHost.hostWord(CrossHost.Placement(environmentId: mac, sessionId: "c", remote: true, paired: true), names: names) == "Mac")
        #expect(CrossHost.hostWord(CrossHost.Placement(environmentId: box, sessionId: "c", remote: false, paired: true), names: names) == nil)
        #expect(CrossHost.hostWord(CrossHost.Placement(environmentId: ghost, sessionId: "c", remote: true, paired: false), names: names) == nil)
        #expect(CrossHost.unpairedNote == "on a host this phone is not paired with")
    }
}
