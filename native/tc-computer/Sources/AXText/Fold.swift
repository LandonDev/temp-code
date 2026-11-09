import ComputerProtocol
import Foundation

/// Range lines (spec §4.1): a run of at least `rangeFoldRun` siblings of one
/// role that are leaves and print nothing but their role, with consecutive,
/// ascending numbers, prints as `[<first>]–[<last>] <n> × <role>`. A name, a
/// state or a number out of step breaks the run.
public enum Fold {
    public struct Member: Sendable {
        public var index: Int
        public var role: String
        /// a leaf whose line is its role alone
        public var bare: Bool

        public init(index: Int, role: String, bare: Bool) {
            self.index = index
            self.role = role
            self.bare = bare
        }
    }

    /// The runs among one parent's children, as ranges of child positions.
    public static func runs(_ children: [Member], minimum: Int = ComputerDefaults.ObservationText.rangeFoldRun) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start = 0
        while start < children.count {
            var end = start + 1
            if children[start].bare {
                while end < children.count, children[end].bare, children[end].role == children[start].role,
                      children[end].index == children[end - 1].index + 1 { end += 1 }
                if end - start >= minimum { out.append(start..<end) }
            }
            start = end
        }
        return out
    }
}
