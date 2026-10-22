import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The wire's row for a relayed host, as JSON, so the tests never depend on
/// the generated type's memberwise init. Shared with the registry and live suites.
func presenceJSON(id: String = "env_mac", name: String = "Studio Mac", platform: String = "darwin", link: String = "up", screen: String = "unlocked", power: String = "awake", since: Int = 0, build: String = "null") -> String {
    #"{"environmentId":"\#(id)","name":"\#(name)","platform":"\#(platform)","link":"\#(link)","since":\#(since),"screen":"\#(screen)","power":"\#(power)","lastSeenAt":null,"build":\#(build)}"#
}

func presence(id: String = "env_mac", name: String = "Studio Mac", platform: String = "darwin", link: String = "up", screen: String = "unlocked", power: String = "awake", since: Int = 0) -> HostPresence {
    try! JSONDecoder().decode(HostPresence.self, from: Data(presenceJSON(id: id, name: name, platform: platform, link: link, screen: screen, power: power, since: since).utf8))
}

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}()
private let posix = Locale(identifier: "en_US_POSIX")
/// 2026-10-22 12:00:00 UTC.
private let noon = Date(timeIntervalSince1970: 1_792_670_400)
/// 2026-10-22 09:14 UTC, in ms.
private let today914 = 1_792_660_440_000
/// 2026-10-21 09:14 UTC, in ms.
private let yesterday914 = today914 - 86_400_000

@Suite("RelayState")
struct RelayStateTests {
    @Test func `the four states, in the wire's order`() {
        #expect(RelayState(presence()) == .available)
        #expect(RelayState(presence(screen: "locked")) == .locked)
        #expect(RelayState(presence(power: "asleep")) == .asleep)
        #expect(RelayState(presence(link: "down")) == .unreachable)
        // A down link is unreachable whatever the screen says; asleep beats locked.
        #expect(RelayState(presence(link: "down", screen: "locked", power: "asleep")) == .unreachable)
        #expect(RelayState(presence(screen: "locked", power: "asleep")) == .asleep)
    }

    @Test func `unknown screen counts as not locked and unknown power as not asleep`() {
        #expect(RelayState(presence(screen: "unknown", power: "unknown")) == .available)
        #expect(RelayState(presence(screen: "locked", power: "unknown")) == .locked)
    }

    @Test func `only available and locked admit sends`() {
        #expect(RelayState.available.admitsSends)
        #expect(RelayState.locked.admitsSends)
        #expect(!RelayState.asleep.admitsSends)
        #expect(!RelayState.unreachable.admitsSends)
    }
}

@Suite("RelayWords")
struct RelayWordsTests {
    @Test func `since prints the time today and the day and month otherwise`() {
        #expect(RelayWords.since(today914, now: noon, calendar: utc, locale: posix) == "9:14")
        #expect(RelayWords.since(yesterday914, now: noon, calendar: utc, locale: posix) == "21 Oct 9:14")
        #expect(RelayWords.since(today914 + 12 * 3_600_000, now: noon, calendar: utc, locale: posix) == "21:14")
    }

    @Test func `the row line has no subject and says nothing when available`() {
        #expect(RelayWords.rowLine(presence(), lockedSince: nil, now: noon, calendar: utc, locale: posix) == nil)
        #expect(RelayWords.rowLine(presence(screen: "locked"), lockedSince: today914, now: noon, calendar: utc, locale: posix) == "locked since 9:14")
        #expect(RelayWords.rowLine(presence(screen: "locked"), lockedSince: nil, now: noon, calendar: utc, locale: posix) == "locked")
        #expect(RelayWords.rowLine(presence(power: "asleep"), lockedSince: nil, now: noon, calendar: utc, locale: posix) == "asleep")
        #expect(RelayWords.rowLine(presence(link: "down", since: today914), lockedSince: nil, now: noon, calendar: utc, locale: posix) == "unreachable since 9:14")
    }

    @Test func `the subline names the carrier and adds the presence`() {
        #expect(RelayWords.subline(presence(), carrierName: "box", lockedSince: nil, now: noon, calendar: utc, locale: posix) == "through box")
        #expect(RelayWords.subline(presence(power: "asleep"), carrierName: "box", lockedSince: nil, now: noon, calendar: utc, locale: posix) == "through box · asleep")
    }

