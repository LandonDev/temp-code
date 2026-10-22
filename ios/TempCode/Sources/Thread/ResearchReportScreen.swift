import SwiftUI
import TempCodeClient

/// The report, full screen, set as a document: the title, its state and
/// summary as the lede, the body at reading measure through the phone's one
/// markdown renderer with `[n]` citations as tappable superscripts, and the
/// sources list as reading-list rows. A citation or a link opens its page in
/// the app. The document keeps streaming while it is open.
struct ResearchReportScreen: View {
    let sessionId: String
    let document: String
    let board: ResearchBoard
    let running: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.markdownScope) private var scope
    @State private var page: WebPage?

    var body: some View {
        let report = PlanDoc.report(document)
        let citations = ReportCitations.index(body: report.body, board: board)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ReportLede(report: report, running: running, sources: citations.count)
                    ReportBody(markdown: report.body, title: report.title, citations: citations, scope: scope, sessionId: sessionId) { page = WebPage(url: $0) }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Surface.background)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .tcNavigationBar(visible: false)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .font(.subheadline.weight(.semibold))
                }
            }
            .environment(\.openURL, OpenURLAction { url in
                if url.scheme == ReportCitations.scheme, let number = Int(url.host() ?? ""), let cited = citations[number], let target = URL(string: cited.url) {
                    page = WebPage(url: target)
                    return .handled
                }
                if url.scheme == "http" || url.scheme == "https" {
                    page = WebPage(url: url)
                    return .handled
                }
                return .systemAction
            })
            .safariCover($page)
        }
    }
}

/// The title at document size, its state beside how many sources it cites,
/// and the summary as a lede, over a hairline. The title is shown here and
/// nowhere else on the screen.
private struct ReportLede: View {
    let report: Report
    let running: Bool
    let sources: Int

    var body: some View {
        let cited = sources > 0 ? "\(sources) source\(sources == 1 ? "" : "s")" : nil
        VStack(alignment: .leading, spacing: 8) {
            Text(report.title ?? "Report")
                .font(.title.weight(.bold))
                .tracking(-0.5)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                ReportState(mark: report.isComplete ? .dot(Tint.success) : running ? .spinner : .dot(Color(.tertiaryLabel)), text: report.isComplete ? "Complete" : "In progress")
                if let cited {
                    HStack(spacing: 4) {
                        MetaGlyph("link", label: "Sources")
                        Text(cited)
                            .textStep(.meta)
                            .numeric(cited)
                    }
                }
            }
            if let summary = report.summary, !summary.isEmpty {
                Text(summary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 16)
        .overlay(alignment: .bottom) { Hairline() }
        .padding(.bottom, 12)
    }
}

/// The body through the transcript's block renderer, after the citation
/// pass has linked every marker and this screen has styled the runs; the
/// list under the sources heading becomes reading-list rows.
private struct ReportBody: View {
    let markdown: String
    let title: String?
    let citations: [Int: Citation]
    let scope: MarkdownScope
    let sessionId: String
    let open: (URL) -> Void

    var body: some View {
        let document = ThreadCaches.markdown.document(scope: scope, seq: ThreadCaches.documentSeq(sessionId) - 1, text: markdown) ?? MarkdownDocument.parse(markdown)
        let decorated = ReportStyle.superscripts(ReportCitations.decorate(document, citations: citations))
        let pieces = ReportLayout.pieces(decorated.blocks, title: title, listed: ReportCitations.sourcesList(markdown))
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .blocks(let blocks):
                    MarkdownBlocksView(document: MarkdownDocument(blocks: blocks, textHash: decorated.textHash))
                case .sources(let cited):
                    VStack(spacing: 0) {
                        ForEach(Array(cited.enumerated()), id: \.offset) { offset, citation in
                            CitationRow(citation: citation, divided: offset > 0, open: open)
                        }
                    }
                    .padding(.horizontal, -4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Links in a Text draw in the tint: the research cyan, for the superscripts and the prose's own links alike.
        .tint(Tint.cyan)
    }
}

/// How this screen styles the citation runs the pass linked by scheme: a
/// resolved number is a cyan semibold superscript that opens its page; a
/// number the report never lists is the same superscript, dim, with no link.
enum ReportStyle {
    static func superscripts(_ document: MarkdownDocument) -> MarkdownDocument {
        let blocks = document.blocks.map { block -> RenderedBlock in
            switch block {
            case .paragraph(let text): .paragraph(style(text))
            case .heading(let level, let text): .heading(level, style(text))
            case .list(let items, let ordered): .list(items.map(style), ordered: ordered)
            case .quote(let text): .quote(style(text))
            default: block
            }
        }
        return MarkdownDocument(blocks: blocks, textHash: document.textHash)
    }

    private static func style(_ text: AttributedString) -> AttributedString {
        var styled = text
        let marks = styled.runs.compactMap { run -> (Range<AttributedString.Index>, Bool)? in
            switch run.link?.scheme {
            case ReportCitations.scheme?: (run.range, true)
            case ReportCitations.missingScheme?: (run.range, false)
            default: nil
            }
        }
        for (range, resolved) in marks {
            // Scoped to SwiftUI's attributes: UIKit's scope names font, baselineOffset and foregroundColor too.
            styled[range].swiftUI.font = .caption.weight(.semibold)
            styled[range].swiftUI.baselineOffset = 4
            styled[range].swiftUI.foregroundColor = resolved ? Tint.cyan : Color(.tertiaryLabel)
            if !resolved { styled[range].link = nil }
        }
        return styled
    }
}

/// A listed source as the board's row: the number, the icon, the title and
/// the domain. Tap opens the page in the app; hold for the link.
private struct CitationRow: View {
    let citation: Citation
    let divided: Bool
    let open: (URL) -> Void
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = Layout.glyphWidth

    var body: some View {
        let host = ResearchBoard.host(of: citation.url)
        let url = URL(string: citation.url)
        Button {
            if let url { open(url) }
        } label: {
            HStack(alignment: .top, spacing: Layout.rowGap) {
                Text("\(citation.number)")
                    .textStep(.stamp, weight: .semibold)
                    .frame(minWidth: 16, alignment: .trailing)
                    .padding(.top, 2)
                SiteIcon(host: host)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(citation.title ?? (host.isEmpty ? citation.url : host))
                        .textStep(.title)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if citation.title != nil, !host.isEmpty {
                        Text(host)
                            .textStep(.stamp)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) {
                if divided {
                    Hairline(inset: 4 + 16 + Layout.rowGap + icon + Layout.rowGap)
                }
            }
        }
        .buttonStyle(.pressable)
        .disabled(url == nil)
        .contextMenu {
            Button("Copy Link", systemImage: "link") { UIPasteboard.general.string = citation.url }
            if let url {
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
            }
        }
        .accessibilityLabel("Source \(citation.number), \(citation.title ?? host)")
        .accessibilityHint("Opens the page")
    }
}
