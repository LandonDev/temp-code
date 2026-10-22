import SwiftUI
import TempCodeClient
import TempCodeContract

/// One issue or pull request, read-only: the header from the row's own
/// data (so it paints at once), the body and the conversation as quiet
/// markdown, and for a pull request the changed files as a list, each row
/// opening that file's slice of the patch in the diff screen. What loaded
/// once stays in the store, so coming back paints from memory. Open on
/// GitHub sits in the bar.
struct InboxItemView: View {
    let client: EnvironmentClient
    let item: GithubInboxItem
    private let store = InboxStore.shared
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var failed = false
    @State private var diffFailed = false
    /// Bumped by Retry; the load task keys on it.
    @State private var attempt = 0
    /// DEBUG: the diff the proof pushes once the patch is in.
    @State private var proofRoute: PatchDiffRoute?
    @State private var proofPushed = false
    @ScaledMetric(relativeTo: .subheadline) private var avatarSize: CGFloat = 32

    private var isPullRequest: Bool { item.kind == .pr }
    private var key: String { InboxModel.key(environmentId: client.environment.id, item: item) }

    /// The checkout gh runs in: the workspace of the repo, else any git workspace.
    private var cwd: String? {
        client.workspaces.first { $0.githubRepo?.lowercased() == item.repo.lowercased() }?.path
            ?? client.workspaces.first { $0.git }?.path
    }

