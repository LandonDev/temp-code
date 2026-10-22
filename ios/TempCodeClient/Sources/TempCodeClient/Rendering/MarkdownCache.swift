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
    /// A pipe table: the header row first, then the body rows.
    case table([[AttributedString]])
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
        MarkdownDocument(blocks: MarkdownBlocks.split(text).map(renderBlock), textHash: text.hashValue)
    }

    /// One block's inline markdown resolved.
    public static func renderBlock(_ block: MarkdownBlock) -> RenderedBlock {
        switch block {
        case .paragraph(let p): .paragraph(MarkdownBlocks.inline(p))
        case .heading(let level, let h): .heading(level, MarkdownBlocks.inline(h))
        case .list(let items, let ordered): .list(items.map(MarkdownBlocks.inline), ordered: ordered)
        case .code(let code, let language): .code(code, language: language)
        case .quote(let q): .quote(MarkdownBlocks.inline(q))
        case .rule: .rule
        case .table(let rows): .table(rows.map { $0.map(MarkdownBlocks.inline) })
        }
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
    private struct StreamKey: Hashable {
        var scope: MarkdownScope
        var seq: Int
    }
    /// A streaming row's last parse: the source blocks and what they rendered to.
    private struct Streaming {
        var source: [MarkdownBlock]
        var rendered: [RenderedBlock]
    }
    @ObservationIgnored private var rows: [Key: MarkdownRow] = [:]
    @ObservationIgnored private var short: [Key: MarkdownDocument] = [:]
    @ObservationIgnored private var inflight: Set<Key> = []
    @ObservationIgnored private var streaming: [StreamKey: Streaming] = [:]
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let limit: Int
    @ObservationIgnored public let syncLimit: Int
    @ObservationIgnored public private(set) var parses = 0
    /// Blocks inline-parsed by `streamingDocument` so far (the test's count).
    @ObservationIgnored public private(set) var streamingParses = 0
    /// A streaming block past this many bytes stays plain text until the next block boundary.
    public static let streamingBlockLimit = 8 * 1024

    public init(limit: Int = 400, syncLimit: Int = 256) {
        self.limit = max(4, limit)
        self.syncLimit = syncLimit
    }

    public func document(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) -> MarkdownDocument? {
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        let streamKey = StreamKey(scope: scope, seq: seq)
        if let ready = short[key] {
            streaming[streamKey] = nil
            return ready
        }
        if text.utf8.count <= syncLimit {
            let document = MarkdownDocument.parse(text)
            parses += 1
            trim(&short)
            short[key] = document
            streaming[streamKey] = nil
            return document
        }
        let row = slot(key)
        if let document = row.document {
            streaming[streamKey] = nil
            return document
        }
        if inflight.insert(key).inserted {
            let generation = self.generation
            Task {
                self.parses += 1
                let document = await MarkdownDocument.render(text)
                guard self.generation == generation else { return }
                row.document = document
                self.inflight.remove(key)
                // The settled parse supersedes the row's streaming slot.
                self.streaming[streamKey] = nil
            }
        }
        // A row that was streaming keeps its incremental render until the
        // settled parse lands, so it never drops to plain text in between.
        if streaming[streamKey] != nil { return streamingDocument(scope: scope, seq: seq, text: text) }
        return nil
    }

    @discardableResult
    public func render(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) async -> MarkdownDocument {
        let ready = document(scope: scope, seq: seq, text: text)
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        // While the settled parse runs, `document` answers the streaming
        // render as a stand-in; the caller asked for the settled one.
        if let ready, !inflight.contains(key) { return ready }
        let row = slot(key)
        while inflight.contains(key) { try? await Task.sleep(for: .milliseconds(5)) }
        return row.document ?? MarkdownDocument.parse(text)
    }

    /// A streaming row's document, synchronous and incremental, the
    /// desktop's streaming path: the text is split into blocks (linear and
    /// cheap), every leading block whose source is unchanged since the last
    /// call for this row keeps its render, and only the changed tail (normally
    /// the last block) is inline-parsed again. One slot per row, dropped when
    /// the settled `document(...)` for that seq lands. A block over
    /// `streamingBlockLimit` stays a plain paragraph until the next boundary,
    /// so one huge paragraph never re-parses whole on every delta.
    public func streamingDocument(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) -> MarkdownDocument {
        let key = StreamKey(scope: scope, seq: seq)
        let source = MarkdownBlocks.split(text)
        let last = streaming[key]
        var rendered: [RenderedBlock] = []
        rendered.reserveCapacity(source.count)
        var reused = 0
        if let last {
            while reused < source.count, reused < last.source.count, source[reused] == last.source[reused] {
                rendered.append(last.rendered[reused])
                reused += 1
            }
        }
        for block in source[reused...] {
            if case .paragraph(let p) = block, p.utf8.count > Self.streamingBlockLimit {
                rendered.append(.paragraph(AttributedString(p)))
            } else {
                rendered.append(MarkdownDocument.renderBlock(block))
            }
            streamingParses += 1
        }
        if streaming.count >= limit, streaming[key] == nil { streaming = [:] }
        streaming[key] = Streaming(source: source, rendered: rendered)
        return MarkdownDocument(blocks: rendered, textHash: text.hashValue)
    }

    /// True while a streaming slot is held for the row (the test's probe).
    public func hasStreamingSlot(scope: MarkdownScope = MarkdownScope(), seq: Int) -> Bool {
        streaming[StreamKey(scope: scope, seq: seq)] != nil
    }

    public func clear() {
        generation += 1
        for row in rows.values { row.document = nil }
        rows = [:]
        short = [:]
        inflight = []
        streaming = [:]
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
