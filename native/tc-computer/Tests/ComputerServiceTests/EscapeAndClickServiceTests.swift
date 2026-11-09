import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// Epoch ms moved by hand.
private final class HandClock: @unchecked Sendable {
    private let lock = NSLock()
    private var ms: Double = 1_000_000
    var now: Double { lock.withLock { ms } }
    func advance(_ by: Double) { lock.withLock { ms += by } }
}

private func watch(_ tap: FakeEscapeTap, _ clock: HandClock, pressed: Box<[Double]> = Box()) -> EscapeWatch {
    EscapeWatch(
        makeTap: { tap }, now: { clock.now },
        onPress: { at in pressed.value = (pressed.value ?? []) + [at] }, warn: { _ in }
    )
}

@Suite struct EscapeWatchTests {
    @Test func onStartsTheTapAndAPressIsToldWithItsTime() throws {
        let tap = FakeEscapeTap(), clock = HandClock(), pressed = Box<[Double]>()
        let escape = watch(tap, clock, pressed: pressed)
        try escape.set(on: true, leaseMs: nil)
        #expect(tap.running && escape.isOn)
        tap.press()
        #expect(pressed.value == [clock.now])
        escape.stop()
    }

    @Test func theLeaseEndsTheTapWithoutRenewal() throws {
        let tap = FakeEscapeTap(), clock = HandClock()
        let escape = watch(tap, clock)
        try escape.set(on: true, leaseMs: 5_000)
        clock.advance(4_999)
        escape.check()
        #expect(tap.running)
        clock.advance(1)
        escape.check()
        #expect(!tap.running && !escape.isOn)
        #expect(tap.stops == 1)
    }

    @Test func aRenewalKeepsTheTapAndStartsNoSecond() throws {
        let tap = FakeEscapeTap(), clock = HandClock()
        let escape = watch(tap, clock)
        try escape.set(on: true, leaseMs: 5_000)
        for _ in 0..<5 {
            clock.advance(4_000)
            escape.check()
            try escape.set(on: true, leaseMs: 5_000)
        }
        #expect(tap.running && tap.starts == 1)
        escape.stop()
    }

    @Test func offEndsTheTap() throws {
        let tap = FakeEscapeTap(), clock = HandClock()
        let escape = watch(tap, clock)
        try escape.set(on: true, leaseMs: nil)
        try escape.set(on: false, leaseMs: nil)
        #expect(!tap.running && tap.stops == 1)
        clock.advance(1e9)
        escape.check()
        #expect(tap.stops == 1)
    }

    @Test func aRefusedTapLeavesTheWatchOff() {
        let tap = FakeEscapeTap(), clock = HandClock()
        tap.refuse = true
        let escape = watch(tap, clock)
        #expect(throws: ComputerError.self) { try escape.set(on: true, leaseMs: nil) }
        #expect(!escape.isOn)
    }
}

