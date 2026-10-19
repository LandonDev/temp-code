import SwiftUI
import TempCodeClient
import TempCodeContract

/// One inbox item and the host it came from.
struct InboxEntry: Identifiable, Hashable {
    let environmentId: String
    let hostName: String
    let item: GithubInboxItem
    let updated: Date

    var id: String { "\(environmentId):\(item.repo)#\(item.number)" }
}

/// The GitHub inbox of every host, over `github.inbox`. Pull to refresh runs
/// `github.inboxRefresh`: the inbox is a poll, so this is the one place a
/// pull is right. Rows name the host when there are several. Read-only.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: NavigationPath
    @State private var snapshots: [String: GithubInboxSnapshot] = [:]
    @State private var loaded = false
    @State private var refreshDenied = false

    var body: some View {
        let clients = model.registry.ordered
        let entries = Self.entries(clients: clients, snapshots: snapshots)
        let notices = Self.notices(clients: clients, snapshots: snapshots, refreshDenied: refreshDenied)
        List {
            ForEach(notices, id: \.self) { notice in
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 36)
                    .listRowInsets(rowInsets)
                    .listRowBackground(Surface.chrome)
            }
            ForEach(entries) { entry in
                Button { path.append(Route.inboxItem(environmentId: entry.environmentId, item: entry.item)) } label: {
                    InboxRow(entry: entry, showHost: clients.count > 1)
                }
                .buttonStyle(.pressable)
                .listRowInsets(rowInsets)
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh(clients) }
        .overlay {
            if entries.isEmpty, notices.isEmpty {
                if loaded {
                    ContentUnavailableView("Nothing in the inbox", systemImage: "tray")
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Inbox")
        .task(id: openKey(clients)) { await load(clients) }
    }

    private func openKey(_ clients: [EnvironmentClient]) -> String {
        clients.map { "\($0.environment.id):\($0.status.transport == .open)" }.joined(separator: ",")
    }

    private func load(_ clients: [EnvironmentClient]) async {
        for client in clients where client.status.transport == .open && snapshots[client.environment.id] == nil {
            if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
                snapshots[client.environment.id] = snapshot
            }
        }
        if clients.allSatisfy({ $0.status.transport == .open || $0.status.transport == .unauthorized || $0.status.transport == .offline }) {
            loaded = true
        }
    }

    private func refresh(_ clients: [EnvironmentClient]) async {
        refreshDenied = false
        for client in clients where client.status.transport == .open {
            do {
                snapshots[client.environment.id] = try await client.request(Methods.GithubInboxRefresh.self, .init(reason: .manual))
            } catch let error as TransportError where error.isForbidden {
                refreshDenied = true
                if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
                    snapshots[client.environment.id] = snapshot
                }
            } catch {
                continue
            }
        }
    }

    /// Every item of every host, newest first.
    static func entries(clients: [EnvironmentClient], snapshots: [String: GithubInboxSnapshot]) -> [InboxEntry] {
        var out: [InboxEntry] = []
        for client in clients {
            guard let snapshot = snapshots[client.environment.id] else { continue }
            for repo in snapshot.repos {
                for item in repo.items {
                    out.append(InboxEntry(environmentId: client.environment.id, hostName: client.environment.name, item: item, updated: date(item.updatedAt)))
                }
            }
        }
        return out.sorted { ($0.updated, $0.id) > ($1.updated, $1.id) }
    }

    /// What stands between the user and a full inbox: gh not signed in, a repo that failed, a key that cannot refresh.
    static func notices(clients: [EnvironmentClient], snapshots: [String: GithubInboxSnapshot], refreshDenied: Bool) -> [String] {
        var out: [String] = []
        if refreshDenied { out.append("This key reads the inbox but cannot refresh it.") }
        for client in clients {
            guard let snapshot = snapshots[client.environment.id] else { continue }
            let prefix = clients.count > 1 ? "\(client.environment.name): " : ""
            if snapshot.auth.state.rawValue != "ok", !snapshot.auth.message.isEmpty {
                out.append(prefix + snapshot.auth.message)
            }
            for repo in snapshot.repos {
                if let error = repo.error, !error.isEmpty { out.append("\(prefix)\(repo.repo): \(error)") }
            }
        }
        return out
    }

    static func date(_ iso: String) -> Date {
        (try? Date(iso, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(iso, strategy: .iso8601))
            ?? .distantPast
    }
}

/// The desktop's inbox row in three lines: kind and reference with the time,
/// the title, then the author, what the PR waits on, and the host.
struct InboxRow: View {
    let entry: InboxEntry
    let showHost: Bool

    var body: some View {
        let item = entry.item
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: item.kind.rawValue == "pr" ? "arrow.triangle.pull" : "circle.circle")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel(item.kind.rawValue == "pr" ? "Pull request" : "Issue")
                Text("\(item.repo) #\(item.number)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(TimeFormat.ago(Int(entry.updated.timeIntervalSince1970 * 1000)))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            Text(item.title)
                .font(.subheadline)
                .lineLimit(2)
            meta
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var meta: Text {
        var parts: [Text] = []
        if let author = entry.item.author?.login, !author.isEmpty { parts.append(Text(author)) }
        if let note = InboxNote.of(entry.item) { parts.append(Text(note.text).foregroundStyle(note.tint)) }
        if showHost { parts.append(Text(entry.hostName)) }
        if parts.isEmpty { return Text(entry.item.state.rawValue.capitalized) }
        return parts.dropFirst().reduce(parts[0]) { $0 + Text(" · ") + $1 }
    }
}

/// What a pull request waits on, as the desktop's `prNote` says it.
enum InboxNote {
    struct Note {
        let text: String
        let tint: Color
    }

    static func of(_ item: GithubInboxItem) -> Note? {
        guard item.kind.rawValue == "pr" else { return nil }
        if item.draft { return Note(text: "Draft", tint: Color(.tertiaryLabel)) }
        guard item.state.rawValue == "open" else { return Note(text: item.state.rawValue.capitalized, tint: Color(.tertiaryLabel)) }
        if item.reviewDecision.rawValue == "CHANGES_REQUESTED" { return Note(text: "Changes requested", tint: Tint.warning) }
        if let checks = item.checks?.rawValue, checks == "FAILURE" || checks == "ERROR" { return Note(text: "Checks failing", tint: Tint.destructive) }
        if item.reviewDecision.rawValue == "APPROVED" { return Note(text: "Approved", tint: Tint.success) }
        return nil
    }
}
