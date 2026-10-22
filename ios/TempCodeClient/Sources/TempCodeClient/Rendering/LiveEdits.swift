import Foundation
import TempCodeContract

/// One file a running thread is changing on disk, from the `live-edits`
/// push: the desktop's LiveEditState (lib/tcserver/store.ts). The host
/// watches the thread's cwd and sends the file's unified diff against its
/// baseline as it grows; `settled` is the per-file quiet timer firing.
public struct LiveEditState: Sendable, Hashable {
    /// Relative to the watched cwd.
    public var path: String
    public var kind: LiveEdit.Edit.Kind
    public var adds: Int
    public var dels: Int
    /// The unified diff so far; nil when the host degraded it (binary, caps, a burst).
    public var diff: String?
    public var bytes: Int?
    /// Part of a mass burst (a checkout, a formatter): rolled up, not shown line by line.
    public var burst: Bool
    public var settled: Bool
    /// The first push's time for this file.
    public var startedTs: Int
    public var ts: Int

    public init(path: String, kind: LiveEdit.Edit.Kind, adds: Int, dels: Int, diff: String?, bytes: Int?, burst: Bool, settled: Bool, startedTs: Int, ts: Int) {
        self.path = path
        self.kind = kind
        self.adds = adds
        self.dels = dels
        self.diff = diff
        self.bytes = bytes
        self.burst = burst
        self.settled = settled
        self.startedTs = startedTs
        self.ts = ts
    }
}

public enum LiveEdits {
    /// Files kept per thread; the oldest leaves past this (the desktop's MAX_LIVE_EDITS).
    public static let max = 500

    /// The desktop's match (EditRow.tsx): the paths are equal, or one ends
    /// with "/" and the other (the push's path is relative to the cwd; the
    /// tool's may be absolute).
    public static func matches(_ editPath: String, _ toolPath: String) -> Bool {
        editPath == toolPath || toolPath.hasSuffix("/" + editPath) || editPath.hasSuffix("/" + toolPath)
    }

    /// The store's merge rule: a push without adds, dels or a diff keeps the
    /// previous ones; `startedTs` is the first push's time.
    public static func merged(previous: LiveEditState?, push edit: LiveEdit.Edit, path: String) -> LiveEditState {
        LiveEditState(
            path: path,
            kind: edit.kind,
            adds: edit.adds ?? previous?.adds ?? 0,
            dels: edit.dels ?? previous?.dels ?? 0,
            diff: edit.diff ?? previous?.diff,
            bytes: edit.bytes,
            burst: edit.burst ?? false,
            settled: edit.settled ?? false,
            startedTs: previous?.startedTs ?? edit.ts,
            ts: edit.ts
        )
    }
}

extension ThreadFold {
    /// A live edit for this thread: merged into the state kept by path and
    /// stamped on the running edit tool whose path matches. True when an
    /// item changed.
    @discardableResult
    public mutating func applyLiveEdit(_ edit: LiveEdit.Edit) -> Bool {
        stamp(LiveEdits.merged(previous: liveEdits[edit.path], push: edit, path: edit.path))
    }
}