    var body: some View {
        let details = store.details[key]
        let thread = store.threads[key]
        let diff = store.diffs[key]
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header(details: details, thread: thread)
                description(details)
                if let thread, !thread.comments.isEmpty {
                    InboxConversation(thread: thread)
                }
                if isPullRequest {
                    changes(diff)
                }
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Surface.background)
        .navigationTitle(isPullRequest ? "Pull Request" : "Issue")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if let url = URL(string: item.url) { openURL(url) }
                } label: {
                    Label("Open on GitHub", systemImage: "safari")
                }
            }
        }
        // The hand-off to the diff thread's screen: a file row's value, and the proof's push.
        .navigationDestination(for: PatchDiffRoute.self) { route in DiffScreen(route: route) }
        .navigationDestination(item: $proofRoute) { route in DiffScreen(route: route) }
        .task(id: "\(key)|\(cwd ?? "")|\(attempt)") { await load() }
    }

    // MARK: - header

    @ViewBuilder
    private func header(details: GitHubWorkItemDetails?, thread: GitHubWorkItemThread?) -> some View {
        let author = item.author?.login ?? details?.author ?? ""
        let avatar = item.author?.avatarUrl ?? details?.authorAvatarUrl ?? ""
        let status = InboxModel.status(of: item, viewer: store.snapshot(for: client.environment.id)?.viewer)
        let head = item.headRefName.isEmpty ? (thread?.headRefName ?? details?.headRefName ?? "") : item.headRefName
        let base = item.baseRefName.isEmpty ? (thread?.baseRefName ?? details?.baseRefName ?? "") : item.baseRefName
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                InboxAvatar(url: avatar, login: author, size: avatarSize)
                VStack(alignment: .leading, spacing: 1) {
                    Text(author.isEmpty ? "GitHub" : author)
                        .textStep(.title, weight: .semibold)
                        .lineLimit(1)
                    Text("\(item.repo) #\(item.number)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                AgoText(InboxModel.ms(item.updatedAt))
            }
            Text(item.title)
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Text(status?.text ?? (item.state == .open ? "Open" : item.state.rawValue.capitalized))
                    .foregroundStyle(status?.tone.color ?? (item.state == .open ? Tint.success : Color(.tertiaryLabel)))
                    .lineLimit(1)
                    .layoutPriority(1)
                if isPullRequest, !head.isEmpty, !base.isEmpty {
                    Text("\(head) → \(base)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .font(TextStep.meta.font)
            if !item.labels.isEmpty {
                InboxLabels(labels: item.labels.map(\.name))
            }
        }
    }

    // MARK: - body

    /// The description: a shimmer of the height it will take, then the
    /// markdown cross-faded over it (a plain swap under reduced motion).
    @ViewBuilder
    private func description(_ details: GitHubWorkItemDetails?) -> some View {
        Group {
            if let details {
                if details.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("No description.")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                } else {
                    MarkdownText(text: details.body)
                        .textSelection(.enabled)
                }
            } else if cwd == nil {
                Text("No checkout of \(item.repo) on \(client.environment.name).")
                    .textStep(.meta)
            } else if failed {
                InboxLoadFailed(text: "Couldn't load this from \(client.environment.name).") { retry() }
            } else {
                Shimmer(height: 72)
            }
        }
        .transition(.opacity)
        .animation(reduceMotion ? nil : Motion.crossFade, value: details == nil)
    }

    // MARK: - changes

    @ViewBuilder
    private func changes(_ diff: GitHubPrDiff?) -> some View {
        Group {
            if let diff {
                InboxChanges(title: "\(item.repo) #\(item.number)", diff: diff)
            } else if cwd != nil {
                if diffFailed {
                    InboxLoadFailed(text: "The changes could not be loaded.") { retry() }
                } else {
                    Shimmer(height: 88)
                }
            }
        }
        .transition(.opacity)
        .animation(reduceMotion ? nil : Motion.crossFade, value: diff == nil)
    }

    private func retry() {
        failed = false
        diffFailed = false
        attempt += 1
    }

    // MARK: - loading

    /// The details and the conversation together, then the diff; each lands
    /// in the store as it comes, and a cancelled load settles nothing.
    private func load() async {
        guard let cwd else { return }
        let kind = item.kind.rawValue
        if store.details[key] == nil || store.threads[key] == nil {
            async let detailsCall = try? client.request(Methods.GithubDetails.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
            async let threadCall = try? client.request(Methods.GithubThread.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
            let (details, thread) = await (detailsCall, threadCall)
            guard !Task.isCancelled else { return }
            if let details { store.putDetails(details, for: key) }
            if let thread { store.putThread(thread, for: key) }
            failed = store.details[key] == nil
        }
        if isPullRequest, store.diffs[key] == nil {
            let diff = try? await client.request(Methods.GithubPrDiff.self, .init(cwd: cwd, number: item.number))
            guard !Task.isCancelled else { return }
            if let diff {
                store.putDiff(diff, for: key)
            } else {
                diffFailed = true
            }
        }
        openDiffForProof()
    }

    /// DEBUG only: `TC_TEST_OPEN=item-diff` pushes the first file's diff once the patch is in.
    private func openDiffForProof() {
        guard TestHooks.open == "item-diff", !proofPushed, let diff = store.diffs[key] else { return }
        guard let change = InboxPatch.changes(diff).first(where: { $0.patch != nil }), let patch = change.patch else { return }
        proofPushed = true
        proofRoute = PatchDiffRoute(title: change.path, patch: patch)
    }
}

/// A load that failed: the line and Retry, in the meta step.
private struct InboxLoadFailed: View {
    let text: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(text)
                .textStep(.meta)
            PillButton("Retry", action: retry)
        }
    }
}

/// Label names as small capsules on the fill step. Their GitHub colors stay
/// on GitHub: here color means state, nothing else.
private struct InboxLabels: View {
    let labels: [String]

    var body: some View {
        FlowRow(spacing: 6) {
            ForEach(labels, id: \.self) { label in
                Text(label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Surface.fill, in: Capsule())
            }
        }
    }
}

/// Children laid left to right, wrapping to the next line when the row is full.
private nonisolated struct FlowRow: SwiftUI.Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - conversation

