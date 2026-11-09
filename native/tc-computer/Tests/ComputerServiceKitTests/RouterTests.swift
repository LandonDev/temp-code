import ComputerProtocol
@testable import ComputerServiceKit
import Foundation
import Testing

private struct Echo: Codable, Sendable { var x: Int }
private struct Init: Codable, Sendable { var `protocol`: Int }
private struct Boom: Error {}

/// A router over a recording sink, with `echo`, `slow`, `block`, `boom`, `initialize`, `ping` and `shutdown`.
private final class Rig: @unchecked Sendable {
    let sink: RecordingSink
    let outbox: Outbox
    let router: Router
    let gate = Gate()
    let started = Counter()
    let closed = Counter()
    private let lock = NSLock()
    private var flags: [Int: CancelFlag] = [:]

    init(maxInFlight: Int = 32, maxQueued: Int = 256, sinkHeld: Bool = false) {
        sink = RecordingSink(held: sinkHeld)
        let closed = self.closed
        outbox = Outbox(sink: sink, onClosed: { _ in closed.bump() })
        router = Router(outbox: outbox, maxInFlight: maxInFlight, maxQueued: maxQueued)
        outbox.start()
        let router = self.router, gate = self.gate, started = self.started
        router.on("initialize", beforeInit: true) { (p: Init, _) -> Echo in
            guard p.protocol == computerProtocol else {
                throw ComputerError(kind: .protocolMismatch, message: "protocol \(p.protocol) is not 1")
            }
            router.markInitialized()
            return Echo(x: 1)
        }
        router.on("shutdown", beforeInit: true, slot: false) { (_: Empty, _) -> Empty in
            router.markShutDown()
            return Empty()
        }
        router.on("ping", slot: false) { (_: Empty, _) -> Echo in Echo(x: 0) }
        router.on("echo") { (p: Echo, _) -> Echo in
            started.bump()
            return p
        }
        router.on("slow") { (p: Echo, _) -> Echo in
            try await Task.sleep(for: .milliseconds(p.x))
            return p
        }
        router.on("block", keepsResult: true) { [self] (p: Echo, ctx) -> Echo in
            started.bump()
            lock.locked { flags[ctx.id] = ctx.cancel }
            await gate.wait(ctx.cancel)
            return Echo(x: ctx.cancel.isSet ? -1 : p.x)
        }
        router.on("boom") { (_: Empty, _) -> Empty in throw Boom() }
        router.on("finish") { [self] (p: Echo, ctx) -> Echo in
            lock.locked { flags[ctx.id] = ctx.cancel }
            await gate.wait(ctx.cancel)
            ctx.afterAnswer { [self] in started.bump() }
            return p
        }
    }

    func flag(_ id: Int) -> CancelFlag? { lock.locked { flags[id] } }

