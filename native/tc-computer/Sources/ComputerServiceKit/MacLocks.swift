import ComputerProtocol
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A held `flock`. The kernel drops it when the process dies, so a crash never leaves it taken.
public final class FileLockLease: @unchecked Sendable {
    public let path: String
    public let acquiredAt: ContinuousClock.Instant
    private let lock = NSLock()
    private var fd: Int32

    init(path: String, fd: Int32) {
        self.path = path
        self.fd = fd
        self.acquiredAt = .now
    }

    /// Idempotent; also on deinit.
    public func release() {
        lock.locked {
            guard fd >= 0 else { return }
            close(fd)
            fd = -1
        }
    }

    public var isHeld: Bool { lock.locked { fd >= 0 } }

    deinit { release() }
}

public enum FileLock {
    /// `flock(LOCK_EX | LOCK_NB)` on `path` through a fresh descriptor, tried every 10 ms; nil when
    /// `timeout` passes. Each acquire opens its own descriptor, and a flock belongs to the open file
    /// description, so two holders in one process exclude each other as two processes do.
    public static func acquire(_ path: String, timeout: Duration) -> FileLockLease? {
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        let deadline = ContinuousClock.now + timeout
        while true {
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { return FileLockLease(path: path, fd: fd) }
            guard errno == EWOULDBLOCK || errno == EINTR, ContinuousClock.now < deadline else {
                close(fd)
                return nil
            }
            usleep(10_000)
        }
    }
}

/// The two things there is one of per Mac, the pasteboard and the real pointer and keyboard.
public enum MacLockName: String, Sendable, CaseIterable {
    case clipboard
    case session

    var file: String {
        switch self {
        case .clipboard: ComputerDefaults.Locks.clipboard
        case .session: ComputerDefaults.Locks.session
        }
    }
}

public final class MacLockLease: @unchecked Sendable {
    public let name: MacLockName
    private let lease: FileLockLease

    init(name: MacLockName, lease: FileLockLease) {
        self.name = name
        self.lease = lease
    }

    public var acquiredAt: ContinuousClock.Instant { lease.acquiredAt }

    /// Idempotent; also on deinit.
    public func release() { lease.release() }
}

/// The Mac-wide locks every service on the Mac shares (docs/computer-protocol.md §1, shell A7).
public final class MacLocks: Sendable {
    public let directory: URL

    /// `<confstr(_CS_DARWIN_USER_TEMP_DIR)>/tc-computer` on macOS, never `$TMPDIR`, so a process whose
    /// TMPDIR was overridden cannot split a lock; `NSTemporaryDirectory()` elsewhere, for tests.
    public static func defaultDirectory() -> URL {
        URL(fileURLWithPath: userTempDirectory(), isDirectory: true).appendingPathComponent(ComputerDefaults.Locks.dir, isDirectory: true)
    }

    public init(directory: URL = MacLocks.defaultDirectory()) {
        self.directory = directory
    }

    /// The lock, or nil when `timeout` passes with it taken. The directory is made `0700`.
    public func acquire(_ name: MacLockName, timeout: Duration) -> MacLockLease? {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let path = directory.appendingPathComponent(name.file).path
        return FileLock.acquire(path, timeout: timeout).map { MacLockLease(name: name, lease: $0) }
    }

    static func userTempDirectory() -> String {
        #if canImport(Darwin)
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
        if size > 0 {
            var buffer = [CChar](repeating: 0, count: size)
            if confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, size) > 0 { return String(cString: buffer) }
        }
        #endif
        return NSTemporaryDirectory()
    }
}
