import SwiftUI
import TempCodeClient
import TempCodeContract

/// The research board: the report pin on top as the one raised surface, the
/// coverage line under it, then one section per angle with its queries and
/// the sources they surfaced streaming in beneath, Safari-reading-list rows
/// that open the page in the app. A source arriving after the board has
/// painted travels in 8 pt over 200 ms; counts tick in place.
struct SourcesView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    let document: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page: WebPage?
    @State private var readingReport = false
    /// The first page of rows has painted: what arrives from here on animates in.
    @State private var settled = false

    var body: some View {
        let board = ResearchBoard.fold(thread.fold.board.sources)
        let agents = thread.fold.board.agents
        let angles = ResearchBoard.mergeAngles(board, agents: agents)
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let report = text.isEmpty ? nil : PlanDoc.report(document ?? "")
        let liveAngles = agents.filter { Self.isLive(client.session($0)?.status) }.count
        let coverage = ResearchBoard.coverage(sources: board.sources, searches: board.searches, angles: agents.count, done: agents.count - liveAngles)
        let running = Self.isLive(session?.status)
        let loading = thread.isLoading || thread.isLoadingHistory
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let report {
                    ReportPin(report: report, running: running, liveAngles: liveAngles) { readingReport = true }
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .transition(Motion.appear(reduced: reduceMotion))
                }
                if !coverage.isEmpty {
                    Text(coverage)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .padding(.horizontal, 16)
                        .padding(.top, report == nil ? 12 : 10)
                        .padding(.bottom, 8)
                }
                if angles.isEmpty, report == nil {
                    EmptyBoard(running: running, loading: loading)
                }
                ForEach(Array(angles.enumerated()), id: \.element.id) { index, angle in
                    AngleSection(
                        angle: angle,
                        label: label(for: angle, index: index),
                        live: angle.agentId != sessionId && Self.isLive(client.session(angle.agentId)?.status),
                        animated: settled,
                        onOpen: { page = $0 }
                    )
                }
            }
            .padding(.bottom, 16)
            .animation(settled ? Motion.rowAppear : nil, value: ArrivalKey(sources: thread.fold.board.sources.count, agents: agents.count, live: liveAngles, report: report != nil))
        }
        .safariCover($page)
        .fullScreenCover(isPresented: $readingReport) {
            ResearchReportScreen(sessionId: sessionId, document: document ?? "", board: board, running: running)
        }
        .onAppear {
            // The proof's launch hook: `report` opens the pin, `source` the first page.
            if TestHooks.open == "report" { readingReport = true }
            if TestHooks.open == "source", let first = board.uniqueSources.first, let url = URL(string: first.url) { page = WebPage(url: url) }
        }
        .task(id: loading) {
            // A short rest after the page lands, so history paints in place and only live arrivals travel.
            guard !loading else {
                settled = false
                return
            }
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { settled = true }
        }
    }

    /// The angle's name: the root's own research, else the child's title,
    /// else the label it boarded under, else its place in the fan-out.
    private func label(for angle: ResearchAngle, index: Int) -> String {
        if angle.agentId == sessionId { return "Direct research" }
        if let title = client.session(angle.agentId)?.title, !title.isEmpty { return title }
        return angle.label.isEmpty ? "Angle \(index + 1)" : angle.label
    }

    static func isLive(_ status: SessionStatus?) -> Bool {
        status == .running || status == .starting || status == .waiting
    }

    /// What a change in it means something new is on the board.
    private struct ArrivalKey: Equatable {
        var sources: Int
        var agents: Int
        var live: Int
        var report: Bool
    }
}

// MARK: - the report pin

/// The deliverable, pinned: title, its state as a dot or a spinner, and the
/// one-line summary while it is being written. The only raised surface on
/// the board. Tap opens the report full screen.
private struct ReportPin: View {
    let report: Report
    let running: Bool
    let liveAngles: Int
    let open: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Tint.cyan)
                    .frame(width: 22)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(report.title ?? "Report")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    ReportState(mark: mark, text: stateText)
                    if let summary = report.summary, !summary.isEmpty {
                        Text(summary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 13)
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(card)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("\(report.title ?? "Report"), \(stateText)")
        .accessibilityHint("Opens the report")
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.field, style: .continuous) }

    /// Light: white lifted by two soft offset shadows. Dark: the raised step with a hairline.
    @ViewBuilder private var card: some View {
        if scheme == .dark {
            shape
                .fill(Surface.raised)
                .overlay(shape.strokeBorder(Surface.hairline, lineWidth: 1 / scale))
        } else {
            shape
                .fill(Surface.background)
                .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        }
    }

    private var mark: ReportState.Mark {
        if report.isComplete { return liveAngles > 0 ? .spinner : .dot(Tint.success) }
        return running ? .spinner : .dot(Color(.tertiaryLabel))
    }

    private var stateText: String {
        if report.isComplete {
            return liveAngles > 0 ? "Complete · \(liveAngles) angle\(liveAngles == 1 ? "" : "s") still running" : "Complete"
        }
        return "In progress"
    }
}

/// The pin's state line: a 7 pt dot or the mini spinner, cross-fading, then the words.
struct ReportState: View {
    enum Mark: Equatable {
        case spinner
        case dot(Color)
    }

    let mark: Mark
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                switch mark {
                case .spinner:
                    ProgressView()
                        .controlSize(.mini)
                        .transition(.opacity)
                case .dot(let color):
                    Circle()
                        .fill(color)
                        .frame(width: 7, height: 7)
                        .transition(.opacity)
                }
            }
            .frame(width: 14, height: 14)
            .animation(Motion.crossFade, value: mark)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .contentTransition(.numericText())
                .lineLimit(1)
        }
    }
}