    func initialize() async {
        router.receive(request(0, "initialize", #"{"protocol":1}"#))
        _ = await eventually { router.isInitialized && sink.response(0) != nil }
    }
}

@Suite struct RouterTests {
    @Test func methodsBeforeInitializeAnswerNotInitialized() async {
        let rig = Rig()
        rig.router.receive(request(1, "echo", #"{"x":3}"#))
        #expect(await eventually { rig.sink.error(1) != nil })
        #expect(rig.sink.error(1)?.code == -32000)
        #expect(rig.sink.error(1)?.data?.kind == .notInitialized)
        #expect(rig.started.count == 0)
    }

    @Test func aProtocolMismatchLeavesItUninitializedThenAGoodInitializeWorks() async {
        let rig = Rig()
        rig.router.receive(request(1, "initialize", #"{"protocol":2}"#))
        #expect(await eventually { rig.sink.error(1) != nil })
        #expect(rig.sink.error(1)?.data?.kind == .protocolMismatch)
        rig.router.receive(request(2, "echo", #"{"x":1}"#))
        #expect(await eventually { rig.sink.error(2)?.data?.kind == .notInitialized })
        rig.router.receive(request(3, "initialize", #"{"protocol":1}"#))
        #expect(await eventually { rig.router.isInitialized })
        rig.router.receive(request(4, "echo", #"{"x":7}"#))
        #expect(await eventually { rig.sink.response(4) == .result(id: 4, result: .object(["x": .number(7)])) })
    }

    @Test func anUnknownMethodAnswersMethodNotFound() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(5, "nope"))
        #expect(await eventually { rig.sink.error(5)?.code == -32601 })
    }

    @Test func invalidParamsNameTheField() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(6, "echo", #"{"y":1}"#))
        #expect(await eventually { rig.sink.error(6) != nil })
        let error = rig.sink.error(6)
        #expect(error?.code == -32602)
        #expect(error?.message.contains("x") == true)
        rig.router.receive(request(7, "echo", #"{"x":"seven"}"#))
        #expect(await eventually { rig.sink.error(7)?.code == -32602 })
        #expect(rig.started.count == 0)
    }

    @Test func aLineThatIsNotJSONAnswersAParseErrorWithANullId() async {
        let rig = Rig()
        rig.router.receive(line("{not json"))
        #expect(await eventually { rig.sink.error(nil) != nil })
        #expect(rig.sink.error(nil)?.code == -32700)
        #expect(String(decoding: rig.sink.lines[0], as: UTF8.self).contains(#""id":null"#))
    }

    @Test func jsonThatIsNotJSONRPCAnswersInvalidRequest() async {
        let rig = Rig()
        rig.router.receive(line(#"{"id":9,"method":"echo"}"#))
        rig.router.receive(line("[1,2]"))
        #expect(await eventually { rig.sink.error(9) != nil && rig.sink.error(nil) != nil })
        #expect(rig.sink.error(9)?.code == -32600)
        #expect(rig.sink.error(nil)?.code == -32600)
    }

    @Test func anOverLongLineAnswersAParseError() async {
        let rig = Rig()
        var splitter = LineSplitter(maxBytes: 16)
        for item in splitter.feed(line(String(repeating: "x", count: 40) + "\n")) {
            if case .overlong(let bytes) = item { rig.router.receiveOverlong(bytes) }
        }
        #expect(await eventually { rig.sink.error(nil)?.code == -32700 })
    }

    @Test func responsesGoOutAsHandlersFinish() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(10, "slow", #"{"x":150}"#))
        rig.router.receive(request(11, "slow", #"{"x":1}"#))
        #expect(await eventually { rig.sink.response(10) != nil && rig.sink.response(11) != nil })
        let order = rig.sink.frames.compactMap { if case .result(let id, _) = $0 { id } else { nil } }
        #expect(order.firstIndex(of: 11)! < order.firstIndex(of: 10)!)
    }

    @Test func pastTheSlotsARequestWaitsInArrivalOrder() async {
        let rig = Rig(maxInFlight: 2)
        await rig.initialize()
        for id in 20...22 { rig.router.receive(request(id, "block", #"{"x":\#(id)}"#)) }
        #expect(await eventually { rig.started.count == 2 })
        try? await Task.sleep(for: .milliseconds(30))
        #expect(rig.started.count == 2)
        #expect(rig.router.load.waiting == 1)
        rig.gate.open()
        #expect(await eventually { (20...22).allSatisfy { rig.sink.response($0) != nil } })
        #expect(rig.started.count == 3)
    }

    @Test func aSlotFreesOnlyWhenItsResponseIsWritten() async {
        let rig = Rig(maxInFlight: 2, sinkHeld: true)
        rig.router.markInitialized()
        for id in 30...32 { rig.router.receive(request(id, "echo", #"{"x":1}"#)) }
        #expect(await eventually { rig.started.count == 2 })
        try? await Task.sleep(for: .milliseconds(30))
        #expect(rig.started.count == 2, "the handlers finished but nothing was written, so no slot is free")
        rig.sink.open()
        #expect(await eventually { rig.started.count == 3 && rig.sink.response(32) != nil })
    }

    @Test func pastTheQueueANewRequestIsOverloadedWhileCancelAndShutdownStillGoThrough() async {
        let rig = Rig(maxInFlight: 1, maxQueued: 2)
        await rig.initialize()
        for id in 40...42 { rig.router.receive(request(id, "block", #"{"x":1}"#)) }
        rig.router.receive(request(43, "block", #"{"x":1}"#))
        #expect(await eventually { rig.sink.error(43) != nil })
        #expect(rig.sink.error(43)?.code == -32603)
        #expect(rig.sink.error(43)?.message.contains("overloaded") == true)
        rig.router.receive(request(44, "ping"))
        #expect(await eventually { rig.sink.response(44) != nil }, "a slotless method answers with every slot taken")
        rig.router.receive(cancelLine(42))
        #expect(await eventually { rig.sink.error(42)?.data?.kind == .cancelled })
        rig.router.receive(request(45, "shutdown"))
        #expect(await eventually { rig.sink.response(45) != nil })
    }

    @Test func cancelOfAWaitingRequestAnswersCancelled() async {
        let rig = Rig(maxInFlight: 1)
        await rig.initialize()
        rig.router.receive(request(50, "block", #"{"x":1}"#))
        rig.router.receive(request(51, "block", #"{"x":1}"#))
        #expect(await eventually { rig.router.load.waiting == 1 })
        rig.router.receive(cancelLine(51))
        #expect(await eventually { rig.sink.error(51)?.data?.kind == .cancelled })
        #expect(rig.router.load.waiting == 0)
    }

    @Test func cancelOfARunningRequestSetsItsFlag() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(60, "block", #"{"x":5}"#))
        #expect(await eventually { rig.flag(60) != nil })
        rig.router.receive(cancelLine(60))
        #expect(await eventually { rig.flag(60)?.isSet == true })
        // the handler returned normally once it saw the flag, as action.run does
        #expect(await eventually { rig.sink.response(60) == .result(id: 60, result: .object(["x": .number(-1)])) })
    }

    @Test func aCancelledRequestThatDoesNotKeepItsResultAnswersCancelled() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(61, "finish", #"{"x":5}"#))
        #expect(await eventually { rig.flag(61) != nil })
        rig.router.receive(cancelLine(61))
        #expect(await eventually { rig.sink.error(61)?.data?.kind == .cancelled })
    }

    @Test func workAfterTheAnswerRunsOnceTheAnswerIsQueued() async {
        let rig = Rig()
        await rig.initialize()
        rig.gate.open()
        rig.router.receive(request(62, "finish", #"{"x":5}"#))
        #expect(await eventually { rig.sink.response(62) != nil })
        #expect(await eventually { rig.started.count == 1 })
    }

    @Test func unknownNotificationsAndHostResponsesAreIgnored() async {
        let rig = Rig()
        await rig.initialize()
        let before = rig.sink.lines.count
        rig.router.receive(line(#"{"jsonrpc":"2.0","method":"what/ever","params":{}}"#))
        rig.router.receive(line(#"{"jsonrpc":"2.0","id":3,"result":{}}"#))
        rig.router.receive(line(#"{"jsonrpc":"2.0","id":4,"error":{"code":1,"message":"x"}}"#))
        try? await Task.sleep(for: .milliseconds(30))
        #expect(rig.sink.lines.count == before)
    }

    @Test func aKnownNotificationReachesItsHandler() async {
        let rig = Rig()
        let got = Counter()
        rig.router.onNotification("capture.stream.ack") { params in if params["seq"]?.intValue == 4 { got.bump() } }
        rig.router.receive(line(#"{"jsonrpc":"2.0","method":"capture.stream.ack","params":{"stream":"s","seq":4}}"#))
        #expect(got.count == 1)
    }

    @Test func afterShutdownEveryNewRequestIsCancelled() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(70, "shutdown"))
        #expect(await eventually { rig.sink.response(70) != nil })
        rig.router.receive(request(71, "echo", #"{"x":1}"#))
        #expect(await eventually { rig.sink.error(71)?.data?.kind == .cancelled })
        #expect(rig.started.count == 0)
    }

    @Test func aThrowThatIsNotAComputerErrorAnswersInternalErrorAndLogs() async {
        let rig = Rig()
        await rig.initialize()
        rig.router.receive(request(80, "boom"))
        #expect(await eventually { rig.sink.error(80) != nil })
        #expect(rig.sink.error(80)?.code == -32603)
        #expect(await eventually { rig.sink.notifications("log").contains { $0["level"] == .string("error") } })
    }

    @Test func aMappedErrorAnswersAsAComputerError() async {
        struct Wrapped: Error { let error: ComputerError }
        let sink = RecordingSink()
        let outbox = Outbox(sink: sink, onClosed: { _ in })
        let router = Router(outbox: outbox, mapError: { ($0 as? Wrapped)?.error ?? ($0 as? ComputerError) })
        outbox.start()
        router.markInitialized()
        router.on("w") { (_: Empty, _) -> Empty in throw Wrapped(error: ComputerError(kind: .timeout, message: "slow")) }
        router.receive(request(90, "w"))
        #expect(await eventually { sink.error(90)?.data?.kind == .timeout })
    }

    @Test func cancelAllSetsEveryFlagAndAnswersTheWaiting() async {
        let rig = Rig(maxInFlight: 1)
        await rig.initialize()
        rig.router.receive(request(100, "block", #"{"x":1}"#))
        rig.router.receive(request(101, "block", #"{"x":1}"#))
        #expect(await eventually { rig.flag(100) != nil && rig.router.load.waiting == 1 })
        rig.router.cancelAll()
        #expect(await eventually { rig.sink.error(101)?.data?.kind == .cancelled })
        #expect(rig.flag(100)?.isSet == true)
    }
}
