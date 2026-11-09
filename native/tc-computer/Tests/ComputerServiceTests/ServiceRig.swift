import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation

/// Records the service's stdout.
final class Lines: LineSink, @unchecked Sendable {
    private let lock = NSLock()
    private var written: [Data] = []

    func write(_ line: Data) throws { lock.withLock { written.append(line) } }

    var frames: [RPCFrame] { lock.withLock { written }.compactMap { try? decodeLine($0) } }

    func result(_ id: Int) -> JSONValue? {
        for frame in frames { if case .result(id, let value) = frame { return value } }
        return nil
    }

    func error(_ id: Int) -> RPCErrorObject? {
        for frame in frames { if case .error(id, let error) = frame { return error } }
        return nil
    }

    func notifications(_ method: String) -> [JSONValue] {
        frames.compactMap { if case .notification(method, let params) = $0 { params } else { nil } }
    }
}

final class Box<T>: @unchecked Sendable {
    var value: T?
}

/// The service in process over fake modules, a stdin pipe and a recorded stdout.
final class ServiceRig: @unchecked Sendable {
    let log = CallLog()
    let lines = Lines()
    let workspace = FakeWorkspace()
    let permissions: FakePermissions
    let system = FakeSystem()
    let appEvents = FakeAppEvents()
    let windowEvents = FakeWindowEvents()
    let windows = FakeWindows()
    let readers: FakeReaders
    let capture: FakeCapture
    let exits = ExitRecorder()
    let dataDir: URL
    let stdin = Pipe()
    let service: ComputerService
    private let inputBox = Box<FakeInput>()
    private var nextID = 100

    init(accessibility: Bool = true, screenRecording: Bool = true, pixelLive: Bool = false, timing: ((inout ServiceTiming) -> Void)? = nil, dataDir: URL? = nil) {
        permissions = FakePermissions(accessibility: accessibility, screenRecording: screenRecording)
        readers = FakeReaders(log: log)
        capture = FakeCapture(log: log, pixelLive: pixelLive)
        self.dataDir = dataDir ?? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tc-svc-\(UUID().uuidString)")
        windows.set(500, [window(7, "Doc"), window(8, "Other")])
        windows.set(600, [window(9, "Notes")])
        var t = ServiceTiming()
        t.appSlotWait = .milliseconds(200)
        t.launchWindow = .milliseconds(500)
        t.serviceLockWait = .milliseconds(150)
        t.waitTick = .milliseconds(5)
        timing?(&t)
        let exits = self.exits
        let env = ServiceEnvironment(
            workspace: workspace, permissions: permissions, system: system, appEvents: appEvents, windowEvents: windowEvents,
            lockDirectory: self.dataDir.appendingPathComponent("locks"), exit: { exits.record($0) }, parentGone: { false }, timing: t
        )
        let log = self.log, readers = self.readers, capture = self.capture, windows = self.windows, inputBox = self.inputBox
        let modules = Modules(
            readers: { readers },
            input: { wiring in
                let input = FakeInput(wiring: wiring, log: log)
                inputBox.value = input
                return input
            },
            capture: { _ in capture },
            windows: windows
        )
        service = ComputerService(modules: modules, environment: env, build: BuildInfo(version: "1.0.9", build: "abc123"), trace: Trace(enabled: false, write: { _ in }), sink: lines)
        service.start(input: stdin.fileHandleForReading.fileDescriptor)
    }

    var input: FakeInput { inputBox.value! }

    func reader(_ session: String = "s1", pid: pid_t = 500) -> FakeReader { readers.fake(session, pid) }

    /// Sends one request and waits for its answer.
    @discardableResult
    func call(_ method: String, _ params: String = "{}", timeout: Duration = .seconds(5)) async -> (id: Int, result: JSONValue?, error: RPCErrorObject?) {
        let id = send(method, params)
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let result = lines.result(id) { return (id, result, nil) }
            if let error = lines.error(id) { return (id, nil, error) }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return (id, nil, nil)
    }

    /// Sends one request without waiting.
    @discardableResult
    func send(_ method: String, _ params: String = "{}") -> Int {
        nextID += 1
        let id = nextID
        write(#"{"jsonrpc":"2.0","id":\#(id),"method":"\#(method)","params":\#(params)}"#)
        return id
    }

    func write(_ line: String) {
        stdin.fileHandleForWriting.write(Data((line + "\n").utf8))
    }

    func cancel(_ id: Int) { write(#"{"jsonrpc":"2.0","method":"$/cancel","params":{"id":\#(id)}}"#) }

    func answer(_ id: Int, timeout: Duration = .seconds(5)) async -> (result: JSONValue?, error: RPCErrorObject?) {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let result = lines.result(id) { return (result, nil) }
            if let error = lines.error(id) { return (nil, error) }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return (nil, nil)
    }

    /// `initialize` then `session.open`.
    func ready(session: String = "s1") async {
        await call("initialize", #"{"protocol":1,"client":{"name":"test","version":"0"},"dataDir":"\#(dataDir.path)"}"#)
        await call("session.open", #"{"session":"\#(session)"}"#)
    }

    func closeStdin() { try? stdin.fileHandleForWriting.close() }
}

/// True once `condition` holds, polled every 2 ms up to `timeout`.
func eventually(_ timeout: Duration = .seconds(3), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(2))
    }
    return condition()
}

let docTarget = #""session":"s1","app":{"app":"Doc"}"#
