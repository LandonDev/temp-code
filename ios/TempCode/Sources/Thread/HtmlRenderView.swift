import SwiftUI
import TempCodeClient
import UIKit
import WebKit

/// A page an agent published with `html_render`, the desktop's
/// `HtmlRenderRow`: the page itself on the transcript, borderless and as
/// wide as the reply, themed from the phone's own colours and as tall as
/// the host measured it (then as the page reports itself). It does not take
/// touches: the transcript scrolls over it and a tap pushes the page full
/// screen, where it scrolls, its links open in Safari and Share hands out
/// the file. A shimmer of the final height holds the place while it loads.
struct HtmlRenderRow: View {
    let render: HtmlRender
    let client: EnvironmentClient
    @Environment(\.colorScheme) private var scheme
    @State private var html: String?
    @State private var failed = false
    @State private var painted = false
    @State private var width: CGFloat = 0
    @State private var contentHeight: CGFloat?

    init(render: HtmlRender, client: EnvironmentClient) {
        self.render = render
        self.client = client
        _html = State(initialValue: HtmlPages.shared.cached(render, client: client))
    }

    private var height: CGFloat {
        CGFloat(render.frameHeight(width: Double(width > 0 ? width : 360), contentHeight: contentHeight.map(Double.init)))
    }

    var body: some View {
        NavigationLink(value: HtmlRenderRoute(render: render)) {
            if failed {
                QuietLine(symbol: "exclamationmark.triangle", text: "Couldn't load \(render.title)")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ZStack(alignment: .top) {
                    if !painted { Shimmer(height: height) }
                    if let html {
                        PageWebView(html: html, render: render, theme: .phone(scheme), interactive: false, onPainted: {
                            withAnimation(Motion.crossFade) { painted = true }
                        }, onContentHeight: { contentHeight = $0 })
                        .opacity(painted ? 1 : 0)
                        .allowsHitTesting(false)
                    }
                }
                .frame(height: height)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.pressableStatic)
        .padding(.vertical, 4)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityLabel(render.title)
        .accessibilityHint("Opens the page")
        .task(id: render) {
            guard html == nil else { return }
            html = await HtmlPages.shared.load(render, client: client)
            failed = html == nil
        }
    }
}

/// The page full screen: it scrolls, its links open in Safari, Share hands
/// out the file the host stored.
struct HtmlRenderScreen: View {
    let render: HtmlRender
    let client: EnvironmentClient
    @Environment(\.colorScheme) private var scheme
    @State private var html: String?
    @State private var failed = false
    @State private var painted = false
    @State private var link: WebPage?

    init(render: HtmlRender, client: EnvironmentClient) {
        self.render = render
        self.client = client
        _html = State(initialValue: HtmlPages.shared.cached(render, client: client))
    }

    var body: some View {
        ZStack {
            if let html {
                PageWebView(html: html, render: render, theme: .phone(scheme), interactive: true, onPainted: {
                    withAnimation(Motion.crossFade) { painted = true }
                }, onLink: { link = WebPage(url: $0) })
                .opacity(painted ? 1 : 0)
                .ignoresSafeArea(edges: .bottom)
            }
            if failed {
                ContentUnavailableView {
                    Label("Couldn't load the page", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            } else if !painted {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Surface.background)
        .navigationTitle(render.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let file = html.flatMap({ HtmlPages.shared.file(for: render, html: $0) }) {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: file)
                }
            }
        }
        .safariCover($link)
        .task(id: render) {
            guard html == nil else { return }
            await load()
        }
    }

    private func load() async {
        failed = false
        html = await HtmlPages.shared.load(render, client: client)
        failed = html == nil
    }
}

/// Pushed from a page row: the thread screen's destination.
struct HtmlRenderRoute: Hashable {
    let render: HtmlRender
}

// MARK: - the pages

/// Every page fetched this launch, by host and page: the row and the full
/// screen read one copy, and a page scrolled back into view paints at once.
/// The host's `/asset/page/…` mirror answers the key, as an image does.
@MainActor
final class HtmlPages {
    static let shared = HtmlPages()
    private let cache = NSCache<NSString, NSString>()
    private var files: [String: URL] = [:]

    private init() {
        cache.countLimit = 40
        cache.totalCostLimit = 16 * 1024 * 1024
    }

    private func key(_ render: HtmlRender, _ client: EnvironmentClient) -> String {
        "\(client.environment.id)/\(render.sessionId)/\(render.pageId)"
    }

