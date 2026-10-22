import Foundation
import Testing
@testable import TempCodeContract

/// The numbers scripts/capture-swift-fixtures.ts wrote the fixtures with.
private enum Captured {
    static let sessionId = "fixture-thread"
    static let outputBytes = 6000
    static let outputLines = 100
    static let renamedTitle = "Fixture thread, renamed"
    static let queuedText = "Queued from the fixture capture"
    static let keyName = "iphone"
    static let workspaceLinkId = "wl_fixtureWorkspace0000"
    static let projectLinkId = "pl_fixtureProject000000"
}

enum Fixtures {
    static func data(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    /// Decodes the fixture as `T`, encodes it again, and expects the two
    /// canonical texts to match: nothing lost, nothing invented.
    @discardableResult
    static func roundTrip<T: Codable>(_ type: T.Type, _ name: String, sourceLocation: SourceLocation = #_sourceLocation) throws -> T {
        let data = try data(name)
        let value = try JSONDecoder().decode(T.self, from: data)
        let sent = try JSONDecoder().decode(JSONValue.self, from: data).canonicalJSON()
        let again = try JSONValue(value).canonicalJSON()
        #expect(again == sent, "\(name) changed in the round trip", sourceLocation: sourceLocation)
        return value
    }

    static func push(_ name: String, sourceLocation: SourceLocation = #_sourceLocation) throws -> ServerPush {
        guard case .push(let push) = try roundTrip(ServerFrame.self, name, sourceLocation: sourceLocation) else {
            throw FixtureError.notAPush(name)
        }
        return push
    }

    static func output<M: ContractMethod>(_ method: M.Type, _ name: String, sourceLocation: SourceLocation = #_sourceLocation) throws -> M.Output {
        guard case .response(let response) = try roundTrip(ServerFrame.self, name, sourceLocation: sourceLocation) else {
            throw FixtureError.notAResponse(name)
        }
        return try response.output(method)
    }

    enum FixtureError: Error {
        case notAPush(String)
        case notAResponse(String)
    }
}

@Suite("Fixtures captured from a real server")
struct FixtureTests {
    @Test("every socket frame survives decode and encode", arguments: [
        "hello", "workspace-list", "project-list", "catalog", "session-list", "session-events",
        "session-row-body", "push-events", "push-sessions", "push-queue", "queue-list", "response-error",
        "workspace-icon", "session-search", "session-search-empty", "search-project", "github-inbox",
        // the 2026-10-21/22 features (scripts/capture-swift-fixtures.ts records them from scripts/lib/ios-seeds.ts)
        "batch-get", "batch-children", "push-batch", "session-notes-get", "push-notes", "project-plan-get",
        "project-plan-get-null", "project-plan-link-of", "review-get", "plans-get", "resources-list", "push-resources",
        "session-changes", "session-changes-reset", "session-events-notices", "notes-search", "session-start",
        "session-batch", "host-devices-hosts", "host-deploy-status", "host-log", "mac-bridge-thread-get",
        "accounts-list", "push-boot-resume", "push-accounts"
    ])
    func frameRoundTrip(name: String) throws {
        try Fixtures.roundTrip(ServerFrame.self, name)
    }

    @Test func httpBodies() throws {
        let hello = try Fixtures.roundTrip(HelloResponse.self, "http-hello")
        #expect(hello.contract == contractVersion)
        #expect(hello.key?.name == Captured.keyName)
        let pair = try Fixtures.roundTrip(PairKeyResponse.self, "http-pair-key")
        #expect(pair.key.hasPrefix("tc_"))
        #expect(pair.caps.contains(.operate))
        #expect(pair.environmentId == hello.environmentId)
        let ticket = try Fixtures.roundTrip(TicketResponse.self, "http-ticket")
        #expect(ticket.expiresIn == 30)
    }

    @Test func helloIsFirst() throws {
        guard case .hello(let hello) = try Fixtures.push("hello") else { throw Fixtures.FixtureError.notAPush("hello") }
        #expect(hello.contract == contractVersion)
        #expect(hello.caps.contains(.read))
        #expect(hello.caps.contains(.operate))
        #expect(hello.key?.name == Captured.keyName)
    }

    @Test func sessionListPage() throws {
        let page = try Fixtures.output(Methods.SessionList.self, "session-list")
        let meta = try #require(page.sessions.first { $0.id == Captured.sessionId })
        #expect(page.cursor == nil)
        #expect(meta.status == .running)
        #expect(meta.provider == .claude)
        #expect(meta.threadType == .implementation)
        #expect(meta.permission == .edits)
        #expect(meta.busySince != nil)
    }

