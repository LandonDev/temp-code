@testable import Capture
import Testing

@Suite struct StreamLifecycleTests {
    @Test func pauseAndResumeEachWaitForTheirCompletion() {
        var life = StreamLifecycle()
        #expect(life.pause() == .stopCapture)
        #expect(life.state == .pausing)
        #expect(life.completed() == nil)
        #expect(life.state == .paused)
        #expect(life.resume() == .startCapture)
        #expect(life.state == .resuming)
        #expect(life.completed() == nil)
        #expect(life.state == .running)
    }

    @Test func anAckDuringPausingResumesOnlyAfterThePause() {
        var life = StreamLifecycle()
        _ = life.pause()
        #expect(life.resume() == nil)
        #expect(life.state == .pausing)
        #expect(life.completed() == .startCapture)
        #expect(life.state == .resuming)
        #expect(life.completed() == nil)
        #expect(life.state == .running)
    }

    @Test func starvationDuringResumingPausesOnlyAfterTheResume() {
        var life = StreamLifecycle()
        _ = life.pause(); _ = life.completed(); _ = life.resume()
        #expect(life.pause() == nil)
        #expect(life.completed() == .stopCapture)
        #expect(life.state == .pausing)
        #expect(life.completed() == nil)
        #expect(life.state == .paused)
    }

    @Test func aPauseThenAResumeWhileResumingCancelsThePause() {
        var life = StreamLifecycle()
        _ = life.pause(); _ = life.completed(); _ = life.resume()
        _ = life.pause()
        #expect(life.resume() == nil)
        #expect(life.completed() == nil)
        #expect(life.state == .running)
    }

    @Test func stopFromRunningWaitsForItsStop() {
        var life = StreamLifecycle()
        #expect(life.stop() == .stopCapture)
        #expect(life.state == .stopping)
        #expect(life.completed() == .finish)
        #expect(life.state == .stopped)
    }

    @Test func stopWhilePausedFinishesAtOnce() {
        var life = StreamLifecycle()
        _ = life.pause(); _ = life.completed()
        #expect(life.stop() == .finish)
        #expect(life.state == .stopped)
    }

    @Test func stopDuringPausingWinsAndTheLateCompletionChangesNothing() {
        var life = StreamLifecycle()
        _ = life.pause()
        _ = life.resume()
        #expect(life.stop() == nil)
        #expect(life.completed() == .finish)
        #expect(life.state == .stopped)
        #expect(life.completed() == nil)
        #expect(life.resume() == nil)
        #expect(life.state == .stopped)
    }

    @Test func stopDuringResumingStopsTheStartThatLands() {
        var life = StreamLifecycle()
        _ = life.pause(); _ = life.completed(); _ = life.resume()
        #expect(life.stop() == nil)
        #expect(life.completed() == .stopCapture)
        #expect(life.state == .stopping)
        #expect(life.completed() == .finish)
        #expect(life.state == .stopped)
    }

    @Test func finishComesExactlyOnce() {
        var life = StreamLifecycle()
        var finishes = 0
        for command in [life.stop(), life.completed(), life.stop(), life.endedBySystem(), life.completed(), life.pause()] where command == .finish {
            finishes += 1
        }
        #expect(finishes == 1)
    }

    @Test func isEndingFromTheStopOnSoALateAckSendsNothing() {
        var life = StreamLifecycle()
        #expect(!life.isEnding)
        _ = life.pause()
        #expect(!life.isEnding)
        _ = life.completed(); _ = life.resume()
        #expect(!life.isEnding)
        _ = life.stop()
        #expect(life.isEnding)
        _ = life.completed(); _ = life.completed()
        #expect(life.isEnding)
        var ended = StreamLifecycle()
        _ = ended.endedBySystem()
        #expect(ended.isEnding)
    }

    @Test func theSystemEndingTheStreamFinishesItFromAnyState() {
        var life = StreamLifecycle()
        _ = life.pause()
        #expect(life.endedBySystem() == .finish)
        #expect(life.completed() == nil)
        #expect(life.stop() == nil)
        #expect(life.state == .stopped)
    }
}

@Suite struct LingerTests {
    @Test func aUseRenewsItAndItExpiresThirtySecondsAfterTheLast() {
        var linger = Linger(afterMs: 30_000, startMs: 0)
        #expect(!linger.expired(atMs: 29_999))
        linger.touch(atMs: 20_000)
        #expect(!linger.expired(atMs: 49_999))
        #expect(linger.expired(atMs: 50_000))
        #expect(linger.expiresAtMs == 50_000)
        linger.touch(atMs: 10_000)
        #expect(linger.expiresAtMs == 50_000, "an older touch never shortens it")
    }

    @Test func readsEveryFewSecondsKeepALongWaitAlive() {
        var linger = Linger(afterMs: 30_000, startMs: 0)
        for now in stride(from: 0.0, through: 40_000, by: 200) {
            #expect(!linger.expired(atMs: now))
            linger.touch(atMs: now)
        }
        #expect(!linger.expired(atMs: 69_999))
        #expect(linger.expired(atMs: 70_000))
    }
}

@Suite struct BaselineGateTests {
    @Test func liveAnswersTrueAtOnce() {
        var gate = BaselineGate<Int>()
        _ = gate.baseline()
        guard case .now(true) = gate.wait(1) else { Issue.record("expected an answer now"); return }
    }

    @Test func aBaselineInsideTheTimeoutAnswersTrue() {
        var gate = BaselineGate<String>()
        guard case .pending(let id) = gate.wait("first") else { Issue.record("expected to wait"); return }
        _ = gate.wait("second")
        #expect(gate.baseline() == ["first", "second"])
        #expect(gate.timeout(id) == nil, "answered already")
        #expect(gate.state == .live)
    }

    @Test func theTimeoutAnswersFalse() {
        var gate = BaselineGate<String>()
        guard case .pending(let id) = gate.wait("w") else { Issue.record("expected to wait"); return }
        #expect(gate.timeout(id) == "w")
        #expect(gate.baseline().isEmpty)
    }

    @Test func aStoppedWatchAnswersFalseAtOnce() {
        var gate = BaselineGate<String>()
        _ = gate.wait("w")
        #expect(gate.stop() == ["w"])
        guard case .now(false) = gate.wait("late") else { Issue.record("expected false now"); return }
        #expect(gate.baseline().isEmpty)
        #expect(gate.state == .stopped)
    }
}
