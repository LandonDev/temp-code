import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func inboxItem(
    _ number: Int,
    repo: String = "acme/app",
    kind: String = "pr",
    state: String = "open",
    updatedAt: String = "2026-10-20T10:00:00Z",
    draft: Bool = false,
    review: String = "NONE",
    checks: String? = nil,
    reviewRequested: [String] = [],
    title: String = "Title"
) -> GithubInboxItem {
    GithubInboxItem(
        kind: .init(rawValue: kind), repo: repo, number: number, title: title,
        url: "https://github.com/\(repo)/pull/\(number)", state: .init(rawValue: state), draft: draft,
        updatedAt: updatedAt, author: GithubInboxPerson(login: "ada", avatarUrl: ""), assignees: [], labels: [],
        reviewDecision: .init(rawValue: review), headRefName: "feat", baseRefName: "main",
        checks: checks.map { .init(rawValue: $0) }, reviewRequested: reviewRequested
    )
}

private func snapshot(_ repos: [GithubInboxRepo], auth: GithubInboxAuth = GithubInboxAuth(state: .ok, message: ""), viewer: String? = "me") -> GithubInboxSnapshot {
    GithubInboxSnapshot(viewer: viewer, auth: auth, fetchedAt: 1, refreshing: false, repos: repos)
}

private func repo(_ name: String, items: [GithubInboxItem], error: String? = nil) -> GithubInboxRepo {
    GithubInboxRepo(repo: name, fetchedAt: 1, error: error, items: items)
}

private func entry(_ item: GithubInboxItem, host: String = "h1") -> InboxEntry {
    InboxEntry(environmentId: host, hostName: host, item: item, updatedMs: InboxModel.ms(item.updatedAt))
}

@Suite struct InboxModelTests {
    @Test func `ms parses fractional and whole-second stamps and gives 0 for junk`() {
        #expect(InboxModel.ms("2026-10-20T10:00:00Z") == 1_792_490_400_000)
        #expect(InboxModel.ms("2026-10-20T10:00:00.250Z") == 1_792_490_400_250)
        #expect(InboxModel.ms("yesterday") == 0)
        #expect(InboxModel.ms("") == 0)
    }

    @Test func `entries sort newest first across hosts, then repo, kind, number descending`() {
        let newest = inboxItem(1, repo: "acme/zeta", updatedAt: "2026-10-21T00:00:00Z")
        let sameTimeIssue = inboxItem(7, repo: "acme/app", kind: "issue", updatedAt: "2026-10-20T00:00:00Z")
        let sameTimePr = inboxItem(9, repo: "acme/app", updatedAt: "2026-10-20T00:00:00Z")
        let sameTimePrLower = inboxItem(3, repo: "acme/app", updatedAt: "2026-10-20T00:00:00Z")
        let otherRepo = inboxItem(2, repo: "acme/lib", updatedAt: "2026-10-20T00:00:00Z")
        let hosts = [
            InboxModel.Host(environmentId: "box", name: "The box", snapshot: snapshot([repo("acme/app", items: [sameTimePr, sameTimePrLower]), repo("acme/lib", items: [otherRepo])])),
            InboxModel.Host(environmentId: "mac", name: "Mac", snapshot: snapshot([repo("acme/zeta", items: [newest]), repo("acme/app", items: [sameTimeIssue])])),
            InboxModel.Host(environmentId: "off", name: "Off", snapshot: nil)
        ]
        let out = InboxModel.entries(hosts)
        #expect(out.map(\.item.number) == [1, 7, 9, 3, 2])
        #expect(out.map(\.environmentId) == ["mac", "mac", "box", "box", "box"])
        #expect(out.first?.id == "mac:acme/zeta#1")
        #expect(out.first?.hostName == "Mac")
    }

    @Test(arguments: [
        (inboxItem(1, state: "merged"), InboxStatus(text: "Merged", tone: .violet)),
        (inboxItem(1, state: "closed"), InboxStatus(text: "Closed", tone: .destructive)),
        (inboxItem(1, kind: "issue", state: "closed"), InboxStatus(text: "Closed", tone: .plain)),
        (inboxItem(1, kind: "issue", state: "merged"), InboxStatus(text: "Merged", tone: .violet)),
        (inboxItem(1, draft: true, review: "CHANGES_REQUESTED", checks: "FAILURE"), InboxStatus(text: "Draft", tone: .plain)),
        (inboxItem(1, review: "CHANGES_REQUESTED", checks: "FAILURE"), InboxStatus(text: "Changes requested", tone: .warning)),
        (inboxItem(1, review: "APPROVED", checks: "FAILURE"), InboxStatus(text: "Checks failing", tone: .destructive)),
        (inboxItem(1, review: "APPROVED", checks: "ERROR"), InboxStatus(text: "Checks failing", tone: .destructive)),
        (inboxItem(1, review: "APPROVED", checks: "SUCCESS"), InboxStatus(text: "Approved", tone: .success)),
        (inboxItem(1, reviewRequested: ["ME"]), InboxStatus(text: "Your review", tone: .info))
    ])
    func `status picks the one word in order`(item: GithubInboxItem, expected: InboxStatus) {
        #expect(InboxModel.status(of: item, viewer: "me") == expected)
    }

