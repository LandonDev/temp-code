import ComputerProtocol
import Foundation

/// A shot name the shell asked for that cannot be a path; the shell answers invalid params.
public struct ShotNameError: Error, Equatable, Sendable {
    public let message: String
}

/// Where a shot goes: `<dataDir>/shots/<session>/<nnnn>-<action>`, the extension added once the
/// format is known (docs/computer-protocol.md §6, A2). Pure.
public enum ShotNaming {
    public static func stem(dataDir: String, session: String, counter: Int, action: String) throws -> String {
        guard dataDir.hasPrefix("/") else { throw ShotNameError(message: "dataDir must be an absolute path") }
        guard isSessionName(session) else {
            throw ShotNameError(message: "a session name is 1 to 64 letters, digits, _ or -")
        }
        guard counter >= 0 else { throw ShotNameError(message: "the shot counter is never negative") }
        let action = actionName(action)
        guard !action.isEmpty else { throw ShotNameError(message: "a shot names its action") }
        let root = dataDir.hasSuffix("/") ? String(dataDir.dropLast()) : dataDir
        return "\(root)/shots/\(session)/\(padded(counter))-\(action)"
    }

    public static func ext(_ format: ShotFormat) -> String {
        switch format {
        case .png: "png"
        case .jpeg, .unknown: "jpg"
        }
    }

    /// The session's shot directory, or nil for a name that is not a session's.
    static func directory(dataDir: String, session: String) -> String? {
        guard dataDir.hasPrefix("/"), isSessionName(session) else { return nil }
        let root = dataDir.hasSuffix("/") ? String(dataDir.dropLast()) : dataDir
        return "\(root)/shots/\(session)"
    }

    static func isSessionName(_ session: String) -> Bool {
        (1...64).contains(session.utf8.count) && session.utf8.allSatisfy { byte in
            isLowerAlnum(byte) || (0x41...0x5A).contains(byte) || byte == 0x5F || byte == 0x2D
        }
    }

    /// Lower-cased, every character outside `[a-z0-9_]` made `_`, cut at 32.
    static func actionName(_ action: String) -> String {
        String(action.lowercased().unicodeScalars.prefix(32).map { scalar -> Character in
            scalar.isASCII && (isLowerAlnum(UInt8(scalar.value)) || scalar == "_") ? Character(scalar) : "_"
        })
    }

    /// Four digits, more past 9999, so names sort and never collide.
    static func padded(_ counter: Int) -> String {
        let digits = String(counter)
        return String(repeating: "0", count: max(0, 4 - digits.count)) + digits
    }

    /// The number a shot file's name starts with, if it is a shot's.
    static func counter(ofFile name: String) -> Int? {
        guard let dash = name.firstIndex(of: "-") else { return nil }
        let digits = name[..<dash]
        guard !digits.isEmpty, digits.utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
        return Int(digits)
    }

    private static func isLowerAlnum(_ byte: UInt8) -> Bool {
        (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte)
    }
}

/// Each session's next shot number. The shell keeps one. A session's first `next` (after the
/// service started, or after `forget`) starts above the highest number already in its directory,
/// so a reopened session or a restarted service never reuses a name whose file still exists.
public final class ShotCounter: @unchecked Sendable {
    private let dataDir: String
    private let lock = NSLock()
    private var upcoming: [String: Int] = [:]

    public init(dataDir: String) {
        self.dataDir = dataDir
    }

    public func next(session: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let value = upcoming[session] ?? highestOnDisk(session) + 1
        upcoming[session] = value + 1
        return value
    }

    /// On `session.close`: drops the memory, never the files.
    public func forget(session: String) {
        lock.lock()
        defer { lock.unlock() }
        upcoming[session] = nil
    }

    private func highestOnDisk(_ session: String) -> Int {
        guard let directory = ShotNaming.directory(dataDir: dataDir, session: session),
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory)
        else { return 0 }
        return names.compactMap(ShotNaming.counter(ofFile:)).max() ?? 0
    }
}
