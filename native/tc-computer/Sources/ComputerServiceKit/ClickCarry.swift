import ComputerProtocol
import Foundation

/// The agent's last click per session × window (P2, docs/computer-protocol.md §6): a preview stream that
/// starts on that window while the call that clicked still runs, or within `carryMs` of its answer, is
/// sent the click once, so a click that brought a new window forward still shows on its stream.
public struct ClickCarry: Sendable {
    public struct Click: Equatable, Sendable {
        /// session space
        public let at: [Int]
        /// the space `at` is in
        public let spaceWidth: Int
        public let spaceHeight: Int

        public init(at: [Int], spaceWidth: Int, spaceHeight: Int) {
            self.at = at
            self.spaceWidth = spaceWidth
            self.spaceHeight = spaceHeight
        }
    }

    struct Key: Hashable {
        let session: String
        let windowID: UInt32
    }

    struct Entry {
        let click: Click
        /// the request that made it
        let call: Int
        /// epoch ms of that request's answer; nil while it runs
        var answeredAt: Double?
    }

    public let carryMs: Double
    private var entries: [Key: Entry] = [:]

    public init(carryMs: Double = Double(ComputerDefaults.PreviewStream.clickCarryMs)) {
        self.carryMs = carryMs
    }

    /// A step of request `call` clicked on the window; it replaces the window's last click.
    public mutating func record(_ click: Click, session: String, windowID: UInt32, call: Int) {
        entries[Key(session: session, windowID: windowID)] = Entry(click: click, call: call, answeredAt: nil)
    }

    /// Request `call` answered: its clicks are carried `carryMs` from now.
    public mutating func answered(call: Int, at now: Double) {
        for (key, entry) in entries where entry.call == call && entry.answeredAt == nil {
            entries[key]?.answeredAt = now
        }
    }

    /// The click a stream starting now on the window is sent, if one is still carried.
    public mutating func pending(session: String, windowID: UInt32, now: Double) -> Click? {
        prune(now: now)
        return entries[Key(session: session, windowID: windowID)]?.click
    }

    public mutating func forget(session: String) {
        entries = entries.filter { $0.key.session != session }
    }

    var count: Int { entries.count }

    private mutating func prune(now: Double) {
        entries = entries.filter { _, entry in
            guard let answered = entry.answeredAt else { return true }
            return now - answered <= carryMs
        }
    }
}

/// A click in session space mapped into a stream's frame pixels: `at × frame / space`, rounded and
/// kept inside the frame.
public enum ClickMapping {
    public static func map(_ click: ClickCarry.Click, frameWidth: Int, frameHeight: Int) -> [Int] {
        guard click.at.count == 2, click.spaceWidth > 0, click.spaceHeight > 0, frameWidth > 0, frameHeight > 0 else { return [0, 0] }
        let x = (Double(click.at[0]) * Double(frameWidth) / Double(click.spaceWidth)).rounded()
        let y = (Double(click.at[1]) * Double(frameHeight) / Double(click.spaceHeight)).rounded()
        return [min(max(Int(x), 0), frameWidth - 1), min(max(Int(y), 0), frameHeight - 1)]
    }
}
