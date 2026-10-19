import SwiftUI
import TempCodeClient
import TempCodeContract

/// One issue or pull request, read-only: the body, the conversation, and
/// for a pull request the files and the patch.
struct InboxItemView: View {
    let client: EnvironmentClient
    let item: GithubInboxItem
    @State private var details: GitHubWorkItemDetails?
    @State private var thread: GitHubWorkItemThread?
    @State private var diff: GitHubPrDiff?
    @State private var failed = false

    private var isPullRequest: Bool { item.kind.rawValue == "pr" }

    /// The checkout gh runs in: the workspace of the repo, else any git workspace.
    private var cwd: String? {
        client.workspaces.first { $0.githubRepo?.lowercased() == item.repo.lowercased() }?.path
            ?? client.workspaces.first { $0.git }?.path
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(item.repo) #\(item.number)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(item.title)
                        .font(.headline)
                    HStack(spacing: 4) {
                        if let author = item.author?.login, !author.isEmpty { Text(author) }
                        Text("·")
                        Text(item.state.rawValue.capitalized)
                        if let note = InboxNote.of(item) {
                            Text("·")
                            Text(note.text).foregroundStyle(note.tint)
                        }
                        if isPullRequest, !item.headRefName.isEmpty {
                            Text("·")
                            Text("\(item.headRefName) → \(item.baseRefName)")
                                .lineLimit(1)
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                if let details {
                    if details.body.isEmpty {
                        Text("No description")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    } else {
                        MarkdownText(text: details.body)
                    }
                } else if failed {
                    Text("Could not load this from the host.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                }
                if let thread, !thread.comments.isEmpty {
                    SectionHeader("Conversation")
                        .padding(.horizontal, -16)
                    ForEach(thread.comments, id: \.id) { comment in
                        CommentView(comment: comment)
                    }
                    if thread.truncated {
                        Text("Older comments are on GitHub.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
                if let diff {
                    SectionHeader("Changes") {
                        Text("+\(diff.additions)").foregroundStyle(Tint.success) + Text(" −\(diff.deletions)").foregroundStyle(Tint.destructive)
                    }
                    .font(.footnote)
                    .monospacedDigit()
                    .padding(.horizontal, -16)
                    ForEach(diff.files, id: \.path) { file in
                        HStack(spacing: 8) {
                            Text(file.path)
                                .font(.footnote)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 8)
                            (Text("+\(file.additions)").foregroundStyle(Tint.success) + Text(" −\(file.deletions)").foregroundStyle(Tint.destructive))
                                .font(.caption2)
                                .monospacedDigit()
                        }
                    }
                    if !diff.patch.isEmpty {
                        ScrollView(.horizontal) {
                            Text(diff.patch)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .padding(12)
                        }
                        .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(isPullRequest ? "Pull request" : "Issue")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: item.number) { await load() }
    }

    private func load() async {
        guard let cwd else {
            failed = true
            return
        }
        let kind = item.kind.rawValue
        async let detailsCall = try? client.request(Methods.GithubDetails.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
        async let threadCall = try? client.request(Methods.GithubThread.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
        details = await detailsCall
        thread = await threadCall
        failed = details == nil
        if isPullRequest {
            diff = try? await client.request(Methods.GithubPrDiff.self, .init(cwd: cwd, number: item.number))
        }
    }
}

/// One comment and its replies, one step in.
private struct CommentView: View {
    let comment: GitHubWorkItemComment

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(comment.author)
                    .font(.footnote.weight(.semibold))
                if !comment.path.isEmpty {
                    Text(comment.line.map { "\(comment.path):\($0)" } ?? comment.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                Text(TimeFormat.ago(Int(InboxView.date(comment.createdAt).timeIntervalSince1970 * 1000)))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            MarkdownText(text: comment.body)
            ForEach(comment.replies, id: \.id) { reply in
                CommentView(comment: reply)
                    .padding(.leading, 16)
            }
        }
    }
}
