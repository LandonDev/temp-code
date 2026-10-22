import Foundation
import Testing
@testable import TempCodeClient

/// The desktop's cases (src/renderer/src/lib/pathHost.test.ts) ported, plus
/// the phone's owners, the media URL's host and the upload rule.
private let primary = "local"
private let catalogs = [
    HostCatalog(environmentId: "env_mac", roots: ["/Users/me/IdeaProjects/temp-code", "/Users/me/shop/"]),
    HostCatalog(environmentId: "env_box", roots: ["/srv/agents/work/temp-code"])
]

@Suite struct PathHostTests {
    @Test func `a path under a catalog root opens on that root's host`() {
        #expect(PathHost.host(forPath: "/x", owners: ["env_box"], threadHost: nil, primary: primary) == "env_box")
        #expect(PathHost.host(forPath: "/x", owners: ["env_box"], threadHost: "env_box", primary: primary) == "env_box")
    }

    @Test func `a Mac project's file a box thread named opens on the Mac`() {
        #expect(PathHost.host(forPath: "/x", owners: [primary], threadHost: "env_box", primary: primary) == primary)
    }

    @Test func `a path outside every root opens on the thread's host, not this machine`() {
        #expect(PathHost.host(forPath: "/x", owners: [], threadHost: "env_box", primary: primary) == "env_box")
    }

    @Test func `a path no thread named and no root holds is one the person opened here`() {
        #expect(PathHost.host(forPath: "/x", owners: [], threadHost: nil, primary: primary) == primary)
    }

    @Test func `two hosts holding the same root: the thread's host wins`() {
        #expect(PathHost.host(forPath: "/x", owners: [primary, "env_box"], threadHost: "env_box", primary: primary) == "env_box")
        #expect(PathHost.host(forPath: "/x", owners: [primary, "env_box"], threadHost: nil, primary: primary) == primary)
    }

    @Test func `owners are the hosts whose project cwd or workspace path holds the path`() {
        #expect(PathHost.owners(of: "/Users/me/IdeaProjects/temp-code/src/a.ts", catalogs: catalogs) == ["env_mac"])
        #expect(PathHost.owners(of: "/Users/me/shop/x", catalogs: catalogs) == ["env_mac"])
        #expect(PathHost.owners(of: "/srv/agents/work/temp-code/", catalogs: catalogs) == ["env_box"])
        #expect(PathHost.owners(of: "/srv/agents/work/temp-code-2/x", catalogs: catalogs).isEmpty)
        #expect(PathHost.owners(of: "/tmp/shot.png", catalogs: catalogs).isEmpty)
    }

    @Test func `with no owner the path opens on the thread's host`() {
        #expect(PathHost.host(ofPath: "/tmp/shot.png", threadHost: "env_box", catalogs: catalogs) == "env_box")
        #expect(PathHost.host(ofPath: "/Users/me/shop/x", threadHost: "env_box", catalogs: catalogs) == "env_mac")
    }

    @Test func `the media URL's host query names whose bytes they are`() throws {
        let stamped = try #require(URL(string: "tempcode-asset://file/tok123/shot.png?v=1&host=env_x"))
        #expect(PathHost.environment(ofMediaURL: stamped) == "env_x")
        let bare = try #require(URL(string: "tempcode-asset://file/tok123/shot.png?v=1"))
        #expect(PathHost.environment(ofMediaURL: bare) == nil)
        let encoded = try #require(URL(string: "tempcode-asset://file/tok123/shot.png?host=env%5Fy&v=1"))
        #expect(PathHost.environment(ofMediaURL: encoded) == "env_y")
        let empty = try #require(URL(string: "tempcode-asset://file/tok123/shot.png?host="))
        #expect(PathHost.environment(ofMediaURL: empty) == nil)
    }

    @Test func `a missing file says where it is missing from`() {
        let message = "/tmp/shot.png: ENOENT: no such file or directory, stat '/tmp/shot.png'"
        #expect(PathHost.failureText(message, hostName: "The box") == "No such file on The box.")
        #expect(PathHost.failureText(message, hostName: nil) == "No such file.")
        #expect(PathHost.failureText(nil, hostName: "box") == "No such file on box.")
        #expect(PathHost.failureText(nil, hostName: nil) == "No such file.")
    }

    @Test func `every other failure keeps the host's words`() {
        #expect(PathHost.failureText("Binary files cannot be edited.", hostName: "The box") == "Binary files cannot be edited.")
        #expect(PathHost.failureText("ENOENTITY", hostName: "box") == "ENOENTITY")
    }

    @Test func `a photo uploads to the thread's host`() {
        #expect(PathHost.uploadHost(threadHost: "env_box") == "env_box")
    }
}
