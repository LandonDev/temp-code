import SwiftUI
import TempCodeClient
import TempCodeContract

/// One inbox item and the host it came from.
struct InboxEntry: Identifiable, Hashable {
    let environmentId: String
    let hostName: String
    let viewer: String?
    let item: GithubInboxItem
    let updatedMs: Int

    var id: String { key }
    /// Stable across refreshes: the seen store's key.
    var key: String { "\(environmentId):\(item.repo):\(item.kind.rawValue):\(item.number)" }
}

/// The GitHub inbox of every host, over `github.inbox`: the desktop's list
/// read like Mail. The tab paints from the last snapshot on disk, the
/// socket's answer lands without motion, and only a pull (the one place a
/// pull is right, since the inbox is a poll) reorders with animation through
/// `github.inboxRefresh`. Rows name the host when there are several. Unread
/// is weight, not a badge; a swipe marks it either way or opens GitHub.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Binding var path: NavigationPath
    @State private var snapshots: [String: GithubInboxSnapshot] = [:]
    @State private var loaded = false
    @State private var refreshDenied = false
    @State private var seen = InboxSeen.shared
    @State private var opened = false

    var body: some View {
        let clients = model.registry.ordered
        let snapshots = effectiveSnapshots(clients)
        let entries = Self.entries(clients: clients, snapshots: snapshots)
        let notices = Self.notices(clients: clients, snapshots: snapshots, refreshDenied: refreshDenied)
        List {
            ForEach(notices, id: \.self) { notice in
                InboxNotice(text: notice)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Surface.chrome)
            }
            ForEach(entries) { entry in
                let unread = seen.isUnread(entry)
                Button {
                    open(entry)
                } label: {
                    InboxRow(entry: entry, unread: unread, showHost: clients.count > 1)
                }
                .buttonStyle(.pressable)
                .listRowInsets(rowInsets)
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + 48 }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        openURL(URL(string: entry.item.url) ?? URL(fileURLWithPath: "/"))
                    } label: {
                        Label("GitHub", systemImage: "safari")
                    }
                    .tint(Color(.systemGray))
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button {
                        if unread { seen.markSeen(entry) } else { seen.markUnread(entry) }
                    } label: {
                        Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                    .tint(Tint.info)
                }
                .contextMenu {
                    Button {
                        openURL(URL(string: entry.item.url) ?? URL(fileURLWithPath: "/"))
                    } label: {
                        Label("Open on GitHub", systemImage: "safari")
                    }
                    Button {
                        if unread { seen.markSeen(entry) } else { seen.markUnread(entry) }
                    } label: {
                        Label(unread ? "Mark as Read" : "Mark as Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                    Button {
                        UIPasteboard.general.string = entry.item.url
                    } label: {
                        Label("Copy Link", systemImage: "link")
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh(clients) }
        .overlay {
            if loaded, entries.isEmpty, notices.isEmpty {
                Text("Nothing waiting on GitHub.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Inbox")
        .task(id: openKey(clients)) { await load(clients) }
        .onChange(of: entries, initial: true) { _, entries in
            seen.seed(entries)
            openForProof(entries)
        }
    }

    private func open(_ entry: InboxEntry) {
        seen.markSeen(entry)
        path.append(Route.inboxItem(environmentId: entry.environmentId, item: entry.item))
    }

    /// DEBUG: `TC_TEST_OPEN=inbox` pushes the newest pull request, `inbox-issue` the newest issue.
    private func openForProof(_ entries: [InboxEntry]) {
        guard !opened, let want = TestHooks.open, want == "inbox" || want == "inbox-issue" else { return }
        let kind: GithubInboxItem.Kind = want == "inbox" ? .pr : .issue
        guard let entry = entries.first(where: { $0.item.kind == kind }) else { return }
        opened = true
        open(entry)
    }

    /// The socket's snapshot where it has answered, else the one on disk.
    private func effectiveSnapshots(_ clients: [EnvironmentClient]) -> [String: GithubInboxSnapshot] {
        var out = snapshots
        for client in clients where out[client.environment.id] == nil {
            if let cached = InboxCache.snapshot(client.environment.id) { out[client.environment.id] = cached }
        }
        return out
    }

    private func openKey(_ clients: [EnvironmentClient]) -> String {
        clients.map { "\($0.environment.id):\($0.status.transport == .open)" }.joined(separator: ",")
    }

    /// The first answer of every open host, applied with no motion: the rows
    /// are already there from the cache, or were never there to move.
    private func load(_ clients: [EnvironmentClient]) async {
        for client in clients where client.status.transport == .open && snapshots[client.environment.id] == nil {
            if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
                apply(snapshot, for: client.environment.id, animated: false)
            }
        }
        if clients.allSatisfy({ $0.status.transport == .open || $0.status.transport == .unauthorized || $0.status.transport == .offline }) {
            loaded = true
        }
    }

    /// The pull: GitHub is asked again and the rows reorder under the default animation.
    private func refresh(_ clients: [EnvironmentClient]) async {
        refreshDenied = false
        for client in clients where client.status.transport == .open {
            do {
                let snapshot = try await client.request(Methods.GithubInboxRefresh.self, .init(reason: .manual))
                apply(snapshot, for: client.environment.id, animated: true)
            } catch let error as TransportError where error.isForbidden {
                refreshDenied = true
                if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
                    apply(snapshot, for: client.environment.id, animated: true)
                }
            } catch {
                continue
            }
        }
    }

    private func apply(_ snapshot: GithubInboxSnapshot, for environmentId: String, animated: Bool) {
        InboxCache.store(snapshot, for: environmentId)
        if animated {
            withAnimation(.default) { snapshots[environmentId] = snapshot }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { snapshots[environmentId] = snapshot }
        }
    }

    /// Every item of every host, newest first, as the desktop sorts.
    static func entries(clients: [EnvironmentClient], snapshots: [String: GithubInboxSnapshot]) -> [InboxEntry] {
        var out: [InboxEntry] = []
        for client in clients {
            guard let snapshot = snapshots[client.environment.id] else { continue }
            for repo in snapshot.repos {
                for item in repo.items {
                    out.append(InboxEntry(environmentId: client.environment.id, hostName: client.environment.name, viewer: snapshot.viewer, item: item, updatedMs: item.updatedMs))
                }
            }
        }
        return out.sorted {
            if $0.updatedMs != $1.updatedMs { return $0.updatedMs > $1.updatedMs }
            if $0.item.repo != $1.item.repo { return $0.item.repo < $1.item.repo }
            if $0.item.kind.rawValue != $1.item.kind.rawValue { return $0.item.kind.rawValue < $1.item.kind.rawValue }
            return $0.item.number > $1.item.number
        }
    }

    /// What stands between the user and a full inbox: a host not connected,
    /// gh not signed in, a repo that failed, a key that cannot refresh.
    static func notices(clients: [EnvironmentClient], snapshots: [String: GithubInboxSnapshot], refreshDenied: Bool) -> [String] {
        var out: [String] = []
        if refreshDenied { out.append("This key reads the inbox but cannot refresh it.") }
        for client in clients {
            let name = client.environment.name
            let prefix = clients.count > 1 ? "\(name): " : ""
            guard let snapshot = snapshots[client.environment.id] else {
                switch client.status.transport {
                case .offline: out.append("\(name) is not reachable.")
                case .unauthorized: out.append("\(name) no longer accepts this key.")
                default: break
                }
                continue
            }
            if snapshot.auth.state != .ok, !snapshot.auth.message.isEmpty {
                out.append(prefix + snapshot.auth.message)
            }
            for repo in snapshot.repos {
                if let error = repo.error, !error.isEmpty { out.append("\(prefix)\(repo.repo): \(error)") }
            }
        }
        return out
    }

    static func date(_ iso: String) -> Date {
        Date(timeIntervalSince1970: Double(inboxMs(iso)) / 1000)
    }
}

