import SwiftUI
import TempCodeClient
import TempCodeContract

enum SearchScope: String, CaseIterable {
    case threads
    case files
}

/// One matching row of a thread, its snippet with the query set in weight.
struct SearchHit: Identifiable, Sendable {
    let hit: SessionSearchHit
    let text: AttributedString

    var id: Int { hit.seq }

    init(_ hit: SessionSearchHit, query: String) {
        self.hit = hit
        self.text = MatchEmphasis.attributed(hit.snippet.trimmingCharacters(in: .whitespacesAndNewlines), query: query, font: .footnote)
    }
}

/// One thread's hits, in the order the host ranked them.
struct ThreadResult: Identifiable, Sendable {
    let group: ThreadHits
    let hits: [SearchHit]

    var id: EnvironmentResourceID { group.id }

    init(_ group: ThreadHits, query: String) {
        self.group = group
        self.hits = group.hits.map { SearchHit($0, query: query) }
    }
}

/// One matching line of a project file, the preview with the query set in weight.
struct FileMatch: Identifiable, Sendable {
    let match: ProjectSearchMatch
    let text: AttributedString

    var id: String { "\(match.relative):\(match.line):\(match.column)" }

    init(_ match: ProjectSearchMatch, query: String) {
        self.match = match
        self.text = MatchEmphasis.attributed(match.preview.trimmingCharacters(in: .whitespaces), query: query, font: .caption.monospaced())
    }
}

/// The file matches of one project.
struct ProjectMatches: Identifiable, Sendable {
    let environmentId: String
    let project: ProjectMeta
    let matches: [FileMatch]
    let truncated: Bool

    var id: EnvironmentResourceID { EnvironmentResourceID(environmentId: environmentId, resourceId: project.id) }
}

/// What the list shows: every host's answer to one query in one scope. The
/// next answer replaces it whole; nothing clears it first, so the screen
/// never flashes to empty between two queries.
struct SearchAnswer: Sendable {
    var query = ""
    var scope = SearchScope.threads
    var threads: [ThreadResult] = []
    var files: [ProjectMatches] = []
    var truncated = false

    var isEmpty: Bool { threads.isEmpty && files.isEmpty }

    static let none = SearchAnswer()
}

