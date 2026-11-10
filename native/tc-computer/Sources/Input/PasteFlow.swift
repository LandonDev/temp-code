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

/// The paste's own check refused: someone copied within the call's `pasteQuietMs`.
public func recentCopyRefusal() -> ComputerFailure {
    ComputerFailure(ComputerError(kind: .clipboardBusy, message: "The clipboard changed just now (someone copied); nothing was pasted.", reason: .recentCopy))
}

/// What a paste did: how it went in, what became of the clipboard (nil when it never touched it), what changed.
public struct PasteResult: Equatable, Sendable {
    public var via: InputVia
    public var clipboard: ClipboardOutcome?
    public var effect: StepEffect

    public init(via: InputVia, clipboard: ClipboardOutcome?, effect: StepEffect) {
        self.via = via
        self.clipboard = clipboard
        self.effect = effect
    }
}

/// The paste flow: first, when given, the AX insert of the plain text (§24.6), which needs no
/// clipboard; then under the Mac-wide clipboard lock: check, snapshot, write, check again,
/// Command-V, wait for the destination, and on every exit put the person's clipboard back
/// unless they copied meanwhile.
public struct PasteFlow {
    public let store: PasteboardStore
    public let lock: MacLock
    public let clock: InputClock
    /// the shell's pasteboard watch: a foreign change within this many ms (`watchingSince` counted)
    public let recentForeignCopy: @Sendable (_ withinMs: Int) -> Bool

    public init(store: PasteboardStore, lock: MacLock, clock: InputClock, recentForeignCopy: @escaping @Sendable (_ withinMs: Int) -> Bool = { _ in false }) {
        self.store = store
        self.lock = lock
        self.clock = clock
        self.recentForeignCopy = recentForeignCopy
    }

    /// - checks: the destination and the key window, before the clipboard is touched
    /// - recheck: the same, after the write and before the keys
    /// - insert: the AX insert rung: the destination's effect, nil when it takes no insert; on `changed`
    ///   or `unknown` the paste is done with the clipboard untouched, on `none` it goes on to the clipboard
    /// - checks: also find how Command-V will go in (§24.6): a disabled Paste refuses here, before the write
    /// - deliver: Command-V, as §24.2 delivers it (the Paste item pressed when enabled, else the posted key)
    /// - evidence: the destination's evidence now, nil when unreadable
    /// - quietMs: the call's `pasteQuietMs`; with it, a foreign copy that recent refuses the paste
    ///   `recent-copy` once the lock is held, before the pasteboard is read or written
    public func run(_ content: PasteContent, quietMs: Int? = nil, cancelled: () -> Bool, insert: (() throws -> StepEffect?)? = nil, checks: () throws -> Void, recheck: () throws -> Void, deliver: () throws -> Void, evidence: () -> Evidence?) throws -> PasteResult {
        if let insert, let effect = try insert(), effect != .none {
            return PasteResult(via: .axInsert, clipboard: nil, effect: effect)
        }
        guard let hold = lock.acquire(within: InputTiming.clipboardWaitS) else {
            throw clipboardBusy("Another paste is using the clipboard; try again.")
        }
        defer { hold.release() }
        if let quietMs, recentForeignCopy(quietMs) { throw recentCopyRefusal() }
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
            try deliver()
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
        return PasteResult(via: .paste, clipboard: outcome, effect: effect)
    }
}
