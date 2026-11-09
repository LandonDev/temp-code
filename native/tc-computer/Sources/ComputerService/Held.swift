import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

extension HeldRecord: HeldEntry {
    public var kindKey: String { kind.rawValue }
}

/// Every button or key held past one event pair: the crash ledger on disk (`<dataDir>/held.json`), the
/// session each pid's hold belongs to, and the app slot's sticky owner (shell §2, §8.3).
final class HeldInput: @unchecked Sendable {
    private let lock = NSLock()
    private var ledger: HeldLedger<HeldRecord>?
    /// pid → the session that pressed and the kinds still down
    private var holds: [Int32: (session: String, kinds: Set<HeldRecord.Kind>)] = [:]
    private let slots: AppSlots
    private let book: SessionBook
    private let warn: @Sendable (String) -> Void

    init(slots: AppSlots, book: SessionBook, warn: @escaping @Sendable (String) -> Void) {
        self.slots = slots
        self.book = book
        self.warn = warn
    }

    /// At `initialize`: the ledger under the data dir, and the records a dead service left in it.
    func open(dataDir: URL) -> [HeldRecord] {
        let ledger = HeldLedger<HeldRecord>(file: dataDir.appendingPathComponent("held.json"))
        lock.withLock { self.ledger = ledger }
        do {
            return try ledger.takeStale()
        } catch {
            warn("the held-input ledger could not be read: \(error)")
            return []
        }
    }

    /// Input's `onHeld`. The record is on disk before this returns, so it is there before the down is posted.
    func handle(_ event: HeldEvent) {
        switch event {
        case .pressing(let record):
            let session = slots.slot(record.pid).holder ?? lock.withLock { holds[record.pid]?.session }
            lock.withLock {
                do { try ledger?.pressing(record) } catch { warn("the held-input ledger could not be written: \(error)") }
                if let session {
                    var hold = holds[record.pid] ?? (session, [])
                    hold.kinds.insert(record.kind)
                    holds[record.pid] = hold
                }
            }
            if let session {
                book.setHeld(session, pid: record.pid, tier: record.tier)
                slots.slot(record.pid).setSticky(session)
            }
        case .released(let pid, let kind):
            let ended: String? = lock.withLock {
                do { try ledger?.released(pid: pid, kindKey: kind.rawValue) } catch { warn("the held-input ledger could not be written: \(error)") }
                guard var hold = holds[pid] else { return nil }
                hold.kinds.remove(kind)
                if hold.kinds.isEmpty {
                    holds[pid] = nil
                    return hold.session
                }
                holds[pid] = hold
                return nil
            }
            if let ended {
                book.setHeld(ended, pid: pid, tier: nil)
                slots.existing(pid)?.setSticky(nil)
            }
        }
    }

    /// The session that holds input on `pid`.
    func session(holding pid: Int32) -> String? { lock.withLock { holds[pid]?.session } }

    /// Every pid with input held, and its session.
    var all: [(pid: Int32, session: String)] { lock.withLock { holds.map { ($0.key, $0.value.session) } } }
}
