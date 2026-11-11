/// §27.6: a window keeps answering to the titles the service gave it. Per session × app, the titles answered for each
/// window (by its id); §2.1's match, tabs included, gains one last step: a kept title of a live window, when no live
/// title or tab matched. Two live windows that once shared the title match neither; a gone window matches nothing.
public struct WindowAliases: Sendable, Equatable {
    /// the most windows kept; past it the ones answered longest ago go
    public static let maxWindows = 64

    private var titles: [Int: [String]] = [:]
    private var order: [Int] = []

    public init() {}

    /// The service answered for window `id` under `title` (a resolution, an observation).
    public mutating func answered(id: Int, title: String) {
        guard !title.isEmpty else { return }
        if !(titles[id]?.contains(title) ?? false) { titles[id, default: []].append(title) }
        order.removeAll { $0 == id }
        order.append(id)
        while order.count > Self.maxWindows { titles[order.removeFirst()] = nil }
    }

    /// The live window a title names by a kept title, or nil: none, or more than one.
    public func match(_ title: String, live: [Int]) -> Int? {
        let hits = live.filter { titles[$0]?.contains(title) ?? false }
        return hits.count == 1 ? hits[0] : nil
    }

    /// Drops the windows no longer live.
    public mutating func keep(live: [Int]) {
        let set = Set(live)
        for id in titles.keys where !set.contains(id) { titles[id] = nil }
        order.removeAll { !set.contains($0) }
    }
}
