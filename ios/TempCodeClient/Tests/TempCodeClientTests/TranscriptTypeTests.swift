import Foundation
import Testing
@testable import TempCodeClient

/// The transcript's type ladder (docs/IOS-DESIGN.md "Visual system"): each
/// token's style, size and line box at the default size, and the line box
/// keeping its ratio once Dynamic Type scales the size.
@Suite struct TranscriptTypeTests {
    @Test(arguments: [
        ("prose", TypeSpec.Style.subheadline, 15.0, 22.0),
        ("line", .footnote, 13, 20),
        ("detail", .caption, 12, 16),
        ("code", .subheadline, 14, 20),
        ("rowCode", .caption, 12, 20),
        ("proseH1", .subheadline, 17, 24),
        ("proseH2", .subheadline, 16, 22),
        ("proseH3", .subheadline, 15, 22),
        ("document", .callout, 16, 24),
        ("documentH1", .callout, 20, 26),
        ("documentH2", .callout, 17, 24),
        ("documentH3", .callout, 16, 24),
    ] as [(String, TypeSpec.Style, Double, Double)])
    func `each token's style, size and line height at the default size`(name: String, style: TypeSpec.Style, size: Double, line: Double) throws {
        let spec = try #require(TranscriptScale.all[name])
        #expect(spec.style == style)
        #expect(spec.size == size)
        #expect(spec.lineHeight == line)
        #expect(spec.lineHeight(atSize: size) == line)
    }

    @Test func `at an accessibility size the line box keeps its ratio`() {
        // subheadline at AX3 is about 2.5 times its default size.
        let prose = TranscriptScale.prose
        #expect(prose.lineHeight(atSize: 37.5) == 55)
        #expect(TranscriptScale.detail.lineHeight(atSize: 24) == 32)
    }

    @Test func `line spacing fills the box above the font's own line and never goes negative`() {
        let prose = TranscriptScale.prose
        #expect(abs(prose.lineSpacing(atSize: 15, fontLine: 17.9) - 4.1) < 0.0001)
        #expect(prose.lineSpacing(atSize: 15, fontLine: 30) == 0)
    }

    @Test func `code is mono, headings carry their weight and tracking`() {
        #expect(TranscriptScale.code.mono)
        #expect(TranscriptScale.rowCode.mono)
        #expect(!TranscriptScale.prose.mono)
        #expect(TranscriptScale.proseH1.weight == .semibold)
        #expect(TranscriptScale.proseH1.tracking == -0.01)
        #expect(TranscriptScale.documentH3.weight == .medium)
    }

    @Test func `the rows and the composer sit on the desktop's lengths`() {
        #expect(TranscriptLengths.line == 28)
        #expect(TranscriptLengths.tableRow == 32)
        #expect(TranscriptLengths.column == 768)
        #expect(TranscriptLengths.documentColumn == 640)
        // The empty box: 28 pt controls with 8 pt above and below, plus the hairline's room.
        #expect(TranscriptLengths.composerBox == TranscriptLengths.composerControl + 2 * 8 + 2)
    }
}

/// The desktop's motion numbers as the phone holds them; the parity test on
/// the box compares the file itself with the desktop's sources.
@Suite struct MotionValuesTests {
    @Test func `the layout spring settles in the desktop's 370 ms, the glide in 340`() {
        #expect(MotionValues.springLayout.settleSeconds() == 0.37)
        #expect(MotionValues.springLayout.settleSeconds() == MotionValues.layout)
        #expect(MotionValues.springGlide.settleSeconds() == 0.34)
    }

    @Test(arguments: [
        MotionValues.easeOut, MotionValues.easeInOut, MotionValues.easeDrawer,
        MotionValues.easeExit, MotionValues.easeSwap, MotionValues.easeBreathe, MotionValues.shimmerSweep,
    ])
    func `every curve starts at 0, ends at 1 and never runs backwards`(curve: MotionValues.Curve) {
        #expect(curve.value(at: 0) == 0)
        #expect(curve.value(at: 1) == 1)
        var last = 0.0
        for i in 1...100 {
            let v = curve.value(at: Double(i) / 100)
            #expect(v >= last - 1e-6)
            last = v
        }
    }

    @Test func `ease-out is past halfway early and the in-out is symmetric`() {
        #expect(MotionValues.easeOut.value(at: 0.25) > 0.7)
        let inOut = MotionValues.easeInOut
        #expect(abs(inOut.value(at: 0.5) - 0.5) < 0.02)
        #expect(abs(inOut.value(at: 0.2) + inOut.value(at: 0.8) - 1) < 0.02)
    }

    @Test func `the durations climb in the desktop's order`() {
        let ladder = [MotionValues.swapOut, MotionValues.fast, MotionValues.base, MotionValues.slow, MotionValues.drawer, MotionValues.layout]
        #expect(ladder == ladder.sorted())
        #expect(MotionValues.revealStep < MotionValues.revealFade)
        #expect(MotionValues.shimmerStart < MotionValues.shimmerEnd)
        #expect(MotionValues.markGather < MotionValues.markPart)
        #expect(MotionValues.markLagGather < MotionValues.markLagPart)
    }
}
