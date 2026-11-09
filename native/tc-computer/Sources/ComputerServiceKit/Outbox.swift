import ComputerProtocol
import Foundation

/// Where finished lines go: stdout in the binary, a recorder in the tests.
public protocol LineSink: Sendable {
    func write(_ line: Data) throws
}

/// Everything the service sends, through one writer thread. Producers never block: only the writer
/// waits on the pipe. Two lanes: control (responses and every notification but `capture/frame`) is
/// FIFO and always drained first; frames go only when control is empty. The capture module already
/// gates a stream to 2 unacknowledged frames, so the frame lane needs no rule of its own.
public final class Outbox: @unchecked Sendable {
    public enum CloseReason: Sendable, Equatable {
        /// a write failed: the host is gone (exit 0)
        case hostGone
        /// the host left `budgetBytes` unread (exit 70)
        case overBudget
    }

    /// How a notification queues.
    public enum Kind: Sendable, Equatable {
        case plain
        /// an unsent line with the same key is replaced by the newer one (`window/changed`)
        case coalesce(String)
        /// at most `maxLogs` wait; past that the oldest go and one warn says how many
        case log
    }

    private struct Entry {
        var line: Data
        var key: String?
        var isLog: Bool
        var onWritten: (@Sendable () -> Void)?
    }

    public let budgetBytes: Int
    public let maxLogs: Int
    private let sink: LineSink
    private let trace: Trace?
    private let onClosed: @Sendable (CloseReason) -> Void

    private let condition = NSCondition()
    private var control: [Entry] = []
    private var frames: [Entry] = []
    private var unsentBytes = 0
    private var pendingLogs = 0
    private var droppedLogs = 0
    private var closed = false
    private var writing = false
    private var started = false

    public init(sink: LineSink, trace: Trace? = nil, budgetBytes: Int = ComputerDefaults.Service.outboxBudgetBytes, maxLogs: Int = 100,
                onClosed: @escaping @Sendable (CloseReason) -> Void) {
        self.sink = sink
        self.trace = trace
        self.budgetBytes = budgetBytes
        self.maxLogs = maxLogs
        self.onClosed = onClosed
    }

    /// Starts the writer thread; until then lines wait.
    public func start() {
        condition.lock()
        defer { condition.unlock() }
        guard !started else { return }
        started = true
        let thread = Thread { [self] in run() }
        thread.name = "tc-computer.outbox"
        thread.start()
    }

    /// A response; `onWritten` runs once the line is on the pipe (the router frees its slot then).
    public func respond(_ line: Data, onWritten: (@Sendable () -> Void)? = nil) {
        enqueue(Entry(line: line, key: nil, isLog: false, onWritten: onWritten), frame: false)
    }

    public func notify(_ line: Data, kind: Kind = .plain) {
        switch kind {
        case .plain: enqueue(Entry(line: line, key: nil, isLog: false), frame: false)
        case .coalesce(let key): enqueue(Entry(line: line, key: key, isLog: false), frame: false)
        case .log: enqueue(Entry(line: line, key: nil, isLog: true), frame: false)
        }
    }

    /// A `capture/frame`.
    public func frame(_ line: Data) {
        enqueue(Entry(line: line, key: nil, isLog: false), frame: true)
    }

    public var isClosed: Bool {
        condition.lock()
        defer { condition.unlock() }
        return closed
    }

    /// Unsent bytes, for the tests.
    public var pendingBytes: Int {
        condition.lock()
        defer { condition.unlock() }
        return unsentBytes
    }

    /// Returns once everything queued is written, the outbox closed, or `deadline` passed.
    public func drain(until deadline: ContinuousClock.Instant) async {
        while ContinuousClock.now < deadline {
            if isIdle { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// Nothing queued and nothing on its way, or closed.
    public var isIdle: Bool {
        condition.lock()
        defer { condition.unlock() }
        return closed || (control.isEmpty && frames.isEmpty && !writing)
    }

    private func enqueue(_ entry: Entry, frame: Bool) {
        condition.lock()
        guard !closed else { condition.unlock(); return }
        if let key = entry.key, let at = control.firstIndex(where: { $0.key == key }) {
            unsentBytes += entry.line.count - control[at].line.count
            control[at].line = entry.line
        } else if frame {
            frames.append(entry)
            unsentBytes += entry.line.count
        } else {
            if entry.isLog {
                if pendingLogs >= maxLogs, let oldest = control.firstIndex(where: \.isLog) {
                    unsentBytes -= control.remove(at: oldest).line.count
                    pendingLogs -= 1
                    droppedLogs += 1
                }
                pendingLogs += 1
            }
            control.append(entry)
            unsentBytes += entry.line.count
        }
        let over = unsentBytes > budgetBytes
        if over { closed = true }
        condition.signal()
        condition.unlock()
        if over { onClosed(.overBudget) }
    }

    private func run() {
        while true {
            condition.lock()
            while !closed && control.isEmpty && frames.isEmpty { condition.wait() }
            if closed { condition.unlock(); return }
            var entry: Entry
            if droppedLogs > 0, control.first?.isLog == true {
                entry = Entry(line: Outbox.droppedLine(droppedLogs), key: nil, isLog: false)
                droppedLogs = 0
            } else if !control.isEmpty {
                entry = control.removeFirst()
                if entry.isLog { pendingLogs -= 1 }
                unsentBytes -= entry.line.count
            } else {
                entry = frames.removeFirst()
                unsentBytes -= entry.line.count
            }
            writing = true
            condition.unlock()

            trace?.frameOut(entry.line)
            do {
                try sink.write(entry.line)
            } catch {
                condition.lock()
                let first = !closed
                closed = true
                writing = false
                condition.unlock()
                if first { onClosed(.hostGone) }
                return
            }
            condition.lock()
            writing = false
            condition.unlock()
            entry.onWritten?()
        }
    }

    /// The one warn that stands for the `log` lines the cap dropped.
    static func droppedLine(_ count: Int) -> Data {
        notificationLine(method: "log", params: LogNotification.Params(level: .warn, message: "\(count) log lines were dropped: the host is not reading"))
    }
}

/// One notification as one line.
public func notificationLine(method: String, params: some Encodable) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    let body = (try? encoder.encode(params)) ?? Data("{}".utf8)
    var line = Data(#"{"jsonrpc":"2.0","method":"#.utf8)
    line.append((try? encoder.encode(method)) ?? Data(#""log""#.utf8))
    line.append(Data(#","params":"#.utf8))
    line.append(body)
    line.append(Data("}\n".utf8))
    return line
}
