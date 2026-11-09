import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

private final class Reasons: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Outbox.CloseReason] = []
    func add(_ r: Outbox.CloseReason) { lock.locked { list.append(r) } }
    var all: [Outbox.CloseReason] { lock.locked { list } }
}

@Suite struct OutboxTests {
    @Test func controlGoesBeforeFrames() async {
        let sink = RecordingSink()
        let outbox = Outbox(sink: sink, onClosed: { _ in })
        outbox.frame(line("frame-1\n"))
        outbox.respond(line("response\n"))
        outbox.notify(line("note\n"))
        outbox.frame(line("frame-2\n"))
        outbox.start()
        #expect(await eventually { sink.lines.count == 4 })
        #expect(sink.lines.map { String(decoding: $0, as: UTF8.self) } == ["response\n", "note\n", "frame-1\n", "frame-2\n"])
    }

    @Test func anUnsentWindowChangeIsReplacedByTheNewerOne() async {
        let sink = RecordingSink()
        let outbox = Outbox(sink: sink, onClosed: { _ in })
        outbox.notify(line("moved-1\n"), kind: .coalesce("1:2:moved"))
        outbox.notify(line("titled\n"), kind: .coalesce("1:2:titled"))
        outbox.notify(line("moved-2\n"), kind: .coalesce("1:2:moved"))
        outbox.start()
        #expect(await eventually { sink.lines.count == 2 })
        try? await Task.sleep(for: .milliseconds(20))
        #expect(sink.lines.map { String(decoding: $0, as: UTF8.self) } == ["moved-2\n", "titled\n"])
    }

    @Test func pastTheLogCapTheOldestGoAndOneWarnSaysHowMany() async {
        let sink = RecordingSink()
        let outbox = Outbox(sink: sink, maxLogs: 3, onClosed: { _ in })
        for n in 1...5 { outbox.notify(line("log-\(n)\n"), kind: .log) }
        outbox.start()
        #expect(await eventually { sink.lines.count == 4 })
        let texts = sink.lines.map { String(decoding: $0, as: UTF8.self) }
        #expect(texts[0].contains("2 log lines were dropped"))
        #expect(Array(texts.dropFirst()) == ["log-3\n", "log-4\n", "log-5\n"])
        if case .notification("log", let params) = try? decodeLine(sink.lines[0]) {
            #expect(params["level"] == .string("warn"))
        } else {
            Issue.record("the dropped line is a log notification")
        }
    }

    @Test func aSinkThatThrowsClosesItOnceAsHostGone() async {
        let sink = RecordingSink(held: true)
        let reasons = Reasons()
        let outbox = Outbox(sink: sink, onClosed: { reasons.add($0) })
        outbox.start()
        outbox.respond(line("a\n"))
        outbox.respond(line("b\n"))
        sink.fail()
        #expect(await eventually { !reasons.all.isEmpty })
        try? await Task.sleep(for: .milliseconds(20))
        #expect(reasons.all == [.hostGone])
        #expect(outbox.isClosed)
    }

    @Test func unreadOutputPastTheBudgetClosesItAsOverBudget() async {
        let sink = RecordingSink(held: true)
        let reasons = Reasons()
        let outbox = Outbox(sink: sink, budgetBytes: 100, onClosed: { reasons.add($0) })
        outbox.start()
        for _ in 0..<5 { outbox.respond(Data(repeating: 0x61, count: 30)) }
        #expect(await eventually { reasons.all == [.overBudget] })
        outbox.respond(Data(repeating: 0x61, count: 30))
        #expect(reasons.all == [.overBudget])
        sink.open()
    }

    @Test func drainStopsAtItsDeadline() async {
        let sink = RecordingSink(held: true)
        let outbox = Outbox(sink: sink, onClosed: { _ in })
        outbox.start()
        outbox.respond(line("stuck\n"))
        let start = ContinuousClock.now
        await outbox.drain(until: .now + .milliseconds(60))
        let took = ContinuousClock.now - start
        #expect(took >= .milliseconds(55) && took < .milliseconds(500))
        sink.open()
        await outbox.drain(until: .now + .seconds(2))
        #expect(outbox.isIdle)
        #expect(sink.lines.count == 1)
    }

    @Test func onWrittenRunsOnceTheLineIsOut() async {
        let sink = RecordingSink(held: true)
        let outbox = Outbox(sink: sink, onClosed: { _ in })
        let written = Counter()
        outbox.start()
        outbox.respond(line("r\n"), onWritten: { written.bump() })
        try? await Task.sleep(for: .milliseconds(20))
        #expect(written.count == 0)
        sink.open()
        #expect(await eventually { written.count == 1 })
    }

    @Test func aNotificationLineIsOneFrame() throws {
        let data = notificationLine(method: "window/changed", params: WindowChangedNotification.Params(pid: 1, windowId: 2, change: .moved))
        #expect(data.last == 0x0A)
        #expect(data.dropLast().contains(0x0A) == false)
        #expect(try decodeLine(data.dropLast()) == .notification(method: "window/changed", params: .object(["pid": .number(1), "windowId": .number(2), "change": .string("moved")])))
    }
}
