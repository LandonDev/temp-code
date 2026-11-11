import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct CacheWriterTests {
    @Test func `writes land in the order they were queued: a reset page never after the rows pushed behind it`() async throws {
        let cache = try SessionCache.inMemory()
        let writer = CacheWriter(cache: cache)
        writer.write { try? await $0.store("e", sessionId: "s", rows: (1...5).map { textRow("s", seq: $0) }, moreBefore: true) }
        writer.write { try? await $0.store("e", sessionId: "s", rows: (40...42).map { textRow("s", seq: $0) }, moreBefore: false, reset: true) }
        writer.write { try? await $0.store("e", sessionId: "s", rows: [textRow("s", seq: 43)]) }
        await writer.drained()
        #expect(try await cache.tail("e", sessionId: "s").rows.map(\.seq) == [40, 41, 42, 43])
    }

    @Test func `drained returns once everything queued before it is written`() async throws {
        actor Log {
            var steps: [Int] = []
            func add(_ step: Int) { steps.append(step) }
        }
        let log = Log()
        let writer = CacheWriter(cache: try SessionCache.inMemory())
        writer.write { _ in
            try? await Task.sleep(for: .milliseconds(20))
            await log.add(1)
        }
        writer.write { _ in await log.add(2) }
        await writer.drained()
        #expect(await log.steps == [1, 2])
    }

    @Test func `pushed rows are counted against the bound once in fifty stores, a page at once`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("e", sessionId: "s", rows: (1...1_300).map { textRow("s", seq: $0) }, moreBefore: false)
        // A row at a time past the bound: nothing is counted, so nothing is pruned, until the fiftieth.
        for seq in 1_301...1_349 { try await cache.store("e", sessionId: "s", rows: [textRow("s", seq: seq)]) }
        #expect(try await cache.oldestSeq("e", sessionId: "s") == 1)
        try await cache.store("e", sessionId: "s", rows: [textRow("s", seq: 1_350)])
        #expect(try await cache.oldestSeq("e", sessionId: "s") == 351)
        #expect(try await cache.cursor("e", sessionId: "s") == 1_350)
    }
}

@Suite struct NeedsYouCountTests {
    @Test func `the badge's count is needs-you's, with no item built`() {
        let metas = [
            meta("a", status: .waiting), meta("b", parentId: "a", status: .waiting), meta("c", status: .error),
            meta("d", parentId: "a", status: .error), meta("e", status: .paused), meta("f", parentId: "a", status: .paused),
            meta("g", status: .waiting, archived: true), meta("h", status: .running), meta("i", status: .idle)
        ]
        #expect(HomeModel.needsYouCount(metas) == HomeModel.needsYou(metas).count)
        #expect(HomeModel.needsYouCount(metas) == 4)
        #expect(HomeModel.needsYouCount([]) == 0)
    }
}
