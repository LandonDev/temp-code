import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

@Suite struct MacLocksTests {
    @Test func twoLeasesOnOneNameExcludeEachOtherInOneProcess() throws {
        let locks = MacLocks(directory: tempDirectory())
        let first = try #require(locks.acquire(.clipboard, timeout: .milliseconds(50)))
        #expect(locks.acquire(.clipboard, timeout: .milliseconds(40)) == nil)
        #expect(locks.acquire(.session, timeout: .milliseconds(40)) != nil, "the two names are two locks")
        first.release()
        #expect(locks.acquire(.clipboard, timeout: .milliseconds(40)) != nil)
    }

    @Test func aLockThatStaysTakenGivesNilAfterItsTimeout() throws {
        let locks = MacLocks(directory: tempDirectory())
        let held = try #require(locks.acquire(.session, timeout: .zero))
        let start = ContinuousClock.now
        #expect(locks.acquire(.session, timeout: .milliseconds(80)) == nil)
        #expect(ContinuousClock.now - start >= .milliseconds(75))
        held.release()
    }

    @Test func releaseIsIdempotentAndADroppedLeaseFreesOnDeinit() throws {
        let locks = MacLocks(directory: tempDirectory())
        let lease = try #require(locks.acquire(.clipboard, timeout: .zero))
        lease.release()
        lease.release()
        do { _ = locks.acquire(.clipboard, timeout: .zero) }
        #expect(locks.acquire(.clipboard, timeout: .zero) != nil, "the lease above went out of scope and let go")
    }

    @Test func theDirectoryIsMadePrivateAndNamedAfterTheProtocol() throws {
        let root = tempDirectory()
        let dir = root.appendingPathComponent("tc-computer")
        _ = MacLocks(directory: dir).acquire(.clipboard, timeout: .zero)
        let mode = try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o700)
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("clipboard.lock").path))
        #expect(MacLocks.defaultDirectory().lastPathComponent == "tc-computer")
    }

    @Test func aFileLockExcludesASecondHolder() throws {
        let path = tempDirectory().appendingPathComponent("service.lock").path
        let first = try #require(FileLock.acquire(path, timeout: .zero))
        #expect(FileLock.acquire(path, timeout: .milliseconds(30)) == nil)
        first.release()
        #expect(FileLock.acquire(path, timeout: .zero) != nil)
    }
}

@Suite struct AppMatcherTests {
    let running = [
        AppCandidate(pid: 10, bundleId: "com.apple.TextEdit", name: "TextEdit", path: "/System/Applications/TextEdit.app"),
        AppCandidate(pid: 11, bundleId: "com.apple.Terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app"),
        AppCandidate(pid: 12, bundleId: "com.google.Chrome", name: "Google Chrome", path: "/Applications/Google Chrome.app")
    ]
    let installed = [
        AppCandidate(bundleId: "com.apple.Notes", name: "Notes", path: "/System/Applications/Notes.app"),
        AppCandidate(bundleId: "com.apple.TextEdit", name: "TextEdit", path: "/System/Applications/TextEdit.app")
    ]

    @Test func theOrderIsBundleIdNameInstalledThenPrefix() {
        #expect(AppMatcher.match("com.apple.Terminal", running: running, installed: installed, launch: false) == .running(pid: 11))
        #expect(AppMatcher.match("textedit", running: running, installed: installed, launch: false) == .running(pid: 10))
        #expect(AppMatcher.match("Notes", running: running, installed: installed, launch: true) == .launch(path: "/System/Applications/Notes.app"))
        #expect(AppMatcher.match("com.apple.Notes", running: running, installed: installed, launch: true) == .launch(path: "/System/Applications/Notes.app"))
        #expect(AppMatcher.match("goo", running: running, installed: installed, launch: false) == .running(pid: 12))
    }

    @Test func aRunningNameBeatsAnInstalledOne() {
        #expect(AppMatcher.match("TextEdit", running: running, installed: installed, launch: true) == .running(pid: 10))
    }

