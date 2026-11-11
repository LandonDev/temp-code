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

extension RenderedBlock {
    /// The plain text a streaming row's phrase fade reads for this block
    /// (a list's items joined by newlines); nil for a block that never
    /// fades (code, a table, a rule).
    public var plainProse: String? {
        switch self {
        case .paragraph(let text), .heading(_, let text), .quote(let text): String(text.characters)
        case .list(let items, _): items.map { String($0.characters) }.joined(separator: "\n")
        case .code, .rule, .table: nil
        }
    }
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
///
/// What is kept is bounded by count and by cost (an estimate of each parsed
/// document's bytes, `costLimit` in all), and what leaves is what was read
/// longest ago, never the lowest seq: a reader scrolling back meets old
/// rows, and those were the ones a seq order threw out first.
///
/// A settled text of up to `syncLimit` bytes that is not held parses in
/// place, so its row mounts at its real height (a row that mounted on its
/// plain-text estimate changed height when the parse landed, under the
/// reader). `prefetch` parses off the main actor ahead of the mount, so
/// most rows find theirs ready; a longer text waits for its parse.
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
    @ObservationIgnored private let costLimit: Int
    /// When each held document was last read, on a counter, and what each costs.
    @ObservationIgnored private var used: [Key: Int] = [:]
    @ObservationIgnored private var costs: [Key: Int] = [:]
    @ObservationIgnored private var reads = 0
    @ObservationIgnored public private(set) var cost = 0
    @ObservationIgnored public private(set) var parses = 0
    /// Blocks inline-parsed by `streamingDocument` so far (the test's count).
    @ObservationIgnored public private(set) var streamingParses = 0
    /// A streaming block past this many bytes stays plain text until the next block boundary.
    public static let streamingBlockLimit = 8 * 1024

    /// A text of this size or less is never worth a task of its own: `prefetch` leaves it to the mount.
    public static let prefetchFloor = 256
    /// The parsed documents kept, by the estimate `cost(of:)`.
    public static let defaultCostLimit = 12 * 1024 * 1024

    public init(limit: Int = 400, syncLimit: Int = 8 * 1024, costLimit: Int = MarkdownCache.defaultCostLimit) {
        self.limit = max(4, limit)
        self.syncLimit = syncLimit
        self.costLimit = max(1, costLimit)
    }

    /// What a text's parsed document is taken to weigh: its bytes four times over (the styled runs), and the slot.
    static func cost(of text: String) -> Int {
        text.utf8.count * 4 + 256
    }

    public func document(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) -> MarkdownDocument? {
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        let streamKey = StreamKey(scope: scope, seq: seq)
        if let ready = short[key] ?? rows[key]?.document {
            read(key, text)
            streaming[streamKey] = nil
            return ready
        }
        if text.utf8.count <= syncLimit {
            let document = MarkdownDocument.parse(text)
            parses += 1
            short[key] = document
            read(key, text)
            streaming[streamKey] = nil
            return document
        }
        let row = slot(key, text)
        if let document = row.document {
            streaming[streamKey] = nil
            return document
        }
        startParse(key, row: row, text: text, streamKey: streamKey)
        // A row that was streaming keeps its render until the settled parse
        // lands, so it never drops to plain text in between: the whole render
        // (`settled`), which is the settled parse's document, so a paragraph
        // past `streamingBlockLimit` is styled from this frame on too.
        if streaming[streamKey] != nil { return streamingDocument(scope: scope, seq: seq, text: text, settled: true) }
        return nil
    }

    /// Parses a row's text off the main actor ahead of its mount (the
    /// transcript asks for the rows of its window), so the row draws its
    /// styled document from its first frame. A short text parses at the
    /// mount anyway; a ready or running parse is left alone.
    public func prefetch(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) {
        guard text.utf8.count > min(Self.prefetchFloor, syncLimit) else { return }
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        guard short[key] == nil, !inflight.contains(key) else { return }
        let row = slot(key, text)
        guard row.document == nil else { return }
        startParse(key, row: row, text: text, streamKey: StreamKey(scope: scope, seq: seq))
    }

