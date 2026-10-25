import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// One instance of every `Route` case: a new case must be listed here and given a column.
private let everyRoute: [Route] = [
    .thread(environmentId: "e", sessionId: "s", seq: nil),
    .workspace(key: "w"),
    .project(key: "p"),
    .archivedThreads(environmentId: "e", projectId: "p"),
    .archivedProjects(environmentId: "e", workspaceId: "w"),
    .settings,
    .hosts
]

@Suite struct ShellPathsTests {
    @Test func `every route has a column: the lists in the sidebar, the screens in the detail`() {
        #expect(everyRoute.count == 7)
        let sidebar = everyRoute.filter { ShellPaths.column(of: $0) == .sidebar }
        let detail = everyRoute.filter { ShellPaths.column(of: $0) == .detail }
        #expect(sidebar.count + detail.count == everyRoute.count)
        #expect(sidebar == [.workspace(key: "w"), .project(key: "p"), .archivedThreads(environmentId: "e", projectId: "p"), .archivedProjects(environmentId: "e", workspaceId: "w")])
        #expect(detail.count == 3)
        #expect(ShellPaths.column(of: .settings) == .detail)
        #expect(ShellPaths.column(of: .hosts) == .detail)
    }

    @Test func `a snapshot round-trips through JSON with a detail open`() throws {
        var snapshot = NavigationSnapshot(tab: .inbox, sidebarShown: false)
        snapshot[.home] = ColumnMemory(sidebar: [.workspace(key: "w"), .project(key: "p")], detailRoot: .thread(environmentId: "e", sessionId: "s", seq: 12), detailStack: Data([1, 2, 3]))
        snapshot[.search] = ColumnMemory(detailRoot: .thread(environmentId: "e", sessionId: "hit", seq: 4))
        let data = try JSONEncoder().encode(snapshot)
        let back = try JSONDecoder().decode(NavigationSnapshot.self, from: data)
        #expect(back == snapshot)
        #expect(back[.home].sidebar == [.workspace(key: "w"), .project(key: "p")])
        #expect(back[.home].detailRoot == .thread(environmentId: "e", sessionId: "s", seq: 12))
        #expect(back[.home].detailStack == Data([1, 2, 3]))
        #expect(back[.search].detailRoot == .thread(environmentId: "e", sessionId: "hit", seq: 4))
        // The tabs key the object by name, so a hand-read snapshot is legible.
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"home\""))
        #expect(text.contains("\"search\""))
    }

    @Test func `a snapshot round-trips with no detail and reads empty columns for a tab it never saw`() throws {
        var snapshot = NavigationSnapshot()
        snapshot[.home] = ColumnMemory(sidebar: [.workspace(key: "w")])
        let back = try JSONDecoder().decode(NavigationSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(back == snapshot)
        #expect(back.tab == .home)
        #expect(back.sidebarShown)
        #expect(back[.home].detailRoot == nil)
        #expect(back[.home].detailStack == nil)
        #expect(back[.inbox] == ColumnMemory())
    }

    @Test func `the key is the second version`() {
        #expect(NavigationSnapshot.key == "navigation.memory.v2")
    }
}