    func cached(_ render: HtmlRender, client: EnvironmentClient) -> String? {
        cache.object(forKey: key(render, client) as NSString) as String?
    }

    func load(_ render: HtmlRender, client: EnvironmentClient) async -> String? {
        if let hit = cached(render, client: client) { return hit }
        guard let request = client.assetRequest(host: "page", path: render.assetPath),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        let html = String(decoding: data, as: UTF8.self)
        cache.setObject(html as NSString, forKey: key(render, client) as NSString, cost: data.count)
        return html
    }

    /// The page as a file named after its title, written once, for Share.
    func file(for render: HtmlRender, html: String) -> URL? {
        if let url = files[render.pageId] { return url }
        let dir = FileManager.default.temporaryDirectory.appending(path: "pages/\(render.pageId)")
        let url = dir.appending(path: render.fileName)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(html.utf8).write(to: url)
        } catch {
            return nil
        }
        files[render.pageId] = url
        return url
    }
}

// MARK: - the web view

extension HtmlRenderTheme {
    /// The phone's colours as the page's variables: the transcript's
    /// background, the label colour, the system tints.
    static func phone(_ scheme: ColorScheme) -> HtmlRenderTheme {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        func css(_ color: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return "rgb(\(Int((r * 255).rounded())) \(Int((g * 255).rounded())) \(Int((b * 255).rounded())))"
        }
        let tokens = Tokens(
            background: css(.systemBackground), foreground: css(.label), accent: css(.systemBlue), link: css(.link),
            success: css(.systemGreen), warning: css(.systemOrange), danger: css(.systemRed), info: css(.systemBlue),
            violet: css(.systemPurple), cyan: css(.systemCyan), busy: css(.systemPink)
        )
        return HtmlRenderTheme(tokens: tokens, dark: scheme == .dark)
    }
}

/// A page in a WKWebView of its own: no shared cookies or storage, an
/// origin no host answers (the page is the agent's, never the host's), the
/// theme in the URL fragment the page's bootstrap reads before first paint
/// and in a message when the appearance changes. Inline it reports its
/// content height and never scrolls; full screen it scrolls and hands its
/// links out.
private struct PageWebView: UIViewRepresentable {
    let html: String
    let render: HtmlRender
    let theme: HtmlRenderTheme
    let interactive: Bool
    var onPainted: () -> Void = {}
    var onContentHeight: (CGFloat) -> Void = { _ in }
    var onLink: (URL) -> Void = { _ in }

    /// The bootstrap measures a framed page; a top-level page measures itself here, the same way.
    private static let sizeScript = """
    (function(){var h,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.webkit.messageHandlers.tcSize.postMessage(v);};if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);if(document.body)o.observe(document.body);}window.addEventListener("load",z);z();})();
    """

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if !interactive {
            configuration.userContentController.add(WeakHandler(context.coordinator), name: "tcSize")
            configuration.userContentController.addUserScript(WKUserScript(source: Self.sizeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = interactive
        view.scrollView.contentInsetAdjustmentBehavior = interactive ? .automatic : .never
        view.allowsLinkPreview = interactive
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.theme = theme
        view.loadHTMLString(html, baseURL: baseURL)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.theme != theme else { return }
        context.coordinator.theme = theme
        view.evaluateJavaScript(theme.updateScript)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "tcSize")
    }

    private var baseURL: URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "page.temp-code.invalid"
        components.path = "/\(render.assetPath)"
        components.percentEncodedFragment = String(theme.fragment.dropFirst())
        return components.url
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: PageWebView
        var theme: HtmlRenderTheme?

        init(_ parent: PageWebView) {
            self.parent = parent
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.onPainted()
        }

        // The page's own load is the only navigation; a link opens in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.navigationType == .linkActivated, let url = action.request.url {
                if ["http", "https"].contains(url.scheme ?? "") { parent.onLink(url) }
                return .cancel
            }
            return action.targetFrame?.isMainFrame == false || action.navigationType == .other ? .allow : .cancel
        }

        // The bootstrap gives a top-level page's links target=_blank.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { parent.onLink(url) }
            return nil
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let height = message.body as? Double, height.isFinite, height > 0 { parent.onContentHeight(CGFloat(height)) }
        }
    }

    /// The content controller holds its handler strongly; the coordinator must not be held by it.
    @MainActor
    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: (any WKScriptMessageHandler)?

        init(_ target: any WKScriptMessageHandler) {
            self.target = target
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }
}
