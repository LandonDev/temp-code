import Foundation
import TempCodeContract

/// The slot above the composer, the desktop's `composerSlotOf`: while a
/// turn works or waits it holds the turn's elapsed time and Stop; the held
/// states hold their word and their actions (Paused with Stop and Continue,
/// Stopped with Resume, Queued with Start now); anything else (idle, done,
/// watching, failed) leaves it empty. What the thread does is the
/// transcript's working line, so nothing here repeats it. The app has no
/// unit test target, so the rule lives here where ComposerSlotTests reaches it.
public enum ComposerSlot: Hashable, Sendable {
    case empty
    case timer
    case paused
    case stopped
    case queued

    /// A send of this device's still on its way opens the timer at once:
    /// the clock counts from the click, never from the host's echo.
    public init(status: SessionStatus?, sending: Bool) {
        switch status {
        case .paused?: self = .paused
        case .stopped?: self = .stopped
        case .queued?: self = .queued
        case .running?, .starting?, .waiting?: self = .timer
        default: self = sending ? .timer : .empty
        }
    }

    /// A turn is open on the host: the statuses the timer counts through.
    public static func turnOpen(_ status: SessionStatus?) -> Bool {
        status == .running || status == .starting || status == .waiting
    }

    /// Paused, stopped or queued: a row with its own actions.
    public var isHeld: Bool { self == .paused || self == .stopped || self == .queued }

    /// The slot has something to show.
    public var hasContent: Bool { self != .empty }

    /// At regular width the slot keeps its 28 pt whatever it holds, so
    /// nothing moves when a turn starts or ends; at compact width it takes
    /// room only while it has something (or a locked relayed host's line).
    public static func occupies(_ slot: ComposerSlot, regularWidth: Bool, relayLine: Bool = false) -> Bool {
        regularWidth || slot.hasContent || relayLine
    }

    /// What the dock draws behind itself. A slot that takes room has its
    /// own band: the backing ramps in above the slot and is solid from the
    /// slot's top down, so its words (the timer, a held row, a relayed
    /// host's "The Mac is locked") never sit over a row scrolling beneath.
    /// With no slot the composer floats on the soft edge alone.
    public static func backing(occupies: Bool) -> DockBacking {
        occupies ? .solid : .fade
    }

    /// When the open turn's clock started: the click that opened it
    /// (`sentAt`, kept after the host's stamp lands so the timer never steps
    /// back by the round trip), else the host's `busySince`.
    public static func turnStart(sentAt: Int?, busySince: Int?) -> Int? {
        sentAt ?? busySince
    }

    /// The milliseconds the slot shows: the open turn's run from its start
    /// (nil under a second, as the desktop's timer is), a paused or stopped
    /// turn's frozen span (nil when none), nothing for queued or empty.
    public static func elapsedMs(_ slot: ComposerSlot, sentAt: Int?, busySince: Int?, frozen: Int?, now: Int) -> Int? {
        switch slot {
        case .timer:
            guard let start = turnStart(sentAt: sentAt, busySince: busySince) else { return nil }
            let run = max(0, now - start)
            return run >= 1000 ? run : nil
        case .paused, .stopped:
            guard let frozen, frozen > 0 else { return nil }
            return frozen
        case .queued, .empty:
            return nil
        }
    }

    /// The paused master's batch line: how many of its batch's roots are
    /// paused with it (the desktop's `pausedText` rule). Roots only, never
    /// archived, carrying the master's id, and paused themselves.
    public static func batchPaused(of id: String, in sessions: [SessionMeta]) -> Int {
        sessions.count { $0.masterId == id && $0.parentId == nil && !$0.archived && $0.status == .paused }
    }

    /// The timer's Stop while its interrupt is out.
    public static let stopping = "Stopping…"
}

/// The dock's backing: the soft edge, or solid from the dock's top.
public enum DockBacking: String, Hashable, Sendable {
    case fade
    case solid
}
