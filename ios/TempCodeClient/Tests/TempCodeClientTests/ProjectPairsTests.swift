import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The desktop's pairing cases (src/renderer/src/lib/projectPairs.test.ts)
/// ported, plus Home's key and the host-word rule.
private func ws(_ path: String, name: String? = nil, repo: String? = nil, id: String? = nil) -> WorkspaceMeta {
    let base = path.split(separator: "/").last.map(String.init) ?? path
    return WorkspaceMeta(id: id ?? path, name: name ?? base, path: path, git: true, accountPins: nil, githubRepo: repo, githubRepoCheckedAt: nil, createdAt: 1)
}

private func host(_ id: String, _ workspaces: [WorkspaceMeta]) -> HostWorkspaces {
    HostWorkspaces(environmentId: id, workspaces: workspaces)
}

private let appPairs = ProjectPairs.pairs([
    host("local", [ws("/Users/me/app")]),
    host("box", [ws("/work/app"), ws("/work/app/vendor/lib", name: "lib")])
])

@Suite struct ProjectPairsTests {
    @Test func `pairs two hosts' copies by GitHub repo, else by folder name, one member per host`() {
        let pairs = ProjectPairs.pairs([
            host("local", [ws("/Users/me/IdeaProjects/temp-code", repo: "LandonDev/temp-code"), ws("/Users/me/shop"), ws("/Users/me/solo")]),
            host("box", [ws("/srv/agents/work/temp-code/", repo: "landondev/TEMP-CODE"), ws("/srv/agents/work/shop"), ws("/srv/agents/work/other/shop")])
        ])
        #expect(pairs.map(\.id) == ["repo:landondev/temp-code", "name:shop", "name:solo"])
        #expect(pairs.map { $0.members.map { "\($0.environmentId):\($0.cwd)" } } == [
            ["local:/Users/me/IdeaProjects/temp-code", "box:/srv/agents/work/temp-code"],
            ["local:/Users/me/shop", "box:/srv/agents/work/shop"],
            ["local:/Users/me/solo"]
        ])
        #expect(pairs[0].name == "temp-code")
        #expect(pairs[0].isPaired)
        #expect(!pairs[2].isPaired)
        #expect(pairs[0].members[1].workspaceId == "/srv/agents/work/temp-code/")
    }

    @Test func `keys on the repo when known, the folder name otherwise`() {
        #expect(ProjectPairs.key(ws("/a/B", repo: "O/R")) == "repo:o/r")
        #expect(ProjectPairs.key(ws("/a/B/")) == "name:b")
        #expect(ProjectPairs.key(ws("/a/B", repo: "  ")) == "name:b")
        #expect(ProjectPairs.key(ws("/a/B")) == "name:b")
    }

    @Test func `finds the deepest member folder holding a path on that host`() {
        #expect(ProjectPairs.pair(of: "/work/app/src/x.ts", on: "box", in: appPairs)?.pair.id == "name:app")
        #expect(ProjectPairs.pair(of: "/work/app/vendor/lib/y.ts", on: "box", in: appPairs)?.pair.id == "name:lib")
        #expect(ProjectPairs.pair(of: "/work/application/z.ts", on: "box", in: appPairs) == nil)
        #expect(ProjectPairs.pair(of: "/work/app/src/x.ts", on: "local", in: appPairs) == nil)
    }

    @Test func `gives the path relative to its member's folder`() {
        let file = ProjectPairs.relative("/Users/me/app/src/x.ts", on: "local", in: appPairs)
        #expect(file?.pair.id == "name:app")
        #expect(file?.relative == "src/x.ts")
        let root = ProjectPairs.relative("/work/app", on: "box", in: appPairs)
        #expect(root?.pair.id == "name:app")
        #expect(root?.relative == "")
        #expect(ProjectPairs.relative("/elsewhere", on: "box", in: appPairs) == nil)
    }

    @Test func `names the other hosts' copies`() {
        #expect(ProjectPairs.partners(of: "/Users/me/app/README.md", on: "local", in: appPairs) == [
            PairMember(environmentId: "box", workspaceId: "/work/app", cwd: "/work/app", name: "app")
        ])
        #expect(ProjectPairs.partners(of: "/work/app/vendor/lib/y.ts", on: "box", in: appPairs).isEmpty)
    }

    @Test func `the home key is the pair id for a host's first workspace with that key and the workspace's own for a second`() {
        let hosts = [
            host("local", [ws("/Users/me/shop", id: "w1")]),
            host("box", [ws("/srv/agents/work/shop", id: "w2"), ws("/srv/agents/work/other/shop", id: "w3")])
        ]
        #expect(ProjectPairs.homeKey("local", ws("/Users/me/shop", id: "w1"), hosts: hosts) == "name:shop")
        #expect(ProjectPairs.homeKey("box", ws("/srv/agents/work/shop", id: "w2"), hosts: hosts) == "name:shop")
        #expect(ProjectPairs.homeKey("box", ws("/srv/agents/work/other/shop", id: "w3"), hosts: hosts) == "box:w3")
    }

    @Test func `the home pairing closure says what the home key says`() {
        let hosts = [
            host("local", [ws("/Users/me/shop", id: "w1")]),
            host("box", [ws("/srv/agents/work/shop", id: "w2"), ws("/srv/agents/work/other/shop", id: "w3")])
        ]
        let pairing: @Sendable (String, WorkspaceMeta) -> String = ProjectPairs.homePairing(hosts)
        for (env, workspace) in [("local", ws("/Users/me/shop", id: "w1")), ("box", ws("/srv/agents/work/other/shop", id: "w3"))] {
            #expect(pairing(env, workspace) == ProjectPairs.homeKey(env, workspace, hosts: hosts))
        }
    }

    @Test(arguments: [(0, false), (1, false), (2, true), (3, true)])
    func `a row names its host only with more than one paired host`(count: Int, shows: Bool) {
        #expect(ProjectPairs.showsHost(hostCount: count) == shows)
    }

    @Test func `normalize and basename strip trailing slashes`() {
        #expect(ProjectPairs.normalize("/a/b/") == "/a/b")
        #expect(ProjectPairs.normalize("/") == "/")
        #expect(ProjectPairs.basename("/a/b/") == "b")
        #expect(ProjectPairs.basename("/") == "/")
    }
}