    @Test func `the strip line speaks only when locked`() {
        #expect(RelayWords.stripLine(presence(screen: "locked"), lockedSince: today914, now: noon, calendar: utc, locale: posix) == "The Mac is locked since 9:14")
        #expect(RelayWords.stripLine(presence(screen: "locked"), lockedSince: nil, now: noon, calendar: utc, locale: posix) == "The Mac is locked")
        #expect(RelayWords.stripLine(presence(), lockedSince: nil, now: noon, calendar: utc, locale: posix) == nil)
        #expect(RelayWords.stripLine(presence(power: "asleep"), lockedSince: nil, now: noon, calendar: utc, locale: posix) == nil)
        #expect(RelayWords.stripLine(presence(link: "down"), lockedSince: nil, now: noon, calendar: utc, locale: posix) == nil)
    }

    @Test func `the held and reconnecting lines, and the subject per platform`() {
        #expect(RelayWords.heldLine(presence(link: "down", since: today914), now: noon, calendar: utc, locale: posix) == "The Mac is unreachable since 9:14")
        #expect(RelayWords.reconnecting(presence()) == "Reconnecting to the Mac…")
        #expect(RelayWords.subject(presence()) == "the Mac")
        #expect(RelayWords.subject(presence(name: "box", platform: "linux")) == "box")
        #expect(RelayWords.heldLine(presence(name: "box", platform: "linux", link: "down", since: today914), now: noon, calendar: utc, locale: posix) == "Box is unreachable since 9:14")
    }
}

@Suite("RelayRefusal")
struct RelayRefusalTests {
    @Test func `the four wire lines parse with their kind and line`() {
        let locked = RelayRefusal(message: "unavailable: the Mac is locked")
        #expect(locked?.kind == .locked)
        #expect(locked?.line == "The Mac is locked")
        let asleep = RelayRefusal(message: "unavailable: the Mac is asleep")
        #expect(asleep?.kind == .asleep)
        #expect(asleep?.line == "The Mac is asleep")
        let unreachable = RelayRefusal(message: "unavailable: the Mac is unreachable since 09:14")
        #expect(unreachable?.kind == .unreachable)
        #expect(unreachable?.line == "The Mac is unreachable since 09:14")
        let cut = RelayRefusal(message: "linkDown: the Mac is unreachable since 09:14")
        #expect(cut?.kind == .linkDown)
        #expect(cut?.line == "The Mac is unreachable since 09:14")
    }

    @Test func `anything else is not a relay refusal`() {
        #expect(RelayRefusal(message: "forbidden: session.send needs operate") == nil)
        #expect(RelayRefusal(message: "no such session") == nil)
        #expect(RelayRefusal(message: "") == nil)
        #expect(RelayRefusal(message: "unavailable: ") == nil)
        #expect(RelayRefusal(message: "unavailable: the host is busy") == nil)
    }

    @Test func `an action's refusal carries the host's line`() {
        let wrapped = ActionError.wrap(TransportError.server(method: "session.send", message: "unavailable: the Mac is asleep"))
        #expect(wrapped == .refused(message: "The Mac is asleep", forbidden: false))
        let cut = ActionError.wrap(TransportError.server(method: "session.list", message: "linkDown: the Mac is unreachable since 09:14"))
        #expect(cut == .refused(message: "The Mac is unreachable since 09:14", forbidden: false))
    }
}

@Suite("Relay blocks")
struct RelayBlockTests {
    @Test func `the two blocks say the state and are transient`() {
        #expect(ActionBlock.hostAsleep(subject: "the Mac").text(now: 0) == "The Mac is asleep: reading only until it wakes")
        #expect(ActionBlock.hostUnreachable(subject: "the Mac", since: "9:14").text(now: 0) == "The Mac is unreachable since 9:14")
        #expect(ActionBlock.hostAsleep(subject: "box").text(now: 0) == "Box is asleep: reading only until it wakes")
        #expect(ActionBlock.hostAsleep(subject: "the Mac").isTransient)
        #expect(ActionBlock.hostUnreachable(subject: "the Mac", since: "9:14").isTransient)
    }

