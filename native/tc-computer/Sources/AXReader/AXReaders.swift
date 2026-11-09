#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import ComputerCore
import Foundation

/// Every AX reader of one service, one per session × pid; the Service shell holds it.
/// Numbers are counted per session × app key (bundle id, else name), so an app
/// that quits and comes back under a new pid goes on where it stopped.
public final class AXReaders: @unchecked Sendable {
    private let lock = NSLock()
    private var allocators: [String: IndexAllocator] = [:]
    private var readers: [String: AppReader] = [:]
    private let manual = ManualAccessibility.live()
    private let lookup: WindowIDLookup

    public init() {
        lookup = .live
    }

    init(lookup: WindowIDLookup) {
        self.lookup = lookup
    }

    /// The reader of `pid` in `session`; `app_not_found` for a pid with no running app.
    public func reader(session: String, pid: pid_t) throws -> AppReader {
        lock.lock()
        defer { lock.unlock() }
        let key = "\(session)\u{1}\(pid)"
        if let r = readers[key] { return r }
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw ComputerFailure(ComputerError(kind: .appNotFound, message: "No app is running as pid \(pid)"))
        }
        let appKey = "\(session)\u{1}\(running.bundleIdentifier ?? running.localizedName ?? "pid \(pid)")"
        let allocator = allocators[appKey] ?? IndexAllocator()
        allocators[appKey] = allocator
        let reader = AppReader(pid: pid, allocator: allocator, manual: manual, lookup: lookup)
        readers[key] = reader
        return reader
    }

    /// Close every reader of a session and forget its numbers.
    public func close(session: String) {
        lock.lock()
        let prefix = "\(session)\u{1}"
        let gone = readers.filter { $0.key.hasPrefix(prefix) }
        for k in gone.keys { readers[k] = nil }
        for k in allocators.keys where k.hasPrefix(prefix) { allocators[k] = nil }
        lock.unlock()
        for r in gone.values { r.close() }
    }
}
#endif
