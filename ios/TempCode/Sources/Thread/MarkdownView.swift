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
/// main actor once per text version. Until the parse lands the row shows
/// its plain text at the same size, so nothing shifts but the styling.
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

    var body: some View {
        if streaming {
            MarkdownBlocksView(document: ThreadCaches.markdown.streamingDocument(scope: scope, seq: seq, text: text), dim: dim)
        } else if let document = ThreadCaches.markdown.document(scope: scope, seq: seq, text: text) {
            MarkdownBlocksView(document: document, dim: dim)
        } else {
            Text(text)
                .font(.body)
                .foregroundStyle(dim ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The desktop's `AgentMarkdown` in SwiftUI: paragraphs at body size with a
/// generous measure, headings two and one steps up, lists with a hanging
/// marker, code in a bordered block, a quote behind a 2 pt rule, tables as
/// a bordered grid that scrolls sideways.
struct MarkdownBlocksView: View {
    let document: MarkdownDocument
    var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(text.inlineStyled())
                        .font(.body)
                case .heading(let level, let text):
                    Text(text.inlineStyled())
                        .font(level <= 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                        .padding(.top, level <= 2 ? 8 : 4)
                case .list(let items, let ordered):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            ListItemRow(item: item, index: index, ordered: ordered)
                        }
                    }
                    .font(.body)
                case .code(let code, let language):
                    CodeBlock(text: code, language: language, font: .callout, maxLines: 40)
                case .quote(let text):
                    Text(text.inlineStyled())
                        .font(.body)
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
}

/// Monospaced text one step down, never wrapped: a language header when the
/// fence names one, line numbers in the dim step, sideways scroll, a fold
/// past `maxLines`, and Copy in the context menu. The desktop's `CodeBlock`
/// without the colouring (no highlighter runs on the phone).
struct CodeBlock: View {
    let text: String
    var language: String? = nil
    var font: Font.TextStyle = .footnote
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
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 36)
                Hairline()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    if lineNumbers, lines.count > 1 {
                        Text(shown.indices.map { String($0 + 1) }.joined(separator: "\n"))
                            .font(.system(font, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .frame(minWidth: 24, alignment: .trailing)
                            .accessibilityHidden(true)
                    }
                    Text(shown.joined(separator: "\n"))
                        .font(.system(font, design: .monospaced))
                        .foregroundStyle(tint ?? .primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            if lines.count > maxLines {
                Button {
                    withAnimation(expanded ? Motion.collapse : Motion.expand) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Show all \(lines.count) lines")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
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
                                .font(index == 0 ? .subheadline.weight(.semibold) : .subheadline)
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
            .padding(.horizontal, 10)
        }
        .transcriptBlock()
    }
}

extension AttributedString {
    /// Inline code one step down in mono on the desktop's wash, so a `name`
    /// sits in the line instead of standing out of it; the rest keeps the
    /// paragraph's font. (A run's background has no radius of its own; at
    /// text height the square wash reads as the desktop's 4 px.)
    func inlineStyled() -> AttributedString {
        var styled = self
        for run in styled.runs where run.inlinePresentationIntent?.contains(.code) == true {
            styled[run.range].font = .system(.callout, design: .monospaced)
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
            Text(text.inlineStyled())
                .foregroundStyle(checked == true ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
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
