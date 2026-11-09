import ComputerCore
import ComputerProtocol
import Foundation

/// What a paste writes: the plain string always, rendered HTML and RTF for markdown, HTML as given for html.
public struct PasteContent: Equatable, Sendable {
    public var plain: String
    public var html: String?
    public var rtf: Data?

    public init(plain: String, html: String? = nil, rtf: Data? = nil) {
        self.plain = plain
        self.html = html
        self.rtf = rtf
    }
}

/// One pasteboard item: its types in order, each with its data.
public struct PasteboardItemData: Equatable, Sendable {
    public var types: [String]
    public var data: [String: Data]

    public init(types: [String], data: [String: Data]) {
        self.types = types
        self.data = data
    }
}

/// Everything on the pasteboard, to put back byte for byte.
public struct PasteboardSnapshot: Equatable, Sendable {
    public var items: [PasteboardItemData]
    public var changeCount: Int

    public init(items: [PasteboardItemData], changeCount: Int) {
        self.items = items
        self.changeCount = changeCount
    }
}

/// The pasteboard as the paste flow uses it; SystemPasteboard is NSPasteboard, the tests use a private one.
public protocol PasteboardStore: AnyObject {
    var changeCount: Int { get }
    /// Every item, every type with its data. Throws `clipboard_busy` when the data can't be saved:
    /// `changeCount` moved while it read, or a type's data could not be read (a promise its owner did not keep).
    func snapshot() throws -> PasteboardSnapshot
    func clear()
    /// May throw after clearing.
    func write(_ content: PasteContent) throws
    func restore(_ snapshot: PasteboardSnapshot)
}

public func clipboardBusy(_ message: String) -> ComputerFailure {
    ComputerFailure(.clipboardBusy, message)
}

/// The paste flow under the Mac-wide clipboard lock: check, snapshot, write, check again,
/// Command-V, wait for the destination, and on every exit put the person's clipboard back
/// unless they copied meanwhile.
public struct PasteFlow {
    public let store: PasteboardStore
    public let lock: MacLock
    public let clock: InputClock

    public init(store: PasteboardStore, lock: MacLock, clock: InputClock) {
        self.store = store
        self.lock = lock
        self.clock = clock
    }

    /// - checks: the destination and the key window, before the clipboard is touched
    /// - recheck: the same, after the write and before the keys
    /// - post: Command-V
    /// - evidence: the destination's evidence now, nil when unreadable
    public func run(_ content: PasteContent, cancelled: () -> Bool, checks: () throws -> Void, recheck: () throws -> Void, post: () throws -> Void, evidence: () -> Evidence?) throws -> (ClipboardOutcome, StepEffect) {
        guard let hold = lock.acquire(within: InputTiming.clipboardWaitS) else {
            throw clipboardBusy("Another paste is using the clipboard; try again.")
        }
        defer { hold.release() }
        let start = clock.seconds()
        let cap = start + Double(InputTiming.pasteCapMs) / 1000
        try checks()
        let snapshot = try store.snapshot()
        var owned = snapshot.changeCount
        var effect: StepEffect = .unknown
        var failure: Error?
        do {
            let before = evidence() ?? Evidence()
            // the person copied since the snapshot: theirs stays, nothing is written
            if store.changeCount != snapshot.changeCount { throw clipboardBusy("The clipboard changed while the paste read it; nothing was pasted.") }
            store.clear()
            owned = store.changeCount
            try store.write(content)
            owned = store.changeCount
            try recheck()
            if cancelled() { throw cancelledFailure() }
            if clock.seconds() >= cap { throw clipboardBusy("The paste ran past its time; nothing was pasted.") }
            try post()
            let until = min(clock.seconds() + Double(InputTiming.pasteWaitMs) / 1000, cap)
            var after = evidence() ?? Evidence()
            while Evidence.compare(before: before, after: after) != .changed, clock.seconds() < until {
                if cancelled() { throw cancelledFailure() }
                clock.sleep(ms: 10)
                after = evidence() ?? Evidence()
            }
            effect = Evidence.compare(before: before, after: after)
        } catch {
            failure = error
        }
        let outcome: ClipboardOutcome
        if store.changeCount == owned {
            store.restore(snapshot)
            outcome = .restored
        } else {
            outcome = .keptPersonCopy
        }
        if let failure { throw failure }
        return (outcome, effect)
    }
}
