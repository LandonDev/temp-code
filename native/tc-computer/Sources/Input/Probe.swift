import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// The probe's reads, writes and posts over AX and the event sink, process tier only. Every
/// element it touches gets a messaging timeout of at most 0.25 s (less when the probe's 2 s
/// runs short) before its first call, so one hung call cannot eat the budget; the candidate
/// search reads at most 500 nodes.
final class LiveProbeAccess: ProbeAccess {
    typealias Element = AXUIElement

    let pid: Int32
    let bundleId: String?
    private let window: AXUIElement
    private let windowID: UInt32
    private let app: AXUIElement
    private let sink: EventSink
    private let clock: InputClock
    private let deadline: Double
    private var touched: [AXUIElement] = []

    init(target: InputTarget, sink: EventSink, clock: InputClock) {
        pid = target.pid
        bundleId = NSRunningApplication(processIdentifier: target.pid)?.bundleIdentifier
        window = target.window
        windowID = target.windowID
        app = AXUIElementCreateApplication(target.pid)
        self.sink = sink
        self.clock = clock
        deadline = clock.seconds() + Double(InputTiming.probeCapMs) / 1000
        touch(app)
        touch(window)
    }

    /// The timeout binds only the exact element it is set on: set it before the first call on each.
    @discardableResult
    private func touch(_ e: AXUIElement) -> AXUIElement {
        if !touched.contains(where: { CFEqual($0, e) }) {
            let left = max(0.01, deadline - clock.seconds())
            AX.setTimeout(e, seconds: min(InputTiming.probeCallTimeoutS, left))
            touched.append(e)
        }
        return e
    }

    func keyWindow() -> KeyWindowState {
        guard let focused = AX.element(app, "AXFocusedWindow") else { return .none }
        return AX.same(focused, window) ? .target : .other
    }

    /// The window's elements, breadth first, at most `probeMaxNodes`.
    private func walk() -> [AXUIElement] {
        var out: [AXUIElement] = []
        var queue = [window]
        while !queue.isEmpty, out.count < InputTiming.probeMaxNodes, clock.seconds() < deadline {
            let e = touch(queue.removeFirst())
            out.append(e)
            queue += AX.elements(e, "AXChildren")
        }
        return out
    }

    private func verticalBar(of area: AXUIElement) -> AXUIElement? {
        AX.element(area, "AXVerticalScrollBar").map(touch)
    }

    func scrollCandidate() -> ProbeScroll<AXUIElement>? {
        guard let windowFrame = AX.frame(window) else { return nil }
        for e in walk() where AX.string(e, "AXRole") == "AXScrollArea" {
            guard let bar = verticalBar(of: e), let value = AX.number(bar, "AXValue"),
                  let frame = AX.frame(e), let p = pointIn(frame, visible: nil, window: windowFrame) else { continue }
            let facts = [RestoreFact("scroll bar", readable: true, settable: AX.settable(bar, "AXValue"))]
            return ProbeScroll(bar: bar, value: value, point: p, facts: facts)
        }
        return nil
    }

    /// A text element's caret, scroll bar and facts.
    private func text(_ e: AXUIElement) -> ProbeText<AXUIElement>? {
        touch(e)
        let length = AX.int(e, "AXNumberOfCharacters") ?? AX.string(e, "AXValue")?.utf16.count ?? 0
        guard length >= 1, let range = AX.range(e) else { return nil }
        var facts = [RestoreFact("selection", readable: true, settable: AX.settable(e, "AXSelectedTextRange"))]
        var bar: AXUIElement?
        var barValue: Double?
        if let area = AX.ancestor(e, role: "AXScrollArea").map(touch), let b = verticalBar(of: area) {
            bar = b
            barValue = AX.number(b, "AXValue")
            facts.append(RestoreFact("scroll bar", readable: barValue != nil, settable: AX.settable(b, "AXValue")))
        }
        return ProbeText(element: e, range: range, length: length, bar: bar, barValue: barValue, facts: facts)
    }

    func focusedText() -> ProbeText<AXUIElement>? {
        guard let e = AX.element(app, "AXFocusedUIElement").map(touch), AX.same(AX.element(e, "AXWindow"), window) else { return nil }
        return text(e)
    }

    func clickCandidate() -> ProbeText<AXUIElement>? {
        guard let windowFrame = AX.frame(window) else { return nil }
        let focused = AX.element(app, "AXFocusedUIElement").map(touch)
        let textRoles: Set<String> = ["AXTextArea", "AXTextField"]
        let candidates = (focused.map { [$0] } ?? []) + walk().filter { textRoles.contains(AX.string($0, "AXRole") ?? "") }
        for e in candidates {
            guard var c = text(e), c.length >= 2 else { continue }
            let visible = AX.range(e, "AXVisibleCharacterRange") ?? TextRange(location: 0, length: c.length)
            // a character away from the caret, whose bounds show, with two more after it for the drag
            for i in visible.location ..< min(visible.end, c.length) where i != c.range.location && i + 2 <= c.length {
                guard let b = AX.bounds(e, for: TextRange(location: i, length: 1)), b.w > 0, b.h > 0,
                      let end = AX.bounds(e, for: TextRange(location: i + 2, length: 1)),
                      intersect(b, windowFrame) != nil else { continue }
                c.clickAt = ScreenPoint(x: b.x + b.w * 0.25, y: b.y + b.h / 2)
                c.clickExpect = TextRange(location: i, length: 0)
                c.dragTo = ScreenPoint(x: end.x + end.w * 0.25, y: end.y + end.h / 2)
                c.dragExpect = TextRange(location: i, length: 2)
                c.focused = focused
                c.facts.append(RestoreFact("focus", readable: focused != nil, settable: focused.map { AX.settable($0, "AXFocused") } ?? false))
                return c
            }
        }
        return nil
    }

    func number(_ e: AXUIElement) -> Double? { AX.number(touch(e), "AXValue") }
    func range(_ e: AXUIElement) -> TextRange? { AX.range(touch(e)) }

    func setNumber(_ e: AXUIElement, _ value: Double) -> Bool {
        AX.setTimeout(e, seconds: InputTiming.probeCallTimeoutS)
        return AX.set(e, "AXValue", NSNumber(value: value)) == .success
    }

    func setRange(_ e: AXUIElement, _ range: TextRange) -> Bool {
        AX.setTimeout(e, seconds: InputTiming.probeCallTimeoutS)
        return AX.set(e, "AXSelectedTextRange", AX.rangeValue(range)) == .success
    }

    func setFocused(_ e: AXUIElement) -> Bool {
        AX.setTimeout(e, seconds: InputTiming.probeCallTimeoutS)
        return AX.set(e, "AXFocused", kCFBooleanTrue) == .success
    }

    func post(_ plan: [SyntheticEvent]) {
        for e in plan {
            if case .pause(let ms) = e { clock.sleep(ms: ms); continue }
            sink.post(e, route: .pid(pid, windowID: windowID))
            clock.sleep(ms: InputTiming.eventGapMs)
        }
    }
}