/// The conversation: comments, reviews and review threads in time order,
/// each with its author's picture, the review it carried in the color that
/// means it, where in the code it sits, and its replies one step in.
private struct InboxConversation: View {
    let thread: GitHubWorkItemThread

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Hairline()
            HStack(spacing: 6) {
                Text("Conversation")
                    .textStep(.meta, weight: .semibold)
                Text("\(count)")
                    .textStep(.stamp)
            }
            ForEach(thread.comments, id: \.id) { comment in
                InboxCommentView(comment: comment)
            }
            if thread.truncated {
                Text("Older comments are on GitHub.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var count: Int {
        func total(_ comments: [GitHubWorkItemComment]) -> Int {
            comments.reduce(0) { $0 + 1 + total($1.replies) }
        }
        return total(thread.comments)
    }
}

private struct InboxCommentView: View {
    let comment: GitHubWorkItemComment
    @ScaledMetric(relativeTo: .footnote) private var avatarSize: CGFloat = 24

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            InboxAvatar(url: comment.authorAvatarUrl, login: comment.author, size: avatarSize)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(comment.author.isEmpty ? "GitHub" : comment.author)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if let verdict = InboxModel.reviewVerdict(comment.state) {
                        Text(verdict.text)
                            .font(.footnote)
                            .foregroundStyle(verdict.tone.color)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    if comment.resolved {
                        Text("Resolved")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    Spacer(minLength: 8)
                    AgoText(InboxModel.ms(comment.createdAt))
                }
                if !comment.path.isEmpty {
                    Text(comment.line.map { "\(comment.path):\($0)" } ?? comment.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if !comment.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownText(text: comment.body)
                        .textSelection(.enabled)
                }
                if !comment.replies.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(comment.replies, id: \.id) { reply in
                            InboxCommentView(comment: reply)
                        }
                    }
                    .padding(.top, 8)
                }
            }
        }
    }
}

// MARK: - changes

/// The pull request's changed files: a count line, then a card of rows, one
/// per file with its `+n −m`, each opening that file's slice of the patch in
/// the diff screen; "All files" first when there are several. A file whose
/// block the host did not send (binary, or a patch cut short) cannot open.
private struct InboxChanges: View {
    let title: String
    let diff: GitHubPrDiff

    var body: some View {
        let changes = InboxPatch.changes(diff)
        VStack(alignment: .leading, spacing: 12) {
            Hairline()
            HStack(spacing: 6) {
                Text("Changes")
                    .textStep(.meta, weight: .semibold)
                Text(changes.count == 1 ? "1 file" : "\(changes.count) files")
                    .textStep(.stamp)
            }
            if changes.isEmpty {
                Text("No file changes.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            } else {
                VStack(spacing: 0) {
                    if changes.count > 1 {
                        InboxChangeRow(route: PatchDiffRoute(title: title, patch: diff.patch), enabled: !diff.patch.isEmpty) {
                            Text("All files")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(diff.patch.isEmpty ? .tertiary : .primary)
                        } trailing: {
                            ChangeStat(adds: diff.additions, dels: diff.deletions)
                        }
                        Hairline(inset: 12)
                    }
                    ForEach(Array(changes.enumerated()), id: \.element.id) { index, change in
                        if index > 0 { Hairline(inset: 12) }
                        InboxChangeRow(route: change.patch.map { PatchDiffRoute(title: change.path, patch: $0) }, enabled: change.patch != nil) {
                            InboxChangePath(change: change, enabled: change.patch != nil)
                        } trailing: {
                            if change.binary {
                                Text("Binary")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            } else {
                                ChangeStat(adds: change.additions, dels: change.deletions)
                            }
                        }
                    }
                }
                .groupCard()
            }
            if diff.truncated {
                Text("The rest of the patch is on GitHub.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

/// One row of the Changes card: a push to the diff screen with the kit's
/// press, or the same row inert when there is nothing to open.
private struct InboxChangeRow<Label: View, Trailing: View>: View {
    let route: PatchDiffRoute?
    let enabled: Bool
    @ViewBuilder let label: () -> Label
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        let content = HStack(spacing: 8) {
            label()
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 12)
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        if let route, enabled {
            NavigationLink(value: route) { content }
                .buttonStyle(.pressable)
        } else {
            content
        }
    }
}

/// A path in two steps on one line: the directory dim, the file name
/// primary, in mono one step down, the head truncated so the name survives.
private struct InboxChangePath: View {
    let change: InboxChange
    let enabled: Bool

    var body: some View {
        let name = Board.fileName(change.displayPath)
        let directory = String(change.displayPath.dropLast(name.count))
        (Text(directory).foregroundStyle(.tertiary) + Text(name).foregroundStyle(enabled ? .primary : .tertiary))
            .font(.system(.footnote, design: .monospaced))
            .lineLimit(1)
            .truncationMode(.head)
            .accessibilityLabel(change.displayPath)
    }
}
