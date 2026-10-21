import SwiftUI
import TempCodeClient
import TempCodeContract

/// The GitHub inbox of every host, over `github.inbox`. The tab paints from
/// the last snapshot on disk and asks each host for its stored snapshot when
/// it opens, with no animation; a pull runs `github.inboxRefresh` (the inbox
/// is a poll, so this is the one place a pull is right) and only then does
/// the list reorder with the default animation. Rows name the host when
/// there are several; a row is unread by weight alone, and the swipes mark
/// it read or open it on GitHub.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Binding var path: NavigationPath
    private let store = InboxStore.shared
    @State private var refreshDenied = false
    @State private var opened = false

    var body: some View {
        let clients = model.registry.ordered
        let entries = store.entries(clients: clients)
        let notices = Self.notices(clients: clients, snapshots: store.snapshots, refreshDenied: refreshDenied)
        List {
            ForEach(notices, id: \.self) { notice in
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .listRowInsets(rowInsets)
                    .listRowBackground(Surface.chrome)
            }
            ForEach(entries) { entry in
                let unread = store.isUnread(entry)
                Button { open(entry) } label: {
                    InboxRow(entry: entry, unread: unread, status: InboxStatus.of(entry.item, viewer: store.snapshot(for: entry.environmentId)?.viewer), showHost: clients.count > 1)
                }
                .buttonStyle(.pressable)
                .listRowInsets(rowInsets)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button {
                        if unread { store.markRead(entry) } else { store.markUnread(entry) }
                    } label: {
                        Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                    .tint(Tint.info)
                }
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    Button {
                        if let url = URL(string: entry.item.url) { openURL(url) }
                    } label: {
                        Label("GitHub", systemImage: "safari")
                    }
                    .tint(Color(.systemGray))
                }
                .contextMenu {
                    Button {
                        if let url = URL(string: entry.item.url) { openURL(url) }
                    } label: {
                        Label("Open on GitHub", systemImage: "safari")
                    }
                    Button {
                        UIPasteboard.general.url = URL(string: entry.item.url)
                    } label: {
                        Label("Copy Link", systemImage: "link")
                    }
                    Divider()
                    Button {
                        if unread { store.markRead(entry) } else { store.markUnread(entry) }
                    } label: {
                        Label(unread ? "Mark as Read" : "Mark as Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh(clients) }
        .overlay {
            if entries.isEmpty, notices.isEmpty, Self.settled(clients, store: store) {
                Text("Nothing in the inbox.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Inbox")
        .task(id: openKey(clients)) { await load(clients) }
    }

    private func open(_ entry: InboxEntry) {
        store.markRead(entry)
        path.append(Route.inboxItem(environmentId: entry.environmentId, item: entry.item))
    }

    private func openKey(_ clients: [EnvironmentClient]) -> String {
        clients.map { "\($0.environment.id):\($0.status.transport == .open)" }.joined(separator: ",")
    }

    /// The host's stored snapshot (SQLite, never the network), landing without
    /// animation: on the first open, and again when the tab comes back after a
    /// minute, since the desktop may have refreshed it meanwhile.
    private func load(_ clients: [EnvironmentClient]) async {
        for client in clients where client.status.transport == .open && store.shouldAsk(client.environment.id) {
            store.markAsked(client.environment.id)
            guard let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) else { continue }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { store.put(snapshot, for: client.environment.id) }
        }
        openForProof(clients)
    }

    /// The pull: GitHub is asked again and the rows move under the default animation.
    private func refresh(_ clients: [EnvironmentClient]) async {
        refreshDenied = false
        for client in clients where client.status.transport == .open {
            do {
                let snapshot = try await client.request(Methods.GithubInboxRefresh.self, .init(reason: .manual))
                withAnimation(.default) { store.put(snapshot, for: client.environment.id) }
            } catch let error as TransportError where error.isForbidden {
                refreshDenied = true
                if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
                    withAnimation(.default) { store.put(snapshot, for: client.environment.id) }
                }
            } catch {
                continue
            }
        }
    }

    /// Every host has answered, or cannot: the empty line may show.
    static func settled(_ clients: [EnvironmentClient], store: InboxStore) -> Bool {
        clients.allSatisfy { client in
            store.snapshots[client.environment.id] != nil
                || (store.asked.contains(client.environment.id) && client.status.transport != .connecting)
                || client.status.transport == .unauthorized || client.status.transport == .offline
        }
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

    /// DEBUG only: `TC_TEST_OPEN=item` pushes the newest pull request for the proof's detail shot.
    private func openForProof(_ clients: [EnvironmentClient]) {
        guard TestHooks.open == "item", !opened else { return }
        let entries = store.entries(clients: clients)
        guard let entry = entries.first(where: { $0.item.kind.rawValue == "pr" }) ?? entries.first else { return }
        opened = true
        open(entry)
    }
}

/// One row, the way Mail lays a message out: the author's picture, the
/// title (semibold while unread) with the time trailing in tabular digits,
/// then a dim line with the kind, the author, the repository and number,
/// what the item waits on in the one color that means it, and the host
/// when there are several.
struct InboxRow: View {
    let entry: InboxEntry
    let unread: Bool
    let status: InboxStatus?
    let showHost: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let item = entry.item
        HStack(alignment: .top, spacing: 12) {
            InboxAvatar(url: item.author?.avatarUrl ?? "", login: item.author?.login ?? "", size: 36)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.subheadline.weight(unread ? .semibold : .regular))
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
                    Spacer(minLength: 0)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(TimeFormat.ago(entry.updatedMs, now: context.date))
                    }
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                }
                HStack(spacing: 5) {
                    Image(systemName: item.kind.rawValue == "pr" ? "arrow.triangle.pull" : "circle.circle")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel(item.kind.rawValue == "pr" ? "Pull request" : "Issue")
                    if let author = item.author?.login, !author.isEmpty {
                        Text(author)
                            .foregroundStyle(unread ? .secondary : .tertiary)
                            .fixedSize()
                        dot
                    }
                    Text("\(Self.repoName(item.repo)) #\(item.number)")
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let status {
                        dot
                        Text(status.text)
                            .foregroundStyle(status.tint ?? Color(.tertiaryLabel))
                            .fixedSize()
                            .layoutPriority(1)
                    }
                    if showHost {
                        dot
                        Text(entry.hostName)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .font(.footnote)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(unread ? "\(item.title), new" : item.title)
    }

    private var dot: some View {
        Text("·")
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }

    /// The name after the owner: one owner is the common case, and the phone has no room for it.
    static func repoName(_ repo: String) -> String {
        repo.split(separator: "/").last.map(String.init) ?? repo
    }
}
