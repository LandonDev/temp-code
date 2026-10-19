import SwiftUI
import TempCodeClient
import TempCodeContract

enum SearchScope: String, CaseIterable {
    case threads
    case files
}

/// The hits of one thread.
struct ThreadHits: Identifiable {
    let environmentId: String
    let sessionId: String
    let title: String
    let type: ThreadType?
    var hits: [SessionSearchHit]

    var id: String { sessionId }
}

/// The file matches of one project.
struct ProjectMatches: Identifiable {
    let environmentId: String
    let project: ProjectMeta
    let matches: [ProjectSearchMatch]
    let truncated: Bool

    var id: String { project.id }
}

/// Search every host: thread rows that mention the query (`session.search`),
/// grouped by thread with the matching row quoted, or file lines in each live
/// project (`search.project`). Tap a hit to land on its row.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: NavigationPath
    var initialQuery: String?
    @State private var query = ""
    @State private var scope = SearchScope.threads
    @State private var threads: [ThreadHits] = []
    @State private var files: [ProjectMatches] = []
    @State private var searching = false
    @State private var truncated = false

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            switch scope {
            case .threads:
                ForEach(threads) { group in
                    threadHeader(group)
                    ForEach(group.hits, id: \.seq) { hit in
                        Button { path.append(Route.thread(environmentId: group.environmentId, sessionId: group.sessionId, seq: hit.seq)) } label: {
                            HitRow(hit: hit)
                        }
                        .buttonStyle(.pressable)
                        .listRowInsets(rowInsets)
                    }
                }
            case .files:
                ForEach(files) { group in
                    SectionHeader(group.project.name, branch: group.project.branch, worktree: group.project.mode == .worktree)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                    ForEach(Array(group.matches.enumerated()), id: \.offset) { _, match in
                        MatchRow(match: match)
                            .listRowInsets(rowInsets)
                    }
                    if group.truncated {
                        DimRow("More matches than shown")
                            .listRowInsets(rowInsets)
                    }
                }
            }
            if truncated, scope == .threads {
                DimRow("More matches than shown")
                    .listRowInsets(rowInsets)
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Threads and files")
        .searchScopes($scope, activation: .onTextEntry) {
            Text("Threads").tag(SearchScope.threads)
            Text("Files").tag(SearchScope.files)
        }
        .autocorrectionDisabled()
        .overlay {
            if trimmed.count < 2 {
                Color.clear
            } else if searching, isEmpty {
                ProgressView()
            } else if isEmpty {
                ContentUnavailableView.search(text: trimmed)
            }
        }
        .navigationTitle("Search")
        .onAppear {
            if query.isEmpty, let initialQuery { query = initialQuery }
        }
        .task(id: "\(trimmed)|\(scope.rawValue)") { await run() }
    }

    private var isEmpty: Bool {
        scope == .threads ? threads.isEmpty : files.isEmpty
    }

    private func threadHeader(_ group: ThreadHits) -> some View {
        SectionHeader(group.title) {
            TypeGlyph(type: group.type)
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
    }

    private func run() async {
        let text = trimmed
        guard text.count >= 2 else {
            threads = []
            files = []
            truncated = false
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        let clients = model.registry.ordered.filter { $0.status.transport == .open }
        switch scope {
        case .threads:
            var groups: [ThreadHits] = []
            var index: [String: Int] = [:]
            var cut = false
            for client in clients {
                guard let result = try? await client.request(Methods.SessionSearch.self, .init(query: text, limit: 60)) else { continue }
                cut = cut || result.truncated
                for hit in result.hits {
                    if let at = index[hit.sessionId] {
                        groups[at].hits.append(hit)
                    } else {
                        let session = client.session(hit.sessionId)
                        index[hit.sessionId] = groups.count
                        groups.append(ThreadHits(environmentId: client.environment.id, sessionId: hit.sessionId, title: session?.title ?? "Thread", type: session?.threadType, hits: [hit]))
                    }
                }
            }
            guard !Task.isCancelled else { return }
            threads = groups
            truncated = cut
        case .files:
            var groups: [ProjectMatches] = []
            for client in clients {
                for project in client.projects.filter({ !$0.archived }).prefix(8) {
                    guard let result = try? await client.request(Methods.SearchProject.self, .init(options: .init(cwd: project.cwd, query: text))) else { continue }
                    if result.matches.isEmpty { continue }
                    groups.append(ProjectMatches(environmentId: client.environment.id, project: project, matches: Array(result.matches.prefix(40)), truncated: result.truncated || result.matches.count > 40))
                }
            }
            guard !Task.isCancelled else { return }
            files = groups
        }
    }
}

/// A matching row: who said it, the snippet, when.
private struct HitRow: View {
    let hit: SessionSearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: hit.role.rawValue == "user" ? "person" : "sparkle")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(width: 20)
                .padding(.top, 2)
            Text(hit.snippet)
                .font(.footnote)
                .lineLimit(3)
            Spacer(minLength: 8)
            Text(TimeFormat.ago(hit.ts))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
    }
}

/// A file line: the path and line dim, the line itself in mono.
private struct MatchRow: View {
    let match: ProjectSearchMatch

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(match.relative):\(match.line)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.head)
            Text(match.preview.trimmingCharacters(in: .whitespaces))
                .font(.caption.monospaced())
                .lineLimit(1)
        }
        .padding(.vertical, 6)
    }
}
