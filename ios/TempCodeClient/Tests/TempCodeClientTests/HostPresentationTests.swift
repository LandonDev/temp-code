import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func status(_ transport: TransportState, attempts: Int = 0, halt: HaltReason? = nil) -> EnvironmentStatus {
    EnvironmentStatus(transport: transport, attempts: attempts, halt: halt)
}

private let identityChanged = HaltReason.identityChanged(expected: "env_a", got: "env_b")
private let hostNewer = HaltReason.contractMismatch(app: 3, host: 4)
private let hostOlder = HaltReason.contractMismatch(app: 4, host: 3)

@Suite("ConnectionWord")
struct ConnectionWordTests {
    @Test(arguments: [
        (status(.open), "Connected"),
        (status(.connecting), "Connecting…"),
        (status(.connecting, attempts: 1), "Unreachable"),
        (status(.reconnecting), "Reconnecting…"),
        (status(.offline), "Offline"),
        (status(.offline, halt: identityChanged), "Different host"),
        (status(.offline, halt: hostNewer), "Needs an update"),
        (status(.unauthorized), "Key refused"),
        (status(.suspended), "Paused"),
    ])
    func `one word per transport state`(status: EnvironmentStatus, word: String) {
        #expect(ConnectionWord.text(for: status) == word)
    }
}

@Suite("abbreviatedEnvironmentId")
struct AbbreviatedEnvironmentIdTests {
    @Test func `a 22-character body keeps its prefix, four head and four tail characters`() {
        #expect(abbreviatedEnvironmentId("env_AbCdEfGhIjKlMnOpQrStUv") == "env_AbCd…StUv")
    }

    @Test func `a short body stays whole`() {
        #expect(abbreviatedEnvironmentId("env_AbCdEfGhIj") == "env_AbCdEfGhIj")
        #expect(abbreviatedEnvironmentId("env_") == "env_")
        #expect(abbreviatedEnvironmentId("") == "")
    }

    @Test func `an id without the prefix is abbreviated without one`() {
        #expect(abbreviatedEnvironmentId("AbCdEfGhIjKlMnOpQrStUv") == "AbCd…StUv")
    }
}

@Suite("sentence")
struct SentenceTests {
    @Test func `capitalises and adds a full stop`() {
        #expect(sentence("that is not a pairing link") == "That is not a pairing link.")
    }

    @Test func `keeps a trailing question or exclamation mark`() {
        #expect(sentence("is the host up?") == "Is the host up?")
        #expect(sentence("refused!") == "Refused!")
        #expect(sentence("already a sentence.") == "Already a sentence.")
    }

    @Test func `trims whitespace and leaves empty alone`() {
        #expect(sentence("  no key for this host \n") == "No key for this host.")
        #expect(sentence("") == "")
        #expect(sentence("   ") == "")
    }
}

@Suite("HostFix")
struct HostFixTests {
    @Test(arguments: [
        (status(.unauthorized), HostFix.pairAgain),
        (status(.reconnecting), .retry),
        (status(.offline), .retry),
        (status(.offline, halt: identityChanged), .pairAgain),
        (status(.offline, halt: hostNewer), nil),
        (status(.connecting), nil),
        (status(.connecting, attempts: 1), .retry),
        (status(.open), nil),
        (status(.suspended), nil),
    ] as [(EnvironmentStatus, HostFix?)])
    func `the one action per state`(status: EnvironmentStatus, fix: HostFix?) {
        #expect(HostFix.fix(for: status) == fix)
    }

    @Test func `titles`() {
        #expect(HostFix.retry.title == "Retry Now")
        #expect(HostFix.pairAgain.title == "Pair Again")
    }

    @Test func `the explanation names which side needs the update`() {
        #expect(HostFix.explanation(for: status(.offline, halt: hostNewer)) == "Update this app to talk to the host.")
        #expect(HostFix.explanation(for: status(.offline, halt: hostOlder)) == "Update the host to talk to this app.")
        #expect(HostFix.explanation(for: status(.open)) == nil)
        #expect(HostFix.explanation(for: status(.connecting)) == nil)
        #expect(HostFix.explanation(for: status(.connecting, attempts: 2)) == "The phone keeps trying on its own; Retry tries now.")
        #expect(HostFix.explanation(for: status(.offline)) == "The phone will try again when the network returns.")
        #expect(HostFix.explanation(for: status(.offline, halt: identityChanged)) == "The address now answers as another host. Pair again to trust it.")
        #expect(HostFix.explanation(for: status(.unauthorized)) == "The host refused this key. A new pairing link from its Remote access pane replaces it.")
        #expect(HostFix.explanation(for: status(.suspended)) == "Reconnects when the app comes forward.")
    }

    @Test(arguments: [
        (status(.unauthorized), true),
        (status(.offline, halt: identityChanged), true),
        (status(.offline, halt: hostNewer), true),
        (status(.offline), false),
        (status(.reconnecting), false),
        (status(.connecting, attempts: 3), false),
        (status(.open), false),
        (status(.suspended), false),
    ])
    func `destructive only when the state waits on the person`(status: EnvironmentStatus, waits: Bool) {
        #expect(HostFix.waitsOnUser(status) == waits)
    }
}

@Suite("HostBuildLine")
struct HostBuildLineTests {
    @Test func `the version and seven characters of the commit`() {
        let build = HelloPush.Build(release: 273, version: "1.0.273", sha: "5edeb5d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7", platform: "darwin")
        #expect(HostBuildLine.text(build) == "1.0.273 · 5edeb5d")
    }

    @Test func `the version alone without a commit`() {
        #expect(HostBuildLine.text(HelloPush.Build(release: 273, version: "1.0.273", sha: nil, platform: "linux")) == "1.0.273")
        #expect(HostBuildLine.text(HelloPush.Build(release: 273, version: "1.0.273", sha: "", platform: "linux")) == "1.0.273")
    }
}

@Suite("HostPushWord")
struct HostPushWordTests {
    private func pushStatus(registered: Bool = true, relay: PushStatus.Relay) -> PushStatus {
        PushStatus(registered: registered, relay: relay, error: nil, events: [], updatedAt: nil)
    }

    @Test func `the switch and the host's failure come first`() {
        #expect(HostPushWord.text(enabled: false, failure: nil, status: pushStatus(relay: .ok)) == "Off")
        #expect(HostPushWord.text(enabled: true, failure: "This key can read but not act", status: pushStatus(relay: .ok)) == "Failed")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: nil) == "Not registered")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(registered: false, relay: .ok)) == "Not registered")
    }

    @Test func `the relay's word once registered`() {
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .ok)) == "On")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .none)) == "No relay")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .failed)) == "Failed")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .unknown("later"))) == "Registered")
    }
}

@Suite("Capability words")
struct CapabilityWordsTests {
    @Test func `the four in the pane's order`() {
        #expect(Capability.ordered == [.read, .operate, .approve, .admin])
        #expect(Capability.ordered.map(\.title) == ["Read", "Operate", "Approve", "Admin"])
        #expect(Capability.read.detail == "See threads, files and the inbox")
        #expect(Capability.operate.detail == "Send turns, stop and start threads")
        #expect(Capability.approve.detail == "Decide approvals and run full-access threads")
        #expect(Capability.admin.detail == "Pair devices, manage keys and move threads")
    }

    @Test func `an unknown capability keeps its raw name`() {
        #expect(Capability.unknown("x").title == "X")
        #expect(Capability.unknown("x").detail == "Not known to this app")
    }
}