    @Test @MainActor func `relayBlock is nil for available and locked, and the composer's line otherwise`() throws {
        let environment = PairedEnvironment(id: "env_mac", name: "Studio Mac", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 0, via: "env_box")
        let keys = InMemoryKeyStore()
        let cache = try SessionCache.inMemory()
        #expect(EnvironmentClient(environment: environment, keys: keys, cache: cache, presence: presence()).relayBlock == nil)
        #expect(EnvironmentClient(environment: environment, keys: keys, cache: cache, presence: presence(screen: "locked")).relayBlock == nil)
        #expect(EnvironmentClient(environment: environment, keys: keys, cache: cache, presence: presence(power: "asleep")).relayBlock == .hostAsleep(subject: "the Mac"))
        let down = EnvironmentClient(environment: environment, keys: keys, cache: cache, presence: presence(link: "down", since: 0))
        guard case .hostUnreachable(let subject, _)? = down.relayBlock else {
            Issue.record("a down link should block as unreachable")
            return
        }
        #expect(subject == "the Mac")
        // A paired host has no presence and no block.
        let paired = PairedEnvironment(id: "env_box", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 0)
        #expect(EnvironmentClient(environment: paired, keys: keys, cache: cache).relayBlock == nil)
        #expect(EnvironmentClient(environment: paired, keys: keys, cache: cache).relayState == nil)
    }
}

@Suite("Relayed environment")
struct RelayedEnvironmentTests {
    @Test func `the relayed environment borrows the carrier's origin, key and caps under its own id`() {
        let carrier = PairedEnvironment(id: "env_box", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 5)
        let host = RelayedHost(id: "env_mac", via: "env_box", presence: presence(), learnedAt: 9)
        let relayed = PairedEnvironment.relayed(host, through: carrier)
        #expect(relayed.id == "env_mac")
        #expect(relayed.name == "Studio Mac")
        #expect(relayed.origin == carrier.origin)
        #expect(relayed.caps == carrier.caps)
        #expect(relayed.keyId == "K1")
        #expect(relayed.keyName == "iphone")
        #expect(relayed.addedAt == 9)
        #expect(relayed.via == "env_box")
        #expect(relayed.isRelayed)
        #expect(relayed.keyOwner == "env_box")
        #expect(relayed.socketURL.absoluteString == "wss://box.example/ws?host=env_mac")
        #expect(!carrier.isRelayed)
        #expect(carrier.keyOwner == "env_box")
        #expect(carrier.socketURL.absoluteString == "wss://box.example/ws")
    }

    @Test func `an environments json from before decodes with no via`() throws {
        let data = Data(#"[{"id":"env_box","name":"box","origin":"https://box.example","caps":["read"],"keyId":"K1","keyName":"iphone","addedAt":1}]"#.utf8)
        let decoded = try JSONDecoder().decode([PairedEnvironment].self, from: data)
        #expect(decoded.first?.via == nil)
        #expect(decoded.first?.isRelayed == false)
    }
}

@Suite("forgetCopy")
struct ForgetCopyTests {
    @Test func `names the relayed hosts that go with the carrier`() {
        let base = forgetCopy(carrier: "box", relayed: [])
        #expect(base.hasPrefix("Its threads stay on the host"))
        #expect(!base.contains("with it"))
        #expect(forgetCopy(carrier: "box", relayed: ["Studio Mac"]) == "\(base) Studio Mac goes with it.")
        #expect(forgetCopy(carrier: "box", relayed: ["Studio Mac", "Office Mac"]) == "\(base) Studio Mac and Office Mac go with it.")
        #expect(forgetCopy(carrier: "box", relayed: ["A", "B", "C"]).hasSuffix("A, B and C go with it."))
    }

    @Test func `a relayed host has no fix of its own`() {
        let relayed = PairedEnvironment(id: "env_mac", name: "Studio Mac", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0, via: "env_box")
        #expect(HostFix.fix(for: EnvironmentStatus(transport: .reconnecting), environment: relayed) == nil)
        #expect(HostFix.fix(for: EnvironmentStatus(transport: .unauthorized), environment: relayed) == nil)
        #expect(HostFix.fix(for: EnvironmentStatus(transport: .reconnecting)) == .retry)
        #expect(HostBuildLine.text(version: "1.0.300", sha: "5edeb5dabc") == "1.0.300 · 5edeb5d")
        #expect(HostBuildLine.text(version: "1.0.300", sha: nil) == "1.0.300")
    }
}
