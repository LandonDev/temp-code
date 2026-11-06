import SwiftUI
import TempCodeClient

/// The markdown cache every row reads; one per process.
enum ThreadCaches {
    static let markdown = MarkdownCache()
}

private struct MarkdownScopeKey: EnvironmentKey {
    static let defaultValue = MarkdownScope()
}

extension EnvironmentValues {
    var markdownScope: MarkdownScope {
        get { self[MarkdownScopeKey.self] }
        set { self[MarkdownScopeKey.self] = newValue }
    }
}

/// The agent's prose as the page: body size, no container, parsed off the
/// main actor once per text version, ahead of the row's mount for the
/// transcript's window (`MarkdownCache.prefetch`), so a row draws styled
/// from its first frame. A row whose parse has not landed yet keeps its
/// height estimate (its plain text laid out, not drawn) and draws the
/// styled document when it lands, never plain text first; a row that was
/// streaming keeps its whole streaming render, the same document.
/// A `streaming` row parses on the main actor, incrementally: only the
/// block that changed (normally the last) is parsed again, so the earlier
/// blocks keep their render and nothing flickers between plain and styled.
/// `dim` draws the whole document in the secondary step (a thought).
struct MarkdownView: View {
    @Environment(\.markdownScope) private var scope
    let seq: Int
    let text: String
    var dim = false
    var streaming = false
    /// The streaming row's phrase fade; nil draws every block as it stands.
    var fade: StreamFadeState? = nil

    var body: some View {
        if streaming {
            MarkdownBlocksView(document: ThreadCaches.markdown.streamingDocument(scope: scope, seq: seq, text: text), dim: dim, fade: fade)
        } else if let document = ThreadCaches.markdown.document(scope: scope, seq: seq, text: text) {
            MarkdownBlocksView(document: document, dim: dim)
        } else {
            // The parse is on its way: the row's height, nothing drawn.
            Text(text)
                .transcriptType(TranscriptType.prose)
                .frame(maxWidth: .infinity, alignment: .leading)
                .hidden()
                .accessibilityHidden(true)
        }
    }
}

/// The desktop's `AgentMarkdown` in SwiftUI: paragraphs in the prose type
/// (15 on 22), headings on the prose ladder (17, 16, 15 semibold), lists
/// with a hanging marker, code in a bordered block in the code type, a
/// quote behind a 2 pt rule, tables as a bordered grid that scrolls sideways.
struct MarkdownBlocksView: View {
    let document: MarkdownDocument
    var dim = false
    /// A streaming row's fade: prose blocks (paragraphs, headings, quotes,
    /// list items) draw their young steps faded; code, tables and rules never.
    var fade: StreamFadeState? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.Gap.block) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    prose(text.inlineStyled(), type: TranscriptType.prose)
                case .heading(let level, let text):
                    prose(text.inlineStyled(), type: level <= 1 ? TranscriptType.proseH1 : level == 2 ? TranscriptType.proseH2 : TranscriptType.proseH3)
                        .padding(.top, level <= 2 ? TranscriptMetrics.Gap.line * 2 : TranscriptMetrics.Gap.line)
                case .list(let items, let ordered):
                    let itemRuns = listRuns(items)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            ListItemRow(item: item, index: index, ordered: ordered, runs: itemRuns?[index])
                        }
                    }
                    .transcriptType(TranscriptType.prose)
                case .code(let code, let language):
                    CodeBlock(text: code, language: language, type: TranscriptType.code, maxLines: 40)
                case .quote(let text):
                    prose(text.inlineStyled(), type: TranscriptType.prose)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 12)
                        .padding(.vertical, 2)
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(TranscriptStyle.control)
                                .frame(width: 2)
                        }
                case .rule:
                    Hairline()
                        .padding(.vertical, 4)
                case .table(let rows):
                    MarkdownTable(rows: rows)
                }
            }
        }
        .foregroundStyle(dim ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A prose block: plain when nothing fades, else its runs through the renderer.
    @ViewBuilder
    private func prose(_ styled: AttributedString, type: TypeSpec) -> some View {
        if let fade {
            StreamFadeText(styled: styled, runs: fade.runs(String(styled.characters)), type: type)
        } else {
            Text(styled)
                .transcriptType(type)
        }
    }

    /// A list's runs per item: the ledger reads the items joined by newlines.
    private func listRuns(_ items: [AttributedString]) -> [[RevealSegment]]? {
        guard let fade else { return nil }
        let plain = items.map { String($0.characters) }
        let runs = fade.runs(plain.joined(separator: "\n"))
        var start = 0
        return plain.map { item in
            defer { start += item.count + 1 }
            return RevealSegment.slice(runs, from: start, to: start + item.count)
        }
    }
}

