import Foundation
import TempCodeContract

/// The row under the composer's box, the desktop's (docs/LAYOUT.md
/// "Composer", chrome/ComposerBar.tsx): 24 pt, 4 pt under the box and on its
/// edges, always there. At the left the model and its effort (a menu: the
/// catalog's models by provider, then Effort); at the right the context
/// meter and the permission mode. The app draws it; this decides what it
/// holds.
public enum ComposerRow {
    /// The row's height and its distance under the box.
    public static let height = TranscriptLengths.composerRow
    public static let gap = TranscriptLengths.gapLine

    /// What a row of `width` points has room for. A narrow row gives way in
    /// the desktop's order and never wraps: the meter's percent first (the
    /// ring stays), then the effort word, then the mode's label (its glyph
    /// stays), then the model's name (its provider's glyph stays).
    public struct Fit: Equatable, Sendable {
        public let percent: Bool
        public let effort: Bool
        public let modeLabel: Bool
        public let modelName: Bool
    }

    public static let percentWidth: Double = 400
    public static let effortWidth: Double = 368
    public static let modeLabelWidth: Double = 320
    public static let modelNameWidth: Double = 144

    public static func fit(width: Double) -> Fit {
        Fit(percent: width >= percentWidth, effort: width >= effortWidth, modeLabel: width >= modeLabelWidth, modelName: width >= modelNameWidth)
    }

    // MARK: the context meter

    /// The meter's ink: secondary, then the warning tint from 85 %. Never
    /// red: red is for failed.
    public enum Tone: Equatable, Sendable {
        case muted
        case warning
    }

    public static let warnRatio = 0.85

    public static func tone(ratio: Double) -> Tone {
        ratio >= warnRatio ? .warning : .muted
    }

    /// The window's fill as the meter draws it: a 14 pt ring and the
    /// percent, a spinner in the ring's place while the harness compacts.
    public struct Meter: Equatable, Sendable {
        public let ratio: Double
        public let percent: Int
        public let tone: Tone
        public let compacting: Bool
        /// "124K of 200K tokens", or "Compacting context".
        public let label: String
    }

    /// Nothing until the host has reported both the level and the window
    /// (`SessionMeta.context`); a harness that reports none has no meter.
    public static func meter(_ context: SessionMeta.Context?, compacting: Bool) -> Meter? {
        guard let context, let window = context.window, window > 0, context.tokens >= 0 else { return nil }
        let ratio = min(1, Double(context.tokens) / Double(window))
        let label = compacting ? "Compacting context" : "\(tokens(context.tokens)) of \(tokens(window)) tokens"
        return Meter(ratio: ratio, percent: Int((ratio * 100).rounded()), tone: tone(ratio: ratio), compacting: compacting, label: label)
    }

    /// A count for chrome, the desktop's `formatTokens`: 980, 7.5K, 176K, 1.2M.
    public static func tokens(_ count: Int) -> String {
        guard count >= 0 else { return "0" }
        if count < 1000 { return String(count) }
        func short(_ value: Double, _ unit: String) -> String {
            if value < 10 {
                let tenth = (value * 10).rounded() / 10
                return tenth == tenth.rounded(.down) ? "\(Int(tenth))\(unit)" : "\(tenth)\(unit)"
            }
            return "\(Int(value.rounded()))\(unit)"
        }
        if count < 1_000_000 { return short(Double(count) / 1000, "K") }
        return short(Double(count) / 1_000_000, "M")
    }

    // MARK: who may use what

    /// What a control is for this key: a menu, a value it can only read, or
    /// not there (no thread yet for a meter or a mode).
    public enum Access: Equatable, Sendable {
        case editable
        case readOnly
        case hidden
    }

    /// The model and its effort ride on the next send, so a key that may
    /// operate picks them; a lesser key reads them.
    public static func modelAccess(operate: Bool) -> Access {
        operate ? .editable : .readOnly
    }

    /// The permission mode is `session.permission`, which needs approve; a
    /// lesser key sees the mode read-only. No thread, no mode.
    public static func modeAccess(hasThread: Bool, approve: Bool) -> Access {
        guard hasThread else { return .hidden }
        return approve ? .editable : .readOnly
    }
}

/// The permission modes in the desktop's words (lib/session.ts
/// `RUNTIME_MODE_LABEL`, over the wire's policies as lib/tcserver/access.ts
/// maps them), the one vocabulary for the row and the sheets.
public enum PermissionWords {
    public static let choices: [PermissionPolicy] = [.safe, .edits, .auto]

    public static func label(_ policy: PermissionPolicy) -> String {
        switch policy {
        case .safe: "Supervised"
        case .edits: "Auto-accept edits"
        case .auto: "Full access"
        case .unknown(let value): value
        }
    }

    /// The desktop's `RUNTIME_MODE_HINT`.
    public static func hint(_ policy: PermissionPolicy) -> String {
        switch policy {
        case .safe: "Ask before edits and commands that change things."
        case .edits: "Auto-approve edits, ask before other actions."
        case .auto: "Allow commands and edits without prompts."
        case .unknown: ""
        }
    }
}