    @Test func linkedCatalogRows() throws {
        let workspaces = try Fixtures.output(Methods.WorkspaceList.self, "workspace-list")
        #expect(workspaces.first { $0.name == "fixture-workspace" }?.linkId == Captured.workspaceLinkId)
        let projects = try Fixtures.output(Methods.ProjectList.self, "project-list")
        #expect(projects.first { $0.name == "fixture-project" }?.linkId == Captured.projectLinkId)
    }

    @Test func workspaceIcon() throws {
        let icon = try Fixtures.output(Methods.WorkspaceIcon.self, "workspace-icon")
        #expect(icon.dataUrl == nil)
        #expect(icon.host == nil)
    }

    @Test func sessionSearch() throws {
        let found = try Fixtures.output(Methods.SessionSearch.self, "session-search")
        #expect(!found.truncated)
        #expect(found.hits.count == 2)
        #expect(found.hits.allSatisfy { $0.sessionId == Captured.sessionId })
        #expect(Set(found.hits.map(\.role)) == [.user, .assistant])
        #expect(found.hits.allSatisfy { $0.snippet.lowercased().contains("hello") })
        let empty = try Fixtures.output(Methods.SessionSearch.self, "session-search-empty")
        #expect(empty.hits.isEmpty)
        #expect(!empty.truncated)
    }

    @Test func projectSearch() throws {
        let found = try Fixtures.output(Methods.SearchProject.self, "search-project")
        #expect(!found.truncated)
        let match = try #require(found.matches.first)
        #expect(found.matches.count == 1)
        #expect(match.relative == "fixture-search.txt")
        #expect(match.path.hasSuffix("/fixture-search.txt"))
        #expect(match.line == 2)
        #expect(match.column == 7)
        #expect(match.preview == "const fixtureNeedle = true")
    }

    @Test func storedGithubInbox() throws {
        let inbox = try Fixtures.output(Methods.GithubInbox.self, "github-inbox")
        #expect(inbox.repos.isEmpty)
        #expect(inbox.viewer == nil)
        #expect(inbox.fetchedAt == nil)
        #expect(!inbox.refreshing)
        #expect(inbox.auth.state == .ok)
        #expect(inbox.auth.message.isEmpty)
    }