    /// Whether a row's document is ready to draw now (the test's probe).
    public func isReady(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) -> Bool {
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        return short[key] != nil || rows[key]?.document != nil
    }

    private func startParse(_ key: Key, row: MarkdownRow, text: String, streamKey: StreamKey) {
        guard inflight.insert(key).inserted else { return }
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

    @discardableResult
    public func render(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String) async -> MarkdownDocument {
        let ready = document(scope: scope, seq: seq, text: text)
        let key = Key(scope: scope, seq: seq, textHash: text.hashValue)
        // While the settled parse runs, `document` answers the streaming
        // render as a stand-in; the caller asked for the settled one.
        if let ready, !inflight.contains(key) { return ready }
        let row = slot(key, text)
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
    ///
    /// While live the last block's open inline spans are closed first
    /// (`MarkdownClose`, the desktop's remend), so no raw mark shows and a
    /// span closing mid-stream only grows the styled text; the closed source
    /// is what the slot keeps, so a later call without it parses that block
    /// again.
    ///
    /// `settled` drops the plain-paragraph shortcut and the closing, so the
    /// document equals `MarkdownDocument.parse` for the same text: the row
    /// that has drained draws it while the settled parse is still on its
    /// way, and the swap changes nothing on screen.
    public func streamingDocument(scope: MarkdownScope = MarkdownScope(), seq: Int, text: String, settled: Bool = false) -> MarkdownDocument {
        let key = StreamKey(scope: scope, seq: seq)
        var source = MarkdownBlocks.split(text)
        if !settled, let last = source.indices.last, !Self.wasShortcut(source[last]) { source[last] = MarkdownClose.block(source[last]) }
        let last = streaming[key]
        var rendered: [RenderedBlock] = []
        rendered.reserveCapacity(source.count)
        var reused = 0
        if let last {
            while reused < source.count, reused < last.source.count, source[reused] == last.source[reused],
                  !(settled && Self.wasShortcut(source[reused])) {
                rendered.append(last.rendered[reused])
                reused += 1
            }
        }
        for block in source[reused...] {
            if !settled, case .paragraph(let p) = block, p.utf8.count > Self.streamingBlockLimit {
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

    /// A paragraph the streaming path left plain (over `streamingBlockLimit`).
    private static func wasShortcut(_ block: MarkdownBlock) -> Bool {
        if case .paragraph(let p) = block { return p.utf8.count > streamingBlockLimit }
        return false
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
        used = [:]
        costs = [:]
        cost = 0
    }

    private func slot(_ key: Key, _ text: String) -> MarkdownRow {
        if let row = rows[key] {
            read(key, text)
            return row
        }
        let row = MarkdownRow()
        rows[key] = row
        read(key, text)
        return row
    }

    /// The document for `key` was read (or its slot made): it is the newest
    /// used, and what was used longest ago leaves once the count or the
    /// cost is past its bound, a quarter at a time. A parse still running
    /// keeps its slot.
    private func read(_ key: Key, _ text: String) {
        reads += 1
        used[key] = reads
        if costs[key] == nil {
            let weight = Self.cost(of: text)
            costs[key] = weight
            cost += weight
        }
        guard used.count > limit || cost > costLimit else { return }
        let keepCount = limit - limit / 4
        let keepCost = costLimit - costLimit / 4
        for old in used.keys.sorted(by: { (used[$0] ?? 0) < (used[$1] ?? 0) }) {
            guard used.count > keepCount || cost > keepCost else { break }
            if old == key || inflight.contains(old) { continue }
            rows[old] = nil
            short[old] = nil
            used[old] = nil
            cost -= costs.removeValue(forKey: old) ?? 0
        }
    }
}
