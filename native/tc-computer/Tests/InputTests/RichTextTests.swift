#if canImport(AppKit)
import AppKit
import Testing
@testable import Input

// MARK: markdown → HTML

@Test(arguments: 1...6)
func headingLevels(level: Int) {
    let hashes = String(repeating: "#", count: level)
    #expect(MarkdownHTML.html(fromMarkdown: "\(hashes) Title") == "<h\(level)>Title</h\(level)>")
}

@Test func inlineStyles() {
    let md = "Hi **strong** *em* `code` ~~gone~~ [link](https://example.com/a?b=1&c=2)."
    #expect(MarkdownHTML.html(fromMarkdown: md) == """
        <p>Hi <strong>strong</strong> <em>em</em> <code>code</code> <del>gone</del> \
        <a href="https://example.com/a?b=1&amp;c=2">link</a>.</p>
        """)
}

@Test func unorderedList() {
    #expect(MarkdownHTML.html(fromMarkdown: "- a\n- b") == "<ul><li>a</li><li>b</li></ul>")
}

@Test func orderedList() {
    #expect(MarkdownHTML.html(fromMarkdown: "1. a\n2. b") == "<ol><li>a</li><li>b</li></ol>")
    #expect(MarkdownHTML.html(fromMarkdown: "3. c\n4. d") == "<ol start=\"3\"><li>c</li><li>d</li></ol>")
}

@Test func nestedList() {
    #expect(MarkdownHTML.html(fromMarkdown: "1. a\n   - x\n   - y\n2. b")
        == "<ol><li>a<ul><li>x</li><li>y</li></ul></li><li>b</li></ol>")
}

@Test func codeBlocks() {
    #expect(MarkdownHTML.html(fromMarkdown: "```swift\nlet x = <tag>\n```")
        == "<pre><code class=\"language-swift\">let x = &lt;tag&gt;\n</code></pre>")
    #expect(MarkdownHTML.html(fromMarkdown: "```\n<tag> & \"q\"\n```")
        == "<pre><code>&lt;tag&gt; &amp; &quot;q&quot;\n</code></pre>")
}

@Test func blockQuote() {
    #expect(MarkdownHTML.html(fromMarkdown: "> quoted *text*")
        == "<blockquote><p>quoted <em>text</em></p></blockquote>")
}

@Test func thematicBreak() {
    #expect(MarkdownHTML.html(fromMarkdown: "a\n\n---\n\nb") == "<p>a</p><hr><p>b</p>")
}

@Test func scriptIsEscaped() {
    #expect(MarkdownHTML.html(fromMarkdown: "<script>alert(1)</script>")
        == "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")
    #expect(MarkdownHTML.html(fromMarkdown: "Say <script>x</script> now")
        == "<p>Say &lt;script&gt;x&lt;/script&gt; now</p>")
}

@Test func lineBreakAndTable() {
    #expect(MarkdownHTML.html(fromMarkdown: "line\\\nbreak") == "<p>line<br>break</p>")
    #expect(MarkdownHTML.html(fromMarkdown: "| a | b |\n|---|---|\n| 1 | 2 |")
        == "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>")
}

@Test func noStyleAttributes() {
    let html = MarkdownHTML.html(fromMarkdown: "# h\n\n- **a**\n\n> b\n\n```js\nc\n```")
    #expect(!html.contains("style"))
    #expect(!html.contains("<html") && !html.contains("<body"))
}

// MARK: RTF

@Test func rtfCarriesBold() throws {
    let data = try #require(RichTextRTF.rtf(fromMarkdown: "plain **bold** end"))
    #expect(!data.isEmpty)
    let back = try #require(NSAttributedString(rtf: data, documentAttributes: nil))
    let text = back.string.trimmingCharacters(in: .newlines)
    #expect(text == "plain bold end")
    let nsText = back.string as NSString
    func isBold(_ word: String) -> Bool {
        let range = nsText.range(of: word)
        let font = back.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont
        return font?.fontDescriptor.symbolicTraits.contains(.bold) == true
    }
    #expect(isBold("bold"))
    #expect(!isBold("plain"))
}

@Test func attributedListsAndCode() throws {
    let string = RichTextRTF.attributed(fromMarkdown: "1. one\n   - inner\n2. two\n\n`x`")
    #expect(string.string == "1.\tone\n•\tinner\n2.\ttwo\nx")
    let ns = string.string as NSString
    let inner = try #require(string.attribute(.paragraphStyle, at: ns.range(of: "inner").location, effectiveRange: nil) as? NSParagraphStyle)
    let outer = try #require(string.attribute(.paragraphStyle, at: ns.range(of: "one").location, effectiveRange: nil) as? NSParagraphStyle)
    #expect(inner.headIndent > outer.headIndent)
    #expect(inner.tabStops.first?.location == inner.headIndent)
    let code = try #require(string.attribute(.font, at: ns.range(of: "x").location, effectiveRange: nil) as? NSFont)
    #expect(code.fontDescriptor.symbolicTraits.contains(.monoSpace))
}

@Test func attributedHeadingAndLink() throws {
    let string = RichTextRTF.attributed(fromMarkdown: "# Big\n\n[l](https://example.com) ~~s~~")
    let ns = string.string as NSString
    let heading = try #require(string.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
    #expect(heading.pointSize == NSFont.systemFontSize * 2)
    #expect(heading.fontDescriptor.symbolicTraits.contains(.bold))
    let link = string.attribute(.link, at: ns.range(of: "l").location, effectiveRange: nil) as? URL
    #expect(link?.absoluteString == "https://example.com")
    let strike = string.attribute(.strikethroughStyle, at: ns.range(of: "s").location, effectiveRange: nil) as? Int
    #expect(strike == NSUnderlineStyle.single.rawValue)
}

@Test func attributedOffMain() async {
    let length = await Task.detached { RichTextRTF.rtf(fromMarkdown: "*a* **b**")?.count ?? 0 }.value
    #expect(length > 0)
}

// MARK: HTML → plain text

@Test func plainTextBlocks() {
    #expect(MarkdownHTML.plainText(fromHTML: "<p>a &amp; b</p><p>c<br>d</p>") == "a & b\nc\nd")
    #expect(MarkdownHTML.plainText(fromHTML: "<ul><li>x</li><li>y</li></ul>") == "x\ny")
}

@Test func plainTextEntities() {
    #expect(MarkdownHTML.plainText(fromHTML: "it&#39;s it&#x27;s a&nbsp;b &lt;&gt;&quot;&apos;")
        == "it's it's a\u{00A0}b <>\"'")
}

@Test func plainTextRoundTrip() {
    let html = MarkdownHTML.html(fromMarkdown: "# T\n\nOne & *two*\n\n- x\n- y")
    #expect(MarkdownHTML.plainText(fromHTML: html) == "T\nOne & two\nx\ny")
}
#endif
