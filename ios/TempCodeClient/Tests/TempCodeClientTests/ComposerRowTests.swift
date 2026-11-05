import CoreGraphics
import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The row under the composer's box: the give-way widths, the meter's tone,
/// which controls a key may use.
@Suite struct ComposerRowTests {
    @Test(arguments: [
        (466.0, true, true, true, true),
        (400.0, true, true, true, true),
        (399.0, false, true, true, true),
        (367.0, false, false, true, true),
        (319.0, false, false, false, true),
        (143.0, false, false, false, false),
    ] as [(Double, Bool, Bool, Bool, Bool)])
    func `the controls give way in the desktop's order`(width: Double, percent: Bool, effort: Bool, mode: Bool, model: Bool) {
        let row = ComposerRow.at(width: CGFloat(width))
        #expect(row.showsPercent == percent)
        #expect(row.showsEffort == effort)
        #expect(row.showsModeLabel == mode)
        #expect(row.showsModelName == model)
    }

    @Test func `the meter is amber from 85 %, never red, and absent with no level`() {
        #expect(ComposerRow.Meter.of(.init(tokens: 50_000, window: 200_000), compacting: false)?.tone == .quiet)
        #expect(ComposerRow.Meter.of(.init(tokens: 170_000, window: 200_000), compacting: false)?.tone == .warning)
        #expect(ComposerRow.Meter.of(.init(tokens: 250_000, window: 200_000), compacting: false)?.share == 1)
        #expect(ComposerRow.Meter.of(.init(tokens: 124_000, window: 200_000), compacting: false)?.percent == "62%")
        #expect(ComposerRow.Meter.of(nil, compacting: false) == nil)
        #expect(ComposerRow.Meter.of(.init(tokens: 10, window: nil), compacting: false) == nil)
        #expect(ComposerRow.Meter.of(nil, compacting: true)?.compacting == true)
    }

    @Test func `a read key changes nothing, operate picks the model, approve the mode`() {
        #expect(ComposerRow.Controls.for(caps: [.read]) == .init(model: false, permission: false))
        #expect(ComposerRow.Controls.for(caps: [.read, .operate]) == .init(model: true, permission: false))
        #expect(ComposerRow.Controls.for(caps: [.read, .operate, .approve]) == .init(model: true, permission: true))
    }
}
