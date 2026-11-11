import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's host naming rule; src/shared/hostNames.test.ts holds the desktop's copy to the same cases.
@Suite struct HostNamesTests {
    @Test(arguments: [
        ("Mac.attlocal.net", "Mac"),
        ("Landons-MBP.attlocal.net", "Landons-MBP"),
        ("studio.local", "studio"),
        ("  box.lan  ", "box"),
        ("tempcode-box", "tempcode-box"),
        ("192.168.1.20", "192.168.1.20"),
        ("fe80::1", "fe80::1"),
        (".hidden", ".hidden")
    ])
    func `a hostname loses its network domain, an address or bare name stays whole`(name: String, short: String) {
        #expect(HostNames.short(name) == short)
    }

    @Test func `labels shorten unique names, keep namesakes whole and never shorten the person's name`() {
        let unique = HostNames.labels([.init(id: "box", name: "tempcode-box"), .init(id: "mac", name: "Mac.attlocal.net")])
        #expect(unique == ["box": "tempcode-box", "mac": "Mac"])
        let clash = HostNames.labels([
            .init(id: "a", name: "Mac.attlocal.net"),
            .init(id: "b", name: "mac.home"),
            .init(id: "c", name: "Mac", custom: true),
            .init(id: "d", name: "My.Box", custom: true)
        ])
        #expect(clash == ["a": "Mac.attlocal.net", "b": "mac.home", "c": "Mac", "d": "My.Box"])
    }

    @Test func `a down row of a machine that came back under a new id, or of the carrier, is a past identity`() {
        let list = [
            presence(id: "env_mac", name: "Mac", link: "up", since: 3_000),
            presence(id: "env_mac_old", name: "Mac.attlocal.net", link: "down", since: 2_000),
            presence(id: "env_box_old", name: "tempcode-box", platform: "linux", link: "down", since: 1_000),
            presence(id: "env_studio", name: "Studio", link: "down", since: 1_000),
            presence(id: "env_unknown", name: "Mac", platform: "unknown", link: "down", since: 1_000)
        ]
        let past = HostNames.pastIdentities(list, carrierName: "tempcode-box.lan", carrierPlatform: "linux")
        #expect(past == ["env_mac_old", "env_box_old"])
    }

    @Test func `two live machines of one name keep both rows, and one that went down after the other came up stays`() {
        let list = [
            presence(id: "env_a", name: "Mac", link: "up", since: 1_000),
            presence(id: "env_b", name: "Mac", link: "down", since: 2_000)
        ]
        #expect(HostNames.pastIdentities(list, carrierName: nil, carrierPlatform: nil).isEmpty)
    }

    @Test @MainActor func `apply leaves out a past identity of a listed host or of the carrier`() {
        let directory = FileManager.default.temporaryDirectory.appending(path: "tc-host-names-\(UUID().uuidString)")
        let store = RelayedHosts(directory: directory, now: { 1 })
        let carrier = PairedEnvironment(id: "env_box", name: "tempcode-box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iPhone", addedAt: 0, platform: "linux")
        store.apply([
            presence(id: "env_mac", name: "Mac.attlocal.net", link: "up", since: 3_000),
            presence(id: "env_mac_old", name: "Mac.attlocal.net", link: "down", since: 2_000),
            presence(id: "env_box_old", name: "tempcode-box", platform: "linux", link: "down", since: 1_000)
        ], via: "env_box", carrier: carrier)
        #expect(store.hosts.map(\.id) == ["env_mac"])
    }
}