    @Test func anAbsoluteAppPathIsTheRunningAppElseALaunch() {
        #expect(AppMatcher.match("/System/Applications/TextEdit.app/", running: running, installed: [], launch: false) == .running(pid: 10))
        #expect(AppMatcher.match("/tmp/TC Probe.app", running: running, installed: [], launch: true) == .launch(path: "/tmp/TC Probe.app"))
        #expect(AppMatcher.match("/tmp/TC Probe.app", running: running, installed: [], launch: false) == .notFound(candidates: [], launchable: true))
    }

    @Test func anAmbiguousPrefixIsNotFoundWithTheMatchesFirst() {
        guard case .notFound(let names, let launchable) = AppMatcher.match("te", running: running, installed: installed, launch: false) else {
            Issue.record("two apps start with te")
            return
        }
        #expect(Array(names.prefix(2)).sorted() == ["Terminal", "TextEdit"])
        #expect(!launchable)
    }

    @Test func anInstalledAppThatWouldMatchWithLaunchLeadsTheCandidates() {
        guard case .notFound(let names, let launchable) = AppMatcher.match("notes", running: running, installed: installed, launch: false) else {
            Issue.record("Notes is installed but not running")
            return
        }
        #expect(launchable)
        #expect(names.first == "Notes")
        #expect(names.count <= 5)
    }

    @Test func atMostFiveCandidatesClosestFirst() {
        let many = (1...9).map { AppCandidate(pid: Int32($0), name: "App \($0)") } + [AppCandidate(pid: 99, name: "Zed")]
        guard case .notFound(let names, _) = AppMatcher.match("Zes", running: many, installed: [], launch: false) else {
            Issue.record("no app is named Zes")
            return
        }
        #expect(names.count == 5)
        #expect(names.first == "Zed")
    }

    @Test func editDistanceIsLevenshtein() {
        #expect(AppMatcher.editDistance("kitten", "sitting") == 3)
        #expect(AppMatcher.editDistance("", "abc") == 3)
        #expect(AppMatcher.editDistance("same", "same") == 0)
    }
}

@Suite struct SessionBookTests {
    @Test func seqCountsFullDiffAndUnchangedAndBaseIsTheOneBefore() {
        let book = SessionBook()
        book.open("s")
        #expect(book.stamp("s", pid: 1, kind: .full) == (1, nil))
        #expect(book.stamp("s", pid: 1, kind: .diff) == (2, 1))
        #expect(book.stamp("s", pid: 1, kind: .subtree) == (2, nil))
        #expect(book.stamp("s", pid: 1, kind: .unchanged) == (3, 2))
        #expect(book.stamp("s", pid: 2, kind: .full) == (1, nil), "per app")
    }

    @Test func openIsIdempotentAndCloseForgets() {
        let book = SessionBook()
        book.open("s")
        _ = book.stamp("s", pid: 1, kind: .full)
        book.open("s")
        #expect(book.stamp("s", pid: 1, kind: .diff) == (2, 1))
        book.close("s")
        #expect(!book.isOpen("s"))
        book.open("s")
        #expect(book.stamp("s", pid: 1, kind: .full) == (1, nil))
    }

    @Test func itKeepsTheCursorThinHeldAndSpace() {
        let book = SessionBook()
        book.open("s")
        book.setCursor("s", pid: 1, [5, 6])
        book.noteThin("s", pid: 1, thin: true)
        book.setHeld("s", pid: 1, tier: .process)
        book.setHeld("s", pid: 3, tier: .session)
        book.setSpace("s", window: 9, CoordinateSpace(width: 100, height: 80, scale: 2))
        #expect(book.cursor("s", pid: 1) == [5, 6])
        #expect(book.lastThin("s", pid: 1))
        #expect(!book.lastThin("s", pid: 2))
        #expect(book.heldPids("s") == [1, 3])
        book.setHeld("s", pid: 1, tier: nil)
        #expect(book.heldPids("s") == [3])
        #expect(book.space("s", window: 9) == CoordinateSpace(width: 100, height: 80, scale: 2))
        #expect(book.cursor("other", pid: 1) == nil)
    }

    @Test func theEpochCheckRunsBeforeAnything() {
        #expect(EpochCheck.check(names: nil, epoch: nil, current: "e1") == nil)
        #expect(EpochCheck.check(names: 4, epoch: "e1", current: "e1") == nil)
        #expect(EpochCheck.check(names: 4, epoch: nil, current: "e1") is RPCFailure)
        let stale = EpochCheck.check(names: 4, epoch: "e0", current: "e1") as? ComputerError
        #expect(stale?.kind == .staleElement)
        #expect(stale?.reason == .serviceRestarted)
        #expect(stale?.element == 4)
    }
}