/// Search every host: thread rows that mention the query (`session.search`),
/// grouped by thread with the matching rows quoted, or lines of each live
/// project's files (`search.project`). The field is the system one in the
/// navigation bar; the scopes show only when a host has a project to grep.
/// Queries wait 250 ms after the last keystroke and run on every open host at
/// once, off the main actor; the previous answer stays on screen until the
/// next one lands. Tap a thread to open it, tap a hit to land on its row.
/// Nothing here animates on a keystroke.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: NavigationPath
    var initialQuery: String?
    @State private var query = ""
    @State private var scope = SearchScope.threads
    @State private var answer = SearchAnswer.none
    @State private var searching = false

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var clients: [EnvironmentClient] { model.registry.ordered.filter { $0.status.transport == .open } }
    private var offersFiles: Bool { clients.contains { client in client.projects.contains { !$0.archived } } }
    /// Host names by environment, only when there are several to tell apart.
    private var hostNames: [String: String]? {
        guard clients.count > 1 else { return nil }
        return Dictionary(clients.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
    }

    /// Text starts after the 20 pt glyph column and its 10 pt gap.
    private static let textEdge: CGFloat = 30
    private static let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
    private static let hitInsets = EdgeInsets(top: 0, leading: 16 + textEdge, bottom: 0, trailing: 16)

    var body: some View {
        List {
            switch answer.scope {
            case .threads:
                ForEach(answer.threads) { result in
                    Button { open(result.group, seq: nil) } label: {
                        ThreadHeadRow(group: result.group, host: hostNames?[result.group.environmentId])
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(Self.rowInsets)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.textEdge }
                    ForEach(result.hits) { hit in
                        Button { open(result.group, seq: hit.hit.seq) } label: {
                            SearchHitRow(hit: hit)
                        }
                        .buttonStyle(.pressable)
                        .listRowInsets(Self.hitInsets)
                    }
                }
                if answer.truncated {
                    MoreRow()
                        .listRowInsets(Self.rowInsets)
                }
            case .files:
                ForEach(answer.files) { group in
                    SectionHeader(group.project.name, branch: group.project.branch, worktree: group.project.mode == .worktree) {
                        if let host = hostNames?[group.environmentId] {
                            Text(host)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    ForEach(group.matches) { match in
                        FileMatchRow(match: match)
                            .listRowInsets(Self.rowInsets)
                            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.textEdge }
                    }
                    if group.truncated {
                        MoreRow()
                            .listRowInsets(Self.rowInsets)
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: offersFiles ? "Threads and files" : "Threads")
        .modifier(SearchScopes(scope: $scope, offered: offersFiles))
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .overlay(alignment: .top) {
            status
                .padding(.top, 28)
        }
        .navigationTitle("Search")
        .onAppear {
            if query.isEmpty, let initialQuery { query = initialQuery }
        }
        .onChange(of: offersFiles) {
            if !offersFiles, scope == .files { scope = .threads }
        }
        .task(id: [trimmed, scope.rawValue] + clients.map(\.environment.id)) { await run() }
    }

    /// One calm line over the empty list; nothing while an older answer is still showing.
    @ViewBuilder private var status: some View {
        if clients.isEmpty {
            SearchStatusLine("No host is connected.")
        } else if trimmed.count < 2 {
            SearchStatusLine(offersFiles ? "Threads and project files on every host." : "Every thread on every host.")
        } else if answer.isEmpty, searching {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Searching")
        } else if answer.isEmpty, answer.query == trimmed, answer.scope == scope {
            SearchStatusLine("No results for “\(answer.query)”")
        }
    }

    private func open(_ group: ThreadHits, seq: Int?) {
        path.append(Route.thread(environmentId: group.environmentId, sessionId: group.sessionId, seq: seq))
    }

    /// One host to ask, with what its answer needs snapshotted on the main actor.
    private struct Target: Sendable {
        let client: EnvironmentClient
        let id: String
        let sessions: [SessionMeta]
        let projects: [ProjectMeta]
    }

    private func run() async {
        let text = trimmed
        let scope = scope
        guard text.count >= 2 else {
            answer = .none
            searching = false
            return
        }
        // A new query waits for the typing to pause; a scope change does not.
        if text != answer.query {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
        }
        let targets = clients.map {
            Target(client: $0, id: $0.environment.id, sessions: $0.sessions, projects: Array($0.projects.filter { !$0.archived }.prefix(8)))
        }
        searching = true
        // A cancelled search may finish after its replacement started; only the live one clears the cue.
        defer { if !Task.isCancelled { searching = false } }
        var next = SearchAnswer(query: text, scope: scope)
        switch scope {
        case .threads:
            let answers = await withTaskGroup(of: (Int, [ThreadResult], Bool)?.self) { group in
                for (index, target) in targets.enumerated() {
                    group.addTask {
                        guard let result = try? await target.client.request(Methods.SessionSearch.self, .init(query: text, limit: 60)) else { return nil }
                        let groups = ThreadHits.group(environmentId: target.id, hits: result.hits, sessions: target.sessions)
                        return (index, groups.map { ThreadResult($0, query: text) }, result.truncated)
                    }
                }
                var out: [(Int, [ThreadResult], Bool)] = []
                for await one in group {
                    if let one { out.append(one) }
                }
                return out.sorted { $0.0 < $1.0 }
            }
            for (_, groups, truncated) in answers {
                next.threads += groups
                next.truncated = next.truncated || truncated
            }
        case .files:
            let answers = await withTaskGroup(of: (Int, [ProjectMatches]).self) { group in
                for (index, target) in targets.enumerated() {
                    group.addTask {
                        var groups: [ProjectMatches] = []
                        for project in target.projects {
                            guard let result = try? await target.client.request(Methods.SearchProject.self, .init(options: .init(cwd: project.cwd, query: text))) else { continue }
                            if result.matches.isEmpty { continue }
                            let shown = result.matches.prefix(40).map { FileMatch($0, query: text) }
                            groups.append(ProjectMatches(environmentId: target.id, project: project, matches: shown, truncated: result.truncated || result.matches.count > 40))
                        }
                        return (index, groups)
                    }
                }
                var out: [(Int, [ProjectMatches])] = []
                for await one in group { out.append(one) }
                return out.sorted { $0.0 < $1.0 }
            }
            for (_, groups) in answers { next.files += groups }
        }
        guard !Task.isCancelled else { return }
        answer = next
    }
}

/// The scope buttons under the field, only where a project file search is on offer.
private struct SearchScopes: ViewModifier {
    @Binding var scope: SearchScope
    let offered: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if offered {
            content.searchScopes($scope, activation: .onTextEntry) {
                Text("Threads").tag(SearchScope.threads)
                Text("Files").tag(SearchScope.files)
            }
        } else {
            content
        }
    }
}

/// The thread a group of hits belongs to: its type glyph and title, the host
/// when there are several. Opens the thread itself.
private struct ThreadHeadRow: View {
    let group: ThreadHits
    let host: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            TypeGlyph(type: group.type, weight: .semibold)
            Text(group.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if let host {
                Text(host)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 12)
        .padding(.bottom, 6)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// A matching row: the snippet with the query in weight, when it was said.
private struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(hit.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            Text(TimeFormat.ago(hit.hit.ts))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// A file line: the path with its line number dim, the line itself in mono
/// with the query in weight. The phone has no editor, so the row is a fact.
private struct FileMatchRow: View {
    let match: FileMatch

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "doc.text")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                (Text(match.match.relative) + Text(":\(match.match.line)").foregroundStyle(.tertiary))
                    .font(.footnote)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.head)
                Text(match.text)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// The host cut its answer short: one dim line after the last match.
private struct MoreRow: View {
    var body: some View {
        Text("More matches than shown")
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}
