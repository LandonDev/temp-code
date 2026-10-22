import SwiftUI
import TempCodeClient
import TempCodeContract

/// Search every host: thread rows that mention the query (`session.search`),
/// grouped by thread with the matching rows quoted, or lines of each live
/// project's files (`search.project`). The field is the system one; the
/// scopes show only when an open host has a project to grep. A query waits
/// 250 ms after the last keystroke and runs on every open host at once, off
/// the main actor; the previous answer stays on screen until the next one
/// lands, whole, so two queries' rows never mix. Tap a thread to open it,
/// tap a hit to land on its row. Nothing here animates on a keystroke.
///
/// The rows are `SearchRows.build`'s: the one call in `run()` is where the
/// cross-host selector lands, and the view draws whatever it emits.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: NavigationPath
    var initialQuery: String?
    @State private var query = ""
    @State private var scope = SearchScope.threads
    @State private var answer = SearchAnswer.none
    @State private var searching = false
    /// Where a head's title starts past the text edge: the glyph column and
    /// its gap, scaled with the glyph. Hits and separators start here.
    @ScaledMetric(relativeTo: .subheadline) private var glyphEdge = Layout.glyphWidth + Layout.rowGap

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Every paired host in rail order, open or not.
    private var paired: [EnvironmentClient] { model.registry.ordered }
    private var openHosts: [EnvironmentClient] { paired.filter { $0.status.transport == .open } }
    private var offersFiles: Bool { openHosts.contains { client in client.projects.contains { !$0.archived } } }
    private var severalHosts: Bool { paired.count > 1 }
    private var hitInsets: EdgeInsets {
        EdgeInsets(top: 0, leading: Layout.textEdge + glyphEdge, bottom: 0, trailing: Layout.textEdge)
    }

    /// What `.task(id:)` keys on: the query, the scope and the open hosts, so
    /// a host coming or going re-runs the search.
    nonisolated private struct SearchKey: Hashable {
        let query: String
        let scope: SearchScope
        let hosts: [String]
    }

    var body: some View {
        List {
            ForEach(answer.rows) { row in
                switch row {
                case .threadHead(let head):
                    Button { open(head.environmentId, head.sessionId, seq: nil) } label: {
                        ThreadHeadRow(head: head)
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(Layout.rowInsets)
                    .separatorAtTextEdge(glyphEdge)
                    .listRowSeparator(.hidden, edges: .top)
                case .hit(let hit):
                    Button { open(hit.environmentId, hit.sessionId, seq: hit.seq) } label: {
                        HitRow(hit: hit)
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(hitInsets)
                case .projectHead(let head):
                    ProjectHeadRow(head: head)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                case .file(let file):
                    FileRow(file: file)
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(glyphEdge)
                case .project(let project):
                    ProjectRow(project: project)
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(glyphEdge)
                case .more:
                    MoreRow()
                        .listRowInsets(Layout.rowInsets)
                        .listRowSeparator(.hidden)
                }
            }
            if severalHosts, !answer.isEmpty, let foot = SearchRows.footLine(answer.hosts) {
                FootRow(text: foot)
                    .listRowInsets(Layout.rowInsets)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .modifier(SearchField(query: $query, prompt: offersFiles ? "Threads and files" : "Threads"))
        .searchPresentationToolbarBehavior(.avoidHidingContent)
        .modifier(SearchScopes(scope: $scope, offered: offersFiles))
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .overlay(alignment: .top) {
            status
                .padding(.top, 24)
        }
        .navigationTitle("Search")
        .onAppear {
            if query.isEmpty, let initialQuery { query = initialQuery }
            #if DEBUG
            // The simulator proof's shot of the Files scope; nothing else reads it.
            if ProcessInfo.processInfo.environment["TC_TEST_SEARCH_SCOPE"] == "files" { scope = .files }
            #endif
        }
        .onChange(of: offersFiles) {
            if !offersFiles, scope == .files { scope = .threads }
        }
        .task(id: SearchKey(query: trimmed, scope: scope, hosts: openHosts.map(\.environment.id))) { await run() }
    }

    /// One calm line over the empty list; nothing while an older answer is still showing.
    @ViewBuilder private var status: some View {
        if answer.isEmpty {
            if paired.isEmpty {
                SearchStatusLine("No host is connected.")
            } else if openHosts.isEmpty {
                SearchStatusLine("Every host is offline.")
            } else if trimmed.count < SearchDebounce.minimumLength {
                SearchStatusLine(offersFiles ? "Threads and project files on every host." : "Every thread on every host.")
            } else if searching {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Searching")
            } else if answer.query == trimmed, answer.scope == scope {
                SearchStatusLine("No results for “\(answer.query)”")
            }
        }
    }

    private func open(_ environmentId: String, _ sessionId: String, seq: Int?) {
        path.append(Route.thread(environmentId: environmentId, sessionId: sessionId, seq: seq))
    }

    /// One host to ask, with what its answer needs snapshotted on the main
    /// actor before the task group starts. `EnvironmentClient` is main-actor,
    /// so the reference is Sendable; the children only call `request` on it.
    nonisolated private struct Target: Sendable {
        let client: EnvironmentClient
        let id: String
        let name: String
        let sessions: [SessionMeta]
        let projects: [ProjectMeta]
    }

    private func run() async {
        let text = trimmed
        let scope = scope
        guard text.count >= SearchDebounce.minimumLength else {
            answer = .none
            searching = false
            return
        }
        let delay = SearchDebounce.delay(previousQuery: answer.query, nextQuery: text)
        if delay > .zero {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
        }
        let targets = openHosts.map {
            Target(client: $0, id: $0.environment.id, name: $0.environment.name, sessions: $0.sessions, projects: Array($0.projects.filter { !$0.archived }.prefix(8)))
        }
        let hosts = paired.map {
            SearchHost(id: $0.environment.id, name: $0.environment.name, open: $0.status.transport == .open)
        }
        searching = true
        // A cancelled search may finish after its replacement started; only the live one clears the cue.
        defer { if !Task.isCancelled { searching = false } }
        let answers = await withTaskGroup(of: SearchHostAnswer.self) { group in
            for target in targets {
                group.addTask { await Self.ask(target, text: text, scope: scope) }
            }
            var out: [SearchHostAnswer] = []
            for await one in group { out.append(one) }
            return out
        }
        // The one line the cross-host selector slots into.
        let next = SearchRows.build(query: text, scope: scope, hosts: hosts, answers: answers)
        guard !Task.isCancelled else { return }
        Motion.withoutAnimation { answer = next }
    }

    /// One host's calls, off the main actor: the thread search, or one
    /// project search per project in turn. Measures what the host took and
    /// marks the answer failed when every call threw.
    private nonisolated static func ask(_ target: Target, text: String, scope: SearchScope) async -> SearchHostAnswer {
        let clock = ContinuousClock()
        let start = clock.now
        var threads: SessionSearchResult?
        var files: [SearchHostAnswer.ProjectFiles] = []
        var failed = false
        switch scope {
        case .threads:
            threads = try? await target.client.request(Methods.SessionSearch.self, .init(query: text, limit: 60))
            failed = threads == nil
        case .files:
            var threw = 0
            for project in target.projects {
                if let result = try? await target.client.request(Methods.SearchProject.self, .init(options: .init(cwd: project.cwd, query: text))) {
                    files.append(.init(project: project, result: result))
                } else {
                    threw += 1
                }
            }
            failed = !target.projects.isEmpty && threw == target.projects.count
        }
        let elapsed = clock.now - start
        return SearchHostAnswer(
            environmentId: target.id,
            name: target.name,
            sessions: target.sessions,
            threads: threads,
            files: files,
            elapsedMs: Int(elapsed / .milliseconds(1)),
            failed: failed
        )
    }
}

/// The system field, placed by version: on iOS 26 `.automatic` keeps the
/// search-role tab's own field; before it the navigation drawer, always shown.
private struct SearchField: ViewModifier {
    @Binding var query: String
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.searchable(text: $query, placement: .automatic, prompt: prompt)
        } else {
            content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        }
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
