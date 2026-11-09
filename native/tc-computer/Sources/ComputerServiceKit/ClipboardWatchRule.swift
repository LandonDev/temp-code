import ComputerProtocol
import Foundation

/// When the person (or anything but this service) last copied, from the pasteboard's change count
/// alone, read every 250 ms (`clipboard.state`, shell A5). It never reads the contents, so it cannot
/// raise macOS's paste privacy prompt. Times are epoch milliseconds.
public struct ClipboardWatchRule: Sendable, Equatable {
    public private(set) var changeCount: Int
    public private(set) var foreignChangeAt: Double?
    public let watchingSince: Double

    public init(changeCount: Int, now: Double) {
        self.changeCount = changeCount
        self.watchingSince = now
    }

    /// One poll. A change seen while this service held its clipboard lock at any time since the last
    /// poll is its own paste and its restore, and does not count; any other change does, another
    /// service's paste included, since erring towards "someone copied" is the safe side.
    public mutating func observe(changeCount count: Int, ownHoldSinceLastPoll: Bool, at now: Double) {
        guard count != changeCount else { return }
        changeCount = count
        if !ownHoldSinceLastPoll { foreignChangeAt = now }
    }

    /// A paste whose outcome was `kept-person-copy`: the person copied during it.
    public mutating func personCopiedDuringPaste(at now: Double) {
        foreignChangeAt = now
    }

    /// Quiet for `ms`: no foreign change since `now − ms`, and the watch has run that long (a copy made
    /// before it began is invisible to it).
    public func quiet(for ms: Double, now: Double) -> Bool {
        now - max(foreignChangeAt ?? 0, watchingSince) >= ms
    }

    public var state: ClipboardActivity {
        ClipboardActivity(changeCount: changeCount, foreignChangeAt: foreignChangeAt, watchingSince: watchingSince)
    }
}
