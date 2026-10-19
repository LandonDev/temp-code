import SwiftUI
import TempCodeClient
import TempCodeContract

/// The research board: the report pin on top, then one section per angle
/// with its queries and the sources they surfaced beneath.
struct SourcesView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    let document: String?

    var body: some View {
        let board = ResearchBoard.fold(thread.fold.board.sources)
        let angles = ResearchBoard.mergeAngles(board, agents: thread.fold.board.agents)
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let report = text.isEmpty ? nil : PlanDoc.report(document ?? "")
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let report {
                    ReportPin(sessionId: sessionId, report: report)
                }
                if angles.isEmpty, report == nil {
                    HStack {
                        Spacer()
                        Text("No sources yet")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.top, 40)
                }
                ForEach(Array(angles.enumerated()), id: \.element.id) { index, angle in
                    AngleSection(angle: angle, index: index, title: client.session(angle.agentId)?.title)
                }
            }
            .padding(.bottom, 16)
        }
    }
}

private struct ReportPin: View {
    let sessionId: String
    let report: Report

    var body: some View {
        NavigationLink(value: ReportRoute(sessionId: sessionId, title: report.title ?? "Report", body: report.body)) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.subheadline)
                    .foregroundStyle(Tint.cyan)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(report.title ?? "Report")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                    Text(report.isComplete ? "Complete" : report.status.map { $0.replacingOccurrences(of: "-", with: " ").capitalized } ?? "In progress")
                        .font(.footnote)
                        .foregroundStyle(report.isComplete ? Tint.success : Color(.secondaryLabel))
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
    }
}

private struct AngleSection: View {
    let angle: ResearchAngle
    let index: Int
    let title: String?

    var body: some View {
        SectionHeader(angle.label.isEmpty ? (title ?? "ResearchAngle \(index + 1)") : angle.label) {
            if angle.sourceCount > 0 {
                Text("\(angle.sourceCount)")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
        }
        ForEach(Array(angle.queries.enumerated()), id: \.offset) { _, group in
            if let query = group.query {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(width: 20)
                    Text(query)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 32)
            }
            ForEach(group.sources) { source in
                SourceRowView(source: source)
            }
        }
        if angle.queries.isEmpty {
            Text("Nothing boarded yet")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 16)
                .frame(minHeight: 32)
        }
    }
}

/// Favicon, title, domain dim, the claim in one line. Tap opens the page.
private struct SourceRowView: View {
    let source: SourceRow

    var body: some View {
        let host = ResearchBoard.host(of: source.url)
        Group {
            if let url = URL(string: source.url) {
                Link(destination: url) { content(host) }
            } else {
                content(host)
            }
        }
        .buttonStyle(.pressable)
    }

    private func content(_ host: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Favicon(host: host)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                if let title = source.title, !title.isEmpty {
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    if let claim = source.claim, !claim.isEmpty {
                        Text(claim)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else if let claim = source.claim, !claim.isEmpty {
                    Text(claim)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                } else {
                    Text(host)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// The site's icon through the system URL cache, a letter tile until then.
private struct Favicon: View {
    let host: String

    var body: some View {
        let tile = Text(host.prefix(1).uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 20, height: 20)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        if host.isEmpty {
            tile
        } else {
            AsyncImage(url: URL(string: "https://www.google.com/s2/favicons?domain=\(host)&sz=64")) { image in
                image
                    .resizable()
                    .scaledToFit()
                    .frame(width: 20, height: 20)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            } placeholder: {
                tile
            }
        }
    }
}
