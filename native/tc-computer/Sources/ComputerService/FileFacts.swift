import ComputerProtocol
import Foundation

/// `DiskFacts`: what the commit check reads of the disk (docs/computer-protocol.md §26.8): one file's stat, or a
/// folder's listing bounded by `ComputerDefaults.Front.commitListMax` entries and `commitListMs`. A read the
/// system refuses (a TCC folder TempCode has no grant for, a volume gone) is unknown, never a guess.
enum DiskFacts {
    /// One file or folder as `lstat` gave it.
    struct Stat: Hashable, Sendable {
        let size: Int64
        /// epoch seconds, to the nanosecond
        let mtime: Double
        let inode: UInt64
        let isDirectory: Bool
    }

    /// A stat's answer: there with its facts, not there, or not readable.
    enum Fact: Hashable, Sendable {
        case present(Stat)
        case missing
        case unknown
    }

    /// One entry of a listing.
    struct Entry: Hashable, Sendable {
        let inode: UInt64
        let mtime: Double
        let isDirectory: Bool
    }

    /// A folder's entries by name, or why there are none: the folder could not be read, held more than
    /// the cap, or took longer than the budget.
    enum Listing: Hashable, Sendable {
        case listed([String: Entry])
        case unknown(Unread)
    }

    enum Unread: String, Hashable, Sendable {
        case unreadable
        case tooMany
        case tooSlow
    }

    static func stat(_ path: String) -> Fact {
        var st = Darwin.stat()
        guard lstat(path, &st) == 0 else {
            return errno == ENOENT || errno == ENOTDIR ? .missing : .unknown
        }
        return .present(Stat(size: Int64(st.st_size), mtime: seconds(st.st_mtimespec), inode: UInt64(st.st_ino), isDirectory: (st.st_mode & S_IFMT) == S_IFDIR))
    }

    /// The folder's entries, skipping `.` and `..` and every name that starts with a dot (Finder's
    /// .DS_Store and an app's temporary save files move on their own and are nobody's change). Past `max`
    /// entries, or once `budgetMs` has run out (`now` is a monotonic clock in nanoseconds), the listing is
    /// unknown.
    static func list(
        _ folder: String,
        max: Int = ComputerDefaults.Front.commitListMax,
        budgetMs: Int = ComputerDefaults.Front.commitListMs,
        now: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) -> Listing {
        let start = now()
        let deadline = start &+ UInt64(Swift.max(0, budgetMs)) * 1_000_000
        guard let dir = opendir(folder) else { return .unknown(.unreadable) }
        defer { closedir(dir) }
        let fd = dirfd(dir)
        var entries: [String: Entry] = [:]
        while let raw = readdir(dir) {
            if now() > deadline { return .unknown(.tooSlow) }
            let name = withUnsafeBytes(of: raw.pointee.d_name) { bytes in
                String(decoding: bytes.prefix(Int(raw.pointee.d_namlen)), as: UTF8.self)
            }
            if name.hasPrefix(".") { continue }
            if entries.count >= max { return .unknown(.tooMany) }
            var st = Darwin.stat()
            // an entry gone between the read and the stat is not there
            guard fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 else {
                if errno == ENOENT { continue }
                return .unknown(.unreadable)
            }
            entries[name] = Entry(inode: UInt64(st.st_ino), mtime: seconds(st.st_mtimespec), isDirectory: (st.st_mode & S_IFMT) == S_IFDIR)
        }
        return .listed(entries)
    }

    /// The path a window's `AXDocument` names, or nil when it is no `file://` URL.
    static func path(fromDocument document: String) -> String? {
        guard let url = URL(string: document), url.isFileURL else { return nil }
        let path = url.path
        return path.isEmpty ? nil : path
    }

    /// A path as the model reads it: `~` for the home folder and `~/…` under it, else as it is.
    static func display(_ path: String, home: String = NSHomeDirectory()) -> String {
        let home = home.hasSuffix("/") && home.count > 1 ? String(home.dropLast()) : home
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    /// A model's path (`save_as`'s) made absolute: `~` and `~/…` from the home folder; nil for a relative
    /// path, which the wire refuses before it gets here.
    static func absolute(_ path: String, home: String = NSHomeDirectory()) -> String? {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return (home as NSString).appendingPathComponent(String(path.dropFirst(2))) }
        return path.hasPrefix("/") ? path : nil
    }

    private static func seconds(_ t: timespec) -> Double { Double(t.tv_sec) + Double(t.tv_nsec) / 1_000_000_000 }
}
