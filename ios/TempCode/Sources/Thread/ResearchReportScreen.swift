import SwiftUI
import TempCodeClient

/// The report, full screen, set as a document: the title, its state and
/// summary as the lede, the body at reading measure with `[n]` citations as
/// tappable superscripts, and the sources list as reading-list rows. A
/// citation or a link opens its page in the app. The document keeps
/// streaming while it is open.
struct ResearchReportScreen: View {
    let sessionId: String
    let document: String
    let board: ResearchBoard
    let running: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var page: WebPage?

    var body: some View {
        let report = PlanDoc.report(document)
        let citations = ReportCitations.index(body: report.body, board: board)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ReportLede(report: report, running: running, sources: citations.count)
                    ReportBody(markdown: report.body, title: report.title, citations: citations)
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Surface.background)
            .navigationTitle(report.title ?? "Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Surface.background, for: .navigationBar)
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

extension ReportCitations {
    /// The scheme a superscript's link carries; the host is the number.
    static let scheme = "tempcode-cite"
}

/// The title at document size, its state beside how many sources it cites,
/// and the summary as a lede, over a hairline.
private struct ReportLede: View {
    let report: Report
    let running: Bool
    let sources: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(report.title ?? "Report")
                .font(.title2.weight(.bold))
                .tracking(-0.3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                ReportState(mark: report.isComplete ? .dot(Tint.success) : running ? .spinner : .dot(Color(.tertiaryLabel)), text: report.isComplete ? "Complete" : "In progress")
                if sources > 0 {
                    Text("· \(sources) source\(sources == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
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

/// The body's blocks with citations set as superscripts; the list under the
/// sources heading becomes reading-list rows.
private struct ReportBody: View {
    let markdown: String
    let title: String?
    let citations: [Int: Citation]

    var body: some View {
        let blocks = MarkdownBlocks.split(markdown)
        let listed = ReportCitations.sourcesList(markdown)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(Self.layout(blocks, title: title, listed: listed).enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .block(let block):
                    ReportBlock(block: block, citations: citations)
                case .sources(let cited):
                    VStack(spacing: 0) {
                        ForEach(Array(cited.enumerated()), id: \.element.id) { offset, citation in
                            CitationRow(citation: citation, divided: offset > 0)
                        }
                    }
                    .padding(.horizontal, -4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    enum Piece {
        case block(MarkdownBlock)
        case sources([Citation])
    }

    /// Drops a leading H1 that repeats the title, and swaps the one list
    /// under the sources heading for the citations it names when they match
    /// one to one; anything else stays as the agent wrote it.
    static func layout(_ blocks: [MarkdownBlock], title: String?, listed: [Citation]) -> [Piece] {
        var out: [Piece] = []
        var underSources = false
        for (index, block) in blocks.enumerated() {
            switch block {
            case .heading(let level, let text):
                if index == 0, level == 1, let title, text.trimmingCharacters(in: .whitespaces) == title { continue }
                let lower = text.lowercased()
                underSources = lower.hasPrefix("source") || lower.hasPrefix("reference") || lower.hasPrefix("citation")
                out.append(.block(block))
            case .list(let items, _) where underSources && !listed.isEmpty && items.count == listed.count:
                out.append(.sources(listed))
                underSources = false
            default:
                out.append(.block(block))
            }
        }
        return out
    }
}

/// One block of the report at reading size; prose carries its citations.
private struct ReportBlock: View {
    let block: MarkdownBlock
    let citations: [Int: Citation]

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(Self.cited(text, citations: citations))
                .font(.body)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(Self.cited(text, citations: citations))
                .font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, level <= 2 ? 10 : 4)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .frame(minWidth: 16, alignment: .trailing)
                        Text(Self.cited(item, citations: citations))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.body)
            .lineSpacing(2)
        case .code(let code, _):
            CodeBlock(text: code, font: .subheadline, maxLines: 40)
        case .quote(let text):
            Text(Self.cited(text, citations: citations))
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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

    /// Inline markdown with every `[n]` set as a superscript that links to
    /// its citation; a number the report never lists stays a dim superscript.
    static func cited(_ text: String, citations: [Int: Citation]) -> AttributedString {
        var styled = MarkdownBlocks.inline(text).inlineStyled()
        let plain = String(styled.characters)
        for match in plain.matches(of: ReportCitations.marker).reversed() {
            let numbers = ReportCitations.numbers(in: match.1)
            guard !numbers.isEmpty else { continue }
            let start = styled.characters.index(styled.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: match.range.lowerBound))
            let end = styled.characters.index(start, offsetBy: plain.distance(from: match.range.lowerBound, to: match.range.upperBound))
            // `rows[0]` in inline code is an index, not a citation.
            if styled[start..<end].runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            var replacement = AttributedString("\u{2009}")
            for (offset, number) in numbers.enumerated() {
                if offset > 0 { replacement.append(AttributedString(",")) }
                var mark = AttributedString("\(number)")
                mark.font = .caption.weight(.semibold)
                mark.baselineOffset = 4
                if let cited = citations[number] {
                    mark.foregroundColor = Tint.cyan
                    mark.link = URL(string: "\(ReportCitations.scheme)://\(cited.number)")
                } else {
                    mark.foregroundColor = Color(.tertiaryLabel)
                }
                replacement.append(mark)
            }
            styled.replaceSubrange(start..<end, with: replacement)
        }
        return styled
    }
}

/// A listed source as the board's row: icon, title, domain. Tap opens it.
private struct CitationRow: View {
    let citation: Citation
    let divided: Bool
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 20

    var body: some View {
        let host = ResearchBoard.host(of: citation.url)
        Button {
            if let url = URL(string: citation.url) { openURL(url) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text("\(citation.number)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .frame(minWidth: 16, alignment: .trailing)
                    .padding(.top, 2)
                SiteIcon(host: host)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(citation.title ?? (host.isEmpty ? citation.url : host))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if citation.title != nil, !host.isEmpty {
                        Text(host)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) {
                if divided {
                    Hairline().padding(.leading, 4 + 16 + 10 + icon + 10)
                }
            }
        }
        .buttonStyle(.pressable)
        .contextMenu {
            Button("Copy Link", systemImage: "link") { UIPasteboard.general.string = citation.url }
            if let url = URL(string: citation.url) {
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
            }
        }
        .accessibilityLabel("Source \(citation.number), \(citation.title ?? host)")
        .accessibilityHint("Opens the page")
    }
}
