import ComputerProtocol

// The commit check's two reads of the disk and what changed between them
// (docs/computer-protocol.md §26.8). The live side stats the file or lists the folder; this compares.

/// One file as stat(2) answers it.
public struct FileStamp: Equatable, Sendable {
    public var size: Int64
    /// seconds since 1970
    public var mtime: Double
    public var inode: UInt64

    public init(size: Int64, mtime: Double, inode: UInt64) {
        self.size = size
        self.mtime = mtime
        self.inode = inode
    }
}

/// One entry of a folder's listing.
public struct FolderEntry: Equatable, Sendable {
    public var inode: UInt64
    public var mtime: Double

    public init(inode: UInt64, mtime: Double) {
        self.inode = inode
        self.mtime = mtime
    }
}

/// What the check read of the window's document: the file (nil when nothing is at its path) or
/// the folder's listing by name; `unknown` when it could not read it in its bounds.
public enum DiskSnapshot: Equatable, Sendable {
    case file(path: String, FileStamp?)
    case folder(path: String, [String: FolderEntry])
    case unknown

    /// The folder listing's bounds: at most `commitListMax` entries read within `commitListMs`;
    /// past either the check is `unknown`, never a guess.
    public static func listingFits(entries: Int, elapsedMs: Int) -> Bool {
        entries <= ComputerDefaults.Front.commitListMax && elapsedMs <= ComputerDefaults.Front.commitListMs
    }
}

public enum DiskDiff {
    /// at most this many paths in each list of `step.disk`
    public static let listMax = 32

    /// What changed between the two reads, nil when nothing did. Renames are matched by inode;
    /// `edited` only when the flag moved; `document` only when AXDocument moved; `unexpected`
    /// when the disk changed and the step was not expected to commit (an autosave). Paths are
    /// `~`-relative under `home`.
    public static func diff(before: DiskSnapshot, after: DiskSnapshot, edited: (before: Bool, after: Bool)? = nil,
                            document: (from: String?, to: String?)? = nil, expected: Bool, home: String) -> DiskChange? {
        func tilde(_ p: String) -> String { tildeRelative(p, home: home) }
        var saved: String?
        var renamed: [DiskChange.Renamed] = []
        var added: [String] = []
        var removed: [String] = []
        var unknown = false

        switch (before, after) {
        case (.file(let p0, let a), .file(let p1, let b)) where p0 == p1:
            switch (a, b) {
            case (nil, .some): saved = tilde(p1)
            case (.some, nil): removed = [tilde(p0)]
            case (.some(let x), .some(let y)) where x != y: saved = tilde(p1)
            default: break
            }
        case (.folder(let p0, let a), .folder(let p1, let b)) where p0 == p1:
            let gone = a.filter { b[$0.key] == nil }
            let new = b.filter { a[$0.key] == nil }
            var byInode: [UInt64: String] = [:]
            for (name, e) in new { byInode[e.inode] = name }
            var renamedTo: Set<String> = []
            for (name, e) in gone.sorted(by: { $0.key < $1.key }) {
                if let to = byInode[e.inode] {
                    renamed.append(DiskChange.Renamed(from: tilde(join(p0, name)), to: tilde(join(p1, to))))
                    renamedTo.insert(to)
                } else {
                    removed.append(tilde(join(p0, name)))
                }
            }
            added = new.keys.filter { !renamedTo.contains($0) }.sorted().map { tilde(join(p1, $0)) }
            // a file written in place: same name, its mtime or inode moved
            saved = a.keys.sorted().first { name in b[name].map { $0 != a[name]! } ?? false }.map { tilde(join(p1, $0)) }
        case (.unknown, _), (_, .unknown):
            unknown = true
        default:
            // the document moved between a file and a folder, or to another path: AXDocument says it
            unknown = document == nil
        }

        let flag = edited.flatMap { $0.before != $0.after ? DiskChange.Edited(before: $0.before, after: $0.after) : nil }
        let doc = document.flatMap { $0.from != $0.to ? DiskChange.Document(from: $0.from.map(tilde), to: $0.to.map(tilde)) : nil }
        let onDisk = saved != nil || !renamed.isEmpty || !added.isEmpty || !removed.isEmpty
        guard onDisk || flag != nil || doc != nil || unknown else { return nil }
        return DiskChange(
            saved: saved,
            renamed: renamed.isEmpty ? nil : Array(renamed.prefix(listMax)),
            added: added.isEmpty ? nil : Array(added.prefix(listMax)),
            removed: removed.isEmpty ? nil : Array(removed.prefix(listMax)),
            edited: flag,
            document: doc,
            unexpected: onDisk && !expected ? true : nil,
            unknown: unknown ? true : nil
        )
    }

    private static func join(_ folder: String, _ name: String) -> String {
        folder.hasSuffix("/") ? folder + name : folder + "/" + name
    }
}

/// A path under `home` as `~/…`, else as it is; cut to the wire's path cap.
public func tildeRelative(_ path: String, home: String) -> String {
    let home = home.count > 1 && home.hasSuffix("/") ? String(home.dropLast()) : home
    let p: String
    if path == home { p = "~" } else if path.hasPrefix(home + "/") { p = "~" + path.dropFirst(home.count) } else { p = path }
    guard p.utf16.count > ComputerDefaults.Front.pathMaxUnits else { return p }
    var out = "", units = 0
    for c in p {
        units += String(c).utf16.count
        if units > ComputerDefaults.Front.pathMaxUnits { break }
        out.append(c)
    }
    return out
}
