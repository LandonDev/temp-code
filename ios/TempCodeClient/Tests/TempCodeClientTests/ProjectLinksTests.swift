import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The settings home of a linked project, ported from
/// src/shared/projectLinks.test.ts's settingsHomeOf cases, and the sheet's target.
private func copy(_ environmentId: String, _ projectId: String = "p") -> ProjectCopy {
    ProjectCopy(environmentId: environmentId, projectId: projectId)
}

private func project(_ id: String, link: String? = nil) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: "w", name: id, mode: .local, branch: nil, cwd: "/w/\(id)", archived: false, linkId: link, createdAt: 1)
}

private let platforms: [String: String] = ["env_mac": "darwin", "env_box": "linux", "env_box2": "linux"]
private let platformOf: @Sendable (String) -> String? = { platforms[$0] }

@Suite struct SettingsHomeTests {
    @Test func `is the copy off darwin`() {
        #expect(ProjectLinks.settingsHome([copy("env_mac"), copy("env_box", "b")], platformOf: platformOf) == copy("env_box", "b"))
        #expect(ProjectLinks.settingsHome([copy("env_box", "b"), copy("env_mac")], platformOf: platformOf) == copy("env_box", "b"))
    }

    @Test func `two copies of one platform: the id that sorts first`() {
        #expect(ProjectLinks.settingsHome([copy("env_box2"), copy("env_box")], platformOf: platformOf)?.environmentId == "env_box")
        #expect(ProjectLinks.settingsHome([copy("env_mac"), copy("env_mac0")], platformOf: { $0.hasPrefix("env_mac") ? "darwin" : nil })?.environmentId == "env_mac")
    }

    @Test func `a host not yet heard from counts as a box; one copy is its own home; none is nil`() {
        #expect(ProjectLinks.settingsHome([copy("env_mac"), copy("env_unknown")], platformOf: platformOf)?.environmentId == "env_unknown")
        #expect(ProjectLinks.settingsHome([copy("env_mac")], platformOf: platformOf)?.environmentId == "env_mac")
        #expect(ProjectLinks.settingsHome([], platformOf: platformOf) == nil)
    }
}

@Suite struct ProjectCopiesTests {
    private let hosts: [(environmentId: String, projects: [ProjectMeta])] = [
        ("env_mac", [project("pm", link: "pl_1"), project("solo")]),
        ("env_box", [project("other", link: "pl_2"), project("pb", link: "pl_1")])
    ]

    @Test func `a linked project's copies are every host's row with its link, in host order`() {
        #expect(ProjectLinks.copies(of: project("pm", link: "pl_1"), on: "env_mac", hosts: hosts) == [copy("env_mac", "pm"), copy("env_box", "pb")])
        #expect(ProjectLinks.copies(of: project("pb", link: "pl_1"), on: "env_box", hosts: hosts) == [copy("env_mac", "pm"), copy("env_box", "pb")])
    }

    @Test func `a project with no link, or a link no other host holds, is its own only copy`() {
        #expect(ProjectLinks.copies(of: project("solo"), on: "env_mac", hosts: hosts) == [copy("env_mac", "solo")])
        #expect(ProjectLinks.copies(of: project("other", link: "pl_2"), on: "env_box", hosts: hosts) == [copy("env_box", "other")])
    }

    @Test func `a second row of one host under one link stays its own`() {
        let twins: [(environmentId: String, projects: [ProjectMeta])] = [("env_mac", [project("a", link: "pl_1"), project("b", link: "pl_1")]), ("env_box", [project("pb", link: "pl_1")])]
        #expect(ProjectLinks.copies(of: project("b", link: "pl_1"), on: "env_mac", hosts: twins) == [copy("env_mac", "b")])
    }
}

@Suite struct SettingsTargetTests {
    private let hosts: [(environmentId: String, projects: [ProjectMeta])] = [
        ("env_mac", [project("pm", link: "pl_1"), project("solo")]),
        ("env_box", [project("pb", link: "pl_1")])
    ]

    @Test func `a menu on the Mac's copy reads and saves the box's copy`() {
        let target = ProjectLinks.target(for: project("pm", link: "pl_1"), on: "env_mac", hosts: hosts, platformOf: platformOf)
        #expect(target.home == copy("env_box", "pb"))
        #expect(target.isLinked)
        #expect(target.footer(hostName: "box") == "Saved on box")
    }

    @Test func `an unlinked project saves where it is and says nothing about where`() {
        let target = ProjectLinks.target(for: project("solo"), on: "env_mac", hosts: hosts, platformOf: platformOf)
        #expect(target.home == copy("env_mac", "solo"))
        #expect(!target.isLinked)
        #expect(target.footer(hostName: "Mac") == nil)
    }

    @Test func `a home out of reach gives the reason, named after the home when linked`() {
        let linked = SettingsTarget(home: copy("env_box", "pb"), copies: 2)
        #expect(linked.saveReason(nil, hostName: "box", now: 0) == nil)
        #expect(linked.saveReason(.offline(reason: nil), hostName: "box", now: 0) == "Settings live on box. Offline")
        #expect(linked.saveReason(.noAdmin, hostName: "box", now: 0) == "Settings live on box. This key can read these settings but not change them")
        let single = SettingsTarget(home: copy("env_mac", "solo"), copies: 1)
        #expect(single.saveReason(.offline(reason: nil), hostName: "Mac", now: 0) == "Offline")
    }
}

@Suite struct HostKindTests {
    @Test(arguments: [("darwin", HostKind.mac), ("linux", .server), (nil, .server)] as [(String?, HostKind)])
    func `a Mac by its platform, anything else a server`(platform: String?, kind: HostKind) {
        #expect(HostKind(platform: platform) == kind)
    }

    @Test func `draws a laptop for a Mac and a rack for a server`() {
        #expect(HostKind.mac.symbol == "laptopcomputer")
        #expect(HostKind.server.symbol == "server.rack")
    }
}