private struct Record: HeldEntry {
    var writer: Int32
    var pid: Int32
    var kind: String
    var kindKey: String { kind }
}

@Suite struct HeldLedgerTests {
    @Test func pressingWritesAndReleasedClears() throws {
        let file = tempDirectory().appendingPathComponent("held.json")
        let ledger = HeldLedger<Record>(file: file)
        try ledger.pressing(Record(writer: 1, pid: 10, kind: "button"))
        try ledger.pressing(Record(writer: 1, pid: 10, kind: "key"))
        try ledger.pressing(Record(writer: 1, pid: 10, kind: "button"))
        #expect(HeldLedger<Record>(file: file).records.count == 2, "a second down of one kind replaces the first")
        try ledger.released(pid: 10, kindKey: "button")
        #expect(HeldLedger<Record>(file: file).records == [Record(writer: 1, pid: 10, kind: "key")])
    }

    @Test func staleRecordsAreTheDeadWritersAndLeaveTheFile() throws {
        let file = tempDirectory().appendingPathComponent("held.json")
        let ledger = HeldLedger<Record>(file: file)
        try ledger.pressing(Record(writer: 111, pid: 10, kind: "button"))
        try ledger.pressing(Record(writer: 222, pid: 11, kind: "key"))
        let stale = try HeldLedger<Record>(file: file).takeStale(isAlive: { $0 == 222 })
        #expect(stale == [Record(writer: 111, pid: 10, kind: "button")])
        #expect(HeldLedger<Record>(file: file).records == [Record(writer: 222, pid: 11, kind: "key")])
    }

    @Test func aMissingOrBrokenFileIsAnEmptyLedger() throws {
        let dir = tempDirectory()
        #expect(HeldLedger<Record>(file: dir.appendingPathComponent("none.json")).records.isEmpty)
        let broken = dir.appendingPathComponent("broken.json")
        try Data("{".utf8).write(to: broken)
        #expect(HeldLedger<Record>(file: broken).records.isEmpty)
    }

    @Test func thisProcessIsAliveAndANonsensePidIsNot() {
        #expect(HeldLedger<Record>.processAlive(getpid()))
        #expect(!HeldLedger<Record>.processAlive(Int32.max - 7))
    }
}

@Suite struct ClipboardWatchRuleTests {
    @Test func itsOwnHoldsDoNotCountAndOtherChangesDo() {
        var rule = ClipboardWatchRule(changeCount: 5, now: 1_000)
        rule.observe(changeCount: 6, ownHoldSinceLastPoll: true, at: 1_250)
        #expect(rule.foreignChangeAt == nil)
        rule.observe(changeCount: 7, ownHoldSinceLastPoll: false, at: 1_500)
        #expect(rule.foreignChangeAt == 1_500)
        rule.observe(changeCount: 7, ownHoldSinceLastPoll: false, at: 1_750)
        #expect(rule.foreignChangeAt == 1_500, "no change, no stamp")
        #expect(rule.state == ClipboardActivity(changeCount: 7, foreignChangeAt: 1_500, watchingSince: 1_000))
    }

    @Test func aPersonsCopyDuringAPasteStampsIt() {
        var rule = ClipboardWatchRule(changeCount: 1, now: 0)
        rule.personCopiedDuringPaste(at: 300)
        #expect(rule.foreignChangeAt == 300)
    }

    @Test func quietCountsFromTheLaterOfTheLastForeignChangeAndTheWatchStart() {
        var rule = ClipboardWatchRule(changeCount: 1, now: 10_000)
        #expect(!rule.quiet(for: 5_000, now: 12_000), "a copy before the watch began is invisible, so it is not quiet yet")
        #expect(rule.quiet(for: 5_000, now: 15_000))
        rule.observe(changeCount: 2, ownHoldSinceLastPoll: false, at: 16_000)
        #expect(!rule.quiet(for: 5_000, now: 20_000))
        #expect(rule.quiet(for: 5_000, now: 21_000))
    }
}

