import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct HtmlRenderTests {
    private let reference = #"{"sessionId":"s1","pageId":"p1234567890abcde","title":"Chart","height":420}"#
    private var result: String { #"{"htmlRender":\#(reference),"message":"Shown above your reply."}"# }
    private let expected = HtmlRender(sessionId: "s1", pageId: "p1234567890abcde", title: "Chart", height: 420)

    private func call(_ name: String, _ output: String?, status: ToolItem.Status = .done, seq: Int = 2) -> ToolItem {
        ToolItem(seq: seq, ts: 1_000, callId: "c\(seq)", name: name, display: nil, input: nil, partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: output.map { .whole($0) } ?? .none, status: status, reauth: nil, doneTs: status == .running ? nil : 1_100)
    }

    private func quoted(_ text: String) -> String {
        String(data: try! JSONEncoder().encode(text), encoding: .utf8)!
    }

    @Test func `reads the page from each harness's envelope`() {
        #expect(call("mcp__app__html_render", result).htmlRender == expected)
        #expect(call("app.html_render", #"{"content":[{"type":"text","text":\#(quoted(result))}]}"#).htmlRender == expected)
        #expect(call("app.html_render", #"{"structuredContent":\#(result),"content":[]}"#).htmlRender == expected)
    }

    @Test func `ignores other tools, running or failed calls, and malformed results`() {
        #expect(call("mcp__app__html_preview", result).htmlRender == nil)
        #expect(call("mcp__app__html_render", result, status: .running).htmlRender == nil)
        #expect(call("mcp__app__html_render", result, status: .failed).htmlRender == nil)
        #expect(call("mcp__app__html_render", "These local images could not be read").htmlRender == nil)
        #expect(call("mcp__app__html_render", nil).htmlRender == nil)
        #expect(call("mcp__app__html_render", #"{"htmlRender":{"pageId":1}}"#).htmlRender == nil)
        #expect(call("mcp__app__html_render", #"{"htmlRender":{"sessionId":"../x","pageId":"p","title":"T","height":300}}"#).htmlRender == nil)
    }

    @Test func `clamps the height, trims the title and sorts the measured heights`() {
        let page = call("mcp__app__html_render", #"{"htmlRender":{"sessionId":"s","pageId":"p","title":"  ","height":9000,"heights":[[864,300],[320,700]]}}"#).htmlRender
        #expect(page?.title == "HTML")
        #expect(page?.height == HtmlRender.maxHeight)
        #expect(page?.heights == [.init(width: 320, height: 700), .init(width: 864, height: 300)])
        // One bad pair drops the whole list rather than sizing from half of it.
        let bad = call("mcp__app__html_render", #"{"htmlRender":{"sessionId":"s","pageId":"p","title":"T","height":300,"heights":[[320,700],[1.5,2]]}}"#).htmlRender
        #expect(bad?.heights == [])
    }

    @Test func `the file name drops what a file system refuses`() {
        #expect(HtmlRender(sessionId: "s", pageId: "p", title: "Build: a/b  times?", height: 300).fileName == "Build a b times.html")
        #expect(HtmlRender(sessionId: "s", pageId: "p", title: "///", height: 300).fileName == "Page.html")
    }

    @Test func `the frame fits the page at the phone's width`() {
        let measured: [HtmlRender.Measured] = [.init(width: 320, height: 900), .init(width: 400, height: 700), .init(width: 864, height: 420)]
        let page = HtmlRender(sessionId: "s", pageId: "p", title: "T", height: 420, heights: measured)
        // Between two measured widths the taller one wins.
        #expect(page.frameHeight(width: 390) == 900)
        #expect(page.frameHeight(width: 400) == 700)
        // The page's own report wins over the measurement.
        #expect(page.frameHeight(width: 390, contentHeight: 640) == 640)
        // An agent that asked for a scrolling frame keeps its cap.
        let scrolling = HtmlRender(sessionId: "s", pageId: "p", title: "T", height: 300, heights: measured)
        #expect(scrolling.frameHeight(width: 390) == 300)
        // Never measured: the agent's height, or less when the page says so.
        let bare = HtmlRender(sessionId: "s", pageId: "p", title: "T", height: 500)
        #expect(bare.frameHeight(width: 390) == 500)
        #expect(bare.frameHeight(width: 390, contentHeight: 20) == HtmlRender.minHeight)
    }

    @Test func `a published page is a row of its own, never a step in a phase`() {
        let user = item(.user(UserTurn(seq: 1, ts: 1_000, text: "go", attachments: [], model: nil, reasoning: nil, completedTs: nil, costUsd: nil)))
        let read = item(toolItem(2, ts: 1_002, doneTs: 1_010, input: ["file_path": .string("/repo/a.ts")]))
        let page = item(.tool(call("mcp__app__html_render", result, seq: 3)))
        let rows = TranscriptRows.rows([user, read, page], turnOpen: false)
        #expect(rows.map(\.id) == [TranscriptRowID(kind: .item, seq: 1), TranscriptRowID(kind: .group, seq: 2), TranscriptRowID(kind: .item, seq: 3)])
        // While it runs it is ordinary work.
        let running = item(.tool(call("mcp__app__html_render", nil, status: .running, seq: 3)))
        #expect(TranscriptRows.rows([user, read, running], turnOpen: true).map(\.id).prefix(2) == [TranscriptRowID(kind: .item, seq: 1), TranscriptRowID(kind: .group, seq: 2)])
    }

    @Test func `the theme travels as the desktop's fragment and message`() throws {
        let tokens = HtmlRenderTheme.Tokens(background: "rgb(0 0 0)", foreground: "rgb(255 255 255)", accent: "#0a84ff", link: "#64d2ff", success: "#30d158", warning: "#ff9f0a", danger: "#ff453a", info: "#0a84ff", violet: "#bf5af2", cyan: "#64d2ff", busy: "#ff375f")
        let theme = HtmlRenderTheme(tokens: tokens, dark: true)
        #expect(theme.variables.count == 28)
        #expect(theme.variables.first { $0.0 == "--card" }?.1 == "color-mix(in srgb, rgb(255 255 255) 4%, rgb(0 0 0))")
        #expect(theme.fragment.hasPrefix("#tc-theme=%7B%22appearance%22%3A%22dark%22"))
        let json = try #require(String(theme.fragment.dropFirst("#tc-theme=".count)).removingPercentEncoding)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        guard case .object(let fields) = decoded, case .object(let variables)? = fields["variables"] else {
            Issue.record("not an object")
            return
        }
        #expect(variables["--font-mono"] == .string(#"ui-monospace, SFMono-Regular, Menlo, monospace"#))
        #expect(variables["--font-sans"] == .string(#"-apple-system, system-ui, "Helvetica Neue", sans-serif"#))
        #expect(theme.updateScript.contains("ui/notifications/host-context-changed"))
        #expect(HtmlRenderTheme(tokens: tokens, dark: false) != theme)
    }
}
