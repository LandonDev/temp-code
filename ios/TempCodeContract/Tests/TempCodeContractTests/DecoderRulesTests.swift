import Foundation
import Testing
@testable import TempCodeContract

/// The decoder's rules on hand-written JSON: these pass before any fixture is
/// re-recorded, and they pin the names the phone's screens code against
/// (the 2026-10-21/22 features: master threads, notes, the project plan,
/// reviews, resources, the restart ledger, the launch mirror, devices,
/// accounts).
@Suite("Decoder rules")
struct DecoderRulesTests {
    private func roundTrip<T: Codable>(_ type: T.Type, _ json: String, sourceLocation: SourceLocation = #_sourceLocation) throws -> T {
        let data = Data(json.utf8)
        let value = try JSONDecoder().decode(T.self, from: data)
        let sent = try JSONDecoder().decode(JSONValue.self, from: data).canonicalJSON()
        #expect(try JSONValue(value).canonicalJSON() == sent, sourceLocation: sourceLocation)
        return value
    }

    /// A session row with every required field, `status` as given.
    private func sessionJSON(status: String, extra: String = "") -> String {
        """
        {"id":"s","parentId":null,"projectId":"p","workspaceId":"w","threadType":"chat","planPath":null,
         "provider":"claude","model":"claude-haiku-5-5","reasoning":"low","agentType":"implementer",
         "title":"T","cwd":"/tmp/p","status":"\(status)","pinned":false,"archived":false,"permission":"edits",
         "fast":false,"ultrafast":false,"context1m":false,"busySince":null,"pausedAt":null,
         "frozenActiveElapsed":null,"nativeId":null,"createdAt":1760000000000,"updatedAt":1760000000001\(extra)}
        """
    }