    @Test func `status is nil for an open issue, a waiting pull request, and a review asked of someone else`() {
        #expect(InboxModel.status(of: inboxItem(1, kind: "issue"), viewer: "me") == nil)
        #expect(InboxModel.status(of: inboxItem(1), viewer: "me") == nil)
        #expect(InboxModel.status(of: inboxItem(1, reviewRequested: ["bob"]), viewer: "me") == nil)
        #expect(InboxModel.status(of: inboxItem(1, reviewRequested: ["me"]), viewer: nil) == nil)
        #expect(InboxModel.status(of: inboxItem(1, reviewRequested: ["me"]), viewer: "") == nil)
    }

    @Test func `review verdicts name approvals, requested changes and dismissals; a comment has none`() {
        #expect(InboxModel.reviewVerdict("APPROVED") == InboxStatus(text: "Approved", tone: .success))
        #expect(InboxModel.reviewVerdict("changes_requested") == InboxStatus(text: "Requested changes", tone: .warning))
        #expect(InboxModel.reviewVerdict("DISMISSED") == InboxStatus(text: "Dismissed", tone: .plain))
        #expect(InboxModel.reviewVerdict("COMMENTED") == nil)
        #expect(InboxModel.reviewVerdict("") == nil)
    }

    @Test func `unread until a mark at or past the update, and again after markUnread`() {
        let item = entry(inboxItem(5, updatedAt: "2026-10-20T10:00:00Z"))
        var seen: [String: Int] = [:]
        #expect(InboxModel.isUnread(item, seen: seen))
        seen[item.id] = item.updatedMs - 1
        #expect(InboxModel.isUnread(item, seen: seen))
        seen[item.id] = item.updatedMs
        #expect(!InboxModel.isUnread(item, seen: seen))
        InboxModel.markUnread(item, in: &seen)
        #expect(seen[item.id] == nil)
        #expect(InboxModel.isUnread(item, seen: seen))
        InboxModel.markRead(item, in: &seen)
        #expect(seen[item.id] == item.updatedMs)
        #expect(!InboxModel.isUnread(item, seen: seen))
    }

    @Test func `markRead never lowers a newer mark`() {
        let item = entry(inboxItem(5, updatedAt: "2026-10-20T10:00:00Z"))
        var seen = [item.id: item.updatedMs + 1_000]
        InboxModel.markRead(item, in: &seen)
        #expect(seen[item.id] == item.updatedMs + 1_000)
    }

    @Test func `seedSeen marks what is older than a day and nothing newer`() {
        let now = InboxModel.ms("2026-10-21T12:00:00Z")
        let old = inboxItem(1, updatedAt: "2026-10-20T11:59:00Z")
        let edge = inboxItem(2, updatedAt: "2026-10-20T12:00:00Z")
        let fresh = inboxItem(3, updatedAt: "2026-10-21T11:00:00Z")
        let marks = InboxModel.seedSeen(snapshot([repo("acme/app", items: [old, edge, fresh])]), environmentId: "box", now: now)
        #expect(marks == ["box:acme/app#1": InboxModel.ms(old.updatedAt)])
    }

    @Test func `notices: one host has no prefix, several do, errors follow auth, refreshDenied comes first`() {
        let signedOut = GithubInboxAuth(state: .loggedOut, message: "gh is not signed in.")
        let one = [InboxModel.Host(environmentId: "a", name: "Mac", snapshot: snapshot([repo("acme/app", items: [], error: "rate limited")], auth: signedOut))]
        #expect(InboxModel.notices(hosts: one, refreshDenied: false) == ["gh is not signed in.", "acme/app: rate limited"])
        let two = one + [InboxModel.Host(environmentId: "b", name: "Box", snapshot: snapshot([repo("acme/lib", items: [])]))]
        #expect(InboxModel.notices(hosts: two, refreshDenied: true) == [
            "This key reads the inbox but cannot refresh it.",
            "Mac: gh is not signed in.",
            "Mac: acme/app: rate limited"
        ])
        let quiet = [InboxModel.Host(environmentId: "a", name: "Mac", snapshot: snapshot([repo("acme/app", items: [])], auth: GithubInboxAuth(state: .error, message: "")))]
        #expect(InboxModel.notices(hosts: quiet, refreshDenied: false).isEmpty)
        #expect(InboxModel.notices(hosts: [InboxModel.Host(environmentId: "a", name: "Mac", snapshot: nil)], refreshDenied: false).isEmpty)
    }
}

@Suite struct InboxPatchTests {
    static let twoFiles = """
    diff --git a/src/a.ts b/src/a.ts
    index 1111..2222 100644
    --- a/src/a.ts
    +++ b/src/a.ts
    @@ -1,3 +1,4 @@
     const a = 1
    -const b = 2
    +const b = 3
    +const c = 4
     export {}
    diff --git a/README.md b/README.md
    --- a/README.md
    +++ b/README.md
    @@ -1 +1 @@
    -old
    +new

    """

