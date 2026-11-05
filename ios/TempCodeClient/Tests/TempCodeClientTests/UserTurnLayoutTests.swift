import CoreGraphics
import Foundation
import Testing
@testable import TempCodeClient

/// The bubble's share of the column (UserMessage.tsx on the phone).
@Suite struct UserTurnLayoutTests {
    @Test func `a bubble is at most 85 % of the column`() {
        #expect(UserTurnLayout.maxWidth(column: 400) == 340)
        #expect(UserTurnLayout.maxWidth(column: 768) == 652)
    }

    @Test func `a short message hugs its text with the padding, a long one stops at the share`() {
        #expect(UserTurnLayout.width(textWidth: 60, column: 400) == 84)
        #expect(UserTurnLayout.width(textWidth: 900, column: 400) == 340)
    }

    @Test func `the bubble sits at the column's right edge`() {
        #expect(UserTurnLayout.leadingInset(bubble: 84, column: 400) == 316)
        #expect(UserTurnLayout.leadingInset(bubble: 500, column: 400) == 0)
    }
}
