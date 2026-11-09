#if canImport(ApplicationServices)
import ApplicationServices
import AXText
import Foundation

/// An AXUIElement as a dictionary key: CFHash and CFEqual, which is what "the
/// same element" means to AX.
struct ElementKey: Hashable {
    let element: AXUIElement

    static func == (a: ElementKey, b: ElementKey) -> Bool { CFEqual(a.element, b.element) }
    func hash(into h: inout Hasher) { h.combine(CFHash(element)) }
}

/// Every AXUIElement a reader has seen, interned to one NodeID each and held
/// alive, so an index resolves back to its element (plan §5.1). Its size
/// follows the index book's: past it the entries used longest ago go.
final class HandleTable: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [ElementKey: NodeID] = [:]
    private var elements: [NodeID: AXUIElement] = [:]
    private var used: [NodeID: UInt64] = [:]
    private var next: NodeID = 0
    private var tick: UInt64 = 0
    let capacity: Int

    init(capacity: Int = 20_000) {
        self.capacity = capacity
    }

    func intern(_ element: AXUIElement) -> NodeID {
        lock.lock()
        defer { lock.unlock() }
        tick += 1
        let key = ElementKey(element: element)
        if let id = ids[key] {
            used[id] = tick
            return id
        }
        next += 1
        ids[key] = next
        elements[next] = element
        used[next] = tick
        return next
    }

    func element(_ id: NodeID) -> AXUIElement? {
        lock.lock()
        defer { lock.unlock() }
        return elements[id]
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return elements.count
    }

    /// Past capacity, the handles used longest ago go.
    func trim() {
        lock.lock()
        defer { lock.unlock() }
        guard elements.count > capacity else { return }
        for (id, _) in used.sorted(by: { $0.value < $1.value }).prefix(elements.count - capacity) {
            if let el = elements.removeValue(forKey: id) { ids[ElementKey(element: el)] = nil }
            used[id] = nil
        }
    }

    func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        ids = [:]
        elements = [:]
        used = [:]
    }
}
#endif
