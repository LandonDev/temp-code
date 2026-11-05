import Foundation
import Testing
@testable import TempCodeClient

/// The memory moved to v3 when a thread came to live in its project's
/// shell: v2's routes name screens that are gone, so a v2 restore keeps the
/// tab alone and opens every column at its root.
@Suite struct NavigationSnapshotTests {
    @Test func `the key is the third version`() {
        #expect(NavigationSnapshot.key == "navigation.memory.v3")
        #expect(NavigationSnapshot.v2Key == "navigation.memory.v2")
    }

    @Test func `a v2 snapshot keeps its tab and toggle and drops its routes`() throws {
        // v2's shape: a project's list in the sidebar, a thread at the detail's root.
        let v2 = Data(#"{"tab":"search","sidebarShown":false,"columns":{"home":{"sidebar":[{"workspace":{"key":"w"}},{"project":{"key":"p"}}],"detailRoot":{"thread":{"environmentId":"e","sessionId":"s","seq":3}}}}}"#.utf8)
        let back = try #require(NavigationSnapshot.restore(v3: nil, v2: v2))
        #expect(back.tab == .search)
        #expect(!back.sidebarShown)
        #expect(back.columns.isEmpty)
        #expect(back[.home] == ColumnMemory())
    }

    @Test func `v3 wins over v2, and nothing saved restores nothing`() throws {
        var snapshot = NavigationSnapshot(tab: .inbox)
        snapshot[.home] = ColumnMemory(detailRoot: .project(key: "k", thread: "e:s"))
        let v2 = Data(#"{"tab":"search","columns":{}}"#.utf8)
        #expect(NavigationSnapshot.restore(v3: try JSONEncoder().encode(snapshot), v2: v2) == snapshot)
        #expect(NavigationSnapshot.restore(v3: nil, v2: nil) == nil)
        #expect(NavigationSnapshot.restore(v3: Data("junk".utf8), v2: nil) == nil)
    }
}