// MARK: - the board

/// Nothing boarded and no report: the type's glyph and what is happening.
private struct EmptyBoard: View {
    let running: Bool
    let loading: Bool

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "binoculars")
                .font(.title2)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            HStack(spacing: 8) {
                if running || loading {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(loading ? "Loading" : running ? "Searching" : "No sources yet")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
    }
}

/// One angle: its name and what it is doing on the gray step, then each
/// query with the sources it surfaced beneath, hairlines inset to the text.
private struct AngleSection: View {
    let angle: ResearchAngle
    let label: String
    let live: Bool
    let animated: Bool
    let onOpen: (WebPage) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        SectionHeader(label) {
            if live {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text(activity)
                        .contentTransition(.opacity)
                }
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .transition(.opacity)
            } else if angle.sourceCount > 0 {
                Text("\(angle.sourceCount)")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .transition(.opacity)
            }
        }
        ForEach(Array(angle.queries.enumerated()), id: \.offset) { _, group in
            if let query = group.query {
                QueryRow(query: query)
            }
            ForEach(Array(group.sources.enumerated()), id: \.element.id) { offset, source in
                SourceRowView(source: source, divided: offset > 0, onOpen: onOpen)
                    .transition(animated ? Motion.appear(reduced: reduceMotion) : .identity)
            }
        }
        if angle.queries.isEmpty, !live {
            Text("No sources")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 16)
                .frame(minHeight: 36)
        }
    }

    private var activity: String {
        switch angle.activity {
        case .searching?: "Searching"
        case .reading?: "Reading"
        case nil: "Starting"
        }
    }
}

/// A search the angle ran, under the glass; its hits follow.
private struct QueryRow: View {
    let query: String
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 20

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(width: icon)
                .accessibilityHidden(true)
            Text(query)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .frame(minHeight: 32)
        .accessibilityLabel("Searched \(query)")
    }
}

/// One source, as a reading-list row: the site's icon in a 1 px outline,
/// the title, the domain dim, the claim it supports in one line. Tap opens
/// the page in the app; hold for the link.
private struct SourceRowView: View {
    let source: SourceRow
    /// A hairline above, inset to the text edge, between consecutive sources.
    let divided: Bool
    let onOpen: (WebPage) -> Void
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 20

    var body: some View {
        let host = ResearchBoard.host(of: source.url)
        let url = URL(string: source.url)
        Button {
            if let url { onOpen(WebPage(url: url)) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                SiteIcon(host: host)
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline(host))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if !host.isEmpty, source.title != nil || source.claim != nil {
                        Text(host)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    if source.title != nil, let claim = source.claim, !claim.isEmpty {
                        Text(claim)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) {
                if divided {
                    Hairline().padding(.leading, 16 + icon + 10)
                }
            }
        }
        .buttonStyle(.pressable)
        .disabled(url == nil)
        .contextMenu {
            Button("Copy Link", systemImage: "link") { UIPasteboard.general.string = source.url }
            if let url {
                Button("Open in Safari", systemImage: "safari") { openURL(url) }
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
            }
        } preview: {
            SourcePreview(source: source, host: host)
        }
        .accessibilityLabel([source.title, host, source.claim].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Opens the page")
    }

    /// The title, else the claim as the headline, else the domain alone.
    private func headline(_ host: String) -> String {
        if let title = source.title, !title.isEmpty { return title }
        if let claim = source.claim, !claim.isEmpty { return claim }
        return host.isEmpty ? source.url : host
    }
}

/// What the hold shows: the whole title and claim, and the address.
private struct SourcePreview: View {
    let source: SourceRow
    let host: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                SiteIcon(host: host)
                Text(source.title ?? host)
                    .font(.subheadline.weight(.semibold))
            }
            if let claim = source.claim, !claim.isEmpty {
                Text(claim)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text(source.url)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(2)
        }
        .padding(16)
        .frame(width: 320, alignment: .leading)
        .background(Surface.background)
    }
}

// MARK: - favicons

/// The site's icon in a continuous-corner square with a 1 px outline at 10 %,
/// a letter tile until it loads. One cache for the process so a row scrolled
/// back into view never flashes.
struct SiteIcon: View {
    let host: String
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 20

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size / 4, style: .continuous)
        ZStack {
            if let image = FaviconCache.shared.image(for: host) {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Color(.tertiarySystemFill)
                Text(host.prefix(1).uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(scheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.1), lineWidth: 1 / scale))
        .task(id: host) { await FaviconCache.shared.load(host) }
        .accessibilityHidden(true)
    }
}

/// Favicons by host, fetched once through the shared session's URL cache.
@MainActor @Observable
final class FaviconCache {
    static let shared = FaviconCache()

    private var images: [String: UIImage] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var missing: Set<String> = []

    func image(for host: String) -> UIImage? { images[host] }

    func load(_ host: String) async {
        guard !host.isEmpty, images[host] == nil, !inFlight.contains(host), !missing.contains(host),
              let url = URL(string: "https://www.google.com/s2/favicons?domain=\(host)&sz=64") else { return }
        inFlight.insert(host)
        defer { inFlight.remove(host) }
        guard let fetched = try? await URLSession.shared.data(from: url), let image = UIImage(data: fetched.0) else {
            missing.insert(host)
            return
        }
        images[host] = image
    }
}
