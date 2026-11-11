import Foundation
import Testing
@testable import ComputerProtocol

/// src/main/server/computer/fixtures/wire, read in place from the checkout.
enum WireFixtures {
    static let dir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // WireFixtureTests.swift
        .deletingLastPathComponent() // ComputerProtocolTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // tc-computer
        .deletingLastPathComponent() // native
        .appendingPathComponent("src/main/server/computer/fixtures/wire")

    static func names() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted()
    }

    static func frame(_ name: String) throws -> RPCFrame {
        try JSONDecoder().decode(RPCFrame.self, from: Data(contentsOf: dir.appendingPathComponent(name)))
    }
}

/// Decodes `value` as `T`, encodes it again, and expects the same canonical text: nothing lost, nothing invented.
func roundTrip<T: Codable>(_ type: T.Type, _ value: JSONValue, sourceLocation: SourceLocation = #_sourceLocation) throws -> T {
    let decoded = try value.decode(T.self)
    #expect(try JSONValue(decoded).canonicalJSON() == value.canonicalJSON(), sourceLocation: sourceLocation)
    return decoded
}

/// Every method of the protocol; a fixture pair must exist for each. A function, not a
/// global: an array of metatypes is not Sendable.
func allMethods() -> [any ContractMethod.Type] { [
    Methods.Initialize.self, Methods.Shutdown.self, Methods.PermissionsGet.self, Methods.PermissionsRequest.self,
    Methods.AppsList.self, Methods.AppsLaunch.self, Methods.SessionOpen.self, Methods.SessionClose.self,
    Methods.StateGet.self, Methods.ActionRun.self, Methods.ActionBatch.self, Methods.CaptureScreenshot.self,
    Methods.CaptureStreamStart.self, Methods.CaptureStreamStop.self, Methods.InputProbe.self,
    Methods.InputRestoreSession.self, Methods.ClipboardState.self
] }

func check<M: ContractMethod>(_ method: M.Type) throws {
    guard case .request(_, let name, let params) = try WireFixtures.frame("\(M.name).request.json") else {
        Issue.record("\(M.name).request.json is not a request")
        return
    }
    #expect(name == M.name)
    _ = try roundTrip(M.Params.self, params)
    guard case .result(_, let result) = try WireFixtures.frame("\(M.name).response.json") else {
        Issue.record("\(M.name).response.json is not a result")
        return
    }
    _ = try roundTrip(M.Output.self, result)
}

@Suite struct WireFixtureTests {
    @Test func everyMethodHasARequestAndAResponseThatDecode() throws {
        for method in allMethods() { try check(method) }
    }

    @Test func everyFixtureIsAFrame() throws {
        let names = try WireFixtures.names()
        #expect(names.count >= allMethods().count * 2)
        for name in names { _ = try WireFixtures.frame(name) }
    }

    @Test func everyErrorKindHasAFixtureThatDecodes() throws {
        let kinds = try WireFixtures.names().filter { $0.hasPrefix("error-") }
        #expect(kinds.count == 26) // every ComputerErrorKind but `unknown`
        for name in kinds {
            let kind = String(name.dropFirst("error-".count).dropLast(".json".count))
            switch try WireFixtures.frame(name) {
            case .error(_, let error):
                #expect(error.code == ComputerDefaults.RPCErrorCode.computer)
                #expect(error.data?.kind.rawValue == kind)
            case .result(_, let result):
                let answer = try roundTrip(Methods.ActionRun.Output.self, result)
                guard case .failed(let step) = answer.step else {
                    Issue.record("\(name): the step did not fail")
                    continue
                }
                #expect(step.error.kind.rawValue == kind)
            default:
                Issue.record("\(name) is neither an error nor a result")
            }
        }
    }

    @Test func everyNotificationDecodesToAKnownCase() throws {
        let names = try WireFixtures.names().filter { $0.hasPrefix("notify-") }
        #expect(names.count == 12)
        for name in names {
            let data = try Data(contentsOf: WireFixtures.dir.appendingPathComponent(name))
            guard case .notification(let method, _) = try WireFixtures.frame(name) else {
                Issue.record("\(name) is not a notification")
                continue
            }
            if method == cancelMethod || method == "capture.stream.ack" {
                let note = try JSONDecoder().decode(HostNotification.self, from: data)
                if case .unknown = note { Issue.record("\(name) decoded as unknown") }
            } else {
                let note = try JSONDecoder().decode(ComputerNotification.self, from: data)
                if case .unknown = note { Issue.record("\(name) decoded as unknown") }
            }
        }
    }

    @Test func aGeneratedPointIsAnArrayOfInts() throws {
        let action = try JSONDecoder().decode(ComputerAction.self, from: Data(#"{"action":"left_click","coordinate":[500,300],"text":"shift"}"#.utf8))
        let point: Point = try #require(action.coordinate)
        #expect(point == [500, 300])
        #expect(action.action == .leftClick)
        #expect(AppRef(app: "TextEdit").pid == nil)
    }

    @Test func aLaunchResultFromBeforeTheFrontGuardStillDecodes() throws {
        let old = try JSONDecoder().decode(Methods.AppsLaunch.Output.self, from: Data(#"{"pid":16800,"launched":true}"#.utf8))
        #expect(old.front == nil && old.window == nil && old.others == nil)
        let now = try JSONDecoder().decode(
            Methods.AppsLaunch.Output.self,
            from: Data(#"{"pid":1,"launched":false,"front":{"raised":true,"restored":"hid-app"}}"#.utf8))
        #expect(now.front == FrontReport(raised: true, restored: .hidApp))
    }

    @Test func anUnknownEnumValueIsKept() throws {
        let tier = try JSONDecoder().decode(Tier.self, from: Data(#""remote""#.utf8))
        #expect(tier == .unknown("remote"))
        #expect(tier.rawValue == "remote")
    }
}