    @Test func eventsTailKeepsLargeBodiesOffTheWire() throws {
        let page = try Fixtures.output(Methods.SessionEvents.self, "session-events")
        #expect(page.moreBefore)
        #expect(!page.moreAfter)
        #expect(!page.reset)
        let omitted = page.rows.compactMap { row -> OmittedBody? in
            guard case .toolResult(let result) = row.event, case .omittedBody(let body) = result.output else { return nil }
            return body
        }
        #expect(omitted.count == 1)
        #expect(omitted.first?.bytes == Captured.outputBytes)
        #expect(omitted.first?.lines == Captured.outputLines)
        #expect(omitted.first?.head.hasPrefix("line 000:") == true)
        let edit = try #require(page.rows.compactMap { row -> ToolCallEvent? in
            guard case .toolCall(let call) = row.event, call.name == "Edit" else { return nil }
            return call
        }.first)
        guard case .omittedBody = edit.preview?.lines else {
            Issue.record("the Edit preview's lines should be an OmittedBody")
            return
        }
        #expect(edit.input?["old_string"]?["omitted"] == .bool(true))
        #expect(edit.input?["file_path"] == .string("/src/fixture.ts"))
        #expect(page.rows.map(\.seq) == page.rows.map(\.seq).sorted())
    }

    @Test func rowBodyIsTheWholeRow() throws {
        let answer = try Fixtures.output(Methods.SessionRowBody.self, "session-row-body")
        guard case .toolResult(let result) = answer.row.event, case .string(let text) = result.output else {
            Issue.record("expected the tool result with its text")
            return
        }
        #expect(text.utf8.count == Captured.outputBytes)
        #expect(text.split(separator: "\n", omittingEmptySubsequences: false).count == Captured.outputLines)
    }

    @Test func coalescedEventsFrame() throws {
        guard case .events(let push) = try Fixtures.push("push-events") else { throw Fixtures.FixtureError.notAPush("push-events") }
        #expect(push.sessionId == Captured.sessionId)
        #expect(push.rows.count == 2)
        #expect(push.rows.map(\.seq) == push.rows.map(\.seq).sorted())
        let finals = push.rows.compactMap { row -> AssistantTextEvent? in
            guard case .assistantText(let text) = row.event, !text.delta else { return nil }
            return text
        }
        #expect(finals.map(\.text) == ["A live row after subscribe."])
    }

    @Test func sessionsFrame() throws {
        guard case .sessions(let push) = try Fixtures.push("push-sessions") else { throw Fixtures.FixtureError.notAPush("push-sessions") }
        #expect(push.sessions.contains { $0.id == Captured.sessionId && $0.title == Captured.renamedTitle })
    }

    @Test func queuePush() throws {
        guard case .queue(let push) = try Fixtures.push("push-queue") else { throw Fixtures.FixtureError.notAPush("push-queue") }
        #expect(push.sessionId == Captured.sessionId)
        #expect(push.items.map(\.text) == [Captured.queuedText])
        let listed = try Fixtures.output(Methods.QueueList.self, "queue-list")
        #expect(listed == push.items)
    }

    @Test func errorResponse() throws {
        guard case .response(let response) = try Fixtures.roundTrip(ServerFrame.self, "response-error") else {
            throw Fixtures.FixtureError.notAResponse("response-error")
        }
        guard case .error(_, let message) = response else {
            Issue.record("expected ok: false")
            return
        }
        #expect(message.hasPrefix("forbidden: session.approve"))
        #expect(throws: ContractError.server(message)) {
            try response.output(Methods.SessionApprove.self)
        }
    }

    @Test func noticesThreadHasEveryKind() throws {
        let page = try Fixtures.output(Methods.SessionEvents.self, "session-events-notices")
        let kinds = page.rows.compactMap { row -> NoticeKind? in
            guard case .notice(let notice) = row.event else { return nil }
            return notice.kind
        }
        for kind in [NoticeKind.review, .gate, .batch, .accountGone] { #expect(kinds.contains(kind), "\(kind) missing") }
        #expect(!kinds.contains { if case .unknown = $0 { true } else { false } })
        let failures = page.rows.compactMap { row -> FailureKind? in
            guard case .error(let error) = row.event else { return nil }
            return error.failure?.kind
        }
        for kind in [FailureKind.oauthExpired, .accountUnknown, .tokenExpired, .rateLimited, .quota, .modelUnavailable, .network, .harnessCrashed, .unknown] {
            #expect(failures.contains(kind), "\(kind) missing")
        }
        #expect(!failures.contains { if case .unrecognized = $0 { true } else { false } })
        let preambles = page.rows.compactMap { row -> PreambleStamp? in
            guard case .userText(let text) = row.event else { return nil }
            return text.preamble
        }
        #expect(preambles.first?.words == 212)
        #expect(page.rows.contains { if case .planHandoff = $0.event { true } else { false } })
    }

    @Test func projectPlanFixture() throws {
        let state = try #require(try Fixtures.output(Methods.ProjectPlanGet.self, "project-plan-get"))
        #expect(state.milestones.count == 7)
        #expect(state.milestones.filter(\.done).count == 3)
        #expect(state.complete)
        #expect(state.missing.isEmpty)
        #expect(try Fixtures.output(Methods.ProjectPlanGet.self, "project-plan-get-null") == nil)
    }

    @Test func batchFixtureStreamsAShellStep() throws {
        let state = try Fixtures.output(Methods.BatchGet.self, "batch-get")
        let running = try #require(state.steps.first { $0.status == .running && $0.kind == .shell })
        #expect(running.kind == .shell)
        #expect(!running.log.isEmpty)
        guard case .batch(let push) = try Fixtures.push("push-batch") else { throw Fixtures.FixtureError.notAPush("push-batch") }
        #expect(push.state.masterId == state.masterId)
    }

    @Test func catalogRecord() throws {
        let catalog = try Fixtures.output(Methods.CatalogGet.self, "catalog")
        let claude = try #require(catalog["claude"])
        #expect(claude.id == .claude)
        #expect(claude.models.contains { $0.reasoning.contains(.high) })
    }
}

@Suite("Unknown cases survive a newer server")
struct UnknownCaseTests {
    private func roundTrip<T: Codable>(_ type: T.Type, _ json: String) throws -> T {
        let data = Data(json.utf8)
        let value = try JSONDecoder().decode(T.self, from: data)
        let sent = try JSONDecoder().decode(JSONValue.self, from: data).canonicalJSON()
        #expect(try JSONValue(value).canonicalJSON() == sent)
        return value
    }