@Suite struct EscapeRouteTests {
    @Test func theMethodTurnsTheTapOnAndOffAndAPressReachesTheHost() async throws {
        let rig = ServiceRig()
        await rig.ready()
        #expect(await rig.call("escape.watch", #"{"on":true,"leaseMs":30000}"#).result == .object([:]))
        #expect(rig.escapeTap.running)
        rig.escapeTap.press()
        #expect(await eventually { rig.lines.notifications("escape/pressed").count == 1 })
        #expect((rig.lines.notifications("escape/pressed").first?["at"]?.doubleValue ?? 0) > 0)
        _ = await rig.call("escape.watch", #"{"on":false}"#)
        #expect(!rig.escapeTap.running)
    }

    @Test func withoutAccessibilityItIsRefused() async throws {
        let rig = ServiceRig(accessibility: false)
        await rig.ready()
        let answer = await rig.call("escape.watch", #"{"on":true}"#)
        #expect(answer.error?.data?.kind == .permissionMissing)
        #expect(!rig.escapeTap.running)
    }

    @Test func shutdownEndsTheTap() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("escape.watch", #"{"on":true}"#)
        _ = await rig.call("shutdown")
        #expect(await eventually { !rig.escapeTap.running })
    }

    @Test func stdinClosingEndsTheTap() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("escape.watch", #"{"on":true}"#)
        rig.closeStdin()
        #expect(await eventually { !rig.escapeTap.running })
    }
}

@Suite struct ClickRecordTests {
    /// Input that marks every click-class step at its coordinate.
    private func clicking(_ rig: ServiceRig) {
        rig.input.onPerform = { action, _ in
            let click: Set<ComputerActionName> = [.leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftMouseDown, .perform]
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: action.coordinate, lastInputAt: mach_absolute_time(),
                                clickAt: click.contains(action.action) ? action.coordinate : nil)
        }
    }

    private func click(_ rig: ServiceRig, _ at: String, window: String = "") async {
        _ = await rig.call("action.run", "{\(docTarget)\(window),\"action\":{\"action\":\"left_click\",\"coordinate\":\(at)},\"tiers\":[\"process\"],\"wait\":\(quick),\"observe\":{\"mode\":\"none\"}}")
    }

    @Test func aClickIsMappedIntoTheStreamsFrameWithThatSizeAndNeedsNoPixelChange() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        let started = try #require(await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\",\"maxEdge\":960}").result)
        #expect(started["width"]?.intValue == 960)
        // no frame comes: the click still goes
        await click(rig, "[640,480]")
        #expect(await eventually { rig.lines.notifications("capture/click").count == 1 })
        let first = try #require(rig.lines.notifications("capture/click").first)
        #expect(first["stream"]?.stringValue == "p1")
        #expect(first["at"]?.arrayValue?.compactMap(\.intValue) == [480, 360])
        #expect(first["width"]?.intValue == 960 && first["height"]?.intValue == 720)
        #expect(rig.lines.notifications("capture/frame").isEmpty)

        // a frame of another size: the next click maps into it
        rig.capture.stream(7)?.onFrame(Frame(seq: 1, jpeg: Data([1]), width: 400, height: 300, ts: 1))
        await click(rig, "[640,480]")
        #expect(await eventually { rig.lines.notifications("capture/click").count == 2 })
        let second = try #require(rig.lines.notifications("capture/click").last)
        #expect(second["at"]?.arrayValue?.compactMap(\.intValue) == [200, 150])
        #expect(second["width"]?.intValue == 400 && second["height"]?.intValue == 300)
    }

    @Test func aStepThatIsNoClickSendsNothing() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        _ = await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\"}")
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"mouse_move\",\"coordinate\":[5,5]},\"tiers\":[\"process\"],\"wait\":\(quick),\"observe\":{\"mode\":\"none\"}}")
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/click").isEmpty)
    }

    @Test func aStreamStartedJustAfterTheClickGetsItOnceAfterItsAnswer() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        await click(rig, "[640,480]")
        let start = await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\",\"maxEdge\":960}")
        #expect(start.result != nil)
        #expect(await eventually { rig.lines.notifications("capture/click").count == 1 })
        let sent = try #require(rig.lines.notifications("capture/click").first)
        #expect(sent["stream"]?.stringValue == "p1")
        #expect(sent["at"]?.arrayValue?.compactMap(\.intValue) == [480, 360])
        // after the start's answer
        let frames = rig.lines.frames
        let answered = try #require(frames.firstIndex { if case .result(start.id, _) = $0 { true } else { false } })
        let clicked = try #require(frames.firstIndex { if case .notification("capture/click", _) = $0 { true } else { false } })
        #expect(answered < clicked)
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/click").count == 1)
    }

    @Test func aStreamOnAnotherWindowNeverGetsIt() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        await click(rig, "[640,480]")
        _ = await rig.call("capture.stream.start", "{\(docTarget),\"window\":{\"id\":8},\"stream\":\"p2\"}")
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/click").isEmpty)
    }

    @Test func aClickOnAnotherWindowIsNotSentToTheStream() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        _ = await rig.call("capture.stream.start", "{\(docTarget),\"stream\":\"p1\"}")
        await click(rig, "[10,10]", window: ",\"window\":{\"id\":8}")
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/click").isEmpty)
    }

    @Test func theCarryLapsesTwoSecondsAfterTheAnswer() async throws {
        let rig = ServiceRig()
        await rig.ready()
        clicking(rig)
        await click(rig, "[640,480]")
        // the click's call answered: the shell's own carry, read past its window
        let late = rig.service.env.system.now() + Double(ComputerDefaults.PreviewStream.clickCarryMs) + 1
        #expect(await eventually { rig.service.lock.withLock { rig.service.clicks.pending(session: "s1", windowID: 7, now: late) } == nil })
    }
}
