import Foundation

/// stdin as lines. A line past `maxBytes` is dropped up to its newline and reported once, so the
/// buffer never holds more than one line's bytes and the next line reads as usual.
public struct LineSplitter: Sendable {
    public enum Item: Equatable, Sendable {
        case line(Data)
        /// a line was dropped; its length so far
        case overlong(Int)
    }

    public let maxBytes: Int
    private var buffer = Data()
    /// inside an over-long line: everything up to the next newline goes
    private var discarding = false

    public init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    public mutating func feed(_ data: Data) -> [Item] {
        var items: [Item] = []
        var rest = data[...]
        while !rest.isEmpty {
            let newline = rest.firstIndex(of: 0x0A)
            let chunk = rest[rest.startIndex..<(newline ?? rest.endIndex)]
            if discarding {
                if newline != nil { discarding = false }
            } else if buffer.count + chunk.count > maxBytes {
                items.append(.overlong(buffer.count + chunk.count))
                buffer.removeAll(keepingCapacity: false)
                discarding = newline == nil
            } else {
                buffer.append(contentsOf: chunk)
                if newline != nil {
                    if !buffer.isEmpty { items.append(.line(buffer)) }
                    buffer = Data()
                }
            }
            guard let newline else { break }
            rest = rest[rest.index(after: newline)...]
        }
        return items
    }
}
