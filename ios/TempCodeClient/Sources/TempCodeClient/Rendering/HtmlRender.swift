import Foundation
import TempCodeContract

/// A page an agent published into the thread with the `html_render` app
/// tool, the desktop's `HtmlRenderReference` (src/shared/htmlRender.ts):
/// the host keeps it under `/asset/page/<sessionId>/<pageId>.html`, the
/// phone loads it with its key and shows it as a row of its own.
public struct HtmlRender: Hashable, Sendable {
    public var sessionId: String
    public var pageId: String
    public var title: String
    /// The agent's frame height in CSS pixels, and the cap on any measured height.
    public var height: Int
    /// `(width, contentHeight)` pairs the host measured at publish, ascending by width.
    public var heights: [Measured]

    public struct Measured: Hashable, Sendable {
        public var width: Int
        public var height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    public init(sessionId: String, pageId: String, title: String, height: Int, heights: [Measured] = []) {
        self.sessionId = sessionId
        self.pageId = pageId
        self.title = title
        self.height = height
        self.heights = heights
    }

    public static let toolName = "html_render"
    public static let minHeight = 80
    public static let maxHeight = 2_000
    /// The desktop's reply column: an agent sizes its frame for this width.
    public static let columnWidth = 864

    /// The page's path under the host's `/asset/` mirror, for `EnvironmentClient.assetRequest(host: "page", …)`.
    public var assetPath: String { "\(sessionId)/\(pageId).html" }

    /// The frame height at `width`, `htmlRenderFrameHeight`: the page's own
    /// `contentHeight` when the view has one, else the host's measurement
    /// for that width; the agent's height caps it only when it asked for a
    /// scrolling frame (below the page's height at the column width) or the
    /// page was never measured.
    public func frameHeight(width: Double, contentHeight: Double? = nil) -> Int {
        guard !heights.isEmpty else {
            return Self.clamp(min(Double(height), contentHeight ?? Double(height)))
        }
        let cap = measuredHeight(width: Double(Self.columnWidth)) > height ? height : Self.maxHeight
        return Self.clamp(min(Double(cap), contentHeight ?? Double(measuredHeight(width: width))))
    }

    /// The taller of the heights measured at the nearest widths on each side.
    func measuredHeight(width: Double) -> Int {
        let above = heights.firstIndex { Double($0.width) >= width }
        let high = above ?? heights.count - 1
        let low = Double(heights[high].width) == width ? high : max(0, high - 1)
        return max(heights[low].height, heights[high].height)
    }

