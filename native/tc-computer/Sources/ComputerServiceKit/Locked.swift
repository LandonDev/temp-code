import Foundation

extension NSLock {
    /// The body under the lock. Named apart from Foundation's `withLock`, which older corelibs lack.
    @inline(__always)
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

/// A request's `$/cancel`: the router sets it beside `Task.cancel()`, and the modules read it between
/// their own steps (Input through `InputTarget.cancelled`, the wait runner every sample).
public final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    public init() {}

    public var isSet: Bool { lock.locked { value } }

    public func set() { lock.locked { value = true } }
}