    @Test func `split cuts at every diff --git line and counts each file's lines`() {
        let out = InboxPatch.split(Self.twoFiles)
        #expect(out.map(\.path) == ["src/a.ts", "README.md"])
        #expect(out[0].additions == 2)
        #expect(out[0].deletions == 1)
        #expect(out[0].previousPath == nil)
        #expect(out[0].patch?.hasPrefix("diff --git a/src/a.ts b/src/a.ts\n") == true)
        #expect(out[0].patch?.hasSuffix(" export {}") == true)
        #expect(out[1].patch == "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new")
        #expect(out[1].additions == 1)
        #expect(out[1].deletions == 1)
    }

    @Test func `a content line starting with the word diff stays inside its file`() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n diff --git is a line of prose\n+more\n"
        let out = InboxPatch.split(patch)
        #expect(out.count == 1)
        #expect(out[0].additions == 1)
    }

    @Test func `a rename reads both paths and shows them with an arrow`() {
        let patch = "diff --git a/old/name.swift b/new/name.swift\nsimilarity index 90%\nrename from old/name.swift\nrename to new/name.swift\n--- a/old/name.swift\n+++ b/new/name.swift\n@@ -1 +1 @@\n-a\n+b\n"
        let out = InboxPatch.split(patch)
        #expect(out.count == 1)
        #expect(out[0].path == "new/name.swift")
        #expect(out[0].previousPath == "old/name.swift")
        #expect(out[0].displayPath == "old/name.swift → new/name.swift")
        #expect(InboxChange(path: "x").displayPath == "x")
    }

    @Test func `a binary file is marked and has no counts`() {
        let patch = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n"
        let out = InboxPatch.split(patch)
        #expect(out.count == 1)
        #expect(out[0].binary)
        #expect(out[0].additions == 0 && out[0].deletions == 0)
        #expect(out[0].patch == "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ")
        #expect(InboxPatch.split("diff --git a/x.bin b/x.bin\nGIT binary patch\nliteral 3\n")[0].binary)
    }

    @Test func `a quoted path with spaces loses its quotes and prefix`() {
        let patch = "diff --git \"a/docs/My Notes.md\" \"b/docs/My Notes.md\"\n--- \"a/docs/My Notes.md\"\n+++ \"b/docs/My Notes.md\"\n@@ -1 +1 @@\n-a\n+b\n"
        let out = InboxPatch.split(patch)
        #expect(out.map(\.path) == ["docs/My Notes.md"])
        #expect(out[0].previousPath == nil)
    }

    @Test func `CRLF input is normalised and an empty patch gives nothing`() {
        let out = InboxPatch.split("diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n")
        #expect(out.map(\.path) == ["x"])
        #expect(out[0].patch?.contains("\r") == false)
        #expect(out[0].additions == 1)
        #expect(InboxPatch.split("").isEmpty)
        #expect(InboxPatch.split("\n\n").isEmpty)
    }

    @Test func `a block the host cut short keeps the lines it has`() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n-a\n+b\n cont"
        let out = InboxPatch.split(patch)
        #expect(out.count == 1)
        #expect(out[0].additions == 1 && out[0].deletions == 1)
        #expect(out[0].patch?.hasSuffix(" cont") == true)
    }

    @Test func `changes follows the metadata's order and counts, appends blocks it lacks, nil patch for a listed file without one`() {
        let diff = GitHubPrDiff(
            additions: 9, deletions: 4,
            files: [GitHubPrFile(path: "README.md", additions: 5, deletions: 2), GitHubPrFile(path: "assets/logo.png", additions: 0, deletions: 0), GitHubPrFile(path: "src/a.ts", additions: 4, deletions: 2)],
            patch: Self.twoFiles, truncated: true
        )
        let out = InboxPatch.changes(diff)
        #expect(out.map(\.path) == ["README.md", "assets/logo.png", "src/a.ts"])
        #expect(out[0].additions == 5 && out[0].deletions == 2)
        #expect(out[0].patch?.hasPrefix("diff --git a/README.md") == true)
        #expect(out[1].patch == nil)
        #expect(!out[1].binary)
        #expect(out[2].patch?.hasPrefix("diff --git a/src/a.ts") == true)
    }

    @Test func `changes appends a parsed block the metadata does not list, once`() {
        let diff = GitHubPrDiff(additions: 1, deletions: 1, files: [GitHubPrFile(path: "README.md", additions: 1, deletions: 1)], patch: Self.twoFiles, truncated: false)
        let out = InboxPatch.changes(diff)
        #expect(out.map(\.path) == ["README.md", "src/a.ts"])
        #expect(out[1].additions == 2 && out[1].deletions == 1)
    }

    @Test func `changes with no metadata is the parsed patch, and nothing at all is empty`() {
        let parsed = InboxPatch.changes(GitHubPrDiff(additions: 0, deletions: 0, files: [], patch: Self.twoFiles, truncated: false))
        #expect(parsed.map(\.path) == ["src/a.ts", "README.md"])
        #expect(InboxPatch.changes(GitHubPrDiff(additions: 0, deletions: 0, files: [], patch: "", truncated: false)).isEmpty)
    }
}
