@testable import AXText
import ComputerProtocol
import Foundation
import Testing

@Test(.enabled(if: ProcessInfo.processInfo.environment["TC_AX_PHASES"] != nil)) func phaseTimings() {
    // the synthetic 5,000-node window, phase by phase
    var next: NodeID = 1
    func id() -> NodeID { next += 1; return next }
    let frame = Rect(x: 0, y: 0, w: 1440, h: 900)
    var sections: [AXNode] = []
    for s in 0..<250 {
        sections.append(AXNode(id: id(), role: "AXGroup", title: "Section \(s)", frame: frame, children: (0..<19).map { i in
            i % 2 == 0 ? AXNode(id: id(), role: "AXButton", title: "Button \(s).\(i)", frame: frame, actions: ["AXPress"])
                       : AXNode(id: id(), role: "AXStaticText", value: .string("Paragraph \(s).\(i) of the page"), frame: frame)
        }))
    }
    let snap = AXSnapshot(app: AppFacts(pid: 0, bundleId: nil, name: "S"), window: WindowInfo(id: 1, title: "S", frame: frame, main: true, focused: true, minimized: false, onScreen: true, space: .current), roots: [AXNode(id: 1, role: "AXWindow", title: "S", frame: frame, children: sections)])
    let clock = ContinuousClock()
    for _ in 0..<3 {
        var kept: KeptTree!
        let k = clock.measure { kept = Keep.tree(snap) }
        let book = IndexBook(allocator: IndexAllocator())
        var idx: Indexed!
        let a = clock.measure { idx = book.assign(kept, base: nil) }
        var layout: Layout!
        let l = clock.measure { layout = Layout.build(kept, idx, snapshot: snap, space: CoordinateSpace(width: 1440, height: 900, scale: 1), geometry: false, wholeValues: false) }
        let h = HeaderFacts()
        var out: TextBudget.Outcome!
        let b = clock.measure { out = TextBudget.fit(&layout, header: h, budget: 24_000) }
        var text = ""
        let t = clock.measure { text = layout.text(h, footer: out.footer) }
        let d = clock.measure { _ = Diff.base(layout, structure: idx.structure, footer: out.footer, windowID: 1, fullBytes: text.utf8.count) }
        print("keep \(k) assign \(a) layout \(l) budget \(b) text \(t) base \(d)")
    }
}
