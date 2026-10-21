import SwiftUI
import TempCodeClient
import TempCodeContract

/// One issue or pull request, read-only: the header the list already knows,
/// the body, the conversation as quiet markdown, and for a pull request the
/// patch by file and hunk with dim line numbers, never side by side. The
/// header paints at once; the rest lands when the host answers, with a
/// spinner only after 300 ms so a fast answer never flashes one.
struct InboxItemView: View {
    let client: EnvironmentClient
    let item: GithubInboxItem
    @Environment(\.openURL) private var openURL
    @State private var details: GitHubWorkItemDetails?
    @State private var thread: GitHubWorkItemThread?
    @State private var diff: GitHubPrDiff?
    /// The patch parsed once, when the diff lands, never in the body.
    @State private var patchFiles: [PatchFile] = []
    @State private var patchTruncated = false
    @State private var failed = false
    @State private var slow = false

    /// The checkout gh runs in: the workspace of the repo, else any git workspace.
    private var cwd: String? {
        client.workspaces.first { $0.githubRepo?.lowercased() == item.repo.lowercased() }?.path
            ?? client.workspaces.first { $0.git }?.path
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 16)
                description
                    .padding(.horizontal, 16)
                    .padding(.bottom, 20)
                if let thread, !thread.comments.isEmpty {
                    SectionHeader("Conversation") {
                        Text("\(thread.comments.count)")
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(thread.comments, id: \.id) { comment in
                        InboxCommentView(comment: comment)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                        Hairline().padding(.leading, 16)
                    }
                    if thread.truncated {
                        Text("Older comments are on GitHub.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .padding(16)
                    }
                }
                if let diff {
                    SectionHeader("Changes") {
                        HStack(spacing: 8) {
                            Text(patchFiles.count == 1 ? "1 file" : "\(patchFiles.count) files")
                                .foregroundStyle(.tertiary)
                            DiffCounts(additions: diff.additions, deletions: diff.deletions)
                        }
                        .font(.footnote)
                        .monospacedDigit()
                    }
                    ForEach(Array(patchFiles.enumerated()), id: \.element.id) { index, file in
                        PatchFileView(file: file, expanded: index == 0)
                    }
                    if patchTruncated {
                        Text("The patch is too long to show in full; the files are listed without the rest.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .padding(16)
                    }
                    if patchFiles.isEmpty {
                        Text("No file changes.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .padding(16)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 24)
        }
        .navigationTitle("#\(item.number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    openURL(URL(string: item.url) ?? URL(fileURLWithPath: "/"))
                } label: {
                    Label("Open on GitHub", systemImage: "safari")
                }
            }
        }
        .task(id: item.number) { await load() }
    }

    /// The title, who opened it, the reference with the state word and the
    /// labels dim, and for a pull request the branches in mono one step down.
    private var header: some View {
        let state = InboxState.of(item, viewer: nil)
        return VStack(alignment: .leading, spacing: 10) {
            Text(item.title)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                InboxAvatar(url: item.author?.avatarUrl ?? "", login: item.author?.login ?? "", size: 22)
                Text(item.author?.login ?? "")
                    .font(.footnote.weight(.medium))
                Text("·").foregroundStyle(.quaternary)
                Text("updated \(TimeFormat.ago(item.updatedMs))")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Image(systemName: item.kindGlyph)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                    Text(item.reference)
                        .foregroundStyle(.tertiary)
                    if let state {
                        Text("·").foregroundStyle(.quaternary)
                        Text(state.text).foregroundStyle(state.tint)
                    } else {
                        Text("·").foregroundStyle(.quaternary)
                        Text(item.state.rawValue.capitalized).foregroundStyle(.tertiary)
                    }
                    if !item.labels.isEmpty {
                        Text("·").foregroundStyle(.quaternary)
                        Text(item.labels.map(\.name).joined(separator: ", "))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .font(.footnote)
                if item.isPullRequest, !item.headRefName.isEmpty {
                    HStack(spacing: 5) {
                        Text(item.headRefName)
                        Image(systemName: "arrow.right")
                            .font(.caption2.weight(.medium))
                            .accessibilityLabel("into")
                        Text(item.baseRefName)
                    }
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private var description: some View {
        if let details {
            if details.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("No description.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            } else {
                MarkdownText(text: details.body)
            }
        } else if failed {
            Text("Couldn't load this from \(client.environment.name).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if slow {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
        } else {
            Color.clear.frame(height: 48)
        }
    }

    private func load() async {
        guard let cwd else {
            failed = true
            return
        }
        let wait = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled, details == nil, !failed { slow = true }
        }
        let kind = item.kind.rawValue
        async let detailsCall = try? client.request(Methods.GithubDetails.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
        async let threadCall = try? client.request(Methods.GithubThread.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
        let (loadedDetails, loadedThread) = await (detailsCall, threadCall)
        wait.cancel()
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            details = loadedDetails
            thread = loadedThread
            failed = loadedDetails == nil
            slow = false
        }
        if item.isPullRequest {
            let loadedDiff = try? await client.request(Methods.GithubPrDiff.self, .init(cwd: cwd, number: item.number))
            let parsed = loadedDiff.map { diff in PatchFile.parse(diff) }
            withTransaction(transaction) {
                diff = loadedDiff
                patchFiles = parsed?.files ?? []
                patchTruncated = parsed?.truncated ?? false
            }
        }
    }
}

/// `+n` in success, `−m` in destructive, tabular.
struct DiffCounts: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 6) {
            Text("+\(additions)").foregroundStyle(Tint.success)
            Text("−\(deletions)").foregroundStyle(Tint.destructive)
        }
        .monospacedDigit()
    }
}

/// One comment: the avatar, the author with a review's verdict in its color,
/// the file and line of a review comment in mono, the time trailing; the
/// body as markdown; replies one step in. A resolved thread steps back.
private struct InboxCommentView: View {
    let comment: GitHubWorkItemComment
    var depth = 0

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            InboxAvatar(url: comment.authorAvatarUrl, login: comment.author, size: depth == 0 ? 28 : 22)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(comment.author.isEmpty ? "ghost" : comment.author)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if let verdict = InboxState.ofReview(comment.state) {
                        Text(verdict.text)
                            .font(.footnote)
                            .foregroundStyle(verdict.tint)
                            .lineLimit(1)
                    }
                    if comment.resolved {
                        Text("Resolved")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 8)
                    Text(TimeFormat.ago(inboxMs(comment.createdAt)))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                if !comment.path.isEmpty, depth == 0 {
                    Text(comment.line.map { "\(comment.path):\($0)" } ?? comment.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if !comment.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownText(text: comment.body)
                }
                ForEach(comment.replies, id: \.id) { reply in
                    InboxCommentView(comment: reply, depth: depth + 1)
                        .padding(.top, 8)
                }
            }
        }
        .opacity(comment.resolved && depth == 0 ? 0.6 : 1)
    }
}

/// One file of the patch: a header row with the path and its counts that
/// folds the hunks under it (the first file open, the rest closed), then the
/// lines: old and new numbers dim in mono, the sign in the change's color,
/// the text in mono one step down. Long lines scroll sideways as a block.
private struct PatchFileView: View {
    let file: PatchFile
    @State var expanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded {
                    withAnimation(Motion.collapse) { expanded = false }
                } else {
                    withAnimation(Motion.expand) { expanded = true }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 12)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(file.path)
                            .font(.footnote.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.head)
                        if let previous = file.previousPath {
                            Text("was \(previous)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                    Spacer(minLength: 8)
                    if file.status != .modified {
                        Text(file.status.rawValue.capitalized)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    DiffCounts(additions: file.additions, deletions: file.deletions)
                        .font(.caption)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("\(file.path), \(file.additions) added, \(file.deletions) removed")
            .accessibilityValue(expanded ? "expanded" : "collapsed")
            if expanded {
                lines
                    .transition(reduceMotion ? .opacity : .opacity.animation(Motion.expandContent))
            }
            Hairline().padding(.leading, 16)
        }
    }

    @ViewBuilder
    private var lines: some View {
        if file.binary {
            Text("Binary file.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        } else if file.lines.isEmpty {
            Text("The patch for this file was not shown.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(file.lines) { line in
                        PatchLineView(line: line)
                    }
                }
                .padding(.bottom, 8)
            }
            .accessibilityLabel("\(file.lines.count) lines")
        }
    }
}

private struct PatchLineView: View {
    let line: PatchLine

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if line.kind == .hunk {
                Text(line.text)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 16)
                    .padding(.vertical, 3)
            } else {
                Text(line.oldNumber.map(String.init) ?? "")
                    .frame(width: 34, alignment: .trailing)
                Text(line.newNumber.map(String.init) ?? "")
                    .frame(width: 34, alignment: .trailing)
                    .padding(.trailing, 6)
                Text(sign)
                    .foregroundStyle(tint ?? Color(.tertiaryLabel))
                    .frame(width: 10)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .padding(.trailing, 16)
            }
        }
        .font(.caption2.monospaced())
        .foregroundStyle(.tertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 1)
        .background(tint?.opacity(0.1) ?? (line.kind == .hunk ? Surface.chrome : .clear))
        .accessibilityElement(children: .combine)
    }

    private var sign: String {
        switch line.kind {
        case .add: "+"
        case .delete: "−"
        default: ""
        }
    }

    private var tint: Color? {
        switch line.kind {
        case .add: Tint.success
        case .delete: Tint.destructive
        default: nil
        }
    }
}
