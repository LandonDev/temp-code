import ComputerProtocol
@testable import ComputerServiceKit
import Foundation

/// Records every line the outbox writes; can hold writes until opened, or fail them.
final class RecordingSink: LineSink, @unchecked Sendable {
    private let lock = NSCondition()
    private var written: [Data] = []
    private var held: Bool
    private var failing = false

    init(held: Bool = false) {
        self.held = held
    }

    func write(_ line: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        while held && !failing { lock.wait() }
        if failing { throw CocoaError(.fileWriteUnknown) }
        written.append(line)
    }

    func open() {
        lock.lock()
        held = false
        lock.broadcast()
        lock.unlock()
    }

    func fail() {
        lock.lock()
        failing = true
        lock.broadcast()
        lock.unlock()
    }

    var lines: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return written
    }

    var frames: [RPCFrame] { lines.compactMap { try? decodeLine($0) } }

    func response(_ id: Int) -> RPCFrame? {
        frames.first { frame in
            switch frame {
            case .result(let rid, _): rid == id
            case .error(let rid, _): rid == id
            default: false
            }
        }
    }

    func error(_ id: Int?) -> RPCErrorObject? {
        for frame in frames { if case .error(let rid, let error) = frame, rid == id { return error } }
        return nil
    }

    func notifications(_ method: String) -> [JSONValue] {
        frames.compactMap { if case .notification(method, let params) = $0 { params } else { nil } }
    }
}

/// A count that tests read and handlers bump.
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func bump() { lock.locked { value += 1 } }
    var count: Int { lock.locked { value } }
}

/// Handlers wait on it until the test opens it.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false

    func open() { lock.locked { opened = true } }

    func wait(_ flag: CancelFlag? = nil) async {
        while !lock.locked({ opened }) && !(flag?.isSet ?? false) {
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
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

func line(_ text: String) -> Data { Data(text.utf8) }

func request(_ id: Int, _ method: String, _ params: String = "{}") -> Data {
    line(#"{"jsonrpc":"2.0","id":\#(id),"method":"\#(method)","params":\#(params)}"#)
}

func cancelLine(_ id: Int) -> Data {
    line(#"{"jsonrpc":"2.0","method":"$/cancel","params":{"id":\#(id)}}"#)
}

func tempDirectory() -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tc-kit-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
