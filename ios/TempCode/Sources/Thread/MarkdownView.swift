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
struct MarkdownView: View {
    @Environment(\.markdownScope) private var scope
    let seq: Int
    let text: String

    var body: some View {
        if let document = ThreadCaches.markdown.document(scope: scope, seq: seq, text: text) {
            MarkdownBlocksView(document: document)
        } else {
            Text(text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MarkdownBlocksView: View {
    let document: MarkdownDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(text.inlineStyled())
                        .font(.body)
                case .heading(let level, let text):
                    Text(text.inlineStyled())
                        .font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                        .padding(.top, 6)
                case .list(let items, let ordered):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            ListItemRow(item: item, index: index, ordered: ordered)
                        }
                    }
                    .font(.body)
                case .code(let code, _):
                    CodeBlock(text: code, font: .subheadline, maxLines: 40)
                case .quote(let text):
                    Text(text.inlineStyled())
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Color(.tertiaryLabel))
                                .frame(width: 2)
                        }
                case .rule:
                    Hairline()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Monospaced text one step down, never wrapped: it scrolls sideways, folds
/// past `maxLines`, and copies from the context menu.
struct CodeBlock: View {
    let text: String
    var font: Font.TextStyle = .subheadline
    var maxLines = 24
    var tint: Color?
    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let shown = expanded ? lines : Array(lines.prefix(maxLines))
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(shown.joined(separator: "\n"))
                    .font(.system(font, design: .monospaced))
                    .foregroundStyle(tint ?? .primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
            if lines.count > maxLines {
                Button(expanded ? "Show less" : "Show all \(lines.count) lines") {
                    withAnimation(expanded ? Motion.collapse : Motion.expand) { expanded.toggle() }
                }
                .font(.footnote.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 10)
                .padding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
    }
}

extension AttributedString {
    /// Inline code one step down in mono, so a `name` sits in the line
    /// instead of standing out of it; the rest keeps the paragraph's font.
    func inlineStyled() -> AttributedString {
        var styled = self
        for run in styled.runs where run.inlinePresentationIntent?.contains(.code) == true {
            styled[run.range].font = .system(.callout, design: .monospaced)
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
                    .frame(minWidth: 16)
            } else {
                Text(ordered ? "\(index + 1)." : "•")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(minWidth: 16, alignment: .trailing)
            }
            Text(text.inlineStyled())
                .foregroundStyle(checked == true ? .secondary : .primary)
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