    @Test func unknownPushDecodesAndReEncodes() throws {
        let frame = try roundTrip(ServerFrame.self, #"{"push":"deploy-master","master":null}"#)
        guard case .push(.unknown(let value)) = frame else {
            Issue.record("expected an unknown push")
            return
        }
        #expect(value["push"] == .string("deploy-master"))
    }

    @Test func unknownStatusKeepsRawValue() throws {
        let meta = try roundTrip(SessionMeta.self, sessionJSON(status: "hibernating"))
        #expect(meta.status == .unknown("hibernating"))
        #expect(meta.status.rawValue == "hibernating")
    }

    @Test("the statuses of the master threads and the restart ledger", arguments: [
        ("queued", SessionStatus.queued), ("watching", SessionStatus.watching), ("stopped", SessionStatus.stopped)
    ])
    func newStatusesDecode(raw: String, expected: SessionStatus) throws {
        let meta = try roundTrip(SessionMeta.self, sessionJSON(status: raw))
        #expect(meta.status == expected)
    }

    @Test func masterFieldsOnTheRow() throws {
        let meta = try roundTrip(SessionMeta.self, sessionJSON(status: "queued", extra: #","isMaster":false,"masterId":"m","after":"a","startedBy":"m","activity":"Queued · waiting for a""#))
        #expect(meta.isMaster == false)
        #expect(meta.masterId == "m")
        #expect(meta.after == "a")
        #expect(meta.startedBy == "m")
    }

    @Test func noticeOfUnknownKindKeepsMessage() throws {
        let event = try roundTrip(AgentEvent.self, #"{"type":"notice","kind":"weather","message":"Rain"}"#)
        guard case .notice(let notice) = event else {
            Issue.record("expected a notice")
            return
        }
        #expect(notice.kind == .unknown("weather"))
        #expect(notice.message == "Rain")
    }

    @Test func noticeKindsAreExhaustive() throws {
        let review = try roundTrip(AgentEvent.self, """
        {"type":"notice","kind":"review","message":"Review held: 1 blocking finding","review":{"runId":"r1","reviewerId":"rev","provider":"codex","model":"gpt-6.1-sol","outcome":"held","branch":"ios/x","target":"master","blocking":[{"file":"src/a.ts","line":12,"summary":"Off by one","failure_scenario":"An empty list crashes","verdict":"CONFIRMED"}],"minor":[],"merged":false,"pushed":false}}
        """)
        let gate = try roundTrip(AgentEvent.self, """
        {"type":"notice","kind":"gate","message":"Gate failed","gate":{"step":"gate","branch":"ios/x","ok":false,"log":"✗ vitest 12s","at":1760000000000}}
        """)
        let batch = try roundTrip(AgentEvent.self, #"{"type":"notice","kind":"batch","message":"Merged by the batch: ios/x → master at 1a2b3c4d5e, pushed"}"#)
        let gone = try roundTrip(AgentEvent.self, #"{"type":"notice","kind":"account-gone","message":"Account ws@example.com is gone","account":"ws@example.com"}"#)
        var seen: [NoticeKind] = []
        for event in [review, gate, batch, gone] {
            guard case .notice(let notice) = event else {
                Issue.record("expected a notice")
                continue
            }
            seen.append(notice.kind)
            // Every case the build knows, plus the one it does not: a `switch` stays exhaustive.
            switch notice.kind {
            case .review:
                #expect(notice.review?.outcome == .held)
                #expect(notice.review?.blocking.first?.verdict == .confirmed)
                #expect(notice.review?.blocking.first?.line == 12)
            case .gate:
                #expect(notice.gate?.step == .gate)
                #expect(notice.gate?.ok == false)
            case .batch:
                #expect(notice.message.hasPrefix("Merged by the batch"))
            case .accountGone:
                #expect(notice.account == "ws@example.com")
            case .unknown:
                Issue.record("every seeded kind is known")
            }
        }
        #expect(seen == [.review, .gate, .batch, .accountGone])
    }

    @Test func failureKindLiteralUnknown() throws {
        let known = try roundTrip(Failure.self, #"{"kind":"unknown","account":null,"summary":"?","cause":"?"}"#)
        #expect(known.kind == .unknown)
        let newer = try roundTrip(Failure.self, #"{"kind":"gremlins","account":"a","summary":"?","cause":"?"}"#)
        #expect(newer.kind == .unrecognized("gremlins"))
        #expect(newer.kind.rawValue == "gremlins")
    }

    @Test func batchStateMidRun() throws {
        let log = (1...200).map { "\"line \($0)\"" }.joined(separator: ",")
        let state = try roundTrip(BatchState.self, """
        {"masterId":"m","rules":{"land":"as-they-finish","steps":[{"id":"land","name":"Land","kind":"land"},{"id":"gate","name":"Gate","kind":"gate"},{"id":"smoke","name":"Smoke test","kind":"shell","run":"bun run smoke","when":"all-done"}],"then":"notify","summary":"Land, gate, smoke"},
         "steps":[{"id":"land","name":"Land","kind":"land","status":"passed","detail":"3 of 4 branches landed","at":1,"progress":{"done":3,"total":4},"log":[]},
                  {"id":"gate","name":"Gate","kind":"gate","status":"running","detail":"","at":2,"startedAt":2,"progress":{"done":2,"total":3,"label":"vitest"},"log":[]},
                  {"id":"smoke","name":"Smoke test","kind":"shell","status":"running","detail":"","at":3,"startedAt":3,"log":[\(log)]}],
         "landed":["a","b"],"pending":["c"],"held":[],"blocked":null,"finishedAt":null}
        """)
        #expect(state.steps.map(\.status) == [.passed, .running, .running])
        #expect(state.steps[0].progress?.done == 3)
        #expect(state.steps[1].progress?.label == "vitest")
        #expect(state.steps[2].kind == .shell)
        #expect(state.steps[2].log.count == 200)
        #expect(state.rules.steps[2].run == "bun run smoke")
        #expect(state.blocked == nil)
        #expect(state.finishedAt == nil)
        let blocked = try roundTrip(BatchState.self, #"{"masterId":"m","rules":{"land":"all-at-once","steps":[],"then":"archive-children"},"steps":[],"landed":[],"pending":[],"held":["c"],"blocked":{"sessionId":"c","why":"errored"},"finishedAt":null}"#)
        #expect(blocked.blocked?.why == .errored)
        #expect(blocked.rules.land == .allAtOnce)
    }

    @Test func sessionChangesBothAnswers() throws {
        let reset = try roundTrip(SessionChanges.self, #"{"reset":true,"seq":12,"generation":"g1"}"#)
        #expect(reset.reset)
        #expect(reset.sessions == nil)
        #expect(reset.removed == nil)
        let full = try roundTrip(SessionChanges.self, #"{"reset":false,"seq":13,"generation":"g1","sessions":[\#(sessionJSON(status: "idle"))],"removed":["gone"]}"#)
        #expect(full.sessions?.count == 1)
        #expect(full.removed == ["gone"])
    }

    @Test func projectPlanNullAndFull() throws {
        guard case .response(let empty) = try decodeFrame(Data(#"{"id":"1","ok":true,"result":null}"#.utf8)) else {
            Issue.record("expected a response")
            return
        }
        #expect(try empty.output(Methods.ProjectPlanGet.self) == nil)
        let milestones = (1...7).map { #"{"index":\#($0),"title":"M\#($0)","done":\#($0 <= 3)}"# }.joined(separator: ",")
        guard case .response(let full) = try decodeFrame(Data(#"{"id":"2","ok":true,"result":{"projectId":"p","path":"/tmp/p/.temp-code/plans/project.md","exists":true,"pinned":true,"sessionId":"ios-project-plan","complete":true,"milestones":[\#(milestones)],"missing":[]}}"#.utf8)) else {
            Issue.record("expected a response")
            return
        }
        let state = try #require(try full.output(Methods.ProjectPlanGet.self))
        #expect(state.milestones.count == 7)
        #expect(state.milestones.filter(\.done).count == 3)
        #expect(state.complete)
    }

    @Test func accountsSnapshot() throws {
        let snapshot = try roundTrip(AccountsSnapshot.self, """
        {"updatedAt":1760000000000,"providers":{"claude":{"pinned":"work@example.com","profiles":[{"name":"work@example.com","active":true},{"name":"spare@example.com","active":false}],
         "reports":[{"profileName":"work@example.com","windows":[{"label":"5h","usedPercent":40,"resetsAt":1760000100000}]}],
         "headroom":{"work@example.com":{"room":0.8,"ratePerMin":12,"seenAt":1760000000000},"spare@example.com":{"room":0.1,"throttledUntil":1760000600000,"ratePerMin":0,"seenAt":1759999000000}}},
         "codex":{"pinned":null,"profiles":[],"reports":[]},"cursor":{"pinned":null,"profiles":[],"reports":[]}}}
        """)
        let claude = snapshot.providers.claude
        #expect(claude.profiles.count == 2)
        #expect(claude.headroom?["work@example.com"]?.room == 0.8)
        #expect(claude.headroom?["spare@example.com"]?.throttledUntil == 1760000600000)
        #expect(claude.reports.first?.windows.first?.usedPercent == 40)
        #expect(snapshot.providers.codex.profiles.isEmpty)
    }

    @Test func hostDevicesReport() throws {
        let report = try roundTrip(HostDevicesReport.self, """
        {"environmentId":"env_a","at":1760000000000,
         "simulators":[{"udid":"A-1","name":"iPhone 17","runtime":"iOS 26.0","state":"booted","cpu":12.5,"holder":{"sessionId":"ios-resources","title":"Resources","status":"idle"}},
                       {"udid":"A-2","name":"iPhone 17 Pro","runtime":"iOS 26.0","state":"shutdown","holder":null}],
         "phones":[{"udid":"P-1","name":"Phone","model":"iPhone 16 Pro","os":"iOS 26.0","connection":"paired","holder":null}],
         "xcode":{"path":"/Applications/Xcode-26.app","name":"Xcode-26","version":"26.0","from":"newest"},
         "load":{"oneMinute":3.2,"cores":8},"problems":[]}
        """)
        #expect(report.simulators.map(\.state) == [.booted, .shutdown])
        #expect(report.simulators[0].holder?.sessionId == "ios-resources")
        #expect(report.phones.first?.connection == .paired)
        #expect(report.xcode?.name == "Xcode-26")
        #expect(report.load.cores == 8)
    }

    @Test func buildFactsIsOneType() throws {
        let facts = BuildFacts(release: 400, version: "1.0.400", sha: nil, platform: "darwin")
        let hello = HelloPush(environmentId: "e", contract: contractVersion, caps: [.read], build: facts)
        let http = HelloResponse(environmentId: "e", build: facts, contract: contractVersion)
        #expect(hello.build == http.build)
    }

    @Test func notesResourcesAndTheNewPushes() throws {
        guard case .push(.notes(let notes)) = try decodeFrame(Data(#"{"push":"notes","sessionId":"s","doc":{"text":"Goal: one line\n","updatedAt":1760000000000,"path":null}}"#.utf8)) else {
            Issue.record("expected the notes push")
            return
        }
        #expect(notes.doc.text.hasPrefix("Goal:"))
        #expect(notes.doc.path == nil)
        guard case .push(.resources(let resources)) = try decodeFrame(Data(#"{"push":"resources","sessionId":"s","resources":[{"id":"r1","sessionId":"s","environmentId":"env_m","kind":"simulator","identifier":"A-1","label":"iPhone 17","branch":null,"createdAt":1,"removeRequestedAt":2,"removedAt":null,"note":"Mac offline, waiting"}]}"#.utf8)) else {
            Issue.record("expected the resources push")
            return
        }
        #expect(resources.resources.first?.kind == .simulator)
        #expect(resources.resources.first?.note == "Mac offline, waiting")
        guard case .push(.bootResume(let boot)) = try decodeFrame(Data(#"{"push":"boot-resume","count":4,"at":1760000000000}"#.utf8)) else {
            Issue.record("expected the boot-resume push")
            return
        }
        #expect(boot.count == 4)
        guard case .push(.macBridgeHeld(let held)) = try decodeFrame(Data(#"{"push":"macBridge.held","sessionId":"s","held":3}"#.utf8)) else {
            Issue.record("expected the held push")
            return
        }
        #expect(held.held == 3)
        guard case .push(.hostLog(let log)) = try decodeFrame(Data(#"{"push":"host-log","job":"deploy","append":"line\n","status":{"job":"deploy","phase":"running","target":"master","startedAt":1,"finishedAt":null,"exit":null,"stoppable":false}}"#.utf8)) else {
            Issue.record("expected the host-log push")
            return
        }
        #expect(log.status.phase == .running)
        #expect(log.append == "line\n")
    }
}
