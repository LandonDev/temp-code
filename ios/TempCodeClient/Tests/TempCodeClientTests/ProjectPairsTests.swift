import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Copies fold by the link id the hosts stamped, and by nothing else: the
/// same repo or folder name without a shared `linkId` stays two rows.
private func ws(_ path: String, name: String? = nil, repo: String? = nil, id: String? = nil, link: String? = nil) -> WorkspaceMeta {
    let base = path.split(separator: "/").last.map(String.init) ?? path
    return WorkspaceMeta(id: id ?? path, name: name ?? base, path: path, git: true, accountPins: nil, githubRepo: repo, githubRepoCheckedAt: nil, linkId: link, createdAt: 1)
}

private func project(_ id: String, link: String? = nil) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: "w", name: id, mode: .local, branch: nil, cwd: "/w/\(id)", archived: false, linkId: link, createdAt: 1)
}

private func host(_ id: String, _ workspaces: [WorkspaceMeta]) -> HostWorkspaces {
    HostWorkspaces(environmentId: id, workspaces: workspaces)
}

private let appPairs = ProjectPairs.pairs([
    host("local", [ws("/Users/me/app", link: "wl_app")]),
    host("box", [ws("/work/app", link: "wl_app"), ws("/work/app/vendor/lib", name: "lib")])
])

@Suite struct ProjectPairsTests {
    @Test func `pairs two hosts' copies by link id only, one member per host`() {
        let pairs = ProjectPairs.pairs([
            host("local", [ws("/Users/me/IdeaProjects/temp-code", repo: "LandonDev/temp-code", link: "wl_tc"), ws("/Users/me/shop"), ws("/Users/me/solo", link: "wl_solo")]),
            host("box", [ws("/srv/agents/work/temp-code/", link: "wl_tc"), ws("/srv/agents/work/shop")])
        ])
        #expect(pairs.map(\.id) == ["link:wl_tc", "local:/Users/me/shop", "link:wl_solo", "box:/srv/agents/work/shop"])
        #expect(pairs.map { $0.members.map { "\($0.environmentId):\($0.cwd)" } } == [
            ["local:/Users/me/IdeaProjects/temp-code", "box:/srv/agents/work/temp-code"],
            ["local:/Users/me/shop"],
            ["local:/Users/me/solo"],
            ["box:/srv/agents/work/shop"]
        ])
        #expect(pairs[0].name == "temp-code")
        #expect(pairs[0].isPaired)
        #expect(!pairs[1].isPaired)
        #expect(pairs[0].members[1].workspaceId == "/srv/agents/work/temp-code/")
    }

    @Test func `the same repo or folder name without a shared link stays apart`() {
        let pairs = ProjectPairs.pairs([
            host("local", [ws("/Users/me/app", repo: "o/app")]),
            host("box", [ws("/work/app", repo: "o/app", link: "wl_box")])
        ])
        #expect(pairs.map(\.id) == ["local:/Users/me/app", "link:wl_box"])
        #expect(pairs.allSatisfy { !$0.isPaired })
    }

    @Test func `a second row of one host under one link stays its own`() {
        let pairs = ProjectPairs.pairs([
            host("box", [ws("/work/a", id: "w1", link: "wl_x"), ws("/work/b", id: "w2", link: "wl_x")]),
            host("mac", [ws("/Users/me/a", id: "w3", link: "wl_x")])
        ])
        #expect(pairs.map(\.id) == ["link:wl_x", "box:w2"])
        #expect(pairs[0].members.map(\.workspaceId) == ["w1", "w3"])
    }

    @Test func `keys on the link id, else on the host and the row`() {
        #expect(ProjectPairs.key("box", ws("/a/B", id: "w", link: "wl_1")) == "link:wl_1")
        #expect(ProjectPairs.key("box", ws("/a/B", repo: "O/R", id: "w")) == "box:w")
        #expect(ProjectPairs.key("box", ws("/a/B", id: "w", link: "  ")) == "box:w")
        #expect(ProjectPairs.key("mac", project("p", link: "pl_1")) == "link:pl_1")
        #expect(ProjectPairs.key("mac", project("p")) == "mac:p")
    }

    @Test func `finds the deepest member folder holding a path on that host`() {
        #expect(ProjectPairs.pair(of: "/work/app/src/x.ts", on: "box", in: appPairs)?.pair.id == "link:wl_app")
        #expect(ProjectPairs.pair(of: "/work/app/vendor/lib/y.ts", on: "box", in: appPairs)?.pair.id == "box:/work/app/vendor/lib")
        #expect(ProjectPairs.pair(of: "/work/application/z.ts", on: "box", in: appPairs) == nil)
        #expect(ProjectPairs.pair(of: "/work/app/src/x.ts", on: "local", in: appPairs) == nil)
    }

    @Test func `gives the path relative to its member's folder`() {
        let file = ProjectPairs.relative("/Users/me/app/src/x.ts", on: "local", in: appPairs)
        #expect(file?.pair.id == "link:wl_app")
        #expect(file?.relative == "src/x.ts")
        let root = ProjectPairs.relative("/work/app", on: "box", in: appPairs)
        #expect(root?.pair.id == "link:wl_app")
        #expect(root?.relative == "")
        #expect(ProjectPairs.relative("/elsewhere", on: "box", in: appPairs) == nil)
    }

    @Test func `names the other hosts' copies`() {
        #expect(ProjectPairs.partners(of: "/Users/me/app/README.md", on: "local", in: appPairs) == [
            PairMember(environmentId: "box", workspaceId: "/work/app", cwd: "/work/app", name: "app")
        ])
        #expect(ProjectPairs.partners(of: "/work/app/vendor/lib/y.ts", on: "box", in: appPairs).isEmpty)
    }

    @Test(arguments: [(0, false), (1, false), (2, true), (3, true)])
    func `a row names its host only with more than one paired host`(count: Int, shows: Bool) {
        #expect(ProjectPairs.showsHost(hostCount: count) == shows)
    }

    @Test func `normalize strips trailing slashes`() {
        #expect(ProjectPairs.normalize("/a/b/") == "/a/b")
        #expect(ProjectPairs.normalize("/") == "/")
    }
}
