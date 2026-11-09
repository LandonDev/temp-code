@testable import Capture
import Foundation
import Testing

@Suite struct ShotNamingTests {
    @Test func theStemIsPaddedUnderTheSessionsDirectory() throws {
        #expect(try ShotNaming.stem(dataDir: "/tmp/data", session: "s1", counter: 7, action: "zoom") == "/tmp/data/shots/s1/0007-zoom")
        #expect(try ShotNaming.stem(dataDir: "/tmp/data/", session: "A_b-9", counter: 12_345, action: "observe") == "/tmp/data/shots/A_b-9/12345-observe")
        #expect(try ShotNaming.stem(dataDir: "/d", session: "s", counter: 0, action: "screenshot") == "/d/shots/s/0000-screenshot")
    }

    @Test func theActionIsLowerCasedAndCut() throws {
        #expect(try ShotNaming.stem(dataDir: "/d", session: "s", counter: 1, action: "Left Click!") == "/d/shots/s/0001-left_click_")
        #expect(try ShotNaming.stem(dataDir: "/d", session: "s", counter: 1, action: "left_click") == "/d/shots/s/0001-left_click")
        #expect(ShotNaming.actionName(String(repeating: "a", count: 40)).count == 32)
        #expect(ShotNaming.actionName("../x/é") == "___x__")
    }

    @Test(arguments: ["..", "a/b", "", String(repeating: "s", count: 65), "a b", "é"])
    func aSessionThatIsNoNameIsRefused(_ session: String) {
        #expect(throws: ShotNameError.self) { try ShotNaming.stem(dataDir: "/d", session: session, counter: 1, action: "zoom") }
    }

    @Test func aRelativeDataDirOrAnEmptyActionIsRefused() {
        #expect(throws: ShotNameError.self) { try ShotNaming.stem(dataDir: "tmp/d", session: "s", counter: 1, action: "zoom") }
        #expect(throws: ShotNameError.self) { try ShotNaming.stem(dataDir: "/d", session: "s", counter: 1, action: "") }
        #expect(throws: ShotNameError.self) { try ShotNaming.stem(dataDir: "/d", session: "s", counter: -1, action: "zoom") }
    }

    @Test func extensions() {
        #expect(ShotNaming.ext(.jpeg) == "jpg")
        #expect(ShotNaming.ext(.png) == "png")
    }
}

@Suite struct ShotCounterTests {
    private func scratch() throws -> String {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tc-shot-counter-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        return directory
    }

    @Test func eachSessionCountsFromOne() throws {
        let counter = ShotCounter(dataDir: try scratch())
        #expect(counter.next(session: "a") == 1)
        #expect(counter.next(session: "a") == 2)
        #expect(counter.next(session: "b") == 1)
        #expect(counter.next(session: "a") == 3)
    }

    @Test func concurrentCallersNeverShareANumber() throws {
        let counter = ShotCounter(dataDir: try scratch())
        let seen = Seen()
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            for _ in 0..<100 { seen.add(counter.next(session: "s")) }
        }
        #expect(seen.values.count == 800)
        #expect(seen.values == Set(1...800))
    }

    @Test func aRestartOrAReopenedSessionStartsAboveTheFilesThere() throws {
        let dataDir = try scratch()
        let shots = "\(dataDir)/shots/s"
        try FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
        for n in 1...9 {
            let format: String = n % 2 == 0 ? "png" : "jpg"
            _ = FileManager.default.createFile(atPath: "\(shots)/\(ShotNaming.padded(n))-observe.\(format)", contents: Data())
        }
        _ = FileManager.default.createFile(atPath: "\(shots)/notes.txt", contents: Data())
        #expect(ShotCounter(dataDir: dataDir).next(session: "s") == 10)
        let reopened = ShotCounter(dataDir: dataDir)
        #expect(reopened.next(session: "s") == 10)
        reopened.forget(session: "s")
        #expect(reopened.next(session: "s") == 10)
    }

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var values = Set<Int>()

        func add(_ value: Int) {
            lock.lock()
            values.insert(value)
            lock.unlock()
        }
    }
}
