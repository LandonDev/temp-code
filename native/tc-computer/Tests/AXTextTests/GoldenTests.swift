@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// The recorded fixtures (src/main/server/computer/fixtures/apps), read in place
/// from the checkout. `TC_AX_GOLDEN=update swift test --filter GoldenTests`
/// rewrites the goldens; read every rewritten file before committing it.
enum Goldens {
    static let apps = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("src/main/server/computer/fixtures/apps")

    static var updating: Bool { ProcessInfo.processInfo.environment["TC_AX_GOLDEN"] == "update" }

    struct Meta: Decodable {
        struct Shot: Decodable { var width: Int; var height: Int; var scale: Double }
        struct After: Decodable { var state: String }
        var app: String
        var state: String
        var shot: Shot
        var after: After?
    }

    /// Every recorded state, `<app>/<state>`.
    static func states() -> [String] {
        let fm = FileManager.default
        let apps = (try? fm.contentsOfDirectory(atPath: Goldens.apps.path)) ?? []
        return apps.sorted().flatMap { app in
            ((try? fm.contentsOfDirectory(atPath: Goldens.apps.appendingPathComponent(app).path)) ?? []).sorted()
                .filter { fm.fileExists(atPath: Goldens.apps.appendingPathComponent("\(app)/\($0)/tree.json").path) }
                .map { "\(app)/\($0)" }
        }
    }

    /// The states recorded after another, whose diff from it has a golden.
    static func following() -> [String] {
        states().filter { ((try? meta($0))?.after) != nil }
    }

    static func meta(_ state: String) throws -> Meta {
        try JSONDecoder().decode(Meta.self, from: Data(contentsOf: apps.appendingPathComponent("\(state)/meta.json")))
    }

    static func snapshot(_ state: String, ids: NodeIDSource) throws -> AXSnapshot {
        RawTree.snapshot(try RawTree.decode(Data(contentsOf: apps.appendingPathComponent("\(state)/tree.json"))), ids: ids)
    }

    static func space(_ state: String) throws -> CoordinateSpace {
        let m = try meta(state)
        return CoordinateSpace(width: m.shot.width, height: m.shot.height, scale: m.shot.scale)
    }

    /// The golden's text against `actual`, or the file rewritten when updating.
    static func check(_ state: String, _ file: String, _ actual: String) throws {
        let url = apps.appendingPathComponent("\(state)/\(file)")
        if updating {
            try (actual + "\n").write(to: url, atomically: true, encoding: .utf8)
            return
        }
        let golden = try String(contentsOf: url, encoding: .utf8)
        #expect(golden == actual + "\n", "\(state)/\(file)")
    }
}

@Suite struct GoldenTests {
    @Test func thereAreRecordedStates() {
        #expect(Goldens.states().count >= 9)
    }

    @Test(arguments: Goldens.states())
    func eachTreeReadsAsItsObservation(_ state: String) throws {
        let built = Reader().read(try Goldens.snapshot(state, ids: NodeIDSource()), space: try Goldens.space(state))
        #expect(built.kind == .full)
        try Goldens.check(state, "observation.txt", built.text)
    }

    @Test(arguments: Goldens.following())
    func eachStateAfterAnotherReadsAsItsDiff(_ state: String) throws {
        let meta = try Goldens.meta(state)
        let prior = "\(meta.app)/\(meta.after!.state)"
        let ids = NodeIDSource()
        let reader = Reader()
        reader.read(try Goldens.snapshot(prior, ids: ids), space: try Goldens.space(prior))
        let built = reader.read(try Goldens.snapshot(state, ids: ids), space: try Goldens.space(state))
        try Goldens.check(state, "diff.txt", built.text)
    }

    @Test func theFormUnderAFourThousandByteBudgetReadsAsItsTruncation() throws {
        let state = "chrome/form"
        let built = Reader().read(try Goldens.snapshot(state, ids: NodeIDSource()), budget: 4_000, space: try Goldens.space(state))
        #expect(built.text.utf8.count <= 4_000 && built.stats.omitted > 0)
        try Goldens.check(state, "truncated.txt", built.text)
    }
}
