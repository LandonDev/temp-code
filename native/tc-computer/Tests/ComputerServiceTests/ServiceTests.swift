import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// A short wait row, so the tests do not sit through the spec's.
let quick = #"{"minMs":0,"quietMs":10,"maxMs":60,"busyMaxMs":60}"#

private func held(_ pid: Int32, kind: HeldRecord.Kind = .button) -> HeldRecord {
    HeldRecord(writer: ProcessInfo.processInfo.processIdentifier, pid: pid, tier: .process, kind: kind, point: [10, 10], since: 1)
}

@Suite struct InitializeTests {
    @Test func itAnswersTheServiceTheEpochAndTheMac() async throws {
        let rig = ServiceRig()
        let mismatch = await rig.call("initialize", #"{"protocol":2,"client":{"name":"t","version":"0"},"dataDir":"\#(rig.dataDir.path)"}"#)
        #expect(mismatch.error?.data?.kind == .protocolMismatch)
        let ok = await rig.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(rig.dataDir.path)"}"#)
        let result = try #require(ok.result)
        #expect(result["protocol"]?.intValue == 1)
        #expect(result["service"]?["version"]?.stringValue == "1.0.9")
        #expect(result["service"]?["build"]?.stringValue == "abc123")
        #expect(result["epoch"]?.stringValue == rig.service.epoch)
        #expect(result["os"]?["arch"]?.stringValue == "arm64")
        #expect(result["displays"]?.arrayValue?.count == 1)
        let again = await rig.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(rig.dataDir.path)"}"#)
        #expect(again.result?["epoch"]?.stringValue == rig.service.epoch)
        let other = await rig.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"/tmp/elsewhere"}"#)
        #expect(other.error?.code == -32600)
    }

    @Test func aSecondServiceOnTheSameDataDirIsAlreadyRunning() async throws {
        let rig = ServiceRig()
        try FileManager.default.createDirectory(at: rig.dataDir, withIntermediateDirectories: true)
        let other = try #require(FileLock.acquire(rig.dataDir.appendingPathComponent("service.lock").path, timeout: .zero))
        let answer = await rig.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(rig.dataDir.path)"}"#)
        #expect(answer.error?.data?.kind == .alreadyRunning)
        other.release()
        let retry = await rig.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(rig.dataDir.path)"}"#)
        #expect(retry.result != nil)
    }

    @Test func heldInputADeadServiceLeftIsReleasedAtInitialize() async throws {
        let rig = ServiceRig()
        try FileManager.default.createDirectory(at: rig.dataDir, withIntermediateDirectories: true)
        let dead = HeldRecord(writer: Int32.max - 7, pid: 500, tier: .process, kind: .button, point: [1, 1], since: 1)
        try JSONEncoder().encode([dead]).write(to: rig.dataDir.appendingPathComponent("held.json"))
        await rig.ready()
        #expect(rig.input.staleRecords == [dead])
        #expect(await eventually { rig.lines.notifications("log").contains { $0["message"]?.stringValue?.contains("released 1 held input") == true } })
        let left = try JSONDecoder().decode([HeldRecord].self, from: Data(contentsOf: rig.dataDir.appendingPathComponent("held.json")))
        #expect(left.isEmpty)
        // nothing reaches the host before initialize's answer
        let frames = rig.lines.frames
        let answer = try #require(frames.firstIndex { if case .result = $0 { true } else { false } })
        let firstNote = try #require(frames.firstIndex { if case .notification = $0 { true } else { false } })
        #expect(answer < firstNote)
    }

    @Test func methodsBeforeInitializeAnswerNotInitialized() async {
        let rig = ServiceRig()
        let answer = await rig.call("apps.list")
        #expect(answer.error?.data?.kind == .notInitialized)
    }
}

