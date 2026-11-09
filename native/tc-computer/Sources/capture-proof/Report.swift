#if canImport(ScreenCaptureKit)

import Foundation

/// The proof's record: one printed line per check, and every measurement into report.json.
@MainActor final class Report {
    enum Outcome: String { case pass, fail, skip, finding }

    struct Check {
        let scene: String
        let name: String
        let outcome: Outcome
        let detail: String
    }

    private(set) var checks: [Check] = []
    private var measurements: [String: [String: Any]] = [:]
    let out: URL

    init(out: URL) {
        self.out = out
    }

    /// One check. `pass` false is a failure unless `finding` says why it cannot pass.
    func check(_ scene: String, _ name: String, _ pass: Bool, _ detail: String, finding: Bool = false) {
        record(Check(scene: scene, name: name, outcome: pass ? .pass : (finding ? .finding : .fail), detail: detail))
    }

    func skip(_ scene: String, _ name: String, _ detail: String) {
        record(Check(scene: scene, name: name, outcome: .skip, detail: detail))
    }

    private func record(_ check: Check) {
        checks.append(check)
        let mark = switch check.outcome {
        case .pass: "PASS"
        case .fail: "FAIL"
        case .skip: "SKIP"
        case .finding: "FIND"
        }
        print("\(mark) [\(check.scene)] \(check.name): \(check.detail)")
        fflush(stdout)
    }

    /// A measurement under a scene; values must be JSON-able (numbers, strings, arrays, dicts).
    func measure(_ scene: String, _ key: String, _ value: Any) {
        measurements[scene, default: [:]][key] = Self.json(value)
    }

    func note(_ line: String) {
        print("     \(line)")
        fflush(stdout)
    }

    var failed: Bool { checks.contains { $0.outcome == .fail } }

    func write() throws {
        let summary: [String: Any] = [
            "pass": checks.filter { $0.outcome == .pass }.count,
            "fail": checks.filter { $0.outcome == .fail }.count,
            "skip": checks.filter { $0.outcome == .skip }.count,
            "finding": checks.filter { $0.outcome == .finding }.count,
        ]
        let body: [String: Any] = [
            "generatedAt": ISO8601DateFormatter().string(from: Date()),
            "host": ProcessInfo.processInfo.operatingSystemVersionString,
            "summary": summary,
            "checks": checks.map { ["scene": $0.scene, "name": $0.name, "outcome": $0.outcome.rawValue, "detail": $0.detail] },
            "measurements": measurements,
        ]
        let data = try JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: out.appendingPathComponent("report.json"))
        print("SUMMARY pass=\(summary["pass"]!) fail=\(summary["fail"]!) skip=\(summary["skip"]!) finding=\(summary["finding"]!)")
    }

    private static func json(_ value: Any) -> Any {
        switch value {
        case let rect as CGRect:
            return [round2(rect.minX), round2(rect.minY), round2(rect.width), round2(rect.height)]
        case let size as CGSize:
            return [round2(size.width), round2(size.height)]
        case let point as CGPoint:
            return [round2(point.x), round2(point.y)]
        case let number as Double:
            return number.isFinite ? round2(number) : String(number)
        case let number as CGFloat:
            return round2(Double(number))
        case let array as [Any]:
            return array.map(json)
        case let dictionary as [String: Any]:
            return dictionary.mapValues(json)
        default:
            return value
        }
    }

    private static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }

    private static func round2(_ value: CGFloat) -> Double {
        round2(Double(value))
    }
}

struct ProofError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// A value carried across a task boundary the proof knows is safe (a stream handle it awaits).
struct Unchecked<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// Percentiles and counts for the report.
enum Stats {
    static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return .nan }
        let sorted = values.sorted()
        let rank = Int((p / 100 * Double(sorted.count - 1)).rounded(.up))
        return sorted[min(max(rank, 0), sorted.count - 1)]
    }

    static func summary(_ values: [Double]) -> [String: Any] {
        ["n": values.count, "p50": percentile(values, 50), "p95": percentile(values, 95), "max": values.max() ?? .nan, "min": values.min() ?? .nan]
    }
}

#endif
