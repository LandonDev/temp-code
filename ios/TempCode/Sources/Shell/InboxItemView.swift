import SwiftUI
import TempCodeClient
import TempCodeContract

/// One issue or pull request, read-only: the header from the row's own
/// data (so it paints at once), the body and the conversation as quiet
/// markdown, and for a pull request the patch by file and hunk, never side
/// by side. What loaded once stays in the store, so coming back paints
/// from memory. Open on GitHub sits in the bar.
struct InboxItemView: View {
    let client: EnvironmentClient
    let item: GithubInboxItem
    private let store = InboxStore.shared
    @Environment(\.openURL) private var openURL
    @State private var failed = false
    @State private var diffFailed = false

    private var isPullRequest: Bool { item.kind.rawValue == "pr" }
    private var key: String { "\(client.environment.id):\(item.repo)#\(item.number)" }

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
                if let details {
                    if details.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No description.")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                    } else {
                        MarkdownText(text: details.body)
                            .textSelection(.enabled)
                    }
                } else if failed {
                    Text("Couldn't load this from \(client.environment.name).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                }
                if let thread, !thread.comments.isEmpty {
                    InboxConversation(thread: thread)
                }
                if isPullRequest {
                    if let diff {
                        InboxChanges(diff: diff)
                    } else if diffFailed {
                        Text("The changes could not be loaded.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(.horizontal, 16)
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
        .task(id: key) { await load() }
    }

    @ViewBuilder
    private func header(details: GitHubWorkItemDetails?, thread: GitHubWorkItemThread?) -> some View {
        let author = item.author?.login ?? details?.author ?? ""
        let avatar = item.author?.avatarUrl ?? details?.authorAvatarUrl ?? ""
        let status = InboxStatus.of(item, viewer: store.snapshot(for: client.environment.id)?.viewer)
        let head = item.headRefName.isEmpty ? (thread?.headRefName ?? details?.headRefName ?? "") : item.headRefName
        let base = item.baseRefName.isEmpty ? (thread?.baseRefName ?? details?.baseRefName ?? "") : item.baseRefName
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                InboxAvatar(url: avatar, login: author, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(author.isEmpty ? "GitHub" : author)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text("\(item.repo) #\(item.number)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Text(TimeFormat.ago(InboxStore.ms(item.updatedAt)))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            Text(item.title)
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            HStack(spacing: 6) {
                Text(status?.text ?? (item.state.rawValue == "open" ? "Open" : item.state.rawValue.capitalized))
                    .foregroundStyle(status?.tint ?? (item.state.rawValue == "open" ? Tint.success : Color(.tertiaryLabel)))
                    .fixedSize()
                if isPullRequest, !head.isEmpty, !base.isEmpty {
                    Text("·").foregroundStyle(.tertiary)
                    Text("\(head) → \(base)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .font(.footnote)
            if !item.labels.isEmpty {
                InboxLabels(labels: item.labels.map(\.name))
            }
        }
    }

    private func load() async {
        guard let cwd else {
            failed = store.details[key] == nil
            return
        }
        let kind = item.kind.rawValue
        if store.details[key] == nil || store.threads[key] == nil {
            async let detailsCall = try? client.request(Methods.GithubDetails.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
            async let threadCall = try? client.request(Methods.GithubThread.self, .init(cwd: cwd, kind: .init(rawValue: kind), number: item.number, repo: item.repo))
            if let details = await detailsCall { store.putDetails(details, for: key) }
            if let thread = await threadCall { store.putThread(thread, for: key) }
            failed = store.details[key] == nil
        }
        if isPullRequest, store.diffs[key] == nil {
            if let diff = try? await client.request(Methods.GithubPrDiff.self, .init(cwd: cwd, number: item.number)) {
                store.putDiff(diff, for: key)
            } else {
                diffFailed = true
            }
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
                    .background(Color(.tertiarySystemFill), in: Capsule())
            }
        }
    }
}

/// Children laid left to right, wrapping to the next line when the row is full.
private struct FlowRow: Layout {
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
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("\(count)")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
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

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            InboxAvatar(url: comment.authorAvatarUrl, login: comment.author, size: 24)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(comment.author.isEmpty ? "GitHub" : comment.author)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if let review = InboxReviewState.label(comment.state) {
                        Text(review.text)
                            .font(.footnote)
                            .foregroundStyle(review.tint ?? Color(.tertiaryLabel))
                            .fixedSize()
                    }
                    if comment.resolved {
                        Text("Resolved")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                    Spacer(minLength: 8)
                    Text(TimeFormat.ago(InboxStore.ms(comment.createdAt)))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
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

/// The pull request's patch: a count line, then one fold per file with its
/// hunks, dim line numbers in mono one step down, adds and deletes tinted.
/// The first file opens; the rest open on tap. Long patches show their first
/// 2,000 lines until asked for the rest.
private struct InboxChanges: View {
    let diff: GithubPrDiff
    @State private var open: Set<String> = []
    @State private var primed = false
    @State private var showAll = false
    private let cap = 2_000

    var body: some View {
        let files = PatchFile.parse(diff)
        let total = files.reduce(0) { $0 + $1.lines.count }
        VStack(alignment: .leading, spacing: 12) {
            Hairline()
            HStack(spacing: 6) {
                Text("Changes")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(files.count == 1 ? "1 file" : "\(files.count) files")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 8)
                ChangeStat(adds: diff.additions, dels: diff.deletions)
                    .font(.footnote)
                    .monospacedDigit()
            }
            if diff.truncated {
                Text("The patch is too large to show; the files are listed without it.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            if files.isEmpty {
                Text("No file changes.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            let budgets = budgets(files)
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                PatchFileView(file: file, expanded: open.contains(file.id), budget: budgets[index]) {
                    withAnimation(open.contains(file.id) ? Motion.collapse : Motion.expand) {
                        if open.contains(file.id) { open.remove(file.id) } else { open.insert(file.id) }
                    }
                }
            }
            if total > cap, !showAll {
                Button("Show all \(total) lines") { showAll = true }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.pressable)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .onAppear {
            guard !primed else { return }
            primed = true
            if let first = files.first { open = [first.id] }
        }
    }

    /// How many lines each open file may show before the cap: the files above it spend the budget first.
    private func budgets(_ files: [PatchFile]) -> [Int] {
        var shown = 0
        var out: [Int] = []
        for file in files {
            out.append(showAll ? Int.max : max(0, cap - shown))
            if open.contains(file.id) { shown += file.lines.count }
        }
        return out
    }
}

private struct PatchFileView: View {
    let file: PatchFile
    let expanded: Bool
    let budget: Int
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 12)
                    Text(file.displayPath)
                        .font(.system(.footnote, design: .monospaced).weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 8)
                    if file.binary {
                        Text("Binary")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    } else {
                        ChangeStat(adds: file.additions, dels: file.deletions)
                            .font(.caption)
                            .monospacedDigit()
                    }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("\(file.displayPath), \(expanded ? "expanded" : "collapsed")")
            if expanded {
                Hairline()
                if file.binary || file.lines.isEmpty {
                    Text(file.binary ? "Binary file." : "No patch for this file.")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .padding(12)
                } else {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(file.lines.prefix(budget).enumerated()), id: \.offset) { _, line in
                                PatchLineRow(line: line)
                            }
                            if file.lines.count > budget {
                                Text("\(file.lines.count - budget) more lines")
                                    .font(.footnote)
                                    .foregroundStyle(.tertiary)
                                    .padding(12)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .scrollIndicators(.hidden)
                    .transition(reduced ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
    }

    private var reduced: Bool { reduceMotion }
}

private struct PatchLineRow: View {
    let line: PatchLine

    var body: some View {
        if line.kind == .hunk {
            Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.quaternarySystemFill))
        } else {
            HStack(spacing: 0) {
                Text(line.number.map { String($0) } ?? "")
                    .foregroundStyle(.tertiary)
                    .frame(width: 40, alignment: .trailing)
                Text(marker)
                    .foregroundStyle(markerColor)
                    .frame(width: 18)
                Text(line.text)
                    .foregroundStyle(line.kind == .context ? .secondary : .primary)
                Spacer(minLength: 16)
            }
            .font(.system(.footnote, design: .monospaced))
            .monospacedDigit()
            .padding(.vertical, 1)
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
        }
    }

    private var marker: String {
        switch line.kind {
        case .add: "+"
        case .del: "−"
        default: " "
        }
    }

    private var markerColor: Color {
        switch line.kind {
        case .add: Tint.success
        case .del: Tint.destructive
        default: Color(.tertiaryLabel)
        }
    }

    private var background: Color {
        switch line.kind {
        case .add: Tint.success.opacity(0.12)
        case .del: Tint.destructive.opacity(0.12)
        default: .clear
        }
    }
}

// MARK: - the patch

struct PatchLine: Hashable {
    enum Kind: Hashable {
        case add, del, context, hunk
    }

    let kind: Kind
    let text: String
    let oldNumber: Int?
    let newNumber: Int?

    /// The one number a unified view shows: the new line, or the old one for a deletion.
    var number: Int? { kind == .del ? oldNumber : newNumber }
}

/// One file of a unified patch, the desktop's `parsePrPatch` in Swift,
/// merged with the counts `gh pr view` reports.
struct PatchFile: Identifiable, Hashable {
    enum Status: Hashable {
        case added, deleted, renamed, modified
    }

    var path: String
    var previousPath: String?
    var status: Status = .modified
    var binary = false
    var additions = 0
    var deletions = 0
    var lines: [PatchLine] = []

    var id: String { path }

    var displayPath: String {
        if let previousPath, status == .renamed { return "\(previousPath) → \(path)" }
        return path
    }

    nonisolated static func parse(_ diff: GithubPrDiff) -> [PatchFile] {
        let parsed = parse(patch: diff.patch)
        if parsed.isEmpty {
            return diff.files.map { PatchFile(path: $0.path, additions: $0.additions, deletions: $0.deletions) }
        }
        if diff.files.isEmpty { return parsed }
        var byPath = Dictionary(parsed.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [PatchFile] = []
        for meta in diff.files {
            if var hit = byPath.removeValue(forKey: meta.path) {
                hit.additions = meta.additions
                hit.deletions = meta.deletions
                out.append(hit)
            } else {
                out.append(PatchFile(path: meta.path, additions: meta.additions, deletions: meta.deletions))
            }
        }
        for file in parsed where byPath[file.path] != nil {
            out.append(file)
        }
        return out
    }

    nonisolated static func parse(patch: String) -> [PatchFile] {
        let text = patch.replacingOccurrences(of: "\r\n", with: "\n")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var files: [PatchFile] = []
        var block: [Substring] = []
        func flush() {
            if !block.isEmpty, let file = parseFile(block) { files.append(file) }
            block = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") { flush() }
            block.append(line)
        }
        flush()
        return files
    }

    private nonisolated static func parseFile(_ lines: [Substring]) -> PatchFile? {
        var file = PatchFile(path: "")
        var oldNumber = 0
        var newNumber = 0
        var inHunk = false
        for line in lines {
            if line.hasPrefix("diff --git ") {
                if let (from, to) = gitPaths(line.dropFirst("diff --git ".count)) {
                    file.previousPath = from == to ? nil : from
                    file.path = to
                }
                continue
            }
            if line.hasPrefix("new file mode") {
                file.status = .added
                continue
            }
            if line.hasPrefix("deleted file mode") {
                file.status = .deleted
                continue
            }
            if line.hasPrefix("rename from ") {
                file.previousPath = String(line.dropFirst("rename from ".count))
                file.status = .renamed
                continue
            }
            if line.hasPrefix("rename to ") {
                file.path = String(line.dropFirst("rename to ".count))
                file.status = .renamed
                continue
            }
            if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") {
                file.binary = true
                continue
            }
            if line.hasPrefix("--- ") {
                let next = stripPath(line.dropFirst(4))
                if next == "/dev/null" {
                    if file.status == .modified { file.status = .added }
                } else if !next.isEmpty, file.previousPath == nil, next != file.path {
                    file.previousPath = next
                }
                continue
            }
            if line.hasPrefix("+++ ") {
                let next = stripPath(line.dropFirst(4))
                if next == "/dev/null" {
                    file.status = .deleted
                } else if !next.isEmpty {
                    file.path = next
                }
                continue
            }
            if line.hasPrefix("@@ "), let (old, new) = hunkStart(line) {
                inHunk = true
                oldNumber = old
                newNumber = new
                file.lines.append(PatchLine(kind: .hunk, text: String(line), oldNumber: nil, newNumber: nil))
                continue
            }
            guard inHunk else { continue }
            if line.hasPrefix("+") {
                file.additions += 1
                file.lines.append(PatchLine(kind: .add, text: String(line.dropFirst()), oldNumber: nil, newNumber: newNumber))
                newNumber += 1
            } else if line.hasPrefix("-") {
                file.deletions += 1
                file.lines.append(PatchLine(kind: .del, text: String(line.dropFirst()), oldNumber: oldNumber, newNumber: nil))
                oldNumber += 1
            } else if line.hasPrefix("\\") {
                continue
            } else {
                file.lines.append(PatchLine(kind: .context, text: String(line.dropFirst(line.hasPrefix(" ") ? 1 : 0)), oldNumber: oldNumber, newNumber: newNumber))
                oldNumber += 1
                newNumber += 1
            }
        }
        if file.previousPath == file.path { file.previousPath = nil }
        return file.path.isEmpty ? nil : file
    }

    /// "a/x b/y" → ("x", "y"); the split is at " b/", the first path's own spaces kept.
    private nonisolated static func gitPaths(_ rest: Substring) -> (String, String)? {
        guard let range = rest.range(of: " b/") else { return nil }
        let from = rest[rest.startIndex..<range.lowerBound]
        let to = rest[range.upperBound...]
        return (stripPath(from), String(to))
    }

    /// Drops the `a/` or `b/` prefix, the trailing tab stamp, and the quotes git puts around odd names.
    private nonisolated static func stripPath(_ raw: Substring) -> String {
        var path = Substring(raw)
        if let tab = path.firstIndex(of: "\t") { path = path[..<tab] }
        path = Substring(path.trimmingCharacters(in: .whitespaces))
        if path.hasPrefix("\""), path.hasSuffix("\""), path.count >= 2 { path = path.dropFirst().dropLast() }
        if path.hasPrefix("a/") || path.hasPrefix("b/") { path = path.dropFirst(2) }
        return String(path)
    }

    private nonisolated static func hunkStart(_ line: Substring) -> (Int, Int)? {
        // @@ -12,7 +12,9 @@ …
        let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        let old = Int(parts[1].dropFirst().split(separator: ",").first ?? "") ?? 0
        let new = Int(parts[2].dropFirst().split(separator: ",").first ?? "") ?? 0
        return (old, new)
    }
}