@Suite struct ObservationTests {
    @Test func stateGetAssemblesSeqBaseKindAndTheSpaceBeforeTheRead() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let first = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(first["kind"]?.stringValue == "full")
        #expect(first["seq"]?.intValue == 1)
        #expect(first["base"] == nil)
        #expect(first["epoch"]?.stringValue == rig.service.epoch)
        #expect(first["app"]?["name"]?.stringValue == "Doc")
        #expect(first["space"]?["width"]?.intValue == 1280)
        let second = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(second["kind"]?.stringValue == "diff")
        #expect(second["seq"]?.intValue == 2)
        #expect(second["base"]?.intValue == 1)
        let request = try #require(rig.reader().observed.first)
        #expect(request.space.width == 1280)
        #expect(request.noteThin)
        #expect(!request.loading)
        #expect(rig.windowEvents.watching.contains(500))
    }

    @Test func anAutoReadThatTakesNoShotKeepsTheSpaceCoordinatesMean() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let result = try #require(await rig.call("state.get", "{\(docTarget),\"maxEdge\":640,\"wait\":\(quick)}").result)
        #expect(result["shot"] == nil)
        #expect(result["space"]?["width"]?.intValue == 1280)
        #expect(rig.reader().observed.last?.space.width == 1280)
    }

    @Test func anAlwaysReadWhoseShotFailsStillMeansTheSpaceItStates() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.capture.failShots = true
        let result = try #require(await rig.call("state.get", "{\(docTarget),\"screenshot\":\"always\",\"maxEdge\":640,\"wait\":\(quick)}").result)
        #expect(result["shot"] == nil)
        #expect(result["space"]?["width"]?.intValue == 640)
        #expect(rig.service.book.space("s1", window: 7)?.width == 640)
    }

    @Test func noteThinIsOffWithoutAShotAndWithoutScreenRecording() async throws {
        let rig = ServiceRig(screenRecording: false)
        await rig.ready()
        _ = await rig.call("state.get", "{\(docTarget),\"screenshot\":\"auto\",\"wait\":\(quick)}")
        #expect(rig.reader().observed.last?.noteThin == false)
        let rig2 = ServiceRig()
        await rig2.ready()
        _ = await rig2.call("state.get", "{\(docTarget),\"screenshot\":\"never\",\"wait\":\(quick)}")
        #expect(rig2.reader().observed.last?.noteThin == false)
    }

    @Test func aBusyWaitReadsAsLoading() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.reader().signal.setBusy(true)
        let busy = #"{"minMs":0,"quietMs":10,"maxMs":30,"busyMaxMs":80}"#
        let result = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(busy)}").result)
        #expect(result["waited"]?["reason"]?.stringValue == "busy-max")
        #expect(rig.reader().observed.last?.loading == true)
    }

    @Test func anElementNeedsThisProcesssEpoch() async {
        let rig = ServiceRig()
        await rig.ready()
        let none = await rig.call("state.get", "{\(docTarget),\"element\":3}")
        #expect(none.error?.code == -32602)
        let old = await rig.call("state.get", "{\(docTarget),\"element\":3,\"epoch\":\"before\"}")
        #expect(old.error?.data?.kind == .staleElement)
        #expect(old.error?.data?.reason == .serviceRestarted)
        let now = await rig.call("state.get", "{\(docTarget),\"element\":3,\"epoch\":\"\(rig.service.epoch)\",\"wait\":\(quick)}")
        #expect(now.result?["kind"]?.stringValue == "subtree")
    }

    @Test func aThinTreeCarriesAShotOrSaysWhyNot() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.reader().script = [(.full, true)]
        let thin = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(thin["shot"]?["path"]?.stringValue?.hasSuffix("0001-observe.jpg") == true)
        rig.capture.failShots = true
        rig.reader().script = [(.diff, true)]
        let failed = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(failed["shot"] == nil)
        #expect(failed["shotError"]?["kind"]?.stringValue == "capture_failed")
    }

    @Test func aShotOfAnotherSizeReadsTheTextAgainInItsSpace() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.capture.shotSize = (1000, 700)
        let result = try #require(await rig.call("state.get", "{\(docTarget),\"screenshot\":\"always\",\"wait\":\(quick)}").result)
        #expect(result["space"]?["width"]?.intValue == 1000)
        #expect(result["kind"]?.stringValue == "full")
        #expect(result["seq"]?.intValue == 1, "the re-read is stamped once")
        #expect(rig.reader().resets == 1)
        #expect(rig.reader().observed.last?.space.width == 1000)
    }

    @Test func aReadTheModelNeverSeesResetsTheBase() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.reader().hang = true
        let id = rig.send("state.get", "{\(docTarget),\"wait\":\(quick)}")
        #expect(await eventually { rig.log.count("observe") == 1 })
        rig.cancel(id)
        try await Task.sleep(for: .milliseconds(20))
        rig.reader().hang = false
        let answer = await rig.answer(id)
        #expect(answer.error?.data?.kind == .cancelled)
        #expect(await eventually { rig.reader().resets == 1 })
    }

    @Test func anUnopenedSessionAndAMissingGrantAnswerErrors() async {
        let rig = ServiceRig(accessibility: false)
        await rig.ready()
        let noGrant = await rig.call("state.get", "{\(docTarget)}")
        #expect(noGrant.error?.data?.kind == .permissionMissing)
        #expect(noGrant.error?.data?.which == .accessibility)
        let unknown = await rig.call("state.get", #"{"session":"nope","app":{"app":"Doc"}}"#)
        #expect(unknown.error?.data?.kind == .unknownSession)
        let bad = await rig.call("session.open", #"{"session":"a/b"}"#)
        #expect(bad.error?.code == -32602)
    }
}

@Suite struct ActionTests {
    @Test func anActionWatchesThenReadsTheSignatureThenPerformsThenWaitsThenObserves() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":[10,10]},\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["status"]?.stringValue == "ok")
        #expect(result["step"]?["tier"]?.stringValue == "process")
        #expect(result["step"]?["effect"]?.stringValue == "none")
        #expect(result["step"]?["waited"]?["reason"]?.stringValue == "quiet")
        #expect(result["observation"]?["kind"]?.stringValue == "full")
        let log = rig.log
        let watch = try #require(log.index("watch"))
        let live = try #require(log.index("waitLive"))
        let perform = try #require(log.index("perform left_click"))
        let sig0 = try #require(log.all.prefix(perform).lastIndex { $0 == "signature" })
        let observe = try #require(log.index("observe"))
        #expect(watch < live && live < perform && sig0 < perform && perform < observe)
    }

    @Test func anAXChangeAfterTheInputSaysChanged() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let reader = rig.reader()
        rig.input.onPerform = { _, _ in
            let at = mach_absolute_time()
            reader.signal.notify()
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: at - 1)
        }
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"element\":2},\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["effect"]?.stringValue == "changed")
        #expect(result["step"]?["element"]?["line"]?.stringValue == "button \"B2\"")
    }

    @Test func cursorPositionGoesToInputAndAScreenshotDoesNot() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let cursor = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"cursor_position\"},\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(rig.log.count("perform cursor_position") == 1)
        #expect(cursor["step"]?["text"]?.stringValue == "X=0, Y=0")
        #expect(cursor["step"]?["tier"] == JSONValue.null || cursor["step"]?["tier"] == nil)
        let shot = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"screenshot\"},\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(rig.log.count("perform screenshot") == 0)
        #expect(shot["step"]?["shot"]?["path"]?.stringValue?.hasSuffix("-screenshot.jpg") == true)
    }

    @Test func theAgentCursorRidesIntoTheNextAction() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"mouse_move\",\"coordinate\":[40,30]},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_mouse_up\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(rig.input.seenCursors.last == [40, 30])
    }

    @Test func aBatchStopsAtTheFirstFailureAndObservesOnce() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let actions = #"[{"action":"left_click","coordinate":[1,1]},{"action":"left_click","element":99},{"action":"key","text":"Tab"}]"#
        let result = try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":\(actions),\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"process\"],\"stepWait\":\(quick),\"wait\":\(quick)}").result)
        let steps = try #require(result["steps"]?.arrayValue)
        #expect(steps.map { $0["status"]?.stringValue } == ["ok", "failed", "not-run"])
        #expect(steps[1]["error"]?["kind"]?.stringValue == "no_such_element")
        #expect(result["observation"] != nil)
        #expect(rig.log.count("observe") == 1)
        #expect(rig.log.count("perform key") == 0)
    }

    @Test func aHeldButtonMakesItsSessionTheStickyOwnerUntilReleased() async throws {
        let rig = ServiceRig()
        await rig.ready(session: "s1")
        _ = await rig.call("session.open", #"{"session":"s2"}"#)
        let wiring = rig.input.wiring
        rig.input.onPerform = { action, target in
            if action.action == .leftMouseDown { wiring.onHeld(.pressing(held(target.pid))) }
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_mouse_down\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        let ledger = try JSONDecoder().decode([HeldRecord].self, from: Data(contentsOf: rig.dataDir.appendingPathComponent("held.json")))
        #expect(ledger.count == 1)
        let other = try #require(await rig.call("action.run", #"{"session":"s2","app":{"app":"Doc"},"action":{"action":"key","text":"a"},"tiers":["process"],"wait":\#(quick)}"#).result)
        #expect(other["step"]?["error"]?["kind"]?.stringValue == "app_busy")
        let own = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"mouse_move\",\"coordinate\":[5,5]},\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(own["step"]?["status"]?.stringValue == "ok")
        wiring.onHeld(.released(pid: 500, kind: .button))
        let cleared = try JSONDecoder().decode([HeldRecord].self, from: Data(contentsOf: rig.dataDir.appendingPathComponent("held.json")))
        #expect(cleared.isEmpty)
        let after = try #require(await rig.call("action.run", #"{"session":"s2","app":{"app":"Doc"},"action":{"action":"key","text":"a"},"tiers":["process"],"wait":\#(quick)}"#).result)
        #expect(after["step"]?["status"]?.stringValue == "ok")
    }

    @Test func aCancelDuringTheClosingWaitLetsGoOfHeldInput() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let wiring = rig.input.wiring
        rig.input.onPerform = { _, target in
            wiring.onHeld(.pressing(held(target.pid)))
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        let long = #"{"minMs":0,"quietMs":5000,"maxMs":5000,"busyMaxMs":5000}"#
        let id = rig.send("action.run", "{\(docTarget),\"action\":{\"action\":\"left_mouse_down\"},\"tiers\":[\"process\"],\"wait\":\(long)}")
        #expect(await eventually { rig.log.count("perform") == 1 })
        try await Task.sleep(for: .milliseconds(50))
        rig.cancel(id)
        let answer = try #require(await rig.answer(id).result)
        #expect(answer["observationError"]?["kind"]?.stringValue == "cancelled")
        #expect(answer["observation"] == nil)
        #expect(rig.input.releasedPids == [500])
    }

    @Test func thePersonsInputInterruptsTheSessionHoldingIt() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let wiring = rig.input.wiring
        rig.input.onPerform = { _, target in
            wiring.onHeld(.pressing(held(target.pid, kind: .key)))
            return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"hold_key\",\"text\":\"shift\",\"duration\":1},\"tiers\":[\"session\"],\"wait\":\(quick)}")
        wiring.onPersonInput(500)
        #expect(await eventually { rig.lines.notifications("session/interrupted").first?["session"]?.stringValue == "s1" })
    }

    @Test func aThrownInterruptionAlsoSaysSo() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { _, _ in throw ComputerError(kind: .interrupted, message: "the person moved the mouse", by: .person) }
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":[1,1]},\"tiers\":[\"session\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["error"]?["kind"]?.stringValue == "interrupted")
        #expect(await eventually { !rig.lines.notifications("session/interrupted").isEmpty })
    }

    @Test func closingASessionCancelsItsActionInFlightFirst() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { _, target in
            while !target.cancelled() { usleep(2_000) }
            throw ComputerError(kind: .cancelled, message: "cancelled")
        }
        let action = rig.send("action.run", "{\(docTarget),\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(await eventually { rig.log.count("perform") == 1 })
        let close = await rig.call("session.close", #"{"session":"s1"}"#)
        #expect(close.result == .object([:]))
        let answer = try #require(await rig.answer(action).result)
        #expect(answer["step"]?["error"]?["kind"]?.stringValue == "cancelled")
        let frames = rig.lines.frames
        let actionAt = try #require(frames.firstIndex { if case .result(action, _) = $0 { true } else { false } })
        let closeAt = try #require(frames.firstIndex { if case .result(close.id, _) = $0 { true } else { false } })
        #expect(actionAt < closeAt, "close answers after the action it cancelled")
        #expect(rig.reader().closed)
    }

    @Test func closingASessionWakesAStreamWaitingForItsAppAndStartsNone() async throws {
        let rig = ServiceRig()
        await rig.ready(session: "s1")
        _ = await rig.call("session.open", #"{"session":"s2"}"#)
        let release = CancelFlag()
        rig.input.onPerform = { _, _ in
            while !release.isSet { usleep(2_000) }
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        let busy = rig.send("action.run", #"{"session":"s2","app":{"app":"Doc"},"action":{"action":"key","text":"a"},"tiers":["process"],"wait":\#(quick)}"#)
        #expect(await eventually { rig.log.count("perform") == 1 })
        let stream = rig.send("capture.stream.start", "{\(docTarget),\"stream\":\"p1\"}")
        try await Task.sleep(for: .milliseconds(50))
        _ = await rig.call("session.close", #"{"session":"s1"}"#)
        #expect(await rig.answer(stream).error?.data?.kind == .cancelled)
        release.set()
        _ = await rig.answer(busy)
        #expect(rig.log.count("startStream") == 0)
    }

    @Test func closingASessionLetsGoOfItsHeldInputAndReaders() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let wiring = rig.input.wiring
        rig.input.onPerform = { _, target in
            wiring.onHeld(.pressing(held(target.pid)))
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_mouse_down\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        _ = await rig.call("session.close", #"{"session":"s1"}"#)
        #expect(rig.input.releasedPids == [500])
        #expect(rig.reader().closed)
        let after = await rig.call("state.get", "{\(docTarget)}")
        #expect(after.error?.data?.kind == .unknownSession)
    }

    @Test func launchStartsTheAppInTheBackgroundAndWaitsForItsWindow() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let result = try #require(await rig.call("state.get", #"{"session":"s1","app":{"app":"Notes"},"launch":true,"wait":\#(quick)}"#).result)
        #expect(rig.workspace.launchCount == 1)
        #expect(result["app"]?["pid"]?.intValue == 600)
        #expect(result["window"]?["id"]?.intValue == 9)
        let notRunning = await rig.call("state.get", #"{"session":"s1","app":{"app":"Notess"}}"#)
        #expect(notRunning.error?.data?.kind == .appNotFound)
    }
}

@Suite struct CaptureTests {
    @Test func everyPicturePathGoesThroughTheGuard() async throws {
        let rig = ServiceRig(screenRecording: false)
        await rig.ready()
        let screenshot = await rig.call("capture.screenshot", "{\(docTarget)}")
        #expect(screenshot.error?.data?.kind == .permissionMissing)
        #expect(screenshot.error?.data?.which == .screenRecording)
        let stream = await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\"}")
        #expect(stream.error?.data?.kind == .permissionMissing)
        for action in [#"{"action":"screenshot"}"#, #"{"action":"zoom","region":[0,0,100,100]}"#] {
            let step = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(action),\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
            #expect(step["step"]?["error"]?["kind"]?.stringValue == "permission_missing")
        }
        let observation = try #require(await rig.call("state.get", "{\(docTarget),\"screenshot\":\"always\",\"wait\":\(quick)}").result)
        #expect(observation["shotError"]?["kind"]?.stringValue == "permission_missing")
        #expect(rig.log.count("screenshot") == 0)
        #expect(rig.log.count("startStream") == 0)
    }

    @Test func aMinimizedWindowIsRefused() async throws {
        let rig = ServiceRig()
        rig.windows.set(500, [window(7, "Doc", minimized: true)])
        await rig.ready()
        let answer = await rig.call("capture.screenshot", "{\(docTarget)}")
        #expect(answer.error?.data?.kind == .windowMinimized)
    }

    @Test func aZoomMapsItsRegionToWindowPointsAndKeepsTheSpace() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"screenshot\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"zoom\",\"region\":[0,0,160,80]},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(rig.log.all.contains { $0.hasSuffix("-zoom region=100x50") })
        #expect(rig.service.book.space("s1", window: 7)?.width == 1280)
    }

    @Test func aStreamSendsFramesWithTheCursorTakesAcksAndStopsById() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"mouse_move\",\"coordinate\":[640,480]},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        let started = try #require(await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\",\"maxEdge\":960}").result)
        #expect(started["width"]?.intValue == 960)
        let stream = try #require(rig.capture.stream(7))
        stream.onFrame(Frame(seq: 1, jpeg: Data([1, 2, 3]), width: 400, height: 300, ts: 1))
        #expect(await eventually { !rig.lines.notifications("capture/frame").isEmpty })
        let frame = try #require(rig.lines.notifications("capture/frame").first)
        #expect(frame["data"]?.stringValue == Data([1, 2, 3]).base64EncodedString())
        #expect(frame["cursor"]?.arrayValue?.compactMap(\.intValue) == [200, 150])
        rig.write(#"{"jsonrpc":"2.0","method":"capture.stream.ack","params":{"stream":"p1","seq":1}}"#)
        #expect(await eventually { stream.acked == [1] })
        _ = await rig.call("capture.stream.stop", #"{"stream":"p1"}"#)
        #expect(await eventually { rig.lines.notifications("capture/streamEnded").first?["reason"]?.stringValue == "stopped" })
        let unknown = await rig.call("capture.stream.stop", #"{"stream":"nope"}"#)
        #expect(unknown.result == .object([:]))
        #expect(rig.lines.notifications("capture/streamEnded").count == 1)
    }

    @Test func aStreamThatEndsOnItsOwnSaysWhy() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p2\"}")
        rig.capture.stream(7)?.end(.windowClosed)
        #expect(await eventually { rig.lines.notifications("capture/streamEnded").first?["reason"]?.stringValue == "window-closed" })
    }

    @Test func aWindowChangeInvalidatesCaptureAndIsCoalesced() async {
        let rig = ServiceRig()
        await rig.ready()
        rig.windowEvents.send(WindowEvent(pid: 500, windowID: 7, change: .moved))
        #expect(await eventually { rig.log.count("invalidate") == 1 })
        #expect(await eventually { rig.lines.notifications("window/changed").first?["change"]?.stringValue == "moved" })
        rig.appEvents.send(AppEvent(pid: 500, bundleId: "com.example.Doc", name: "Doc", change: .activated))
        #expect(await eventually { rig.lines.notifications("apps/changed").first?["change"]?.stringValue == "activated" })
    }
}

@Suite struct ServiceStateTests {
    @Test func appsListPutsTheFrontmostFirstAndListsWindowsWhenAsked() async throws {
        let rig = ServiceRig()
        rig.workspace.apps.append(RunningApp(pid: 501, bundleId: "com.example.Alpha", name: "Alpha", path: nil, active: true, hidden: false))
        rig.windows.set(501, [])
        await rig.ready()
        let apps = try #require(await rig.call("apps.list").result?["apps"]?.arrayValue)
        #expect(apps.map { $0["name"]?.stringValue } == ["Alpha", "Doc"])
        #expect(apps[0]["windows"] == nil)
        let withWindows = try #require(await rig.call("apps.list", #"{"windows":true}"#).result?["apps"]?.arrayValue)
        #expect(withWindows[1]["windows"]?.arrayValue?.count == 2)
        let launched = try #require(await rig.call("apps.launch", #"{"app":"Notes"}"#).result)
        #expect(launched["launched"]?.boolValue == true)
        #expect(launched["pid"]?.intValue == 600)
    }

    @Test func permissionsGetAnswersWhileEverySlotIsTaken() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.reader().hang = true
        for _ in 0..<34 { rig.send("state.get", "{\(docTarget),\"wait\":\(quick)}") }
        try await Task.sleep(for: .milliseconds(50))
        let start = ContinuousClock.now
        let answer = await rig.call("permissions.get")
        #expect(answer.result?["accessibility"]?.boolValue == true)
        #expect(ContinuousClock.now - start < .milliseconds(500))
        rig.reader().hang = false
    }

    @Test func clipboardStateSaysWhenSomeoneElseCopied() async throws {
        let rig = ServiceRig(timing: { $0.clipboardPoll = .milliseconds(10) })
        await rig.ready()
        let before = try #require(await rig.call("clipboard.state").result)
        #expect(before["foreignChangeAt"] == .null || before["foreignChangeAt"] == nil)
        rig.system.copy()
        try await Task.sleep(for: .milliseconds(60))
        let after = try #require(await rig.call("clipboard.state").result)
        #expect(after["foreignChangeAt"]?.doubleValue != nil)
        #expect(after["changeCount"]?.intValue == 11)
    }

    @Test func permissionsRequestAsksTheSystemOncePerRun() async throws {
        let rig = ServiceRig(accessibility: false)
        await rig.ready()
        _ = await rig.call("permissions.request", #"{"which":"accessibility"}"#)
        _ = await rig.call("permissions.request", #"{"which":"accessibility"}"#)
        #expect(rig.permissions.asked == ["accessibility"])
    }

    @Test func aGrantARequestReadsFirstStillSaysChangedAndRestarts() async throws {
        let rig = ServiceRig(screenRecording: false, timing: { $0.permissionPollOff = .seconds(60) })
        await rig.ready()
        rig.permissions.set(screenRecording: true)
        _ = await rig.call("permissions.request", #"{"which":"screenRecording"}"#)
        #expect(await eventually { rig.lines.notifications("permissions/changed").first?["screenRecording"]?.boolValue == true })
        #expect(await eventually { rig.exits.first == 75 })
    }

    @Test func probeAndRestoreReachInput() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let probe = try #require(await rig.call("input.probe", "{\(docTarget)}").result)
        #expect(probe["results"]?.arrayValue?.count == 3)
        let restore = try #require(await rig.call("input.restoreSession").result)
        #expect(restore["frontmost"]?.stringValue == "nothing")
    }
}

@Suite struct LifecycleTests {
    @Test func stdinClosingExitsZero() async {
        let rig = ServiceRig()
        await rig.ready()
        rig.closeStdin()
        #expect(await eventually(.seconds(3)) { rig.exits.first == 0 })
    }

    @Test func shutdownExitsInsideTwoSecondsEvenWithAHungReader() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.reader().hang = true
        rig.send("state.get", "{\(docTarget),\"wait\":\(quick)}")
        #expect(await eventually { rig.log.count("observe") == 1 })
        let start = ContinuousClock.now
        let answer = await rig.call("shutdown")
        #expect(answer.result == .object([:]))
        #expect(await eventually(.seconds(3)) { rig.exits.first != nil })
        #expect(rig.exits.first == 0)
        #expect(ContinuousClock.now - start < .milliseconds(2_500))
        let late = await rig.call("permissions.get", timeout: .milliseconds(300))
        #expect(late.result == nil)
        rig.reader().hang = false
    }

    @Test func anOutboxPastItsBudgetExits70() async {
        let rig = ServiceRig()
        await rig.ready()
        rig.service.outboxClosed(.overBudget)
        #expect(await eventually { rig.exits.first == 70 })
    }

    @Test func screenRecordingComingOnRestartsWith75() async {
        let rig = ServiceRig(screenRecording: false, timing: { $0.permissionPollOff = .milliseconds(20) })
        await rig.ready()
        rig.permissions.set(screenRecording: true)
        #expect(await eventually { rig.lines.notifications("permissions/changed").first?["screenRecording"]?.boolValue == true })
        #expect(await eventually { rig.exits.first == 75 })
    }

    @Test func theDeadlineEndsTheProcessWhateverIsUnfinished() async {
        let rig = ServiceRig(timing: { $0.exitDeadline = .milliseconds(300) })
        await rig.ready()
        let wiring = rig.input.wiring
        rig.input.onPerform = { _, target in
            wiring.onHeld(.pressing(held(target.pid)))
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_mouse_down\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        rig.reader().hang = true
        rig.service.lifecycle.windDown = { try? await Task.sleep(for: .seconds(10)) }
        let start = ContinuousClock.now
        rig.service.lifecycle.exit(0, why: "test")
        #expect(await eventually(.seconds(2)) { rig.exits.first == 0 })
        #expect(ContinuousClock.now - start < .milliseconds(800))
        rig.reader().hang = false
    }
}

@Suite struct PrivateSymbolTests {
    @Test func aPublicSymbolResolvesAndAForcedMissMisses() {
        typealias Trusted = @convention(c) () -> DarwinBoolean
        #expect(PrivateSymbol.lookup("AXIsProcessTrusted", as: Trusted.self) != nil)
        PrivateSymbol.forcedMisses = ["AXIsProcessTrusted"]
        defer { PrivateSymbol.forcedMisses = [] }
        #expect(PrivateSymbol.lookup("AXIsProcessTrusted", as: Trusted.self) == nil)
        #expect(PrivateSymbol.lookup("tc_no_such_symbol", as: Trusted.self) == nil)
        #expect(PrivateSymbol.misses("all") == ["all"])
        #expect(PrivateSymbol.misses(" a, b ,") == ["a", "b"])
    }
}
