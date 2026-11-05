import Foundation
import Testing
@testable import TempCodeClient

/// The thread last on screen in each project's shell, under the scope's key.
@Suite struct ProjectLandingMemoryTests {
    @Test func `the last thread or the draft is kept per key, the newest kept past the cap`() {
        var landings = ShellLandings()
        let first = landings.remember(.thread("e:a"), for: "link:pl_1")
        let same = landings.remember(.thread("e:a"), for: "link:pl_1")
        let draft = landings.remember(.draft, for: "link:pl_1")
        #expect(first && !same && draft)
        #expect(landings["link:pl_1"] == .draft)
        for index in 0..<ShellLandings.maxEntries { landings.remember(.thread("e:\(index)"), for: "k\(index)") }
        #expect(landings.entries.count == ShellLandings.maxEntries)
        #expect(landings["link:pl_1"] == nil)
        #expect(landings["k0"] == .thread("e:0"))
    }

    @MainActor
    @Test func `the store reads back what a shell on screen showed, a draft as the draft`() throws {
        let defaults = try #require(UserDefaults(suiteName: "ProjectLandingMemoryTests"))
        defaults.removePersistentDomain(forName: "ProjectLandingMemoryTests")
        let store = ShellLandingStore(defaults: defaults)
        store.remember(.project(key: "link:pl_1", thread: "e:a", seq: 4))
        store.remember(.project(key: "loose:wl_1"))
        store.remember(.thread(environmentId: "e", sessionId: "bare", seq: nil))
        let again = ShellLandingStore(defaults: defaults)
        #expect(again["link:pl_1"] == .thread("e:a"))
        #expect(again["loose:wl_1"] == .draft)
        #expect(again.landings.entries.count == 2)
        defaults.removePersistentDomain(forName: "ProjectLandingMemoryTests")
    }
}
