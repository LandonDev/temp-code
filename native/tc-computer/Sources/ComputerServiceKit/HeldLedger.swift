import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// One record of the crash ledger. ComputerCore's `HeldRecord` conforms in the service; the kit
/// cannot see it (ComputerCore is a macOS target), so the rules work over this.
public protocol HeldEntry: Codable, Sendable, Equatable {
    /// the service process that wrote it
    var writer: Int32 { get }
    /// the app the input went to
    var pid: Int32 { get }
    /// `button` or `key`: one of each per app at most
    var kindKey: String { get }
}

/// `<dataDir>/held.json`: every button or key held past one event pair, written before the down is
/// posted and removed after its up, so a service that crashed with input down can have it let go by
/// the next one (docs/computer-protocol.md §5.1, shell §8.3).
public final class HeldLedger<Entry: HeldEntry>: @unchecked Sendable {
    public let file: URL
    private let lock = NSLock()
    private var entries: [Entry]

    /// Reads what the file holds; a missing or unreadable file is an empty ledger.
    public init(file: URL) {
        self.file = file
        self.entries = (try? JSONDecoder().decode([Entry].self, from: Data(contentsOf: file))) ?? []
    }

    public var records: [Entry] { lock.locked { entries } }

    /// Before a lasting down is posted: replaces any record of the same app and kind, then writes.
    public func pressing(_ entry: Entry) throws {
        try lock.locked {
            entries.removeAll { $0.pid == entry.pid && $0.kindKey == entry.kindKey }
            entries.append(entry)
            try save()
        }
    }

    /// After its up.
    public func released(pid: Int32, kindKey: String) throws {
        try lock.locked {
            let before = entries.count
            entries.removeAll { $0.pid == pid && $0.kindKey == kindKey }
            if entries.count != before { try save() }
        }
    }

    /// At `initialize`: the records whose writer is dead, taken out of the ledger for the caller to release.
    public func takeStale(isAlive: (Int32) -> Bool = HeldLedger.processAlive) throws -> [Entry] {
        try lock.locked {
            let stale = entries.filter { !isAlive($0.writer) }
            guard !stale.isEmpty else { return [] }
            entries.removeAll { !isAlive($0.writer) }
            try save()
            return stale
        }
    }

    /// `kill(pid, 0)`: EPERM still means alive.
    public static func processAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// Written by rename, so a crash mid-write leaves the old file whole.
    private func save() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(entries)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temp = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).\(getpid()).tmp")
        try data.write(to: temp)
        if rename(temp.path, file.path) != 0 {
            try? FileManager.default.removeItem(at: temp)
            throw CocoaError(.fileWriteUnknown)
        }
    }
}