@Suite struct TraceTests {
    @Test func aFramesJPEGPrintsAsItsSize() {
        let text = Trace.frameText(line(#"{"jsonrpc":"2.0","method":"capture/frame","params":{"data":"QUJDREVG","seq":1}}"# + "\n"))
        #expect(text == #"{"jsonrpc":"2.0","method":"capture/frame","params":{"data":"<jpeg 6 bytes>","seq":1}}"#)
        #expect(Trace.frameText(line(#"{"data":"QUJD"}"#)) == #"{"data":"QUJD"}"#, "only capture/frame")
    }

    @Test func aLongLineIsCut() {
        let text = String(repeating: "a", count: 2_010)
        #expect(Trace.cut(text) == String(repeating: "a", count: 2_000) + "…(+10)")
        #expect(Trace.cut("short") == "short")
    }

    @Test func aWaitReadsAsOneLine() {
        #expect(Trace.waitText(WaitReport(waitedMs: 812, settled: true, busy: false, reason: .quiet), ax: 3, sig: 1, px: 0) == "wait 812ms quiet ax=3 sig=1 px=0")
        #expect(Trace.waitText(WaitReport(waitedMs: 5_000, settled: false, busy: true, reason: .busyMax), ax: 0, sig: 0, px: 0) == "wait 5000ms busy-max ax=0 sig=0 px=0 busy")
    }

    @Test func theStampIsSecondsToTheMillisecond() {
        #expect(Trace.stamp(.milliseconds(12_345)) == "[   12.345]")
        #expect(Trace.stamp(.milliseconds(7)) == "[    0.007]")
    }

    @Test func offItWritesOnlyWarningsAndErrors() {
        let lines = LinesBox()
        let trace = Trace(enabled: false, write: { lines.add($0) })
        trace.frameIn(line("{}"))
        trace.wait(WaitReport(waitedMs: 1, settled: true, busy: false, reason: .quiet), ax: 0, sig: 0, px: 0)
        trace.warn("w")
        trace.error("e")
        #expect(lines.all.count == 2)
        #expect(lines.all[0].hasSuffix("warn: w"))
        let on = Trace(enabled: true, write: { lines.add($0) })
        on.frameIn(line("{}"))
        #expect(lines.all.last?.hasSuffix("→ {}") == true)
    }
}

private final class LinesBox: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [String] = []
    func add(_ s: String) { lock.locked { list.append(s) } }
    var all: [String] { lock.locked { list } }
}

@Suite struct LineSplitterTests {
    @Test func itSplitsLinesAndKeepsAPartialOne() {
        var s = LineSplitter(maxBytes: 64)
        #expect(s.feed(line("a\nbc")) == [.line(line("a"))])
        #expect(s.feed(line("d\n\n")) == [.line(line("bcd"))])
    }

    @Test func anOverLongLineIsDroppedUpToItsNewlineOnce() {
        var s = LineSplitter(maxBytes: 4)
        #expect(s.feed(line("12345")) == [.overlong(5)])
        #expect(s.feed(line("6789")) == [])
        #expect(s.feed(line("0\nok\n")) == [.line(line("ok"))])
        #expect(s.feed(line("abcdefgh\nxy\n")) == [.overlong(8), .line(line("xy"))])
    }
}

@Suite struct AsyncGateTests {
    @Test func bodiesRunOneAtATimeInArrivalOrder() async {
        let gate = AsyncGate()
        let order = LinesBox()
        let inside = Counter()
        let most = LinesBox()
        await withTaskGroup(of: Void.self) { group in
            for n in 0..<5 {
                group.addTask {
                    try? await Task.sleep(for: .milliseconds(n * 3))
                    await gate.run {
                        inside.bump()
                        most.add("\(inside.count)")
                        order.add("start \(n)")
                        try? await Task.sleep(for: .milliseconds(10))
                        order.add("end \(n)")
                        inside.drop()
                    }
                }
            }
        }
        #expect(most.all.allSatisfy { $0 == "1" }, "never two bodies at once")
        let all = order.all
        for at in stride(from: 0, to: all.count, by: 2) {
            #expect(all[at].hasPrefix("start") && all[at + 1] == "end " + all[at].dropFirst("start ".count))
        }
    }
}
