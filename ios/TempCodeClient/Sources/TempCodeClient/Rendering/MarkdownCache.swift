import Foundation
import Observation

/// A markdown block with its inline styling resolved: what a row draws.
public enum RenderedBlock: Sendable, Hashable {
    case paragraph(AttributedString)
    case heading(Int, AttributedString)
    case list([AttributedString], ordered: Bool)
    case code(String, language: String?)
    case quote(AttributedString)
    case rule
}

/// One row's markdown, parsed once per text version.
public struct MarkdownDocument: Sendable, Hashable {
    public var blocks: [RenderedBlock]
    /// The hash of the text this came from; a row whose text moved re-renders.
    public var textHash: Int

    public init(blocks: [RenderedBlock], textHash: Int) {
        self.blocks = blocks
        self.textHash = textHash
    }

    /// The whole parse, synchronous: block splitting and inline markdown.
    public static func parse(_ text: String) -> MarkdownDocument {
        let blocks: [RenderedBlock] = MarkdownBlocks.split(text).map { block in
            switch block {
            case .paragraph(let p): .paragraph(MarkdownBlocks.inline(p))
            case .heading(let level, let h): .heading(level, MarkdownBlocks.inline(h))
            case .list(let items, let ordered): .list(items.map(MarkdownBlocks.inline), ordered: ordered)
            case .code(let code, let language): .code(code, language: language)
            case .quote(let q): .quote(MarkdownBlocks.inline(q))
            case .rule: .rule
            }
        }
        return MarkdownDocument(blocks: blocks, textHash: text.hashValue)
    }

    /// The same parse, off the caller's actor.
    @concurrent
    public static func render(_ text: String) async -> MarkdownDocument {
        parse(text)
    }
}

/// One row's slot in the cache: the only thing a row observes, so a parse
/// landing re-renders that row and no other.
@MainActor @Observable
public final class MarkdownRow {
    public internal(set) var document: MarkdownDocument?
}

/// A row's host and thread, also used for synthetic plan and report rows.
public struct MarkdownScope: Sendable, Hashable {
    public var environmentId: String
    public var sessionId: String

    public init(environmentId: String = "", sessionId: String = "") {
        self.environmentId = environmentId
        self.sessionId = sessionId
    }
}

/// Parsed markdown by host, thread, seq and text hash. Each text version
/// has its own slot, so a miss never serves another consumer's document.
@MainActor @Observable
public final class MarkdownCache {
    private struct Key: Hashable {
        var scope: MarkdownScope
        var seq: Int
        var textHash: Int
    }
    @ObservationIgnored private var rows: [Key: MarkdownRow] = [:]
    @ObservationIgnored private var short: [Key: MarkdownDocument] = [:]
    @ObservationIgnored private var inflight: Set<Key> = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let limit: Int
    @ObservationIgnored public let syncLimit: Int
    @ObservationIgnored public private(set) var parses = 0

    public init(limit: Int = 400, syncLimit: Int = 256) {
        self.limit = max(4, limit)
        self.syncLimit = syncLimit
    }

    public func document(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) -> MarkdownDocument? {
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        if let ready = short[key] { return ready }
        if text.utf8.count <= syncLimit {
            let document = MarkdownDocument.parse(text)
            parses += 1
            trim(&short)
            short[key] = document
            return document
        }
        let row = slot(key)
        if let document = row.document { return document }
        if inflight.insert(key).inserted {
            let generation = self.generation
            Task {
                self.parses += 1
                let document = await MarkdownDocument.render(text)
                guard self.generation == generation else { return }
                row.document = document
                self.inflight.remove(key)
            }
        }
        return nil
    }

    @discardableResult
    public func render(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) async -> MarkdownDocument {
        if let ready = document(scope: scope, seq: seq, text: text) { return ready }
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        let row = slot(key)
        while inflight.contains(key) { try? await Task.sleep(for: .milliseconds(5)) }
        return row.document ?? MarkdownDocument.parse(text)
    }

    public func clear() {
        generation += 1
        for row in rows.values { row.document = nil }
        rows = [:]
        short = [:]
        inflight = []
    }

    private func slot(_ key: Key) -> MarkdownRow {
        if let row = rows[key] { return row }
        trim(&rows)
        let row = MarkdownRow()
        rows[key] = row
        return row
    }

    private func trim<Value>(_ table: inout [Key: Value]) {
        guard table.count >= limit else { return }
        for key in table.keys.sorted(by: { $0.seq < $1.seq }).prefix(limit / 4) { table[key] = nil }
    }
}
