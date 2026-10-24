import Foundation

// The iPhone Duo's five poses as the proof names them, and the window each
// one gives an app linked against the iOS 27.1 SDK (docs/IOS-DESIGN.md
// "iPhone Duo" is the table). Pure: the layout report classifies a shot with
// it, and a layout rule may read it for words; a layout DECIDES by the size
// class of its own container, never by this enum.

public enum DuoPose: String, CaseIterable, Sendable {
    case folded
    case foldedLandscape = "folded-landscape"
    case unfolded
    case unfoldedPortrait = "unfolded-portrait"
    case halfOpen = "half-open"

    public enum SizeClass: String, Sendable { case compact, regular }
    /// SwiftUI's `DeviceHinge.Status`, as a plain value the package can hold.
    public enum HingeState: String, Sendable { case closed, partiallyOpen, fullyOpen }

    /// What a shot in this pose must report: the window in points, the size
    /// classes, the lit panel's name (`simctl io … --display=`) and its id.
    public struct Expected: Equatable, Sendable {
        public let width: Double
        public let height: Double
        public let horizontal: SizeClass
        public let vertical: SizeClass
        public let panel: String
        public let displayId: Int
    }

    /// The two-letter alias the shot names use (`fp fl ul up ho`).
    public var alias: String {
        switch self {
        case .folded: "fp"
        case .foldedLandscape: "fl"
        case .unfolded: "ul"
        case .unfoldedPortrait: "up"
        case .halfOpen: "ho"
        }
    }

    public var expected: Expected {
        switch self {
        case .folded: Expected(width: 466, height: 678, horizontal: .compact, vertical: .regular, panel: "LCD", displayId: 1)
        case .foldedLandscape: Expected(width: 678, height: 466, horizontal: .compact, vertical: .compact, panel: "LCD", displayId: 1)
        case .unfolded, .halfOpen: Expected(width: 951, height: 669, horizontal: .regular, vertical: .regular, panel: "LCD-1", displayId: 3)
        case .unfoldedPortrait: Expected(width: 669, height: 951, horizontal: .regular, vertical: .regular, panel: "LCD-1", displayId: 3)
        }
    }

    /// The long tag or its alias; nil for anything else.
    public init?(tag: String) {
        let trimmed = tag.trimmingCharacters(in: .whitespaces)
        if let pose = DuoPose(rawValue: trimmed) {
            self = pose
        } else if let pose = DuoPose.allCases.first(where: { $0.alias == trimmed }) {
            self = pose
        } else {
            return nil
        }
    }

    /// The table inverted: the pose whose window and size classes these are,
    /// `halfOpen` only when the hinge says partially open (an open window
    /// with any other hinge word, or none, is `unfolded`). A window of
    /// another size (a 27.0-linked app's 871 × 669, an ordinary iPhone) is nil.
    public static func classify(width: Double, height: Double, horizontal: SizeClass, vertical: SizeClass, hinge: HingeState?) -> DuoPose? {
        let match = allCases.first {
            let e = $0.expected
            return abs(e.width - width) < 1 && abs(e.height - height) < 1 && e.horizontal == horizontal && e.vertical == vertical && $0 != .halfOpen
        }
        guard let match else { return nil }
        if match == .unfolded, hinge == .partiallyOpen { return .halfOpen }
        return match
    }

    /// Whether a window of this size is one of the Duo's.
    public static func isDuoWindow(width: Double, height: Double) -> Bool {
        allCases.contains { abs($0.expected.width - width) < 1 && abs($0.expected.height - height) < 1 }
    }
}