/// Monospaced text in a code type (`rowCode` by default), never wrapped: a language header when the
/// fence names one, line numbers in the dim step, sideways scroll, a fold
/// past `maxLines`, and Copy in the context menu. The desktop's `CodeBlock`
/// without the colouring (no highlighter runs on the phone).
struct CodeBlock: View {
    let text: String
    var language: String? = nil
    var type: TypeSpec = TranscriptType.rowCode
    var maxLines = 24
    var tint: Color? = nil
    var lineNumbers = true
    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let folded = lines.count > maxLines && !expanded
        let shown = folded ? Array(lines.prefix(maxLines)) : lines
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .transcriptType(TranscriptType.detail, weight: .medium)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, TranscriptMetrics.tableInset)
                    .frame(minHeight: TranscriptMetrics.tableRow)
                Hairline()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    if lineNumbers, lines.count > 1 {
                        Text(shown.indices.map { String($0 + 1) }.joined(separator: "\n"))
                            .transcriptType(type)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .frame(minWidth: 24, alignment: .trailing)
                            .accessibilityHidden(true)
                    }
                    Text(shown.joined(separator: "\n"))
                        .transcriptType(type)
                        .foregroundStyle(tint ?? .primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.vertical, 8)
            }
            // The first character rests on the block's inset at either end of a sideways scroll.
            .contentMargins(.horizontal, TranscriptMetrics.tableInset, for: .scrollContent)
            if lines.count > maxLines {
                Button {
                    withAnimation(expanded ? Motion.collapse : Motion.expand) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Show all \(lines.count) lines")
                        .transcriptType(TranscriptType.line, weight: .medium)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, TranscriptMetrics.tableInset)
                        .frame(minHeight: TranscriptMetrics.tableRow)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transcriptBlock()
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
    }
}

/// A pipe table: header row semibold, rows parted by hairlines, scrolling
/// sideways when the columns outgrow the phone.
private struct MarkdownTable: View {
    let rows: [[AttributedString]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell.inlineStyled())
                                .transcriptType(TranscriptType.line, weight: index == 0 ? .semibold : .regular)
                                .monospacedDigit()
                                .foregroundStyle(index == 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                                .padding(.vertical, 7)
                                .gridColumnAlignment(.leading)
                        }
                    }
                    if index < rows.count - 1 {
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
        }
        .contentMargins(.horizontal, TranscriptMetrics.tableInset, for: .scrollContent)
        .transcriptBlock()
    }
}

extension AttributedString {
    /// Inline code in the code type on the desktop's wash, so a `name`
    /// sits in the line instead of standing out of it; the rest keeps the
    /// paragraph's font. (A run's background has no radius of its own; at
    /// text height the square wash reads as the desktop's 4 px.)
    func inlineStyled() -> AttributedString {
        var styled = self
        for run in styled.runs where run.inlinePresentationIntent?.contains(.code) == true {
            styled[run.range].font = TranscriptType.code.font
            styled[run.range].backgroundColor = Color(.tertiarySystemFill)
        }
        return styled
    }
}

/// One list item; a `[ ]` or `[x]` prefix becomes a checkbox glyph.
private struct ListItemRow: View {
    let item: AttributedString
    let index: Int
    let ordered: Bool
    /// The item's runs while its row streams (nil: drawn as it stands).
    var runs: [RevealSegment]? = nil

    var body: some View {
        let (checked, text) = Self.checklist(item)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let checked {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.footnote)
                    .foregroundStyle(checked ? Tint.success : Color(.tertiaryLabel))
                    .frame(minWidth: 18)
            } else {
                Text(ordered ? "\(index + 1)." : "•")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(minWidth: 18, alignment: .trailing)
            }
            itemText(text.inlineStyled(), checked: checked)
                .foregroundStyle(checked == true ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
        }
    }

    @ViewBuilder
    private func itemText(_ styled: AttributedString, checked: Bool?) -> some View {
        // A checkbox item's runs count its "[x] " prefix, which the glyph replaced: shift them by it.
        let shift = checked == nil ? 0 : 4
        if let runs, runs.contains(where: \.young) {
            StreamFadeText(styled: styled, runs: runs.compactMap { run in
                let from = max(0, run.from - shift), to = run.to - shift
                return to > from ? RevealSegment(from: from, to: min(to, styled.characters.count), bornAt: run.bornAt) : nil
            }, type: TranscriptType.prose)
        } else {
            Text(styled)
        }
    }

    /// Splits "[x] Ship it" into its tick and the rest; nil when the item is not a checkbox.
    private static func checklist(_ item: AttributedString) -> (Bool?, AttributedString) {
        let plain = String(item.characters)
        for (mark, checked) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] where plain.hasPrefix(mark) {
            var rest = item
            rest.removeSubrange(rest.startIndex..<rest.index(rest.startIndex, offsetByCharacters: mark.count))
            return (checked, rest)
        }
        return (nil, item)
    }
}

/// Markdown by text alone, for screens with no row seq (the inbox detail):
/// the text's own hash keys its slot in the cache.
struct MarkdownText: View {
    let text: String

    var body: some View {
        MarkdownView(seq: ThreadCaches.documentSeq(text), text: text)
    }
}
