#if canImport(AppKit)
import AppKit
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation
import Testing
@testable import Input

@Suite struct EventMakerTests {
    let p = ScreenPoint(x: 3900.5, y: -120)

    private func make(_ e: SyntheticEvent, window: UInt32? = 1581) -> CGEvent {
        EventMaker.make(e, windowID: window, source: CGEventSource(stateID: .privateState))!
    }

    @Test func mouseEventsCarryEverything() {
        let down = make(.down(.left, p, clickState: 2, flags: [.shift, .command]))
        #expect(down.type == .leftMouseDown)
        #expect(down.location == CGPoint(x: 3900.5, y: -120))
        #expect(down.getIntegerValueField(.mouseEventClickState) == 2)
        #expect(down.flags.contains(.maskShift) && down.flags.contains(.maskCommand) && !down.flags.contains(.maskControl))
        #expect(down.getIntegerValueField(CGEventField(rawValue: 91)!) == 1581)
        #expect(down.getIntegerValueField(CGEventField(rawValue: 92)!) == 1581)
        #expect(down.getIntegerValueField(.eventSourceUserData) == TC_EVENT_MARK)
        let middle = make(.up(.middle, p, clickState: 1, flags: []))
        #expect(middle.type == .otherMouseUp)
        #expect(middle.getIntegerValueField(.mouseEventButtonNumber) == 2)
        #expect(make(.move(p, dragging: .left)).type == .leftMouseDragged)
        #expect(make(.move(p, dragging: nil)).type == .mouseMoved)
        // the HID route sets no window fields
        #expect(make(.down(.right, p, clickState: 1, flags: []), window: nil).getIntegerValueField(CGEventField(rawValue: 91)!) == 0)
    }

    @Test func scrollsAreLineUnitsOnTheirWheel() {
        let v = make(.scroll(lines: -1, axis: .vertical, at: p, flags: []))
        #expect(v.type == .scrollWheel)
        #expect(v.getIntegerValueField(.scrollWheelEventDeltaAxis1) == -1)
        #expect(v.getIntegerValueField(.scrollWheelEventDeltaAxis2) == 0)
        #expect(v.getIntegerValueField(.scrollWheelEventIsContinuous) == 0)
        let h = make(.scroll(lines: 1, axis: .horizontal, at: p, flags: []))
        #expect(h.getIntegerValueField(.scrollWheelEventDeltaAxis2) == 1)
    }

    @Test func keysCarryTheirCodeTheirStringAndTheMark() {
        let k = make(.key(36, down: true, flags: .control))
        #expect(k.type == .keyDown)
        #expect(k.getIntegerValueField(.keyboardEventKeycode) == 36)
        #expect(k.flags.contains(.maskControl))
        let m = make(.modifier(56, down: true, flags: .shift))
        #expect(m.type == .flagsChanged)
        let u = make(.unicode("héllo🙂", down: true))
        var length = 0
        var chars = [UniChar](repeating: 0, count: 20)
        u.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
        #expect(String(utf16CodeUnits: chars, count: length) == "héllo🙂")
        #expect(u.getIntegerValueField(.eventSourceUserData) == TC_EVENT_MARK)
        #expect(EventMaker.make(.pause(ms: 5), windowID: nil, source: nil) == nil)
    }
}

@Suite struct CurrentKeyLayoutTests {
    @MainActor @Test func buildsAMapOnThisMac() {
        let map = CurrentKeyLayout.build()
        #expect(map == nil || (map?.count ?? 0) > 20)
        #expect(CurrentKeyLayout().stroke(for: "a") != nil)
    }
}

@Suite struct PasteboardTests {
    private func board() -> NSPasteboard {
        NSPasteboard(name: NSPasteboard.Name("dev.landon.tempcode.input-test.\(UUID().uuidString)"))
    }

    @Test func aSnapshotOfTwoItemsOfThreeTypesRestoresByteForByte() throws {
        let pb = board()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        let types = ["dev.landon.a", "dev.landon.b", "dev.landon.c"].map { NSPasteboard.PasteboardType($0) }
        let items = (0 ..< 2).map { n -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (i, t) in types.enumerated() { item.setData(Data([UInt8(n), UInt8(i), 0xFF, 0x00]), forType: t) }
            return item
        }
        pb.writeObjects(items)
        let store = SystemPasteboard(pb)
        let snap = try store.snapshot()
        store.clear()
        try store.write(PasteContent(plain: "pasted", html: "<b>pasted</b>"))
        #expect(pb.string(forType: .string) == "pasted")
        #expect(pb.string(forType: .html) == "<b>pasted</b>")
        store.restore(snap)
        let back = pb.pasteboardItems ?? []
        #expect(back.count == 2)
        for (n, item) in back.enumerated() {
            for (i, t) in types.enumerated() { #expect(item.data(forType: t) == Data([UInt8(n), UInt8(i), 0xFF, 0x00])) }
        }
    }

    @Test func theFlowOnARealBoardKeepsAPersonsCopy() throws {
        let pb = board()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        pb.setString("theirs", forType: .string)
        let store = SystemPasteboard(pb)
        let clock = FakeClock()
        let outcome = try PasteFlow(store: store, lock: FakeLock(clock: clock), clock: clock).run(
            PasteContent(plain: "ours"), cancelled: { false }, checks: {}, recheck: {},
            deliver: {
                pb.clearContents()
                pb.setString("copied meanwhile", forType: .string)
            },
            evidence: { nil }
        ).clipboard
        #expect(outcome == .keptPersonCopy)
        #expect(pb.string(forType: .string) == "copied meanwhile")
    }

    @Test func markdownWritesHTMLRTFAndTheSource() {
        let c = PasteContent.make("**bold** and *it*", format: .markdown)
        #expect(c.plain == "**bold** and *it*")
        #expect(c.html?.contains("<strong>bold</strong>") == true)
        #expect((c.rtf?.count ?? 0) > 0)
        let h = PasteContent.make("<p>a &amp; b</p>", format: .html)
        #expect(h.html == "<p>a &amp; b</p>")
        #expect(h.plain == "a & b")
        #expect(PasteContent.make("plain", format: nil) == PasteContent(plain: "plain"))
    }
}
#endif
