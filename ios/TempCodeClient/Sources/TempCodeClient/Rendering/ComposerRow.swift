import CoreGraphics
import Foundation
import TempCodeContract

/// The 24 pt row under the composer's box, the desktop's composer row
/// (docs/LAYOUT.md): the model and its effort at the left, the context
/// meter and the permission mode at the right, quiet secondary controls.
/// At a narrow width they give way in the desktop's order, never wrapping:
/// the meter's percent under 400 pt, the effort under 368, the mode's label
/// under 320, the model's name under 144.
public struct ComposerRow: Sendable, Hashable {
    public static let percentBelow: CGFloat = 400
    public static let effortBelow: CGFloat = 368
    public static let modeLabelBelow: CGFloat = 320
    public static let modelNameBelow: CGFloat = 144

    public var showsPercent: Bool
    public var showsEffort: Bool
    public var showsModeLabel: Bool
    public var showsModelName: Bool

    /// What the row shows in a row `width` wide.
    public static func at(width: CGFloat) -> ComposerRow {
        ComposerRow(
            showsPercent: width >= percentBelow,
            showsEffort: width >= effortBelow,
            showsModeLabel: width >= modeLabelBelow,
            showsModelName: width >= modelNameBelow
        )
    }

    /// The context meter: the share of the window used, its tone, and
    /// whether it draws at all. Amber from 85 %, never red; a spinner while
    /// the thread compacts; nothing when the host reports no level.
    public struct Meter: Sendable, Hashable {
        public enum Tone: Sendable, Hashable { case quiet, warning }

        public static let warnAt = 0.85

        public var share: Double
        public var tone: Tone
        public var compacting: Bool

        /// "62%".
        public var percent: String { "\(Int((share * 100).rounded()))%" }

        public static func of(_ context: SessionMeta.Context?, compacting: Bool) -> Meter? {
            guard let context, let window = context.window, window > 0 else {
                return compacting ? Meter(share: 0, tone: .quiet, compacting: true) : nil
            }
            let share = min(1, max(0, Double(context.tokens) / Double(window)))
            return Meter(share: share, tone: share >= warnAt ? .warning : .quiet, compacting: compacting)
        }
    }

    /// Which of the row's controls a key may change: the model and effort
    /// ride the next send (operate); the permission mode is `session.permission`
    /// (approve); a lesser key sees the mode read-only.
    public struct Controls: Sendable, Hashable {
        public var model: Bool
        public var permission: Bool

        public static func `for`(caps: [Capability]) -> Controls {
            Controls(model: caps.contains(.operate), permission: caps.contains(.approve))
        }
    }
}
