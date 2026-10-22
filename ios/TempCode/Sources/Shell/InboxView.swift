import SwiftUI
import TempCodeClient
import TempCodeContract

/// The GitHub inbox of every host, over `github.inbox`. The tab paints from
/// the last snapshot on disk and asks each host for its stored snapshot when
/// it opens, with no animation; a pull runs `github.inboxRefresh` (the inbox
/// is a poll, so this is the one place a pull is right) and only then does
/// the list reorder with the default animation. Rows name the host when
/// there are several; a row is unread by weight alone, and the swipes mark
/// it read or open it on GitHub. The rules are `InboxModel`; this is the list.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Binding var path: NavigationPath
    private let store = InboxStore.shared
    /// A refresh answered forbidden, so the key reads but cannot refresh.
    @State private var refreshRefused = false
    @State private var opened = false

    var body: some View {
        let clients = model.registry.ordered
        let entries = store.entries(clients: clients)
        let notices = InboxModel.notices(hosts: store.hosts(clients), refreshDenied: refreshDenied(clients))
        List {
            ForEach(notices, id: \.self) { notice in
                Text(notice)
                    .textStep(.meta)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .listRowInsets(Layout.rowInsets)
                    .listRowBackground(Surface.chrome)
            }
            ForEach(entries) { entry in
                let unread = store.isUnread(entry)
                Button { open(entry) } label: {
                    InboxRow(entry: entry, unread: unread, status: InboxModel.status(of: entry.item, viewer: store.snapshot(for: entry.environmentId)?.viewer), showHost: clients.count > 1)
                }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button {
                        toggleRead(entry, unread: unread)
                    } label: {
                        Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                    .tint(Tint.info)
                }
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    Button {
                        openOnGitHub(entry)
                    } label: {
                        Label("GitHub", systemImage: "safari")
                    }
                    .tint(Color(.systemGray))
                }
                .contextMenu {
                    Button {
                        openOnGitHub(entry)
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
                        toggleRead(entry, unread: unread)
                    } label: {
                        Label(unread ? "Mark as Read" : "Mark as Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh(clients) }
        .overlay {
            if entries.isEmpty, notices.isEmpty {
                if Self.settled(clients, store: store) {
                    ContentUnavailableView("Nothing in the Inbox", systemImage: "tray")
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Inbox")
        .task(id: openKey(clients)) { await load(clients) }
    }

    private func open(_ entry: InboxEntry) {
        store.markRead(entry)
        path.append(Route.inboxItem(environmentId: entry.environmentId, item: entry.item))
    }

    private func openOnGitHub(_ entry: InboxEntry) {
        if let url = URL(string: entry.item.url) { openURL(url) }
    }

    /// The weight swaps at once: a mark is a keyboard-speed action, never animated.
    private func toggleRead(_ entry: InboxEntry, unread: Bool) {
        Motion.withoutAnimation {
            if unread { store.markRead(entry) } else { store.markUnread(entry) }
        }
    }

    private func openKey(_ clients: [EnvironmentClient]) -> String {
        clients.map { "\($0.environment.id):\($0.status.transport == .open)" }.joined(separator: ",")
    }

    /// The key cannot refresh: every connected host's key is read-only, or a
    /// refresh already came back forbidden.
    private func refreshDenied(_ clients: [EnvironmentClient]) -> Bool {
        if refreshRefused { return true }
        let connected = clients.filter { $0.status.transport == .open }
        return !connected.isEmpty && connected.allSatisfy { $0.operateBlock == .readOnly }
    }

    /// The host's stored snapshot (SQLite, never the network), landing without
    /// animation: on the first open, and again when the tab comes back after a
    /// minute, since the desktop may have refreshed it meanwhile.
    private func load(_ clients: [EnvironmentClient]) async {
        for client in clients where client.status.transport == .open && store.shouldAsk(client.environment.id) {
            store.markAsked(client.environment.id)
            guard let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) else { continue }
            Motion.withoutAnimation { store.put(snapshot, for: client.environment.id) }
        }
        openForProof(clients)
    }

    /// The pull: GitHub is asked again and the rows move under the default
    /// animation. A read-only key is known before the call and reads the
    /// stored snapshot instead; a refusal the host answers is read the same way.
    private func refresh(_ clients: [EnvironmentClient]) async {
        refreshRefused = false
        for client in clients where client.status.transport == .open {
            if client.operateBlock == .readOnly {
                refreshRefused = true
                await readStored(client)
                continue
            }
            do {
                let snapshot = try await client.request(Methods.GithubInboxRefresh.self, .init(reason: .manual))
                withAnimation(.default) { store.put(snapshot, for: client.environment.id) }
            } catch let error as TransportError where error.isForbidden {
                refreshRefused = true
                await readStored(client)
            } catch {
                continue
            }
        }
    }

    private func readStored(_ client: EnvironmentClient) async {
        if let snapshot = try? await client.request(Methods.GithubInbox.self, .init()) {
            withAnimation(.default) { store.put(snapshot, for: client.environment.id) }
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

    /// DEBUG only: `TC_TEST_OPEN=item` (or `item-diff`) pushes the newest pull request for the proof's detail shots.
    private func openForProof(_ clients: [EnvironmentClient]) {
        guard TestHooks.open == "item" || TestHooks.open == "item-diff", !opened else { return }
        let entries = store.entries(clients: clients)
        guard let entry = entries.first(where: { $0.item.kind == .pr }) ?? entries.first else { return }
        opened = true
        open(entry)
    }
}

/// One row, the way Mail lays a message out: the author's picture, the
/// title (semibold while unread) with the time trailing in the stamp step,
/// then a dim line with the kind, the author, the repository and number,
/// what the item waits on in the one color that means it, and the host
/// when there are several. The separator starts at the title.
struct InboxRow: View {
    let entry: InboxEntry
    let unread: Bool
    let status: InboxStatus?
    let showHost: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var avatarSize: CGFloat = 36
    private let gap: CGFloat = 12

    var body: some View {
        let item = entry.item
        let weight: Font.Weight = unread ? .semibold : .regular
        HStack(alignment: .top, spacing: gap) {
            InboxAvatar(url: item.author?.avatarUrl ?? "", login: item.author?.login ?? "", size: avatarSize)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .textStep(.title, weight: weight)
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
                    Spacer(minLength: 0)
                    AgoText(entry.updatedMs)
                }
                InboxRowMeta(entry: entry, weight: weight, status: status, showHost: showHost)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: Layout.rowHeight)
        .separatorAtTextEdge(avatarSize + gap)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(unread ? "\(item.title), new" : item.title)
    }

    /// The name after the owner: one owner is the common case, and the phone has no room for it.
    static func repoName(_ repo: String) -> String {
        repo.split(separator: "/").last.map(String.init) ?? repo
    }
}

/// The dim line under the title: the kind glyph (its stroke the title's
/// weight), the author, the repository and number, the status word in its
/// color, the host. One line that truncates the repository first; at
/// accessibility sizes two lines, who over what, so the status never pushes
/// the row past the screen.
private struct InboxRowMeta: View {
    let entry: InboxEntry
    let weight: Font.Weight
    let status: InboxStatus?
    let showHost: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize, status != nil || showHost {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) { who }
                    HStack(spacing: 8) { what }
                }
            } else {
                HStack(spacing: 8) {
                    HStack(spacing: 4) { who }
                    what
                }
            }
        }
        .font(TextStep.meta.font)
    }

    @ViewBuilder private var who: some View {
        let item = entry.item
        let isPr = item.kind == .pr
        MetaGlyph(isPr ? "arrow.triangle.pull" : "circle.circle", weight: weight, label: isPr ? "Pull request" : "Issue")
        if let author = item.author?.login, !author.isEmpty {
            Text(author)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .layoutPriority(1)
        }
        Text("\(InboxRow.repoName(item.repo)) #\(item.number)")
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    @ViewBuilder private var what: some View {
        if let status {
            Text(status.text)
                .foregroundStyle(status.tone.color)
                .lineLimit(1)
                .layoutPriority(1)
        }
        if showHost {
            HStack(spacing: 3) {
                MetaGlyph("desktopcomputer", label: "Host")
                Text(entry.hostName)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }
}
