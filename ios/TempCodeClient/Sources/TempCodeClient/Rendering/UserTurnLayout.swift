import CoreGraphics
import Foundation

/// The person's words as the desktop draws them (transcript/UserMessage.tsx):
/// a right-aligned bubble on the chrome fill at radius 12, padded 12 × 8, at
/// most 85 % of the column, sized to its text below that.
public enum UserTurnLayout {
    /// The widest a bubble grows in a column `column` wide.
    public static func maxWidth(column: CGFloat) -> CGFloat {
        (column * CGFloat(TranscriptLengths.bubbleMaxShare)).rounded(.down)
    }

    /// The bubble's width for text that wants `textWidth` on one line.
    public static func width(textWidth: CGFloat, column: CGFloat) -> CGFloat {
        min(maxWidth(column: column), textWidth + 2 * CGFloat(TranscriptLengths.bubblePaddingH))
    }

    /// Where the bubble's leading edge sits: right-aligned in the column.
    public static func leadingInset(bubble: CGFloat, column: CGFloat) -> CGFloat {
        max(0, column - bubble)
    }
}