    /// `htmlRenderFileName`: the title without characters file systems refuse, for Share.
    public var fileName: String {
        let name = title
            .replacing(/[\\\/:*?"<>|\p{Cc}]+/, with: " ")
            .replacing(/\s+/, with: " ")
            .trimmingCharacters(in: .whitespaces)
        let short = String(name.prefix(120)).trimmingCharacters(in: .whitespaces)
        return "\(short.isEmpty ? "Page" : short).html"
    }

    static func clamp(_ value: Double) -> Int {
        min(maxHeight, max(minHeight, Int(value.rounded())))
    }

    // MARK: reading

    /// A completed `html_render` call's page, `htmlRenderOf`: nil for any
    /// other tool, a call still running or failed, or a result that names no page.
    public static func of(_ tool: ToolItem) -> HtmlRender? {
        guard tool.status == .done, shortName(tool.name) == toolName, case .whole(let text) = tool.output,
              let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let fields)? = unwrap(value), let reference = fields["htmlRender"]
        else { return nil }
        return read(reference)
    }

    /// `mcp__app__html_render` and `app.html_render` are both `html_render`.
    static func shortName(_ name: String) -> String {
        var short = name.replacing(/^mcp__[^_]+(?:__)?/, with: "")
        if let dot = short.lastIndex(of: ".") { short = String(short[short.index(after: dot)...]) }
        return short
    }

    /// The result object, whichever envelope the harness stored it in: the
    /// object itself, or codex's MCP result (structuredContent, or a text part holding the JSON).
    static func unwrap(_ value: JSONValue) -> JSONValue? {
        guard case .object(let fields) = value else { return nil }
        if fields["htmlRender"] != nil { return value }
        if case .object(let structured)? = fields["structuredContent"], structured["htmlRender"] != nil {
            return .object(structured)
        }
        if case .array(let parts)? = fields["content"] {
            for part in parts {
                guard case .object(let p) = part, p["type"] == .string("text"), case .string(let text)? = p["text"],
                      let data = text.data(using: .utf8),
                      let inner = try? JSONDecoder().decode(JSONValue.self, from: data)
                else { continue }
                return unwrap(inner)
            }
        }
        return nil
    }

    /// `readHtmlRenderReference`: ids the host could have made, a title, a finite height.
    static func read(_ value: JSONValue) -> HtmlRender? {
        guard case .object(let fields) = value,
              case .string(let sessionId)? = fields["sessionId"], validId(sessionId),
              case .string(let pageId)? = fields["pageId"], validId(pageId),
              case .string(let rawTitle)? = fields["title"],
              case .number(let height)? = fields["height"], height.isFinite
        else { return nil }
        let title = String(rawTitle.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return HtmlRender(sessionId: sessionId, pageId: pageId, title: title.isEmpty ? "HTML" : title, height: clamp(height), heights: measured(fields["heights"]))
    }

    private static func validId(_ id: String) -> Bool {
        id.wholeMatch(of: /[A-Za-z0-9_-]{1,64}/) != nil
    }

    /// Every pair valid, or none: a half-read list would size the frame wrong.
    private static func measured(_ value: JSONValue?) -> [Measured] {
        guard case .array(let entries)? = value, !entries.isEmpty, entries.count <= 24 else { return [] }
        var out: [Measured] = []
        for entry in entries {
            guard case .array(let pair) = entry, pair.count == 2,
                  case .number(let width) = pair[0], width == width.rounded(), width >= 1, width <= 10_000,
                  case .number(let height) = pair[1], height.isFinite
            else { return [] }
            out.append(Measured(width: Int(width), height: clamp(height)))
        }
        return out.sorted { $0.width < $1.width }
    }
}

// MARK: - theme

/// The variables a page styles against, `htmlRenderTheme`, built from the
/// phone's own colours so a page sits on the transcript as it does on the
/// desktop's thread. Colours are CSS strings the app resolves from its tokens.
public struct HtmlRenderTheme: Hashable, Sendable {
    public struct Tokens: Hashable, Sendable {
        public var background, foreground, accent, link, success, warning, danger, info, violet, cyan, busy: String

        public init(background: String, foreground: String, accent: String, link: String, success: String, warning: String, danger: String, info: String, violet: String, cyan: String, busy: String) {
            self.background = background
            self.foreground = foreground
            self.accent = accent
            self.link = link
            self.success = success
            self.warning = warning
            self.danger = danger
            self.info = info
            self.violet = violet
            self.cyan = cyan
            self.busy = busy
        }
    }

    public var dark: Bool
    /// In the order the desktop sets them.
    public var variables: [(String, String)]

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.dark == rhs.dark && lhs.variables.elementsEqual(rhs.variables) { $0 == $1 }
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(dark)
        for (name, value) in variables {
            hasher.combine(name)
            hasher.combine(value)
        }
    }

    static let fontSans = "-apple-system, system-ui, \"Helvetica Neue\", sans-serif"
    static let fontMono = "ui-monospace, SFMono-Regular, Menlo, monospace"

    public init(tokens t: Tokens, dark: Bool) {
        func mix(_ colour: String, _ percent: Int, over: String = "transparent") -> String {
            "color-mix(in srgb, \(colour) \(percent)%, \(over))"
        }
        self.dark = dark
        variables = [
            ("--background", t.background),
            ("--foreground", t.foreground),
            ("--muted", mix(t.foreground, 6)),
            ("--muted-foreground", mix(t.foreground, 55)),
            ("--card", mix(t.foreground, 4, over: t.background)),
            ("--card-foreground", t.foreground),
            ("--border", mix(t.foreground, 10)),
            ("--input", mix(t.foreground, 10)),
            ("--ring", t.accent),
            ("--primary", t.foreground),
            ("--primary-foreground", t.background),
            ("--accent", t.accent),
            ("--accent-foreground", "#fff"),
            ("--link", t.link),
            ("--destructive", t.danger),
            ("--warning", t.warning),
            ("--success", t.success),
            ("--info", t.info),
            ("--code-background", mix(t.foreground, 6)),
            ("--chart-1", t.accent),
            ("--chart-2", t.cyan),
            ("--chart-3", t.violet),
            ("--chart-4", t.warning),
            ("--chart-5", t.success),
            ("--chart-6", t.busy),
            ("--radius", "10px"),
            ("--font-sans", Self.fontSans),
            ("--font-mono", Self.fontMono),
        ]
    }

    private var appearance: String { dark ? "dark" : "light" }

    private var variablesJSON: String {
        "{" + variables.map { "\(Self.quote($0.0)):\(Self.quote($0.1))" }.joined(separator: ",") + "}"
    }

    /// `htmlRenderThemeFragment`: the page's bootstrap reads it before first paint.
    public var fragment: String {
        let json = "{\"appearance\":\"\(appearance)\",\"variables\":\(variablesJSON)}"
        return "#tc-theme=" + (json.addingPercentEncoding(withAllowedCharacters: Self.fragmentSafe) ?? "")
    }

    /// `htmlRenderThemeMessage` as a script: a loaded page takes a new appearance without a reload.
    public var updateScript: String {
        "window.postMessage({jsonrpc:\"2.0\",method:\"ui/notifications/host-context-changed\",params:{theme:\"\(appearance)\",styles:{variables:\(variablesJSON)}}},\"*\")"
    }

    /// encodeURIComponent's set.
    private static let fragmentSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    private static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

extension ToolItem {
    /// The page a completed `html_render` call published.
    public var htmlRender: HtmlRender? { HtmlRender.of(self) }
}
