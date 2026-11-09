import Foundation

/// The numbers of one session × app key (bundle id, else name): never repeated,
/// so an app that quits and comes back under a new pid counts on (plan §4.1).
public final class IndexAllocator: @unchecked Sendable {
    private let lock = NSLock()
    private var nextIndex = 1

    public init() {}

    public func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        nextIndex += 1
        return nextIndex - 1
    }

    /// Whether this number was ever given out.
    public func issued(_ index: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return index >= 1 && index < nextIndex
    }
}

/// What one kept element of a read was, for the next read's match and the
/// diff's move check: its structural parent (0 at the top), its position among
/// that parent's kept children, and its match key.
public struct BaseNode: Sendable, Equatable {
    public var parent: Int
    public var position: Int
    public var dom: String?
    public var role: String
    public var subrole: String?
    public var name: String

    public init(parent: Int, position: Int, dom: String?, role: String, subrole: String?, name: String) {
        self.parent = parent
        self.position = position
        self.dom = dom
        self.role = role
        self.subrole = subrole
        self.name = name
    }

    /// A DOM id alone when there is one; else role, subrole, name and position.
    var key: String {
        if let dom, !dom.isEmpty { return "d\u{1}" + dom }
        return "r\u{1}\(role)\u{1}\(subrole ?? "")\u{1}\(name)\u{1}\(position)"
    }
}

/// One read's indices: every kept element's number, its structure for the next base, and whether it forces a full read.
public struct Indexed: Sendable {
    public var index: [NodeID: Int]
    public var structure: [Int: BaseNode]
    public var moved: Bool
    public var reordered: Bool
}

/// The numbers of one session × pid. Not thread-safe: the AppReader's lock guards it.
public final class IndexBook: @unchecked Sendable {
    public let allocator: IndexAllocator
    public let capacity: Int
    private var byID: [NodeID: Int] = [:]
    private var byIndex: [Int: NodeID] = [:]
    private var seen: [Int: UInt64] = [:]
    private var reads: UInt64 = 0

    public init(allocator: IndexAllocator, capacity: Int = 20_000) {
        self.allocator = allocator
        self.capacity = capacity
    }

    /// The element a number names; nil when never issued here or evicted.
    public func id(of index: Int) -> NodeID? { byIndex[index] }

    public func index(of id: NodeID) -> Int? { byID[id] }

    public func issued(_ index: Int) -> Bool { allocator.issued(index) }

    /// Point a number at another element (a rebuilt one the match found).
    public func rebind(_ index: Int, to id: NodeID) {
        if let old = byIndex[index], old != id { byID[old] = nil }
        if let prior = byID[id], prior != index { byIndex[prior] = nil }
        byIndex[index] = id
        byID[id] = index
        seen[index] = reads
    }

    public var count: Int { byIndex.count }

    private struct Flat {
        var id: NodeID
        var parent: Int
        var node: BaseNode
        var key: String
    }

    /// Spec §4.2 with plan §4.1's rule, in three steps: the same element over the
    /// whole read first; then, parent first in reading order, a rebuilt element
    /// matched one to one under its matched parent; then moves and order.
    /// `sameWindow`: the read's target window has the base's window id, so its root is the base's root whatever its title now says.
    public func assign(_ tree: KeptTree, base: Base?, sameWindow: Bool = false) -> Indexed {
        reads += 1
        var flat: [Flat] = []
        func walk(_ nodes: [KeptNode], parent: Int) {
            var position = 0
            for n in nodes where n.kind == .element {
                let i = flat.count
                let node = BaseNode(parent: 0, position: position, dom: n.domIdentifier, role: n.facts.line.role, subrole: n.subrole, name: n.facts.rawName ?? "")
                flat.append(Flat(id: n.id, parent: parent, node: node, key: node.key))
                position += 1
                walk(n.children, parent: i)
            }
        }
        walk(tree.roots, parent: -1)

        var assigned = [Int?](repeating: nil, count: flat.count)
        var taken = Set<Int>()
        let structure = base?.structure ?? [:]
        // 1. the same element keeps its number, wherever it now sits
        for (i, f) in flat.enumerated() {
            if let index = byID[f.id] {
                assigned[i] = index
                taken.insert(index)
            }
        }
        // the counts, frozen before step 2 gives any number: a key seen twice on either side matches nothing
        var newCounts: [Int: [String: Int]] = [:]
        for (i, f) in flat.enumerated() where assigned[i] == nil { newCounts[f.parent, default: [:]][f.key, default: 0] += 1 }
        var baseCounts: [Int: [String: Int]] = [:]
        var baseByKey: [Int: [String: Int]] = [:]
        for (index, b) in structure where !taken.contains(index) {
            baseCounts[b.parent, default: [:]][b.key, default: 0] += 1
            baseByKey[b.parent, default: [:]][b.key] = index
        }
        // the same window id is the same window: its root keeps the base root's number
        if sameWindow, !flat.isEmpty, assigned[0] == nil, let root = structure.first(where: { $0.value.parent == 0 && $0.value.position == 0 })?.key, !taken.contains(root) {
            assigned[0] = root
            taken.insert(root)
            newCounts[-1]?[flat[0].key]? -= 1
        }
        // 2. parent first: a rebuilt element under its matched parent
        for (i, f) in flat.enumerated() where assigned[i] == nil {
            let p = f.parent >= 0 ? assigned[f.parent]! : 0
            let key = f.key
            if newCounts[f.parent]?[key] == 1, baseCounts[p]?[key] == 1, let candidate = baseByKey[p]?[key], !taken.contains(candidate) {
                assigned[i] = candidate
                taken.insert(candidate)
            } else {
                assigned[i] = allocator.next()
            }
        }
        // 3. moves and order, once every element has its number
        var moved = false
        var positions: [Int: [Int]] = [:]
        var now: [Int: BaseNode] = [:]
        var index: [NodeID: Int] = [:]
        for (i, f) in flat.enumerated() {
            let n = assigned[i]!
            let p = f.parent >= 0 ? assigned[f.parent]! : 0
            var node = f.node
            node.parent = p
            now[n] = node
            index[f.id] = n
            if let b = structure[n] {
                if b.parent != p { moved = true } else { positions[p, default: []].append(b.position) }
            }
            rebind(n, to: f.id)
        }
        let reordered = positions.values.contains { zip($0, $0.dropFirst()).contains { $0 >= $1 } }
        evict()
        return Indexed(index: index, structure: now, moved: moved, reordered: reordered)
    }

    /// Past capacity, the entries seen longest ago go; their numbers answer `stale_element`, never another element.
    private func evict() {
        guard byIndex.count > capacity else { return }
        let old = seen.sorted { $0.value < $1.value }.prefix(byIndex.count - capacity)
        for (index, _) in old {
            if let id = byIndex.removeValue(forKey: index) { byID[id] = nil }
            seen[index] = nil
        }
    }
}
