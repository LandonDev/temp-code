import Testing
@testable import TempCodeClient

@Suite struct DiagnosticsTextTests {
    @Test func `milliseconds keep one decimal under ten`() {
        #expect(DiagnosticsText.ms(8.33) == "8.3 ms")
        #expect(DiagnosticsText.ms(21.4) == "21 ms")
        #expect(DiagnosticsText.hitch(3.06) == "3.1 ms per second")
    }

    @Test func `late frames read as a share`() {
        #expect(DiagnosticsText.late(0, of: 0) == "No frames")
        #expect(DiagnosticsText.late(0, of: 2_400) == "None")
        #expect(DiagnosticsText.late(1, of: 2_400) == "Under 0.1%")
        #expect(DiagnosticsText.late(12, of: 2_400) == "0.5%")
        #expect(DiagnosticsText.late(300, of: 2_400) == "13%")
    }

    @Test func `the display names the drawn rate only when it differs`() {
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: nil) == "120 Hz")
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: 8.3) == "120 Hz")
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: 16.7) == "120 Hz, drawing at 60")
    }
}
