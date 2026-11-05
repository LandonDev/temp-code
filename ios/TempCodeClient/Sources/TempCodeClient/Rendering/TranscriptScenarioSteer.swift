import Foundation
import TempCodeContract

/// The `.steer` check: under its bubble the steer word
/// changes in place and only forward (Sent, then Queued for the next turn
/// or Received; Not delivered ends it), and once shown it never leaves.
extension ScenarioRunner {
    static func steerRank(_ state: SteerEvent.State) -> Int? {
        switch state {
        case .sent: 0
        case .queued: 1
        case .received, .failed: 2
        case .unknown: nil
        }
    }

    /// Jerks of the steer words in `rows`, remembered by the user row's key in `last`.
    static func steerJerks(_ rows: [TranscriptRowModel], last: inout [Int: SteerEvent.State], at: String) -> [String] {
        var jerks: [String] = []
        var shown: Set<Int> = []
        for row in rows {
            guard case .item(let entry) = row, case .user(let turn) = entry.item else { continue }
            shown.insert(entry.key)
            let previous = last[entry.key]
            guard let stamp = turn.steer, let rank = steerRank(stamp.state) else {
                if previous != nil { jerks.append("\(at): the steer word under \"\(turn.text)\" went away") }
                continue
            }
            if let previous, let before = steerRank(previous), rank < before || (rank == before && previous != stamp.state) {
                jerks.append("\(at): the steer word under \"\(turn.text)\" went from \(previous) back to \(stamp.state)")
            }
            last[entry.key] = stamp.state
        }
        for key in last.keys where !shown.contains(key) { last[key] = nil }
        return jerks
    }
}