    @Test func pushKind() throws {
        let frame = try roundTrip(ServerFrame.self, #"{"push":"telemetry","sessionId":"s","samples":[1,2.5,null]}"#)
        guard case .push(.unknown(let value)) = frame else {
            Issue.record("expected an unknown push")
            return
        }
        #expect(value["push"] == .string("telemetry"))
    }

    @Test func eventType() throws {
        let row = try roundTrip(EventRow.self, #"{"sessionId":"s","seq":7,"ts":1760860000000,"event":{"type":"mind-meld","text":"hi","depth":{"a":[true]}}}"#)
        #expect(row.seq == 7)
        guard case .unknown(let event) = row.event else {
            Issue.record("expected an unknown event")
            return
        }
        #expect(event["type"] == .string("mind-meld"))
    }

    @Test func enumValue() throws {
        #expect(SessionStatus(rawValue: "dreaming") == .unknown("dreaming"))
        #expect(SessionStatus.unknown("dreaming").rawValue == "dreaming")
        #expect(SessionStatus(rawValue: "idle") == .idle)
        let decoded = try roundTrip([SessionStatus].self, #"["idle","dreaming"]"#)
        #expect(decoded == [.idle, .unknown("dreaming")])
    }

    @Test func bodyShape() throws {
        let body = try roundTrip(Body.self, #"{"shape":"new","bytes":3}"#)
        guard case .unknown = body else {
            Issue.record("expected an unknown body")
            return
        }
        let omitted = try roundTrip(Body.self, #"{"omitted":true,"bytes":3,"lines":1,"head":"abc"}"#)
        #expect(omitted == .omittedBody(OmittedBody(omitted: true, bytes: 3, lines: 1, head: "abc")))
    }
}

@Suite("Framing")
struct FramingTests {
    @Test func requestEnvelope() throws {
        let request = Request<Methods.SessionEvents>(id: "7", params: .init(sessionId: "s", tail: 2))
        #expect(try JSONValue(request).canonicalJSON(dropNulls: false) == #"{"id":"7","method":"session.events","params":{"sessionId":"s","tail":2}}"#)
        let bare = Request<Methods.ProjectList>(id: "8", params: NoParams())
        #expect(try JSONValue(bare).canonicalJSON() == #"{"id":"8","method":"project.list","params":{}}"#)
    }

    @Test func patchClearsOrLeavesOut() throws {
        let clear = Methods.QueueUpdate.Params(sessionId: "s", messageId: "m", provider: .clear, model: .set("gpt-6.1-sol"))
        #expect(try JSONValue(clear).canonicalJSON(dropNulls: false) == #"{"messageId":"m","model":"gpt-6.1-sol","provider":null,"sessionId":"s"}"#)
        let keep = Methods.QueueUpdate.Params(sessionId: "s", messageId: "m", text: "edited")
        #expect(try JSONValue(keep).canonicalJSON(dropNulls: false) == #"{"messageId":"m","sessionId":"s","text":"edited"}"#)
    }

    @Test func requiredNullableIsWrittenAsNull() throws {
        let dismissed = Methods.SessionAnswer.Params(sessionId: "s", requestId: "r", answers: nil)
        #expect(try JSONValue(dismissed).canonicalJSON(dropNulls: false) == #"{"answers":null,"requestId":"r","sessionId":"s"}"#)
    }

    @Test func nullOutput() throws {
        let frame = try decodeFrame(Data(#"{"id":"3","ok":true,"result":null}"#.utf8))
        guard case .response(let response) = frame else {
            Issue.record("expected a response")
            return
        }
        #expect(try response.output(Methods.SessionSend.self) == NoOutput())
        #expect(response.id == "3")
    }

    @Test func pushAndResponseAreToldApart() throws {
        guard case .push = try decodeFrame(Data(#"{"push":"session-removed","sessionIds":["a"]}"#.utf8)) else {
            Issue.record("expected a push")
            return
        }
        guard case .response(.error(let id, let message)) = try decodeFrame(Data(#"{"id":"9","ok":false,"error":"nope"}"#.utf8)) else {
            Issue.record("expected an error response")
            return
        }
        #expect(id == "9")
        #expect(message == "nope")
    }
}
