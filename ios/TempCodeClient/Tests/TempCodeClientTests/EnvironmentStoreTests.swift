import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct PairingLinkTests {
    @Test(arguments: [
        ("https://tempcode.landonhale.com/pair#AB1CD-EF2GH", "https://tempcode.landonhale.com", "AB1CD-EF2GH"),
        ("  http://127.0.0.1:7677/pair#ab1cdef2gh\n", "http://127.0.0.1:7677", "AB1CD-EF2GH"),
        ("https://host.example/pair?x=1#AB1CD-EF2GH", "https://host.example", "AB1CD-EF2GH")
    ])
    func `reads the origin and the code`(text: String, origin: String, code: String) {
        let link = PairingLink(text)
        #expect(link?.origin.absoluteString == origin)
        #expect(link?.code == code)
    }

    @Test(arguments: ["AB1CD-EF2GH", "https://host/pair", "https://host/pair#AB1CD", "ftp://host/pair#AB1CD-EF2GH", "not a link"])
    func `refuses anything that is not an http origin plus a code`(text: String) {
        #expect(PairingLink(text) == nil)
    }
}

@Suite struct EnvironmentTests {
    @Test func `the socket url is wss at /ws, or ws behind plain http`() {
        let https = Environment(id: "env_1", name: "box", origin: URL(string: "https://tempcode.landonhale.com")!, caps: [.read], keyId: "k", keyName: "phone", addedAt: 0)
        #expect(https.socketURL.absoluteString == "wss://tempcode.landonhale.com/ws")
        let http = Environment(id: "env_2", name: "dev", origin: URL(string: "http://127.0.0.1:7677")!, caps: [.read], keyId: "k", keyName: "phone", addedAt: 0)
        #expect(http.socketURL.absoluteString == "ws://127.0.0.1:7677/ws")
        #expect(http.host == "127.0.0.1:7677")
    }

    @Test func `read is implied and admin implies everything`() {
        let reader = Environment(id: "e", name: "n", origin: URL(string: "https://h")!, caps: [], keyId: "k", keyName: "p", addedAt: 0)
        #expect(reader.allows(.read))
        #expect(!reader.allows(.operate))
        let admin = Environment(id: "e", name: "n", origin: URL(string: "https://h")!, caps: [.admin], keyId: "k", keyName: "p", addedAt: 0)
        #expect(admin.allows(.approve))
    }
}

/// A fake host for the store: answers pair and hello from canned bodies.
private func fakeHost(environmentId: String = "env_fake", refusePairing: Bool = false) -> RemoteAPI {
    RemoteAPI { request in
        let url = request.url!
        func json(_ status: Int, _ body: String) -> (Data, HTTPURLResponse) {
            (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        switch url.path {
        case "/api/pair":
            if refusePairing { return json(401, #"{"error":"pairing code is not valid"}"#) }
            return json(200, #"{"key":"tc_K1.secret","keyId":"K1","name":"iphone","caps":["read"],"audience":"client","environmentId":"\#(environmentId)"}"#)
        case "/api/hello":
            let known = request.value(forHTTPHeaderField: "Authorization") == "Bearer tc_K1.secret"
            let key = known ? #","key":{"id":"K1","name":"iphone","caps":["read"],"audience":"client"}"# : ""
            return json(200, #"{"environmentId":"\#(environmentId)","name":"box","version":"1.0.240","contract":1\#(key)}"#)
        default:
            return json(404, "not found")
        }
    }
}

@MainActor
@Suite struct EnvironmentStoreTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "tc-env-store-\(UUID().uuidString)")

    @Test func `pairing by link stores the environment and keeps the key out of the file`() async throws {
        let keys = InMemoryKeyStore()
        let store = EnvironmentStore(directory: directory, keys: keys, api: fakeHost())
        let added = try await store.add(pairingLink: "https://box.example/pair#AB1CD-EF2GH")
        #expect(added.id == "env_fake")
        #expect(added.name == "box")
        #expect(added.caps == [.read])
        let stored = try keys.key(for: "env_fake")
        #expect(stored == "tc_K1.secret")
        let file = try String(contentsOf: directory.appending(path: "environments.json"), encoding: .utf8)
        #expect(!file.contains("secret"))
        #expect(file.contains("env_fake"))

        let reopened = EnvironmentStore(directory: directory, keys: keys, api: fakeHost())
        #expect(reopened.environments == [added])
    }

    @Test func `adding by key asks hello who the host is`() async throws {
        let keys = InMemoryKeyStore()
        let store = EnvironmentStore(directory: directory, keys: keys, api: fakeHost())
        let added = try await store.add(origin: URL(string: "https://box.example")!, key: " tc_K1.secret\n", name: "The box")
        #expect(added.name == "The box")
        #expect(added.keyId == "K1")
        let stored = try keys.key(for: added.id)
        #expect(stored == "tc_K1.secret")
    }

    @Test func `a refused code stores nothing`() async throws {
        let keys = InMemoryKeyStore()
        let store = EnvironmentStore(directory: directory, keys: keys, api: fakeHost(refusePairing: true))
        await #expect(throws: EnvironmentStoreError.api(.unauthorized("pairing code is not valid"))) {
            try await store.add(pairingLink: "https://box.example/pair#AB1CD-EF2GH")
        }
        #expect(store.environments.isEmpty)
        let gone = try keys.key(for: "env_fake")
        #expect(gone == nil)
    }

    @Test func `pairing the same host again replaces the key and keeps one row`() async throws {
        let keys = InMemoryKeyStore()
        let store = EnvironmentStore(directory: directory, keys: keys, api: fakeHost())
        try await store.add(pairingLink: "https://box.example/pair#AB1CD-EF2GH")
        try await store.add(pairingLink: "https://box.example/pair#ZZ1ZZ-ZZ2ZZ", name: "renamed")
        #expect(store.environments.count == 1)
        #expect(store.environments[0].name == "renamed")
        store.remove("env_fake")
        #expect(store.environments.isEmpty)
        let gone = try keys.key(for: "env_fake")
        #expect(gone == nil)
    }

    @Test func `a malformed link or key fails before any request`() async {
        let store = EnvironmentStore(directory: directory, keys: InMemoryKeyStore(), api: fakeHost())
        await #expect(throws: EnvironmentStoreError.invalidPairingLink) { try await store.add(pairingLink: "AB1CD-EF2GH") }
        await #expect(throws: EnvironmentStoreError.invalidKey) { try await store.add(origin: URL(string: "https://h")!, key: "nope") }
    }
}

@Suite struct RemoteAPIDecodeTests {
    @Test func `statuses map to the errors the supervisor acts on`() {
        func attempt(_ status: Int, _ body: String = "", retryAfter: String? = nil) -> RemoteAPIError? {
            do {
                let _: TicketResponse = try RemoteAPI.decode(status: status, retryAfter: retryAfter, data: Data(body.utf8))
                return nil
            } catch {
                return error
            }
        }
        #expect(attempt(200, #"{"ticket":"t","expiresIn":30}"#) == nil)
        #expect(attempt(401, #"{"error":"credential required"}"#) == .unauthorized("credential required"))
        #expect(attempt(403, #"{"error":"mcp keys use /mcp"}"#) == .forbidden("mcp keys use /mcp"))
        #expect(attempt(429, retryAfter: "17") == .rateLimited(retryAfterSeconds: 17))
        #expect(attempt(400, #"{"error":"bad request"}"#) == .rejected(status: 400, message: "bad request"))
        #expect(attempt(502, "<html>") == .unavailable("the host answered 502"))
        #expect(attempt(200, "<html>") == .unavailable("the host answered something this app does not understand"))
    }
}