/// One line on the chrome step, the same shape as a section header.
private struct InboxNotice: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}

/// The row: the author's avatar, the title carrying the weight while unread,
/// the time trailing in tabular digits, and one dim line with the kind
/// glyph, the reference, the state in its one color and the host when
/// there are several. No chevron: every row pushes.
struct InboxRow: View {
    let entry: InboxEntry
    let unread: Bool
    let showHost: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let item = entry.item
        let time = TimeFormat.ago(entry.updatedMs)
        let state = InboxState.of(item, viewer: entry.viewer)
        HStack(alignment: .top, spacing: 12) {
            InboxAvatar(url: item.author?.avatarUrl ?? "", login: item.author?.login ?? "", size: 36)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                if typeSize.isAccessibilitySize {
                    Text(item.title)
                        .font(.subheadline.weight(unread ? .semibold : .regular))
                        .lineLimit(3)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.title)
                            .font(.subheadline.weight(unread ? .semibold : .regular))
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Text(time)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
                HStack(spacing: 5) {
                    Image(systemName: item.kindGlyph)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                    Text(item.reference)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                    if let state {
                        Text("·").foregroundStyle(.quaternary)
                        Text(state.text)
                            .foregroundStyle(state.tint)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    if showHost {
                        Text("·").foregroundStyle(.quaternary)
                        Text(entry.hostName)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    if typeSize.isAccessibilitySize {
                        Spacer(minLength: 8)
                        Text(time)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.footnote)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(state: state, time: time))
    }

    private func accessibilityLabel(state: InboxState?, time: String) -> String {
        var parts = [unread ? "Unread" : "", entry.item.kindLabel, entry.item.title]
        if let author = entry.item.author?.login, !author.isEmpty { parts.append("from \(author)") }
        parts.append(entry.item.reference)
        if let state { parts.append(state.text) }
        if showHost { parts.append(entry.hostName) }
        parts.append(time)
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
