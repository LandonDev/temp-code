import AppKit

public enum RichTextRTF {
    /// the same runs as MarkdownHTML, as an attributed string: system font at NSFont.systemFontSize, bold/italic traits for strong/emphasis, NSFont.monospacedSystemFont for code (inline and blocks), larger bold system fonts for headings (h1 2.0×, h2 1.6×, h3 1.3×, h4–h6 1.1×), strikethrough style, .link attribute for links, list items prefixed with "•\t" or "N.\t" and indented by level with an NSParagraphStyle (headIndent / firstLineHeadIndent / tabStops), block quotes indented, paragraphs separated by "\n"
    public static func attributed(fromMarkdown markdown: String) -> NSAttributedString {
        let blocks = MarkdownBlocks.parse(markdown) ?? [.paragraph([MarkdownSpan(text: markdown)])]
        var writer = Writer()
        for block in blocks { writer.write(block, indent: 0) }
        return writer.finish()
    }

    /// RTF data of `attributed(fromMarkdown:)` via `rtf(from:documentAttributes:)`; nil only when that fails
    public static func rtf(fromMarkdown markdown: String) -> Data? {
        let string = attributed(fromMarkdown: markdown)
        return string.rtf(
            from: NSRange(location: 0, length: string.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
    }

    /// Indent per list level or quote.
    private static let step: CGFloat = 24

    private struct Writer {
        let out = NSMutableAttributedString()
        let size = NSFont.systemFontSize

        mutating func write(_ block: MarkdownBlock, indent: CGFloat, marker: String? = nil) {
            switch block {
            case .heading(let level, let spans):
                let scale: CGFloat = [2.0, 1.6, 1.3][safe: level - 1] ?? 1.1
                paragraph(spans, size: size * scale, bold: true, indent: indent, marker: marker)
            case .paragraph(let spans):
                paragraph(spans, size: size, bold: false, indent: indent, marker: marker)
            case .code(_, let text):
                var body = text
                if body.hasSuffix("\n") { body.removeLast() }
                let span = MarkdownSpan(text: body, code: true)
                paragraph([span], size: size, bold: false, indent: indent, marker: marker)
            case .list(let ordered, let start, let items):
                for (offset, item) in items.enumerated() {
                    let mark = ordered ? "\(start + offset).\t" : "•\t"
                    let inner = indent + step
                    guard let first = item.first else {
                        paragraph([], size: size, bold: false, indent: inner, marker: mark)
                        continue
                    }
                    switch first {
                    case .paragraph, .heading, .code:
                        write(first, indent: inner, marker: mark)
                    default:
                        paragraph([], size: size, bold: false, indent: inner, marker: mark)
                        write(first, indent: inner)
                    }
                    for rest in item.dropFirst() { write(rest, indent: inner) }
                }
            case .quote(let blocks):
                for (index, child) in blocks.enumerated() {
                    write(child, indent: indent + step, marker: index == 0 ? marker : nil)
                }
            case .rule:
                let start = out.length
                out.append(NSAttributedString(string: "———\n", attributes: [.font: font(size: size)]))
                let style = paragraphStyle(indent: indent, marker: false)
                style.alignment = .center
                out.addAttribute(.paragraphStyle, value: style, range: NSRange(location: start, length: out.length - start))
            case .table(let rows):
                for row in rows {
                    var spans: [MarkdownSpan] = []
                    for (index, cell) in row.cells.enumerated() {
                        if index > 0 { spans.append(MarkdownSpan(text: "\t")) }
                        spans += cell
                    }
                    paragraph(spans, size: size, bold: row.header, indent: indent, marker: nil)
                }
            }
        }

        /// One paragraph: its runs, then "\n", the whole range under one paragraph style.
        private func paragraph(_ spans: [MarkdownSpan], size: CGFloat, bold: Bool, indent: CGFloat, marker: String?) {
            let start = out.length
            if let marker {
                out.append(NSAttributedString(string: marker, attributes: [.font: font(size: size, bold: bold)]))
            }
            for span in spans {
                var attributes: [NSAttributedString.Key: Any] = [
                    .font: span.code
                        ? NSFont.monospacedSystemFont(ofSize: size, weight: bold || span.strong ? .bold : .regular)
                        : font(size: size, bold: bold || span.strong, italic: span.emphasis)
                ]
                if span.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if let link = span.link { attributes[.link] = link }
                out.append(NSAttributedString(string: span.lineBreak ? "\u{2028}" : span.text, attributes: attributes))
            }
            out.append(NSAttributedString(string: "\n", attributes: [.font: font(size: size, bold: bold)]))
            let style = paragraphStyle(indent: indent, marker: marker != nil)
            out.addAttribute(.paragraphStyle, value: style, range: NSRange(location: start, length: out.length - start))
        }

        /// A list item's marker hangs one step left of its text, which a tab stop at `indent` lines up.
        private func paragraphStyle(indent: CGFloat, marker: Bool) -> NSMutableParagraphStyle {
            let style = NSMutableParagraphStyle()
            style.headIndent = indent
            style.firstLineHeadIndent = marker ? max(indent - RichTextRTF.step, 0) : indent
            style.tabStops = marker ? [NSTextTab(textAlignment: .left, location: indent)] : []
            if marker { style.defaultTabInterval = RichTextRTF.step }
            style.paragraphSpacing = size * 0.5
            return style
        }

        private func font(size: CGFloat, bold: Bool = false, italic: Bool = false) -> NSFont {
            let base = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
            guard italic else { return base }
            let traits = base.fontDescriptor.symbolicTraits.union(.italic)
            return NSFont(descriptor: base.fontDescriptor.withSymbolicTraits(traits), size: size) ?? base
        }

        func finish() -> NSAttributedString {
            if out.string.hasSuffix("\n") {
                out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1))
            }
            return NSAttributedString(attributedString: out)
        }
    }
}

extension Array {
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
