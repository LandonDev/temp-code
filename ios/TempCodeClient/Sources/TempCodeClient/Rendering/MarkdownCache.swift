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

/// Parsed markdown per row, keyed by seq and text hash. Reads are
/// synchronous on the main actor. Text under `syncLimit` bytes parses on the
/// spot into an unobserved side table (most rows: a line or two); longer
/// text parses off the main actor and lands in the row's observable slot, so
/// the row paints plain text once and then its styling, and a streaming row
/// keeps its last parse until the next lands.
@MainActor @Observable
public final class MarkdownCache {
    // Nothing here is observed: a read from a view body writes these, and an
    // observed write there would invalidate the body that made it.
    @ObservationIgnored private var rows: [Int: MarkdownRow] = [:]
    @ObservationIgnored private var short: [Int: MarkdownDocument] = [:]
    @ObservationIgnored private var inflight: Set<Int> = []
    @ObservationIgnored private var pending: [Int: String] = [:]
    @ObservationIgnored private let limit: Int
    /// Text this long or shorter parses synchronously.
    @ObservationIgnored public let syncLimit: Int
    /// Parses run so far (tests).
    @ObservationIgnored public private(set) var parses = 0

    public init(limit: Int = 400, syncLimit: Int = 256) {
        self.limit = limit
        self.syncLimit = syncLimit
    }

    /// The row's document when its text is the one parsed; else the stale
    /// one while a parse runs, or nil for a long row never seen.
    public func document(seq: Int, text: String) -> MarkdownDocument? {
        let hash = text.hashValue
        if let ready = short[seq], ready.textHash == hash { return ready }
        if text.utf8.count <= syncLimit {
            let document = MarkdownDocument.parse(text)
            parses += 1
            if short[seq] == nil { trim(&short) }
            short[seq] = document
            return document
        }
        let row = slot(seq)
        if let document = row.document, document.textHash == hash { return document }
        if inflight.contains(seq) {
            // The newest text wins once the running parse lands.
            pending[seq] = text
        } else {
            inflight.insert(seq)
            Task { await self.parse(seq: seq, text: text) }
        }
        return row.document
    }

    /// Parses and stores, awaitable; the document for `text` once it is in.
    @discardableResult
    public func render(seq: Int, text: String) async -> MarkdownDocument {
        if let ready = document(seq: seq, text: text), ready.textHash == text.hashValue { return ready }
        if !inflight.contains(seq) {
            inflight.insert(seq)
            await parse(seq: seq, text: text)
        } else {
            pending[seq] = text
            while inflight.contains(seq) { try? await Task.sleep(for: .milliseconds(5)) }
        }
        return slot(seq).document ?? MarkdownDocument.parse(text)
    }

    /// Drops every entry; the next read parses again.
    public func clear() {
        for row in rows.values { row.document = nil }
        rows = [:]
        short = [:]
        pending = [:]
    }

    private func slot(_ seq: Int) -> MarkdownRow {
        if let row = rows[seq] { return row }
        trim(&rows)
        let row = MarkdownRow()
        rows[seq] = row
        return row
    }

    private func parse(seq: Int, text: String) async {
        var text = text
        while true {
            parses += 1
            let document = await MarkdownDocument.render(text)
            slot(seq).document = document
            guard let next = pending.removeValue(forKey: seq), next.hashValue != document.textHash else { break }
            text = next
        }
        inflight.remove(seq)
    }

    /// Rows far from the tail are the ones scrolled away from.
    private func trim<Value>(_ table: inout [Int: Value]) {
        guard table.count >= limit else { return }
        for key in table.keys.sorted().prefix(limit / 4) { table[key] = nil }
    }
}
